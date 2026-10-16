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

## [0.5.0] - 2026-10-16

Released as **WhiSPa 0.2.0-beta**.

### Added

- **Spending your SegWit coins moved to Send.** It used to live on the Receive
  tab, inside the card that hands out the address — going to Receive in order
  to send. There is a chain picker beside the Silent Payments form, and it only
  appears when there is something on the SegWit side.
- **One balance.** The headline adds both pockets up and names the split
  directly under it, instead of leaving the SegWit coins in a banner that said
  they were held separately.
- **Labels for SegWit addresses**, kept on this device only. A SegWit address
  is one you handed somebody on purpose; what is hard is remembering *which*
  somebody, six payments later.
- **A rescan by day or by date.** 1, 3, 5 or 7 days back, or a specific day
  from a calendar — rather than a number of blocks with "about a day" printed
  beside it. How far back you may start is the indexer's own floor, and any
  one scan covers at most a week.
- **A scanning bar on the Wallet screen.** Catching up can take minutes during
  which the balance is not yet the whole truth, and nothing on that screen said
  so unless you had started the scan from it.
- **A splash screen**, from the moment the launcher is tapped rather than from
  when the app has loaded.
- **Invite a friend** in the browser's Settings, which only the phone had.
- A **frozen filter** on the browser's Coins page, and **New address** on its
  SegWit panel.

### Changed

- **"Plain" is now "SegWit".** It named the chain by what it is *not*, which is
  no help to anyone trying to reach those coins in another wallet. It is a
  standard BIP-84 chain and the screens say so. The card now also says the
  address in front of you has never been used — the instruction not to reuse
  one means nothing without it.
- **Spendable means unfrozen**, on both apps, and the label says so. A frozen
  coin is unspent, confirmed, and still not money you can send; what is held
  back is printed beside the total rather than folded into it.
- **Catch up** is **Scan now**, and Security's **Ask again after** is
  **Auto-lock**. Both were longer ways of saying what the screen already said.
- A finished Tango reports **your own** change and not your partner's, and
  Activity no longer lists the coins of yours that went into a transaction.
- Tango's Lightning change payout is **mainnet only**. On signet the change
  stays on chain in your own wallet, exactly as it did before the setting
  existed.

### Fixed

- **Removing a wallet took the other side's Tango history with it.** A round is
  one record shared by two wallets; now only the leaving side is redacted. A
  wallet removed and added back from the same seed also keeps its history,
  which it lost because the id is new even when the seed is not.
- **A SegWit send left no trace.** It did not show as pending, and once it
  confirmed it disappeared from Activity altogether — the server never lists
  those coins, so nothing else was going to say where the money went.
- **Confirm Broadcast was missing the recipient** on a SegWit send, along with
  the fee rate and the size.
- The browser's Send page **crashed on load** for some wallets.
- The browser and the phone **disagreed about how many coins you had**, because
  the browser counted only the Silent Payments side.
- The Spent list on the Coins page is **paginated** instead of running to
  hundreds of rows, and the Saved contacts dialog is no longer squashed against
  its own edge.

## [0.4.0] - 2026-10-04

Released as **WhiSPa 0.1.0-beta**.

> **Coming from Thrilla? This will not install over it, and that is expected.**
>
> The Android package identifier changed with the name, so Android treats
> WhiSPa as a different app and refuses to install it over Thrilla. If your old
> app offered you this update and the install failed, that is why — nothing is
> wrong with the download.
>
> Install WhiSPa alongside Thrilla, move your funds across, and only then
> remove the old one. **Keep your recovery phrase until you have confirmed the
> balance arrived.** Nothing migrates by itself.

### Changed

- **Thrilla is now WhiSPa.** New name, new home at whispawallet.com, same
  wallet and the same people. The release numbering restarts at 0.1.0-beta to
  match: this is a beta and the version should say so rather than implying a
  history it does not have.

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
