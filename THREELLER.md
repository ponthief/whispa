# Threeller — scope

A three-party equal-output mix, the same shape as Tango with one more person in
it. This is a scoping document: no code has been written, and the decisions in
§6 are not made.

Read `helpers/tango.py` in siLNt first. Everything below assumes it.

## 1. The finding that decides the shape

**There is no new cryptography, and almost no new money logic.**

BIP-352's shared secret is `input_hash · A_sum · b_scan`, where `A_sum` is the
sum of the input *public* keys. Each party derives its own outputs from its own
scan key against a public input set, which is why a PayJoin works at all with
two owners. The input set being two owners or three changes nothing:
`payjoin_sp.input_digest` takes a **list** of inputs, `own_output_point` takes
that list and one scan secret, and `owner_indices`/`verify_witnesses`/`finalize`
all operate on the whole input set plus "which indices are mine".

`helpers/payjoin_sp.py` says so in its own docstring — *"with two parties or
twenty"*. That line has never been exercised. Threeller is the exercise.

So the work is not in the crypto. It is in the roughly 610 `a_`/`b_` references
in the backend and 180 in the clients, every one of which assumes exactly two
sides.

### Therefore: generalise Tango to N parties, do not write a second feature

A parallel `threeller.py` would be a second implementation of the output
ordering, the fee split, the dust absorption, the change-payout enqueue and the
signing verification. `tango.py`'s own docstring gives the reason not to:

> a second implementation of a sighash is how two of them end up disagreeing,
> and the signature that verifies against nothing is the symptom.

This repo has learned that twice already — the Tango payout setting that lived
on two screens for one commit, and the SegWit send that was two panels for a
day. Both got collapsed into one.

**Recommendation: `tango_rounds` grows an `n_parties` column, `a_`/`b_` becomes
a `tango_sides` child table, and "Threeller" is the user-facing name for a round
with three sides.** The alternative — bolting on `c_*` columns — is cheaper this
week and makes a fourth party another full migration, with every loop in the
backend still hard-coded to a tuple of sides.

## 2. What a third party actually buys

Computed with the repo's own `estimate_vsize`/`fee_for` at 5 sat/vB, clean
rounds, one coin in per side. "Readings" is the number of ways to assign the
identical outputs to the parties — `(np)! / (p!)^n`:

| parties | pieces | outputs | readings | bits | vsize | fee | fee per party |
|--------:|-------:|--------:|---------:|-----:|------:|----:|--------------:|
| 2 | 1 | 2 | 2 | 1.00 | 212 | 1060 | 530 |
| 2 | 2 | 4 | 6 | 2.58 | 298 | 1490 | 745 |
| 2 | 3 | 6 | 20 | 4.32 | 384 | 1920 | 960 |
| **3** | **1** | **3** | **6** | **2.58** | 312 | 1560 | **520** |
| 3 | 2 | 6 | 90 | 6.49 | 441 | 2205 | 735 |
| 3 | 3 | 9 | 1680 | 10.71 | 570 | 2850 | 950 |

The row that justifies the feature: **three parties at one piece each buys
exactly what two parties at two pieces buys (2.58 bits), and costs less per
head** — 520 sats against 745, because the fee is split three ways instead of
two.

And it buys it without the constraint pieces carry. Two pieces from one round
must never be spent together, or the reading collapses; `tangolabels.py::
undoes_a_round` refuses it by txid. A three-party round at one piece each has
nothing to keep apart — the single coin you get back is just a coin.

Every row down the 3-party block beats the 2-party row above it on both axes.
**Adding a party is strictly better value than adding a piece.**

## 3. The honest cost, which is not the fee

### Change gets likelier, and change is what actually decides a round

CLAUDE.md already records the rule: *read the link count, not the bits.* A
round with change on both sides measures **higher** entropy than a clean one
while pinning two input-to-output pairs in every reading. Change plus mixed
output is that party's input total, and an observer solves it by arithmetic.

A clean round needs every side's coins to total the denomination plus its fee
share exactly. That is already uncommon with two sides. With three it is
rarer — and one party's change is enough to pin that party.

**This is the feature's real risk and it is not fixable by code.** A three-party
round with change on two sides may be *worse* than a clean two-party round. The
clients must say which kind of round this is, as they do today via `clean`, and
the copy must not imply that more parties is automatically more privacy.

