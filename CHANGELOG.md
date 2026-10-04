# Changelog

Keep a Changelog format, because `zsp` reads it: `release_notes: CHANGELOG.md`
in both zapstore manifests pulls the section whose version matches the APK.

**The heading version is the BUILD number, not the release name.** The public
release stream restarted at 0.1.0-beta on 2026-10-04 while `APP_VERSION` kept
climbing — Android refuses an APK whose versionCode went backwards, so the
number could not follow the name down (see `src/version.ts`). zsp takes the
version from the APK, which reports `0.4.0`, so that is what the heading has to
say or the section will not be found. The name it is released under goes in the
first line of the body, where a reader looks anyway.

## [0.4.0] - 2026-10-04

Released as **WhiSPa 0.1.0-beta**.

### Changed

- **Thrilla is now WhiSPa.** New name, new home at whispawallet.com, same
  wallet and the same people. The release numbering restarts at 0.1.0-beta to
  match: this is a beta and the version should say so rather than implying a
  history it does not have.
- **This is a new app on your phone, not an update.** The Android package
  identifier changed with the name, so WhiSPa installs alongside Thrilla
  instead of over it. Move your funds across before removing the old one, and
  keep your recovery phrase until you have confirmed the balance arrived.
  Nothing migrates by itself.

### Added

- **Tango — a two-party mini coinjoin.** Two people put coins in and each takes
  out shares worth exactly the same amount, so nothing in the transaction says
  which output is whose. Optionally split into several equal pieces. A round
  needs both sides to agree and both to sign; either can walk away, with a short
  note saying why, and the coins come straight back.
- Change from a round can be sent to a **Lightning address you control**
  instead of staying on chain, because a change output's value is fixed by the
  round's arithmetic and spending it later is what links the shares back to
  you. Off by default, per side: if you do not set one, your change simply
  stays in your wallet.
- A **lookback rescan** on the scan screen — 10, 144, 1,008 or 4,320 blocks
  back from the tip — available even when the wallet reports itself up to date,
  which is exactly when it is needed: a payment that never appeared is in a
  block the wallet believes it has already read.
- An **app lock**, backed by the device's own keystore and biometrics, with a
  separate in-app PIN.

### Fixed

- A wallet no longer claims to be fully scanned when a block in its range could
  not be read. The block is named, the resume point is held below it, and the
  next scan starts there.
- The resume point only ever moves forward, so a deliberate rescan of older
  blocks no longer throws away the scanning above it.

## What WhiSPa is

- **Silent Payments (BIP-352).** One reusable address you can publish. Every
  payment to it lands on a fresh on-chain output that only you can find, so
  reusing the address does not reuse anything on chain.
- **PayJoin**, so a payment does not have to look like one.
- **BitMail** — a human-readable name (BIP-353) instead of an address.
- **Keys are derived on the device and stay there.** Transactions are built and
  signed on the phone; no private key and no passphrase is ever sent to a
  server, including ours.
- **Coin control**, so you choose which coins go into a payment.
- Swaps to and from Lightning, through Boltz.
