# Publishing WhiSPa through F-Droid

Two routes exist and they are not the same product decision. This repo is set
up for the first; the second is written down because the first is a step
towards it.

## The route taken: a self-hosted F-Droid repository

You publish your own repo index at, say, `https://fdroid.whispawallet.com/repo`
and users add it to their F-Droid client. **You keep your own signing key**,
which is the whole reason this route was chosen first.

That matters more here than in most apps. An Android APK's signing certificate
is the app's identity to every device that has it installed. An APK signed by a
different key is a different app: it cannot update over the existing one, so
every current user would have to uninstall and reinstall — and for a wallet,
uninstalling is the keys gone unless they still hold their recovery phrase.
Staying on your own key means an install from GitHub, from Zapstore, or from
your F-Droid repo all update each other.

What you give up: discoverability. Your app does not appear in the F-Droid
client's default index, and users must add the repo URL by hand.

### One-time setup

```bash
pip install fdroidserver          # or your distro's package
mkdir -p ~/dev/fdroid && cd ~/dev/fdroid
fdroid init --keystore ~/dev/fdroid/repo-index.jks
```

**`init` does not make the key.** That flag only records the path in
`config.yml`; `fdroid update` then fails with *"'…/repo-index.jks' does not
exist! … you can create one using: fdroid update --create-key"*. So:

```bash
fdroid update --create-key
```

That key signs the **index**, not the APKs — a separate key from the app's
release keystore, and the one worth backing up off the machine: losing it means
every subscriber has to remove and re-add the repo. There is no re-signing your
way out of it.

`init` also writes `config.yml` **beside** `repo/`, holding that key's
`keystorepass` and `keypass` in plaintext. That is why the web root below
points *inside* `repo/` and never at its parent.

Then set the repo's identity in `config.yml`:

```yaml
repo_url: https://fdroid.whispawallet.com/repo
archive_url: https://fdroid.whispawallet.com/archive
repo_name: WhiSPa
repo_description: >-
  Bitcoin wallet with Silent Payments. Official builds, signed with the same
  key as the GitHub releases.
archive_older: 3
```

**Set these before the first `fdroid update`, or you will serve a working repo
that points somewhere else.** The default `repo_url` is
`https://MyFirstFDroidRepo.org/fdroid/repo` (`common.py:207`), and it is not
only a config value: `fdroid update` writes it into `repo/index.html`, into
the QR at `repo/index.png`, and into the signed index's own `address` field.
Left alone, the site serves correctly and every link on it — and every client
that adds the repo — goes to `MyFirstFDroidRepo.org/fdroid/repo`. The
`/fdroid/` in that path is the tell: nothing in the Caddy block below ever
produces it.

Changing the config is not enough on its own. The address is inside the signed
index, so it takes another `fdroid update` and another rsync.

`repo_url` must end in `/repo` and `archive_url` in `/archive`
(`common.py:662-668` raises otherwise), which is what the two routes below
serve.

Two more warnings `fdroid update` raises on a fresh repo, both one-time:

```bash
# repo_icon "repo/icons/icon.png" does not exist
# NOT in repo/icons/ — see below. Source path, relative to ~/dev/fdroid:
cp <app-checkout>/fastlane/metadata/android/en-US/images/icon.png icon.png

# <apk> (com.whispawallet.app) has no metadata — writes metadata/<appid>.yml
fdroid update -c

# then the real metadata, so the client shows more than a package name
mkdir -p metadata/com.whispawallet.app
cp -r <app-checkout>/fastlane/metadata/android/en-US metadata/com.whispawallet.app/
```

**That icon warning names a path it did not look at.** `update.py` checks
`os.path.exists(config['repo_icon'])` — cwd-relative, so `~/dev/fdroid/icon.png`
— and then renders the message as `repo/icons/{path}`, which is the
*destination*: `index.py` copies the file there itself. Putting it in
`repo/icons/` by hand satisfies nothing and the warning repeats. Both paths end
in `icon.png`, so the message reads as if it were already looking where you
just put it.

