# Closing LNbits' own doors at the proxy

Companion to `CSP-notes.md`, which adds a `header` block to the **same** Caddy
site block. Apply both; don't write two site blocks for one host.

## What this does, and what it deliberately does not

It shuts the parts of LNbits that WhiSPa never calls — above all **core's own
account registration**, which is where ten junk accounts came from on
2026-11-04 (no email address, some with random usernames, no wallets). The
extension's `register-start` cannot produce those: `pending_registrations` has
`email` as its PRIMARY KEY and `confirm_registration` always sets one on the
`Account`. They came in beside it, through a door the extension cannot gate.

**It is not an "only our app" gate, and no proxy config can be one.** The app
ships to users' devices, so anything it sends to prove it is the app — a
header, a user agent, an embedded key, a signed request — is in the APK and in
the web bundle. `device_auth.py::_is_thrilla_request` is the honest version of
that idea: it is `X-Thrilla-Client == "1"`, one header, a filter rather than a
boundary. The same point `helpers/turnstile.py` already makes about `Origin`.

What is already a boundary, and needs nothing here: of 126 siLNt endpoints,
**10** are public. Every other one goes through `require_invoice_key` →
`require_trusted_device`, so it needs a per-wallet API key. That is why the
junk accounts could not reach the extension at all — no wallet, no key.

## The allow-list, and why it is one

The block below allow-lists `/api/v1/auth` rather than naming the doors to
shut. That polarity is the whole point: a deny-list only closes the paths
somebody thought of, so an LNbits upgrade that adds an auth method opens a new
one silently. Here, a new one is closed until somebody adds it on purpose.

Both clients call exactly four core paths. Verified by reading every auth call
in `src/api/index.js` and `src/services/api.ts`:

| Path | Method | Used by |
|---|---|---|
| `/api/v1/auth` | POST | login (`login()`, both clients) |
| `/api/v1/auth` | GET | account info (`getAccount()`, both) |
| `/api/v1/wallets` | GET | wallet list (`getLnbitsWallets()`, both) |
| `/api/v1/auth/reset` | PUT | password reset (web) |

Everything else under `/api/v1/auth/` is closed, which covers core's
`register`, the anonymous `usr` login, and any Nostr or SSO endpoints the build
happens to carry.

Note `path /api/v1/auth/*` does **not** match `/api/v1/auth` itself — Caddy
requires the trailing segment — which is what keeps login and account working
while everything below them is shut.

siLNt's own endpoints live under `/siLNt/api/v1/auth/...`, a different prefix,
so none of this touches registration, device confirmation or password reset in
the app.

## The site block

```caddyfile
whispawallet.com {
	# handle blocks are mutually exclusive and run in written order, so the
	# refusals below cannot be reordered behind the proxy by Caddy's own
	# directive ordering. Do not swap these for bare `respond` directives.

	# ── LNbits core auth: allow-list ────────────────────────────────────
	@core_auth_closed {
		path /api/v1/auth/*
		# BOTH forms. Without the slashed one, `/api/v1/auth/reset/` is
		# refused while `/api/v1/auth/reset` works — found by probing a
		# running Caddy, not by reading this. The clients send the bare
		# form, so it would break only if something ever redirected to
		# the other, which is the kind of outage nobody connects back
		# to a proxy rule.
		not path /api/v1/auth/reset /api/v1/auth/reset/
	}
	handle @core_auth_closed {
		# 404, not 403: a refusal that says "this exists but you may not
		# have it" is a map of the surface. 404 says nothing.
		respond 404
	}

	# ── LNbits core admin and user management ───────────────────────────
	# No WhiSPa client calls any of these. /api/v1/wallets is NOT in this
	# list and must not be — both clients read it after login.
	@core_admin {
		path /api/v1/users* /api/v1/audit* /api/v1/settings*
		path /admin* /users* /node* /extensions* /account*
	}
	handle @core_admin {
		respond 404
	}

	# ── Everything else: the app's own traffic ──────────────────────────
	handle {
		reverse_proxy localhost:5000

		header {
			# ... the CSP and companions from CSP-notes.md go here ...
		}
	}

	log {
		output file /var/log/caddy/whispawallet.access.log
	}
}
```

## This block was run, not just written

Against Caddy 2.8.4 with a stub upstream that answers 200 to everything, so a
404 could only come from Caddy. `caddy validate` passing proves the file
parses and nothing else — the two `path` lines inside `@core_admin` do OR
together, but only a running server says so.

