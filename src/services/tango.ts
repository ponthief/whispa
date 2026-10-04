// Tango on the device: the amounts, the four outputs, and the checks that run
// before anything is signed.
//
// WHAT TANGO IS. A two-party mix. Nobody pays anybody: both sides put in the
// same amount and take the same amount back, so the two outputs are identical
// and an observer cannot say which belongs to which input. An anonymity set of
// two — small, real, and it compounds if you do it again with someone else.
//
// WHAT IT IS NOT. A PayJoin. There the outputs differ because one party is
// being paid, and what it hides is that the inputs had two owners. Here the
// outputs are deliberately the same, and what it hides is which is whose.
//
// EVERYTHING CRYPTOGRAPHIC COMES FROM spPayjoin.ts. BIP-352's shared secret
// over the input PUBLIC keys does not care whether anyone is being paid, and
// the sighash cares about inputs and outputs and not about meaning. A second
// copy of either is how two copies end up disagreeing — which has already
// happened once here, and cost a working feature until a real transaction
// failed to verify.
//
// Held to vectors from the Python:
//   node scripts/check-tango-signing.mjs
// regenerated with siLNt helpers/_tango_fixtures.py after ANY change to the
// amounts, the output ordering or the derivation, on either side.

import { schnorr } from '@noble/curves/secp256k1';

import {
  DUST_SATS,
  TAPROOT_OUTPUT_VBYTES,
  concat,
  estimateVsize,
  fromHex,
  serializeUnsigned,
  taprootSighash,
  toHex,
  verifyPayoutOutput,
  type TxIn,
  type TxOut,
} from './spSign';
import {
  canonical,
  changeScript,
  inputSigningKey,
  ownIndices,
  paymentScript,
  withLocalTweaks,
  type PayjoinInput,
} from './spPayjoin';

export type { PayjoinInput } from './spPayjoin';
export { canonical, ownIndices, withLocalTweaks } from './spPayjoin';

/** Which side of a round you are. Neither pays the other. */
export type Side = 'a' | 'b';

export interface TangoAmounts {
  denom: number;
  /** How many equal coins each side takes its denomination back as. */
  pieces: number;
  /** What one of those coins is worth: denom / pieces. */
  share: number;
  a_in: number;
  b_in: number;
  a_change: number;
  b_change: number;
  a_fee: number;
  b_fee: number;
  fee: number;
  vsize: number;
  /** True only when NEITHER side needed change. The honest measure. */
  clean: boolean;
}

export function estimate(
  nInputs: number,
  nOutputs: number,
  feeRate: number,
): { vsize: number; fee: number } {
  const vsize = estimateVsize(
    nInputs,
    new Array(nOutputs).fill(TAPROOT_OUTPUT_VBYTES),
  );
  return { vsize, fee: Math.ceil(vsize * feeRate) };
}

/** (A's share, B's share). The odd satoshi goes to whoever proposed. */
export function splitFee(fee: number): [number, number] {
  const half = Math.floor(fee / 2);
  return [fee - half, half];
}

/**
 * Mirrors helpers/tango.py::plan. The server is the authority; this recomputes
 * so the client can refuse a quote it did not arrive at itself, and so the
 * coin picker can tell you what a selection costs before you commit to it.
 */
