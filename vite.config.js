import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

// Inject a Content-Security-Policy meta tag ONLY in the production build, so
// Vite's dev server (which needs inline scripts/eval for HMR) isn't broken by it.
// The authoritative CSP is also set as a Caddy response header (see CSP-notes.md);
// this meta tag is a baseline that travels with the built index.html.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd())
  const lnbitsUrl = env.VITE_LNBITS_URL || 'http://localhost:5000'

  // DIAGNOSTIC: print what Vite actually resolved for the backend URL at build
  // time, so a mis-set env is obvious in the build log.
  console.log(`[whispa build] mode=${mode}  VITE_LNBITS_URL=${JSON.stringify(env.VITE_LNBITS_URL)}  VITE_NETWORK_LOCK=${JSON.stringify(env.VITE_NETWORK_LOCK)}`)

  // connect-src must allow the backend origin. For web builds the API is
  // same-origin (Caddy proxies /api on the same host) so 'self' suffices. For
  // the packaged APK, VITE_LNBITS_URL is an absolute cross-origin host
  // (https://lnbits.whispawallet.com), so it must be added to connect-src or the
  // WebView's CSP blocks every backend request. Derive the origin + wss variant.
  let connectSrc = "'self'"
  const absUrl = env.VITE_LNBITS_URL || ''
  if (/^https?:\/\//i.test(absUrl)) {
    try {
      const u = new URL(absUrl)
      const wss = (u.protocol === 'https:' ? 'wss://' : 'ws://') + u.host
      connectSrc = `'self' ${u.origin} ${wss}`
    } catch (_) { /* leave as 'self' */ }
  }

  // The sign-up form's bot check loads a script from Cloudflare and renders its
  // challenge in an iframe, so BOTH script-src and frame-src have to name that
  // origin. Allowed unconditionally rather than only when Turnstile is on,
  // because whether it is on is a backend setting an operator can flip from the
  // admin page at any time — the build cannot know, and a policy that needed a
  // rebuild to match would make key rotation a deploy.
  //
  // WHAT HAPPENS WITHOUT IT, because it happened (2026-10-21): the widget never
  // renders, the console says the script was refused, and NOTHING on the page
  // points at the policy — it looks like the keys are wrong. frame-src is the
  // half that gets missed, because fixing script-src alone loads the script and
  // still leaves an empty box.
  const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com'

  const CSP = [
    "default-src 'self'",
    `script-src 'self' ${TURNSTILE_ORIGIN}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    `connect-src ${connectSrc}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    `frame-src ${TURNSTILE_ORIGIN}`,
  ].join('; ')

  function cspMetaPlugin() {
    return {
      name: 'inject-csp-meta',
      apply: 'build',
      transformIndexHtml(html) {
        return html.replace(
          '</title>',
          `</title>\n  <meta http-equiv="Content-Security-Policy" content="${CSP}" />`
        )
      },
    }
  }

  return {
    plugins: [vue(), cspMetaPlugin()],
    resolve: { alias: { '@': resolve(__dirname, 'src') } },
    // Don't emit Vite's inline module-preload polyfill: it's an inline <script>
    // that our strict CSP (script-src 'self', no unsafe-inline) blocks. Modern
    // browsers support <link rel="modulepreload"> natively, so it isn't needed.
    build: {
      modulePreload: { polyfill: false },
    },
    server: {
      proxy: {
        '/api':   { target: lnbitsUrl, changeOrigin: true },
        '/siLNt': { target: lnbitsUrl, changeOrigin: true },
      }
    }
  }
})
