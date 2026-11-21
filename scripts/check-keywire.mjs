#!/usr/bin/env node
// check:keywire — signing happens on the device, and the spend key stays there.
//
// Added 2026-11-21, asked as *"check that when we sign the tnx in the web app we
// are not sending spend keys to the server.. also for mobile"*.
//
// THE ANSWER AT THE TIME: neither client sends one. Both build and sign on the
// device and the wire carries outpoints, public scripts, a signed hex and
// signatures. What the audit also found is that nothing PINNED that. Both api
// modules still contain three functions that serialise a private key —
// `buildTx` (`spend_key`), `buildPlainSpend` (`keys`, the BIP-84 chain's
// private keys) and `recoverWalletKeys` (an encrypted mnemonic and the
// passphrase) — and the backend still accepts all three for older builds. Only
// the last had a guard (`check:seed`). So the first caller anybody added to
// `buildTx`, or to `buildPlainSpend`, would have put a spend key on the wire
// with every other check green: a signed transaction still comes out the other
// end, which is exactly why nothing notices.
//
// Three things are checked and each fails a different way:
//
//   1. WIRE. The real api modules are loaded and every function a send, a
//      swap, a Tango round or a wallet create goes through is called against a
//      capturing fetch — with sentinel secrets planted where a careless caller
//      could pass them (a coin object carrying `priv_key_tweak`, a `meta`
//      carrying a key). The body must hold none. A control calls the legacy
//      function the same way and requires the sentinel to APPEAR, so a capture
//      that sees nothing cannot pass for a clean wire.
//   2. CALLERS. No file but the api modules mentions a function that sends a
//      key. This is what makes "deprecated, nothing calls it" a property of the
//      tree instead of a comment.
//   3. CALL SITES. The object literals handed to the Tango, PayJoin and wallet
//      create calls name no key. Those bodies are built in the views, which
//      the wire test cannot reach.
//
// Not covered, on purpose: the SCAN key. It goes to the server in scan,
// preview and background-scan calls and that is by design — it detects
// payments, it cannot spend them. `ALLOWED_SCAN` names exactly which functions
// may send it, so a new one has to be decided rather than drift in.
//
// Comments are stripped before any source assertion: this file's own prose,
// like the api modules', names every field it looks for (the trap
// check:stealth hit with DONT_KILL_APP).