export function plan(
  aInputs: PayjoinInput[],
  bInputs: PayjoinInput[],
  denom: number,
  feeRate: number,
  pieces = 1,
  /** Which side the reader is: decides whether a shortfall reads as theirs or
   *  the other party's. Defaults to 'a', the proposer, which is who is
   *  looking when a round is being priced before it exists. */
  mine: 'a' | 'b' = 'a',
): TangoAmounts {
  const p = Math.trunc(pieces || 1);
  if (p < 1) throw new Error('A side has to get at least one coin back.');
  if (denom % p) {
    throw new Error(
      `${denom} sats does not divide into ${p} equal coins. Every output in ` +
        `a Tango has to be the same size, so the amount has to be a multiple ` +
        `of the number of coins you want back.`,
    );
  }
  const share = denom / p;
  if (share < DUST_SATS) {
    throw new Error(
      `${share} sats a coin is below the ${DUST_SATS} sat dust limit, so ` +
        `neither side could spend what they got back.`,
    );
  }
  if (!aInputs.length || !bInputs.length) {
    throw new Error('A Tango needs coins from both sides.');
  }

  const aIn = aInputs.reduce((s, i) => s + i.amount, 0);
  const bIn = bInputs.reduce((s, i) => s + i.amount, 0);
  const nIn = aInputs.length + bInputs.length;

  const shares = (nOut: number) => {
    const { vsize, fee } = estimate(nIn, nOut, feeRate);
    const [aFee, bFee] = splitFee(fee);
    return { vsize, fee, aFee, bFee };
  };

  let { vsize, aFee, bFee } = shares(2 * p + 2);
  let aChange = aIn - denom - aFee;
  let bChange = bIn - denom - bFee;

  // `feeShare`, not `share`: `share` is what one mixed OUTPUT is worth, and
  // shadowing it here is how the Python twin silently made every mixed output
  // the size of a fee share the moment pieces arrived.
  // WHOSE SIDE THIS IS, from the reader's chair rather than the protocol's.
  // These were labelled 'Your' and 'Their' by ROLE — a is the proposer, b is
  // the matcher — so the side matching a round was told "Their coins total …"
  // about the coins it had just picked itself. `mine` is which role the reader
  // is playing, so the labelling follows the person, not the protocol.
  for (const [role, total, change, feeShare] of [
    ['a', aIn, aChange, aFee],
    ['b', bIn, bChange, bFee],
  ] as const) {
    if (change < 0) {
      const need = denom + feeShare;
      throw new Error(
        role === mine
          ? `Selected ${total} sats — ${need} needed (${denom} plus a ` +
            `${feeShare} sat share of the fee). Pick more coins, or agree a ` +
            `smaller amount.`
          : `Their ${total} sats do not cover ${need} (${denom} plus a ` +
            `${feeShare} sat share of the fee). They need to pick more coins, ` +
            `or you both need to agree a smaller amount.`,
      );
    }
  }

  // Dropping one change shrinks the transaction, which lowers the fee, which
  // can lift the OTHER change back above dust. Two passes settle it, because
  // there are only two changes to drop.
  for (let pass = 0; pass < 2; pass++) {
    const nOut =
      2 * p + (aChange >= DUST_SATS ? 1 : 0) + (bChange >= DUST_SATS ? 1 : 0);
    const s = shares(nOut);
    vsize = s.vsize;
    aFee = s.aFee;
    bFee = s.bFee;
    const newA = aIn - denom - aFee;
    const newB = bIn - denom - bFee;
    if (newA < 0 || newB < 0) {
      throw new Error(
        'The fee moved above what one side’s coins can cover. Pick more ' +
          'coins, or agree a smaller amount.',
      );
    }
    aChange = newA;
    bChange = newB;
  }

  if (aChange >= 0 && aChange < DUST_SATS) {
    aFee += aChange;
    aChange = 0;
  }
  if (bChange >= 0 && bChange < DUST_SATS) {
    bFee += bChange;
    bChange = 0;
  }

  return {
    denom,
    pieces: p,
    // What one mixed output is worth. Every piece on both sides is this, and
    // the check before signing holds all of them to it.
    share,
    a_in: aIn,
    b_in: bIn,
    a_change: aChange,
    b_change: bChange,
    a_fee: aFee,
    b_fee: bFee,
    fee: aFee + bFee,
    vsize,
    clean: aChange === 0 && bChange === 0,
  };
}

/**
 * The outputs, BIP-69 ordered.
 *
 * The two mixed outputs share a value, so the tie breaks on script bytes —
 * two unrelated fresh taproot keys. Neither side can influence the order,
 * which is what stops "the proposer's output is always first" from becoming
 * the thing that identifies them.
 */
