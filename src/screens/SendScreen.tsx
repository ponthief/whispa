import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Clipboard from '@react-native-clipboard/clipboard';
import { useAuthStore } from '@stores/authStore';
import { useAppLockStore } from '@stores/appLockStore';
import * as api from '@services/api';
import { undoesARound } from '@services/tango';
import { chainMismatch } from '@services/chains';
// Shared with the web app, so the two cannot say this differently.
import {
  CONTACT_UNVERIFIED,
  TANGO_UNDO_ACK,
  TANGO_UNDO_NOTE,
  TANGO_UNDO_TITLE,
} from '@services/sendWarnings';
import { getWalletKeys } from '@services/secureKeys';
import { usePendingSends } from '@stores/pendingSends';
import { useTxLabelStore } from '@stores/txLabelStore';
import { usePlainStatus } from '@stores/plainStatus';
import {
  isOwnSpAddress,
  keyMapForIndices,
  loadPlainChain,
  plainAddressTotals,
  type PlainAddressTotal,
  type PlainChainState,
} from '@services/plainChain';
import {
  buildSignedPlainTx,
  CHANGE_VBYTES,
  INPUT_VBYTES,
  OVERHEAD_VBYTES,
  type PlainBuiltTx,
} from '@services/plainSign';
import { usePlainHistory } from '@stores/plainHistoryStore';
import { labelFor } from '@services/segwitLabels';
import { useSegwitLabels } from '@stores/segwitLabelStore';
import { markScanStarted } from '@services/scanCooldown';
import { parseScannedAddress } from '@services/addressUri';
import { colors } from '@/theme';
import QRScanner from '../components/QRScanner';
import AmountSlider from '../components/AmountSlider';
import { useDrafts } from '@stores/draftStore';
import { sliderTop } from '@services/sendAmount';
import ContactsModal from '../components/ContactsModal';
import ConfirmLockModal from '../components/ConfirmLockModal';
import {
  buildSignedTx,
  estimateVsize,
  outputVbytesForAddress,
  TAPROOT_OUTPUT_VBYTES,
  type BuiltTx as SignedTx,
} from '@services/spSign';

type RecipientKind = 'sp' | 'onchain' | 'bitmail' | '';

// Classify a recipient so we can label it and gate contact-saving (the backend
// only saves sp/bitmail contacts, though sends also accept bech32 on-chain).
function recipientKind(v: string): RecipientKind {
  const s = v.trim().toLowerCase();
  if (!s) return '';
  if (s.includes('@')) return 'bitmail';
  if (s.startsWith('sp1') || s.startsWith('tsp1')) return 'sp';
  if (s.startsWith('bc1') || s.startsWith('tb1') || s.startsWith('bcrt1')) return 'onchain';
  return '';
}

const KIND_LABEL: Record<RecipientKind, string> = {
  sp: 'Silent Payment address',
  onchain: 'On-chain address',
  bitmail: 'BitMail',
  '': '',
};

const PRIMARY = colors.primary;

type Step = 'form' | 'review' | 'done';

const FEE_TIERS: { key: keyof api.FeeTiers; label: string; hint: string }[] = [
  { key: 'fastestFee', label: 'Fastest', hint: '~10 min' },
  { key: 'halfHourFee', label: 'Fast', hint: '~30 min' },
  { key: 'hourFee', label: 'Normal', hint: '~1 hr' },
  { key: 'economyFee', label: 'Economy', hint: 'slower' },
];