`fdroid update` also writes `repo/index.html` and `repo/index.png` — a landing
page and a QR, both carrying the fingerprint of the index key:

```bash
grep -o 'fingerprint=[0-9A-F]*' ~/dev/fdroid/repo/index.html | head -1
```

The URL to publish is `https://fdroid.whispawallet.com/repo?fingerprint=<that>`.
Without the fingerprint the client pins whichever key answers first.

### Each release

```bash
# 1. Build the APK you are going to publish — the no-push build, see below.
npm run apk:fdroid

# 2. Drop it in and build the index.
cp android/app/build/outputs/apk/mainnet/release/*.apk ~/dev/fdroid/repo/
cd ~/dev/fdroid && fdroid update --pretty

# 3. Publish the repo directory.
rsync -av --delete ~/dev/fdroid/repo/ user@host:/srv/fdroid/repo/
```

`fdroid update` reads `fastlane/metadata/android/en-US/` out of the APK's
source repo if you point it there, or you can copy that tree into
`~/dev/fdroid/metadata/com.whispawallet.app/`. The metadata in this repo is already
in the layout both F-Droid and Zapstore expect:

```
fastlane/metadata/android/en-US/
├── title.txt
├── short_description.txt
├── full_description.txt
├── changelogs/500.txt          # named for the versionCode, not the version
└── images/
    ├── icon.png                # 512×512 PNG
    └── phoneScreenshots/
```

The changelog filename is the **versionCode**, which `android/app/build.gradle`
derives as `major * 10000 + minor * 100 + patch` — so 0.5.0 is `500.txt`. A
changelog named after the version string is silently ignored.

### Serving it

Any static host — the tree is already complete, `index.html` and all. Behind
Caddy, its own site block: the CSP in the main one is written for the web app,
does nothing for a static file tree, and can only break the F-Droid client.

```bash
sudo mkdir -p /srv/fdroid
sudo rsync -av --delete ~/dev/fdroid/repo/    /srv/fdroid/repo/
sudo rsync -av --delete ~/dev/fdroid/archive/ /srv/fdroid/archive/
sudo chown -R caddy:caddy /srv/fdroid
```

```caddyfile
fdroid.whispawallet.com {
	# Rooted INSIDE repo/, not at its parent. See below.
	handle_path /repo/* {
		root * /srv/fdroid/repo
		file_server
	}

	# archive_older: 3 means fdroid update writes a second index here.
	handle_path /archive/* {
		root * /srv/fdroid/archive
		file_server
	}

	redir / /repo/
	header /repo/*.apk Content-Type application/vnd.android.package-archive
}
```

**The web root is `repo/`, never the directory above it.** `fdroid init` leaves
`config.yml` and the index keystore in that parent, and `config.yml` holds
`keystorepass` and `keypass` as plaintext — serving the parent publishes the
key that signs the index, and the password to use it, at a predictable URL.
Nothing warns you; the directory listing just looks complete.

Which is also the argument for `rsync`-ing to `/srv/fdroid/repo/` rather than
pointing Caddy at the working tree in `~/dev/fdroid`: the keystore is then not
under a web root at all, and Caddy does not need traverse permission on a home
directory. Serving `~/dev/fdroid/repo` directly works, but needs
`chmod o+x` on every directory down to it, and one `root *` typo exposes the
key.

`repo_url` in `config.yml` must match what the block serves —
`https://fdroid.whispawallet.com/repo`.