export function outputsFor(
  amounts: TangoAmounts,
  aMix: Uint8Array | Uint8Array[],
  bMix: Uint8Array | Uint8Array[],
  aChange: Uint8Array | null,
  bChange: Uint8Array | null,
): TxOut[] {
  const pieces = amounts.pieces || 1;
  const share = amounts.share || amounts.denom;
  const aSpks = mixScripts(aMix);
  const bSpks = mixScripts(bMix);
  for (const [who, spks] of [['A', aSpks], ['B', bSpks]] as const) {
    if (spks.length !== pieces) {
      throw new Error(
        `${who} derived ${spks.length} mixed script(s) for a round of ` +
          `${pieces}. Every piece needs its own output.`,
      );
    }
  }
  const outs: TxOut[] = [...aSpks, ...bSpks].map((script) => ({
    value: share,
    script,
  }));
  if (amounts.a_change) {
    if (!aChange) throw new Error('A has change but no change script was derived');
    outs.push({ value: amounts.a_change, script: aChange });
  }
  if (amounts.b_change) {
    if (!bChange) throw new Error('B has change but no change script was derived');
    outs.push({ value: amounts.b_change, script: bChange });
  }
  outs.sort((x, y) =>
    x.value !== y.value ? x.value - y.value : toHex(x.script) < toHex(y.script) ? -1 : 1,
  );
  return outs;
}

/**
 * One script or several, always as a list.
 *
 * A round with one piece a side is the shape this started as and the shape
 * every existing row holds, so a bare Uint8Array is still accepted. The count
 * is checked against the plan, which is what catches passing the wrong number.
 */
export function mixScripts(spks: Uint8Array | Uint8Array[] | null): Uint8Array[] {
  if (!spks) return [];
  return spks instanceof Uint8Array ? [spks] : [...spks];
}

export interface Assembled {
  vin: TxIn[];
  vout: TxOut[];
  amounts: number[];
  scripts: Uint8Array[];
  unsignedHex: string;
}

export function assemble(
  inputs: PayjoinInput[],
  amounts: TangoAmounts,
  aMix: Uint8Array | Uint8Array[],
  bMix: Uint8Array | Uint8Array[],
  aChange: Uint8Array | null = null,
  bChange: Uint8Array | null = null,
): Assembled {
  const ordered = canonical(inputs);
  const vin: TxIn[] = ordered.map((i) => ({ txid: i.txid, vout: i.vout }));
  const vout = outputsFor(amounts, aMix, bMix, aChange, bChange);
  return {
    vin,
    vout,
    amounts: ordered.map((i) => i.amount),
    scripts: ordered.map((i) =>
      concat(new Uint8Array([0x51, 0x20]), fromHex(i.pub_key)),
    ),
    unsignedHex: toHex(serializeUnsigned(vin, vout)),
  };
}

/**
 * This side's outputs: one mixed coin per piece, and change when the coins did
 * not divide evenly.
 *
 * The mixed outputs go to the wallet's plain Silent Payments address at
 * successive BIP-352 counters — k = 0, 1, 2 … — and the change to its m=0
 * LABELLED one. That is not decoration: m=0 is BIP-352's reserved change
 * label, so the owner's own wallet recognises the change for what it is
 * without being told, which matters because change is the part of a two-party
 * mix that leaks.
 *
 * SEVERAL PIECES ON ONE CHAIN IS THE SHAPE THE SCANNER HAD TO LEARN. BIP-352's
 * reference scan keeps a single k, so a transaction paying one wallet twice on
 * the same chain used to lose the second output. helpers/scan.py counts per
 * chain now, which is what makes taking a share in pieces findable at all.
 */
