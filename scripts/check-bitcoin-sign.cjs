// The Bitcoin sign is DRAWN, in both clients, from the same paths — and the
// web never types the character.
//
// U+20BF only reached Unicode in 2017, so a font that predates it shows an
// empty box. The phone hit exactly that on Android 6-7 and drew the sign with
// react-native-svg (components/BitcoinSign.tsx). The web did the same
// (components/BitcoinSign.vue) on 2026-11-15, so there are now two copies of one
// drawing, and what quietly goes wrong is the copies drifting apart or somebody
// "simplifying" the drawing back to the character. Neither is a build error, a
// lint error or visible in review.
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
let failures = 0;
const ok = (name, cond, why) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${!cond && why ? ' — ' + why : ''}`);
  if (!cond) failures++;
};
// Comments are stripped first: the components' own notes quote the character,
// which is the trap check:stealth and check:backup both walked into.
const strip = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

const pathsOf = (s) => (s.match(/\sd="([^"]+)"/g) || []).map((m) => m.slice(4, -1)).sort();
const web = read('src/components/BitcoinSign.vue');
const phone = read('src/components/BitcoinSign.tsx');

console.log('the two drawings are one drawing');
ok('the web draws it as SVG paths', /<svg[\s\S]*<path /.test(web));
ok('and from exactly the phone\'s paths',
  JSON.stringify(pathsOf(web)) === JSON.stringify(pathsOf(phone)) && pathsOf(web).length === 4,
  'two copies of one drawing: change both or neither');
ok('and the same viewBox',
  /viewBox="0 0 24 24"/.test(web) && /'0 0 24 24'/.test(phone),
  'the phone narrows the window only when asked to (`tight`); the default is the same square');

console.log('\nnothing types the character');
const offenders = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(vue|js|ts|tsx)$/.test(e.name) && strip(fs.readFileSync(p, 'utf8')).includes('₿')) {
      offenders.push(path.relative(path.join(__dirname, '..'), p));
    }
  }
})(path.join(__dirname, '..', 'src'));
ok('no source file types U+20BF outside a comment', offenders.length === 0, offenders.join(', '));

console.log('\nwhere the web shows it');
const app = strip(read('src/App.vue'));
ok('the Wallet nav item is the sign, in both navs',
  /name: 'wallets'[^}]*icon: 'bitcoin'/.test(app) &&
  (app.match(/item\.icon === 'bitcoin'/g) || []).length === 2);
ok('the nav labels are drawn through BrandText, so BitMail starts with it',
  (app.match(/<BrandText :text="item\.label"/g) || []).length === 2);
const brand = strip(read('src/components/BrandText.vue'));
ok('BrandText swaps only the B of the name, and keeps the rest of the word',
  /BitMail/.test(brand) && /itMail/.test(brand) && /BitcoinSign/.test(brand));
ok('and keeps the sign and the word unbreakable together',
  /\.brand-name\s*\{\s*white-space:\s*nowrap/.test(brand));
const wallets = strip(read('src/views/WalletsView.vue'));
ok('the wallet balance carries the sign, in sats only',
  /v-if="units\.unit === 'sats'"/.test(wallets) && /<BitcoinSign/.test(wallets),
  'beside a dollar figure it would say the wrong thing');
const bm = strip(read('src/views/BitMailView.vue'));
ok('the BitMail page heading is drawn through BrandText',
  /<h1><BrandText text="BitMail" \/><\/h1>/.test(bm));

console.log('\nthe phone draws BitMail the same way');
{
  const bt = strip(read('src/components/BrandText.tsx'));
  ok('BrandText draws the sign inline and keeps the rest of the word',
    /<BitcoinSign[\s\S]*tight/.test(bt) && /BRAND_REST/.test(bt) && /splitBrand\(text\)/.test(bt));
  ok('and gives the wrapper the plain name to read aloud',
    /accessibilityLabel=\{text\}/.test(bt),
    'the drawn B has no letter in it');
  ok('the sign is cropped to its strokes inside a word',
    /tight \? '4\.5 0 16 24'/.test(strip(phone)),
    'the full square leaves "B itMail"');
  const uses = {
    'src/components/BitMailCard.tsx': ['text="BitMail (BIP-353)"', 'text="Request BitMail"'],
    'src/screens/WalletScreen.tsx': ['text="⚠ BitMail tampering detected"', 'text={copied ?'],
    'src/screens/SendScreen.tsx': ['text={`Detected: ${KIND_LABEL[rKind]}`}'],
  };
  for (const [file, needles] of Object.entries(uses)) {
    const src = strip(read(file));
    ok(`${file.split('/').pop()} shows the name through BrandText`,
      /import BrandText from/.test(src) && needles.every((n) => src.includes(n)));
  }
}

console.log('\nthe split rule, run');
const finish = (code) => process.exit(code);
import('../src/services/brandText.ts').then(({ splitBrand }) => {
  const rebuild = (parts) => parts.map((p) => ('name' in p ? 'BitMail' : p.t)).join('');
  const cases = ['Request BitMail', 'BitMail Requests', 'No name here', 'BitMail and BitMail', '⚠ BitMail tampering detected', 'Detected: BitMail', ''];
  ok('every string is reproduced exactly, with the name standing where it was',
    cases.every((c) => rebuild(splitBrand(c)) === c));
  ok('only the name is replaced', splitBrand('Request BitMail').length === 2 &&
    splitBrand('Request BitMail')[1].name === true && splitBrand('Request BitMail')[0].t === 'Request ');
  ok('two names are two replacements', splitBrand('BitMail and BitMail').filter((p) => p.name).length === 2);
  ok('a string without it is untouched', splitBrand('No name here').length === 1 && !('name' in splitBrand('No name here')[0]));
  ok('and it is case-sensitive, like the name', !splitBrand('bitmail').some((p) => p.name));
  ok('an empty string gives no parts', splitBrand('').length === 0);
  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed — one drawing, never typed, and BitMail starts with it');
  finish(failures ? 1 : 0);
}).catch((e) => { console.log('  FAIL could not load services/brandText.ts — ' + e.message); finish(1); });