Then check it, before telling anyone the URL:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
curl -sI https://fdroid.whispawallet.com/repo/entry.jar        # 200
curl -sI https://fdroid.whispawallet.com/repo/index-v1.jar     # 200
curl -s  https://fdroid.whispawallet.com/config.yml | head     # must 404
```

That third one is the check worth keeping: it is the failure the web root
guards against, and it is invisible from the client side.

## The no-push build

`npm run apk:fdroid` sets `WHISPA_NO_PUSH=1`, which `react-native.config.js`
turns into an autolinking exclusion for `@react-native-firebase/app` and
`@react-native-firebase/messaging`. The npm packages stay installed so the
JavaScript still resolves; what goes is the native side, and with it the
Firebase AARs.

Verify it took, before trusting a build:

```bash
WHISPA_NO_PUSH=1 npx react-native config | grep -c firebase    # expect 0
npx react-native config | grep -c firebase                     # expect non-zero
```

`services/push.ts` asks `NativeModules.RNFBMessagingModule` whether the native
side is present rather than reading the flag — the app discovers the answer
from the APK it is actually running in, because a flag can disagree with what
was built and that disagreement would surface as a crash on launch. Settings →
Notifications says "Alerts unavailable in this build" rather than offering a
switch that stores a preference nothing can honour.

**What users lose.** Nothing arrives while the app is closed. Payments are
still found — the chain scan runs when the app is opened, and the foreground
watcher picks up changes while it is open — but there is no notification of a
payment or a Tango until then.

You do not have to ship the no-push build on your own repo; a self-hosted repo
has no policy about proprietary dependencies. It is built that way so the
F-Droid build and a future official submission are the same artifact, and so
the option is exercised rather than theoretical.

## The other route: the official f-droid.org repo

Listed in the default index, so discoverable. Three costs, and the third is the
one that decides it.

**1. No proprietary dependencies.** F-Droid builds from source on its own
infrastructure and refuses non-free libraries. Two are in the APK today:

- **Firebase Cloud Messaging** — solved by the no-push build above.
- **Google MLKit barcode scanning** — solved on 2026-10-24. It used to arrive
  through `react-native-camera-kit`, which depends on
  `com.google.mlkit:barcode-scanning` and brings `libbarhopper_v3.so` plus
  `.tflite` models. Android now scans with ZXing
  (`com.journeyapps:zxing-android-embedded`, Apache 2.0) through a native
  module of our own, `android/.../scanner/ZxingScannerModule.kt`, and
  camera-kit is excluded from Android autolinking.

  iOS keeps camera-kit: its podspec depends on `React-Core` alone and the
  decode is AVFoundation's, so MLKit was never on that side.
  `src/components/QRScanner.tsx` branches on the platform and its contract to
  callers is unchanged.

  Visible cost: ZXing opens its own full-screen Activity, so on Android the
  scanner is ZXing's screen rather than our Modal with its frame overlay. The
  alternative was wrapping `DecoratedBarcodeView` in a custom ViewManager —
  a camera lifecycle to get right, for a cosmetic match, on the screen that
  starts every send.

Check what is actually in a built APK rather than reasoning from the manifest:

```bash
unzip -l app.apk | grep -E '\.so$|\.tflite$'
```

After the ZXing change there should be no `.tflite` at all and no
`libbarhopper_v3.so`. `npm run check:fdroid` holds the source side of this —
that camera-kit stays out of the Android build, that the ZXing module is
registered, and that neither camera-kit nor Firebase is statically imported —
but only an APK proves what actually shipped.

**CI does that now.** The `fdroid-blobs` job in `.github/workflows/build-android.yml`
builds `npm run apk:fdroid` on every push and inspects the result: no
`.tflite`, no `libbarhopper_v3.so`, no MLKit native library — and, before any
of those, that the listing it is reading is of a real APK, because a check
shaped "X is absent" passes just as happily when it inspects nothing. It also
asserts that `WHISPA_NO_PUSH=1` empties Firebase out of `react-native config`
while the unflagged build still has it, so the exclusion cannot start passing
because there was nothing to exclude.

Its artifact is **release-built but debug-signed** — the job takes no
keystore. Use it to look inside, never to publish. The release build is still
the local `npm run apk:fdroid` above, with the real key.

**2. A review that takes weeks to months**, plus an `fdroiddata` merge request
carrying a build recipe.

**3. F-Droid signs the APK with its own key.** Different certificate, so it is
a different app to Android: nobody on an existing install can update to it.
For a wallet that means a reinstall and a restore from the recovery phrase, for
every user, at a moment they did not choose.

The third cost is avoidable — F-Droid can publish *your* signed APK if the
build is **reproducible**, meaning their rebuild from source is byte-for-byte
identical to yours. That needs a pinned toolchain (exact NDK, build-tools and
JDK), no build timestamps in the output, and a verified rebuild before each
release. It is the only way onto f-droid.org without breaking the update path,
and it is a project of its own.

### The submission

A merge request against `gitlab.com/fdroid/fdroiddata` adding one file,
`metadata/com.whispawallet.app.yml`. **The self-hosted repo is no part of it**
and does not become an f-droid.org listing by any route; the two are unrelated
publications of the same APK.

The recipe is kept in this repo at **`fdroid/com.whispawallet.app.yml`**, with
the reasoning for each field in comments. Nothing here reads it — it is
versioned alongside the build it describes, because every claim it makes about
`android/app/build.gradle` goes stale without a word.

```bash
git clone git@gitlab.com:<you>/fdroiddata.git && cd fdroiddata
cp <app-checkout>/fdroid/com.whispawallet.app.yml metadata/
fdroid readmeta
fdroid lint com.whispawallet.app
fdroid build -v -l com.whispawallet.app:500      # needs their buildserver
```

Then open the MR. Review is weeks to months.

**`Binaries:` plus `AllowedAPKSigningKeys:` is the pair that matters**, and it
is not optional for a wallet. With them, F-Droid builds from source, downloads
our published APK and compares; on a match it publishes **ours**, under our
certificate, so existing installs update normally. Without them it publishes
its own build under its own key, which is cost 3 above.

**A build that is not yet reproducible does not fall back to their key.**
`build.py:1245-1264` raises, deletes the built APK and fails the build — so the
comparison is a gate, not a preference, and submitting before reproducibility
is solved costs a red build to iterate on rather than a stranded userbase.
That makes it safe to submit first and work on reproducibility after.

The fingerprint is read off the published APK, not the keystore:

```bash
unzip -p whispa-mainnet.apk META-INF/CERT.RSA \
  | openssl pkcs7 -inform DER -print_certs \
  | openssl x509 -outform DER | sha256sum