export function deriveOwnOutputs(
  scanSecretHex: string,
  spendPub: Uint8Array,
  inputs: PayjoinInput[],
  needChange: boolean,
  pieces = 1,
): { mix: Uint8Array[]; change: Uint8Array | null } {
  const n = Math.max(1, Math.trunc(pieces || 1));
  return {
    mix: Array.from({ length: n }, (_, k) =>
      paymentScript(scanSecretHex, spendPub, inputs, k),
    ),
    change: needChange ? changeScript(scanSecretHex, spendPub, inputs) : null,
  };
}

export interface CheckOpts {
  side: Side;
  /** The frozen set, both sides' coins. */
  inputs: PayjoinInput[];
  /** Ours out of it. */
  mine: PayjoinInput[];
  /** What the server quoted. */
  amounts: TangoAmounts;
  /** Every side's scripts AS THE SERVER HOLDS THEM, one per piece. */
  aMix: Uint8Array | Uint8Array[];
  bMix: Uint8Array | Uint8Array[];
  aChange: Uint8Array | null;
  bChange: Uint8Array | null;
  /** Ours as DERIVED HERE, kept apart from the server's copies on purpose. */
  expectMix: Uint8Array | Uint8Array[];
  expectChange: Uint8Array | null;
  /**
   * The coins we committed, FROM OUR OWN RECORDS.
   *
   * Outpoint and amount only, deliberately: this is a list the device wrote
   * down when the user chose, and asking for keys or tweaks it has no reason
   * to store would push a caller towards handing back the server's copy of the
   * set instead — which is the one thing this field must not be.
   */
  committed: { txid: string; vout: number; amount: number }[];
  denom: number;
  feeRate: number;
  /**
   * How many coins this round gives each side.
   *
   * Needed because step 3 recomputes the whole plan from the frozen input set,
   * and the arithmetic depends on it — 2*pieces outputs to pay for. Without it
   * the recomputation prices a different transaction and rejects an honest
   * round, which is exactly how this was found.
   */
  pieces?: number;
  /**
   * The INSTANCE's Silent Payments address, when this round routes a change
   * output to it. From the round record, which carries it so this device does
   * not have to be told twice.
   */
  payoutSpAddress?: string | null;
  /**
   * t_k for OUR side's routed change, as the round reveals it. Present exactly
   * when our change is routed — see verifyPayoutOutput for why a tweak rather
   * than a derivation.
   */
  myPayoutTweak?: Uint8Array | null;
  /**
   * Whether THIS DEVICE agreed to route its change, from its own record of the
   * round it proposed or accepted. NULL when it has no record either way.
   *
   * Not read from the server's copy, and that is the whole reason it is here:
   * a coordinator that flipped the flag on would take a change coin the user
   * never offered, and a check against the server's own claim would not notice.
   *
   * NULL IS NOT FALSE. No record means the round was joined somewhere else —
   * the web app, or a phone since reinstalled — and a round that routes cannot
   * then be signed: the only evidence the user asked for it would be the
   * server's own flag. A round that routes nothing is unaffected, which is
   * every round before this setting existed.
   */
  myPayoutIntended?: boolean | null;
}

/**
 * Everything that must hold before this device signs.
 *
 * A taproot key-path signature authorises the whole transaction, so this is the
 * only moment either side gets to refuse. Throws with a sentence to show the
 * user; every throw means cancel, not retry.
 *
 * The comparison that matters is expectMix against the server's copy. Checking
 * the server's value against itself is no check at all — that exact mistake
 * shipped in the PayJoin and let every substitution through.
 */
