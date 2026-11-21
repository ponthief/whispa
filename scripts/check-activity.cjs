// check:activity — Activity says the right thing about a transaction it received
// and stops calling a confirmed one pending. Source-side, comments stripped
// first (the trap check:stealth and check:backup both hit).
//
// Reported 2026-11-21 against signet 8ace2165…: the RECEIVER's detail listed a
// "Recipient" with a BitMail label, a taproot address and 982 sats, where 5,482
// had arrived — the SENDER's change, which the server reports because it is not
// one of the receiver's coins, with this browser's label stuck on the first
// output. And a row kept "⌛ Pending" after the detail said Confirmed, because
// the list was read once and the confirmation happens later.
const fs = require('fs')
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
const read = (f) => strip(fs.readFileSync(f, 'utf8'))
let bad = 0
const ok = (name, cond) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`); if (!cond) bad++ }

const web = read('src/views/TransactionsView.vue')
const modal = read('src/components/TxDetailModal.tsx')
const wallet = read('src/screens/WalletScreen.tsx')

ok('web lists Recipients only for a send', /v-if="tx\.kind === 'send' && expandedDetail\.recipients/.test(web))
ok('web still shows Recipients for a send at all', web.includes('Recipients'))
ok('phone modal takes an `incoming` flag', /incoming\s*=\s*false/.test(modal))
ok('phone hides Recipients on a receive', /detail\.recipients\?\.length && !mix && !localSend && !incoming/.test(modal))
ok('phone derives incoming from the row kind', /kind === 'receive'/.test(wallet) && /incoming=\{detailIncoming\}/.test(wallet))

ok('web row badge goes through isPending, not the raw flag', /v-if="isPending\(tx\)"/.test(web) && !/v-if="tx\.confirmed === false"/.test(web))
ok('isPending yields to what the chain detail said', /tx\.confirmed === false && !chainConfirmed\.value\.has\(tx\.txid\)/.test(web))
ok('expanding records a chain-confirmed row', /expandedDetail\.value\.confirmed === true && tx\.confirmed === false/.test(web))
ok('list is re-read when a watched send leaves the watch list', /watch\(pendingSends, \(now, before\)[\s\S]*?reloadQuietly\(\)/.test(web))
ok('list is re-read when a scan of the wallet finishes', /watch\(scanWatchWallets[\s\S]*?reloadQuietly\(\)/.test(web))
ok('the quiet reload does not collapse the open row', !/function reloadQuietly[\s\S]*?expandedTxid\.value = null[\s\S]*?\n}/.test(web.slice(web.indexOf('async function reloadQuietly'), web.indexOf('async function loadTxs'))))

process.exit(bad ? 1 : 0)
