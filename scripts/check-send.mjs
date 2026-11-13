#!/usr/bin/env node
// check:send — four things about the Send page and the Tango banner that each
// broke in a way nothing else could see (all reported 2026-11-13).
//
//  1. A BitMail typed on the SEGWIT side must become an address BEFORE
//     /plain/prepare and the builder see it. They took the raw `name@domain`
//     and refused it as an invalid bech32 address, while the same BitMail
//     worked from Silent Payments (whose /tx/prepare resolves it). Both clients.
//  2. A half-built Send must survive leaving the page — in memory only.
//  3. A Tango connection request must be visible from any page, not only as a
//     badge on a tab inside the Tango page.
//  4. The BitMail "resolve an address" card is last on its page.
//  5. The Send page builds SEVERAL transactions at once, in tabs, and a coin one
//     tab holds is not offered by another (reported 2026-11-13).
//
// These were all driven in Chromium against the built app when they were fixed
// (stubbed backend, real router, real views); this is the part of that which
// can be kept as a source-side tripwire. Comments are stripped before any
// assertion — the trap check:stealth and check:backup both documented.

import { readFileSync } from 'node:fs';

let failed = 0;
function ok(name, cond, detail) {
  if (cond) console.log(`  ok   ${name}`);
  else { failed++; console.log(`  FAIL ${name}`); if (detail) console.log(`         ${detail}`); }
}
const strip = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/[^\n]*/g, '');
const read = (rel) => strip(readFileSync(new URL('../' + rel, import.meta.url), 'utf8'));
const fnBody = (src, startMarker) => {
  const at = src.indexOf(startMarker);
  return at < 0 ? '' : src.slice(at, at + 6000);
};