export function checkBeforeSigning(opts: CheckOpts): Assembled {
  const { side, inputs, mine, amounts, committed } = opts;

  // 1. Our coins are the ones we chose, and no others of ours crept in.
  const want = new Set(committed.map((i) => `${i.txid.toLowerCase()}:${i.vout}`));
  const have = mine.map((i) => `${i.txid.toLowerCase()}:${i.vout}`);
  if (have.length !== want.size || !have.every((k) => want.has(k))) {
    throw new Error('The coins in this Tango are not the ones you chose. Cancel it.');
  }
  const byKey = new Map(
    committed.map((i) => [`${i.txid.toLowerCase()}:${i.vout}`, i.amount]),
  );
  for (const i of mine) {
    if (byKey.get(`${i.txid.toLowerCase()}:${i.vout}`) !== i.amount) {
      throw new Error(`${i.txid}:${i.vout} is listed with the wrong amount. Cancel it.`);
    }
  }

  // 2. Both sides get the SAME amount. This is the entire privacy claim, so it
  //    is checked directly rather than inferred from the arithmetic below.
  if (amounts.denom <= 0) {
    throw new Error('This Tango has no denomination. Cancel it.');
  }

  // 3. The arithmetic is ours, recomputed from the frozen set.
  const mineKeys = new Set(have);
  const ours = inputs.filter((i) =>
    side === 'a'
      ? mineKeys.has(`${i.txid.toLowerCase()}:${i.vout}`)
      : !mineKeys.has(`${i.txid.toLowerCase()}:${i.vout}`),
  );
  const theirs = inputs.filter((i) => !ours.includes(i));
  const recomputed = plan(ours, theirs, opts.denom, opts.feeRate, opts.pieces || 1);
  for (const field of ['denom', 'pieces', 'share', 'a_change', 'b_change',
                       'fee', 'vsize'] as const) {
    if (recomputed[field] !== amounts[field]) {
      throw new Error(
        `The server says the ${field} is ${amounts[field]}; this device ` +
          `computes ${recomputed[field]}. Cancel it.`,
      );
    }
  }

  // 4. Our own outputs are the ones we derived — compared BEFORE assembling.
  //    EVERY piece, and as a SET: the server may hold them in any order, and
  //    an order-sensitive compare would reject a correct round while a
  //    set-insensitive one would accept a substituted script that happened to
  //    keep the count.
  const ourMix = mixScripts(side === 'a' ? opts.aMix : opts.bMix);
  const ourChange = side === 'a' ? opts.aChange : opts.bChange;
  const expectMix = mixScripts(opts.expectMix);
  // Not `mine` — that is already this side's INPUTS, a few lines above.
  const ourMixHexes = new Set(ourMix.map(toHex));
  if (
    expectMix.length !== ourMix.length ||
    ourMixHexes.size !== ourMix.length ||
    !expectMix.every((m) => ourMixHexes.has(toHex(m)))
  ) {
    throw new Error(
      'Your share is not going to the addresses this device derived. Cancel it.',
    );
  }
  // 4b. Our change, which has two shapes now.
  //
  //  - Not routed: it is ours, this device derived it, and the server's copy
  //    must equal what we derived. Unchanged.
  //  - Routed: it pays the INSTANCE, so there is nothing of ours to compare
  //    against. The round reveals t_k and we check the arithmetic instead.
  //
  // Which of the two it is comes from THIS DEVICE's record of what it agreed,
  // never from the server's claim. A coordinator that turned routing on would
  // otherwise take a change coin the user never offered, and comparing the
  // server's flag against itself would not notice — the same shape of mistake
  // that let every PayJoin substitution through.
  const routed = !!opts.myPayoutTweak;
  const intended = opts.myPayoutIntended;
  if (routed && intended == null) {
    // Not "you did not ask for this" — nobody can tell from here. Said as
    // what it is, because the fix is to approve it where it was started.
    throw new Error(
      'This Tango sends your change to the service, and this device has no '
        + 'record of you asking for that. Approve it on the device you '
        + 'started it from, or cancel it.',
    );
  }
  if (routed !== !!intended) {
    throw new Error(
      routed
        ? 'This Tango sends your change to the service, which you did not '
          + 'ask for. Cancel it.'
        : 'This Tango keeps your change in your wallet, but you asked for it '
          + 'to be sent over Lightning. Cancel it.',
    );
  }
  const ourChangeHex = ourChange ? toHex(ourChange) : null;
  if (routed) {
    const myChangeAmount = side === 'a' ? amounts.a_change : amounts.b_change;
    if (myChangeAmount) {
      if (!ourChange || !opts.payoutSpAddress) {
        throw new Error(
          'This Tango routes your change but does not say where. Cancel it.',
        );
      }
      if (
        !verifyPayoutOutput(opts.payoutSpAddress, opts.myPayoutTweak!, ourChange)
      ) {
        throw new Error(
          'Your change is not going to the service address this app was told '
            + 'to expect. Cancel it.',
        );
      }
    }
  } else {
    const expectChangeHex = opts.expectChange ? toHex(opts.expectChange) : null;
    if (expectChangeHex !== ourChangeHex) {
      throw new Error('Your change is not going where this device sent it. Cancel it.');
    }
  }

  const assembled = assemble(
    inputs, amounts, opts.aMix, opts.bMix, opts.aChange, opts.bChange,
  );

  // 5. Exactly 2*pieces outputs at the share value, and all of ours are among
  //    them. Both sides get the same COUNT as well as the same size: a round
  //    where one side took three coins and the other one would be two sides an
  //    observer can tell apart, which is the whole thing this is for.
  const pieces = amounts.pieces || 1;
  const share = amounts.share || amounts.denom;
  const atShare = assembled.vout.filter((o) => o.value === share);
  if (atShare.length !== 2 * pieces) {
    throw new Error(
      'This Tango does not pay both sides the same amount in the same number ' +
        'of coins, which is the only thing it is for. Cancel it.',
    );
  }
  const byScript = new Map(assembled.vout.map((o) => [toHex(o.script), o.value]));
  if (ourMix.some((m) => byScript.get(toHex(m)) !== share)) {
    throw new Error('Your share is not in this transaction. Cancel it.');
  }
  const myChange = side === 'a' ? amounts.a_change : amounts.b_change;
  if (myChange && byScript.get(ourChangeHex!) !== myChange) {
    throw new Error('Your change is not in this transaction. Cancel it.');
  }
  const expectedOutputs =
    2 * pieces + (amounts.a_change ? 1 : 0) + (amounts.b_change ? 1 : 0);
  if (assembled.vout.length !== expectedOutputs) {
    throw new Error('This Tango pays somewhere it should not. Cancel it.');
  }

  return assembled;
}