import { readFileSync, writeFileSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

let failed = 0;
function ok(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}`);
    if (detail) console.log(`         ${detail}`);
  }
}
const strip = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
const root = new URL('../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');
const abs = (rel) => new URL(rel, root).pathname;

function walk(dir, out = []) {
  for (const name of readdirSync(abs(dir))) {
    const p = `${dir}/${name}`;
    if (statSync(abs(p)).isDirectory()) walk(p, out);
    else if (/\.(js|ts|tsx|vue)$/.test(name)) out.push(p);
  }
  return out;
}

// Functions that serialise a private key, in both api modules. Adding to this
// list is the deliberate act that admits another.
const KEY_SENDERS = ['buildTx', 'buildPlainSpend', 'recoverWalletKeys'];
// Functions that may send the SCAN key (can detect, cannot spend).
const ALLOWED_SCAN = new Set([
  'startScan', 'enableBackgroundScan', 'previewWalletAddress',
]);
// What a field must look like to count as private key material in a body.
const SECRET_FIELD = /\b(spend_key|spendKey|mnemonic|passphrase|xprv|sweepAccount|sweep_account|priv_key_tweak|privKey|private_key|wif|keys\s*:)\b/;

const API_FILES = ['src/api/index.js', 'src/services/api.ts'];

// ── load the real modules ───────────────────────────────────────────────────
// The two modules reach for things Node does not have (`import.meta.env`, the
// RN config module, the theme). Each is replaced by a stub in a COPY written to
// a temp directory; nothing else in the file is touched, so what is exercised is
// the real request-building code.
const tmp = mkdtempSync(join(tmpdir(), 'keywire-'));
const stubs = join(tmp, 'stubs.mjs');
writeFileSync(stubs, `
export const DEVICE_TRUST_ENABLED = false;
export const currentDeviceId = async () => null;
export default { LNBITS_URL: '', SILNT_PREFIX: '/siLNt', NETWORK_LOCK: 'signet' };
`);
const spUri = pathToFileURL(abs('src/services/spUri.ts')).href;

let captured = [];
globalThis.fetch = async (url, init = {}) => {
  captured.push({ url: String(url), body: init.body == null ? '' : String(init.body) });
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
};
const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
globalThis.localStorage = mem();
globalThis.sessionStorage = mem();

async function load(rel, ext) {
  let src = read(rel);
  src = src
    .replace(/import\.meta\.env/g, '({})')
    .replace(/import Config from 'react-native-config';/, `import Config from '${pathToFileURL(stubs).href}';`)
    .replace(/import \{ DEVICE_TRUST_ENABLED \} from '@\/theme';/, `import { DEVICE_TRUST_ENABLED } from '${pathToFileURL(stubs).href}';`)
    .replace(/import \{ currentDeviceId \} from '\.\/deviceTrust';/, `import { currentDeviceId } from '${pathToFileURL(stubs).href}';`)
    .replace(/from '@\/services\/spUri'/, `from '${spUri}'`)
    .replace(/from '\.\/spUri'/, `from '${spUri}'`);
  const file = join(tmp, rel.replace(/[\\/]/g, '_').replace(/\.(js|ts)$/, '') + ext);
  writeFileSync(file, src);
  return import(pathToFileURL(file).href);
}

// Sentinels. Distinct and recognisable, so a hit names its own source.
const SPEND = 'SENTINEL_SPEND_KEY_0123456789abcdef';
const TWEAK = 'SENTINEL_PRIV_KEY_TWEAK_fedcba9876';
const PHRASE = 'SENTINEL seed phrase words go here';
const PASS = 'SENTINEL_WALLET_PASSPHRASE';
const SENTINELS = [SPEND, TWEAK, PHRASE, PASS];
const leaks = (body) => SENTINELS.filter((s) => body.includes(s));

// A coin as the screens hold it: outpoint, amount and the per-coin tweak, which
// is private. A careless `utxos` argument would carry the lot.
const coin = { txid: 'aa'.repeat(32), vout: 0, amount: 1000, pub_key: 'bb'.repeat(32), priv_key_tweak: TWEAK, spend_key: SPEND };

async function wire(mod, name, args) {
  captured = [];
  await mod[name](...args);
  return captured.map((c) => c.body).join('\n');
}

async function exercise(label, mod, shape) {
  console.log(`\n${label}: the live signing path sends no key`);
  const poisoned = { recipient: 'x', amount: 1, fee: 1, spend_key: SPEND, mnemonic: PHRASE };
  const live = {
    prepareTx: shape.prepareTx(),
    broadcastTx: ['adm', 'ab'.repeat(40), 'wid', [{ txid: coin.txid, vout: 0 }], poisoned],
    preparePlainSpend: ['adm', 'wid', ['bc1qaddr'], 'bc1qdest', 1000, 'bc1qchange', 2],
    broadcastPlainTx: ['adm', 'wid', 'ab'.repeat(40), 1000],
    createSilntWallet: ['ink', { title: 't', sp_address: 'tsp1x', last_height: 1 }],
  };
  for (const [name, args] of Object.entries(live)) {
    const body = await wire(mod, name, args);
    ok(`${name} puts no key material on the wire`, leaks(body).length === 0,
      `body contained ${leaks(body).join(', ')}: ${body.slice(0, 200)}`);
  }
  // prepareTx is the one that takes coin OBJECTS: it must reduce them to
  // outpoints itself rather than trust the caller to have.
  const prep = await wire(mod, 'prepareTx', live.prepareTx);
  const parsed = JSON.parse(prep);
  ok('prepareTx reduces a coin to its outpoint',
    parsed.utxos.every((u) => Object.keys(u).sort().join() === 'txid,vout'),
    prep.slice(0, 200));
  // scan key: allowed, but only here.
  captured = [];
  await mod.startScan('ink', 'wid', 'SCAN_SECRET_VALUE', 1, 2);
  ok('control: the scan key does appear in a scan request (allowed by design)',
    captured.some((c) => c.body.includes('SCAN_SECRET_VALUE')));
  // CONTROL — the capture must be able to see a leak, or all of the above is
  // a test of nothing.
  const bad = await wire(mod, 'buildTx', shape.buildTx());
  ok('control: the legacy buildTx DOES put the spend key on the wire',
    bad.includes(SPEND), 'if this fails the capture is blind and the checks above prove nothing');
  const badPlain = await wire(mod, 'buildPlainSpend', ['adm', 'wid', ['PLAINKEY'], 'd', 1, 'c', 1]);
  ok('control: the legacy buildPlainSpend DOES send keys', badPlain.includes('PLAINKEY'));
}

const webMod = await load('src/api/index.js', '.mjs');
await exercise('web', webMod, {
  prepareTx: () => ['adm', { walletId: 'wid', recipient: 'r', amount: 1, feeRate: 1, utxos: [coin] }],
  buildTx: () => ['adm', { wallet_id: 'wid', recipient: 'r', amount: 1, fee_rate: 1, utxos: [coin] }, SPEND, 'scan'],
});
const phoneMod = await load('src/services/api.ts', '.ts');
await exercise('phone', phoneMod, {
  prepareTx: () => ['adm', { walletId: 'wid', recipient: 'r', amount: 1, feeRate: 1, utxos: [coin] }],
  buildTx: () => ['adm', { wallet_id: 'wid', recipient: 'r', amount: 1, fee_rate: 1, utxos: [coin] }, SPEND, 'scan'],
});

// ── 2. nothing calls a function that sends a key ────────────────────────────
console.log('\ncallers: the key-sending functions are defined and never used');
const files = ['src', 'scripts'].flatMap((d) => walk(d)).filter((f) => !API_FILES.includes(f) && !/check-keywire/.test(f));
for (const fn of KEY_SENDERS) {
  const hits = files.filter((f) => new RegExp(`\\b${fn}\\s*\\(`).test(strip(read(f))));
  ok(`nothing outside the api modules calls ${fn}`, hits.length === 0,
    hits.join(', ') + ' — this would send a private key; derive and sign on the device');
}
// and inside the api modules, nothing calls one from another function
for (const f of API_FILES) {
  const body = strip(read(f));
  for (const fn of KEY_SENDERS) {
    const defs = (body.match(new RegExp(`function\\s+${fn}\\b`, 'g')) || []).length;
    const uses = (body.match(new RegExp(`\\b${fn}\\s*\\(`, 'g')) || []).length;
    ok(`${f}: ${fn} is not called from inside the module`, uses <= defs,
      `${uses} call-shaped mentions for ${defs} definition(s)`);
  }
}

// ── 2b. only the named functions put a key in a request ─────────────────────
console.log('\napi modules: a request body names a key only in the legacy functions');
for (const f of API_FILES) {
  const body = strip(read(f));
  const parts = body.split(/\n(?=export (?:async )?function )/);
  const offenders = [];
  for (const part of parts) {
    const name = (part.match(/^export (?:async )?function\s+(\w+)/) || [])[1];
    if (!name || KEY_SENDERS.includes(name)) continue;
    // Only what is SENT: the object inside JSON.stringify( … ).
    const sent = [...part.matchAll(/JSON\.stringify\(([\s\S]*?)\)\s*,?\s*\n?\s*\}\)/g)].map((m) => m[1]).join('\n');
    if (SECRET_FIELD.test(sent)) offenders.push(name);
    if (/\bscan_secret\b/.test(sent) && !ALLOWED_SCAN.has(name)) offenders.push(`${name} (scan key)`);
  }
  ok(`${f}: no other function serialises a private key`, offenders.length === 0, offenders.join(', '));
}

// ── 3. the bodies the views build ───────────────────────────────────────────
console.log('\ncall sites: the objects handed to the server name no key');
function argsOf(src, callee) {
  const out = [];
  let i = 0;
  while ((i = src.indexOf(callee + '(', i)) !== -1) {
    let depth = 0, j = i + callee.length;
    for (; j < src.length; j++) {
      if (src[j] === '(') depth++;
      else if (src[j] === ')' && --depth === 0) break;
    }
    out.push(src.slice(i, j + 1));
    i = j;
  }
  return out;
}
const SITES = [
  ['src/views/TangoView.vue', ['api.tangoPropose', 'api.tangoAccept', 'api.tangoSign']],
  ['src/screens/TangoScreen.tsx', ['api.proposeTango', 'api.acceptTango', 'api.signTango']],
  ['src/views/PayJoinView.vue', ['api.payjoinCreateInvoice', 'api.payjoinPayInvoice', 'api.payjoinSign']],
  ['src/views/SendView.vue', ['api.prepareTx', 'api.broadcastTx', 'api.preparePlainSpend', 'api.broadcastPlainTx']],
  ['src/screens/SendScreen.tsx', ['api.prepareTx', 'api.broadcastTx', 'api.preparePlainSpend', 'api.broadcastPlainTx']],
  ['src/views/WalletsView.vue', ['api.createSilntWallet']],
  ['src/components/CreateWalletModal.tsx', ['api.createSilntWallet']],
];
for (const [file, callees] of SITES) {
  const src = strip(read(file));
  for (const callee of callees) {
    const calls = argsOf(src, callee);
    if (!calls.length) continue; // a surface may not use every call
    const bad = calls.filter((c) => SECRET_FIELD.test(c) || /\bscanSecret\b|\bscan_secret\b/.test(c));
    ok(`${file}: ${callee} is handed no key`, bad.length === 0, bad.map((c) => c.slice(0, 160)).join(' | '));
  }
}
// The create payload of the web is pinned to its exact shape by check:seed;
// this adds the phone's, which that check does not read.
{
  const modal = strip(read('src/components/CreateWalletModal.tsx'));
  ok('the phone creates a wallet from an address and a title',
    /\{ title: title\.trim\(\), sp_address: keys\.spAddress \}/.test(modal));
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall key-wire checks passed');
process.exit(failed ? 1 : 0);
