# Working in this repo

## Never rewrite published history

`git filter-repo`, rebase, amend or force-push against a branch that has been
pushed — most of all `master` — invalidates every clone that already has it.
The person pulling is told nothing useful: they were up to date, they pull, and
git tries to merge two histories whose only common ancestor is months back.
Every file conflicts, even when the tips are byte-for-byte identical.

That happened here on 2026-09-16. A `filter-repo` run stripped ~142 MB of
committed APKs and the force-push gave all 217 commits new SHAs.
`cc27393` and `e3bb831` are the same commit — same message, same timestamp,
same tree `27df3d4` — with different hashes. A pull afterwards merged 158 old
commits against 220 new ones. Nothing was lost, and it was still a mess to
clean up.

**The rule:** do not rewrite pushed history. If the user explicitly asks for it
anyway, that is their call — but the *same reply* that reports the force-push
must carry the re-sync recipe below, because every existing clone is broken the
moment it lands. Saying it later is too late; they will hit it first.

Re-sync recipe, for whoever has a stale clone:

```bash
git fetch origin
git status                  # commit or stash anything uncommitted first

# Local commits whose patch is NOT already on the new master.
# Patch-id matching sees through the rewrite, so re-landed work is not listed.
git log --oneline --cherry-pick --right-only origin/master...HEAD

# Nothing of yours listed (merge commits and any the rewrite touched will be):
git checkout -B master origin/master

# Something of yours listed: save it, then re-point and replay.
git format-patch origin/master...HEAD -o /tmp/mine
git checkout -B master origin/master
git am /tmp/mine/*.patch
```

Never `git pull` a rewritten branch. `pull` merges; the fix is to *replace* the
branch.

## Standing instructions from the user

- **Do not remove or disable anything without asking first.** This covers CI
  workflows, tests, features and files alike.
