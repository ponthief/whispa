// The labels that live on the SERVER, for the backup to carry.
//
// WHY THIS EXISTS. Reported 2026-11-08: "just restored a file where label for
// segwit address tnx got restored, but not for SP tnx label — if we are only
// backing up labels, it's not really a wallet backup, is it?"
//
// Exactly right, and the split was invisible from outside. A SegWit label is
// device-only (`services/segwitLabels.ts`, the server is never told those
// coins exist) and was in the file; an SP coin's label is `silnt.utxos.label`,
// written by `PUT /api/v1/utxos/{txid}/label`, and was not. Nothing on either
// screen could have told anyone which of their labels would come back. A
// backup that restores half of them, by a rule nobody can see, is worse than
// one that says it restores none.
//
// THE SERVER IS STILL THE AUTHORITY for these. This does not cache them or
// shadow them: it reads them at export and writes them back through the same
// endpoints the UI uses, so every ownership check still runs server-side.
//
// KEYED PER WALLET, LIKE segwitLabels, and remapped on the way back in for the
// same reason: `wallet_id = urlsafe_short_hash()` at create time, so deleting
// a wallet and adding the same seed back gives a new id. Within a wallet a
// coin label is keyed by TXID, which is what the endpoint takes and a fact
// about the chain, and an address label by the ADDRESS, which is the thing
// that was handed out. Both survive the wallet id changing underneath them.
//
// THE API IS INJECTED rather than imported. The two clients have their own
// api modules with the same function names, this file must typecheck under
// both tsconfigs, and a check can drive it with a fake and no network.

/** Just the api functions this needs, as both clients already define them. */
export type LabelApi = {
  getUtxos(inkey: string, walletId: string): Promise<any>;
  updateUtxoLabel(inkey: string, txid: string, label: string, walletId: string): Promise<unknown>;
  getWalletAddresses?(inkey: string, walletId: string): Promise<any>;
  updateAddressLabel?(inkey: string, walletId: string, addressId: string, label: string): Promise<unknown>;
};

export type WalletRef = { id: string; spAddress?: string };

/** walletId -> txid -> label, and walletId -> sp address -> label. */
export type ServerLabelSections = {
  coinLabels?: Record<string, Record<string, string>>;
  addressLabels?: Record<string, Record<string, string>>;
};

export type ServerLabelReport = {
  added: number;
  kept: number;
  /**
   * Labels with nowhere to go YET. The endpoint 404s when the wallet holds no
   * coin from that txid, which is the normal state between adding a wallet
   * back and finishing a rescan — the coins come from the chain, and until
   * they do there is nothing to label. Counted and reported rather than
   * swallowed or treated as an error, because "restore again after the scan"
   * is the useful thing to tell somebody.
   */
  pending: number;
  /** Calls that failed for any other reason. */
  failed: number;
};

const EMPTY: ServerLabelReport = { added: 0, kept: 0, pending: 0, failed: 0 };

function isMissing(e: any): boolean {
  const m = String(e?.message || e || '');
  return e?.status === 404 || /no coin from that transaction/i.test(m) || /404/.test(m);
}

/**
 * Read every wallet's server-side labels.
 *
 * Best effort per wallet: one wallet that cannot be read must not cost the
 * backup the others. An empty result is a legitimate answer — a wallet with no
 * labels contributes nothing rather than an empty object, so the file does not
 * grow a section for a user who has never labelled anything.
 */
export async function collectServerLabels(
  api: LabelApi,
  inkey: string,
  wallets: WalletRef[],
): Promise<ServerLabelSections> {
  const coinLabels: Record<string, Record<string, string>> = {};
  const addressLabels: Record<string, Record<string, string>> = {};

  for (const w of wallets || []) {
    if (!w?.id) continue;

    try {
      const res: any = await api.getUtxos(inkey, w.id);
      const list: any[] = Array.isArray(res) ? res : res?.utxos || [];
      for (const u of list) {
        const label = typeof u?.label === 'string' ? u.label.trim() : '';
        if (!label || !u?.txid) continue;
        // One label per txid, which is what the endpoint stores: it labels
        // every coin this wallet has from that transaction.
        (coinLabels[w.id] || (coinLabels[w.id] = {}))[u.txid] = label;
      }
    } catch {
      /* best effort, per wallet */
    }

    // Labelled SP addresses are a web-only feature; the phone passes an api
    // without these, and the section simply does not appear in its files.
    if (!api.getWalletAddresses) continue;
    try {
      const res: any = await api.getWalletAddresses(inkey, w.id);
      const list: any[] = Array.isArray(res) ? res : res?.addresses || [];
      for (const a of list) {
        const label = typeof a?.label === 'string' ? a.label.trim() : '';
        const addr = a?.sp_address;
        if (!label || !addr) continue;
        (addressLabels[w.id] || (addressLabels[w.id] = {}))[addr] = label;
      }
    } catch {
      /* best effort, per wallet */
    }
  }

  const out: ServerLabelSections = {};
  if (Object.keys(coinLabels).length) out.coinLabels = coinLabels;
  if (Object.keys(addressLabels).length) out.addressLabels = addressLabels;
  return out;
}