Held at 404: `/api/v1/auth/register`, `/usr`, `/nostr`, `/google/callback`,
`/keycloak`, `/api/v1/users`, `/api/v1/users/abc`, `/api/v1/settings`,
`/admin`, `/admin/users`, `/node`, `/extensions`, `/account`.

Reached the upstream: `POST` and `GET /api/v1/auth`, `GET /api/v1/wallets`,
`PUT /api/v1/auth/reset` (both slash forms), `/siLNt/api/v1/auth/signup-config`,
`/siLNt/api/v1/auth/register-start`, `/siLNt/api/v1/wallet`, and `/`.

Bypass attempts, all held: upper case (`/API/V1/AUTH/REGISTER`), mixed case,
a doubled leading slash, a doubled inner slash, `/./`, `/x/../`, a
percent-encoded letter (`%61uth`), a trailing slash, a query string, and a
trailing `%20`. Caddy normalises the path and matches case-insensitively
before the matcher sees it.

Two results worth keeping because they are not obvious: `/api/v1/auth/resetx`
is still refused, so the `not path` is an exact match rather than a prefix and
does not widen the hole; and `/api/v1/auth/reset/../register` normalises to
the register path and is refused.

## Check it before and after, against the running instance

Blocking by reasoning about the clients is how you break login at 2am. Probe
the doors — none of these creates anything:

```bash
H=https://whispawallet.com

# MUST be closed (expect 404 after, something else before):
for p in /api/v1/auth/register /api/v1/auth/usr /api/v1/auth/nostr; do
  printf '%-28s %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' -X POST \
    "$H$p" -H 'Content-Type: application/json' -d '{}')"
done

# MUST stay open (a 4xx that is NOT 404 means it is reachable and validating):
printf 'POST /api/v1/auth        %s\n' "$(curl -s -o /dev/null -w '%{http_code}' \
  -X POST "$H/api/v1/auth" -H 'Content-Type: application/json' -d '{}')"
printf 'GET  /api/v1/wallets     %s\n' "$(curl -s -o /dev/null -w '%{http_code}' \
  "$H/api/v1/wallets")"
printf 'PUT  /api/v1/auth/reset  %s\n' "$(curl -s -o /dev/null -w '%{http_code}' \
  -X PUT "$H/api/v1/auth/reset" -H 'Content-Type: application/json' -d '{}')"

# The extension's own registration, which must be untouched:
printf 'siLNt signup-config      %s\n' "$(curl -s -o /dev/null -w '%{http_code}' \
  "$H/siLNt/api/v1/auth/signup-config")"
```

Then confirm against a week of real traffic rather than against this file —
the keep-list above is read off the clients' source, and your log is the only
thing that knows what is actually in use:

```bash
grep -oE '"/api/v1/[a-z/]+' /var/log/caddy/whispawallet.access.log \
  | sort | uniq -c | sort -rn
```

Anything with a 2xx that this config would close is a path the source read
missed. Fix the config, not the log.

**Where the web app is served matters.** If this host also serves the WhiSPa
web app's static files, the `@core_admin` matcher's bare paths (`/account*`
and friends) can collide with the SPA's own routes. On mainnet the web app is
closed to the outside anyway (CLAUDE.md: onboarding is mobile-app only), but
check before pasting: if the SPA is here, drop the second matcher's non-`/api`
paths and keep the `/api/v1/...` ones.

## Rate limiting is not in Caddy

There is no built-in rate limiter in Caddy v2. It needs a plugin and therefore
a custom binary:

```bash
xcaddy build --with github.com/mholt/caddy-ratelimit
```

Worth knowing before you plan around it. `register-start` already has limits
inside the application (`helpers/register_rate_limiter.py`: per IP per hour,
per email cooldown, and a global hourly backstop), so the gap a proxy limiter
fills is the flood that should never reach Python at all — not the
registration endpoint specifically.

If a custom Caddy build is unwelcome, Cloudflare in front gives the same thing
plus bot scoring and ASN rules, and the Turnstile account already exists.

## What is deliberately not here

**Requiring `X-Thrilla-Client` at the proxy.** It would raise the cost of
pointing a script at the API, and it would also block the LNbits-native
extension page, which `_is_thrilla_request` returns false for on purpose. That
is a product decision, not a hardening one, so it is not in the config above.

**mTLS, request signing, or an embedded API key.** All three put the secret in
the app, which is the problem they claim to solve.

**Play Integrity / App Attest.** It would work on Android and it is a Google
dependency, which would undo `WHISPA_NO_PUSH` and the F-Droid build — and it
does nothing for the web app.