function groupThousands(n: number): string {
  return Math.floor(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// Blocks a wallet may lag the tip before the Send screen says so (~1 hour).
const STALE_BLOCKS = 6;

// A SegWit address's place in the shared selection set. Prefixed so it can
// never collide with an SP outpoint key, which would let a stale selection
// from the other side survive a flip and be spent.
function segwitKey(index: number): string {
  return `sw:${index}`;
}

function utxoKey(u: api.Utxo): string {
  return `${u.txid}:${u.vout}`;
}

// Live fee estimate. Sizes come from services/spSign.ts, mirroring
// helpers/txsize.py, so this matches what the builder charges.
//
// It did not, until txsize existed: the shared formula used 31 vB per output,
// which is a P2WPKH output, for outputs that are P2TR at 43. A two-output send
// was under-counted by 25 vB, and the estimate under-counted with it.
function estimateFee(
  numInputs: number,
  feeRate: number,
  recipient: string = '',
): number {
  if (!numInputs || !feeRate) return 0;
  const vsize = estimateVsize(numInputs, [
    outputVbytesForAddress(recipient),
    TAPROOT_OUTPUT_VBYTES,
  ]);
  return Math.max(1, Math.ceil(vsize * feeRate));
}

// The same estimate for the SegWit chain, whose inputs are a different size.
// P2WPKH in, not P2TR — services/plainSign.ts owns both numbers, so this reads
// them rather than carrying a second copy that could drift.
//
// An ESTIMATE, like its sibling: it drives the fee shown and the slider's
// ceiling. The server's prepare step does the arithmetic the signature
// commits to, and the two are cross-checked before anything is broadcast.
function estimateSegwitFee(
  numInputs: number,
  feeRate: number,
  recipient: string = '',
): number {
  if (!numInputs || !feeRate) return 0;
  const vsize =
    OVERHEAD_VBYTES +
    numInputs * INPUT_VBYTES +
    outputVbytesForAddress(recipient) +
    CHANGE_VBYTES;
  return Math.max(1, Math.ceil(vsize * feeRate));
}

// The builder's dust floor (helpers/wallet.py DUST_SATS), mirrored so the
// refusal happens here rather than three screens later. Stricter than Bitcoin
// Core's 330-sat relay floor for a P2TR output, and the same number the Coins
// screen uses to flag a received output as a suspected dust attack.
const DUST_SATS = 546;

export default function SendScreen() {
  const inkey = useAuthStore((s) => s.inkey);
  const adminkey = useAuthStore((s) => s.adminkey);
  // When an app lock (PIN or biometric) is on, re-authenticate before sending.
  const lockEnabled = useAppLockStore((s) => s.enabled);
  const [authOpen, setAuthOpen] = useState(false);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [noKeys, setNoKeys] = useState(false);

  const [wallet, setWallet] = useState<api.SilntWallet | null>(null);
  const [utxos, setUtxos] = useState<api.Utxo[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');

  const [tiers, setTiers] = useState<api.FeeTiers | null>(null);
  const [feeChoice, setFeeChoice] = useState<keyof api.FeeTiers | 'custom'>(
    'halfHourFee',
  );
  const [feeRate, setFeeRate] = useState<number>(1);
  // The custom rate is kept as text as well as a number. Deriving the field's
  // value from the number alone made "0." unrepresentable — it parses to 0,
  // renders as empty, and the decimal point you just typed vanishes.
  const [feeRateText, setFeeRateText] = useState<string>('1');

  // Which chain pays. 'sp' is the Silent Payments wallet below; 'segwit' is
  // the BIP-84 chain, which used to be spendable only from the card on the
  // RECEIVE tab — going to Receive in order to send.
  const [source, setSource] = useState<'sp' | 'segwit'>('sp');
  const isSegwit = source === 'segwit';
  const segwitSpendable = usePlainStatus((s) =>
    wallet && s.walletId === wallet.id && !s.pendingSpend ? s.spendableSats : 0,
  );
  // The SegWit chain, walked on the device. Held here rather than in a panel
  // of its own because the FORM is shared: one recipient field, one amount,
  // one fee control, one Review button, and only the coin list and the builder
  // change underneath. Two panels meant two of everything, which is what was
  // reported on 2026-10-06.
  const [segwitXprv, setSegwitXprv] = useState<string | null>(null);
  const [segwitChain, setSegwitChain] = useState<PlainChainState | null>(null);
  const [segwitTotals, setSegwitTotals] = useState<PlainAddressTotal[]>([]);
  const [segwitLoading, setSegwitLoading] = useState(false);

  const [step, setStep] = useState<Step>('form');
  const [built, setBuilt] = useState<SignedTx | null>(null);
  const [segwitBuilt, setSegwitBuilt] = useState<PlainBuiltTx | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txid, setTxid] = useState('');
  const [scanning, setScanning] = useState(false);

  // BitMail is the one recipient kind that can fail for reasons outside the
  // address itself, and it used to fail at Build — after the amount, the coins
  // and the fee had all been chosen. Resolving it earlier puts the answer under
  // the field that caused it.
  //
  // Only on Paste, Scan and Contacts, though: an address arriving whole is one
  // worth one lookup. Checking on blur instead meant a DNS round trip every
  // time focus left the field, including the blur that Keyboard.dismiss() fires
  // on the way into Build. A typed BitMail is checked at Build, which now
  // raises an alert rather than a line below the fold.
  const [bitmailWarning, setBitmailWarning] = useState('');
  const [bitmailInvalid, setBitmailInvalid] = useState(false);
  const [bitmailChecking, setBitmailChecking] = useState(false);
  // What the last checked BitMail resolved to. Kept so the self-send warning
  // can compare the ADDRESS rather than the typed string — a BitMail is never
  // equal to an sp1…, so comparing text alone never fires for one.
  const [resolvedSp, setResolvedSp] = useState('');
  // Set once the user has said "send to myself", so the second (build-time)
  // check does not ask again about the same send.
  const selfAcked = useRef(false);

  // A catch-up scan (often thousands of blocks) can be running server-side after
  // login. While it is, this wallet's coin set is still incomplete, so sending
  // is paused until it finishes — then the user spends from a complete,
  // up-to-date balance (and can't trip the backend's "state just changed"
  // rejection). Progress is polled to clear the block the moment it's done.
  const [scanActive, setScanActive] = useState(false);
  const [scanCur, setScanCur] = useState(0);
  const [scanTot, setScanTot] = useState(0);

  // A wallet can also be behind the tip with NO scan running (the catch-up
  // prompt was dismissed, background scanning is off, a scan hit its cooldown).
  // Nothing is mid-flight then, so sending isn't paused — but the coin list may
  // be missing recent payments, which is worth saying out loud.
  const [tipHeight, setTipHeight] = useState(0);
  const [catchUpBusy, setCatchUpBusy] = useState(false);
  const [catchUpMsg, setCatchUpMsg] = useState<string | null>(null);

  const [contacts, setContacts] = useState<api.SpContact[]>([]);
  const [showContacts, setShowContacts] = useState(false);
  const [savingContact, setSavingContact] = useState(false);
  const [showSaveContact, setShowSaveContact] = useState(false);
  const [contactLabel, setContactLabel] = useState('');
  const [contactMsg, setContactMsg] = useState<string | null>(null);


  const loadContacts = useCallback(async () => {
    if (!inkey) return;
    try {
      setContacts(await api.listContacts(inkey));
    } catch {
      setContacts([]);
    }
  }, [inkey]);

  const load = useCallback(async (silent = false) => {
    if (!inkey) {
      setLoading(false);
      return;
    }
    if (!silent) setLoading(true);
    setLoadError(null);
    setMissing(false);
    setNoKeys(false);
    try {
      const wallets = await api.getSilntWallets(inkey);
      const w = api.pickSilntWallet(wallets);
      if (!w) {
        setWallet(null);
        setMissing(true);
        return;
      }
      setWallet(w);
      setNoKeys(!(await getWalletKeys(w.id)));

      const [utxoRes, feeRes, tipRes] = await Promise.allSettled([
        api.getUtxos(inkey, w.id),
        api.getRecommendedFees(inkey),
        api.getChainTip(inkey),
      ]);

      if (utxoRes.status === 'fulfilled') {
        setUtxos(
          utxoRes.value.filter(
            // Held by a live Tango counts as unspendable here, like frozen.
            (u) => u.utxo_state === 'unspent' && !u.frozen && !u.tango_reserved,
          ),
        );
      } else {
        setUtxos([]);
      }

      if (feeRes.status === 'fulfilled') {
        setTiers(feeRes.value);
        const def = feeRes.value.halfHourFee ?? feeRes.value.fastestFee;
        if (def) {
          setFeeRate(def);
          setFeeRateText(String(def));
        }
      }

      // Unavailable oracle → 0, which reads as "can't tell" and shows no
      // warning rather than a bogus one.
      setTipHeight(
        tipRes.status === 'fulfilled' ? Number(tipRes.value?.height) || 0 : 0,
      );
    } catch (e: any) {
      setLoadError(e?.message || 'Failed to load wallet.');
    } finally {
      setLoading(false);
    }
  }, [inkey]);

  useEffect(() => {
    load();
    loadContacts();
  }, [load, loadContacts]);

  // Keep `load` reachable from the scan-watcher without making it a dependency
  // (avoids re-arming the poll every reload).
  const loadRef = useRef(load);
  loadRef.current = load;
  const wasScanningRef = useRef(false);

  // Poll for an in-flight catch-up scan while this screen is open. `scanActive`
  // gates the Review button; on the active → done transition we quietly refresh
  // so the just-scanned coins are present before the user sends.
  useEffect(() => {
    if (!inkey || !wallet?.id) return undefined;
    let cancelled = false;
    const walletId = wallet.id;
    const tick = async () => {
      try {
        const p = await api.getScanProgress(inkey, walletId);
        if (cancelled) return;
        const active = !!p.active;
        setScanActive(active);
        setScanCur(Number(p.current) || 0);
        setScanTot(Number(p.total) || 0);
        if (!active && wasScanningRef.current) loadRef.current(true);
        wasScanningRef.current = active;
      } catch {
        /* transient — keep polling */
      }
    };
    tick();
    const timer = setInterval(tick, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [inkey, wallet?.id]);

  const rKind = recipientKind(recipient);
  // Paying this wallet's own Silent Payment address. Easy to do by accident —
  // scanning the receive QR from the web app on the same wallet lands here —
  // and it costs a fee to move coins to yourself while publicly linking the
  // inputs to the new output. Legitimate for consolidation, so warn rather
  // than block.
  //
  // Three ways to name your own wallet, and text equality only catches the
  // first: the sp1… itself, this wallet's own BitMail (hr_address), and any
  // BitMail that RESOLVES to this wallet. The last one is why a BitMail
  // self-send went through unwarned — it is not the same string as anything
  // this wallet calls itself.
  const own = (wallet?.sp_address || '').trim().toLowerCase();
  const ownBitmail = (wallet?.hr_address || '').trim().toLowerCase();
  const typed = recipient.trim().toLowerCase();
  const isSelfSend =
    (!!own && typed === own) ||
    (!!ownBitmail && typed === ownBitmail) ||
    (!!own && !!resolvedSp && resolvedSp.trim().toLowerCase() === own);
  const saveable = rKind === 'sp' || rKind === 'bitmail';
  const unverified = useMemo(() => {
    const v = recipient.trim().toLowerCase();
    if (!v) return false;
    const c = contacts.find((x) => (x.value || '').toLowerCase() === v);
    return !!c && c.kind === 'sp' && c.whispa === false;
  }, [contacts, recipient]);

  const alreadySaved = contacts.some(
    (c) => c.value.trim().toLowerCase() === recipient.trim().toLowerCase(),
  );

  // Is the recipient on this wallet's chain? Mirrors helpers/chains.py; the
  // server refuses the send either way, and this is so the refusal arrives
  // while the address is being typed. The whole reason it needs saying: a
  // mainnet sp1… derives a perfectly valid signet output, so nothing
  // downstream notices and the coins are simply gone.
  //
  // Depends on the network string rather than the wallet object, so a refresh
  // that returns an equal wallet does not recompute it.
  const walletNetwork = wallet?.network || '';
  const chainWarning = useMemo(
    () => (walletNetwork ? chainMismatch(recipient, walletNetwork) : null),
    [recipient, walletNetwork],
  );

  const onSaveContact = useCallback(async () => {
    if (!inkey) return;
    const value = recipient.trim();
    // A contact is stored per network and only ever offered on that network,
    // so one on the wrong chain is a send that cannot succeed under a name
    // that says it can. The endpoint refuses it too.
    if (chainWarning) {
      setContactMsg(chainWarning);
      return;
    }
    setSavingContact(true);
    setContactMsg(null);
    try {
      await api.createContact(inkey, contactLabel.trim() || value, value);
      setContactLabel('');
      setShowSaveContact(false);
      setContactMsg('Contact saved.');
      await loadContacts();
    } catch (e: any) {
      setContactMsg(e?.message || 'Could not save contact.');
    } finally {
      setSavingContact(false);
    }
  }, [inkey, recipient, contactLabel, loadContacts, chainWarning]);

  const onDeleteContact = useCallback(
    async (id: string) => {
      if (!inkey) return;
      try {
        await api.deleteContact(inkey, id);
        await loadContacts();
      } catch {
        /* ignore */
      }
    },
    [inkey, loadContacts],
  );

  const segwitLabels = useSegwitLabels((st) => st.byWallet);
  const segwitLabelOf = useCallback(
    (address: string) => labelFor(segwitLabels, wallet?.id, address),
    [segwitLabels, wallet?.id],
  );
  const toggleSegwit = useCallback((index: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const k = segwitKey(index);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }, []);

  const toggleUtxo = useCallback((u: api.Utxo) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const k = utxoKey(u);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }, []);

  // ── Surviving a lock ──────────────────────────────────────────────────────
  // App.tsx unmounts the whole Shell when the lock engages, so everything
  // above is gone the moment the screen times out — including a coin
  // selection that took real work. See stores/draftStore.ts.
  const walletId = wallet?.id || '';
  const restored = useRef('');
  useEffect(() => {
    // Once per wallet, and only once the coins are in: restoring a selection
    // before `utxos` has loaded would be filtered down to nothing by the
    // guard below and written straight back as empty.
    if (!walletId || restored.current === walletId || !utxos.length) return;
    restored.current = walletId;
    const draft = useDrafts.getState().send[walletId];
    if (!draft) return;
    // A coin spent or frozen while the phone was locked is simply not in
    // `utxos` any more, so it drops out here rather than being re-offered.
    const live = new Set(utxos.map((u) => utxoKey(u)));
    setSelected(new Set(draft.selected.filter((k) => live.has(k))));
    setAmount(draft.amount);
    setRecipient(draft.recipient);
  }, [walletId, utxos]);

  useEffect(() => {
    if (!walletId || restored.current !== walletId) return;
    useDrafts.getState().setSend(walletId, {
      selected: [...selected],
      amount,
      recipient,
    });
  }, [walletId, selected, amount, recipient]);

  // Walked when the SegWit side is chosen, not on every mount: it costs a
  // chain-index request, and the endpoint is capped at thirty a minute.
  useEffect(() => {
    let dead = false;
    if (!isSegwit || !wallet || !inkey) return;
    (async () => {
      setSegwitLoading(true);
      try {
        const keys = await getWalletKeys(wallet.id);
        const xprv = keys?.sweepAccount || null;
        if (dead) return;
        setSegwitXprv(xprv);
        if (!xprv) {
          setSegwitChain(null);
          setSegwitTotals([]);
          return;
        }
        const next = await loadPlainChain(
          (addresses) => api.getPlainPreview(inkey, wallet.id, addresses),
          xprv,
          wallet.network,
        );
        if (dead) return;
        setSegwitChain(next);
        setSegwitTotals(plainAddressTotals(next));
      } catch {
        if (!dead) {
          setSegwitChain(null);
          setSegwitTotals([]);
        }
      } finally {
        if (!dead) setSegwitLoading(false);
      }
    })();
    return () => {
      dead = true;
    };
  }, [isSegwit, wallet, inkey]);

  // A selection made on one side means nothing on the other, and the keys are
  // prefixed so a leftover could not be spent by accident — but leaving it
  // would show a coin count against a list that does not contain it.
  useEffect(() => {
    setSelected(new Set());
    setAmount('');
  }, [source]);

  const selectedUtxos = useMemo(
    () => utxos.filter((u) => selected.has(utxoKey(u))),
    [utxos, selected],
  );
  // The SegWit side of the same selection. Keyed by DERIVATION INDEX, because
  // that chain picks by address: one key is derived per address and spends
  // every UTXO under it, so there is no choosing between two payments that
  // landed on the same one.
  const selectedSegwit = useMemo(
    () => segwitTotals.filter((t) => selected.has(segwitKey(t.index))),
    [segwitTotals, selected],
  );
  // How many INPUTS the selection is worth, which is what a fee is priced on.
  // An address holding three payments is three inputs, not one — the
  // difference between those two numbers is the fee being wrong.
  const selectedInputCount = isSegwit
    ? selectedSegwit.reduce((n, t) => n + t.utxoCount, 0)
    : selectedUtxos.length;
  const selectedTotal = useMemo(
    () =>
      isSegwit
        ? selectedSegwit.reduce((s, t) => s + t.sats, 0)
        : selectedUtxos.reduce((s, u) => s + u.amount, 0),
    [isSegwit, selectedSegwit, selectedUtxos],
  );
  const amountSats = Number(amount) || 0;
  const estFee = isSegwit
    ? estimateSegwitFee(selectedInputCount, feeRate, recipient)
    : estimateFee(selectedInputCount, feeRate, recipient);
  const insufficient =
    amountSats > 0 && selectedTotal > 0 && amountSats + estFee > selectedTotal;

  // Every spendable coin on the chosen side, which is what the amount slider
  // runs over before any have been picked. `utxos` is already filtered to
  // unspent, unfrozen and not held by a live Tango.
  const spendableTotal = useMemo(
    () =>
      isSegwit
        ? segwitTotals.reduce((s, t) => s + t.sats, 0)
        : utxos.reduce((s, u) => s + u.amount, 0),
    [isSegwit, segwitTotals, utxos],
  );
  // The most the selection can pay once the fee is taken. Negative when the
  // coins cannot even cover the fee.
  const maxSendable = selectedTotal > 0 ? selectedTotal - estFee : 0;
  // An amount below the dust floor is refused by the builder, so refuse it here
  // where the number was typed.
  const belowDust = amountSats > 0 && amountSats < DUST_SATS;
  // The case actually reported: a coin so small that NO amount works. Checking
  // only amount + fee ≤ total let a 561-sat coin through, because 432 sats is
  // affordable — it is just not a payment anyone can make. Flagging the
  // selection rather than the amount matters: there is nothing to retype.
  const selectionTooSmall =
    selectedInputCount > 0 && feeRate > 0 && maxSendable < DUST_SATS;

  // How far this wallet has been scanned vs. the chain tip. last_scan_height is
  // progress, last_height the birth height (static) — a wallet born at the tip
  // has no progress yet but is up to date, so take the max (same rule as the
  // catch-up scan).
  const walletHeight = Math.max(
    Number(wallet?.last_scan_height ?? 0),
    Number(wallet?.last_height ?? 0),
  );
  const blocksBehind =
    tipHeight && walletHeight ? Math.max(0, tipHeight - walletHeight) : 0;
  // Blocks arrive every ~10 minutes, so a handful behind is normal and warning
  // about it would be noise. ~1 hour without scanning is worth flagging.
  const behind = !scanActive && blocksBehind > STALE_BLOCKS;

  // A Tango share selected together with Tango change — from any round, not
  // only its own. Not a matter of degree like the multi-input caution below
  // it: change is attributable by construction (its value plus a share is an
  // input total), a share is the coin that history was cut off from, and one
  // transaction holding both repairs the cut. It does not weaken that round,
  // it undoes it, and no later mix puts it back.
  //
  // services/tango.ts::undoesARound is the rule, mirrored from
  // helpers/tango.py and cross-checked by check:signing:tango. It reads the
  // labels the backend writes when the scanner finds the coins.
  const tangoPairing = useMemo(
    // The whole coin, not just its name: the guard needs the txid to see
    // two pieces of one round. See services/tango.ts::undoesARound.
    // Reads the SP selection only, which is correct rather than incidental: a
    // Tango share is always a Silent Payments coin, so the SegWit side has
    // none to undo and `selectedUtxos` is empty there anyway.
    () => undoesARound(selectedUtxos.map((u) => ({ txid: u.txid, label: u.label }))),
    [selectedUtxos],
  );
  // Gates Build rather than merely appearing above it. The user can still say
  // yes — consolidating a round they have stopped caring about is their call —
  // but not by not noticing. Cleared whenever the pairing changes, so a tick
  // made for one selection cannot carry to another.
  const [tangoAck, setTangoAck] = useState(false);
  useEffect(() => {
    setTangoAck(false);
  }, [tangoPairing]);

  const canBuild =
    !!recipient.trim() &&
    !chainWarning &&
    amountSats > 0 &&
    selectedInputCount > 0 &&
    feeRate > 0 &&
    !insufficient &&
    !belowDust &&
    !selectionTooSmall &&
    !bitmailInvalid &&
    !bitmailChecking &&
    !noKeys &&
    !scanActive &&
    (!tangoPairing || tangoAck);

  const pickTier = useCallback(
    (key: keyof api.FeeTiers | 'custom') => {
      setFeeChoice(key);
      if (key !== 'custom' && tiers && tiers[key]) {
        setFeeRate(tiers[key] as number);
        // Switching to Custom should start from the rate you were just on,
        // not from whatever was last typed.
        setFeeRateText(String(tiers[key]));
      }
    },
    [tiers],
  );

  // A failure that follows a tap gets an alert, not a line of red text below
  // the fold. The inline copy stays as the record once the alert is dismissed —
  // the alert is what makes it seen, not where it lives. Live validation (dust,
  // insufficient funds) deliberately does NOT come through here: it updates as
  // you type, and a modal per keystroke would be unusable.
  const failed = useCallback((title: string, message: string) => {
    setError(message);
    Alert.alert(title, message, [{ text: 'OK' }]);
  }, []);

  // Only a verdict about the address blocks. A 502, or a request that never
  // landed, says the lookup didn't complete — not that the address is bad — so
  // it warns and lets them carry on; the resolve at build time decides.
  // A new recipient is a new question: neither the old resolution nor the old
  // "yes, send to myself" applies to it.
  useEffect(() => {
    setResolvedSp('');
    selfAcked.current = false;
  }, [recipient]);

  const validateBitmail = useCallback(
    async (value: string) => {
      const v = (value || '').trim();
      setBitmailWarning('');
      setBitmailInvalid(false);
      if (!v.includes('@') || !inkey) return;
      setBitmailChecking(true);
      try {
        setResolvedSp(api.spFromResolve(await api.resolveBip353(inkey, v)));
      } catch (e: any) {
        const transient = !e?.status || e.status >= 500;
        setBitmailWarning(
          e?.detail ||
            (transient
              ? `Couldn’t check ${v} right now — the lookup didn’t complete. ` +
                `The address may be fine; try again in a moment.`
              : e?.message || `${v} could not be resolved.`),
        );
        setBitmailInvalid(!transient);
      } finally {
        setBitmailChecking(false);
      }
    },
    [inkey],
  );

  // Sign the planned transaction on this device and move to review. Split out
  // of doBuild so the self-send prompt can carry on from the plan it already
  // has instead of asking the server the same question twice.
  const signAndReview = useCallback(
    async (plan: api.PreparedTx, keys: { spendKey: string; scanSecret: string }) => {
      const result = buildSignedTx({
        recipient: plan.recipient,
        recipientScriptHex: plan.recipient_script || undefined,
        amount: plan.amount,
        feeRate: plan.fee_rate,
        utxos: plan.utxos,
        spendKey: keys.spendKey,
        scanSecret: keys.scanSecret,
        network: plan.network,
      });

      // The server quoted these before anything was signed; the signature
      // commits to them. A disagreement means the two sides computed different
      // transactions, and the only safe move is to stop rather than broadcast
      // one of them.
      if (result.fee !== plan.fee || result.change !== plan.change) {
        throw new Error(
          `Refusing to send: this phone and the server disagree on the ` +
            `amounts (fee ${result.fee} vs ${plan.fee}, change ${result.change} ` +
            `vs ${plan.change}). Try again in a moment.`,
        );
      }
      setBuilt(result);
      setStep('review');
    },
    [],
  );

  // The SegWit build. Same shape as the Silent Payments one below — the server
  // finds the coins and does the arithmetic because only it can reach the chain
  // index, the device signs, and the two are cross-checked before anything is
  // broadcast — but a different prepare, a different builder and a different
  // broadcast. This is the whole of what the chain picker changes.
  const buildSegwit = useCallback(async () => {
    Keyboard.dismiss();
    setError(null);
    if (!wallet || !adminkey || !segwitXprv || !segwitChain) return;
    setBusy(true);
    try {
      const indices = selectedSegwit.map((t) => t.index);
      const keys = keyMapForIndices(segwitXprv, wallet.network, indices);
      // Change goes to the chain's next unused address, so paying out does not
      // put the remainder back on one that has now been seen spending.
      const sendingAll = amountSats >= selectedTotal - estFee;
      const changeAddress = sendingAll ? null : segwitChain.receiveAddress;

      const plan = await api.preparePlainSpend(
        adminkey,
        wallet.id,
        Object.keys(keys),
        recipient.trim(),
        amountSats,
        changeAddress,
        feeRate,
      );

      const res = buildSignedPlainTx({
        destination: recipient.trim(),
        utxos: plan.utxos,
        keys,
        amount: amountSats,
        feeRate,
        changeAddress,
        network: wallet.network,
        expectDestinationScriptHex: plan.destination_script,
      });

      // The server quoted these before anything was signed and the signature
      // commits to them. A disagreement means the two sides built different
      // transactions, and neither should go out.
      if (res.fee !== plan.fee || res.change !== plan.change || res.amount !== plan.amount) {
        throw new Error(
          `Refusing to send: this phone and the server disagree on the amounts ` +
            `(fee ${res.fee} vs ${plan.fee}, change ${res.change} vs ` +
            `${plan.change}). Try again in a moment.`,
        );
      }
      setSegwitBuilt(res);
      setStep('review');
    } catch (e: any) {
      setError(e?.detail || e?.message || 'Could not build the transaction.');
    } finally {
      setBusy(false);
    }
  }, [
    wallet,
    adminkey,
    segwitXprv,
    segwitChain,
    selectedSegwit,
    recipient,
    amountSats,
    feeRate,
    selectedTotal,
    estFee,
  ]);

  const doBuild = useCallback(async () => {
    Keyboard.dismiss();
    setError(null);
    if (!wallet || !adminkey || !inkey) return;
    setBusy(true);
    try {
      const keys = await getWalletKeys(wallet.id);
      if (!keys) {
        failed(
          'Keys not on this device',
          'Wallet keys are not on this device. Re-import the wallet to send.',
        );
        setBusy(false);
        return;
      }
      // The server still decides which coins may be spent and what a BitMail
      // resolves to — /tx/prepare runs the same guards /tx/build did — but it
      // never sees a key. The outputs are derived and the inputs signed here,
      // on the device, and only the finished transaction goes back out.
      const plan = await api.prepareTx(adminkey, {
        walletId: wallet.id,
        recipient: recipient.trim(),
        amount: amountSats,
        feeRate,
        utxos: selectedUtxos,
      });

      // The authoritative self-send check. The pre-review one can only work
      // from what the screen knows, and a TYPED BitMail is never pre-resolved —
      // the lookup runs on paste, scan and contacts only, by design. /tx/prepare
      // is where a BitMail actually becomes an address, so this is the first
      // point at which "am I paying myself?" is answerable for every recipient.
      //
      // Nothing is signed or sent yet, so asking here costs only the round trip.
      if (
        wallet.sp_address &&
        plan.recipient.trim().toLowerCase() ===
          wallet.sp_address.trim().toLowerCase() &&
        !selfAcked.current
      ) {
        setBusy(false);
        Alert.alert(
          'This is your own address',
          `${recipient.trim()} is this wallet's own address. It works, but it ` +
            'costs a fee and links the coins you spend to the new output ' +
            'on-chain. Send elsewhere unless you meant to consolidate.',
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Send to myself',
              onPress: () => {
                selfAcked.current = true;
                // Continue with the plan already fetched rather than asking
                // for another: the answer would be identical and it is a round
                // trip the user waits on.
                setBusy(true);
                signAndReview(plan, keys)
                  .catch((e: any) =>
                    failed('Couldn’t send', e?.message || 'Could not build the transaction.'),
                  )
                  .finally(() => setBusy(false));
              },
            },
          ],
        );
        return;
      }

      await signAndReview(plan, keys);
    } catch (e: any) {
      // The recipient is the overwhelmingly common reason a build fails, and
      // the backend's message already says which address and what to do about
      // it, so the title only has to say which half of the form to look at.
      failed(
        rKind === 'bitmail' ? 'Couldn’t use that BitMail' : 'Couldn’t send',
        e?.message || 'Could not build the transaction.',
      );
    } finally {
      setBusy(false);
    }
  }, [
    wallet,
    adminkey,
    inkey,
    recipient,
    amountSats,
    feeRate,
    selectedUtxos,
    rKind,
    failed,
    signAndReview,
  ]);

  const doBroadcast = useCallback(async () => {
    if (!wallet || !adminkey) return;

    // The SegWit broadcast. Separate from the Silent Payments one because the
    // server tracks nothing about these coins: there are no outpoints to mark
    // spent, and the only record of where the money went is the one written
    // here.
    if (isSegwit) {
      if (!segwitBuilt) return;
      setError(null);
      setBusy(true);
      try {
        const to = recipient.trim();
        const self = !!wallet.sp_address && isOwnSpAddress(to, wallet.sp_address);
        const res = await api.broadcastPlainTx(
          adminkey,
          wallet.id,
          segwitBuilt.tx_hex,
          self ? segwitBuilt.amount : null,
        );
        setTxid(res.txid);
        // The chain index lags a mempool spend, so until it catches up a walk
        // still reports these coins as spendable — and the balance, the slider
        // and the coin list would all offer money already on its way, building
        // a conflicting transaction. PlainSendModal did this through `onSpent`
        // and the shared form lost it in the move; without it the SegWit total
        // simply does not change after a send.
        usePlainStatus.getState().markSpent({
          txid: res.txid,
          balanceAtSpend: spendableTotal,
          at: Date.now(),
        });
        // WITHOUT THIS THE MONEY JUST LEAVES. The server never lists these as
        // pending — it does not hold the coins — so the local entry IS the row
        // until it confirms. Reported 2026-10-06.
        usePendingSends.getState().add({
          txid: res.txid,
          walletId: wallet.id,
          amountSats: segwitBuilt.amount || null,
          kind: self ? 'plain' : 'segwit',
        });
        if (to) {
          useTxLabelStore
            .getState()
            .setLabel(
              res.txid,
              self
                ? 'From SegWit address'
                : to.length > 20
                ? `${to.slice(0, 10)}…${to.slice(-8)}`
                : to,
            )
            .catch(() => {});
        }
        // The only durable record of a payment OUT of this chain. Device-only
        // on purpose — see services/plainHistory.ts.
        usePlainHistory.getState().record(wallet.id, {
          txid: res.txid,
          amount: segwitBuilt.amount,
          fee: segwitBuilt.fee,
          destination: to,
          at: Date.now(),
          toSelf: self,
        });
        setStep('done');
      } catch (e: any) {
        failed('Broadcast failed', e?.detail || e?.message || 'Broadcast failed.');
      } finally {
        setBusy(false);
      }
      return;
    }

    if (!built) return;
    setError(null);
    setBusy(true);
    try {
      const res = await api.broadcastTx(
        adminkey,
        built.tx_hex,
        wallet.id,
        selectedUtxos.map((u) => ({ txid: u.txid, vout: u.vout })),
        { recipient: recipient.trim(), amount: amountSats, fee: built.fee },
      );
      setTxid(res.txid);
      // Start the confirmation watch immediately, before any list refresh.
      usePendingSends.getState().add({
        txid: res.txid,
        walletId: wallet.id,
        amountSats: amountSats || null,
      });
      // Remember a BitMail recipient locally, matching the web app: it is the
      // one part of a send not derivable from the chain, and it names the
      // transaction before any change output exists to label. Raw sp1…/bc1…
      // are already on-chain, so there is nothing to remember.
      const typed = recipient.trim();
      if (typed.includes('@')) {
        useTxLabelStore.getState().setLabel(res.txid, typed).catch(() => {});
      }
      setStep('done');
    } catch (e: any) {
      // The one place where "did it go?" matters most — never a line they can
      // scroll past.
      failed('Broadcast failed', e?.message || 'Broadcast failed.');
    } finally {
      setBusy(false);
    }
  }, [built, segwitBuilt, isSegwit, wallet, adminkey, selectedUtxos, recipient, amountSats, spendableTotal, failed]);

  // Start a catch-up scan from here, so a wallet that's behind can be brought
  // up to date without leaving the Send screen. The existing poller takes over:
  // it flips to the "Sending is paused" banner and reloads the coins when the
  // scan finishes.
  const onCatchUp = useCallback(async () => {
    if (!inkey || !wallet) return;
    setCatchUpBusy(true);
    setCatchUpMsg(null);
    try {
      const keys = await getWalletKeys(wallet.id);
      if (!keys) {
        setCatchUpMsg(
          "This wallet's keys aren't on this device, so it can only be scanned " +
            'where they are.',
        );
        return;
      }
      await api.startScan(inkey, wallet.id, keys.scanSecret, walletHeight, null);
      markScanStarted(wallet.id);
      // Show the paused banner immediately rather than after the next poll, and
      // make sure the poller's active → done transition reloads the coin list.
      wasScanningRef.current = true;
      setScanActive(true);
    } catch (e: any) {
      const msg = e?.message || 'Could not start a scan.';
      // Already running / per-wallet cooldown: benign here, the poller picks it
      // up either way.
      setCatchUpMsg(
        /recently|already|budget|too many/i.test(msg)
          ? 'Already scanning — it will catch up shortly.'
          : msg,
      );
    } finally {
      setCatchUpBusy(false);
    }
  }, [inkey, wallet, walletHeight]);

  // Require re-authentication (PIN/biometric) first when an app lock is
  // enabled. Building reads the spend key out of the keychain and signs with
  // it, so gate here rather than at the final broadcast. With no lock, proceed
  // straight to the review step.
  const proceedToReview = useCallback(() => {
    if (lockEnabled) {
      Keyboard.dismiss();
      setAuthOpen(true);
      return;
    }
    if (isSegwit) buildSegwit();
    else doBuild();
  }, [lockEnabled, isSegwit, buildSegwit, doBuild]);

  // The coin-merging confirmation, split out so the self-send warning can run
  // ahead of it and still chain into it.
  const confirmCoinsThenReview = useCallback(() => {
    // Merging coins is the one choice on this screen that can't be undone after
    // broadcast — the link between them is published on-chain for good. The
    // inline note sits below a long coin list where it's easy to scroll past,
    // so confirm it here, where it can't be missed.
    // INPUTS, not rows. Spending one SegWit address holding three payments
    // links three coins on chain exactly as picking three SP coins does, and
    // counting rows would skip the warning for the case that needs it most.
    if (selectedInputCount > 1) {
      Keyboard.dismiss();
      Alert.alert(
        `Combine ${selectedInputCount} coins?`,
        `Spending ${selectedInputCount} coins in one transaction publicly ` +
          'links them to the same owner — you — and that link is permanent. ' +
          'Spend a single coin when one covers the amount.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Combine anyway', onPress: proceedToReview },
        ],
      );
      return;
    }
    proceedToReview();
  }, [selectedInputCount, proceedToReview]);

  const onReview = useCallback(() => {
    if (busy) return;
    if (isSelfSend) {
      Keyboard.dismiss();
      Alert.alert(
        'This is your own address',
        "You're about to pay this wallet's own Silent Payment address. It " +
          'works, but it costs a fee and links the coins you spend to the new ' +
          'output on-chain. Send elsewhere unless you meant to consolidate.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Send to myself', onPress: () => confirmCoinsThenReview() },
        ],
      );
      return;
    }
    confirmCoinsThenReview();
  }, [busy, isSelfSend, confirmCoinsThenReview]);

  // The unlock gate guards both builds — it is the device authorising a spend,
  // and which chain pays is beneath that question, not above it.
  const onAuthenticated = useCallback(() => {
    setAuthOpen(false);
    if (isSegwit) buildSegwit();
    else doBuild();
  }, [isSegwit, buildSegwit, doBuild]);

  const reset = useCallback(() => {
    setStep('form');
    setBuilt(null);
    setError(null);
    setTxid('');
    setRecipient('');
    setAmount('');
    setSelected(new Set());
    setBitmailWarning('');
    setBitmailInvalid(false);
    if (wallet?.id) useDrafts.getState().clearSend(wallet.id);
    load();
  }, [load, wallet?.id]);

  // ── Render ────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.center}>
          <ActivityIndicator color={PRIMARY} />
        </View>
      </SafeAreaView>
    );
  }

  if (missing) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.center}>
          <Text style={styles.info}>
            No Silent Payments wallet on this network. Create one on the Wallet
            tab first.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  if (loadError) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.center}>
          <Text style={styles.error}>{loadError}</Text>
          <TouchableOpacity style={styles.primaryBtn} onPress={() => load()}>
            <Text style={styles.primaryBtnText}>Retry</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  if (step === 'done') {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.center}>
          <Text style={styles.doneIcon}>✓</Text>
          <Text style={styles.doneTitle}>Transaction broadcast</Text>
          <Text style={styles.doneSub}>
            {groupThousands(amountSats)} sats sent
          </Text>
          <Text style={styles.txidLabel}>Transaction ID</Text>
          <Text style={styles.txid} numberOfLines={1}>
            {txid}
          </Text>
          <TouchableOpacity
            style={styles.ghostBtn}
            onPress={() => Clipboard.setString(txid)}>
            <Text style={styles.ghostBtnText}>Copy TXID</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.primaryBtn} onPress={reset}>
            <Text style={styles.primaryBtnText}>Done</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // ONE REVIEW SCREEN. Whichever side paid, what the user is being asked to
  // confirm is the same four numbers, so the step reads the fee off whichever
  // build produced it rather than existing twice.
  const reviewing = isSegwit ? segwitBuilt : built;
  if (step === 'review' && reviewing) {
    const total = amountSats + (reviewing.fee || 0);
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.header}>Review</Text>
          <View style={styles.card}>
            <ReviewRow label="To" value={recipient.trim()} mono />
            <ReviewRow label="Amount" value={`${groupThousands(amountSats)} sats`} />
            <ReviewRow
              label="Network fee"
              value={`${groupThousands(reviewing.fee || 0)} sats`}
            />
            {/* The coin count drives both the fee and the on-chain link between
                them, so it belongs on the last screen before broadcast. The
                SegWit count is INPUTS, not addresses: an address holding three
                payments links three coins, and saying "1" would understate
                exactly the thing this row is for. */}
            <ReviewRow
              label="Coins"
              value={
                selectedInputCount > 1
                  ? `${selectedInputCount} — linked on-chain`
                  : '1'
              }
            />
            <View style={styles.divider} />
            <ReviewRow label="Total" value={`${groupThousands(total)} sats`} bold />
          </View>

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <TouchableOpacity
            style={[styles.primaryBtn, busy && styles.btnDisabled]}
            onPress={doBroadcast}
            disabled={busy}>
            {busy ? (
              <ActivityIndicator color={colors.onPrimary} />
            ) : (
              <Text style={styles.primaryBtnText}>Confirm &amp; Send</Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.linkBtn}
            onPress={() => {
              setStep('form');
              setError(null);
            }}
            disabled={busy}>
            <Text style={styles.linkBtnText}>Back</Text>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // step === 'form'
  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled">
          <Text style={styles.header}>Send</Text>

          {/* WHICH POCKET. Both are spendable balances on this wallet and they
              cannot share a transaction, so the choice has to be made before
              anything else on the form means something — a recipient and an
              amount read differently depending on which chain pays them.
              Offered only when there is something on the SegWit side: a second
              tab that is always empty is a question nobody needs asked. */}
          {segwitSpendable > 0 || source === 'segwit' ? (
            <View style={styles.sourceRow}>
              {(['sp', 'segwit'] as const).map((s) => {
                const on = source === s;
                return (
                  <TouchableOpacity
                    key={s}
                    style={[styles.sourceChip, on && styles.sourceChipOn]}
                    onPress={() => setSource(s)}>
                    <Text
                      style={[styles.sourceText, on && styles.sourceTextOn]}>
                      {s === 'sp' ? 'Silent Payments' : 'SegWit'}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          ) : null}


          {noKeys ? (
            <Text style={styles.warn}>
              This wallet's keys aren't on this device, so it can't sign a
              transaction. Re-import the wallet (Wallet tab) to send.
            </Text>
          ) : null}

          {scanActive ? (
            <View style={styles.scanBanner}>
              <ActivityIndicator color={colors.primary} size="small" />
              <Text style={styles.scanBannerText}>
                Catching up
                {scanTot
                  ? ` — block ${groupThousands(scanCur)} of ${groupThousands(scanTot)}`
                  : ''}
                . Sending is paused until it finishes.
              </Text>
            </View>
          ) : null}

          {behind ? (
            <View style={styles.behindBanner}>
              <Text style={styles.behindText}>
                ⚠ {groupThousands(blocksBehind)} blocks behind. Coins received
                since then aren't listed yet.
              </Text>
              <TouchableOpacity
                style={[styles.behindBtn, catchUpBusy && styles.btnDisabled]}
                onPress={onCatchUp}
                disabled={catchUpBusy}>
                {catchUpBusy ? (
                  <ActivityIndicator color={PRIMARY} />
                ) : (
                  <Text style={styles.behindBtnText}>Catch up now</Text>
                )}
              </TouchableOpacity>
              {catchUpMsg ? (
                <Text style={styles.behindMsg}>{catchUpMsg}</Text>
              ) : null}
            </View>
          ) : null}

          <Text style={styles.label}>Recipient</Text>
          <Text style={styles.recipientHelp}>
            Silent Payment (sp1…), on-chain (bc1…), or BitMail (name@domain).
          </Text>
          <TextInput
            style={[styles.input, styles.recipientInput]}
            value={recipient}
            onChangeText={(t) => {
              setRecipient(t);
              setContactMsg(null);
              // Editing a pasted address invalidates the verdict that came
              // with it. Nothing re-checks until Build, which is the point.
              setBitmailWarning('');
              setBitmailInvalid(false);
            }}
            placeholder="sp1… / bc1… / name@domain"
            placeholderTextColor={colors.faint}
            autoCapitalize="none"
            autoCorrect={false}
            multiline
          />

          {rKind ? (
            <Text style={styles.kindHint}>Detected: {KIND_LABEL[rKind]}</Text>
          ) : null}

          {bitmailChecking ? (
            <Text style={styles.kindHint}>Checking that BitMail…</Text>
          ) : bitmailWarning ? (
            <View style={bitmailInvalid ? styles.bitmailBad : styles.bitmailWarn}>
              <Text
                style={
                  bitmailInvalid ? styles.bitmailBadText : styles.bitmailWarnText
                }>
                {bitmailInvalid ? '✕ ' : '⚠ '}
                {bitmailWarning}
              </Text>
            </View>
          ) : null}

          {/* Every one of these fills in the address above, so they sit in a
              single wrapping row beneath it. Beside the input they had to be a
              column, which set the row's height and left dead space under the
              address. */}
          <View style={styles.recipientActions}>
            <TouchableOpacity
              style={styles.actionBtn}
              onPress={() => setScanning(true)}>
              <Text style={styles.actionBtnText}>Scan</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.actionBtn}
              onPress={async () => {
                const v = parseScannedAddress(await Clipboard.getString());
                setRecipient(v);
                validateBitmail(v);
              }}>
              <Text style={styles.actionBtnText}>Paste</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.actionBtn}
              onPress={() => setShowContacts(true)}>
              <Text style={styles.actionBtnText}>
                Contacts{contacts.length ? ` (${contacts.length})` : ''}
              </Text>
            </TouchableOpacity>
            {saveable && !alreadySaved ? (
              <TouchableOpacity
                style={styles.actionBtn}
                onPress={() => setShowSaveContact((v) => !v)}>
                <Text style={styles.actionBtnText}>★ Save contact</Text>
              </TouchableOpacity>
            ) : null}
            {alreadySaved ? (
              <Text style={styles.savedHint}>✓ In contacts</Text>
            ) : null}
          </View>

          {/* A saved address no live WhiSPa wallet holds. Said here and not
              only in the picker, because by the time the amount is typed the
              picker is long gone — and this is the last screen before coins
              leave. The server cannot tell a wallet that is gone from someone
              who never used WhiSPa, so neither does this. */}
          {unverified ? (
            <Text style={styles.unverifiedNote}>{CONTACT_UNVERIFIED}</Text>
          ) : null}

          {/* Wrong chain. Refused rather than warned: there is no version of
              this that works, and it is the one mistake on this screen with no
              feedback of any kind — it would build, sign, broadcast and
              confirm, and the recipient would never see it. */}
          {chainWarning ? (
            <View style={styles.undoWarn}>
              <Text style={styles.undoTitle}>⛔ Wrong network</Text>
              <Text style={styles.privacyText}>{chainWarning}</Text>
            </View>
          ) : null}

          {showSaveContact && saveable ? (
            <View style={styles.saveContactRow}>
              <TextInput
                style={[styles.input, styles.contactLabelInput]}
                value={contactLabel}
                onChangeText={setContactLabel}
                placeholder="Label (e.g. Alice)"
                placeholderTextColor={colors.faint}
                maxLength={40}
              />
              <TouchableOpacity
                style={[
                  styles.inlineSaveBtn,
                  (savingContact || !!chainWarning) && styles.btnDisabled,
                ]}
                onPress={onSaveContact}
                disabled={savingContact || !!chainWarning}>
                {savingContact ? (
                  <ActivityIndicator color={PRIMARY} />
                ) : (
                  <Text style={styles.inlineSaveText}>Save</Text>
                )}
              </TouchableOpacity>
            </View>
          ) : null}
          {contactMsg ? <Text style={styles.contactMsg}>{contactMsg}</Text> : null}

          <Text style={styles.label}>Amount</Text>
          <View style={styles.unitRow}>
            <TextInput
              style={[styles.input, styles.amountInput]}
              value={amount}
              onChangeText={(t) => setAmount(t.replace(/[^0-9]/g, ''))}
              keyboardType="number-pad"
              placeholder="0"
              placeholderTextColor={colors.faint}
            />
            <Text style={styles.unitLabel}>sats</Text>
          </View>
          {/* Dial the amount without typing it. Runs 0..maxSendable — the
              selection minus its fee — because a slider whose own maximum
              lands in "amount + fee exceeds your coins" is a strange control.
              It changes the amount and NOTHING else: picking coins stays the
              person's job, and a slider that quietly selected more of them
              would undo the coin control this screen is built around. */}
          <AmountSlider
            value={amountSats}
            max={sliderTop(spendableTotal)}
            onChange={(sats) => setAmount(sats ? String(sats) : '')}
            format={(sats) => `${groupThousands(sats)} sats`}
          />

          <Text style={styles.label}>Fee rate</Text>
          <View style={styles.feeRow}>
            {FEE_TIERS.map((t) => {
              const val = tiers?.[t.key];
              const active = feeChoice === t.key;
              return (
                <TouchableOpacity
                  key={t.key}
                  style={[styles.feeChip, active && styles.feeChipOn]}
                  onPress={() => pickTier(t.key)}
                  disabled={!val}>
                  <Text style={[styles.feeChipLabel, active && styles.feeChipLabelOn]}>
                    {t.label}
                  </Text>
                  <Text style={[styles.feeChipHint, active && styles.feeChipLabelOn]}>
                    {val ? `${val} s/vB` : '—'}
                  </Text>
                </TouchableOpacity>
              );
            })}
            <TouchableOpacity
              style={[styles.feeChip, feeChoice === 'custom' && styles.feeChipOn]}
              onPress={() => pickTier('custom')}>
              <Text
                style={[
                  styles.feeChipLabel,
                  feeChoice === 'custom' && styles.feeChipLabelOn,
                ]}>
                Custom
              </Text>
            </TouchableOpacity>
          </View>
          {feeChoice === 'custom' ? (
            <View style={[styles.unitRow, styles.feeRateRow]}>
              <TextInput
                style={[styles.input, styles.feeRateInput]}
                value={feeRateText}
                // Digits and at most one decimal point. The old filter was
                // [^0-9], which did not merely block a fractional rate — it
                // deleted the point, so typing 0.5 set the rate to 5 and
                // overpaid tenfold without a word.
                onChangeText={(t) => {
                  const cleaned = t
                    .replace(/[^0-9.]/g, '')
                    .replace(/(\..*)\./g, '$1');
                  setFeeRateText(cleaned);
                  setFeeRate(Number(cleaned) || 0);
                }}
                keyboardType="decimal-pad"
                placeholder="1"
                placeholderTextColor={colors.faint}
              />
              <Text style={styles.unitLabel}>sat/vB</Text>
            </View>
          ) : null}

          {/* Their own node may relay below 1 sat/vB; almost nothing else
              will. Saying so is the difference between a deliberate choice and
              a transaction that quietly never goes anywhere. */}
          {feeRate > 0 && feeRate < 1 ? (
            <View style={styles.bitmailWarn}>
              <Text style={styles.bitmailWarnText}>
                ⚠ {feeRate} sat/vB is below the 1 sat/vB minimum most nodes relay
                at. Your own node will accept it, but the transaction may not
                propagate and could stay unconfirmed for a long time.
              </Text>
            </View>
          ) : null}

          {/* THE ONE PART THAT DIFFERS. Everything above and below — the
              recipient, the amount and its slider, the fee tiers, the summary,
              Review — is the same control whichever side is paying. An SP coin
              is an outpoint; a SegWit holding is an address that spends every
              payment under it at once. So the rows differ and nothing else
              does. */}
          <Text style={styles.label}>
            Coins ({isSegwit ? selectedSegwit.length : selectedUtxos.length}/
            {isSegwit ? segwitTotals.length : utxos.length} selected)
          </Text>
          {isSegwit && segwitLoading && !segwitTotals.length ? (
            <ActivityIndicator color={colors.primary} style={styles.coinSpinner} />
          ) : isSegwit && !segwitXprv ? (
            <Text style={styles.info}>
              This wallet predates SegWit addresses. Set them up from the
              Receive tab with your recovery phrase.
            </Text>
          ) : (isSegwit ? segwitTotals.length : utxos.length) === 0 ? (
            <Text style={styles.info}>No spendable coins in this wallet yet.</Text>
          ) : isSegwit ? (
            segwitTotals.map((t) => {
              const on = selected.has(segwitKey(t.index));
              const label = segwitLabelOf(t.address);
              return (
                <TouchableOpacity
                  key={segwitKey(t.index)}
                  style={styles.utxoRow}
                  onPress={() => toggleSegwit(t.index)}>
                  <View style={[styles.checkbox, on && styles.checkboxOn]}>
                    {on ? <Text style={styles.checkMark}>✓</Text> : null}
                  </View>
                  <View style={styles.utxoInfo}>
                    <Text style={styles.utxoAmount}>
                      {groupThousands(t.sats)} sats
                    </Text>
                    <Text style={styles.utxoMeta} numberOfLines={1}>
                      {label ? `${label} · ` : ''}
                      {t.address.slice(0, 10)}…{t.address.slice(-8)}
                      {t.utxoCount > 1 ? ` · ${t.utxoCount} payments` : ''}
                    </Text>
                  </View>
                </TouchableOpacity>
              );
            })
          ) : (
            utxos.map((u) => {
              const on = selected.has(utxoKey(u));
              return (
                <TouchableOpacity
                  key={utxoKey(u)}
                  style={styles.utxoRow}
                  onPress={() => toggleUtxo(u)}>
                  <View style={[styles.checkbox, on && styles.checkboxOn]}>
                    {on ? <Text style={styles.checkMark}>✓</Text> : null}
                  </View>
                  <View style={styles.utxoInfo}>
                    <Text style={styles.utxoAmount}>
                      {groupThousands(u.amount)} sats
                    </Text>
                    <Text style={styles.utxoMeta} numberOfLines={1}>
                      {u.label ? `${u.label} · ` : ''}
                      {u.txid.slice(0, 10)}…:{u.vout}
                    </Text>
                  </View>
                </TouchableOpacity>
              );
            })
          )}

          {selectedInputCount > 0 ? (
            <View style={styles.summary}>
              <SummaryRow
                label="Selected"
                value={`${groupThousands(selectedTotal)} sats`}
              />
              <SummaryRow
                label="Est. fee"
                value={`~${groupThousands(estFee)} sats`}
              />
              {/* What is actually left to send. Shown always, not only when
                  something is wrong: it is the number that decides whether the
                  selection is usable, and reading it off Selected minus Est.
                  fee is exactly the arithmetic people skip. */}
              <SummaryRow
                label="Max sendable"
                value={
                  maxSendable > 0 ? `~${groupThousands(maxSendable)} sats` : 'nothing'
                }
              />
            </View>
          ) : null}

          {tangoPairing ? (
            // The one warning here about something that cannot be taken back
            // once the transaction is out, so it gets the alarm colours rather
            // than the ordinary privacy-note ones.
            <View style={styles.undoWarn}>
              <Text style={styles.undoTitle}>⛔ {TANGO_UNDO_TITLE}</Text>
              <Text style={styles.privacyText}>{TANGO_UNDO_NOTE}</Text>
              <TouchableOpacity
                style={styles.ackRow}
                onPress={() => setTangoAck((v) => !v)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: tangoAck }}>
                <View style={[styles.checkbox, tangoAck && styles.checkboxOn]}>
                  {tangoAck ? <Text style={styles.checkMark}>✓</Text> : null}
                </View>
                <Text style={styles.privacyText}>{TANGO_UNDO_ACK}</Text>
              </TouchableOpacity>
            </View>
          ) : selectedInputCount > 1 ? (
            <View style={styles.privacyWarn}>
              <Text style={styles.privacyText}>
                ⚠ Combining {selectedInputCount} coins in one transaction links
                them together on-chain, which reduces your privacy. Spend a single
                coin when you can.
              </Text>
            </View>
          ) : null}

          {/* Most specific first. A too-small selection makes the other two
              true as well, and saying "amount is below the dust limit" about a
              coin that can never clear it just sends you back to retype. */}
          {selectionTooSmall ? (
            <Text style={styles.error}>
              {maxSendable > 0
                ? `These coins leave ${groupThousands(maxSendable)} sats after the ` +
                  `fee — under the ${groupThousands(DUST_SATS)} sat dust limit, so ` +
                  `they can't fund any payment at this fee rate. Select more coins, ` +
                  `or wait for a lower fee.`
                : `These coins don't cover the ${groupThousands(estFee)} sat fee. ` +
                  `Select more coins, or wait for a lower fee rate.`}
            </Text>
          ) : belowDust ? (
            <Text style={styles.error}>
              {groupThousands(amountSats)} sats is below the{' '}
              {groupThousands(DUST_SATS)} sat dust limit. An output that small costs
              more to spend than it holds, and the network may refuse to relay it.
            </Text>
          ) : insufficient ? (
            <Text style={styles.error}>
              Selected coins don't cover the amount plus fee — the most they can send
              is {groupThousands(maxSendable)} sats.
            </Text>
          ) : null}
          {error ? <Text style={styles.error}>{error}</Text> : null}

          <TouchableOpacity
            style={[styles.primaryBtn, (!canBuild || busy) && styles.btnDisabled]}
            onPress={onReview}
            disabled={!canBuild || busy}>
            {busy ? (
              <ActivityIndicator color={colors.onPrimary} />
            ) : (
              <Text style={styles.primaryBtnText}>
                {scanActive ? 'Scanning… please wait' : 'Review'}
              </Text>
            )}
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>

      <ConfirmLockModal
        visible={authOpen}
        onAuthenticated={onAuthenticated}
        onCancel={() => setAuthOpen(false)}
        title="Confirm it’s you"
        subtitle={`Authenticate to review this ${groupThousands(amountSats)} sats transaction.`}
      />

      <QRScanner
        visible={scanning}
        onClose={() => setScanning(false)}
        onScanned={(v) => {
          const a = parseScannedAddress(v);
          setRecipient(a);
          validateBitmail(a);
        }}
      />

      <ContactsModal
        visible={showContacts}
        contacts={contacts}
        onClose={() => setShowContacts(false)}
        onPick={(v) => {
          setRecipient(v);
          validateBitmail(v);
        }}
        onDelete={onDeleteContact}
        onUpdate={async (id, v) => {
          if (!inkey) return;
          await api.updateContact(inkey, id, { value: v });
          await loadContacts();
        }}
      />
    </SafeAreaView>
  );
}

