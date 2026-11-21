// check:spuri — the Silent Payments key in a BitMail record is the address's own
// HRP (BIP-321), reading accepts both, and nothing parses the URI with replace().
//
// Reported 2026-11-21: Sparrow on signet could not pay a WhiSPa BitMail. It looks
// for `tsp=`; we published `sp=` on every network. `'bitcoin:?tsp=tsp1…'
// .replace('sp=','')` is also not an address, which is how a parser that "works"
// on mainnet breaks the moment the key changes.
import fs from 'node:fs';
import path from 'node:path';
import { spFromUri } from '../src/services/spUri.ts';
import { parseScannedAddress } from '../src/services/addressUri.ts';

let bad = 0;
const ok = (name, cond, extra) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`);
  if (!cond) { bad++; if (extra) console.log('     ' + extra); }
};

const MAIN = 'sp1qqgste7k9hx0qftg6qmwlkqtwuy6cycyavzmzj85c6qdfhjdpdjtdgqjuexzk6murw56suy3e0rd2cgqvycxttddwsvgxe2usfpxumr70xc9pkqwv';
const SIG = 't' + MAIN;

ok('mainnet record reads', spFromUri(`bitcoin:?sp=${MAIN}`) === MAIN);
ok('signet record (tsp=) reads', spFromUri(`bitcoin:?tsp=${SIG}`) === SIG);
ok('a record published before the change (sp=tsp1…) still reads', spFromUri(`bitcoin:?sp=${SIG}`) === SIG);
ok('a bare address passes through', spFromUri(SIG) === SIG);
ok('case does not matter', spFromUri(`BITCOIN:?TSP=${SIG}`) === SIG);
ok('no SP instruction yields nothing', spFromUri('bitcoin:?lno=lno1x') === '' && spFromUri('bitcoin:bc1qxyz') === '' && spFromUri('') === '' && spFromUri(null) === '');
ok('a garbage value is not an address', spFromUri('bitcoin:?sp=hello') === '');
ok('two instructions is ambiguous and refused', spFromUri(`bitcoin:?sp=${MAIN}&tsp=${SIG}`) === '');
ok('a fallback address and other parameters are ignored', spFromUri(`bitcoin:bc1qxyz?label=a&tsp=${SIG}`) === SIG);
ok('a scanned signet URI gives the address', parseScannedAddress(`bitcoin:?tsp=${SIG}`) === SIG);
ok('a scanned mainnet URI still does', parseScannedAddress(`bitcoin:?sp=${MAIN}`) === MAIN);

// Nothing may go back to parsing by replace. Comments are stripped first: the
// ones explaining this quote the bug.
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const offenders = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(ts|tsx|js|vue)$/.test(e.name)) {
      if (/\.replace\(\s*['"`](?:bitcoin:\?)?t?sp=/.test(strip(fs.readFileSync(p, 'utf8')))) offenders.push(p);
    }
  }
})('src');
ok('no source file parses the URI with replace()', offenders.length === 0, offenders.join(', '));

// Every site that reads a resolve result goes through spFromUri.
for (const [f, what] of [
  ['src/services/api.ts', 'spFromResolve'],
  ['src/api/index.js', 'spFromResolve'],
  ['src/stores/bitmailpins.js', 'the pin store'],
  ['src/views/Bip353View.vue', 'Bip353View'],
  ['src/views/BitMailView.vue', 'BitMailView'],
]) ok(`${what} uses spFromUri`, /spFromUri\(/.test(strip(fs.readFileSync(f, 'utf8'))));

process.exit(bad ? 1 : 0);
