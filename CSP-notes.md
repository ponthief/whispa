# Content Security Policy for Thrilla (signet.mydomain.net)

Two layers are now in place:

1. **`<meta http-equiv="Content-Security-Policy">`** in `index.html` — a baseline
   that travels with the app even if the server header is missing. It is built
   from the `CSP` array in `vite.config.js`.
2. **Caddy response header** (below) — the authoritative one. It can set
   `frame-ancestors` (clickjacking protection), which a `<meta>` CSP cannot, and
   it applies before the page parses. Where both exist, the browser enforces the
   intersection (the stricter combination), so they're complementary.

> **The intersection is a trap when you widen the policy.** Adding an origin to
> one layer and not the other changes nothing — the stricter copy still blocks
> it, and the console names the directive without saying which of the two files
> produced it. That cost an afternoon on 2026-10-21, when Turnstile's script was
> added to `vite.config.js` and the deployed Caddy header still said
> `script-src 'self'`. `npm run check:terms` now fails when the two disagree
> about the Turnstile origin. If you add any other external origin, change it in
> **both** places and reload Caddy.

## Add to your Caddy site block

```
signet.mydomain.net {
    # ... existing reverse_proxy + log ...

    header {
        # Content Security Policy — same directives as the meta tag, plus
        # frame-ancestors. Adjust if you add external script/style/connect origins.
        Content-Security-Policy "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-src https://challenges.cloudflare.com; frame-ancestors 'none'"

        # Defense-in-depth companions:
        X-Content-Type-Options "nosniff"
        Referrer-Policy "no-referrer"
        X-Frame-Options "DENY"
        # HSTS — only enable if you're fully committed to HTTPS on this host:
        # Strict-Transport-Security "max-age=31536000; includeSubDomains"
        # Limit powerful browser features:
        Permissions-Policy "geolocation=(), microphone=(), camera=(), payment=()"
    }
}
```

Then: `sudo systemctl reload caddy`

## What the policy allows (and why)

| Directive | Value | Reason |
|-----------|-------|--------|
| `script-src` | `'self' challenges.cloudflare.com` | App JS is bundled, served same-origin. **No `unsafe-inline`** — this is the key XSS defense. The Cloudflare origin is the sign-up form's Turnstile bot check; it loads `turnstile/v0/api.js`. |
| `frame-src` | `challenges.cloudflare.com` | Turnstile renders its challenge in an iframe from that origin. Allowing the script without this loads the code and still shows an empty box — the half that gets missed. |
| `style-src` | `'self' 'unsafe-inline' fonts.googleapis.com` | Google Fonts CSS + Vue scoped/inline styles. `unsafe-inline` here is CSS-only and does NOT weaken script protection. |
| `font-src` | `'self' fonts.gstatic.com` | Google Fonts files. |
| `connect-src` | `'self'` | API is same-origin via the Caddy proxy (`VITE_LNBITS_URL` empty). |
| `img-src` | `'self' data:` | App icons + any inline data-URI images (QR codes). |
| `object-src` | `'none'` | No plugins/embeds. |
| `base-uri` | `'none'` | Blocks `<base>` tag injection (an XSS trick). |
| `frame-ancestors` | `'none'` | Can't be framed → clickjacking protection (header only). |

## If you self-host the fonts (recommended, strongest)

Pulling fonts from Google means `fonts.googleapis.com` / `fonts.gstatic.com` must
be allowed, and you can drop `'unsafe-inline'` from style-src only if you also
inline-hash or self-host. To tighten fully:

1. Download the IBM Plex fonts into the app and serve them `/self`.
2. Remove the two Google origins from `style-src`/`font-src`.
3. That lets you keep `style-src 'self' 'unsafe-inline'` with no external origin —
   or, with build-time CSS hashing, eventually drop `'unsafe-inline'` too.

This removes a third-party dependency from the page entirely (better for both
privacy and supply-chain), at the cost of bundling the font files.

## Verify after deploy

```bash
curl -sI https://signet.mydomain.net | grep -i content-security-policy
```
Open the app, check the browser console for CSP violation reports, and confirm
fonts + API calls still work. Any blocked resource shows a clear console error
naming the directive — adjust only that directive if needed.

## Note on Vite DEV mode

These policies are for the PRODUCTION build (what Caddy serves). Vite's dev server
(`npm run dev`) uses inline scripts + eval for HMR and will trip `script-src 'self'`.
Don't apply the strict CSP to the dev server; it only matters for the deployed
`dist/`. The meta tag is in `index.html`, which Vite serves in dev too — if local
dev breaks, comment the meta tag out locally, or guard it so it's only emitted in
the production build.