/**
 * Sign our own inputs of a checked transaction.
 *
 * Takes an already-checked Assembled so no caller can produce a signature
 * without having run the checks, and takes the tweaks from `mine` — this
 * device's own records — never from the server's copy of the input set.
 */
export function signOwnInputs(
  assembled: Assembled,
  inputs: PayjoinInput[],
  mine: PayjoinInput[],
  spendKeyHex: string,
): Record<string, string> {
  const ordered = canonical(inputs);
  const tweaks = new Map(
    mine.map((i) => [`${i.txid.toLowerCase()}:${i.vout}`, i.priv_key_tweak]),
  );
  const out: Record<string, string> = {};
  for (const n of ownIndices(inputs, mine)) {
    const at = ordered[n];
    const key = inputSigningKey(spendKeyHex, {
      ...at,
      priv_key_tweak: tweaks.get(`${at.txid.toLowerCase()}:${at.vout}`),
    });
    const digest = taprootSighash(
      assembled.vin, assembled.vout, n, assembled.amounts, assembled.scripts,
    );
    out[String(n)] = toHex(schnorr.sign(digest, key));
  }
  if (!Object.keys(out).length) {
    throw new Error('None of the coins in this Tango are yours to sign.');
  }
  return out;
}

// ── the labels, and the one combination they exist to stop ──────────────────
// Mirrors helpers/tango.py. The backend writes these labels when the scanner
// finds the coins; this is the reading half, and it has to agree with the
// writing half exactly — a prefix that drifted by a character would silently
// stop refusing anything.

export const MIX_LABEL = 'Tango share';
export const CHANGE_LABEL = 'Tango change';

