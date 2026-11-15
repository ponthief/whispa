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
ok('and the same viewBox', /viewBox="0 0 24 24"/.test(web) && /viewBox="0 0 24 24"/.test(phone));

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

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed — one drawing, never typed, and BitMail starts with it');
process.exit(failures ? 1 : 0);