function ReviewRow({
  label,
  value,
  mono,
  bold,
}: {
  label: string;
  value: string;
  mono?: boolean;
  bold?: boolean;
}) {
  return (
    <View style={styles.reviewRow}>
      <Text style={styles.reviewLabel}>{label}</Text>
      <Text
        style={[
          styles.reviewValue,
          mono && styles.reviewMono,
          bold && styles.reviewBold,
        ]}
        numberOfLines={mono ? 2 : 1}>
        {value}
      </Text>
    </View>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.summaryRow}>
      <Text style={styles.summaryLabel}>{label}</Text>
      <Text style={styles.summaryValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  content: { padding: 16 },
  coinSpinner: { marginVertical: 16 },
  sourceRow: { flexDirection: 'row', gap: 8, marginBottom: 18 },
  sourceChip: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  sourceChipOn: { backgroundColor: PRIMARY, borderColor: PRIMARY },
  sourceText: { fontSize: 13, fontWeight: '600', color: colors.muted },
  sourceTextOn: { color: colors.onPrimary },
  header: { fontSize: 24, fontWeight: 'bold', color: colors.text, marginBottom: 12 },

  label: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.label,
    marginTop: 16,
    marginBottom: 6,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    color: colors.text,
    backgroundColor: colors.surfaceAlt,
  },
  recipientHelp: { fontSize: 12, color: colors.faint, marginBottom: 8, marginTop: -2 },
  recipientInput: { minHeight: 46 },
  kindHint: { fontSize: 12, color: PRIMARY, fontWeight: '600', marginTop: 6 },
  // Scan / Paste / Contacts / Save contact, wrapping onto a second line on
  // narrow screens instead of squeezing.
  recipientActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
    marginTop: 12,
  },
  // FILLED AND RAISED, not outlined. As a hairline outline on the page
  // background these read as decoration rather than as the three things that
  // actually fill the address in — which is most of what anyone does on this
  // screen.
  //
  // THE FILL HAS TO BE A COLOUR, not a darker grey. The first attempt used
  // surfaceAlt (#131a22) over bg (#080b0f) with a black shadow: a four-value
  // difference on a near-black theme, and a black shadow on near-black is
  // nothing at all. It was reported as unchanged, correctly — the change was
  // real and invisible, which is the same thing on a phone in daylight.
  //
  // primaryDim rather than PRIMARY: the Review button below is solid PRIMARY
  // with black text, and three more of those would compete with the one
  // action that sends the money. Dim orange reads as filled, reads as
  // pressable, and stays subordinate.
  actionBtn: {
    backgroundColor: colors.primaryDim,
    borderWidth: 1,
    borderColor: PRIMARY,
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    // Android takes elevation, iOS takes the shadow* family; both are set so
    // the lift is not a platform coin-flip.
    elevation: 3,
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
  actionBtnText: { color: colors.text, fontSize: 13, fontWeight: '700' },
  unverifiedNote: {
    color: colors.warn,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 10,
  },
  savedHint: { color: colors.green, fontSize: 13, fontWeight: '600' },
  saveContactRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 },
  contactLabelInput: { flex: 1 },
  contactMsg: { fontSize: 13, color: colors.muted, marginTop: 8 },
  // The "Save" button beside the contact-label input: taller than actionBtn so
  // it lines up with the input's height.
  inlineSaveBtn: {
    borderWidth: 1,
    borderColor: PRIMARY,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  inlineSaveText: { color: PRIMARY, fontWeight: '600', fontSize: 13 },

  // Short numeric fields (amount, custom fee rate) are sized to their content
  // rather than the screen width, with the unit beside the box so the narrower
  // field reads as deliberate. Widths are the digits each holds at fontSize 16
  // plus the input's own padding, and both fit a 320dp screen with the unit.
  unitRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  unitLabel: { fontSize: 14, fontWeight: '600', color: colors.muted },
  amountInput: { width: 150 }, // sats: up to ~9 digits
  feeRateInput: { width: 100 }, // sat/vB: 1–4 digits
  feeRateRow: { marginTop: 10 },

  feeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  feeChip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    alignItems: 'center',
    minWidth: 68,
  },
  feeChipOn: { borderColor: PRIMARY, backgroundColor: 'rgba(249,115,22,0.10)' },
  feeChipLabel: { fontSize: 13, fontWeight: '600', color: colors.strong },
  feeChipLabelOn: { color: PRIMARY },
  feeChipHint: { fontSize: 10, color: colors.faint, marginTop: 2 },

  utxoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: PRIMARY,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  checkboxOn: { backgroundColor: PRIMARY },
  checkMark: { color: colors.onPrimary, fontSize: 14, fontWeight: 'bold' },
  utxoInfo: { flex: 1 },
  utxoAmount: { fontSize: 15, fontWeight: '600', color: colors.text },
  utxoMeta: { fontSize: 12, color: colors.faint, marginTop: 2 },

  summary: {
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 8,
    padding: 12,
    marginTop: 4,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 3,
  },
  summaryLabel: { fontSize: 13, color: colors.muted },
  summaryValue: { fontSize: 13, fontWeight: '600', color: colors.text },

  primaryBtn: {
    backgroundColor: PRIMARY,
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 22,
    alignSelf: 'stretch',
  },
  primaryBtnText: { color: colors.onPrimary, fontSize: 16, fontWeight: '600' },
  btnDisabled: { opacity: 0.5 },
  linkBtn: { marginTop: 14, paddingVertical: 6, alignItems: 'center' },
  linkBtnText: { color: colors.muted, fontSize: 14, fontWeight: '600' },
  ghostBtn: {
    borderWidth: 1,
    borderColor: PRIMARY,
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 24,
    marginTop: 20,
  },
  ghostBtnText: { color: PRIMARY, fontSize: 14, fontWeight: '600' },

  card: {
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 20,
  },
  reviewRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
  },
  reviewLabel: { fontSize: 14, color: colors.muted, marginRight: 12 },
  reviewValue: { fontSize: 14, color: colors.text, flex: 1, textAlign: 'right' },
  reviewMono: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 12,
  },
  reviewBold: { fontWeight: '700', fontSize: 16 },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginVertical: 6,
  },

  info: { fontSize: 14, color: colors.muted, textAlign: 'center', lineHeight: 20 },
  warn: {
    fontSize: 13,
    color: colors.danger,
    backgroundColor: 'rgba(255,107,94,0.08)',
    borderRadius: 8,
    padding: 12,
    marginTop: 8,
    lineHeight: 18,
  },
  scanBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: 'rgba(249,115,22,0.10)',
    borderRadius: 8,
    padding: 12,
    marginTop: 8,
  },
  scanBannerText: { flex: 1, fontSize: 13, color: colors.primary, lineHeight: 18 },
  // Behind the tip but nothing scanning: a warning with a way to act on it,
  // not a block — the coins already listed are spendable either way.
  behindBanner: {
    backgroundColor: 'rgba(249,115,22,0.10)',
    borderRadius: 8,
    padding: 12,
    marginTop: 8,
  },
  behindText: { fontSize: 13, color: colors.primary, lineHeight: 18 },
  behindBtn: {
    borderWidth: 1,
    borderColor: PRIMARY,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 9,
    alignSelf: 'flex-start',
    marginTop: 10,
  },
  behindBtnText: { color: PRIMARY, fontSize: 13, fontWeight: '600' },
  behindMsg: { fontSize: 12, color: colors.muted, marginTop: 8, lineHeight: 17 },
  error: { color: colors.danger, fontSize: 13, marginTop: 14, textAlign: 'center' },
  privacyWarn: {
    backgroundColor: 'rgba(249,115,22,0.10)',
    borderRadius: 8,
    padding: 12,
    marginTop: 14,
  },
  // Louder than privacyWarn on purpose: the privacy notes are about a cost
  // that can be weighed, and this is about a round that stops being a round.
  undoWarn: {
    backgroundColor: 'rgba(255,95,86,0.10)',
    borderWidth: 1,
    borderColor: colors.danger,
    borderRadius: 8,
    padding: 12,
    marginTop: 14,
  },
  undoTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.danger,
    marginBottom: 4,
  },
  privacyText: { fontSize: 13, color: colors.primary, lineHeight: 18 },
  ackRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 10,
  },

  // Two weights, because the two cases need different responses. Amber warns
  // and lets you continue (the lookup didn't complete — the address may be
  // fine); red is a verdict about the address and blocks Review, so it should
  // not look like something to shrug past.
  bitmailWarn: {
    backgroundColor: 'rgba(249,115,22,0.10)',
    borderRadius: 8,
    padding: 10,
    marginTop: 8,
  },
  bitmailWarnText: { fontSize: 13, color: colors.primary, lineHeight: 18 },
  bitmailBad: {
    backgroundColor: 'rgba(239,68,68,0.10)',
    borderRadius: 8,
    padding: 10,
    marginTop: 8,
  },
  bitmailBadText: { fontSize: 13, color: colors.danger, lineHeight: 18 },

  doneIcon: {
    fontSize: 48,
    color: colors.green,
    fontWeight: 'bold',
    marginBottom: 8,
  },
  doneTitle: { fontSize: 20, fontWeight: 'bold', color: colors.green },
  doneSub: { fontSize: 15, color: colors.muted, marginTop: 4, marginBottom: 20 },
  txidLabel: { fontSize: 12, color: colors.faint, marginTop: 8 },
  txid: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 12,
    color: colors.strong,
    marginTop: 4,
    paddingHorizontal: 24,
  },
});