// What the share label used to be called. Coins carrying it are in wallets
// right now, and they can never be rewritten: the label is written once, at
// the scan that found the coin. The guard below has to know both spellings or
// it stops seeing those coins — and it is the guard that refuses to spend two
// shares of one round together, so it would stop refusing them in silence.
export const LEGACY_MIX_LABEL = 'Tango mix';
const MIX_LABELS = [MIX_LABEL, LEGACY_MIX_LABEL];

/** party() against every spelling the share label has had. */
function mixParty(label: string): string | null {
  for (const prefix of MIX_LABELS) {
    const who = party(label, prefix);
    if (who !== null) return who;
  }
  return null;
}

/**
 * The day a coin was made, for the label: "· 2026-09-24".
 *
 * WHY A DATE AND NOT A ROUND ID. Two rounds with the same person produce two
 * coins whose labels would otherwise read identically, so something has to
 * separate them. This was four characters of the round id, which separated
 * them and told the owner nothing — "#fagk" is noise in a coin list.
 *
 * ISO order rather than "24 Sep": it needs no locale to read, it sorts, and it
 * is the same width every time. The year is included because the label is
 * written once and never revised.
 *
 * Two rounds with one person ON THE SAME DAY still collide. They are
 * distinguishable by amount in the list beside it, and the refusal that reads
 * these labels does not use the marker at all — it goes by kind.
 */
export function dayMarker(when?: string | Date | null): string {
  if (!when) return '';
  if (when instanceof Date) {
    if (Number.isNaN(when.getTime())) return '';
    return `· ${when.toISOString().slice(0, 10)}`;
  }
  const text = String(when).trim().slice(0, 10);
  return text ? `· ${text}` : '';
}

function named(prefix: string, other?: string | null, when?: string | Date | null): string {
  const parts = [prefix];
  const who = (other || '').trim();
  if (who) parts.push(`- ${who}`);
  const mark = dayMarker(when);
  if (mark) parts.push(mark);
  return parts.join(' ');
}

export const mixLabel = (other?: string | null, when?: string | Date | null) =>
  named(MIX_LABEL, other, when);
export const changeLabel = (other?: string | null, when?: string | Date | null) =>
  named(CHANGE_LABEL, other, when);

// The markers this module has written: the date, and the round-id tag it
// replaced. Both have to be recognised — coins carrying the old one are in
// wallets right now, and a rule that stopped seeing them would stop refusing
// them silently.
const MARKERS = [' · ', ' #'];

function stripMarker(rest: string): string {
  for (const sep of MARKERS) {
    const at = rest.lastIndexOf(sep);
    if (at !== -1) return rest.slice(0, at).trim();
  }
  return rest;
}

/**
 * The counterparty named in one of our labels, or null if it is not one.
 *
 * Matched from the start and only up to a separator we wrote, never as a
 * substring: a coin the user named "my Tango mix money" is theirs, not ours,
 * and refusing to spend it would be us reading our own meaning into their
 * words. Accepts every shape this has written — with either marker and with
 * none — because coins labelled by the earlier versions are the ones in
 * wallets right now.
 */
function party(label: string, prefix: string): string | null {
  const text = (label || '').trim();
  if (text === prefix) return '';
  if (!text.startsWith(`${prefix} `)) return null;
  let rest = text.slice(prefix.length + 1).trim();
  if (rest.startsWith('- ')) rest = rest.slice(2).trim();
  else if (rest.startsWith('#') || rest.startsWith('·')) return '';
  else return null;   // "Tango mix something we never wrote" is the user's
  return stripMarker(rest);
}