/**
 * Write them back.
 *
 * THE FILE WINS, as everywhere else in a restore, and a label already equal to
 * the file's is not written — this talks to the server, so a no-op PUT is a
 * round trip spent saying nothing.
 *
 * `remap` is walletId-in-the-file -> walletId-now, from remapWalletIds.
 *
 * AND IT SAYS WHICH ONES DID NOT LAND, not just how many. `unplaced` is the
 * subset of `sections` that is still owed, keyed exactly as it came in — by
 * the id in the FILE, so the caller can keep it beside the same wallet
 * references and hand the pair straight back here later. That is what
 * services/pendingLabels.ts stores, and it is the whole of the fix for
 * "scan, then restore again": a label with no coin to attach to yet is kept
 * and retried when the coins arrive, instead of being counted out loud and
 * left to the user to come back for.
 *
 * A FAILED call is unplaced too, not only a pending one. The label is owed
 * either way, and a 500 or a dropped connection must not be the thing that
 * loses it — a retry costs one PUT and the alternative is silence.
 */
export async function applyServerLabels(
  api: LabelApi,
  inkey: string,
  sections: ServerLabelSections,
  remap: Record<string, string>,
  live: WalletRef[],
): Promise<{
  coinLabels?: ServerLabelReport;
  addressLabels?: ServerLabelReport;
  unplaced: ServerLabelSections;
}> {
  const out: {
    coinLabels?: ServerLabelReport;
    addressLabels?: ServerLabelReport;
    unplaced: ServerLabelSections;
  } = { unplaced: {} };
  const liveIds = new Set((live || []).map((w) => w?.id).filter(Boolean));

  /** Keep one entry, under the id it arrived with. */
  const owed = (kind: 'coinLabels' | 'addressLabels', fileId: string, key: string, label: string) => {
    const sect = out.unplaced[kind] || (out.unplaced[kind] = {});
    (sect[fileId] || (sect[fileId] = {}))[key] = label;
  };

  if (sections.coinLabels) {
    const r = { ...EMPTY };
    for (const [fileId, byTxid] of Object.entries(sections.coinLabels)) {
      const walletId = remap[fileId] || fileId;
      // A wallet the account no longer has is not an error and not a failure:
      // the labels stay in the file, and restoring again once it is back will
      // place them.
      if (!liveIds.has(walletId)) {
        r.pending += Object.keys(byTxid || {}).length;
        for (const [txid, label] of Object.entries(byTxid || {})) {
          owed('coinLabels', fileId, txid, label);
        }
        continue;
      }
      // One read per wallet rather than one per label, so a wallet with forty
      // labels costs one GET instead of forty comparisons we could not make.
      let current: Record<string, string> = {};
      try {
        const res: any = await api.getUtxos(inkey, walletId);
        const list: any[] = Array.isArray(res) ? res : res?.utxos || [];
        for (const u of list) {
          if (u?.txid) current[u.txid] = typeof u.label === 'string' ? u.label : '';
        }
      } catch {
        current = {};
      }
      for (const [txid, label] of Object.entries(byTxid || {})) {
        if (current[txid] === label) {
          r.kept++;
          continue;
        }
        // A txid this wallet has no coin from yet. Counted as pending WITHOUT
        // a call, because the endpoint would 404 and the answer is already
        // known from the read above.
        if (!(txid in current)) {
          r.pending++;
          owed('coinLabels', fileId, txid, label);
          continue;
        }
        try {
          await api.updateUtxoLabel(inkey, txid, label, walletId);
          r.added++;
        } catch (e) {
          if (isMissing(e)) r.pending++;
          else r.failed++;
          owed('coinLabels', fileId, txid, label);
        }
      }
    }
    out.coinLabels = r;
  }

  if (sections.addressLabels && api.getWalletAddresses && api.updateAddressLabel) {
    const r = { ...EMPTY };
    for (const [fileId, byAddr] of Object.entries(sections.addressLabels)) {
      const walletId = remap[fileId] || fileId;
      if (!liveIds.has(walletId)) {
        r.pending += Object.keys(byAddr || {}).length;
        for (const [addr, label] of Object.entries(byAddr || {})) {
          owed('addressLabels', fileId, addr, label);
        }
        continue;
      }
      // The address row's id is the SERVER's, so a restore cannot use the one
      // from the file: it matches on the address, which is what was handed
      // out, and takes the id the account holds for it now.
      let rows: any[] = [];
      try {
        const res: any = await api.getWalletAddresses(inkey, walletId);
        rows = Array.isArray(res) ? res : res?.addresses || [];
      } catch {
        rows = [];
      }
      const byAddress = new Map<string, any>();
      for (const a of rows) if (a?.sp_address) byAddress.set(a.sp_address, a);

      for (const [addr, label] of Object.entries(byAddr || {})) {
        const row = byAddress.get(addr);
        // An address this wallet does not have. A labelled address is created
        // by the user saving one, not by a scan, so a wallet deleted and added
        // back has none until they do — the same "not yet" as a coin, not a
        // failure.
        if (!row) {
          r.pending++;
          owed('addressLabels', fileId, addr, label);
          continue;
        }
        if ((row.label || '') === label) {
          r.kept++;
          continue;
        }
        try {
          await api.updateAddressLabel(inkey, walletId, row.id, label);
          r.added++;
        } catch {
          r.failed++;
          owed('addressLabels', fileId, addr, label);
        }
      }
    }
    out.addressLabels = r;
  }

  return out;
}
