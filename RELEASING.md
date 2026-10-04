# Releasing

## Cutting a release

```bash
scripts/cut-release.sh v0.4.0        # the TAG is the build number
```

**The tag is numbered and the title is named, and they differ on purpose.**
`src/services/updateCheck.ts` reads the version it compares straight off
`tag_name`, so the tag has to carry a number that sorts above what is already
installed. A tag of `v0.1.0-beta` parses to `0.1.0`, compares below every
installed build, and the in-app update check answers "up to date" to everyone
— for that release and every one after it. That is not a one-off: each
`v0.1.x-beta` would sort below the climbing `APP_VERSION` too.

So the tag is `v${APP_VERSION}` and the release is *titled* from
`PRERELEASE_LABEL` — "WhiSPa 0.1.0-beta". `cut-release.sh` reads the label out
of `src/version.ts` rather than rebuilding it, so the About page and the
release page cannot drift. `check:update` asserts both directions.

## Zapstore

### The thing to understand first

**An app's identity on Zapstore is its Android applicationId.** `zsp` takes the
`d` tag of the kind 32267 event straight from the APK's package identifier, so
two APKs with different applicationIds are two different apps on the relay —
with separate listings, separate install counts and no update path between
them.

The applicationId changed from `com.thrilla_btc.thrilla` to
`com.whispawallet.app` with the WhiSPa rename. So:

- Publishing WhiSPa **creates a new listing**. It does not rename the Thrilla
  one, and there is no flag that makes it.
- Anyone who installed Thrilla from Zapstore will **never** be offered WhiSPa
  as an update. They have to install it as a separate app and move their funds
  across. This is the same thing that happens on the phone, for the same
  reason.

That second point is why the old listing should not simply be deleted. A
deleted entry tells the people who have Thrilla installed nothing at all; a
replaced one can tell them where to go.

### Publishing WhiSPa

Mainnet and Signet are separate packages, so separate configs:

```bash
zsp publish --check                          # validate the mainnet config
SIGN_WITH=nsec1... zsp publish

zsp publish --check zapstore.signet.yaml     # and Signet
SIGN_WITH=nsec1... zsp publish zapstore.signet.yaml
```

Both read `release_source` from `/releases/latest/download/…`, which resolves
to the newest **non-prerelease** — so `scripts/cut-release.sh` has to have run
first. The rolling `ci-*` prereleases are deliberately invisible to it.

`--check` is worth running every time. The one thing to look at in its output
is the version it extracted and whether it found the matching `CHANGELOG.md`
section: zsp reads the version from the APK, which reports the **build** number
(`APP_VERSION`), not the release name. The changelog headings are numbered to
match the former for exactly this reason.

### Retiring the Thrilla listing

There is no Thrilla-era APK left — the old releases were deleted on 2026-10-04
and GitHub no longer serves one — so the "republish the same `d` tag with new
metadata" route is closed. `zsp` builds that tag from an APK, and without one
there is nothing to publish against.

So the old listing gets **deleted**, from the Zapstore side, and the signpost
moves to the places that can still carry it:

1. Publish WhiSPa first, and check both listings are visible.
2. Then delete `com.thrilla_btc.thrilla`.
3. Leave the signpost where people will actually meet it — the release notes
   (`CHANGELOG.md` leads with "this is a new app on your phone, not an
   update"), the website, and the old app's own update check.

That last one is worth knowing about. An old Thrilla install's update check
still resolves: it has `ponthief/thrilla` compiled in and GitHub redirects a
renamed repository indefinitely, so it reads WhiSPa's latest release. It will
offer the download — and the install will FAIL, because Android will not put
`com.whispawallet.app` over `com.thrilla_btc.thrilla`. There is no build of
Thrilla that can be published to say so, since publishing one would mean
reviving that applicationId.

Nothing in this repository can fix that for someone already holding Thrilla.
What reaches them is the release notes on the page the updater sends them to,
which is why those notes open with the warning rather than the feature list.

If a NIP-09 deletion is ever needed instead of the Zapstore UI, it is a kind 5
from the publishing key referencing the addressable coordinate:

```
["a", "32267:<your-pubkey-hex>:com.thrilla_btc.thrilla"]
```

`zsp` has no delete command, so send it with `nak` or any client that can
publish a raw event.
