// The admin card for whispa-matcher, held to the four things that go wrong quietly.
//
//  * The token is WRITE-ONLY: a password input, a `token_set` flag, and never a
//    value read back from the server into the field.
//  * It lives beside Fulcrum and BlindBit, polled and cleaned up with them (a
//    timer that is not cleared outlives the page).
//  * Off, Shadow and Active are ONE choice, not a switch plus a mode: a switch
//    left on over the wrong mode is how a service meant to be compared against
//    ends up deciding what is stored.
//  * A down matcher says that scans still work. A red card read as "payments
//    are missing" is a support ticket, and it is not true.
const fs = require('fs')
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/<!--[\s\S]*?-->/g, '')
const view = strip(fs.readFileSync('src/views/AdminView.vue', 'utf8'))
const api = strip(fs.readFileSync('src/api/index.js', 'utf8'))
let bad = 0
const need = (ok, msg) => { if (!ok) { bad++; console.error('  FAIL ' + msg) } else console.log('  ok   ' + msg) }

for (const [fn, url] of [['getMatcherConfig', '/api/v1/admin/matcher/config'], ['updateMatcherConfig', '/api/v1/admin/matcher/config'],
                         ['forgetMatcherConfig', '/api/v1/admin/matcher/config'], ['getMatcherHealth', '/api/v1/admin/matcher/health']]) {
  need(new RegExp('export async function ' + fn + '\\b[\\s\\S]{0,200}' + url.replace(/\//g, '\\/')).test(api), `api.${fn} calls ${url}`)
}
need(/type="password"[^>]*v-model="matcher\.token"/.test(view) || /v-model="matcher\.token"[^>]*type="password"|type="password"\s+v-model="matcher\.token"/.test(view),
     'the token input is a password field')
need(!/matcher\.value\.token\s*=\s*c\.token\b/.test(view) && !/matcher\.value\.token\s*=\s*res\.token\b/.test(view),
     'the token is never copied from the server into the field')
need(/matcher\.value\.token\s*=\s*''/.test(view), 'the token field is emptied after a load or save')
need(/c\.token_set/.test(view), 'the page learns token_set')
need(/<select[^>]*v-model="matcher\.state"/.test(view) && /value="off"/.test(view) && /value="shadow"/.test(view) && /value="active"/.test(view),
     'off / shadow / active is one select')
need(/enabled:\s*matcher\.value\.state !== 'off'/.test(view) && /mode:\s*matcher\.value\.state === 'active' \? 'active' : 'shadow'/.test(view),
     'enabled and mode both come from that one choice')
need(/setInterval\(checkMatcherHealth/.test(view) && /clearInterval\(mhealthTimer\)/.test(view), 'the status poll is cleared on unmount')
need(/checkMatcherHealth\(\)\s*\n\s*mhealthTimer/.test(view), 'it is checked as soon as the page opens')
need(/nothing missed/.test(view) && /matching in-process meanwhile/.test(view), 'a down or refused matcher says scans still work')
need(/mhealth\.enabled && !mhealth\.ok/.test(view), 'it is red only when it is switched on')
need(/Use environment settings/.test(view) && /forgetMatcher/.test(view), 'there is a way back to the environment settings')
need(view.indexOf('Rust matcher (scanning)') > view.indexOf('Fulcrum (PayJoin)') && view.indexOf('Rust matcher (scanning)') < view.indexOf('<h2>Connections</h2>'),
     'the card sits after Fulcrum and before the Connections form, on the Infra page')
if (bad) { console.error(`\n${bad} check(s) failed`); process.exit(1) }
console.log('\nall checks passed — the matcher card keeps its token write-only and its states honest')
