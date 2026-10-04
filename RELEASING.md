# Releasing

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

Two options, and the first is better.

**Replace it with a signpost.** Kind 32267 is addressable, so publishing a new
event with the same `d` tag (`com.thrilla_btc.thrilla`) from the same pubkey
overwrites the old metadata in place. Point its name and summary at WhiSPa, so
somebody with Thrilla installed opening Zapstore finds out where it went.

The catch: zsp builds the `d` tag from an APK, so this needs a **Thrilla-era
APK** (one built before the applicationId changed) to publish against. If you
still have one locally, point a temporary config's `release_source` at the file
and change only the name/summary/description. If you do not, this option is not
available — the old releases were deleted on 2026-10-04 and GitHub no longer
serves one.

**Or delete it.** Zapstore honours NIP-09 deletion requests that reference an
addressable coordinate, so a kind 5 event from the same pubkey with:

```
["a", "32267:<your-pubkey-hex>:com.thrilla_btc.thrilla"]
```

asks the relay to drop the listing and every version of it. `zsp` has no delete
command, so send it from a client that can publish a raw event — `nak`, or any
signer that lets you craft one — using the same key that published the app.
Relays honour deletion requests at their discretion, and anything that already
mirrored the event may keep it.

Whichever you pick, do it **after** WhiSPa is published and visible, so there
is somewhere to point people at.