- **`.github/workflows/build-ios.yml` must not be deleted.** It was once, on a
  misreading of "no need for ios" (which meant "don't extend the new mainnet
  work to iOS"). If iOS CI is ever genuinely unwanted, disable the triggers and
  say so in the file.
- **Never skip, disable or quarantine a test** to get CI green.
- Private keys are never stored SERVER-SIDE: not the BIP-84 key, not the
  passphrase. The device keystore holds the phrase, and since 2026-11-08 so
  does the backup file — see "The backup IS a wallet backup", which is the
  user's own decision and the reason that qualifier is now written out.
- Push notifications must not mention amounts — they pass through Google.
- Web mainnet stays closed to the outside; onboarding is mobile-app only.

## Layout

One `src/` serves both apps. `src/screens/*.tsx` is React Native (Android and
`ios/`), `src/views/*.vue` is the web app, and `src/services/`, `src/stores/`
and `src/api/` are shared. A change to shared code needs checking on both
sides, and a rule enforced in one client usually belongs in the other too.

The backend is the separate `siLNt` repo (an LNbits extension). It is the
authority for anything about money — the clients mirror its rules for a faster
error, they do not define them. When a validation rule changes, change it there
first, then mirror it.

## Checks before pushing

```bash
npx tsc --noEmit            # React Native side
npm run lint                # stale hook closures (see below)
npm run build:signet        # web app
npm run check:signing       # both on-device signers vs the Python
npm run check:update        # what the update path offers, vs a real release
npm run check:contacts      # a stale saved address is visible and fixable
npm run check:payout        # the Tango change payout says what it takes
npm run check:vue           # a .vue file importing what it calls, and its CSS classes existing
npm run check:admin         # the payout ledger reports earnings and debts apart
npm run check:lock          # unlocking asks every time
npm run check:slider        # the Send amount slider sets an amount, and only an amount
npm run check:plain         # a fresh plain address stays inside the gap limit
npm run check:qr            # every QR is dark-on-light, with a real quiet zone
npm run check:scan          # a rescan reaches back at least as far as it says
npm run check:catchup       # the catch-up banner cannot rescan what was just scanned
npm run check:colors        # the two colours written in both theme.ts and colors.xml
npm run check:terms         # one terms version, in two repos, behind one tick box
npm run check:apksign       # which key signs a release, answered in one place
npm run check:fdroid        # no proprietary scanner, and push can be left out
npm run check:stealth       # one launcher icon always enabled, and the UI says what it hides
npm run check:backup        # the backup carries no keys, and refuses what it cannot open
cd ../siLNt && python3 -m pytest tests/ -q
```

## WhiSPa is not a Lightning wallet

There is no LN balance, no bolt11 to receive, no invoice to pay, and no
`LIGHTNING_ENABLED` flag. That surface existed, gated off, and was removed on
2026-09-30 rather than finished: a Silent Payments wallet that also keeps a
custodial Lightning balance is two products, and the second one is somebody
else's.

Lightning has exactly one place here, and it is not a wallet. A Tango round
leaves a change output, which is the strongest remaining linkability problem
in the protocol — its value is fixed by the round's arithmetic, so spending it
later identifies which of the two identical shares were yours. A user may give
a **Lightning address** for that change to be sent to instead, minus a service
fee; the output itself goes to the instance's SP address. Their money leaves
over somebody else's network to an account this app never touches.

So: `helpers/tangopayout.py`, `helpers/lnaddress.py` and the Tango payout path
are Lightning. Anything that would give a user a balance here is not.

`check:payout` holds that one setting to five things, each of which has a way
of going wrong quietly. It must say **when** — the change goes out once the
round's transaction confirms, not when the address is saved, and that gap is
what makes a payout look lost while it is only pending — rendered before the
input, not after it. The
**threshold comes from the server**, because a number written into a client is
one the backend can change underneath it, and the user reading the stale one
is the one it applies to; no fee figure appears in either client at all (the
fee paragraph was dropped on 2026-10-01 — it was arithmetic in front of a
one-line decision). It is **mainnet only, by the server's say-so**
(`offered`), never a client-side network check: a Lightning address is a
mainnet endpoint and signet change is worthless, so routing it would have the
instance paying real sats for faucet coins.

**Off mainnet the change stays on chain**, in its owner's own wallet, and that
needs no code of its own — `payout_offered` false makes `tango_payout_ready`
false, makes `_tango_routes_change` false, and the client derives its own
change script and keeps the coin. It is what every round did before this
feature existed.

**It stays mainnet-only** (2026-10-15, on the user's instruction). Two
attempts to widen it are recorded in siLNt `helpers/tangopayout.py` because
both looked reasonable and both are refused. An **NWC** connection to a wallet
somebody else runs (Coinos) could be asked which chain it is on — removed,
because this instance pays from a local Lightning node through LNbits and from
nowhere else. Reading the chain **off the invoice** — BOLT 11 names it — kept
its check (`helpers/bolt11net.py`, immediately before the payment, prefixes
matched longest-first because `lnbcrt` starts with `lnbc`), but as a last line
in front of the money rather than a licence to offer the setting off mainnet:
it should never fire, and it is what makes the rule a property of the code
rather than of one constant. A third attempt needs an answer to "what pays the
invoice", not a narrower refusal.

The last two are the same bug from both ends. **Turning it off keeps the
address** — it used to `DELETE` the row, which made the setting a one-way
door: the only way back on was remembering what had been typed, in front of an
empty field that did not say whether anything had ever been saved. `enabled`
is now what a round reads, the address outlives the decision, and forgetting
it is a separate button. The other end matters more: **a payout already owed
must ignore the switch.** By the time `enqueue_tango_payouts` runs the round
has routed, the change output has paid this instance and the value is owed;
reading `enabled` there would strand somebody's money because they turned a
future-rounds setting off. Two tests assert that direction, by lines of code
rather than by prose, because the comments at both sites mention `enabled` to
say exactly this.

There is a third way into the same stranding, found on 2026-10-05 and shut
before it happened: `enqueue_tango_payouts` finds the change output's vout
**by `a_change_spk`**, and skips a side whose script is missing. So anything
that clears that column on a broadcast round — `purge_tango_side` was about
to, removing a wallet — loses a payout for a round that has already routed.
The value is owed whatever the user has since done with their wallet.

And it lives on the **Tango screen, and only there**. It was in Settings as
well for one commit, on the reasoning that an account setting belongs with the
account settings; two screens answering the same question, with nothing to say
which one you had last used, was worse than one screen you have to go to. The
card (`TangoPayoutCard`) and the panel (`TangoPayoutPanel.vue`) stay as
components anyway, because that experiment is what a second copy of the markup
turns into.

The copy is short on purpose and the order is load-bearing: why (the change is
the linkable part, send it to yourself over Lightning), then when it is sent,
then when the answer is *taken*, then the minimum, then "Save your Lightning
address below" directly above the field. Five lines, each held to one sentence
by a test.

The third one earned its place on 2026-10-03. Each side's answer is
snapshotted at the moment that side JOINS — the proposer's at propose, the
other's at accept — because the output set is what both signatures commit to,
and re-reading a live setting between them would leave the two holding valid
signatures for different transactions. Round `7e180d9e…` paid one side's 716
sats of change over Lightning and left the other's on chain, correctly: that
side had turned the setting on after making the offer. Nothing anywhere said
so. The round card now renders `changeDestination` — "Your change is sent to
your Lightning address" or "stays in your wallet" — **from the round's own
flag, never from the setting**, because those two disagree in exactly the case
worth reporting; a round predating the flag gets a blank rather than a guess.
`check:signing` still bans `a_payout`/`b_payout` from everything in the
clients except that one display read, and separately bans it from the signing
path, because what to derive, withhold and sign must keep coming from the
device's own record.

There is no longer a line saying the change output pays the instance rather
than the user. It was there, at two sentences and then one, and was cut on
2026-10-01 at the user's explicit instruction after being raised twice. What
that costs: if the Lightning leg fails permanently the coin is the instance's
and the user holds a claim, not a coin — so the honest disclosure of that is
the payout ledger, the retry, and the failure notification, not the setting.
Do not re-add prose about it without asking.

Swaps are unaffected — Boltz creates its invoice against an LNbits wallet the
account already has, through `getLnbitsWallets`, and never used the payment
API that went.

`lint` does NOT cover `.vue` — it is `--ext .ts,.tsx`, and
`eslint-plugin-vue` is not installed — and `vite build` compiles an SFC
without resolving the identifiers in it. So a `<script setup>` calling
`computed()` without importing it builds clean and dies at runtime with
"computed is not defined". That shipped to the admin portal's System Settings
page on 2026-10-01: the build passed and the page was dead on arrival.
`check:vue` is the narrow replacement — it knows the names that come from
'vue' and checks a file calling one imports it. Not a general
undefined-variable check, which would need real scope analysis to avoid
crying wolf.

It catches one more thing for the same reason, added 2026-10-06 after it
shipped: **an immediate watcher reading a binding declared below it**.
`watch(x, cb, { immediate: true })` and `watchEffect(cb)` run their callback
synchronously during setup, so placed above a `const` they touch they read it
in its temporal dead zone — and the page dies on load with *"Cannot access 'g'
before initialization"*, `g` being whatever the minifier called it, which
tells the reader nothing. Narrow on purpose: only those two forms, only
top-level `const`/`let` in the same block, and only a reference literally
below its declaration in source order. That is the whole of the bug and needs
no scope analysis.

It also checks that every `text-`, `badge-`, `alert-` and `btn-` class a
`.vue` file uses is defined in `src/style.css`, for the same reason: nothing
else did. `text-amber` was used ten times across four views and never
defined, so every one of those warnings rendered in the body colour —
alongside `text-center`, `text-error`, `text-yellow` and `btn-warn`. An
undefined class name is not a build error, not a lint error, and not visibly
wrong unless you know what it was meant to look like. All five are defined
now.

**Two more CSS failures of exactly that shape**, both shipped on 2026-10-29 in
one commit and both found by the user rather than by any check:

**A `<button>` does not inherit the page's text colour.** It defaults to the
UA's `buttontext`, which computes to `rgb(0, 0, 0)` — black on a `#0e1318`
card. The wallet card's new balance tabs set a font size and weight and no
`color`, so both figures rendered, correctly, and could not be read. Any
`<button>` carrying content rather than a label needs `color: var(--text)`
stated.

**`.card` is `overflow: hidden`** (`src/style.css:76`, for its rounded
corners), so an absolutely positioned child hanging below its anchor is
clipped at the card edge and simply is not there. The ⚙ menu was built that
way and showed one item: Edit fitted, Background and Delete were cut off with
no error, no scrollbar and nothing in the DOM to suggest a problem. The menu
sits in normal flow now and cannot be clipped at any card height. Both were
confirmed in Chromium against a cut-down repro of the real rules — the
quickest way to settle a "why is this invisible" question, and it needs no
login.

`check:admin` covers the Tango payout ledger, which is an earnings report and
a liability report in one page. It refuses three ways that could mislead:
counting fees on payouts that never went out (the instance is holding the
whole change, not earning part of it); showing what is owed as if it were a
balance; and showing the user's *current* Lightning address rather than the
one the payout was actually sent to, which is the entire reason the address is
stored on the payout row.

`check:lock` is about one weakness and one fix for it that does not work.

react-native-keychain 8.2.0 generates the app lock's keystore key with a
**five-second authentication validity window**: after any device
authentication — including unlocking the phone — the key is readable again
with no prompt. `services/appLock.ts` rests on "a successful read means the
user authenticated", so inside that window the read succeeds having asked
nobody anything and the lock screen can open on a tap. It is open at exactly
the moment that screen is shown, which is how pressing **Try again** let a
user straight in (2026-10-02).

**Do not close it by patching the key spec.** That was tried the same day —
`setUserAuthenticationParameters(0, …)` on R+, `…ValidityDurationSeconds(-1)`
below — and it locked every user out of their wallet.
`DecryptionResultHandlerInteractiveBiometric` raises its prompt with **no
`CryptoObject`**, so a biometric success authorises nothing, the retried
decrypt throws `UserNotAuthenticatedException` again, and the prompt loops
forever. The window is the library's only mechanism for authorising the key.
Every device that unlocked once on that build rewrote its sentinel into a key
nothing could read. `check:lock` refuses that patch, and the `postinstall`
hook that applied it, coming back.

Closing it properly needs a keychain whose prompt carries a `CryptoObject`.
Until then it is a five-second weakness in the biometric path; the in-app PIN
is a separate mechanism and is unaffected.

What does work, and what `check:lock` keeps: a read is a pass only if it came
back from the auth-binding storage **and** decrypted to our sentinel
(`storageEnforcesAuth`), because the OS silently downgrades to a storage that
needs no authentication when biometry is unavailable at write time.

`sentinelKeyIsBroken` finds the marker the broken build left and
`rebuildSentinel` replaces the key, on mount — a repair behind an unlock can
never run, because the key is what is unreadable. Rebuilding is not a way past
the lock: writing a sentinel needs no authentication, but the key it writes
still has to be READ to unlock, which still raises a prompt.

The app lock is the ONLY thing in the wallet written with an `accessControl`,
so all of this reaches nothing else — `check:lock` asserts that too, because a
second one would start demanding a prompt per use, which for a wallet key
would mean one per signature.

## Stealth mode hides an icon, not an app

Added 2026-10-31. The home screen can show a **Calculator** or **Notes** icon
instead of the wallet, chosen under Settings → Security → Home screen.

Android gives an app one icon per enabled `activity-alias` carrying
MAIN/LAUNCHER, so the manifest declares three onto `MainActivity` —
`.Launcher`, `.LauncherCalculator`, `.LauncherNotes` — and
`stealth/StealthModule.kt` flips which is enabled with
`setComponentEnabledSetting`. **`MainActivity` carries no launcher filter of
its own any more**, and that is the line that makes the feature real rather
than decorative: a filter there cannot be disabled, so the wallet's own icon
would sit on the home screen whatever the user chose.

**The failure to design against is ZERO enabled aliases.** That is an app with
no icon on any launcher and no way to start it — for a wallet, somebody's money
behind a door with no handle, recoverable only by reinstalling and restoring
the recovery phrase, which plenty of people do not have to hand. So `setAlias`
**enables the target before disabling the others**: between the two calls there
are briefly two icons, which is cosmetic and self-correcting, where the other
order leaves a window with none and a process killed inside it never reaches
the enable call. An unrecognised name is **rejected**, never quietly resolved
to `default` — that would turn stealth off for a caller that asked for a
disguise. `check:stealth` pins both, the one-enabled-alias rule, and that every
`setComponentEnabledSetting` passes `DONT_KILL_APP` (without it Android may
stop the process the moment the toggle is used, which reads as a crash caused
by turning on a security feature).

The alias `android:name`s are **frozen**. A launcher stores the component
behind a pinned or home-screen icon, so renaming one leaves whoever pinned it
with an icon that opens nothing. Icons and labels can change freely.

**The component name is (applicationId, namespace-qualified class)**, and
getting that wrong is how this shipped broken on 2026-10-31. `namespace` is
`com.thrilla_btc.thrilla`; `applicationId` is `com.whispawallet.app`, plus
`.signet` on the signet flavor. `getPackageName()` returns the applicationId,
so a class built from it names `com.whispawallet.app.Launcher`, which does not
exist — `setComponentEnabledSetting` throws *Unknown component*, every call
fails, and the user gets "Could not change the icon" with nothing to say why.
app/build.gradle already documented this exact divergence for
`build_config_package` and react-native-config's `BuildConfig` lookup, and this
walked into it anyway. `StealthModule.aliasPackage` holds the namespace and
`check:stealth` pins it against build.gradle's, because nothing else notices
the two drifting until somebody tries to turn stealth on.

**Mainnet and signet have the same launcher artwork**, which the feature made
worth fixing: one `res` directory serves both flavors, so only the label
differed (`WhiSPa` / `WhiSPa Signet`) and launchers truncate that. Signet now
has its own `android/app/src/signet/res/mipmap-*/` — the same icon with an
amber disc, chosen over lettering because at mdpi (48px) any text is mud.

**Badging `ic_launcher.png` alone does nothing on any modern phone**, which is
how this shipped invisible the first time. `mipmap-anydpi-v26/ic_launcher.xml`
declares an ADAPTIVE icon — `@mipmap/ic_launcher_foreground` over
`@color/ic_launcher_background` — and from API 26 the launcher draws that and
ignores the legacy PNG entirely. The override was generated, built, installed
and identical to mainnet. A flavor overriding the icon must override
**`ic_launcher_foreground`** at every density, and `check:stealth` fails a
flavor that overrides one without the other, or that ships a foreground
byte-identical to main's.

The background colour was the obvious alternative and is nearly useless here:
the foreground artwork fills the safe zone, so the background shows as a thin
rim at most. The badge goes **on the foreground**, and its placement is
arithmetic rather than taste — an adaptive foreground is 108dp with only the
central 72dp guaranteed, so a circular mask keeps radius 0.333 of the image
from centre. The first attempt sat with its outer edge at 0.361 and would have
been sliced off on a round-icon launcher; it is at 0.325 now.

The decoy icons are deliberately NOT badged: a disguise that advertises which
build it is would be a poor disguise, so two installs both wearing Calculator
look identical on purpose.

**The current icon is read from the PackageManager, never from app storage.**
The enabled state is what the launcher obeys and it outlives this app's data,
so a cached copy can disagree with what is actually on the home screen — and
the screen offering to change it has to show what is true.

**What it does not hide, which the Settings copy states rather than letting
anyone infer otherwise**: the app name in Settings → Apps and in the storage
and battery lists; the recent-apps card; and the header of every push
notification. All of those read the *application* label, which an alias cannot
touch. **So turning a disguise on turns alerts off** — a payment arriving under
a calculator icon would otherwise still say WhiSPa on the lock screen, which is
the one place it matters most. That is gated on `isDisguised()` rather than on
one alias name, so a third decoy added later cannot ship with alerts on.
Turning them back on is left to the user: somebody who removed the disguise has
not necessarily decided they want their lock screen naming this app again.

And anyone who *taps* the decoy gets the wallet. The disguise is against a
glance, not against a search; the app lock and the duress PIN are what stand
behind it. A working calculator with a secret entry code was considered and not
built — it is a second UI surface to keep working and a new way to be locked
out, and coercion is what the duress PIN already answers.

Android only. `stealthAvailable()` asks `NativeModules.StealthModule` rather
than a build flag, for the reason `push.ts` gives about its own module, and the
section does not render without it — a switch storing a preference nothing can
honour is the worse failure.

## The backup IS a wallet backup

**What it is for** (2026-11-08, the user stating the use case): *"the whole
use case for backup/restore is: user loses, replaces the phone, reinstalls the
app. When he logs in to new phone, reinstalled app he can just restore from the
backup instead of importing wallet or entering wallet recovery keys."*

So a **phone** backup carries each wallet's recovery phrase, and a restore
recreates the wallets from it. Everything below about labels still holds; this
is the thing on top of it.

**KNOW WHAT THAT MAKES THE FILE.** Anyone holding it and the passphrase can
spend the coins. It is not a file of notes any more. That was put to the user
with the trade spelled out and chosen deliberately, and three things changed
with it: the key is the wallet's own passphrase rather than a password this
file invented, the floor rose from 8 to 12 by that change alone
(`PASSPHRASE_MIN_LENGTH`), and the KDF cost doubled.

**The passphrase is CHECKED, not taken on trust** — *"if wrong passphrase
entered the wallet doesn't get backed up"*. Deriving an SP address from (seed,
typed passphrase) and comparing it to the one the account holds is a complete
test, since BIP-39 feeds the passphrase into the seed: one wrong character
gives a different wallet. A wallet that fails is **left out and named on
screen**, because sealing a phrase under a secret that cannot open it produces
a file that looks perfectly fine and restores nothing.

**The phone only, and not by choice.** `seedVault` holds the phrase there; the
browser's `keyvault.js` holds `{ scanSecret, spendKey, refundAddress,
sweepAccount }` and has never held the words, so the web can neither carry a
phrase nor verify a passphrase. It seals with the same passphrase so one file
opens on either client, says *"Save a backup from the app to include your
wallets"*, and says in as many words that it **cannot check the passphrase**
before saving.

`services/walletBackup.ts` is both halves, with every dependency injected —
keystore, derivation and api — so it typechecks under both tsconfigs and a
check can drive it with no device. Four things in it are each a restore that
would look like it worked:

- **A wallet already on the account is matched by SP ADDRESS and skipped**,
  never by the id in the file. Without that, restoring twice makes a second
  copy of every wallet, each with its own id and history.
- **The derivation is verified again before anything is created.** A
  hand-edited file would otherwise create a wallet at an address nobody can
  reach, which is indistinguishable from success until a payment never
  arrives.
- **The BIRTH height travels, not the resume point.** A restored wallet is a
  new row with no coins; setting `last_height` from the old `last_scan_height`
  would declare every block below it already read, and the resume point only
  moves forward, so the history would be gone for good.
- **`false` from the keystore is a failure.** `storeWalletKeys` and `saveSeed`
  return booleans, and ignoring them leaves a wallet on the server with no keys
  on the device: it appears in the list, shows "Recover Keys", cannot scan, and
  reads as a restore that worked.

**Wallets are restored BEFORE labels**, and `live` is re-read in between, so
the labels land on the wallets this restore just made instead of being remapped
to nothing.

**And `assertNoSecrets` now permits exactly one path**: `wallets[n].mnemonic`,
matched on the PATH rather than the key name. Relaxing the name test instead
would have let a phrase through at `sections.txLabels.mnemonic` on the way back
in, where the payload is whatever a file says it is. Everything else — a
phrase one level deeper inside a wallet, a passphrase, an xprv, a scan or
spend key, anywhere — is still refused in both directions.

**The one that nearly shipped silently**: `backupData.ts`'s collector rebuilds
each wallet from named fields, so for one build it collected every phrase,
verified it, and then **dropped it one line later**. The file looked perfectly
normal and restored no wallets at all. `check:backup` asserts the map carries
`mnemonic` and `lastHeight` now, and that the collector still cannot go and
FETCH a phrase — the separation that survives the change is that the screen
reads and verifies it and hands it in.

**What it was before**: added 2026-11-03, cut back on 2026-11-04 after the user
put the objection that made it necessary — *"if user deletes app or wallet, the
utxos and tnxs are removed from the backend. restoring them in the app won't
restore them on the server."* That objection is still correct about the server
and is answered below; what changed is that the file now also carries the one
thing the server never had.

**The device-only data** is the rest of what it holds: transaction labels,
SegWit address labels, and (on the web) the BitMail pins.

**It holds no contacts, and both screens said it did until 2026-11-08.** Asked
directly: *"don't we store Tango connections on the server, so user removing
them from tango should not be able to restore them via file?"* — yes, and the
word was wrong twice over. A connection is a row in `silnt.payjoin_contacts`
naming **both** user ids; it lives on the server and cannot be re-created from
one side, because the other has to accept. So a file could not bring one back
even if it carried it, and the screen was promising exactly that to the person
most likely to be looking for a way back — somebody who has just deleted one.
The same goes for `payjoin_contact_labels` and `sp_contacts`. Both screens now
say **"Backs up your labels."**, and `check:backup` refuses the word on either.

What "contacts" was reaching for was `bitmailPins`, which is not an address
book: it is trust-on-first-use evidence, the SP address the user's own BitMail
should resolve to. Which makes it the one section **a restore may not
overwrite** (`NEVER_OVERWRITTEN`). `bitmailpins.js` refuses to replace a pin
with a different value, because a silent replacement is how a repointed DNS
record would be masked — and "the file wins" would otherwise walk around that
refusal with a file. A pin the file disagrees with is kept and counted as a
`conflict`; a pin this device does not have is still restored, which is the
useful half, since a new browser inherits the trust anchor. Neither screen
lists the ways that happens any more; see "Where it lives" below for why both
now say one line and name no device. `services/backup.ts` does the crypto;
each client supplies its
own collector because the two store this differently — the web in
`localStorage` under `thrilla_*_v1`, the phone in the platform keychain under
named services.

**What it does NOT do, and this is what the objection established.** There is
no transactions table: `silnt.utxos` is the only coin store and the history is
a view over it. Of its columns, `amount`, `priv_key_tweak`, `pub_key`,
`utxo_state`, `timestamp` and `spent_in_txid` are a cache of the chain, which
`insert_utxos_for_wallet` rewrites on every scan. So the coins and the history
**do come back** after a delete — import the phrase, rescan, the chain is the
authority. Only three columns are original user data: `label`, `frozen` and
`freeze_reason`, plus the address labels behind
`PUT /wallet/{id}/addresses/{addressId}/label`.

**The two label sets are in the backup now** (2026-11-08), which closes most of
that gap. It was reported from the outside: *"just restored a file where label
for segwit address tnx got restored, but not for SP tnx label — if we are only
backing up labels, it's not really a wallet backup, is it?"* Exactly right, and
the split was invisible: a SegWit label is device-only and was in the file; an
SP coin's label is `silnt.utxos.label` and was not. A backup that restores half
of somebody's labels, by a rule nobody can see, is worse than one that says it
restores none.

`services/serverLabels.ts` reads and writes them through the same endpoints the
UI uses, so the server stays the authority and every ownership check still runs
there. The **api is injected** rather than imported: the two clients have their
own api modules with the same function names, the file has to typecheck under
both tsconfigs, and a check can drive it with a fake and no network. Sections
are keyed **per wallet** and remapped through `remapWalletIds` for the usual
reason, by **txid** within a wallet for a coin (what the endpoint takes, and a
fact about the chain) and by **address** for a labelled address.

Three things it has to get right, each of which otherwise produces a restore
that looks like it worked:

- **A label whose coin is not scanned yet is `pending`, not failed.** The
  endpoint 404s when the wallet holds no coin from that txid, which is the
  normal state between adding a wallet back and finishing a rescan — the coins
  come from the chain. Both screens say so: *"N labels need their coins scanned
  first — scan, then restore again."* The same goes for a labelled address,
  which a scan does not recreate at all because the user made it.
- **An address row's id is the SERVER's**, so the one in the file is stale by
  definition after a wallet is re-added. The match is on the address.
- **A label already equal to the file's is not written.** This talks to a
  server, so a no-op PUT is a round trip spent saying nothing.

`frozen` and `freeze_reason` are deliberately still out. A label is a note and a
freeze flag decides what can be SPENT, so restoring a stale one either unfreezes
a coin somebody froze after the backup or freezes one they released — a backup
file quietly changing the spendable balance is a different kind of risk and
wants its own decision.

**Labelled SP addresses are web-only**, so the phone writes no `addressLabels`
section and ignores one it finds. Both clients name the server sections as
KNOWN, or a section that WAS restored would be reported as left in the file.

And the bug this nearly shipped with is the reason to run things: the web
modal's new counter was called `pending`, which **shadowed the ref holding the
chosen file**. The restore itself worked and then `pending.value = null` threw
*"Cannot create property 'value' on number '0'"*, leaving the file and the
password sitting in the modal — the save-without-a-password bug, back. `tsc`
catches that shape on the phone and cannot in a `.vue` file, `check:vue` does
not look for it, and no behavioural check would have seen it. Driving the real
modal in Chromium did.

**The file carries key material at exactly one path**: `wallets[n].mnemonic`,
on a phone backup. Not the passphrase — that is the key, and a key inside the
thing it opens is no key at all — and not an xprv, spend key or scan key
anywhere. `assertNoSecrets` walks the payload on the way out **and** on the way
back in, refusing any key whose NAME looks like key material at any other
depth, and permitting that one by PATH.

The rule was blanket from 2026-11-04 to 2026-11-08, and the argument that
closed it is the argument that reopened it. A phrase inside was redundant while
the file was sealed WITH the phrase — whoever opens it typed the phrase to do
so. It is sealed with the PASSPHRASE now, which the phrase is not, so the copy
is the entire point.

It remains a tripwire on the payload's **shape**, not a scan of its values: a
seed under the key `notes` would pass, which is exactly why each client
ASSEMBLES its payload from a named list rather than sweeping its storage. The
web list is `BACKUP_KEYS`; the phone's surface is bounded by what its collector
imports, which `check:backup` pins to three modules.

**And the exclusions are a TOTAL partition now** (2026-11-08). Asked *"what
else is in the backup that shouldn't be?"*, the answer was nothing — the file
holds `txLabels`, `segwitLabels`, and on the web `swapTxids` and `bitmailPins`,
none of which the server owns. But the audit found that
`thrilla_wallet_keys_v1` and `thrilla_wkey_*`, the LEGACY CryptoJS key stores
still sitting in a long-lived browser, were **absent from `BACKUP_EXCLUDED`** —
the one category that list exists for. Nothing collected them, because the list
above is explicit, and nothing recorded that as a decision either.
`assertNoSecrets` would not have caught them: `FORBIDDEN_KEY` matches
`mnemonic`, `xprv`, `privkey` and the like, and `wkey_…` is none of those.

So `BACKUP_EXCLUDED` now names **every** `thrilla_*` key the app stores, with a
reason, and `check:backup` scans `src/` for the literals and fails on one that
is neither collected nor excluded — a new key cannot be added without somebody
deciding. An entry ending in `_` is a prefix. The scan strips comments first,
because `backupdata.js`'s own prose names `thrilla_notes` as an example and the
check counted it as a real key on its first run: the trap `check:stealth` hit
with `DONT_KILL_APP` and this file hit with `Math.random()`.

Two entries are worth reading for their reasons rather than their names.
`thrilla_device_id` identifies this browser to the trusted-device check, so
restoring one elsewhere would hand a second machine the first one's trust. And
`thrilla_login_attempts` / `thrilla_login_lockout` are the only entries a user
would BENEFIT from restoring, which is exactly why they must not be: a backup
that could clear them is an offline way around the lockout.

**The file is encrypted with the wallet's BIP-39 passphrase** (2026-11-08, on
the user's instruction: *"user must enter passphrase, which encrypts the file,
so no separate password, just the passphrase with which wallet was created"*).

That is the **fourth** key this file has had — a separate password, the
passphrase, the recovery phrase, a password again, and now the passphrase —
and the churn is worth reading as one argument rather than four. Each key was
chosen for what the file held at the time, and the file changed. While it held
labels, a password of its own was right and the phrase was out of proportion
(*"12 words recovery phrase is not what you should be asking for, it should be
a single word which encrypts"*). Once it could bring a wallet back, the secret
that already guards that wallet is the right key for it: it adds no new thing
to lose, it **can be checked** where a password could not, and it comes with a
floor of 12 that a wallet already enforces.

The name `wallet-passphrase` is the one the 2026-11-03 scheme used, on purpose:
both are the passphrase used verbatim, so there is one decrypt path and nothing
to tell apart. What differs is the payload, which says what it holds.

**What the typed-secret checks are now.** A password had none: the confirm box
went on 2026-11-08 (*"drop confirm password field, one field is sufficient"*)
and nothing replaced it but the field being unmasked. A passphrase has a real
one on the phone — it is derived and compared against each wallet, and a wallet
it does not open is left out and named. The web cannot do that and says so.
`validateBackupPassword` still runs in the handler ahead of `encryptBackup` and
judges length alone.

**Neither screen asks for the recovery phrase**, and that still holds: the
phrase is read from the keystore, never typed. Every extra place those twelve
words are typed is another place they can be seen, logged or phished — which is
an argument about the KEYBOARD, not about the file, and it survives the file
carrying a phrase intact.

**It is used VERBATIM** — no trimming, no case folding. Both clients send the
raw string, so cross-client compatibility needs no normalisation to agree on,
which is the half of the phrase scheme worth being glad to lose. Folding would
quietly make `Otter` and `otter` one key: a weaker password than the user
chose, and impossible to explain when it bites. `check:backup`'s test password
is mixed-case on purpose — with a lower-case one, folding on the encrypt side
alone passes every behavioural test and only a source regex catches it, which
is how the first version of that control went green.

**Every earlier scheme stays readable**, and `keySource` in the authenticated
header is what tells them apart. A `recovery-phrase` file (2026-11-04 to
2026-11-08) is normalised — twelve words typed with different capitals or
spacing have to give one key — and a `wallet-passphrase` file (2026-11-03 to
2026-11-04) is verbatim. `normalizeBackupKey` survives for the first of those
and for nothing else. Turning somebody's existing backup into a file nothing
can read is the one outcome this feature may never produce, which is the same
reason argon2id stays readable.

**The restore path asks once and applies no length rule.** The floor is
enforced on write; refusing an older file for failing today's policy would
strand it.

### The web's Settings page is Account, and the dust threshold is not on it

Renamed 2026-11-08, on the user's instruction: *"we should probably rename it
with Account as they are more account settings, except Privacy Dust Threshold
which should be under Wallet"*. What is left on `ConfigView.vue` is the
account itself — trusted devices, password, invites, local key recovery,
closing it — and the nav says **Account**.

The dust threshold was the one thing there about coins. It is now
`components/DustThresholdModal.vue`, off the wallet card's ⚙ menu beside
Backup, and **the phone already had it under Settings → Wallet**
(`screens/settings/WalletPage.tsx`), so this is the usual rule applied rather
than a new idea. It is **account-wide, not per-wallet** — the preference is
stored on the user — which is the same thing the backup modal's copy has to
say about itself, and the same reason the menu is where both live: the Wallets
page is the page about coins, and the menu keeps a secondary control off the
row holding Receive and Send.

It **re-reads the preference on every open** rather than caching it. The
threshold can be changed from the phone, and a value held from the last time
the modal was opened would be a stale number on the one screen whose job is
saying what is in force.

### Where it lives, and the one line both screens say

**On the web it is a modal off the wallet card's ⚙ menu** (2026-11-08, on the
user's instruction), `components/BackupModal.vue`. It was a card on the
Settings page; nothing is left there, because two screens offering one thing
with nothing to say which you last used is the failure that menu exists to
undo. It is **account-wide, not per-wallet** — labels and pinned contacts
cover every wallet, so whichever card's menu opens it, one file is one backup.
The menu is where people look; the copy is what states the scope.

**The password does not survive the modal.** Reported as *"I was able to
restore from file w/o being prompted for password"*. The crypto was never
bypassed — an empty password throws before a key is derived — but the field
sat on the Settings page holding whatever had been typed to SAVE a backup, so
pressing Restore straight afterwards opened the file having asked nothing. A
field that persists across two different operations is a field nobody is
prompted by. It is cleared on open and on close.

**One line, the same line, on both: *"Backs up your labels and contacts."***
(*"text must be really simple: backup labels, contacts"*.) Each screen used to
name its own device — "what only this phone knows", "what only this browser
knows" — which is a distinction the reader does not need and which the web
could not state without saying *browser* on a product that is also a phone
app. `check:backup` refuses either word on either screen, and the phone's
status messages lost "on this phone" with them.

**The red warning is about the password** on both: *"Remember this password.
It is the only thing that opens the file, and no one — including us — can
recover it."*

**Neither screen says where the coins live.** *"Your coins are not in this
file… they live on the Bitcoin network"* went from the web on the user's
instruction and from the phone as a consequence: it was the last line naming
the recovery phrase, and leaving it would undo the point of no longer asking
for one.

**Neither button is ever disabled for missing input**, and that is a fix
rather than a preference. Reported as *"you dropped Restore!! I've backed up
and now I can't restore"* — the Restore button was there, `:disabled` until a
password was typed, so it sat greyed out the moment the modal opened. **A dead
control with no explanation is indistinguishable from one that is not there.**
Both buttons are live now; the handlers say what is missing, and `startRestore`
refuses before opening a file picker whose result it would only reject.

**The password is not masked** (2026-11-08, on the user's instruction). It is a
per-file password with no checksum, typed once, not an account credential —
seeing it is the only way to tell you are typing what you typed before. A
masked field is also how "I can't restore" happens when the file is perfectly
good and the typing was not, with nothing on screen able to say which.

**Both of those are on BOTH clients.** The report came from the web and the
phone carried the same two bindings — `disabled={!!busy || !password ||
password !== confirm}` behind the same two fields, and `secureTextEntry` on
them. `SecretInput` is `LineInput` now, unmasked, and the phone's handlers say
what is missing exactly as the modal's do. `check:backup` pins each on both,
and scopes the mask assertion to that one component, because an app PIN
elsewhere is still a thing to mask.

**Saving closes the modal; restoring does not.** The browser's own download
is the confirmation, so a message left in a dialog the user then has to
dismiss is a step for no information — but a *failed* save leaves it open,
because that message is the only thing that says what went wrong, and
`check:backup` asserts both directions (a close at the end of `doSave` would
satisfy a naive check while throwing the error away).

**The restore says `Restored.` and nothing else.** *"restore text is too long
and meaningless — just say whether restored or not"*, then *"do not say
Nothing new, Restored is fine"*. It reported added, kept, re-matched wallets
and leftovers in one four-clause sentence: every number true, none of them the
question being asked. The added/nothing-new branch went for the same reason —
the file IS restored whether or not anything changed, since a merge that added
nothing still means every label in it is now here. "Nothing new" answered a
different question (how much was already here) and read like a refusal. A
section this client cannot store is still named, briefly, for the reason it
always was.

**Both halves are named wherever the feature is entered**: the wallet card's
menu item, the modal's heading, the phone's Settings row and its page title all
say **Backup & Restore**. Restore is the half somebody goes looking for under
pressure, and an entry point that only offers to save one reads as though there
is nowhere to put a file back.

**If a restore refuses, check what sealed the file.** A backup written between
2026-11-04 and 2026-11-08 needs the RECOVERY PHRASE in that box, not a
password; `decryptBackup` branches on the header's `keySource` and the error
names the case rather than saying the file is broken.

**The restore takes the FILE first and asks for the password second**
(2026-11-08, on the user's instruction: *"when restoring user selects the file
and if the file is encrypted it should ask for a password"*). Pressing Restore
opens the picker and demands nothing: until a file has been chosen there is
nothing to ask about, and a screen that has not seen the file **cannot say
which secret that file wants** — which is the whole of it, because a backup
written between 2026-11-04 and 2026-11-08 wants the recovery phrase.

`inspectBackupFile` is what makes that possible: a read of the authenticated
header fields with no secret in hand, reporting whether the file is readable,
whether it is encrypted, and what to ask for. It is **a read, not a
verification** — nothing in it is trustworthy until the AEAD opens, and a
forged header costs one failed decrypt and nothing else. Its header checks are
`decryptBackup`'s own (`readEnvelope`, shared), so a file the screen offered to
open cannot then be refused by the thing that opens it. A file this build
cannot read is refused **before** a password is asked for, because making
somebody type a secret for a file that was never going to open is the same
mistake from the other end.

**The password field is emptied between operations, at both ends.** Choosing
a file clears it, every time. Opening it with
whatever happened to be typed is exactly the bug that was reported in the first
place — *"I was able to restore from file w/o being prompted for password"* —
and it comes straight back the moment one session saves a backup and then
restores one. The password that seals a new backup is not evidence about an old
file. For the same reason the button row belongs to the chosen file while one
is waiting: Open and Cancel, no Save, which would otherwise seal a NEW backup
under the password being typed to open an old one.

A finished restore clears it too, which is a reported bug rather than
symmetry for its own sake: *"after restoring, I clicked save backup w/o
password and pop up disappeared"* — the field still held what had been typed
to OPEN the file, so Save sealed a new backup with it and closed, having asked
nothing. One field serving two operations has to be emptied between them.

**A failed open keeps the file**, so a wrong password is retyped against what
is already in hand; a successful one drops it.

`check:backup` asserts the password rule runs **in the handler**, before
`encryptBackup`, rather than anywhere in the file. The confirm-guard version of
that check matched the comparison anywhere — which the template's own `v-if`
and `:disabled` bindings satisfied — so deleting the guard inside the save
function left it green. A disabled button is a hint; the handler is the only
thing `encryptBackup` sits behind.

**Three message tones, not two.** Once the screen started asking for things,
`ok`/`error` was not enough: *"This backup is encrypted, enter its password"*
rendered in the green of a finished job reads as though something already
succeeded. Prompts and progress are neutral; green is for outcomes.

**A restore re-keys by sp_address, never by the id in the file.** This is the
bug the objection surfaced. `wallet_id = urlsafe_short_hash()` at create time,
so deleting a wallet and adding the same seed back gives a new id (see "A
wallet id does not survive a reinstall"), and `segwitLabels` is keyed
`walletId -> address -> label`. A restore that trusted the file's id would
file a whole wallet's labels under an id nothing references: no error, no
missing file, just labels that never appear again. So the payload carries
`wallets[n] = { id, title, network, spAddress }` and `remapWalletIds` matches
the two sides on the address, which the same seed and passphrase always
derive. `txLabels` needs none of this — a txid is a fact about the chain.

A backed-up wallet with **no live match is left under its original id** rather
than dropped: the common case is restoring before the wallet is added back, and
an app reinstall (as opposed to a wallet delete) preserves the id anyway, so
the labels attach by themselves.

**The two clients are interchangeable, and that took more than matching
names.** The web's `collectBackup` accepted a wallet list and dropped it on the
floor, so no web backup ever carried one; and its `applyBackup` merged
`segwitLabels` ONE level deep, so a wallet the backup also knew about counted
as "already here" and every address labelled since was silently discarded. The
phone had always merged per address. Both are fixed, `check:backup` exercises
the nested merge rather than reading for it, and a section the other client has
nowhere to put — the web's `swapTxids` and `bitmailPins` — is **reported by
name**, never dropped silently and never an error.

**A restore MERGES, and the FILE wins.** Replacing outright would delete every
label written since the backup was taken, silently and permanently — so an
entry that exists only on the device is left alone. But where both sides hold
the same key, the file's value goes in.

The existing value used to win, on the reasoning that it was the more recent of
the two and the one the user could see. That was wrong, and reported on
2026-11-08 as *"Restore is not restoring — made changes to labels and restored
w/o saving first, but latest values still on screen"*: under that rule a
restore could never undo an edit, which is the one thing somebody restores a
backup to do. Nothing on screen said so either, because it reported "Restored"
over a file none of which had been applied.

What the old rule protected survives the change, because this still merges: a
label written since the backup, for a key the file does not have, is untouched.
What is lost is an edit made since to a key the file DOES have, which is the
definition of restoring it. `added` counts entries actually written and `kept`
the ones already identical — compared, not merely present, or restoring the
same file twice would report changes the second time.

Neither client wraps `<router-view>` in `<keep-alive>` and both label stores
read `localStorage` on every call, so a view entered after a restore shows the
restored values without a reload. That is worth knowing before anyone adds
caching to either.

**scrypt N=2^14, r=8, p=1** — the scrypt paper's own "interactive" parameters,
16 MiB.

It shipped as **Argon2id m=19456, t=2** and that was wrong, reported the same
day as an export that *"never finishes, keeps spinning"*. It had not hung:
Argon2 was still running. Argon2 is built on BLAKE2b, which is 64-bit
arithmetic, and Hermes has no JIT and emulates every 64-bit operation with
pairs of 32-bit ones. scrypt is PBKDF2-SHA256 and Salsa20/8, 32-bit throughout,
and measures **10x faster while using less memory** — 16 MiB against 19.
Argon2id is the better primitive on paper and this is a knowing trade: a key
derivation nobody will wait for is one people turn off.

**The lesson is which machine the benchmark ran on.** Argon2id was chosen on a
V8 benchmark in a container with no Hermes in it. A KDF's cost is the entire
point of a KDF, so measuring it on the wrong engine measured nothing. If these
parameters change again, the number that decides it comes off a phone.

**The KDF is async and reports progress**, and that is not cosmetic either. It
runs for seconds on a phone and synchronously it froze the JS thread — which is
exactly what the report described, the native spinner still turning because
only JavaScript had stopped. `asyncTick` yields every 20ms and both screens
count up.

**argon2id stays READABLE for ever.** A file names its own KDF in its header,
so every backup written before the switch still opens — including the one that
had already been made when this was found. Turning somebody's existing backup
into a file nothing can read is the one outcome a backup feature may never
produce, and `check:backup` builds an argon2id file and opens it to prove it.
The parameters live in each file, so raising them later strands nothing; they
are pinned in the source only for what this build WRITES, and `check:backup`
refuses a reduction because weakening the KDF is invisible — the file still
round-trips.

**XChaCha20-Poly1305, with the header as associated data.** The X variant for
its 24-byte nonce, which is what makes a random nonce per file safe when one
key is reused across exports; a repeated nonce under one key is a total break.
The header is authenticated so the stated KDF cost cannot be edited — without
that a doctored file and a mistyped password would be indistinguishable. A
wrong password and a tampered file give **one message**, because Poly1305 fails
identically either way and naming which would be a guess printed as fact. (The
legacy-file wording above branches on the *header*, which is authenticated and
read before any of this, not on how the failure went.)

**On the phone the file goes through the Storage Access Framework**
(`backup/BackupFileModule.kt`): `ACTION_CREATE_DOCUMENT` to save,
`ACTION_OPEN_DOCUMENT` to restore. No storage permission is asked for and the
app writes nowhere the user cannot reach — the system picker is in front of
them and this process gets a one-off URI for exactly the file they chose. On a
wallet, "needs access to all your files" is a permission worth never asking
for. Hand-written rather than an npm native dependency, like ApkInstaller and
ZxingScanner, because it is two intents and two streams and a dependency is
something F-Droid has to build.

The module **moves a UTF-8 string and knows nothing else** — the encryption
has already happened in JavaScript before it is called, and `check:backup`
refuses it gaining any crypto. Opening filters on `*/*` rather than
`application/json`: a backup that has been through Drive, a chat app or mail
comes back as octet-stream or text/plain routinely, and filtering on the
declared type hides the user's own file from them with nothing saying why. The
content is validated in JavaScript, which is the only place that can really
answer. Reads are capped so that picking a video by mistake fails at once
instead of pulling it through the bridge. A cancelled picker **resolves**
rather than rejecting, because backing out is not an error and must not read as
one, and `pending` is cleared BEFORE the promise is settled so a duplicated
activity result cannot settle one that has moved on — the rule
`ZxingScannerModule` already documents.

`check:backup` EXERCISES all of this rather than reading it, because every
failure here produces a file that looks perfectly fine: a weakened KDF still
round-trips, a payload carrying a mnemonic still restores, a forgeable header
still opens with the right key, and labels filed under a dead wallet id are
indistinguishable from a backup that held nothing. Its own first run failed on
a comment mentioning `Math.random()` — the same trap `check:stealth` hit with
`DONT_KILL_APP` — so it strips comments before any source assertion. And its
"two exports differ" test originally passed with a hard-coded nonce, because
the random salt alone changes the ciphertext; salt and nonce are compared
separately now.

The phone's collector cannot be imported by a check — its label services reach
for the platform keychain — so that half is pinned source-side while the web's
is exercised end to end. The rules they pin are the same ones.

Loading a service with sibling imports from a check needs
`scripts/ts-resolve.mjs` (`--import`), because `src/` uses extensionless
relative imports that Metro and Vite resolve and Node does not. It also maps
the web's `@/…` alias onto `src/`, which Vite resolves through its own config —
without that, a store importing `@/services/backup` is unreachable from a
check, and the alternative is writing one file in the tree differently from its
neighbours to suit the harness. The same constraint bans TypeScript that
erasure cannot remove — `BackupError` declares and assigns its `code` rather
than using a `constructor(public code)` parameter property, which
`--experimental-strip-types` refuses outright.

## The signup form had a bot check that was decorative

The arithmetic question on `/register` — `a + b = ?` — was checked in
`RegisterView.vue` and **nowhere else**. The server never saw an answer and
never asked for one, so anything that skipped the page skipped the check.
`start_registration` is the one public endpoint that creates state for somebody
with no account: it bcrypt-hashes a password, writes a pending row, sends mail,
and answers *"Username or email already in use"* — a membership oracle for any
address worth trying.

**Cloudflare Turnstile is the real one** (2026-10-21), verified server-side in
`helpers/turnstile.py`. Four things about it are load-bearing:

**The check runs FIRST**, before the field validation and the uniqueness
lookups. Placed after them it would protect the bcrypt call and leave the
oracle open, which is the interesting half.

**The SECRET is what enables it**, never the site key — `turnstile_enabled()`
reads only the secret, and `/auth/signup-config` withholds the site key until
one exists. A site key alone renders a widget whose answer nothing verifies:
the form *looks* protected. That is the one combination the admin PUT refuses
outright rather than quietly ignoring.

**It fails CLOSED.** A configured secret plus an unreachable Cloudflare refuses
the registration. Fail-open is a gate whose key is published — knock the
verifier over, or merely sit on a slow path, and the protection is gone exactly
when somebody is pushing on it. The honest cost: no signups while
`challenges.cloudflare.com` is down, or until the operator clears the secret.
An instance that never set a secret is unaffected and runs as it always did,
the same call `payout_address_pin` makes about its environment variable.

**It does not lock the phone out.** `RegisterScreen.tsx` posts at the same
endpoint and renders no widget, because Turnstile is a browser control. So
`enforce` defaults to `"browser"` — a missing token is fatal only for a request
carrying an `Origin` header. That header is set by the client and is therefore
spoofable, which is the shape of the control rather than a hole to plug: this
raises the cost of pointing a script at the public *form*, and is not an
authentication boundary. What bounds abuse for every client is that no account
exists until an emailed link or code comes back. `enforce: "always"` is offered
and the admin page says in as many words that it closes mobile onboarding —
which on mainnet is the only way in.

The arithmetic question **stays** as the fallback for an instance with no keys,
and the two are never rendered together: two challenges on one form reads as a
site that does not trust its own defences. `challengeAnswered` is one
expression over both, so a third kind later cannot leave a path where neither
is required.

A Turnstile token is **single use** — Cloudflare refuses the second
presentation with `timeout-or-duplicate`. So every failure resets the widget.
Without that, a registration refused for a taken username fails the *next*
press for a spent token, and the message names something the user cannot see.

### The terms, and the number that makes agreeing to them mean anything

`/terms` is a route, not a modal: somebody reading before agreeing needs to
open it in another tab and come back to a form that still holds what they
typed. It carries a **version**, `helpers/terms.py` publishes the same one, and
a registration naming any other version is refused. An account is then tied to
the text that was on screen when it was made, instead of to whatever the terms
say later.

That holds only while the two files agree, and they are in different repos in
different languages. `check:terms` pins them, and also pins what the page may
not quietly lose in a rewrite: the **MIT licence** (the software's actual
distribution terms, whose warranty disclaimer is the one in force), the
**recovery phrase** named as the only way back *together with* the sentence
saying nobody here can restore it — a phrase mentioned without that consequence
is a backup instruction, not a warning — and Signet coins called worthless.

Be clear about what the tick box is: an assertion by the client, logged at
registration. Not a signature. A caller posting straight at the API sends
whatever it likes, exactly as it can skip the box. The number is for
record-keeping, not enforcement.

One gap is still open deliberately and recorded rather than papered over: the
**mobile app has no terms screen**, so a client with no `Origin` header may
omit the version; that is a follow-up, not a decision that app users agree to
nothing.

### The rate limiter, and the account creation that was not ours

`register-start` had **no rate limiter** until 2026-11-04. It got one
(`helpers/register_rate_limiter.py`) after ten LNbits accounts appeared on a
live instance with no email address and some with random-character usernames.

**Those did not come through this endpoint**, and establishing that first is
the reason the fix went where it did. `silnt.pending_registrations` has
`email` as its PRIMARY KEY and `confirm_registration` always sets one on the
`Account`, so this path cannot produce an email-less account; and every siLNt
endpoint hangs off `require_trusted_device` → `require_invoice_key`, so an
account with no wallet has no key and cannot reach the extension at all. They
came through **LNbits core's own signup**, which is a second public door
beside this one and which the extension cannot gate. The working path logs
`Email-verified account created: …`, so grepping for an account id is what
tells the two apart.

The awkward part is specific: `start_registration` 403s unless
`AuthMethods.username_and_password` is allowed, and core's own register
endpoint is gated on the **same** flag — so closing core's door by auth method
closes ours too. What separates them is LNbits' "allow new accounts" setting,
which gates core's auth *view* while WhiSPa calls `create_account` directly as
a `lnbits.core.crud` import. Verify that on the running version before
changing it: mainnet onboarding is mobile-app only, so breaking signup there
costs more than junk accounts do.

The limiter is three limits, each for a different attack, following
`scan_rate_limiter.py` and `invite_rate_limiter.py` — in-memory, so the
counters reset on restart, which during an incident clears the attacker's
along with everyone else's.

**Per IP per hour** bounds one source. **Per email address** is a cooldown, so
a rotating-IP caller cannot mail-bomb one inbox — the vector
`invite_rate_limiter` already guards, and the mail is the part of this
endpoint that reaches outside, sent to an address the caller chooses through
the shared SMTP server. **Global per hour** is the backstop and the only one
that cannot be forged: `get_client_ip` trusts `X-Forwarded-For` when present
(correctly — behind Caddy, `request.client.host` is Caddy, and a per-IP limit
built on that would be a per-*instance* limit that locks out every user while
stopping nobody), and that header is client-settable, so if LNbits is ever
reachable without the proxy a fresh value per request defeats the per-IP limit
completely. A limiter one header defeats is the maths question all over again.

Know what the global limit costs, because it is a real trade: it is a way to
**close signups**. Burn the hourly budget and nobody registers until the
window slides, which on mainnet is an outage. It is set far above any honest
rate for that reason. If the instance outgrows it, raise it; do not remove it.

**It is checked FIRST** — before Turnstile, before the field validation,
before the uniqueness lookups. Turnstile is a call to somebody else's service
and the uniqueness lookup is the membership oracle; a local counter is cheaper
than both and is what a flood should hit. Placed after them it would protect
the cheap part and leave the expensive and the interesting parts open, which
is the same argument `turnstile.py` makes about its own position.

**One refusal message for all three**, with which-limit in the log instead.
The per-email limit keys on an address the caller does not own, so a
distinguishable 429 would answer "did somebody start registering this address
in the last minute?" — a small oracle on an endpoint whose whole story is
about not answering those.

And the per-address cooldown is stamped **after the send**, not at the top: a
verification email nobody received must not refuse the retry that would
deliver one.

Note what this does *not* do. Turnstile still bounds only the browser case —
`enforce` defaults to `"browser"` and a script omits the `Origin` header — and
that stays deliberate, because `RegisterScreen.tsx` renders no widget. The
limiter is what bounds the rest.

### Confirming a device sends one email

Reported 2026-11-07: *"confirming a device sends an email that new sign in
attempt, but there is no email with the code"*.

`/auth/device-request-confirm` was sending **two** emails back to back to the
same address — the six-digit code, then *"New device sign-in to your wallet —
someone may have your password"*. The second is an answer to a question the
user had just answered the other way: they pressed the button that says this
device is theirs.

It was misplaced rather than misconceived, and the source said so before
anyone looked at the mail. The block carried its own comment — *"This endpoint
is CHECK-ONLY: it never sends a confirmation email … The confirmation email is
sent only when the user explicitly asks, via /auth/device-request-confirm"* —
which describes `device-check` while sitting inside request-confirm; and
`should_send_login_alert`'s docstring says its dedupe exists to *"prevent
spamming the user when an untrusted device repeatedly hits device-check"*. Both
entered in one commit (`475e086`, whose subject is about PayJoin contacts), so
it had been in the wrong handler since the day it was written.

The alert now lives in `device-check`, which is the only endpoint that
actually observes an untrusted sign-in. Three things make it safe on a polled
endpoint: the 12-hour dedupe on `(user, sha256(ua|ip))`, which is what it was
written for — `PendingDeviceView` polls this on mount and `LoginView` calls it
on every sign-in; a guard on the account **already having** a confirmed device,
since a new account's first sign-in is by definition from an unconfirmed one
and warning somebody about their own new account is the noise that teaches
people to ignore the real alert; and a `try/except`, because the caller asked
"is this device trusted" and that question still has an answer when the mailer
is down. `device-check` stays check-only in every other respect — no code, no
device state.

**The ordering also proved something about the missing mail.** The alert was
sent *after* the code, and a failed code send raises 500 before reaching it.
So receiving the alert means the code's send call returned ok — it was accepted
by the mailer and then not delivered. Two messages to one address in one
request is the likeliest reason, and that is now gone; if it recurs, it is a
delivery problem and `Device code email failed` in the instance log is where
it shows.

`tests/test_device_confirm_one_email.py` pins one email from confirm, the
alert's new home with all three guards, and that no handler claims to be
check-only while sending a code — the comment contradiction is what found
this, and it is what review reads instead of the code. Seven of its ten
assertions fail against the old handler. Its own first run failed on the
comment explaining the fix, because that comment quotes the alert's subject
line, so it strips comments (by `tokenize`, since a `#` inside an email body
is not one) before asserting on source — the trap `check:stealth` hit with
`DONT_KILL_APP` and `check:backup` with `Math.random()`.

## F-Droid, and the two proprietary blobs in the APK

`FDROID.md` carries the steps. Three things belong here because they constrain
unrelated work.

**The signing certificate is the app's identity.** The official f-droid.org
repo signs with ITS key, which makes the result a different app to Android:
nobody on an existing install can update to it, and for a wallet a reinstall
means restoring from the recovery phrase. That is why the chosen route
(2026-10-24) is a **self-hosted F-Droid repo**, which keeps our key, so an
install from GitHub, Zapstore or F-Droid all update each other. Same reasoning
as the applicationId note in `zapstore.yaml`.

**`WHISPA_NO_PUSH=1` drops Firebase** from the native build —
`react-native.config.js` turns it into an autolinking exclusion, `npm run
apk:fdroid` sets it. The npm packages stay installed so the JavaScript
resolves; what goes is the native side.

`services/push.ts` therefore has **no static import of
`@react-native-firebase/messaging`**, and must not regain one: a static import
resolves fine and then throws "a firebase module that's not installed
natively" at the first call, on launch, naming a library the user has never
heard of. It asks `NativeModules.RNFBMessagingModule` instead — the question
is "is the native side here", and a build flag can disagree with the APK while
that cannot. Settings → Notifications renders "Alerts unavailable in this
build" rather than a switch storing a preference nothing can honour.

**MLKit is gone from the Android APK** (2026-10-24). It came through
`react-native-camera-kit`, whose Android side depends on
`com.google.mlkit:barcode-scanning` — `libbarhopper_v3.so` and `.tflite`
models. Android now scans with **ZXing**
(`com.journeyapps:zxing-android-embedded`, Apache 2.0) through
`scanner/ZxingScannerModule.kt`, registered by hand in `MainApplication`
beside `ApkInstallerPackage`.

**camera-kit is excluded from ANDROID autolinking only, and the asymmetry is
deliberate.** Its podspec depends on `React-Core` and nothing else: the iOS
decode is AVFoundation's and MLKit was never on that side, so excluding both
platforms would have thrown away a working, already-free scanner to solve an
Android packaging problem. `components/QRScanner.tsx` branches, and its
contract to callers is unchanged — renders on `visible`, calls `onScanned`
once with a trimmed string, then `onClose`.

Two consequences worth knowing. **ZXing opens its own Activity**, so on
Android the scanner is ZXing's screen, not our Modal with the frame overlay —
`DecoratedBarcodeView` in a custom ViewManager would have matched the old look
and meant owning a camera lifecycle on the screen that starts every send. And
**camera-kit must not be imported statically** in `QRScanner.tsx`: on Android
the import resolves and hands back a native module that is not linked, which
is the same failure the Firebase import had.

**The scanner reports chased three different causes, and only one was real
so far.** Worth the whole sequence, because the pattern is the lesson:

1. "Will not read a QR off a monitor" → I tuned the camera (continuous focus,
   SCENE_MODE_BARCODE, metering) and added the `TRY_HARDER` hint. ZXing's
   defaults genuinely are weaker than MLKit's on a backlit screen, so this
   looked right.
2. Still broken → the actual bug was in **JavaScript**: `SendScreen` passes
   `onClose`/`onScanned` as inline arrows, they were in the launch effect's
   dependency array, and any re-render of that screen ran the effect's
   cleanup and made the in-flight scan discard its own result. The scanner
   read the code and threw it away. Callbacks are in refs now and the effect
   depends on `visible` alone; `check:fdroid` pins both halves.
3. Still broken, now with the failure paths made loud (each names itself in
   an Alert) → **the camera screen appears and the decode never fires**, with
   no alert. So launch, module and permission are all fine.
4. Reverted the step-1 tuning to isolate it → **stock decoded nothing either.**
   So the tuning was not the cause, and four builds had now ruled out nothing,
   because step 1 changed four things at once (continuous focus,
   SCENE_MODE_BARCODE, metering, and `fullSensor` in the manifest) and the
   revert put all four back at once.
5. **A device logcat, which is what should have happened at step 3.** It ended
   the guessing about the camera.
6. **The QR itself was inverted, and that was the whole bug.** Six builds
   went into the camera and the camera was never wrong.

**What the logcat settled.** `CameraPreview: Starting preview` is the line
immediately before `previewActive = true; previewStarted()`, and
`BarcodeView.previewStarted()` calls `startDecoderThread()` — with the mode
already SINGLE from `CaptureManager.decode()`. A second camera stream
(`YCbCr_420_888`, `CPU_READ_OFTEN`) is configured 0.4s later, which is the
decoder asking for its first frame, and ~380 frames are delivered over the 13
seconds the screen is open. `DecodeHintManager: Hints from the Intent:
{TRY_HARDER=true}` confirms the intent is parsed. No exception anywhere.

So **the decoder runs, frames reach it, and it cannot read them.** Not the
wiring, not the module, not the permission, not the intent: the image.

And the same log names the one image setting we control:

```
CameraConfiguration: Requesting focus mode value from among: [auto]
CameraConfiguration: Supported focus mode values:
                         [auto, macro, continuous-video, continuous-picture]
focus-distances=Infinity,Infinity,Infinity
```

A list of one is `CameraConfigurationUtils.setFocus` taking its
`FocusMode.AUTO` branch, the library default. Under Camera1 `auto` moves the
lens only when something calls `autoFocus()`, which `AutoFocusManager` does
about every two seconds, and the lens reports as parked at infinity — which
will not resolve a dense QR at reading distance. MLKit ran through camera-kit
with continuous focus.

**So `WhispaCaptureActivity` came back, with continuous focus and nothing
else**, and the manifest mirrored the library's own `sensorLandscape` rather
than the `fullSensor` of the first attempt — for that one build only, so the
focus mode was the sole variable (it is `fullUser` now; see below). That is
the one combination step 1 never tested, because the scene mode it set
alongside can make focus mode read-only.
Whether it took is visible in the log without reading any code: the same line
should become `[continuous-picture, continuous-video, auto]`.

`TRY_HARDER` stays — it is an in-library decode hint passed as an intent
extra named after the `DecodeHintType`, and cannot affect the camera.

**One setting per build, each confirmed to still read at all**, and
`check:fdroid` now counts them rather than trusting review: it fails if
`WhispaCaptureActivity` assigns more than one `settings.*`, and raising that
number is the deliberate act that adds the second variable. It also checks
that the Activity the module launches is declared in the manifest, because
`startActivityForResult` on an undeclared one throws
`ActivityNotFoundException` and nothing in the Kotlin says so.

### And then the actual cause, which was never on the phone

Continuous focus shipped and the scanner still read nothing — but now with
**yellow dots and the red line showing**. Those dots are
`possibleResultPoints`: the decoder running, processing frames, and reporting
candidate finder patterns. A decoder that gets that far is not being starved
of focus.

What it was: **`QrModal.vue` drew the web app's receive QR as orange modules
on near-black**, to match the card behind it.

```js
color: { dark: '#f97316', light: '#080b0f' }   // luma 137 on luma 11
```

The modules the spec calls **dark were the bright ones**. The code was
inverted. MLKit reads inverted QRs natively; **ZXing decodes dark-on-light
only**. So the app stopped being able to read its own receive QR at exactly
the moment the scanner changed, and every symptom followed from that.

Proven with no camera in the loop: render that colour pair perfectly and
noise-free, hand it to ZXing's own decoder, and it fails with
`NotFoundException` with and without `TRY_HARDER`, at 2- and 4-module quiet
zones alike. Swap the two colours and it reads first try. The cost of not
doing that check at step 1 was six builds.

**Both ends are fixed.** `QrModal.vue` renders black-on-white with a 4-module
quiet zone, matching the phone's own renderer — a QR is a machine-readable
artifact that strangers' scanners have to read, and a wallet address QR that
only one reader can manage is an interoperability bug, not a theme. And the
scan intent now carries `Intents.Scan.SCAN_TYPE = MIXED_SCAN`, so
`DefaultDecoderFactory` builds a `MixedDecoder` that alternates normal and
inverted frames — because fixing `QrModal` does nothing for a web build
already deployed, or for the next wallet that styles its QR the same way.

`check:qr` pins the polarity, the contrast and the quiet zone on both clients,
and refuses a phone caller passing its own colours. None of this is a build
error, a lint error, or visible to review: the inverted QR rendered cleanly
and looked exactly like a QR code.

**The lesson is the order.** Every symptom pointed at the reader, so six
builds went at the reader. Nobody looked at the thing being read, and it was
the one artifact in the loop that could be tested in ten seconds with no
device at all.

The camera changes from that hunt stay, because each is defensible on its own
and one setting per build is cheap: continuous focus (the device offers
`continuous-picture` and ZXing's default asks only for `auto`) and
`TRY_HARDER`. Neither is *validated* as necessary — if the scanner ever
misbehaves again, they are the first things to take back out.

**And the scanner is portrait now.** `WhispaCaptureActivity` is declared
`fullUser`, not the library's `sensorLandscape` — a phone held upright was
getting a sideways, stretched preview, reported as "wide perspective, as if
it has been auto rotated". The manifest mirrored `sensorLandscape` for exactly
one build so that focus mode was the only variable while the scanner was being
bisected; that is over.

`fullUser` rather than `fullSensor` because it honours the device's rotation
**lock**, so the scanner behaves like every other screen instead of spinning
when somebody tilts a phone they deliberately locked upright.
`CaptureManager.lockOrientation()` pins whatever it launched in, so the
preview cannot flip mid-scan either way.

It also decodes better, which is the part worth remembering: ZXing's framing
rect insets 10% and then squares itself off, so landscape fed the decoder a
2196×864 letterbox and portrait feeds it an 864×864 square — a third of the
pixels per attempt, in the shape a QR actually is.

`check:fdroid` pins all of it, and it is all **source-side** — config files
read, conclusions drawn. Only an APK shows what shipped, so the
**`fdroid-blobs` CI job** builds `npm run apk:fdroid` and looks inside one:
no `.tflite`, no `libbarhopper_v3.so`, no MLKit native library. By hand it is
`unzip -l app.apk | grep -E '\.so$|\.tflite$'`.

Three things about that job are deliberate. It **proves the listing is real
before asserting anything is absent** — every check in it has the form "X is
not here", and the way those pass by accident is by inspecting nothing, so it
first requires 100+ entries and a React Native `.so`. It carries **no
keystore and no Firebase secret**: the artifact is release-built but
debug-signed and must never be published, and handing the no-push build a
`google-services.json` would test the opposite of the point. And the
**non-free classes in the dex are reported, not enforced** — the self-hosted
repo has no policy about those, that only binds an f-droid.org submission,
and a check nobody has seen the output of should not go red on its first run.

The repo had **no LICENSE file** until 2026-10-24, while asserting MIT in the
README, both zapstore manifests, `TermsView.vue` and `check:terms`. F-Droid
requires one and GitHub showed none.

`fastlane/metadata/android/en-US/` is the metadata tree, in the layout F-Droid
and Zapstore both read. Its changelog file is named for the **versionCode**
(`major * 10000 + minor * 100 + patch`, so 0.5.0 is `500.txt`) — one named
after the version string is silently ignored.

## It is a native SegWit address, and calling it "Plain" said nothing

Renamed on 2026-10-05, in both clients. "Plain" named it by what it is *not*,
which is no help to somebody trying to reach those coins in another wallet.
It is a standard **BIP-84** chain — P2WPKH, `bc1q…`, at
`m/84'/coin'/0'` (`services/derivationPaths.ts`) — so the title, the Receive
segment and every user-facing string say **SegWit**. The code keeps its
`plain` names: it is the same chain whatever the label reads.

**BIP-84, not BIP-85**, and the difference matters to someone recovering
funds. BIP-85 derives child *seeds* from a master one; these addresses hang off
the wallet's own seed on the standard path, so any wallet that takes a recovery
phrase reaches them. Somebody hunting for a BIP-85 option would not find their
coins. `check:plain` bans the string.

The card's copy is the **instruction without the reasoning**: "Use each address
once." It used to carry "so nothing links them", which puts an explanation of
privacy in front of the thing that has to land.

**Two buttons, not three.** Copy and New address; Refresh came off, because
three of them at phone width is a row of cramped stubs. The chain is re-walked
on mount, after a send, and when the foreground watcher finds the totals
changed — `usePlainWatch` publishes through `plainStatus.observe`, and the card
re-walks off `observedAt`. That counter is **separate from `refreshTick`** in
both directions, and both halves are load-bearing: the watcher's own effect
depends on `refreshTick`, so bumping that from inside it would poll forever;
and the card publishes its own walk through `set`, which must not bump
`observedAt` or the card would read its own result as news and walk again.

The button was raised as a way to poke the server, and that was right — but
**removing a button is not a server-side limit**. `GET /api/v1/plain/{id}`
opens a chain-index connection per call and had no cap of any kind, so
`check_plain_preview_allowed` now holds it to 30 a minute per user, checked
**after** ownership so a stranger's refused request cannot spend the owner's
allowance. Ordinary use is four calls.

The web dropped its Refresh button too, once `PlainAddressPanel.vue` got a
watcher of its own — the same five minutes, since it had only `onMounted` and
removing the button before that would have left no way to re-check. Its three
guards are each a bug if they go. It must not poll **under an open send
modal**, because `PlainSendModal` takes `chain` as a prop and builds a
transaction from the coins in it. Not a **hidden tab**, which is waste against
a limited endpoint and throttled by the browser anyway, so the interval it
claims is not the one it gets. And not **on top of a walk already running**,
which spends two of the thirty and can land out of order. The
visibility catch-up sits behind the same five-minute floor, recorded in
`refresh()` so every walk counts: without it, alt-tabbing is a Refresh button
with no label on it.

## Two pockets, one balance — and what that does NOT make them

Reported 2026-10-06: spending the SegWit chain lived on the **Receive** tab,
inside the card that hands out the address. Going to Receive in order to send.
So the paying half moved to Send, under a chain picker beside the Silent
Payments form (`components/SegwitSendPanel.tsx`), and the card keeps the half
it is named for. The picker only appears when there is something on the SegWit
side — a second option that is always empty is a question nobody needs asked.

**One form, and the coin rows are the only branch.** This was two panels for a
day — on the reasoning that a form doing both would branch at every field —
and that was wrong: it meant two of every control. The recipient, the amount
and its slider, the fee tiers, the summary, Review and the review step itself
are the same controls whichever side pays. What differs is the coin list (an
SP coin is an outpoint, a SegWit holding is an address that spends every
payment under it at once), the builder, and the broadcast.

Three things the shared form has to count in **inputs, not rows**: the fee,
the coin-merging warning, and the review's coin count. One SegWit address
holding three payments links three coins on chain exactly as three SP coins
do, and counting rows would skip the warning for the case that most needs it.
`selectedInputCount` is that number on both clients. Selection keys are
prefixed (`sw:<index>`) so a leftover from one side could never be handed to
the other's builder, and flipping clears the selection and the amount anyway.

**The balance is the sum.** "How much have I got" has one answer, and the
SegWit coins used to sit below the balance in a banner reading "held
separately from this balance" — true about how they *spend* and useless as an
answer to what you own. The banner now carries only **arriving** coins, which
are in no total and whose card is on another tab.

**The split was taken off the headline on 2026-10-23**, on the user's
instruction: it had been named directly under the balance on both clients —
`WalletsView.vue`'s card badge and `WalletScreen.tsx`'s headline — and both
lines went.

Know what that cost, because the reason it was there never stopped being true:
the two pockets cannot go into one transaction. A Silent Payments send draws on
SP coins and a SegWit send on the BIP-84 chain, so the headline total can
promise an amount the Send screen then refuses. What keeps that survivable is
that the Send screen's chain picker only appears when there IS something on the
SegWit side, and flipping it re-derives the spendable figure — so the refusal
arrives with the two balances visible rather than as a bare error. If this ever
gets reported as "it says I have X and won't send X", that is this trade, not a
bug.

**The web brought it back as tabs on 2026-10-29**, asked and confirmed first,
because the SegWit side had a second problem the removal made worse: its panel
was the LAST thing on the wallet card, under the labelled addresses and the
Receive explainer, so the pocket nobody mentions was also the hardest thing on
the page to find. `WalletsView.vue` now has a two-tab control per card —
Silent Payments and SegWit, each showing its own figure — with the header badge
still the sum.

That answers the 2026-10-23 objection by shape rather than by omission: the
card still LEADS with one total, and the split is a figure you choose to look
at rather than a second number under the headline. The honest cost is that the
two clients now disagree: `WalletScreen.tsx` is untouched and still shows the
sum alone, which is the usual rule ("a rule enforced in one client usually
belongs in the other too") deliberately not followed, pending whether the tabs
stay.

**Those panels are `v-show`, and that is load-bearing.** `PlainAddressPanel`
is what reports the SegWit balance up to the card, and the header badge adds it
in. A `v-if` would unmount it whenever the SP tab was selected, the emit would
stop, and the headline total would silently fall back to the SP side alone —
no error, no blank space, just a wrong number on the page that exists to say
what you own.

Coins keeps the breakdown on both clients: `CoinsScreen.tsx`'s stats row and
its **SegWit addresses** section, `UtxosView.vue`'s equivalent.

**The wallet card's secondary actions live behind ⚙ Settings** (2026-10-29,
web only). Seven buttons wrapped onto three lines, which left Receive and Send
— the two anyone opened the page for — no more prominent than Delete. Edit,
Background and Delete moved into a per-wallet menu; `Receive`, `Send`,
`Refresh` and the ⚙ stayed in the row.

**Recover Keys deliberately did NOT move.** It renders only when the keys are
missing, and the badge in the header tells you to click it by name. A recovery
affordance behind a menu is one nobody finds at the moment they need it, and
burying it would also make that badge's own wording wrong.

The menu closes on a click anywhere outside through a fixed backdrop element
rather than a document listener — nothing to add on mount and remove on
unmount, so it cannot outlive the card. Every item goes through `fromMenu()`,
which closes before acting: an item that opens a modal and leaves the menu
hanging over it is the failure that pattern exists to prevent.

**Labels, not freezing**, and the distinction is the point. Freezing is a
defence against coins you did not ask for: a dust attack arrives unannounced
and refusing to spend it is the answer. A SegWit address is one you handed
somebody on purpose, so there is nothing to defend against — what is hard is
remembering *which* somebody, six payments later.

`services/segwitLabels.ts` is **device-only**, for the reason
`services/txLabels.ts` already gives: a server-side map of address to "who I
gave it to" is exactly the deanonymisation risk this wallet exists to avoid,
and worse than a txid because the counterparty holds the address too. The
server is never even told these coins exist. Keyed on the **address string**,
not the derivation index — the index is internal bookkeeping that moves if the
chain is re-walked from a different account; the address is the thing that was
given away. Wiped by the duress PIN with the keys.

Every count and total that includes one side must include the other, on both
clients: the web's Coins page reported **7 coins where the phone reported 8**
for the same wallet, because its stats counted only the Silent Payments side
(2026-10-06).

**Spendable means unfrozen**, and the label says so on both. A frozen coin is
unspent and confirmed and still not money you can send — the send path
excludes it, so a figure that counted it promised an amount the form would
then refuse. The web said "Confirmed Balance" and counted everything; the
phone's own two stats disagreed with *each other*, the sats excluding frozen
and the coin count not. Both now exclude it, both are labelled **Spendable**,
and both print what is held back beside the total rather than folding it in —
frozen coins vanishing from every figure on the page is how somebody concludes
their money is gone.

Which made the web's **missing frozen filter** a real gap rather than a
cosmetic one: once the stats stopped counting those coins, nothing on the page
led to them at all. `'frozen'` is a FLAG on an unspent coin, not a
`utxo_state`, so it needs its own clause — filtering on the state would match
nothing and read as "you have none" rather than "that is not how this is
stored". Both clients offer it now.

A SegWit row shows **no derivation index**. It read `#6` beside the address and
meant nothing to anybody: internal bookkeeping, and bookkeeping that *moves* —
re-walking the chain from a different account renumbers it, which is the same
reason the labels are keyed on the address. The address identifies the row.

Still shared between the clients and still arguably wrong: neither excludes a
coin a live Tango holds (`tango_reserved`) from these stats, though the send
path does. They agree with each other, so it has not bitten; it would overstate
by the size of a round in flight.

**Both clients**, which is the rule for anything like this. The web's
`SegwitSendPanel.vue` sits on `SendView.vue` under the same picker,
`PlainAddressPanel.vue` lost its send modal, `WalletsView.vue` adds the two
balances in the card badge, and `UtxosView.vue` grew the label section.
`stores/segwitlabels.js` is the localStorage half, beside `txlabels.js`. Two
differences worth knowing: the web's picker is gated on the wallet *having* a
SegWit chain rather than on its balance, because gating on the balance would
need a walk before the panel that does the walking has mounted; and the wallet
card takes the total from the panel's `balance` emit rather than walking again,
since the preview endpoint is capped at thirty a minute.

The in-app banner for an arriving payment used to say "a payment to your plain
address… Open Receive to view it", which named an internal distinction nobody
asked about and pointed at a tab that no longer holds these coins. It says what
happened and stops. The arriving-coins banner on Wallet lost its **View**
button for the same reason: the payment is a pending row in Recent
transactions directly below it, and a button that navigates away from the
answer is worse than no button.

**A SegWit send has to be registered as pending by the client**, because
nothing else will. The server never lists these — it does not hold the coins —
so `pendingSends` grew a `'segwit'` kind beside `'plain'`, exempt from the
server-list eviction for the same reason: a list that can never contain it is
not evidence it confirmed. Without it the money left the balance with no row
to say where it went until the next chain walk (reported 2026-10-06).

Freeze for SegWit coins was built and then removed the same day, before it
shipped. The decision not to store these coins server-side was taken
deliberately (2026-10-06) and is why there is nowhere to put a freeze flag:
`silnt.utxos` holds the SP wallet's coins and `helpers/plain.py::scan_addresses`
reads SegWit ones live from Fulcrum, keeping nothing.

## A wallet id does not survive a reinstall

`wallet_id = urlsafe_short_hash()` at create time, so removing a wallet and
adding the **same seed** back is a new id for the same wallet. Anything keyed
on it loses that wallet's past. The user id survives, because the LNbits
account does.

Both halves of one bug, reported 2026-10-05 after a mainnet wallet was removed
and re-added. `list_tango_rounds_for_user` and `_tango_role` were keyed on the
user and kept working, so the round was on the Tango screen and a plain send in
the transaction list, which is where `get_tango_txids_for_wallet` was keyed on
the wallet. Round `7e180d9e…` read **"Sent -384"** — both sides of a mix put in
and take back the same amount, so the net is the fee share. That is what a mix
looks like once nothing names it.

The other half: a `tango_rounds` row is **one record shared by two wallets**,
and `delete_silnt_wallet` deleted it outright, so removing a wallet took the
**partner's** Tango history with it. `purge_tango_side` redacts one side
instead, and only two columns — `a_inputs`, which maps the transaction's inputs
to this wallet's coins and is the one thing on the row not already public, and
`a_wallet_id`, emptied so the labelling sweeper stops chasing coins in a wallet
that no longer exists. A round that never reached the chain is still deleted:
nobody's money moved, and leaving it would hold the partner's coins reserved
against a wallet that is gone. Only an **account** deletion takes the user id
and username, and only once both sides are gone does the row go.

Nothing recovers the rows already deleted this way. Going forward, both sides
keep the round.

## The resume point

`wallets.last_scan_height` is one claim: **every block up to here has been
looked at.** Nothing in either app can tell that it is wrong — a wallet whose
resume point is too high reports itself fully scanned while a payment sits in
a block nothing ever read. Two rules keep it honest, and both were broken
until 2026-10-03, when a mainnet balance had to be repaired by editing this
column by hand.

**It starts one BELOW the range.** `last_scanned_height = start - 1`, because
nothing has been looked at yet. It used to start at `start`, which claimed the
first block was scanned before anything had scanned it: a scan that read
nothing — the first block unindexed, or stopped before the first batch — wrote
that block as done and the next scan began above it. Skipped for good.

**It only ever moves forward.** `set_last_scan_height` is a guarded `UPDATE`
(`WHERE last_scan_height IS NULL OR last_scan_height < :height`), in one
statement so two scans finishing at once cannot have the slower one's older
value land last. Scanning an EARLIER range does not make the claim less true,
so a deliberate rescan must not rewind it — the next scan would redo
everything above, which on mainnet is hours.

That second rule is what makes a rescan control safe to offer at all, and the
phone now has one: a lookback chooser on the scan panel inside Receive, live
**even when the wallet is up to date**, because that is exactly when somebody
needs it — a payment that never appeared is in a block the wallet believes it
has already read. Before it, the phone computed its range and never offered
the fields, so "Up to date" disabled the only button and there was no way
back. The web has had editable From/To all along.

It asks in **days (1 / 3 / 5 / 7) or a specific date**, not blocks. It offered
block counts with "about a day" printed beside each, which is the conversion
done in the user's head off a label; somebody whose payment never arrived
knows when it was sent. `services/scanLookback.ts` does the arithmetic and
`check:scan` pins it.

**Two separate limits, and keeping them apart is the whole of it.**

**How far back** a start date may sit is the **oracle's own indexed floor** —
`min_scan_height`, reported with its block time by
`GET /api/v1/blocks/indexed-range`. Not a number of days: an instance that
started indexing last month and one holding all of mainnet are both normal,
and the client cannot guess which. A date below that floor is a 400 from the
scan endpoint, and one just above it reads blocks the oracle cannot answer
for, which comes back as a scan gap rather than as an answer. When the
explorer cannot give the floor's block time, **no calendar is offered at all**
— a floor nobody knows is not a floor to invent.

**How wide** the scan is, from wherever it starts, is `MAX_WINDOW_DAYS` — a
week. A rescan is a search for one payment somebody is waiting on; a month of
blocks is hours against a shared oracle to find something sent on Tuesday, and
the web app's From/To fields are the tool for the other question. The cap is
on the **arithmetic**, not only on what the UI offers. `windowFrom` places a
week from the chosen start and clips at the tip; `rangeFor` anchors a day span
on the tip instead.

The date is a **month grid** (`components/MonthPicker.tsx`), because a start
date may sit years back. It began as a free-text field and somebody typed 2021
— five years of a chain the indexer does not hold. A grid cannot offer a day
that is not there; days outside the range render faint and inert rather than
hidden, or the month before the floor would be blank with nothing saying why.

**A picked date is resolved by the server**, not here:
`GET /api/v1/blocks/height-at?ts=` bisects real block timestamps
(`helpers/blocktime.py`, ~20 probes on mainnet, cached). The client's
arithmetic is tip-anchored and drifts by **months** over years — at nine
minutes a block, five years back overshoots by about five months, and a
seven-day window placed five months early is the wrong window, not a rounding
error. The search answers with the first block **at or after** the timestamp
and then steps back over a slack of blocks, because a window starting before
the chosen day still contains it and one starting after it does not — and
block timestamps are not monotonic, since consensus only constrains
median-time-past. An explorer that cannot answer a probe gives a **503, not an
estimate**. The client sends unix **seconds** off its own local midnight, so
the timezone never leaves the phone.

The one rule on the client arithmetic is that **it must overshoot.** A
rescan's only cost is the blocks it reads, because the resume point never
moves backwards — but a range one block short of the payment reports nothing,
which is what the scan that missed it already did. So blocks are planned at
nine minutes against a target of ten, above every sustained real-world rate,
and every day span covers at least its nominal width.

Three pieces of date arithmetic are pinned because each is quietly wrong the
obvious way. A date is parsed at **local** midnight and round-tripped through
`Date`, since `new Date(2026, 1, 31)` is the 3rd of March — built from parts
it accepts the 31st of February. `shiftMonth` anchors on the **1st** before
stepping, or October + 1 month lands in December. And a month's length comes
from **day 0 of the next month**, which is what stops February being a special
case. Weekday and month names are local arrays, not `Intl`, which Hermes may
not carry — a missing `Intl` throws at render.

A selection whose lookup has not landed **disables the button**, and the held
range is only used for the day it belongs to, so a stale one cannot be scanned
under a day that has since changed.

Separately, a block the scan could not read holds the resume point below it
and is reported as `gap` on the progress record, so neither client claims the
wallet is up to date while there is a hole in it. See
`tests/test_scan_gap_is_reported.py` and `tests/test_resume_point.py`.

### The catch-up banner scanned the same blocks twice

Reported 2026-11-07, web only. The banner on Wallet said "N blocks behind";
the user pressed **↓ Receive**, which goes to `ScanView` — whose heading is
*"Receive Payments"*, and that is the whole reason the report calls it the
Receive page — scanned there, came back to Wallet, pressed **Scan now** on the
banner still sitting at the top, and it scanned the same range again.

**Both halves were module-level state in a composable.** `loginScanPrompts`
and `_evaluated` live in `composables/useLoginScan.js`, not in the component,
so they outlive the route. Nothing dropped a prompt when the gap was closed
somewhere else, and `_evaluated` then stopped `evaluateLoginScan` from ever
recomputing it — so the banner kept rendering a gap that no longer existed,
over a `fromHeight` captured before the scan that closed it. The only visible
symptom was that the second scan took as long as the first.

Two fixes, and the second is the one that makes it a property of the code:

**A scan started anywhere resets that wallet's evaluation.** `scanWatchWallets`
is the signal every scan already raises — `ScanView`, `App.vue`'s post-send
change scan, and `_startBackgroundScan` all call `notifyScanStarted`. The
watcher resets on ENTRY and on EXIT: entry kills the stale banner as the scan
starts, exit forces a fresh evaluation once it finishes, so a scan that only
partly closed the gap prompts again with the real number rather than going
quiet.

**`acceptLoginScan` never trusts the snapshot.** The watcher only fires for
scans on this client; the gap can also close through the server-side
background scanner, another browser or the phone, with no signal here at all.
So it re-reads `last_scan_height` before scanning anything, takes
`max(live, snapshot)` — `set_last_scan_height` only moves forward, so an
earlier range cannot make the wallet more scanned and is pure cost against a
shared oracle — and says "already up to date" rather than starting a no-op
scan. It also refuses to stack on a running scan, which `evaluateLoginScan`
had always done and the path a user actually presses never did.

Both lookups are best-effort: if the wallet list or the tip cannot be read it
falls back to the snapshot, which is exactly the old behaviour and no worse.

**The phone does not have this bug**, and the difference is worth knowing.
`hooks/useCatchUpScan.ts::accept` reads `wallet.last_scan_height` off the
current prop rather than a value frozen at prompt time, and its `status` is
component state, so it cannot survive a remount the way a module-level ref
does. What it does share is that `evaluated` is not cleared when a scan starts
elsewhere, so it will not re-prompt in the same session — milder, and
arguably the documented intent ("runs at most once per wallet per session").

`check:catchup` EXERCISES the composable rather than reading it, with the
three modules it reaches outside itself stubbed in
`scripts/_loginscan-stubs.mjs`; `stores/scanwatch` is deliberately real, since
the signal it carries is half the fix. Against the unfixed composable it
reports ten failures, including the reported symptom by name. Nothing in the
build, `lint` or `check:vue` could see any of it — stale state in a module
scope is not a syntax error, an undefined identifier, or visibly wrong.

`lint` is two rules, not a style pass: `react-hooks/exhaustive-deps` and
`rules-of-hooks`. It had no config at all until 2026-09-24 and so had never
run — which is how a `useCallback` that read `network` without listing it
shipped. The closure kept the `useState` default for the life of the screen,
the mainnet app asked the server about signet, and the network check passed
for the exact case it was written to refuse. Typechecking cannot see it and
review kept missing it, twice.

The whole tree passes it, so a finding is yours. Prefer narrowing the value
over suppressing the rule — an effect that wants `wallet.id` should depend on
an `id` binding, not on `wallet` — and add rules only when you are willing to
fix what they find.

None of these touch the Android native code. `android/app/src/main/java/…/updater`
is only compiled by a real Gradle build, so a change there needs one:

```bash
npm run apk:signet          # or apk:signet:lowmem
```

`check:signing` holds `src/services/spSign.ts`, `src/services/plainSign.ts`,
`src/services/spPayjoin.ts` and `src/services/chains.ts` to vectors generated
from the backend's own code. Both apps now build and sign every send on the
device, so a change to a fee formula, an output ordering or a derivation —
**on either side** — needs the vectors regenerated:

```bash
cd ../siLNt
python3 helpers/_client_signing_fixtures.py > fixtures/client-signing.json
python3 helpers/_plain_signing_fixtures.py  > fixtures/plain-signing.json
python3 helpers/_payjoin_sp_fixtures.py     > fixtures/payjoin-sp.json
python3 helpers/_chain_guard_fixtures.py    > fixtures/chain-guard.json
python3 helpers/_tango_change_fixtures.py  > fixtures/tango-change-payout.json
```

The last one is the routed Tango change output, and it is the one check with
no fallback behind it. A round's change may pay the **instance's** SP address,
and a client cannot re-derive that script: a BIP-352 output is
`B_spend + t_k·G`, and `t_k` needs the payee's scan key or the inputs' private
keys — `payjoin_sp.py::payment_script` says exactly this about its own output
("the payer cannot compute it and cannot check it"). Since a taproot key-path
signature commits to every output, a client that cannot tell a legitimate
change script from the coordinator's own signs the coin away. So the round
reveals `t_k` and each client checks `script == OP_1 <x(B_spend + t_k·G)>`,
which proves the output is spendable only by the instance. `verifyPayoutOutput`
in `services/spSign.ts` is the mirror of
`helpers/tangochange.py::verify_payout_output`, and the fixture's negatives —
a crossed tweak, a foreign script — matter as much as its positives: a
verifier that ignored the tweak would pass every real case and be worthless.

Whether a side routes at all is checked against **this device's own record**
(`myPayoutIntended`), never the server's flag. A coordinator that turned
routing on would otherwise take a change coin the user never offered.

**Routing is per side.** One party giving a Lightning address has no bearing
on the other: the partner who gave none keeps their change on chain, in their
own wallet, exactly as every round did before the setting existed. The server
snapshots each side's flag from that side's own setting at the moment it joins
— A's at propose, B's at accept — and `enqueue_tango_payouts` creates a payout
row only for a side whose flag is set. A round-wide flag would route both
change outputs to the instance and owe nothing to the side that never asked,
which is the expensive direction; six tests in
`tests/test_tango_change_output.py` pin it.

The clients were not wired to any of this until 2026-10-01, and the gap was
worse than a missing feature. `checkBeforeSigning` had the whole verification
and **no caller passed it anything**: both clients derived their own change
script unconditionally and sent it, so a user who had saved a Lightning
address could not accept or sign a round at all — the server refuses a script
for an output only it can derive. Saving an address broke Tango for that
account, silently, with a 400 at accept. Now each client reads
`payoutIntended(setting)` (`services/lnAddress.ts`, mirroring
`_tango_routes_change`) at the moment it joins, writes the answer into
`tangoCommit`/`tangocommit.js` beside the coin list, withholds `change_spk`
when routing, and reads the intent back from its own record to sign.

Two consequences worth knowing. A **missing record is not "no"**: a routed
round joined on another device cannot be signed here, because the only
evidence the user asked for it would be the server's own flag — the round
expires and the coins come back, which is recoverable, unlike signing one
away. And the intent read and the server's snapshot are **two separate
calls**, so a setting that changes in between (or liquidity dipping below the
floor) produces a disagreement; that is caught before signing and tells the
user to cancel, rather than being resolved in either side's favour.

The last one is the address-to-chain rule, and it is pinned down to the
sentence rather than the verdict. `helpers/chains.py` is the authority;
`services/chains.ts` exists only so a cross-chain recipient is refused while
it is being typed. Two apps that agree to refuse and disagree about why is
still a drift.

The PayJoin one carries the most weight of the three. An ordinary send that
derives wrongly makes an output the recipient cannot find — one party's bug. A
PayJoin has two parties deriving different outputs of the *same* transaction
from the *same* frozen input set, each signing over both: if the client's
`A_sum` or `input_hash` differs from the server's by a byte, both outputs
belong to nobody, both signatures still verify, and the network accepts it.
Nothing anywhere reports an error. That is why `A_sum` is compared compressed,
parity byte included.