Worth measuring before building: take the last N real Tango rounds and count how
many were clean. If clean rounds are already rare at two sides, the headline
number in §2 is mostly theoretical.

### Liveness gets worse, and it compounds

Today: `PROPOSED → ACCEPTED → A_SIGNED → BROADCAST`. Three steps after the
offer, two humans.

With three: propose → accept → accept → sign → sign → sign. **Six steps, three
humans**, and any one of them stalling holds everyone's coins. A non-terminal
round reserves its inputs (`get_reserved_tango_outpoints`), `/propose` and
`/accept` refuse anything already reserved, and `TANGO_EXPIRY_SECONDS` is
**86400** — so one absent participant takes three people's coins out of
circulation for a day.

If a two-party round completes p of the time, a naive three-party round
completes p². This is the main product risk, well ahead of anything
cryptographic. Mitigations worth costing: a shorter expiry for three-party
rounds, a partial-cancel that releases the non-stalling sides, or a reminder
notification on the waiting side.

## 4. What changes, by layer

### siLNt (the authority — change here first)

| area | file | what |
|---|---|---|
| schema | `migrations.py` m033 + new | `n_parties`; `tango_sides(round_id, role, user_id, username, wallet_id, inputs, in_sats, change_sats, fee_sats, mix_spk, change_spk, witnesses, payout, payout_tweak)`; backfill a/b |
| planning | `helpers/tango.py::plan` | `a_inputs, b_inputs` → list of input lists; the dust-drop loop is `range(2)` *"because there are only two changes to drop"* → n, or a fixed point |
| fee | `helpers/tango.py::split_fee` | returns a 2-tuple, odd sat to initiator → n-way with the remainder to the initiator. `dust_to_fee` retraces this and must stay in step |
| assembly | `helpers/tango.py::outputs_for`, `assemble` | four spk parameters → per-side lists. BIP-69 sort is already value-then-script and needs no change |
| state | `helpers/tango.py::_TURN`, `whose_turn`, `require_turn` | a fixed 3-entry dict over `a`/`b` → derived from how many sides have joined and signed |
| cancel | `cancelled_by`, `who_cancelled` | `role in ("a","b")` → any valid role; the stored wording must not change (existing rows are parsed by the same code) |
| endpoints | `views_api.py` 6447–7050 | propose/accept/sign/cancel; `_tango_role`, `_tango_assemble`, `_tango_outputs`, `_tango_mix_spks` |
| payout | `views_api.py::enqueue_tango_payouts` ~4806 | the hard-coded 2-tuple of `(role, payout, spk, change, user_id)` becomes a loop over sides. **The two rules it encodes must survive verbatim**: it deliberately ignores `enabled`, and it finds the vout **by `change_spk`** |
| purge | `crud.py::purge_tango_side` | redacts one side; with three, the row survives until all are purged |
| reserve | `crud.py::get_reserved_tango_outpoints` | selects `a_inputs, b_inputs` explicitly |

### Clients (both, in step — CLAUDE.md's rule for shared code)

| area | file | what |
|---|---|---|
| service | `src/services/tango.ts` (817) | 24 sites keyed on `'a'`/`'b'` |
| turns | `src/services/tangoTurns.ts` (264) | 12 sites; mirrors the backend's turn table |
| commit | `src/services/tangoCommit.ts`, `src/stores/tangocommit.js` | the device's own record of what it agreed to; one entry per side |
| signing | `src/services/spSign.ts::verifyPayoutOutput` | verifies **one** instance payout output against its revealed `t_k`; a three-party round can have up to three |
| RN | `src/screens/TangoScreen.tsx` (1498) | propose form, round cards, turn display |
| web | `src/views/TangoView.vue` (1462) | the same, again |

A client signs with a taproot key-path signature, which commits to **every**
output. So each client must be able to justify every output it signs. It cannot
verify another party's *mix* output (a fresh key from their scan secret) — that
is already true at two parties and does not get worse. What does scale is the
payout check: up to n revealed tweaks instead of one.

### Tests and checks

- siLNt: 13 test files touch Tango; the four main ones are **3,933 lines**
  (`test_tango.py` 1593, `test_tango_change_output.py` 1161, `test_tango_payout.py`
  573, `test_tango_cancel_note.py` 224).
- thrilla: ten `check:*` scripts, ~2,000 lines — `check:signing:{tango,commit,
  coins,display,change}` plus `check:payout`.
