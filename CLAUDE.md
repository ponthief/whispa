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
- Private keys are never stored: not the BIP-84 key, not the passphrase.
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
(`offered`), not a client-side network check: a Lightning address is a mainnet
endpoint and signet change is worthless, so routing it would have the instance
paying real sats for faucet coins.

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

It also checks that every `text-`, `badge-`, `alert-` and `btn-` class a
`.vue` file uses is defined in `src/style.css`, for the same reason: nothing
else did. `text-amber` was used ten times across four views and never
defined, so every one of those warnings rendered in the body colour —
alongside `text-center`, `text-error`, `text-yellow` and `btn-warn`. An
undefined class name is not a build error, not a lint error, and not visibly
wrong unless you know what it was meant to look like. All five are defined
now.

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
phone now has one: a lookback chooser on the scan screen (10 / 144 / 1,008 /
4,320 blocks back from the tip), live **even when the wallet is up to date**,
because that is exactly when somebody needs it — a payment that never appeared
is in a block the wallet believes it has already read. Before it, the phone
computed its range and never offered the fields, so "Up to date" disabled the
only button and there was no way back. The web has had editable From/To all
along.

Separately, a block the scan could not read holds the resume point below it
and is reported as `gap` on the progress record, so neither client claims the
wallet is up to date while there is a hole in it. See
`tests/test_scan_gap_is_reported.py` and `tests/test_resume_point.py`.

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
