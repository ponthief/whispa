#!/usr/bin/env node
/*
 * What the transaction detail says a Tango did.
 *
 * Both of these were reported as wrong numbers on a real round —
 * 3331ddbf…3331af on signet: 8 inputs, three outputs of 14,000 / 14,000 /
 * 2,503, change on ONE side.
 *
 *   1. Every output the wallet does not own was listed under "alice's share".
 *      Her change was one of them, so a 14,000 round reported her as taking
 *      16,503 out of a mix where both sides took 14,000.
 *   2. The round line read "Change on one or both sides" whichever side had
 *      it — a hedge that reads as a claim about both, on a round where one
 *      side was clean.
 *
 * Neither is caught by a type or a build. Both are arithmetic a person checks
 * against an explorer, which is exactly when a wallet has to be right.
 *
 * Run: node --experimental-strip-types scripts/check-tango-display.mjs
 */
import { readFileSync } from 'node:fs';
import {
  CANCEL_NOTE_MAX,
  CANCEL_NOTE_PROMPT,
  cancelNote,
  cancelledLine,
  changeLine,
  turnLine,
} from '../src/services/tangoTurns.ts';

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log((cond ? '  ok   ' : '  FAIL ') + name);
  if (!cond) {
    if (detail) console.log('         ' + detail);
    failures++;
  }
};
const eq = (name, got, want) =>
  ok(name, JSON.stringify(got) === JSON.stringify(want),
     `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

console.log('a round does not report on the partner');
{
  // It used to list every output the wallet does not own — the other side's
  // share AND their change, which reported a 14,000 round as 16,503 going to
  // them. Those outputs are on chain either way and are none of this wallet's
  // business, so the section is gone for a Tango and kept for a send, where
  // the recipient is the point.
  for (const [file, guard] of [
    ['src/components/TxDetailModal.tsx', 'detail.recipients?.length && !mix'],
    ['src/views/TransactionsView.vue', 'expandedDetail.recipients.length && !mixOf(tx)'],
  ]) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    ok(`${file} hides the recipients of a round`, src.includes(guard),
      'a Tango would list the other side\u2019s outputs again');
    ok(`${file} still shows them for a send`, src.includes('Recipients'));
  }
  // And the machinery for splitting them is gone with it.
  const svc = readFileSync(new URL('../src/services/tangoTurns.ts', import.meta.url), 'utf8');
  for (const dead of ['splitMixOutputs', 'mixOtherShareTitle', 'mixOtherChangeTitle']) {
    ok(`${dead} is gone`, !svc.includes(dead));
  }
}

console.log('\nwhat each side is waiting for');
{
  // Side A, after approving: the round is on B, and what B does next puts it
  // on the network. "Waiting for bob to sign" said neither which wait it was
  // nor that it was the last one.
  eq('A after approving', turnLine('A_SIGNED', 'a', 'bob'),
     'Waiting for bob to complete the Tango round.');
  // Side B, having matched: waiting on an approval that broadcasts nothing.
  eq('B after matching', turnLine('ACCEPTED', 'b', 'alice'),
     'Waiting for alice to approve it.');
  eq('A after proposing', turnLine('PROPOSED', 'a', 'bob'),
     'Waiting for bob to match it.');
  // And the turns that ARE yours still say what pressing does.
  ok('B at the last step is told it broadcasts',
    turnLine('A_SIGNED', 'b', 'alice').includes('broadcasts the transaction'));
  ok('and that it cannot be undone',
    turnLine('A_SIGNED', 'b', 'alice').includes('cannot be undone'));
  eq('a finished round', turnLine('BROADCAST', 'a', 'bob'),
     'Done \u2014 both shares are on chain.');
}

console.log('\nthe wording that was asked for, and stays gone');
{
  // Removed on request. Each was a sentence a person had already worked out
  // from the screen it was printed on.
  const GONE = [
    'nothing is on chain',      // under the approve step
    'Your change would have been',  // the dropped-change note on a history row
    'Confirm this mix',         // the signing modal's old title
    'Other outputs',            // read as "yours", and it cannot know whose
    'Tango steps',              // the five lines, removed from both screens
    'Connections are per network',  // three sentences where one does
  ];
  for (const file of [
    'src/screens/TangoScreen.tsx', 'src/views/TangoView.vue',
    'src/components/TxDetailModal.tsx', 'src/views/TransactionsView.vue',
    'src/services/tangoTurns.ts',
  ]) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const text of GONE) ok(`${file} has no "${text}"`, !src.includes(text));
  }
  ok('the approve wait says only what it needs',
    !turnLine('ACCEPTED', 'b', 'alice').includes('on chain'));
  // A Tango is not a payment, and "Mixed" was the word for it in three places.
  for (const file of ['src/components/TxDetailModal.tsx', 'src/views/TransactionsView.vue']) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    ok(`${file} says Tango-ed`, src.includes('Tango-ed'));
    // The fee share is a fee. Beside "alice's share" — the mixed output —
    // a bare "Your share" read as the other kind entirely.
    ok(`${file} calls the fee share a fee share`, src.includes('Your fee share'));
    ok(`${file} does not say a bare "Your share"`,
      !/Your share[^ ]/.test(src) && !src.includes('"Your share"'));
  }
}

console.log('\nno screen calls it a mix');
{
  // A Tango is a round, and its outputs are shares. "Mix" was the word for it
  // in a dozen places, including the label written onto a coin.
  for (const file of [
    'src/screens/TangoScreen.tsx', 'src/views/TangoView.vue',
    'src/components/TxDetailModal.tsx', 'src/views/TransactionsView.vue',
  ]) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    // Only what a person reads: the identifiers (mixPicked, mixOf, own.mix,
    // mix_spks) are the protocol's own words and stay.
    const prose = [...src.matchAll(/'([^'\n]{6,})'|"([^"\n]{6,})"|>([^<>{}\n]{6,})</g)]
      .map((m) => m[1] || m[2] || m[3])
      // Sentences, not expressions: a Vue attribute is a string too, and
      // `tab === 'mix'` is the tab's key, which nobody reads.
      .filter((t) => /\s/.test(t) && !/[=;(){}]|\?|\bconst\b/.test(t));
    const offenders = prose.filter((t) => /\bmix(ed|es|ing)?\b/i.test(t));
    ok(`${file} has no "mix" in anything a person reads`,
      offenders.length === 0, offenders.slice(0, 3).join(' | '));
  }
  const svc = readFileSync(new URL('../src/services/tango.ts', import.meta.url), 'utf8');
  ok('the coin label is a share', svc.includes("export const MIX_LABEL = 'Tango share'"));
  // And the old spelling is still recognised, or the guard that refuses two
  // shares of one round goes quiet on every coin mixed before the rename.
  ok('the old spelling is still matched',
    svc.includes("LEGACY_MIX_LABEL = 'Tango mix'") && svc.includes('mixParty('));
}

console.log('\nthe two clients name the same actions');
{
  // One round, two screens: a button called Complete on the phone and
  // "Finish & send" in the browser is the same press under two names, and the
  // browser kept the old one for a release after the phone changed.
  const RETIRED = ['Match & derive', 'Finish & send', 'Finish & sign'];
  for (const file of ['src/screens/TangoScreen.tsx', 'src/views/TangoView.vue']) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const label of RETIRED) {
      ok(`${file} has no "${label}"`, !src.includes(label));
    }
    ok(`${file} says Complete`, src.includes("'Complete'"));
    ok(`${file} says Submit`, src.includes('Submit'));
  }
}

console.log('\nthe warning about undoing a round is read before it is too late');
{
  // A share spent with change publishes which outputs were whose, and no
  // later transaction takes that back. It was six lines below the coin list,
  // off the bottom of the page in the browser, under the selection that
  // caused it. Short, loud, and above the fold in both apps now.
  const W = readFileSync(new URL('../src/services/sendWarnings.ts', import.meta.url), 'utf8');
  const m = W.match(/TANGO_UNDO_NOTE\s*=\s*([\s\S]*?);/);
  ok('the wording is in one place', !!m, 'TANGO_UNDO_NOTE not found');
  const text = (m ? m[1] : '').replace(/['+\n]/g, ' ').replace(/\s+/g, ' ').trim();
  ok('it stays short', text.length <= 220, `${text.length} chars: ${text}`);
  ok('it is two sentences at most',
    (text.match(/[.!?](\s|$)/g) || []).length <= 2, text);
  ok('it says what to do instead', /separate transactions/i.test(text));
  // THE CONSEQUENCE MOVED TO THE TITLE on 2026-10-05, when the note was cut
  // to the remedy alone. It used to be asserted on the note ("permanently");
  // the word is gone from the screen now and "undoes" carries it, which is
  // weaker. Assert it where it actually lives rather than dropping the rule.
  const t = (W.match(/TANGO_UNDO_TITLE\s*=\s*'([^']*)'/) || [])[1] || '';
  ok('the title names the consequence', /undoes/i.test(t), t);
  ok('and names what is undone', /coinjoin|tango/i.test(t), t);
  // The acknowledgement still has to be an acknowledgement, not an OK button:
  // it is the only thing standing between the selection and the signature.
  const ack = (W.match(/TANGO_UNDO_ACK\s*=\s*'([^']*)'/) || [])[1] || '';
  ok('the acknowledgement admits what it is doing',
     /understand/i.test(ack) && /anyway/i.test(ack), ack);

  const WEB = readFileSync(new URL('../src/views/SendView.vue', import.meta.url), 'utf8');
  const RN = readFileSync(new URL('../src/screens/SendScreen.tsx', import.meta.url), 'utf8');
  for (const [label, src] of [['web', WEB], ['mobile', RN]]) {
    ok(`${label} renders the shared wording`, src.includes('TANGO_UNDO_NOTE'));
    // The acknowledgement is what gates the send; losing it turns the whole
    // warning into decoration.
    ok(`${label} still gates on the acknowledgement`, src.includes('tangoAck'));
  }
  // Above the coin list in the browser, not below it. The selection is on the
  // right-hand card, and the alert used to render after it.
  const alertAt = WEB.indexOf('tangoPairing && !broadcastDone');
  ok('web puts it above the coin list',
    alertAt !== -1 && alertAt < WEB.indexOf('<h2>Select coins</h2>'),
    'the alert renders after the coin list again');
  // And in the tampering alert's colours rather than an ordinary privacy note.
  ok('web uses the alarm colours', /tangoPairing && !broadcastDone[\s\S]{0,200}--red/.test(WEB));
  ok('mobile uses the alarm colours', RN.includes('styles.undoWarn'));
}

console.log('\nthe line somebody leaves when they cancel');
{
  // OPTIONAL, and the other side reads it. Two things it must not become: a
  // place for state (reject_reason stays the machine-readable half, parsed on
  // both clients and the server) and a message thread.
  eq('nothing to show is null', cancelNote(''), null);
  eq('whitespace alone is nothing', cancelNote('  \n '), null);
  eq('a note is one line', cancelNote(' changed my\n\n mind '), 'changed my mind');
  ok('a long one is cut with an ellipsis',
    cancelNote('a'.repeat(CANCEL_NOTE_MAX + 20))
      === `${'a'.repeat(CANCEL_NOTE_MAX)}…`);
  ok('the cap matches the server', CANCEL_NOTE_MAX === 200,
    'helpers/tango.py::CANCEL_NOTE_MAX is the authority');
  // The prompt says optional. A field on a destructive confirmation with no
  // label reads as something that has to be filled in first.
  ok('the prompt names who will read it',
    CANCEL_NOTE_PROMPT('alice').includes('alice'));
  ok('and says it is optional',
    /optional/i.test(CANCEL_NOTE_PROMPT('alice'))
    && /optional/i.test(CANCEL_NOTE_PROMPT(null)));
  ok('it still works with no name',
    CANCEL_NOTE_PROMPT(null).includes('them'));

  // reject_reason is untouched by any of this: both parsers still read it.
  eq('a cancellation still names the side', cancelledLine('cancelled by a', 'a'),
    'You cancelled it');
  eq('and the other reader gets the name',
    cancelledLine('cancelled by a', 'b', 'alice', 'bob'), 'alice cancelled it');

  const MOBILE = readFileSync(
    new URL('../src/screens/TangoScreen.tsx', import.meta.url), 'utf8');
  const WEB = readFileSync(
    new URL('../src/views/TangoView.vue', import.meta.url), 'utf8');
  for (const [label, src] of [['mobile', MOBILE], ['web', WEB]]) {
    ok(`${label} asks for it where the round is cancelled`,
      src.includes('CANCEL_NOTE_PROMPT('));
    ok(`${label} caps the input`, /maxlength|maxLength/.test(src)
      && src.includes('CANCEL_NOTE_MAX'));
    ok(`${label} quotes it when showing it`, /cancelNote\(/.test(src)
      && src.includes('\u201c'),
      'somebody else\'s sentence has to read as theirs, not the app\'s');
    // AND IN THE HISTORY, which is where a finished round is read. Both
    // clients render past rounds through the same row renderer as the live
    // ones, so the note has to sit in that shared renderer rather than in a
    // branch only the live list takes.
    const noteAt = src.indexOf('cancelNote(');
    const cancelledOnly = /r\.status === 'CANCELLED' && /.test(src)
      || /r\.status === 'CANCELLED' &&\s*$/m.test(src);
    ok(`the ${label} shows it only for a cancelled round`, cancelledOnly);
    ok(`the ${label} shows it wherever a round is listed`, noteAt !== -1);
    // The ask is a panel or a modal, not a native dialog: neither confirm()
    // nor Alert.alert can carry a field (Alert.prompt is iOS-only), so a
    // dialog here would mean offering the note and dropping it.
    ok(`${label} asks in a panel, not a dialog`, src.includes('cancelAsk'));
    // The round-cancel warning must not sit inside a dialog call. Other
    // confirms on these screens are fine — removing a connection is one.
    const warn = src.indexOf('coins are held for this round');
    ok(`${label} states the warning in the panel`, warn !== -1);
    const before = src.slice(Math.max(0, warn - 300), warn);
    ok(`${label} does not put that warning in a dialog`,
      !/confirm\(|Alert\.alert\(/.test(before),
      'a dialog cannot carry the note field');
    // THE TWO BUTTONS ARE NOT STACKED. "Keep it" was full width directly
    // under a "Cancel it" welded to the input, a few pixels apart — two
    // full-width targets, one of which ends a round.
    ok(`${label} keeps the two actions apart`,
      /cancelActions|justify-between/.test(src),
      'a destructive action must not sit flush against the safe one');
    // A note the server could not store is a reason the other side will never
    // read; saying "Cancelled." alone reads as though it went.
    ok(`${label} says when the note did not save`,
      /note_saved === false/.test(src));
  }
}

console.log('');
if (failures) {
  console.log(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('all checks passed — the detail view accounts for every output');
