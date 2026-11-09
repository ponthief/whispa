<script setup>
import { ref, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import * as api from '@/api'
import { paint } from '@/services/paint'
import { resetLoginScanFor } from '@/composables/useLoginScan'

// Backup, as a modal off the wallet card's ⚙ menu (2026-11-08, on the user's
// instruction: "we should move Backup under Settings in Wallet for web app,
// it should pop up with Save/Restore from backup buttons and Password text
// field, text must be really simple").
//
// IT LIVES ON THE WALLET CARD BUT IT IS NOT PER-WALLET. The labels and pinned
// contacts are account-wide, so one file covers every wallet whichever card's
// menu opened it. The menu is where people look for it; the scope is what the
// copy says.
//
// THE PASSWORD IS CLEARED EVERY TIME THIS OPENS OR CLOSES, and that is the
// fix for what was reported: "I was able to restore from file w/o being
// prompted for password". The crypto was never bypassed — an empty password
// throws before any key is derived — but the field sat on the Settings page
// holding whatever had been typed to SAVE a backup, so pressing Restore after
// an export opened the file having asked nothing. A field that persists
// across two different operations is a field nobody is prompted by.

const props = defineProps({ show: { type: Boolean, default: false } })
const emit = defineEmits(['close'])

const auth = useAuthStore()

const password = ref('')
const busy = ref(null)
const msg = ref('')
const err = ref('ok')   // 'ok' | 'error' | 'info'
const fileInput = ref(null)

// THE FILE COMES FIRST ON A RESTORE (2026-11-08, on the user's instruction:
// "when restoring user selects the file and if the file is encrypted it should
// ask for a password"). A chosen, encrypted file waits here while its password
// is typed. Until the picker has run there is nothing to ask about — and a
// screen that has not seen the file cannot say which secret that file wants,
// which matters for one made before 2026-11-08 and sealed with the seed
// phrase.
const pending = ref(null)   // { text, info } once a file has been chosen

// Three tones, because two were not enough once the screen started ASKING
// for things. "This backup is encrypted, enter its password" is an
// instruction, and in the green of a finished job it reads as though
// something already succeeded.
function say(m, tone = 'ok') {
  msg.value = m
  err.value = tone
}

// Nothing survives the modal being opened or shut — including a file chosen
// but not opened, which must not be waiting there the next time this appears.
watch(() => props.show, () => {
  password.value = ''
  pending.value = null
  busy.value = null
  say('')
})

function close() {
  if (busy.value) return
  emit('close')
}

// The account's wallets as references: { id, title, network, spAddress }.
// On save they record what the labels belong to; on restore they are how a
// wallet that was deleted and added back — and so carries a new id — gets its
// SegWit labels re-matched. Nothing in here is secret.
async function walletRefs() {
  try {
    const list = await api.getSilntWallets(auth.inkey)
    return (list || []).map(w => ({
      id: w.id,
      title: w.title || 'Wallet',
      network: w.network,
      spAddress: w.sp_address || '',
      // THE BIRTH HEIGHT, which this dropped until 2026-11-09 and which is
      // not a missing field so much as a silently empty wallet. Reported as
      // "backup file does not store the born at height block for the wallet".
      //
      // api_create_wallet DEFAULTS last_height TO THE ORACLE TIP when the
      // payload omits it, so a web file restored anywhere created a wallet
      // born TODAY. Every coin received before that sits below its birth
      // height; the catch-up prompt takes max(last_scan_height, last_height),
      // finds nothing behind the tip, and offers no scan. A restore that
      // looked perfectly successful, with the history gone.
      //
      // The phone's walletRefs has carried it all along — the usual one-sided
      // asymmetry, and the collectors on BOTH sides already preserve the
      // field. It was never put in.
      lastHeight: typeof w.last_height === 'number' ? w.last_height : undefined,
    }))
  } catch {
    return []
  }
}

async function doSave() {
  if (busy.value) return
  // The buttons are live whatever the fields hold, so every requirement is
  // stated HERE rather than by greying something out. A dead control explains
  // nothing; this says what is missing.
  if (!password.value) {
    say('Your wallet passphrase is required to encrypt the backup file.', 'error')
    return
  }
  // ONE FIELD, NO CONFIRMATION (2026-11-08, on the user's instruction: "drop
  // confirm password field, one field is sufficient"). What that gives up is
  // the only check a password has — a phrase had BIP-39's checksum, a
  // confirmed password had the second box, and a single unconfirmed one has
  // nothing: a typo here seals a file nobody can ever open and nothing finds
  // out until a restore. What stands in its place is that the field is not
  // masked, so what was typed can be read back before pressing this.
  //
  // The length rule still applies, and still only on write.
  const { validateBackupPassword } = await import('@/services/backup')
  const bad = validateBackupPassword(password.value)
  if (bad) {
    say(bad, 'error')
    return
  }
  busy.value = 'save'
  say('')
  let saved = false
  let left = ''
  let noWords = ''
  try {
    const { encryptBackup, backupFilename } = await import('@/services/backup')
    const { collectBackup, describeBackup } = await import('@/stores/backupdata')
    const { collectServerLabels } = await import('@/services/serverLabels')
    const { collectWalletKeys } = await import('@/services/walletBackup')
    const { spAddressFromKeys, deriveSilentPayment } = await import('@/services/spKeys')

    const refs = await walletRefs()
    // THE WALLETS, and the words where this browser has them (2026-11-08:
    // "this needs to work regardless of the app: backup/restore from either
    // web or mobile app").
    //
    // The derived keys are what a web file always carried — verified to add
    // up to each wallet's own SP address, because for one build it carried no
    // wallet at all, reported as "saved backup in web app and restored in
    // mobile and still asks for recovery key". The PHRASE rides along now for
    // any wallet the vault holds one for, which is what makes a file from
    // here identical in kind to one from the phone: restore it anywhere and
    // the wallet can show its seed phrase.
    const { keys, seeds, leftOut, noSeed } = await collectWalletKeys(
      {
        getWalletKeys: (id) => auth.getWalletKeys(id),
        spAddressFromKeys,
        readSeed: (id) => auth.readSeed(id),
        deriveSilentPayment,
      },
      refs,
      password.value,
    )
    // A WRONG PASSPHRASE REFUSES THE SAVE, as it does on the phone. Asked
    // 2026-11-09: *"if user enter invalid passphrase, we would warn him that
    // it's wrong and won't save the backup?"* — and here it did not. The keys
    // this browser seals do not depend on the passphrase, so a mistyped one
    // still produced a perfectly good file: sealed under a secret that opens
    // none of these wallets, carrying keys and no words, with the mismatch
    // mentioned after the download had already happened.
    //
    // THE TEST IS "OPENED NOTHING IT COULD HAVE OPENED", not "opened
    // everything". A phrase that fails is reason 'passphrase'; a wallet whose
    // words this browser never had is reason 'none' and says nothing about
    // what was typed, so a browser holding no phrases at all still saves —
    // that is the older wallet's keys-only file and always was. THAT is the
    // case this wording exists for.
    //
    // It is NOT about a second wallet. This account has one: the server caps
    // it at `max_wallets_per_user`, which defaults to 1 per network
    // (siLNt models.py), refuses the create with "Wallet limit reached", and
    // WalletsView hides ＋ New Wallet at the cap. With one wallet the test
    // reads simply as "that passphrase did not open your wallet". The loop
    // form costs nothing and stays correct if an operator ever raises the
    // cap, which is the only reason it is not written as a single compare.
    const failedOnPassphrase = noSeed.filter(w => w.reason === 'passphrase')
    if (!Object.keys(seeds).length && failedOnPassphrase.length) {
      say('That passphrase does not open any of your wallets, so none would ' +
          'be in the file. Check it and try again.', 'error')
      return
    }
    const withKeys = refs.map(w => ({
      ...w,
      ...(keys[w.id] ? { keys: keys[w.id] } : {}),
      ...(seeds[w.id] ? { mnemonic: seeds[w.id] } : {}),
    }))
    // The SERVER-side labels too, as of 2026-11-08. An SP coin's label is
    // silnt.utxos.label and a labelled address's is wallet_addresses.label;
    // neither was in the file, so a restore brought back a SegWit label and
    // not an SP one, by a rule invisible from the outside.
    const payload = collectBackup(withKeys, await collectServerLabels(api, auth.inkey, refs))
    // THE WALLETS COUNT, not just the labels. This counted label sections
    // alone, so a wallet with no labels on it — a fresh install, which is
    // exactly who needs a backup — got "Nothing to back up yet" and could not
    // write a file, while the wallet it would have restored sat right there.
    const { countRestorableWallets } = await import('@/services/walletBackup')
    const total = describeBackup(payload).reduce((n, p) => n + p.count, 0)
      + countRestorableWallets(payload)
    if (!total) {
      say('Nothing to back up yet.', 'error')
      return
    }
    // The KDF yields every 20ms and reports progress, so the tab stays
    // responsive and the count goes up rather than looking wedged.
    say('Saving… 0%', 'info')
    await paint()
    const text = await encryptBackup(payload, password.value,
      (f) => say(`Saving… ${Math.round(f * 100)}%`, 'info'))
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = backupFilename()
    a.click()
    // Revoked, or the blob is held for the life of the tab.
    URL.revokeObjectURL(url)
    // THE MODAL CLOSES ON A SUCCESSFUL SAVE (2026-11-08, on the user's
    // instruction: "after saving backup, pop up should disappear"). The
    // browser's own download is the confirmation, and a message sitting in a
    // dialog the user now has to dismiss is a step for no information. It
    // stays open on failure, because that message IS the information.
    saved = true
    // Named, not swallowed: a wallet whose keys this browser does not hold is
    // one the file cannot restore, and the person needs to know which before
    // they rely on it.
    if (leftOut.length) {
      left = leftOut.map(w => w.title).join(', ')
    }
    // IN THE FILE, BUT WITHOUT ITS WORDS — said here, where it can still be
    // fixed, rather than discovered on another device that has nothing to
    // show. The two cases need different answers, so they are reported apart.
    else if (noSeed.length) {
      // Only reachable now when SOME wallet verified, so this names the
      // odd one out rather than reporting a wholly wrong passphrase after
      // the fact — that case is refused above, before anything is written.
      const bad = failedOnPassphrase
      noWords = bad.length
        ? `Saved. ${bad.map(w => w.title).join(', ')}: that passphrase does not ` +
          'match, so its seed phrase was left out of the file.'
        : `Saved, but ${noSeed.map(w => w.title).join(', ')} has no seed phrase ` +
          'stored here to put in it. Add it under ⚙ → Seed phrase.'
    }
  } catch (e) {
    say(e?.message || 'Could not save the backup.', 'error')
  } finally {
    // Cleared BEFORE the close, so a parent that ignores the event is not
    // left holding a modal stuck on 'save'.
    busy.value = null
    // A clean save closes the modal; one that left a wallet out stays open
    // and says which, because that is the half the download cannot tell you.
    if (saved && !left && !noWords) emit('close')
    else if (saved && left) {
      say(`Saved, but ${left} could not be included — its keys are not here. ` +
        'Use Recover Keys on that wallet first, or save the backup from the ' +
        'app.', 'error')
    } else if (saved) {
      say(noWords, 'error')
    }
  }
}

// THE PICKER OPENS STRAIGHT AWAY. Nothing is asked for first: until a file
// has been chosen there is nothing to ask about, and the screen cannot know
// which secret that file wants.
function startRestore() {
  if (busy.value) return
  say('')
  pending.value = null
  fileInput.value?.click()
}

async function onPickFile(ev) {
  const file = ev.target.files && ev.target.files[0]
  // Cleared immediately so picking the SAME file twice still fires a change.
  ev.target.value = ''
  // Backing out of the picker is not an error and must not read as one.
  if (!file) return
  say('')
  const { inspectBackupFile } = await import('@/services/backup')
  const text = await file.text()
  const info = inspectBackupFile(text)
  // A file this build cannot read is refused HERE, before any password is
  // asked for: making somebody type a secret for a file that was never going
  // to open is the question-before-the-answer all over again.
  if (!info.readable) {
    say(info.problem, 'error')
    return
  }
  pending.value = { text, info }
  // CHOOSING A FILE ALWAYS ASKS, and the field is cleared to make sure of it.
  // Opening it with whatever happened to be typed already is the bug that was
  // reported in the first place — "I was able to restore from file w/o being
  // prompted for password" — and it would be back the moment a save and a
  // restore shared a field across one session. The password that seals a new
  // backup is not evidence about an old file.
  //
  // What to ask for comes from the FILE's own header, so a backup written
  // between 2026-11-04 and 2026-11-08 asks for the seed phrase by name
  // rather than failing to open and leaving the user guessing.
  password.value = ''
  say(info.encrypted
    ? `This backup is encrypted. Enter its ${info.asksFor} and press Open.`
    : 'Press Open to restore this backup.', 'info')
}

// Opening the file that is already in hand. Separate from the picker, because
// this is what the Open button presses and what a password typed after the
// fact runs — the file is not chosen again.
async function openPending() {
  if (busy.value || !pending.value) return
  // No length rule on this path: that is enforced on write, and refusing an
  // older file for failing today's policy would strand it. An older file may
  // also be sealed with a seed phrase or a wallet passphrase, which
  // decryptBackup reads from the header and treats correctly.
  if (!password.value && pending.value.info.encrypted) {
    say(`Enter the ${pending.value.info.asksFor} for this file.`, 'error')
    return
  }
  const { text } = pending.value
  busy.value = 'restore'
  say('Opening backup file…', 'info')
  try {
    const { decryptBackup, remapWalletIds } = await import('@/services/backup')
    const { applyBackup } = await import('@/stores/backupdata')
    const { applyServerLabels } = await import('@/services/serverLabels')
    const { restoreWallets } = await import('@/services/walletBackup')
    const { deriveSilentPayment, spAddressFromKeys } = await import('@/services/spKeys')
    // Painted first: encryptBackup and decryptBackup both do their assembling
    // and base64 work before the KDF's first yield, so a message set on the
    // line above arrives after the wait it was meant to explain. The phone was
    // reported for exactly this ("shows as if nothing is happening").
    await paint()
    const payload = await decryptBackup(text, password.value,
      (f) => say(`Opening… ${Math.round(f * 100)}%`, 'info'))
    // STAGES, not one message that sits there. Reported 2026-11-08: "there is
    // no progress when opening file, user not aware that it's restoring". The
    // KDF reports a percentage and then stops — and everything after it is
    // network calls that said nothing at all, so the longest part of a restore
    // looked like a hang. Each stage names what is happening to what.
    say('Reading your wallets…', 'info')
    let live = await walletRefs()

    // THE WEB RESTORES WALLETS TOO, which it did not for one build — it
    // applied labels and nothing else, so "restore" on this side could never
    // answer "still asks for recovery key". It can create the wallet and put
    // keys in its own vault; those are the two things a restore is.
    let walletReport = null
    const fileWallets = payload.wallets || []
    if (fileWallets.length) {
      say('Restoring wallets…', 'info')
      walletReport = await restoreWallets({
        deriveSilentPayment,
        spAddressFromKeys,
        createWallet: (data) => api.createSilntWallet(auth.inkey, data),
        // The store takes these POSITIONALLY; walletBackup hands an object.
        storeWalletKeys: (id, k) =>
          auth.storeWalletKeys(id, k.scanSecret, k.spendKey, k.refundAddress, k.sweepAccount),
        // THE BROWSER KEEPS THE WORDS NOW (2026-11-08), so a phone backup
        // restored here can show its phrase afterwards — which is the whole
        // of the reveal added to the wallet card's menu on the same day. It
        // held derived keys only until then, and these two were stubs saying
        // "this client needs no seed" so that a phone file, which carries a
        // phrase, would not be re-adopted on every restore for ever hunting
        // for something the browser was never going to have.
        //
        // `hasSeed` is the real question now, and it has to be: a wallet whose
        // keys are here but whose phrase is not is exactly the wallet this
        // file can complete. It is adopted, the keys it already had are
        // rewritten with the same values, and the phrase lands — one wasted
        // write against the feature working.
        saveSeed: (id, phrase) => auth.saveSeed(id, phrase),
        hasSeed: async (id) => auth.hasSeed(id),
        hasKeys: async (id) => !!(await auth.getWalletKeys(id)),
        // SO THE SCAN IS OFFERED, which is the other half of the report:
        // "once restored, it should ask to restore from that block". The
        // catch-up banner computes its gap from max(last_scan_height,
        // last_height), so a restored wallet with no scan progress prompts
        // from its birth height — but only if the evaluation is redone.
        // `_evaluated` is module-level and outlives the route, so without
        // this the banner never recomputes and the prompt never appears.
        // The phone passes resetCatchUp here for the same reason.
        onCreated: (id) => resetLoginScanFor(id),
        // PER WALLET, and awaited so the message paints before the thread is
        // taken again. Reported on the phone (2026-11-09, "nothing happens
        // for some time and then suddenly it restores") and true here for the
        // same reason: deriveSilentPayment is PBKDF2 plus an EC multiply,
        // synchronous, once per wallet, and a reactive update in front of
        // synchronous work does not reach the screen.
        onProgress: async (done, total, title) => {
          say(total > 1 ? `Restoring ${title} (${done} of ${total})…` : `Restoring ${title}…`, 'info')
          await paint()
        },
      }, password.value, fileWallets, live)
      if (walletReport.created.length) live = await walletRefs().catch(() => live)
    }
    applyBackup(payload, live)

    // The server-side half, over the network and therefore after the local
    // one: a failure here must not cost the labels that were already written.
    say('Restoring labels…', 'info')
    const srv = await applyServerLabels(
      api, auth.inkey, payload.sections || {},
      remapWalletIds(payload.wallets, live), live)
    // NAMED APART from the `pending` ref holding the chosen FILE. It was
    // `pending` for one build, which shadowed the ref inside this function:
    // the restore itself worked and then `pending.value = null` threw
    // "Cannot create property 'value' on number '0'", so the file and the
    // password were both left sitting in the modal. tsc catches this on the
    // phone and cannot here, and no check would — it took running it.
    const pendingLabels = (srv.coinLabels?.pending || 0) + (srv.addressLabels?.pending || 0)


    // ONE WORD (2026-11-08: "restore text is too long and meaningless, just
    // say whether restored or not", then "do not say Nothing new, Restored is
    // fine"). It used to report added, kept, re-matched wallets and leftovers
    // in one four-clause sentence — every number true, none of them the
    // question being asked, which was "did it work".
    //
    // And the file IS restored whether or not anything changed: a merge that
    // added nothing still means every label in that file is now here, which is
    // what the user came to find out. Reporting "nothing new" answered a
    // different question — how much of it was already here — and read like a
    // refusal.
    //
    // The one thing kept past that is a section this client cannot store —
    // the phone's, in a file this one opened. Short, and by name, because
    // dropping it would have the screen claim a restore it did not do. It
    // appears only for a cross-client file.
    const madeWallets = walletReport?.created.length || 0
    const gotKeys = walletReport?.adopted.length || 0
    const noKeys = walletReport?.noPhrase || 0
    const walletTrouble = [
      ...(walletReport?.mismatched || []).map(w => `${w.title} (its keys do not match it)`),
      ...(walletReport?.failed || []).map(w => `${w.title} (${w.message})`),
    ]
    say([
      'Restored successfully.',
      // ONE CLAUSE, and only when a wallet came back (2026-11-09: "drop the
      // text about restoring — just say Restored successfully, no bitmail
      // pinned etc"). It survives the cut because a restored wallet has NO
      // COINS until a scan runs, and a zero balance with nothing on screen
      // reads as money gone. The counts went with the rest.
      madeWallets || gotKeys ? 'Scan to find your coins.' : '',
      walletTrouble.length ? `Not restored: ${walletTrouble.join(', ')}.` : '',
      noKeys
        ? `${noKeys} wallet${noKeys === 1 ? '' : 's'} in this file could not be ` +
          'restored: it carries no keys for them. Save a new backup and use that.'
        : '',
      // A label whose coin is not here yet — the one thing the user has to
      // come BACK and do, which is why it outlived the cut. The coins come
      // from the chain, so this is the normal state between adding a wallet
      // back and finishing a rescan.
      pendingLabels
        ? `${pendingLabels} label${pendingLabels === 1 ? '' : 's'} need their ` +
          'coins scanned first — scan, then restore again.'
        : '',
      // GONE: the wallet counts, and `skipped` — which is what named
      // bitmailPins, and is the "no bitmail pinned etc" in the report. A
      // section this client cannot store is a fact about the FILE, not about
      // whether the restore worked, and it was being read as the latter.
    ].filter(Boolean).join(' '))
    // Done with: the Open button goes, and a second press cannot re-apply a
    // file the user has finished with. A FAILURE keeps it, so a wrong
    // password is retyped against the file already in hand rather than
    // sending the user back through the picker.
    pending.value = null
    // AND THE PASSWORD GOES WITH IT. Reported as "after restoring, I clicked
    // save backup w/o password and pop up disappeared" — the field still held
    // what had been typed to OPEN the file, so Save sealed a new backup with
    // it and closed, having asked nothing. One field serving two operations
    // must be emptied between them; it is the same rule as clearing it when a
    // file is picked, from the other end.
    password.value = ''
  } catch (e) {
    say(e?.message || 'Could not read that backup.', 'error')
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <div v-if="show" class="modal-overlay" @click.self="close">
    <div class="card modal">
      <div class="card-header">
        <!-- Both halves named, here and on the menu item that opens it
             (2026-11-08: "under Settings, it only says Backup, needs
             Restore"). The modal does both, and somebody who came to get a
             file back should see that word before opening anything. -->
        <h2>Backup &amp; Restore</h2>
        <button class="btn btn-ghost btn-sm btn-icon" @click="close">✕</button>
      </div>
      <div class="card-body" style="display:flex;flex-direction:column;gap:14px">
        <!-- NO CONTENTS LINE. "Backs up your wallets and labels." went on
             2026-11-09 ("text Backs up your wallets needs to go"), with the
             sentence under the field that explained which wallets could have
             their passphrase checked.

             KNOW WHAT THAT COSTS, because the line was load-bearing twice
             over. It was the last thing on either screen saying what is IN
             the file; the red warning that carried the rest went a day later,
             so NOTHING here describes the file now and the field's label is
             what names the key. And "labels" replaced "labels and contacts" on
             2026-11-08 for being a promise the file could not keep; nothing
             says "contacts" now because nothing says anything, so the only
             way that claim comes back is somebody writing a new line here.
             Do not. -->

        <!-- ONE FIELD. The confirmation box went on 2026-11-08 ("drop confirm
             password field, one field is sufficient"). It was the checksum a
             password does not have; what is left in its place is that this
             field is NOT MASKED, so what was typed can be read back before
             pressing Save. That is also why a restore that refuses is
             readable: the file is often fine and the typing was not, and a
             masked field cannot say which. -->
        <div class="field">
          <!-- The label follows the FILE once one is chosen, so a backup from
               the older scheme does not say "Password" over a box that wants
               twelve words. -->
          <label>{{ pending ? `${pending.info.asksFor} for this file` : 'Wallet passphrase' }}</label>
          <input class="input" type="text" v-model="password"
                 :placeholder="pending ? pending.info.asksFor : 'Wallet passphrase'"
                 autocomplete="off" autocapitalize="off" spellcheck="false"
                 @keyup.enter="pending ? openPending() : doSave()" />
        </div>

        <!-- NO RED WARNING (2026-11-09: "remove red text: Encrypted..."),
             matching the phone. With the contents line already gone this
             screen says nothing about the file; what names the key is the
             field's own label, and the behaviour is untouched. See the note
             in BackupPage.tsx for what the sequence of cuts has left. -->

        <!-- NEITHER BUTTON IS EVER DISABLED FOR MISSING INPUT, which is what
             "you dropped Restore" was: both sat greyed out on open, because
             the password starts empty, and a dead button with no explanation
             is indistinguishable from one that is not there. They are live,
             and each says what it needs. Only `busy` disables them, because
             two concurrent runs really are not possible. -->
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <!-- A FILE IS CHOSEN FIRST AND THE PASSWORD ASKED FOR SECOND, so
               once one is waiting the row is about that file and nothing
               else: offering Save beside it would seal a NEW backup under the
               password being typed to open an old one. -->
          <template v-if="pending">
            <button class="btn btn-primary btn-sm" :disabled="!!busy" @click="openPending">
              {{ busy === 'restore' ? '…' : '🔓 Open backup' }}
            </button>
            <button class="btn btn-ghost btn-sm" :disabled="!!busy" @click="pending = null; say('')">
              Cancel
            </button>
          </template>
          <template v-else>
            <button class="btn btn-primary btn-sm" :disabled="!!busy" @click="doSave">
              {{ busy === 'save' ? '…' : '↓ Save backup' }}
            </button>
            <button class="btn btn-ghost btn-sm" :disabled="!!busy" @click="startRestore">
              ↑ Restore from backup
            </button>
          </template>
          <!-- NO `accept` FILTER, the same call the phone's picker makes: a
               backup that has been through Drive, a chat app or mail comes
               back as octet-stream or without its extension routinely, and
               filtering hides the user's own file from them with nothing
               saying why. What the file is gets answered by reading it. -->
          <input ref="fileInput" type="file"
                 style="display:none" @change="onPickFile" />
        </div>

        <p v-if="msg" class="text-sm" style="margin:0"
           :style="err === 'error' ? 'color:var(--red)'
                 : err === 'info' ? 'color:var(--text)'
                 : 'color:var(--green)'">{{ msg }}</p>
      </div>
    </div>
  </div>
</template>
