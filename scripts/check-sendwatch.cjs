// check:sendwatch — the send watcher polls only what this account sent.
//
// Reported 2026-11-21: after switching accounts in one browser mid-send, the
// server log filled with 403s for the first account's transaction. pendingSends
// is browser-wide, the poll uses the CURRENT account's key, and the server
// (rightly) refuses a wallet that is not the caller's. Comments are stripped
// first, as in the other source checks.
const fs = require('fs')
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
const read = (f) => strip(fs.readFileSync(f, 'utf8'))
let bad = 0
const ok = (n, c) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${n}`); if (!c) bad++ }

const store = read('src/stores/pendingsends.js')
const app = read('src/App.vue')
const send = read('src/views/SendView.vue')

ok('an entry records who sent it', /owner/.test(store) && /owner: owner \|\| null/.test(store))
ok('both Send call sites pass the account', (send.match(/addPendingSend\([\s\S]*?auth\.username/g) || []).length === 2)
ok('the poll skips another account\'s entries', /s\.owner === auth\.username/.test(app))
ok('an entry with no owner is tried, and a 403 stops it', /e\.status === 403/.test(app) && /notMine\.add\(/.test(app))
ok('the refusal memory is per account, not per page', /notMine\.has\(`\$\{auth\.username\}:/.test(app))
process.exit(bad ? 1 : 0)
