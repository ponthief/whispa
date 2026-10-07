import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  AppState,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as api from '@services/api';
import { useAuthStore } from '@stores/authStore';
import { useNavStore } from '@stores/navStore';
import { getWalletKeys } from '@services/secureKeys';
import { useBalancesHidden, MASK } from '@stores/balancePrivacy';
import * as tango from '@services/tango';
import * as commits from '@services/tangoCommit';
import { parseSpAddress, fromHex, toHex } from '@services/spSign';
import { changeDestination, payoutIntended } from '@services/lnAddress';
import { useDrafts } from '@stores/draftStore';
import TangoPayoutCard from '../components/TangoPayoutCard';
import { colors, radius, space, type as type_ } from '@/theme';
import { Block, Button, Chips, Field, Group, Note, Page } from './settings/ui';

// Tango: a two-party mix.
//
// WHAT IT DOES, in the sentence the screen has to be able to say. You and one
// connected person each put in the same amount and each take the same amount
// back. Nobody pays anybody. Because the two outputs are identical, someone
// reading the chain cannot tell which is yours — an anonymity set of two.
//
// WHAT IT DOES NOT DO, which the screen also says. Two is two: a coin flip, not
// anonymity, though it compounds if you do it again with someone else. And the
// server running this sees both sides, so Tango hides the mapping from chain
// analysis and nothing from this instance.
//
// WHERE THE KEYS STAY. Both of this side's outputs are derived here from the
// wallet's scan key, and its inputs are signed here with the spend key.
// services/tango.ts holds the derivation and the checks that run before any
// signature exists; this file is the wiring.

type Row = api.TangoRoundRow;
type Tab = 'mix' | 'people' | 'rounds' | 'past';

const TERMINAL = ['BROADCAST', 'CANCELLED'];

// A coin as the wire wants it, and as the local signer wants it. Module scope
// because they are pure — and because as consts inside the component they were
// declared BELOW a useMemo that calls one. A useMemo body runs during render,
// so `local` was still undefined there: `matchChosen.map(local)` threw "Array
// prototype map requires callable argument" the moment a coin was tapped.
// Hoisting is the fix. The reason it shipped is that a lint suppression for
// exhaustive-deps was sitting on the very hook whose missing dependency was
// `local` — the rule was pointing straight at it. CLAUDE.md: prefer narrowing
// the value over suppressing the rule.
const wire = (u: api.Utxo): api.PayjoinSpWireInput => ({
  txid: u.txid, vout: u.vout, pub_key: u.pub_key, amount: u.amount,
});
const local = (u: api.Utxo): tango.PayjoinInput => ({
  txid: u.txid, vout: u.vout, amount: u.amount,
  pub_key: u.pub_key, priv_key_tweak: u.priv_key_tweak,
});