```

Two things specific to this app, both work rather than paperwork:

- **`WHISPA_NO_PUSH=1` cannot be passed.** It is an environment variable read
  during autolinking, a `Builds:` entry has no `env` field, and `prebuild`'s
  environment does not reach the gradle step. The recipe burns it into
  `react-native.config.js` with `sed` instead.
- **Reproducibility has to survive a JS bundle.** The Hermes bytecode and the
  asset packaging must come out identical, so node and npm are pinned
  alongside the NDK, build-tools and JDK. `.nvmrc` holds the version (20.20.2,
  which is what `node-version: '20'` was resolving to), and all three
  workflows read it through `node-version-file` so there is one place to say
  it. **The buildserver does not read `.nvmrc`** — the recipe's `sudo:` block
  installs the same version by hand, with a checksum, and that pair has to be
  kept in step.

  Node 20 reached end of life in April 2026. Moving to 22 is its own change
  and needs a build to validate; pinning the version CI already used keeps
  this commit to one variable.

## Order of work, if the official repo is the eventual goal

1. Self-hosted repo (this document's first half). Done once, keeps working.
2. ~~Replace the MLKit scanner with a FOSS one.~~ Done — ZXing, above.
3. Submit to `fdroiddata` with `Binaries:` and `AllowedAPKSigningKeys:` set.
4. Make the build reproducible until their rebuild matches ours, iterating on
   the failed builds from step 3.

Steps 3 and 4 are in that order on purpose: with `Binaries:` set, step 3 cannot
publish anything under the wrong key, so there is nothing to protect by
delaying it.
