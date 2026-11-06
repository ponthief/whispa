# Draft reply to fdroiddata MR !54187

Not part of the build. Paste the body below as a comment on
https://gitlab.com/fdroid/fdroiddata/-/merge_requests/54187 once the metadata
change is pushed to the `whispa` branch of the fork, and fill the two Abstract
sections into the MR **description** (they are blank, which is what
"check required checkboxes above" was pointing at — they sit above the
checklist).

Three things in the body are deliberate:

* It **raises the reproducible-build risk** rather than quietly accepting the
  node change. Burying it would mean a failed build nobody has an explanation
  for, and the reviewer is better placed than we are to say whether apt's node
  reproduces.
* It **asks them to trigger CI** in the words the checklist itself offers,
  because the pipeline never ran — it has no jobs, `started_at` is null, and
  it "finished" a millisecond before it was created. That is a missing runner,
  not a build failure, and the checklist says to leave a note rather than hand
  GitLab a card.
* It **says plainly that two ticked boxes were not true**, because they were
  ticked and the file did not satisfy them. Leaving that for the reviewer to
  re-find is how an MR gets another round.

---

Thanks for the review, and sorry for the checklist — two of the boxes I ticked
were not actually true of the file. Both are fixed now.

**`commit` was a tag, not a hash.** It said `commit: v0.5.0`; it now says
`commit: 4b16735e0b52d2ebfd4900e53948951b91ec57e6`, which is
`git rev-parse v0.5.0^{commit}`. `UpdateCheckMode: Tags` still picks up the
next release.

**`AuthorName` was missing entirely.** Added as `ponthief`. Worth mentioning
for anyone else reading: `fdroid lint` passes clean both with and without it,
and passes clean on a tag in `commit:` too, so neither of these shows up
locally — only review catches them.

**Node now comes from Debian**, as you asked:

```yaml
    sudo:
      - apt-get update
      - apt-get install -y nodejs npm
```

replacing a download of node 20.20.2 from nodejs.org. trixie gives nodejs
20.19.2 and npm 9.2.0; `package.json` asks for node `>=18` and
`package-lock.json` is lockfileVersion 3, so both are satisfied and the
explicit `npm -g install npm@10.8.2` is gone with the tarball.

**One risk I would rather flag than discover in a build log.** This app is
submitted with `Binaries:` + `AllowedAPKSigningKeys:`, so the build has to
reproduce an APK we publish, and the pinned node was there to match the
toolchain that produced it (our `.nvmrc` is 20.20.2). My reading is that it
should not matter — `hermesc` ships inside the `react-native` package and
`npm ci` against a lockfileVersion 3 lock pins the whole tree, so the Hermes
bytecode and the dependency set come from the lockfile rather than from node,
and 20.19 against 20.20 is a patch-level difference. But that is a reading,
not a result. If the reproducible-build comparison fails on the first real
build, the pinned download (with its `sha256sum -c`) is what I would put back,
and I would rather be told that than guess. Happy to go either way.

**The pipeline has never run.** The head pipeline on my fork reports
`failed`, but it has no jobs at all: `started_at` is null, duration is null,
and it records a finish timestamp a millisecond before its own creation. So
nothing has been built or lint-tested by CI on this branch — including the
change above. Per the checklist I have not given GitLab any payment or phone
details, so this is the note asking whether you can trigger CI from your side.

Checked locally with fdroidserver 2.4.5 against fdroiddata's own
`config/categories.yml`: `fdroid readmeta` and `fdroid lint
com.whispawallet.app` both exit 0 with no output.

Abstract and the remaining description sections are filled in above.

---

# For the MR **description**, not a comment

These two headings exist in the description with nothing under them. Paste
each answer beneath its own heading, and either put an RFP issue number after
`Closes rfp#` or delete that line — it is still the bare placeholder, and
"All related fdroiddata and RFP issues have been referenced" is ticked.

Screenshots: the four in
`fastlane/metadata/android/en-US/images/phoneScreenshots/` (01–04.jpg) are
already in the upstream repo, so they can be linked rather than re-uploaded.

### Please introduce the functions and usage of your app in summary, and also attach some screenshots.

WhiSPa is a self-custodial, Bitcoin-only wallet built on Silent Payments
(BIP-352). You publish one reusable address, and every payment still lands at a
fresh, unrelated output on chain — so the people who pay you cannot see each
other's payments, and nobody watching the chain can tie them together.

Keys are generated on the device from a standard BIP-39 recovery phrase and
never leave it; transactions are built and signed on the phone, so no key is
ever sent to a server. That cuts both ways and the app says so plainly:
nobody operating the service can spend your bitcoin, and nobody can restore it
for you either.

In use: you are given one `sp1…` address to hand out, plus a standard BIP-84
`bc1q…` chain alongside it for senders that cannot pay a Silent Payments
address. Receiving needs no interaction — the wallet scans the chain and finds
payments addressed to you. Sending is an ordinary address-and-amount form with
fee tiers and coin selection. Coin control is per-coin labels, freezing and a
dust warning. There is an optional app lock (biometrics or PIN) and a separate
duress PIN that wipes the keys.

It is not a Lightning wallet and holds no Lightning balance.

Screenshots are in the upstream repo at
`fastlane/metadata/android/en-US/images/phoneScreenshots/`.

### Please elaborate why you wrote this app. Please highlight the unique functions it provides over other similar apps in F-Droid.

Address reuse is the single easiest way to deanonymise a Bitcoin user, and
every workaround for it pushes the work onto the sender or onto a server: hand
out a fresh address each time, run an xpub-aware payment server, or accept that
a static address on a website links every donation to it. BIP-352 solves it at
the protocol level instead — one published address, unlinkable outputs, no
interaction with the payer and no server holding a key.

What I could not find in F-Droid was a wallet that actually implements it.
There are good privacy-conscious Bitcoin wallets in the repo, but as far as I
can tell none of them receives to a BIP-352 Silent Payments address, which is
the whole reason this exists rather than being a patch to one of them.

Two other things are specific to this app:

* **Tango** — an optional, opt-in two-party equal-output mix with another
  user. The interesting part is the change output, which is the strongest
  remaining linkability problem once the amounts match, and which the user can
  choose to route away rather than spend later.
* **It builds and signs every transaction on the device**, including for the
  mix, and refuses to sign an output it cannot independently derive and verify
  — so the coordinating server cannot direct a coin anywhere the device has
  not agreed to.

On packaging, two things matter for F-Droid specifically and are already done
in the submitted build: Firebase is dropped from the native build entirely
(`WHISPA_NO_PUSH=1`, the `prebuild` step in the recipe), and the QR scanner is
ZXing rather than ML Kit, so the APK carries no proprietary native libraries —
no `libbarhopper_v3.so` and no `.tflite` models. That is checked in our own CI
by unpacking the built APK, not just asserted.

Licensed MIT.