function parseInputs(raw?: string | null): tango.PayjoinInput[] {
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

// Amounts, honouring "hide balances". Module scope and `hidden` as an argument
// rather than a closure over it, so a callback can depend on the flag itself.
function fmtSats(n: number | null | undefined, hidden: boolean): string {
  return n == null ? '—' : hidden ? MASK : `${n.toLocaleString()} sats`;
}

export default function TangoScreen() {
  const inkey = useAuthStore((s) => s.inkey);
  const adminkey = useAuthStore((s) => s.adminkey);
  const hidden = useBalancesHidden();

  const [walletId, setWalletId] = useState<string | null>(null);
  const [network, setNetwork] = useState('signet');
  const [spAddress, setSpAddress] = useState('');
  const [coins, setCoins] = useState<api.Utxo[]>([]);
  const [rounds, setRounds] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  // Four tabs, the same four the web has. One scroll held the coin picker, the
  // proposal form, every round and the caveats at once, which meant the thing
  // you came for was never the thing on screen.
  const [tab, setTab] = useState<Tab>('mix');

  const [partner, setPartner] = useState('');
  const [denom, setDenom] = useState('');
  // How many equal coins each side takes its share back as.
  //
  // One coin each gives two readings of the round — which of the two identical
  // coins is yours. Two each gives six, three each twenty: C(2p, p), because
  // nobody can say which p of the 2p identical coins were one person's. It is
  // the only change measured that pays the same on every round shape, and it
  // costs 86 vbytes a pair.
  //
  // The price is that the pieces must never be spent together, which the send
  // guard refuses — see services/tango.ts::undoesARound.
  const [pieces, setPieces] = useState(2);

  // The connection graph. A Tango needs mutual consent — the propose endpoint
  // refuses a partner who is not an accepted contact — so the phone needs the
  // whole of it, not just a username field that fails after the fact.
  const [people, setPeople] = useState<api.Connections>({
    accepted: [], incoming: [], outgoing: [], declined: [],
  });
  const [newPerson, setNewPerson] = useState('');
  const [labels, setLabels] = useState<Record<string, string>>({});
  // The coins THIS user has chosen, by outpoint. Explicit on purpose: which of
  // your coins go into a mix is the decision the mix is made of, and a picker
  // that chooses for you has made it without saying so.
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // What this device committed to each round, read back from the keystore. See
  // services/tangoCommit.ts: the "these are the coins I chose" check needs a
  // list the server did not supply.
  const [committed, setCommitted] = useState<commits.TangoCommitMap>({});

  const key = (u: api.Utxo) => `${u.txid}:${u.vout}`;
  // What a NEW round may use. A coin another round is already holding is
  // refused by /rounds and /accept, and two rounds on one coin make a
  // transaction the network refuses — so it is not offered.
  const selectable = useMemo(
    () => coins.filter((c) => !c.tango_reserved),
    [coins],
  );
  const chosen = useMemo(
    () => selectable.filter((c) => picked.has(key(c))),
    [selectable, picked],
  );
  const chosenTotal = chosen.reduce((s, c) => s + c.amount, 0);

  // ── Surviving a lock ──────────────────────────────────────────────────────
  // App.tsx unmounts the whole Shell when the lock engages, so a selection
  // made seconds before the Offer button is gone when the screen comes back.
  // Picking coins for a mix is the decision the mix is made of — see the
  // comment on `picked` above — and on a wallet with many coins it is minutes
  // of work. See stores/draftStore.ts for why this is memory-only.
  const restored = useRef('');
  useEffect(() => {
    // Only once the coins are in: restoring against an empty `selectable`
    // would filter the selection to nothing and save that back.
    if (!walletId || restored.current === walletId || !selectable.length) return;
    restored.current = walletId;
    const draft = useDrafts.getState().tango[walletId];
    if (!draft) return;
    // A coin that a round took while the phone was locked is no longer in
    // `selectable` (tango_reserved), so it drops out here rather than being
    // offered to a second round.
    const live = new Set(selectable.map((c) => key(c)));
    setPicked(new Set(draft.selected.filter((k) => live.has(k))));
    setDenom(draft.denom);
    setPieces(draft.pieces);
    setPartner(draft.partner);
  }, [walletId, selectable]);

  useEffect(() => {
    if (!walletId || restored.current !== walletId) return;
    useDrafts.getState().setTango(walletId, {
      selected: [...picked],
      denom,
      pieces,
      partner,
    });
  }, [walletId, picked, denom, pieces, partner]);

  // MATCHING HAS ITS OWN SELECTION, and it is not a nicety.
  //
  // Matching used to read the CJ tab's `picked`, so a round proposed from the
  // web and opened on the phone showed "Choose which of your coins go in, then
  // accept." on a page with no coins on it — the picker was a tab away, and
  // nothing said so. The web has always had the picker inside the round; this
  // is that. Two sets rather than one, because a half-built proposal on the CJ
  // tab must not become the coins that match somebody else's round.
  const [matchFor, setMatchFor] = useState<string | null>(null);
  // Which round is being cancelled, and the optional line that goes with it.
  // Inline rather than an Alert: Alert.prompt is iOS-only.
  const [cancelAsk, setCancelAsk] = useState<string | null>(null);
  const [cancelNote, setCancelNote] = useState('');
  const [matchPicked, setMatchPicked] = useState<Set<string>>(new Set());
  const matchChosen = useMemo(
    () => selectable.filter((c) => matchPicked.has(key(c))),
    [selectable, matchPicked],
  );
  const matchTotal = matchChosen.reduce((s, c) => s + c.amount, 0);

  const load = useCallback(async () => {
    if (!inkey) {
      setLoading(false);
      return;
    }
    setError(null);
    try {
      const wallets = await api.getSilntWallets(inkey);
      const w = api.pickSilntWallet(wallets);
      if (!w) {
        setError('No Silent Payments wallet on this network.');
        setWalletId(null);
        return;
      }
      setWalletId(w.id);
      setNetwork(w.network);
      setSpAddress(w.sp_address);
      const [utxos, list] = await Promise.all([
        api.getUtxos(inkey, w.id),
        api.listTango(inkey),
      ]);
      // EVERY spendable coin, reserved ones included. This list has two jobs
      // and only one of them wants the reservation applied: `selectable` is
      // what a new round may pick from, while signing an EXISTING round looks
      // up its tweaks here — and that round's own coins are reserved, by it.
      // Filtering them out of both made approving a mix fail with "this
      // PayJoin uses a coin this device does not have", about a coin the
      // device had all along.
      setCoins(utxos.filter((u) => u.utxo_state === 'unspent' && !u.frozen));
      // Not in the Promise.all above: a connection list that fails is not a
      // reason to tell someone their coins would not load.
      api
        .listConnections(inkey, w.network)
        .then((p) => {
          setPeople(p);
          setLabels(
            Object.fromEntries(p.accepted.map((c) => [c.id, c.label || ''])),
          );
        })
        .catch(() => {});
      const live = list.rounds || [];
      setRounds(live);
      // Forget what was committed to rounds that are over: the list is only
      // needed while there is still something left to sign.
      const stored = await commits.loadTangoCommits();
      setCommitted(
        await commits.pruneTangoCommits(
          stored,
          live
            .filter((r) => !TERMINAL.includes(r.status))
            .map((r) => r.id),
        ),
      );
    } catch (e: any) {
      setError(e?.message || 'Could not load Tango.');
    } finally {
      setLoading(false);
    }
  }, [inkey]);

  // The watcher raises the banner off its own poll, and the screen loaded off
  // its own. So "it is your turn" arrived while the round on screen still said
  // it was theirs and offered no button — the banner was right and the page
  // behind it was a poll behind. One bump, one reload.
  const tangoTick = useNavStore((s) => s.tangoTick);

  useEffect(() => {
    load();
    // Reload on the way back to the foreground.
    //
    // The list was loaded once, when the screen mounted. Tapping a Tango
    // notification resumes an app whose Tango screen is often already mounted
    // and minutes stale, so the round the notification is ABOUT was missing
    // from the page it sends you to — appearing later, when something else
    // happened to reload. Coming back from the background is exactly the
    // moment the list is most likely to be behind.
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') load();
    });
    return () => sub.remove();
  }, [load, tangoTick]);

  /**
   * What the chosen coins would do at the entered denomination.
   *
   * Priced against this side's own coins standing in for the other side's,
   * which is what the server does when it takes a proposal — the real fee
   * depends on how many coins the partner brings. Good enough to tell you the
   * thing that matters before you commit: whether your selection leaves
   * change, and therefore whether the mix will be clean.
   */
  const preview = useMemo(() => {
    const d = Number(denom);
    if (!Number.isFinite(d) || d <= 0 || !chosen.length) return null;
    const rows = chosen.map((c) => ({
      txid: c.txid, vout: c.vout, amount: c.amount, pub_key: c.pub_key,
    }));
    try {
      const p = tango.plan(rows, rows, d, 2, pieces);
      return { change: p.a_change, fee: p.a_fee, error: null as string | null };
    } catch (e: any) {
      return { change: 0, fee: 0, error: e?.message || 'Does not work.' };
    }
  }, [denom, chosen, pieces]);

  // Unlike the proposal preview, this prices EXACTLY: their coins are already
  // in, so the fee is the real one rather than this side's standing in.
  const matchPreview = useMemo(() => {
    const r = rounds.find((x) => x.id === matchFor);
    if (!r || !matchChosen.length) return null;
    try {
      const p = tango.plan(
        parseInputs(r.a_inputs), matchChosen.map(local), r.denom_sats,
        r.fee_rate, r.pieces || 1, 'b',
      );
      return { fee: p.b_fee, change: p.b_change, clean: p.clean, error: null as string | null };
    } catch (e: any) {
      return { fee: 0, change: 0, clean: false, error: e?.message || 'Does not work.' };
    }
  }, [matchFor, matchChosen, rounds]);

  const startMatch = (r: Row) => {
    clearNotice();
    setMatchFor((cur) => (cur === r.id ? null : r.id));
    setMatchPicked(new Set());
  };

  const toggleMatch = (u: api.Utxo) => {
    clearNotice();
    setMatchPicked((prev) => {
      const next = new Set(prev);
      const k = key(u);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };


  const fail = (e: any) => {
    setMsg(null);
    setError(e?.message || 'Something went wrong.');
  };

  // A notice describes the form as it was when the notice was raised, so
  // changing that form makes it stale. Cleared by the controls the user
  // touches, not by an effect on the values: proposing successfully resets the
  // selection and the amount itself, and an effect would wipe the "Sent." it
  // had just put up.
  //
  // Without this, "Choose which of your coins go in, then accept." sat above
  // the screen while the user went to Mix, chose coins, and came back — still
  // telling them to do the thing they had just done.
  const clearNotice = useCallback(() => {
    setError(null);
    setMsg(null);
  }, []);

  const toggle = (u: api.Utxo) => {
    clearNotice();
    setPicked((prev) => {
      const next = new Set(prev);
      const k = key(u);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  // ── connections ──
  // Every one of these takes the inkey: they are read-and-consent calls on a
  // contact list, not spends.
  const refreshPeople = useCallback(async () => {
    if (!inkey) return;
    try {
      const p = await api.listConnections(inkey, network);
      setPeople(p);
      setLabels(Object.fromEntries(p.accepted.map((c) => [c.id, c.label || ''])));
    } catch (e) {
      fail(e);
    }
    // `network` belongs here. Left out, this closure kept the useState default
    // — 'signet' — for the life of the screen, however many times load() set
    // it to the wallet's real network. The mainnet app was then asking the
    // server about signet, which is where the off-network users it should have
    // refused do have wallets, so the whole check passed for the exact case it
    // was written for.
  }, [inkey, network]);

  const askConnect = useCallback(async () => {
    if (!inkey) return;
    const username = newPerson.trim();
    if (!username) {
      setError('Enter a username.');
      return;
    }
    setBusy('connect');
    setError(null);
    try {
      await api.requestConnection(inkey, username, network);
      setNewPerson('');
      // Names the person back. The endpoint refuses a username nobody holds,
      // so reaching here means it went to a real account — and seeing which
      // one is what catches the other kind of typo, the one that lands on
      // somebody.
      setMsg(`Request sent to ${username}. They have to approve it.`);
      await refreshPeople();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
    // See refreshPeople: `network` is read in the body, so it has to be here.
  }, [inkey, newPerson, network, refreshPeople]);

  const respond = useCallback(
    async (c: api.Connection, what: 'approve' | 'decline' | 'remove') => {
      if (!inkey) return;
      setBusy(c.id);
      setError(null);
      try {
        if (what === 'approve') await api.approveConnection(inkey, c.id);
        else if (what === 'decline') await api.declineConnection(inkey, c.id);
        else await api.removeConnection(inkey, c.id);
        setMsg(
          what === 'approve'
            ? 'Connected. Either of you can propose a Tango now.'
            : what === 'decline'
              ? 'Declined.'
              : 'Connection removed. Any unfinished Tango with them is off.',
        );
        await refreshPeople();
        // Removing a connection cancels its unfinished rounds server-side, so
        // the rounds this screen is holding are stale the moment it returns.
        if (what === 'remove') await load();
      } catch (e) {
        fail(e);
      } finally {
        setBusy(null);
      }
    },
    // `load` is here because a removal cancels rounds server-side, so this
    // has to refetch them. Left out, the closure would refetch against
    // whatever the first render captured.
    [inkey, refreshPeople, load],
  );

  const removeWithConfirm = useCallback(
    (c: api.Connection) => {
      Alert.alert(
        `Remove ${c.counterparty_username}?`,
        'Either side can. Any unfinished Tango with them is cancelled and ' +
          'both sides get their coins back. Nothing already broadcast is ' +
          'affected, and this does not touch another network\u2019s ' +
          'connections.',
        [
          { text: 'Keep' },
          {
            text: 'Remove',
            style: 'destructive',
            onPress: () => respond(c, 'remove'),
          },
        ],
      );
    },
    [respond],
  );

  const saveLabel = useCallback(
    async (c: api.Connection) => {
      if (!inkey) return;
      setBusy(c.id);
      try {
        await api.labelConnection(inkey, c.id, (labels[c.id] || '').trim());
        setMsg('Label saved. Only you see it.');
        await refreshPeople();
      } catch (e) {
        fail(e);
      } finally {
        setBusy(null);
      }
    },
    [inkey, labels, refreshPeople],
  );

  // Does THIS DEVICE mean to route its change on the round it is about to
  // join? Read here, at the moment of joining, and written into the local
  // record — never consulted again at signing time, because the setting is a
  // live value and a signature commits to what was true when the round was
  // planned.
  //
  // A read that fails counts as not routing. The server decides for itself,
  // so a disagreement is caught before signing and says to cancel; treating
  // an unreachable setting as "yes" would be the one direction that could
  // sign away a coin.
  const readPayoutIntent = useCallback(async () => {
    if (!inkey || !network) return false;
    try {
      return payoutIntended(await api.getTangoPayoutSetting(inkey, network));
    } catch {
      return false;
    }
  }, [inkey, network]);

  // ── A: propose ──
  //
  // Split in two so the proposal can be read before it is sent. Everything it
  // commits to — who, how much, how many coins in and out, the fee, the change
  // — was on the screen in four different places and nowhere together, and
  // Propose went straight to the server.
  const sendProposal = useCallback(async () => {
    if (!adminkey || !walletId) return;
    const d = Number(denom);
    setBusy('propose');
    setError(null);
    try {
      const intend = await readPayoutIntent();
      const row = await api.proposeTango(adminkey, {
        wallet_id: walletId,
        partner_username: partner.trim(),
        denom_sats: d,
        pieces,
        fee_rate: 2,
        inputs: chosen.map(wire),
        network,
      });
      // Remembered before anything else can change: this is the only copy of
      // the selection that the server did not write.
      setCommitted(
          await commits.recordTangoCommit(
            committed, row.id, walletId, chosen, intend,
          ),
        );
      setPartner('');
      setDenom('');
      setPicked(new Set());
      if (walletId) useDrafts.getState().clearTango(walletId);
      setMsg('Offer sent. You can cancel it under Rounds until they match it.');
      await load();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  }, [
    adminkey, walletId, denom, partner, chosen, pieces, network, committed,
    load, readPayoutIntent,
  ]);

  const propose = useCallback(() => {
    if (!adminkey || !walletId) return;
    const d = Number(denom);
    if (!Number.isFinite(d) || d <= 0) {
      setError('Enter the amount you each want back.');
      return;
    }
    if (!chosen.length) {
      setError('Choose which of your coins go in.');
      return;
    }
    const lines = [
      `To ${partner.trim()}`,
      `${fmtSats(d, hidden)} each, coinjoined into ${pieces === 1 ? '1 coin' : `${pieces} coins`}`,
      `Contributing ${chosen.length} coin${chosen.length === 1 ? '' : 's'}`
        + ` \u00b7 ${fmtSats(chosenTotal, hidden)}`,
    ];
    if (preview && !preview.error) {
      lines.push(`Your fee about ${fmtSats(preview.fee, hidden)}`);
      lines.push(preview.change ? `Your change ${fmtSats(preview.change, hidden)}` : 'No change');
    }
    Alert.alert('Confirm your Tango offer', lines.join('\n'), [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Confirm', onPress: () => void sendProposal() },
    ]);
  }, [
    adminkey, walletId, denom, partner, chosen, chosenTotal, pieces, preview,
    hidden, sendProposal,
  ]);

  // ── B: accept, which means deriving both of this side's outputs ──
  const accept = useCallback(
    async (row: Row) => {
      if (!adminkey || !walletId) return;
      if (!matchChosen.length) {
        setError('Choose which of your coins go in.');
        return;
      }
      setBusy(row.id);
      setError(null);
      try {
        const keys = await getWalletKeys(walletId);
        if (!keys) throw new Error('This device does not hold this wallet’s keys.');

        // The complete input set exists for the first time here, which is why
        // both scripts are derived in this call and not an earlier one.
        const all = [...parseInputs(row.a_inputs), ...matchChosen.map(local)];
        const pieces = row.pieces || 1;
        const amounts = tango.plan(
          parseInputs(row.a_inputs), matchChosen.map(local), row.denom_sats,
          row.fee_rate, pieces, 'b',
        );
        // ROUTING IS PER SIDE. Whether A gave a Lightning address has no
        // bearing here: if this side did not, its change is derived on this
        // device and goes to this wallet on chain, exactly as before the
        // setting existed.
        const intend = await readPayoutIntent();
        const { spend } = parseSpAddress(spAddress);
        const own = tango.deriveOwnOutputs(
          keys.scanSecret, spend, all, !intend && !!amounts.b_change, pieces,
        );

        await api.acceptTango(adminkey, row.id, {
          wallet_id: walletId,
          inputs: matchChosen.map(wire),
          mix_spks: own.mix.map(toHex),
          // Withheld when routing: a routed change pays the instance, and only
          // the payee can derive a BIP-352 output. The server refuses a script
          // here rather than ignoring one, so sending it would fail the accept.
          change_spk: own.change ? toHex(own.change) : null,
        });
        setCommitted(
          await commits.recordTangoCommit(
            committed, row.id, walletId, matchChosen, intend,
          ),
        );
        setMatchFor(null);
        setMatchPicked(new Set());
        setMsg(
          amounts.clean
            ? 'Matched, and neither side needs change — a clean round.'
            : 'Matched. One or both sides have change, which weakens it.',
        );
        await load();
      } catch (e) {
        fail(e);
      } finally {
        setBusy(null);
      }
    },
    [
      adminkey, walletId, spAddress, matchChosen, committed, load,
      readPayoutIntent,
    ],
  );

  // ── both: sign, after the checks ──
  const sign = useCallback(
    async (row: Row) => {
      if (!adminkey || !inkey || !walletId) return;
      setBusy(row.id);
      setError(null);
      try {
        const keys = await getWalletKeys(walletId);
        if (!keys) throw new Error('This device does not hold this wallet’s keys.');

        // Re-fetched: the list is however old the screen is, and what is about
        // to be signed is a transaction.
        const fresh = await api.getTango(inkey, row.id);
        const side = fresh.role!;
        const aRows = parseInputs(fresh.a_inputs);
        const bRows = parseInputs(fresh.b_inputs);
        const all = [...aRows, ...bRows];
        // Tweaks come from this device's own coin records, never from the
        // server's copy of the set — which carries none, by design.
        const mine = tango.withLocalTweaks(side === 'a' ? aRows : bRows, coins);

        const pieces = fresh.pieces || 1;
        const amounts: tango.TangoAmounts = {
          denom: fresh.denom_sats,
          pieces,
          share: Math.floor(fresh.denom_sats / pieces),
          a_in: fresh.a_in_sats!, b_in: fresh.b_in_sats!,
          a_change: fresh.a_change_sats || 0, b_change: fresh.b_change_sats || 0,
          a_fee: fresh.a_fee_sats!, b_fee: fresh.b_fee_sats!,
          fee: fresh.fee_sats!, vsize: fresh.vsize!,
          clean: !!fresh.clean,
        };

        // What THIS DEVICE agreed to when it joined, from its own record.
        // Null means no record — the round was started elsewhere — and
        // checkBeforeSigning refuses a routed round on that basis rather than
        // taking the server's word for what the user asked for.
        const intended = commits.getTangoPayoutIntent(
          committed, fresh.id, walletId,
        );
        const { spend } = parseSpAddress(spAddress);
        const myChange = side === 'a' ? amounts.a_change : amounts.b_change;
        // Nothing of ours to derive when it is routed: that output pays the
        // instance, and a BIP-352 script is derivable only by its payee.
        const own = tango.deriveOwnOutputs(
          keys.scanSecret, spend, all, !intended && !!myChange, pieces,
        );

        // A derives at sign time; B derived at accept time and its scripts are
        // already on the row. spkList reads either column shape, so a round
        // proposed before pieces existed still signs.
        const theirs = (raw?: string | null, old?: string | null) =>
          tango.spkList(raw || old).map(fromHex);
        const aMix = side === 'a'
          ? own.mix
          : theirs(fresh.a_mix_spks, fresh.a_mix_spk);
        const bMix = side === 'b'
          ? own.mix
          : theirs(fresh.b_mix_spks, fresh.b_mix_spk);
        // OUR OWN change comes from the round when we routed it, because a
        // routed output pays the instance and only the instance can derive
        // one — `own.change` is null in that case by design. Taking it from
        // `own` regardless left the side that routed with no change script at
        // all: nothing to verify against the revealed tweak, and a
        // transaction assembled without the output it was about to sign over.
        const fromRow = (hex?: string | null) => (hex ? fromHex(hex) : null);
        const aChange =
          side === 'a' && !intended ? own.change : fromRow(fresh.a_change_spk);
        const bChange =
          side === 'b' && !intended ? own.change : fromRow(fresh.b_change_spk);

        // The coins this device chose, from this device. Comparing the
        // server's set to the server's set would pass whatever it contained.
        // Absent — proposed from the web, or from a phone since reinstalled —
        // the check cannot be made, and the screen says so rather than
        // implying it passed.
        const chose = commits.getTangoCommit(committed, fresh.id, walletId);
        const myTweak = side === 'a' ? fresh.a_payout_tweak : fresh.b_payout_tweak;
        const assembled = tango.checkBeforeSigning({
          side, inputs: all, mine, amounts,
          aMix, bMix, aChange, bChange,
          expectMix: own.mix, expectChange: own.change,
          committed: chose || mine,
          denom: fresh.denom_sats, feeRate: fresh.fee_rate, pieces,
          // A routed change cannot be re-derived here, so the round reveals
          // t_k and this checks the arithmetic instead. The intent is this
          // device's own; the tweak and the address are the round's.
          payoutSpAddress: fresh.payout_sp_address || null,
          myPayoutTweak: myTweak ? fromHex(myTweak) : null,
          myPayoutIntended: intended,
        });

        const witnesses = tango.signOwnInputs(assembled, all, mine, keys.spendKey);
        const done = await api.signTango(adminkey, row.id, {
          witnesses,
          mix_spks: side === 'a' ? own.mix.map(toHex) : null,
          // Null when routing, for the same reason as at accept: the server
          // derives it and refuses a script sent here.
          change_spk: side === 'a' && own.change ? toHex(own.change) : null,
          unsigned_tx: assembled.unsignedHex,
        });
        const unverified = chose
          ? ''
          : ' This device has no record of which coins you chose for it, so' +
            ' that part could not be checked.';
        setMsg(
          (done.status === 'BROADCAST'
            ? 'Sent. Both shares are the same size, so nothing on chain says which is yours.'
            : 'Approved. Waiting on the other side.') + unverified,
        );
        await load();
      } catch (e) {
        fail(e);
      } finally {
        setBusy(null);
      }
    },
    [adminkey, inkey, walletId, spAddress, coins, committed, load],
  );

  // Cancelling asks inline rather than in an Alert, because it now takes an
  // optional line for the other side. Alert.prompt is iOS-only, so a dialog
  // could not carry the field on the platform this ships to.
  const cancel = useCallback((row: Row) => {
    setCancelNote('');
    setCancelAsk(row.id);
  }, []);

  const confirmCancel = useCallback(
    async (row: Row) => {
      if (!adminkey) return;
      setBusy(row.id);
      try {
        // Trimmed and capped here as well as on the server, so what was typed
        // is what gets stored rather than something the server shortened.
        const text = cancelNote.trim().slice(0, tango.CANCEL_NOTE_MAX);
        const done = await api.cancelTango(adminkey, row.id, text);
        setCancelAsk(null);
        setCancelNote('');
        // Said, rather than assumed. A note the server could not store is a
        // reason the other side will never read, and "Cancelled." on its own
        // reads as though it went.
        setMsg(
          text && done?.note_saved === false
            ? 'Cancelled, but your note could not be saved — the other side '
              + 'will not see it.'
            : 'Cancelled.',
        );
        await load();
      } catch (e) {
        fail(e);
      } finally {
        setBusy(null);
      }
    },
    [adminkey, cancelNote, load],
  );

  const sats = (n?: number | null) => fmtSats(n, hidden);

  // Who did the last thing, named.
  //
  // The stored statuses carry the role names the protocol needs — A proposes,
  // B matches, A_SIGNED means A has signed — and those names mean nothing to
  // the person reading them. This row used to print the status raw, so it read
  // "a_signed", which looks like a bug even when nothing is wrong. Nobody is
  // "A": they are you, or they are whoever you are mixing with, by name.
  const actor = (r: Row, which: 'a' | 'b') =>
    r.role === which
      ? 'You'
      : (which === 'a' ? r.a_username : r.b_username) || 'They';

  const statusLabel = (r: Row) => {
    switch (r.status) {
      case 'PROPOSED': return `${actor(r, 'a')} sent the offer`;
      case 'ACCEPTED': return `${actor(r, 'b')} matched it`;
      case 'A_SIGNED': return `${actor(r, 'a')} approved it`;
      // BROADCAST means the transaction is on the network, not that it
      // settled. `settled` is the backend's one-party answer: a UTXO row
      // exists at this round's txid in one of THIS user's wallets, which only
      // a scan of a mined block creates.
      //
      // It was `change_labelled` for a day, which was wrong: that flag waits
      // for every coin on BOTH sides to be named, so a round stayed
      // "Broadcasted" until the partner opened their app. Signet round
      // 9abeda54… was confirmed in block 324,904 and still reading as
      // in-flight.
      //
      // It can still sit on "Broadcasted" while this user's own background
      // scanning is off, which is honest — nothing here has seen the coins —
      // and is at least under their control.
      case 'BROADCAST': return r.settled ? 'Completed' : 'Broadcasted';
      // Who stopped it, or that nobody did: the sweeper closing a round nobody
      // finished is a different outcome from someone deciding to stop. The
      // stored reason keeps the SIDE, so this is where it becomes a name.
      case 'CANCELLED':
        return tango.cancelledLine(
          r.reject_reason, r.role, r.a_username, r.b_username,
        );
      default: return r.status;
    }
  };

  // "Sign" is what the code does; it is not what the person is doing, and the
  // two turns are not the same act. The first approves the mix and waits. The
  // second finishes it, puts it on the network, and cannot be undone — which a
  // button reading "Sign" for both gives no way to tell.
  const signLabel = (r: Row) =>
    r.status === 'A_SIGNED' ? 'Complete' : 'Approve';

  // `compact` is the Past tab: a finished round is a record, not a thing to
  // act on, so it carries the amount, who it was with and how it ended. The
  // fee, the change and which side had it are a live round's decision aids
  // and are on the transaction detail for anybody who wants them afterwards.
  const renderRound = (r: Row, compact = false) => {
    const side = r.role!;
    const mine = tango.isMyTurn(r.status, side);
    const other = side === 'a' ? r.b_username : r.a_username;
    const myChange = side === 'a' ? r.a_change_sats : r.b_change_sats;
    return (
      <View key={r.id} style={styles.row}>
        <View style={styles.rowHead}>
          <Text style={styles.rowWho}>with {other}</Text>
          <Text style={styles.rowStatus}>{statusLabel(r)}</Text>
        </View>
        {/* Their own words, in quotes and in their own line so it does not
            read as the app talking. Shown for a round this side cancelled
            too — it is what was sent, and seeing it is how you know it
            went. */}
        {r.status === 'CANCELLED' && tango.cancelNote(r.cancel_note) ? (
          <Text style={styles.rowNote}>
            “{tango.cancelNote(r.cancel_note)}”
          </Text>
        ) : null}
        <Text style={styles.rowAmount}>{sats(r.denom_sats)} each</Text>
        {!compact && tango.stepNumber(r.status) ? (
          <Text style={styles.rowMeta}>
            Step {tango.stepNumber(r.status)} of {tango.STEPS.length} ·{' '}
            {tango.turnLine(r.status, side, other)}
          </Text>
        ) : null}
        {!compact && r.fee_sats != null ? (
          <Text style={styles.rowMeta}>
            your fee {sats(side === 'a' ? r.a_fee_sats : r.b_fee_sats)} · {r.vsize} vB
            {myChange ? ` · your change ${sats(myChange)}` : ''}
          </Text>
        ) : null}
        {/* WHERE that change goes, from the round's own flag rather than from
            the setting — the two disagree whenever somebody switched it on
            after joining, and until this line existed nothing said which had
            applied. See changeDestination. */}
        {!compact
          && changeDestination(myChange, side === 'a' ? r.a_payout : r.b_payout) ? (
          <Text style={styles.rowMeta}>
            {changeDestination(myChange, side === 'a' ? r.a_payout : r.b_payout)}
          </Text>
        ) : null}
        {/* Which side, not "one or both": both amounts are recorded, and the
            hedge read as a claim about both on a round that had change on one. */}
        {compact ? null : r.clean === false ? (
          <Text style={styles.warn}>
            {tango.changeLine(
              side === 'a' ? r.a_change_sats : r.b_change_sats,
              side === 'a' ? r.b_change_sats : r.a_change_sats,
              other,
            )}
          </Text>
        ) : r.clean === true ? (
          <Text style={styles.good}>
            No change either side — nothing to work out from the amounts.
          </Text>
        ) : null}
        {r.txid ? (
          <Text style={styles.rowMeta} numberOfLines={1}>{r.txid}</Text>
        ) : null}
        {/* The coins go in HERE, on the round they are matching, not on a tab
            the user has to know to visit first. */}
        {mine && r.status === 'PROPOSED' && matchFor === r.id ? (
          <View style={styles.matchPanel}>
            <Text style={styles.rowMeta}>
              They put in {parseInputs(r.a_inputs).length} coin
              {parseInputs(r.a_inputs).length === 1 ? '' : 's'}. Choose yours:
              you need the amount plus your half of the fee, and anything over
              comes back as change.
            </Text>
            {selectable.length === 0 ? (
              <Text style={styles.rowMeta}>No spendable coins.</Text>
            ) : (
              selectable.map((c) => {
                const on = matchPicked.has(key(c));
                return (
                  <Pressable
                    key={key(c)}
                    onPress={() => toggleMatch(c)}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: on }}
                    style={[styles.coin, on && styles.coinOn]}>
                    <View style={[styles.tick, on && styles.tickOn]}>
                      {on ? <Text style={styles.tickMark}>✓</Text> : null}
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.coinAmount}>{sats(c.amount)}</Text>
                      <Text style={styles.coinMeta} numberOfLines={1}>
                        {c.label ? `${c.label} · ` : ''}{c.txid.slice(0, 16)}…:{c.vout}
                      </Text>
                    </View>
                  </Pressable>
                );
              })
            )}
            {matchChosen.length ? (
              <Text style={styles.rowMeta}>
                {matchChosen.length} chosen · {sats(matchTotal)}
                {matchPreview && !matchPreview.error
                  ? ` · your fee ${sats(matchPreview.fee)}`
                  : ''}
              </Text>
            ) : null}
            {matchPreview?.error ? (
              <Note kind="error">{matchPreview.error}</Note>
            ) : matchPreview && !matchPreview.clean && matchPreview.change ? (
              /* ONLY THIS SIDE'S CHANGE. It also said "Their side needs
                 change" when the selection left none here, which is a fact
                 about the proposer's coins and nothing this user can act on —
                 they already saw the same warning about their own side when
                 they proposed. Nothing is shown for that case now. */
              <Text style={styles.warn}>
                {`Your change would be ${sats(matchPreview.change)}. `}
                Change plus a share adds up to what that side put in, which is
                often enough to tell the two outputs apart.
              </Text>
            ) : matchPreview?.clean ? (
              <Text style={styles.good}>
                Neither side needs change — a clean round.
              </Text>
            ) : null}
          </View>
        ) : null}
        <View style={styles.rowActions}>
          {mine && r.status === 'PROPOSED' && matchFor !== r.id ? (
            <Button small label="Match it" busy={busy === r.id}
              onPress={() => startMatch(r)} />
          ) : null}
          {mine && r.status === 'PROPOSED' && matchFor === r.id ? (
            <Button
              small
              label="Submit"
              busy={busy === r.id}
              onPress={() => accept(r)} />
          ) : null}
          {mine && r.status !== 'PROPOSED' ? (
            <Button small label={signLabel(r)} busy={busy === r.id}
              onPress={() => sign(r)} />
          ) : null}
          {r.status !== 'BROADCAST' && r.status !== 'CANCELLED' ? (
            <Button small kind="danger" label="Cancel" busy={busy === r.id}
              onPress={() => cancel(r)} />
          ) : null}
        </View>
        {cancelAsk === r.id ? (
          <View style={styles.matchPanel}>
            {/* Only true before it is matched, so it is only said then. After
                that both sides' coins are held against the round, and a
                dialog that implies otherwise is one about money that is
                wrong. */}
            <Text style={styles.rowMeta}>
              {r.status === 'PROPOSED'
                ? `You can cancel this round before ${other || 'they'} match`
                  + ' it.'
                : 'Both sides\u2019 coins are held for this round. Cancelling'
                  + ' frees them; nothing has been broadcast.'}
            </Text>
            <Text style={styles.rowMeta}>
              {tango.CANCEL_NOTE_PROMPT(other)}
            </Text>
            {/* The input on its own line. It was a Field, which puts its
                action button hard against the input — so the destructive one
                sat where the keyboard's own confirm key would be, with a
                full-width "Keep it" directly under it and nothing between
                them. Two full-width buttons stacked a few pixels apart, one of
                which ends a round, is a mis-tap waiting to happen. */}
            <TextInput
              style={styles.noteInput}
              value={cancelNote}
              onChangeText={setCancelNote}
              placeholder="optional"
              placeholderTextColor={colors.faint}
              maxLength={tango.CANCEL_NOTE_MAX}
              autoCapitalize="sentences"
              autoCorrect
            />
            {/* Keep it first and wider: it is the safe one, and the one a
                thumb reaching up the screen finds. They share a row with a
                real gap, so neither is where the other was. */}
            <View style={styles.cancelActions}>
              <Button
                label="Keep it"
                kind="secondary"
                style={styles.keepBtn}
                onPress={() => { setCancelAsk(null); setCancelNote(''); }}
              />
              <Button
                label="Cancel it"
                kind="danger"
                busy={busy === r.id}
                style={styles.cancelBtn}
                onPress={() => void confirmCancel(r)}
              />
            </View>
          </View>
        ) : null}
      </View>
    );
  };

  const mineNow = (r: Row) => tango.isMyTurn(r.status, r.role);
  const waiting = rounds.filter(mineNow);
  const theirs = rounds.filter((r) => !TERMINAL.includes(r.status) && !mineNow(r));
  const past = rounds
    .filter((r) => TERMINAL.includes(r.status))
    .slice()
    .sort((a, b) =>
      String(b.updated_at || b.created_at || '').localeCompare(
        String(a.updated_at || a.created_at || ''),
      ),
    );

  // Only people a round could actually be built with. on_network is absent
  // when the server was not asked, in which case everyone stays offered.
  const reachable = people.accepted.filter((c) => c.on_network !== false);

  const partnerLabel = (c: api.ConnectedPartner | api.Connection) => {
    const name = 'username' in c ? c.username : c.counterparty_username;
    const l = ('label' in c ? c.label : '') || '';
    return l.trim() ? `${l.trim()} (${name})` : name;
  };

  return (
    <Page
      title="Tango"
      subtitle={
        'Select your WhiSPa partner/coins and amount ' +
        'to start collaborative mini-coinjoin round.'
      }>
      {error ? (
        <Block><Note kind="error">{error}</Note></Block>
      ) : null}
      {msg ? <Block><Note kind="ok">{msg}</Note></Block> : null}

      <Block>
        <Chips<Tab>
          options={[
            { key: 'mix', label: 'CJ' },
            { key: 'people', label: 'Partners' },
            {
              key: 'rounds',
              label: waiting.length ? `Rounds (${waiting.length})` : 'Rounds',
            },
            { key: 'past', label: 'Hist.' },
          ]}
          selected={tab}
          onSelect={setTab}
        />
      </Block>

      {tab === 'mix' ? (
        <>
          <Group
            title="Your coins"
            // Only says something when the selection has told it something.
            // The old placeholder explained how to use a list of tappable
            // coins sitting directly above it.
            footer={
              preview && !preview.error
                ? preview.change
                  ? `The change of ${preview.change.toLocaleString()} sats is bad for privacy. Try the exact amount.`
                  : 'No change. The strongest shape.'
                : undefined
            }>
            <Block>
              {selectable.length === 0 ? (
                <Text style={styles.rowMeta}>No spendable coins.</Text>
              ) : (
                selectable.map((c) => {
                  const on = picked.has(key(c));
                  return (
                    <Pressable
                      key={key(c)}
                      onPress={() => toggle(c)}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: on }}
                      style={[styles.coin, on && styles.coinOn]}>
                      <View style={[styles.tick, on && styles.tickOn]}>
                        {on ? <Text style={styles.tickMark}>✓</Text> : null}
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.coinAmount}>{sats(c.amount)}</Text>
                        <Text style={styles.coinMeta} numberOfLines={1}>
                          {c.label ? `${c.label} · ` : ''}{c.txid.slice(0, 16)}…:{c.vout}
                        </Text>
                      </View>
                    </Pressable>
                  );
                })
              )}
            </Block>
            {chosen.length ? (
              <Block>
                <Text style={styles.rowMeta}>
                  {chosen.length} chosen · {sats(chosenTotal)}
                  {preview && !preview.error
                    ? ` · your fee about ${preview.fee.toLocaleString()} sats`
                    : ''}
                </Text>
                {preview?.error ? (
                  <Note kind="error">{preview.error}</Note>
                ) : null}
              </Block>
            ) : null}
          </Group>

          <Group title="Choose your partner">
            <Block>
              {reachable.length === 0 ? (
                <Text style={styles.rowMeta}>
                  {people.accepted.length
                    ? `None of your connections has a wallet on ${network}, so ` +
                      'there is nobody to Tango with here. See Partners.'
                    : 'No partners yet. Add one under Partners — they approve, ' +
                      'then they appear here.'}
                </Text>
              ) : (
                reachable.map((c) => {
                  const on = partner === c.counterparty_username;
                  return (
                    <Pressable
                      key={c.id}
                      onPress={() => {
                        clearNotice();
                        setPartner(on ? '' : c.counterparty_username);
                      }}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: on }}
                      style={[styles.coin, on && styles.coinOn]}>
                      <View style={[styles.tick, styles.tickRound, on && styles.tickOn]}>
                        {on ? <Text style={styles.tickMark}>✓</Text> : null}
                      </View>
                      <Text style={styles.coinAmount}>{partnerLabel(c)}</Text>
                    </Pressable>
                  );
                })
              )}
            </Block>
            <Block>
              <Text style={styles.rowMeta}>
                Number of coins to come out from mini-coinjoin:
              </Text>
              <Chips<number>
                options={[1, 2, 3].map((n) => ({
                  key: n,
                  label: n === 1 ? '1 coin' : `${n} coins`,
                }))}
                selected={pieces}
                onSelect={(n) => {
                  clearNotice();
                  setPieces(n);
                }}
              />
              <Text style={styles.rowMeta}>
                {pieces === 1
                  ? 'Low anonymity. Cheapest in miner fees.'
                  : pieces === 2
                    ? 'Medium anonymity. Costs more in miner fees.'
                    : 'High anonymity. Costs the most in miner fees.'}
              </Text>
            </Block>
            <Block>
              <Field
                value={denom}
                onChangeText={(v) => {
                  clearNotice();
                  setDenom(v);
                }}
                placeholder="sats each"
                keyboardType="number-pad"
                action="Send offer"
                onAction={propose}
                actionBusy={busy === 'propose'}
                actionDisabled={
                  !partner || !denom || !chosen.length || !walletId ||
                  !!preview?.error
                }
              />
            </Block>
          </Group>

          {/* Where the change goes, offered beside the warning that a round
              leaves some. Renders nothing off mainnet. */}
          <TangoPayoutCard inkey={inkey} network={network} />
        </>
      ) : null}

      {tab === 'people' ? (
        <>
          <Group
            title="Add someone"
            footer="Add someone to Tango with, by their WhiSPa username.">
            <Block>
              <Field
                value={newPerson}
                onChangeText={setNewPerson}
                placeholder="their username"
                autoCapitalize="none"
                action="Ask"
                onAction={askConnect}
                actionBusy={busy === 'connect'}
                actionDisabled={!newPerson.trim()}
              />
            </Block>
          </Group>

          {people.incoming.length ? (
            <Group title="Asking to connect">
              <Block>
                {people.incoming.map((c) => (
                  <View key={c.id} style={styles.row}>
                    <View style={styles.rowHead}>
                      <Text style={styles.rowWho}>{c.counterparty_username}</Text>
                      <Text style={styles.rowStatus}>asking</Text>
                    </View>
                    <Text style={styles.rowMeta}>
                      They want to connect. Accepting lets either of you propose
                      a Tango.
                    </Text>
                    <View style={styles.rowActions}>
                      <Button small label="Approve" busy={busy === c.id}
                        onPress={() => respond(c, 'approve')} />
                      <Button small kind="secondary" label="Decline"
                        busy={busy === c.id} onPress={() => respond(c, 'decline')} />
                    </View>
                  </View>
                ))}
              </Block>
            </Group>
          ) : null}

          {people.outgoing.length ? (
            <Group
              title="Sent, not answered"
              footer="They have to accept before either of you can propose a Tango. Nothing happens until they do, and you can withdraw a request at any time.">
              <Block>
                {people.outgoing.map((c) => (
                  <View key={c.id} style={styles.row}>
                    <View style={styles.rowHead}>
                      <Text style={styles.rowWho}>{c.counterparty_username}</Text>
                      <Text style={styles.rowStatus}>pending</Text>
                    </View>
                    <Text style={styles.rowMeta}>
                      Waiting for them to accept or decline.
                    </Text>
                    <View style={styles.rowActions}>
                      <Button small kind="secondary" label="Withdraw"
                        busy={busy === c.id} onPress={() => respond(c, 'remove')} />
                    </View>
                  </View>
                ))}
              </Block>
            </Group>
          ) : null}

          <Group title="Connected">
            <Block>
              {people.accepted.length === 0 ? (
                <Text style={styles.rowMeta}>Nobody yet.</Text>
              ) : (
                people.accepted.map((c) => (
                  <View key={c.id} style={styles.row}>
                    <View style={styles.rowHead}>
                      <Text style={styles.rowWho}>{c.counterparty_username}</Text>
                      <Text style={styles.rowStatus}>
                        {c.on_network === false ? `not on ${network}` : 'connected'}
                      </Text>
                    </View>
                    {c.on_network === false ? (
                      <Text style={styles.warn}>
                        They no longer have a wallet on {network}, so a Tango
                        with them cannot be built. Shown so you can see why and
                        remove them; they are not offered under CJ.
                      </Text>
                    ) : null}
                    <View style={{ height: space.xs }} />
                    <Field
                      value={labels[c.id] || ''}
                      onChangeText={(t) =>
                        setLabels((prev) => ({ ...prev, [c.id]: t }))
                      }
                      placeholder="private label"
                      action="Save"
                      onAction={() => saveLabel(c)}
                      actionBusy={busy === c.id}
                    />
                    <View style={styles.rowActions}>
                      <Button small kind="danger" label="Remove"
                        busy={busy === c.id} onPress={() => removeWithConfirm(c)} />
                    </View>
                  </View>
                ))
              )}
            </Block>
          </Group>

          {people.declined.length ? (
            <Group title="Declined">
              <Block>
                {people.declined.map((c) => (
                  <View key={c.id} style={styles.row}>
                    <View style={styles.rowHead}>
                      <Text style={styles.rowWho}>{c.counterparty_username}</Text>
                      <Text style={styles.rowStatus}>declined</Text>
                    </View>
                    <Text style={styles.rowMeta}>
                      They turned your request down. Dismiss it to clear it.
                    </Text>
                    <View style={styles.rowActions}>
                      <Button small kind="secondary" label="Dismiss"
                        busy={busy === c.id} onPress={() => respond(c, 'remove')} />
                    </View>
                  </View>
                ))}
              </Block>
            </Group>
          ) : null}
        </>
      ) : null}

      {tab === 'rounds' ? (
        <>
          {/* EMPTY MEANS EMPTY. Both sections said so in a sentence — "Nothing
              waiting on you", "Nothing waiting on the other side" — under a
              heading that already says which side it is about. The heading
              with nothing under it carries it. */}
          <Group title="Your Tango move">
            <Block>
              {waiting.map((r) => renderRound(r))}
            </Block>
          </Group>

          <Group title="Their Tango move">
            <Block>
              {theirs.map((r) => renderRound(r))}
            </Block>
          </Group>
        </>
      ) : null}

      {tab === 'past' ? (
        <Group
          title="Past rounds"
          footer="A round that ran out of time is closed by the server and both sides' coins go back into circulation.">
          <Block>
            {past.length === 0 ? (
              <Text style={styles.rowMeta}>No finished rounds yet.</Text>
            ) : (
              past.map((r) => renderRound(r, true))
            )}
          </Block>
        </Group>
      ) : null}

      {loading ? <Block><Text style={styles.rowMeta}>Loading…</Text></Block> : null}
    </Page>
  );
}