- Fixtures to regenerate: `_tango_fixtures.py`, `_tango_change_fixtures.py`,
  and `_client_signing_fixtures.py` / `_payjoin_sp_fixtures.py` if the signing
  path moves at all.

**Every existing Tango test must still pass unchanged.** A two-party round is
an n-party round with n=2, and if generalising breaks one of those tests the
generalisation is wrong, not the test.

## 5. What must not change

These are load-bearing and each has a recorded reason:

- **Every mixed output is identical in value.** Two different sizes are two
  outputs an observer can tell apart.
- **BIP-69 output ordering**, so no position identifies anyone.
- **`enqueue_tango_payouts` ignores `enabled`** — by then the round has routed
  and the value is owed.
- **It finds the vout by `change_spk`**, so anything clearing that column on a
  broadcast round strands a payout.
- **Each side's payout flag is snapshotted when that side joins**, never
  re-read, because the output set is what the signatures commit to.
- **A missing device record is not "no"** — a routed round joined elsewhere
  cannot be signed here.
- **Routing is per side.** One party giving a Lightning address has no bearing
  on the others.
- **The resume point only moves forward** (unrelated, but the sweeper touches it).

## 6. Decisions needed before any code

1. **Generalise to n, or add a third side?** Recommendation: generalise. Costs
   more now, and the alternative makes n=4 another migration while leaving every
   loop two-sided.
2. **Who must be connected to whom?** `/propose` today requires A connected to B
   on that network. For three: A connected to both, but must B and C be
   connected to each other? If not, **B and C learn each other's username from
   the round** — a disclosure between people who never agreed to one. No default
   is obviously right.
3. **Is `n_parties` fixed at 3, or a range (2–5)?** Three is a feature; "2 to 5"
   is a product with a number picker and a matching problem.
4. **Expiry for a three-party round.** 86400s was chosen for two humans. Three
   stalling for a day is three people's coins held.
5. **Partial cancel?** Can a round drop a non-responding side and continue with
   two, or is it all-or-nothing? All-or-nothing is far simpler and is the
   recommendation for v1.
6. **Does the odd satoshi still go to the initiator?** `split_fee` gives it to
   whoever chose the denomination. With three, the remainder is 0, 1 or 2 sats.
7. **Name.** If this is a generalisation, is "Threeller" the label for n=3 only,
   or does the whole feature get renamed? Two names for one mechanism is the
   thing §1 is trying to avoid.

## 7. Phases

**Phase 0 — measure (half a day, do this first).** Count how many real Tango
rounds were `clean`. If most already carry change, §2's table is theory and the
feature's value needs re-arguing before anything is built.

**Phase 1 — backend generalisation, n=2 only.** Schema plus `tango_sides`,
backfill, `plan`/`split_fee`/`outputs_for`/`assemble`/turn-order taking lists.
No endpoint takes a third party yet. **The entire existing test suite passes
unchanged** — that is the exit condition, and it is what makes the rest safe.

**Phase 2 — n=3 in the backend.** Propose with two partners, two accepts, three
signs. Expiry and cancel semantics. Payout enqueue over n sides. New tests
beside the old ones; fixtures regenerated.

**Phase 3 — clients.** Both, in step. Service, turns, commit, payout
verification, then the two screens. `check:signing` vectors regenerated against
the backend.

**Phase 4 — copy and the honest limits.** The clean/not-clean wording, the
anonymity claim, the disclosure in decision 2 if B and C need not be connected.

Phases 1 and 2 are the bulk. Phase 3 is two screens and ten check scripts and
should not be started until Phase 2's fixtures are stable, or the vectors get
regenerated twice.

## 8. Risks, worst first

1. **Liveness.** p² completion with three humans and a 24-hour coin lock. The
   feature can be correct and still unusable.
2. **Clean rounds get rarer**, which is the metric that decides whether a round
   hid anything.
3. **Touching the signing path touches real money on mainnet.** Any change to
   fee formula, output ordering or derivation needs the fixtures regenerated and
   both clients moved together.
4. **The migration backfills live rows.** `tango_rounds` holds rounds that are
   broadcast, pending payout, or awaiting a label sweep.
5. **Scope creep to "n parties".** Decision 3 is the one that quietly turns a
   two-week feature into a quarter.