/**
 * The round(s) a selection of coins would undo, named, or null.
 *
 * ANY TANGO SHARE WITH ANY TANGO CHANGE. Not only a share with its own
 * round's change, which is what this checked first and was too narrow.
 *
 * The reasoning that led there was that the two have to add up — a round's
 * change plus its share is what that side put in, so the arithmetic resolves
 * which of the two identical shares was theirs. True, and not the only way it
 * goes wrong. A Tango change coin is attributable BY CONSTRUCTION: its value
 * plus a share equals an input total, so an observer can tie it to the coins
 * its owner brought, which is exactly the history that owner had before the
 * mix. A share is the opposite: it is the coin that history was cut off from.
 * Put the two in one transaction and the cut is repaired — the share inherits
 * the change's attribution — whoever the round was with and whenever it
 * happened. Change from the alice round reconnects a share from the bob round
 * just as well.
 *
 * So the rule is by KIND, not by round, and the marker in a label is for the
 * person reading it rather than for this.
 *
 * Returns the counterparty of the share(s) at risk, since the share is what
 * loses its protection.
 */
/**
 * The scripts a side derived, however the row holds them.
 *
 * A JSON array is what rounds are stored as now. A bare hex string is what
 * every round from before pieces holds, and those are on chain — their coins
 * still need naming and their history still needs reading. Mirrors
 * helpers/tangolabels.py::spk_list.
 */
export function spkList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const text = String(raw).trim();
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed)
        ? parsed.filter(Boolean).map((x: unknown) => String(x).toLowerCase())
        : [];
    } catch {
      return [];
    }
  }
  return [text.toLowerCase()];
}

/** A coin as the guard needs it: what it is called, and what made it. */
export interface GuardCoin {
  txid?: string | null;
  label?: string | null;
}

/**
 * The round(s) a selection would undo, named, or null.
 *
 * TWO RULES, failing the same way: a transaction that says two coins had one
 * owner, when the whole point of the round was that nobody could say.
 *
 *  - ANY share with ANY change. A change coin is attributable by construction
 *    — its value plus a share is what its owner put in — and a share is the
 *    coin that history was cut off from. Together, the cut is repaired.
 *  - TWO SHARES FROM ONE ROUND. The price of taking a share in pieces: a round
 *    of p pieces a side has C(2p, p) readings only while nobody can say which
 *    p of the 2p identical coins were one person's. Spending two says it.
 *
 * Matched BY TXID, not by label, so the round id did not have to go back into
 * the coin's name. A plain string is still accepted — it is a label with no
 * txid, which simply cannot trip the second rule.
 *
 * Mirrors helpers/tangolabels.py::undoes_a_round, and scripts/
 * check-tango-signing.mjs holds the two to the same answers.
 */
export function undoesARound(
  coins: (GuardCoin | string | null | undefined)[],
): string | null {
  const mixed = new Set<string>();
  const byTxid = new Map<string, string[]>();
  let hasChange = false;
  for (const item of coins) {
    const txid =
      typeof item === 'string' || !item ? '' : String(item.txid || '');
    const raw = typeof item === 'string' ? item : item?.label || '';
    const asMix = mixParty(raw || '');
    if (asMix !== null) {
      const who = asMix || 'someone';
      mixed.add(who);
      if (txid) byTxid.set(txid, [...(byTxid.get(txid) || []), who]);
      continue;
    }
    if (party(raw || '', CHANGE_LABEL) !== null) hasChange = true;
  }
  const together = [...byTxid.values()].filter((n) => n.length > 1).map((n) => n[0]);
  if (together.length) return [...new Set(together)].sort().join(' and ');
  if (!mixed.size || !hasChange) return null;
  return [...mixed].sort().join(' and ');
}

// The turn table and the step wording live in their own module with no
// imports, so the always-running watchers can read them without pulling the
// cryptography below into the main bundle. Re-exported here for the screens,
// which need both halves anyway.
export {
  TERMINAL_STATUSES,
  STEPS,
  whoseTurn,
  isMyTurn,
  stepNumber,
  turnLine,
  changeLine,
  cancelledLine,
  whoCancelled,
  cancelNote,
  CANCEL_NOTE_MAX,
  CANCEL_NOTE_PROMPT,
} from './tangoTurns';