const styles = StyleSheet.create({
  row: {
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rowHead: { flexDirection: 'row', justifyContent: 'space-between' },
  rowWho: { ...type_.body, color: colors.text, fontWeight: '600', flexShrink: 1 },
  rowStatus: { ...type_.overline, color: colors.muted },
  rowAmount: { ...type_.body, color: colors.text, marginTop: 2 },
  rowMeta: { ...type_.caption, color: colors.muted, marginTop: 2 },
  warn: { ...type_.caption, color: colors.primary, marginTop: 4 },
  good: { ...type_.caption, color: colors.green, marginTop: 4 },
  // Set in from the round it belongs to, so a list of rounds still reads as a
  // list while one of them is open.
  matchPanel: {
    marginTop: space.sm,
    paddingLeft: space.sm,
    borderLeftWidth: 2,
    borderLeftColor: colors.border,
  },
  rowActions: { flexDirection: 'row', gap: space.sm, marginTop: space.sm },
  noteInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceAlt,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    marginTop: space.sm,
    fontSize: 15,
    color: colors.text,
  },
  // A real gap, not a stack: the two do different things and one of them
  // cannot be undone.
  cancelActions: {
    flexDirection: 'row',
    gap: space.md,
    marginTop: space.md,
  },
  keepBtn: { flex: 3 },
  cancelBtn: { flex: 2 },
  // Quoted, dimmed and italic: somebody else's sentence, not the app's.
  rowNote: {
    ...type_.body,
    color: colors.muted,
    fontStyle: 'italic',
    marginTop: space.xs,
  },
  coin: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  coinOn: { backgroundColor: colors.surfaceAlt },
  tick: {
    width: 20, height: 20, borderRadius: 5,
    borderWidth: 1.5, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center',
  },
  // A radio, not a checkbox: you mix with one person, not several.
  tickRound: { borderRadius: 10 },
  tickOn: { borderColor: colors.primary, backgroundColor: colors.primary },
  tickMark: { color: colors.onPrimary, fontSize: 13, fontWeight: '700', lineHeight: 16 },
  coinAmount: { ...type_.body, color: colors.text },
  coinMeta: { ...type_.caption, color: colors.muted },
  input: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.text,
    ...type_.body,
  },
});
