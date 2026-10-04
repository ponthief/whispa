// The Send screen's amount slider.
//
//   node scripts/check-send-slider.cjs
//
// It sets an amount of money, so the arithmetic is pinned here rather than
// left to two hand-written implementations agreeing by luck. What the slider
// must NOT do is as much of this as what it must.

import fs from 'node:fs';
import path from 'node:path';
import { register } from 'node:module';

register(new URL('./ts-resolve.mjs', import.meta.url).href);

const ROOT = new URL('..', import.meta.url).pathname;
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let failures = 0;
function ok(name, cond, detail = '') {
  console.log((cond ? '  ok   ' : '  FAIL ') + name);
  if (!cond) {
    if (detail) console.log('         ' + detail);
    failures++;
  }
}

const { sliderMax, sliderTop, fromSlider, toSlider } =
  await import(new URL('../src/services/sendAmount.ts', import.meta.url).href);

console.log('the range never runs past what can actually be sent');
{
  ok('the top is maxSendable', sliderMax(5000) === 5000);
  // A selection whose coins cannot cover their own fee. 0..-200 is not a
  // range, and the control disables itself on 0.
  ok('a negative maxSendable is zero', sliderMax(-200) === 0);
  ok('zero is zero', sliderMax(0) === 0);
  ok('nonsense is zero', sliderMax(undefined) === 0 && sliderMax(NaN) === 0);
  ok('it is a whole number of sats', sliderMax(999.9) === 999);
}

console.log('\nit has a range before any coins are picked');
{
  // WHAT SHIPPED FIRST AND WAS REPORTED AS BROKEN: with nothing selected
  // there is no fee to subtract, maxSendable is 0, and the control showed
  // "0" and "—" to anybody who had just opened Send. A slider that is dead
  // until you have done something else reads as broken, not as conditional.
  ok('an untouched screen can still drag', sliderTop(false, 0, 250000) === 250000);
  ok('and says so rather than showing a dash', sliderTop(false, 0, 250000) > 0);
  // Once coins are picked the fee is knowable, so the range tightens to what
  // those coins can actually send.
  ok('a selection tightens it to what is sendable',
     sliderTop(true, 4800, 250000) === 4800);
  ok('a selection that cannot cover its fee is empty',
     sliderTop(true, -200, 250000) === 0);
  ok('an empty wallet is empty', sliderTop(false, 0, 0) === 0);
}

console.log('\nthe ends are reachable');
{
  ok('hard left is nothing', fromSlider(0, 5000) === 0);
  // THE ONE PEOPLE REACH FOR. Truncating instead of rounding leaves the
  // right-hand end one sat short of everything.
  ok('hard right is everything', fromSlider(1, 5000) === 5000);
  ok('and so is almost-right', fromSlider(0.99999, 5000) === 5000);
  ok('the middle is the middle', fromSlider(0.5, 5000) === 2500);
}

console.log('\nit cannot produce an unsendable amount');
{
  for (const f of [-1, -0.5, 1.5, 99, NaN, undefined]) {
    const got = fromSlider(f, 5000);
    ok(`a fraction of ${f} stays in range`, got >= 0 && got <= 5000, String(got));
  }
  ok('an empty range yields nothing', fromSlider(1, 0) === 0);
  ok('and a negative one too', fromSlider(1, -200) === 0);
}

console.log('\nthe thumb follows the field, which is the authority');
{
  ok('zero sits at the left', toSlider(0, 5000) === 0);
  ok('the maximum sits at the right', toSlider(5000, 5000) === 1);
  ok('half sits in the middle', toSlider(2500, 5000) === 0.5);
  // Reachable by TYPING, and the amount field wins. The thumb pins rather
  // than running off the end.
  ok('a typed overspend pins at the right', toSlider(999999, 5000) === 1);
  ok('a negative pins at the left', toSlider(-5, 5000) === 0);
  ok('an empty range is the left', toSlider(100, 0) === 0);
}

console.log('\nround-tripping does not drift');
{
  let drift = 0;
  for (const sats of [0, 1, 7, 646, 2500, 4999, 5000]) {
    const back = fromSlider(toSlider(sats, 5000), 5000);
    if (back !== sats) drift++;
  }
  ok('every amount survives a round trip', drift === 0, `${drift} drifted`);
}

console.log('\nit changes the amount and nothing else');
{
  // THE RULE THIS SCREEN IS BUILT AROUND. Combining coins links them on
  // chain, and the screen warns about exactly that — so a slider that
  // selected coins to satisfy a number would undo the choice the person came
  // here to make.
  const RN = read('src/components/AmountSlider.tsx');
  const WEB = read('src/views/SendView.vue');
  ok('the phone slider selects no coins',
    !/setSelected|toggleUtxo|selected\.add/.test(RN));
  ok('the phone slider writes only the amount',
    /onChange\(/.test(RN) && !/utxo/i.test(RN));
  const slider = (WEB.match(/<div v-if="!isSwapFunding" class="amt-slider">[\s\S]*?<\/div>\s*<\/div>/) || [''])[0];
  ok('the browser slider is wired to the amount', /amount = /.test(slider), slider.slice(0, 80));
  ok('the browser slider selects no coins',
    !/selected|utxo/i.test(slider));
  // Its maximum has to be the one the screen already shows as "Max sendable",
  // or the control's own end lands in the insufficient-funds error.
  const RNS = read('src/screens/SendScreen.tsx');
  ok('the browser tops out through the shared rule',
     /topOfRange\(selectedUtxos\.value\.length > 0, maxSendable\.value/.test(WEB));
  ok('the phone tops out through the shared rule',
     /sliderTop\(selectedUtxos\.length > 0, maxSendable/.test(RNS));
  // Both have to feed it the SAME two totals, or one of them silently offers
  // a range the other refuses.
  ok('both pass the wallet total as the fallback',
     /spendableTotal/.test(WEB) && /spendableTotal/.test(RNS));
}

console.log('\nno native dependency was added for it');
{
  // @react-native-community/slider would be the first native module in this
  // app that tsc, lint and the web build cannot check — only a real Gradle
  // run can. For one track and one thumb that is the wrong trade.
  const pkg = JSON.parse(read('package.json'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  ok('no slider package', !Object.keys(deps).some((d) => /slider/i.test(d)),
    Object.keys(deps).filter((d) => /slider/i.test(d)).join(', '));
  ok('it is built on PanResponder', /PanResponder/.test(read('src/components/AmountSlider.tsx')));
}

console.log('');
if (failures) {
  console.log(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('all checks passed — the slider sets an amount, and only an amount');