console.log('a BitMail is resolved before the SegWit builder sees it');
for (const [who, file, marker] of [
  ['the web', 'src/views/SendView.vue', 'async function buildSegwitTransaction'],
  ['the phone', 'src/screens/SendScreen.tsx', 'const buildSegwit = useCallback'],
]) {
  const body = fnBody(read(file), marker);
  const resolveAt = body.indexOf('resolveBip353');
  const prepareAt = body.indexOf('preparePlainSpend');
  ok(`${who} resolves an "@" recipient`,
    /includes\('@'\)/.test(body) && resolveAt > -1);
  ok(`${who} resolves it BEFORE /plain/prepare`,
    resolveAt > -1 && prepareAt > resolveAt,
    'prepare takes an address, not a BitMail');
  ok(`${who} passes the resolved destination to the prepare and the builder`,
    /preparePlainSpend\([\s\S]{0,200}\bdestination,/.test(body) &&
      /buildSignedPlainTx\(\{\s*destination,/.test(body),
    'the raw recipient text must not reach either');
}

console.log('a half-built Send survives leaving the page, in memory only');
{
  const store = read('src/stores/senddraft.js');
  ok('the draft store never touches web storage',
    !/localStorage|sessionStorage|indexedDB/.test(store),
    'which coins and who to pay is not something to leave in a profile');
  ok('and does not keep the built transaction',
    !/tx_hex|txResult|segwitBuilt/.test(store));
  const sv = read('src/views/SendView.vue');
  ok('SendView restores after the wallet settles and saves only once it has',
    /await nextTick\(\)\s*await restoreDraft\(\)/.test(sv) && /draftReady = true/.test(sv));
  ok('a prefilled link or swap funding wins over a draft',
    /isSwapFunding\.value \|\| route\.query\.address \|\| route\.query\.amount/.test(sv));
  ok('flipping the chain picker does not wipe a restore in progress',
    /if \(restoringDraft\) return/.test(sv));
  ok('a broadcast and Send Another both rewrite it from what is left',
    /watch\(broadcastDone, persistDraft\)/.test(sv) &&
      /function reset\(\)[\s\S]{0,700}persistDraft\(\)/.test(sv),
    'it is a list of tabs now: clearing it would drop the OTHER tabs');
  ok('a tab that has been broadcast is not saved as a draft',
    /filter\(\(t\) => !t\.snap\.broadcastDone\)/.test(sv));
  ok('signing out clears every draft',
    /clearAllSendDrafts\(\)/.test(read('src/stores/auth.js')));
}

console.log('a Tango connection request is visible from any page');
{
  const w = read('src/stores/tangowatch.js');
  ok('the watcher counts incoming requests and announces new ones',
    /export const tangoRequests/.test(w) && /payjoinListContacts/.test(w) &&
      /_knownRequests/.test(w));
  const app = read('src/App.vue');
  ok('the banner links straight to the Partners tab, off the Tango page',
    /tangoRequests > 0 && route\.name !== 'tango'/.test(app) &&
      /query: \{ tab: 'connections' \}/.test(app));
  ok('the nav badge counts requests as well as rounds',
    /tangoPending \+ tangoRequests/.test(app));
  const tv = read('src/views/TangoView.vue');
  ok('TangoView opens on Partners for that link',
    /route\.query\.tab === 'connections'/.test(tv));
  ok('and tells the watcher after approving or declining',
    (tv.match(/refreshTangoWatch\(\)/g) || []).length >= 3);
}

console.log('the BitMail resolve card is last');
{
  const b = read('src/views/BitMailView.vue');
  const tpl = b.slice(b.indexOf('<template>'));
  const resolveAt = tpl.indexOf('Resolve Address');
  ok('it comes after the request history',
    resolveAt > tpl.indexOf('Your Request History') && tpl.indexOf('Your Request History') > 0);
  ok('and nothing with a card follows it but its own result',
    (tpl.slice(resolveAt).match(/class="card"/g) || []).length === 1,
    'the result card is the one that belongs to it');
}

console.log('the Send page builds several transactions at once, and a coin is in one');
{
  const sv = read('src/views/SendView.vue');
  const store = read('src/stores/senddraft.js');
  ok('the hold is DERIVED from the other tabs, never stored',
    /const reservedSp = computed\(/.test(sv) && /const reservedSegwit = computed\(/.test(sv) &&
      /otherTabs\.value/.test(sv),
    'a stored hold can leak; a derived one is released by the tab closing');
  ok('the lists, the totals and the selection all read what is AVAILABLE here',
    /v-for="u in availableUtxos"/.test(sv) && /v-for="t in availableSegwit"/.test(sv) &&
      /availableUtxos\.value\.reduce/.test(sv) && /availableSegwit\.value\.reduce/.test(sv) &&
      /const selectedUtxos = computed\(\(\) =>\s*availableUtxos/.test(sv));
  ok('a broadcast tab keeps its hold',
    !/reservedSp[\s\S]{0,300}broadcastDone/.test(sv),
    'the chain index can lag the mempool');
  ok('results go onto the form AFTER a tick, inputs before it',
    /await nextTick\(\)\s*txResult\.value = s\.txResult/.test(sv),
    'the form is full of watchers that clear a build when an input moves');
  ok('the chain picker keeps a tab that has something in it',
    /if \(tabHasContent\.value\) return newTab\(s\)/.test(sv),
    'flipping it used to wipe the build');
  ok('no switching while a build or broadcast is running',
    /const tabsLocked = computed\(\(\) => tabBusy\.value \|\| building\.value \|\| broadcasting\.value\)/.test(sv) &&
      /if \(id === activeTabId\.value \|\| tabsLocked\.value\) return/.test(sv),
    'a result lands on whatever the form holds when it finishes');
  ok('a second SegWit build steps past a change address another tab uses',
    /taken\.has\(changeAddress\)/.test(sv) && /nextReceiveAddress\(/.test(sv));
  ok('a swap funding stays a single transaction',
    /v-if="!isSwapFunding" class="tx-tabs"/.test(sv) && /isSwapFunding\.value\) return/.test(sv));
  ok('the draft keeps every tab and still no built transaction',
    /tabs: tabs\.map/.test(store) && !/tx_hex|txResult|segwitBuilt/.test(store));
  ok('a tab button states its own text colour',
    /\.tx-tab-main[^{]*\{[^}]*color: var\(--text/.test(read('src/views/SendView.vue')) ||
      /\.tx-tab-main, \.tx-tab-close, \.tx-tab-new \{[^}]*color: var\(--text/.test(readFileSync(new URL('../src/views/SendView.vue', import.meta.url), 'utf8')),
    'a <button> defaults to buttontext, black on a dark card');
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed — Send resolves a BitMail on both sides, keeps a draft, builds several transactions in tabs, and a Tango request shows from anywhere');
process.exit(failed ? 1 : 0);
