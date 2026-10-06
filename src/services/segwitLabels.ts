import * as Keychain from 'react-native-keychain';

// What each SegWit address was handed out for, kept on this device only.
//
// NOT A FREEZE. Freezing exists on the Silent Payments side to defend against
// coins you did not ask for — a dust attack arrives unannounced and the
// defence is to refuse to spend it. A SegWit address is one you gave somebody
// on purpose, so there is nothing to defend against; what is actually hard is
// remembering WHICH somebody, six payments later. Hence a label.
//
// BY ADDRESS, which is both the natural unit here and the one the spend path
// already uses (plainChain.plainAddressTotals). One key is derived per address
// and spends every UTXO under it, and two payments to one address are already
// publicly linked — so "who paid this address" is the finest answer that means
// anything, and the address string is what the user actually handed over.
// Keyed on the address rather than the derivation index for the same reason:
// the index is internal bookkeeping that moves if the chain is re-walked from
// a different account, the address is the thing that was given away.
//
// DEVICE-ONLY, and for the same reason services/txLabels.ts is. A server-side
// map of address to "who I gave it to" is precisely the deanonymisation risk
// this wallet exists to avoid — worse here than for a txid, because an address
// is a thing the counterparty also holds. The server is never even told these
// coins exist: helpers/plain.py::scan_addresses reads them live from Fulcrum
// for the length of one request and keeps nothing.
//
// Stored in the platform keystore, which encrypts it at rest and lets the
// duress wipe erase it alongside the keys.

const LABELS_SERVICE = 'com.thrilla.segwitlabels';

/** walletId -> { address -> label }. */
export type SegwitLabelMap = Record<string, Record<string, string>>;

export const MAX_LABEL_LENGTH = 60;

function clean(raw: unknown): SegwitLabelMap {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: SegwitLabelMap = {};
  for (const [walletId, byAddress] of Object.entries(raw as Record<string, unknown>)) {
    if (!walletId || !byAddress || typeof byAddress !== 'object') continue;
    const inner: Record<string, string> = {};
    for (const [address, label] of Object.entries(
      byAddress as Record<string, unknown>,
    )) {
      // A stored blob is only as good as whatever last wrote it. Anything that
      // is not a non-empty string is dropped rather than rendered, so a
      // malformed entry cannot put `[object Object]` on a coin row.
      if (!address || typeof label !== 'string') continue;
      const trimmed = label.trim().slice(0, MAX_LABEL_LENGTH);
      if (trimmed) inner[address] = trimmed;
    }
    if (Object.keys(inner).length) out[walletId] = inner;
  }
  return out;
}

export async function loadSegwitLabels(): Promise<SegwitLabelMap> {
  try {
    const c = await Keychain.getGenericPassword({ service: LABELS_SERVICE });
    if (!c) return {};
    return clean(JSON.parse(c.password));
  } catch {
    return {};
  }
}

export async function persistSegwitLabels(map: SegwitLabelMap): Promise<void> {
  try {
    await Keychain.setGenericPassword('segwitlabels', JSON.stringify(map), {
      service: LABELS_SERVICE,
      accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED,
    });
  } catch {
    /* keystore unavailable — the in-memory map still applies this session */
  }
}

export async function wipeSegwitLabels(): Promise<void> {
  try {
    await Keychain.resetGenericPassword({ service: LABELS_SERVICE });
  } catch {
    /* nothing stored */
  }
}

/**
 * The map after setting one label. Returns a new object; never mutates.
 *
 * An emptied field REMOVES the entry rather than storing an empty string, so
 * clearing a label leaves nothing behind in the keystore to be recovered.
 */
export function withLabel(
  map: SegwitLabelMap,
  walletId: string,
  address: string,
  label: string,
): SegwitLabelMap {
  if (!walletId || !address) return map;
  const next: SegwitLabelMap = { ...map };
  const inner = { ...(next[walletId] || {}) };
  const trimmed = (label || '').trim().slice(0, MAX_LABEL_LENGTH);
  if (trimmed) inner[address] = trimmed;
  else delete inner[address];
  if (Object.keys(inner).length) next[walletId] = inner;
  else delete next[walletId];
  return next;
}

export function labelFor(
  map: SegwitLabelMap,
  walletId: string | null | undefined,
  address: string,
): string {
  if (!walletId) return '';
  return map[walletId]?.[address] || '';
}
