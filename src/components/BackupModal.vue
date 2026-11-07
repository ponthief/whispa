<script setup>
import { ref, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import * as api from '@/api'

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
// which matters for one made before 2026-11-08 and sealed with the recovery
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
    say('A password is required to encrypt the backup file.', 'error')
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
  try {
    const { encryptBackup, backupFilename } = await import('@/services/backup')
    const { collectBackup, describeBackup } = await import('@/stores/backupdata')

    const payload = collectBackup(await walletRefs())
    const total = describeBackup(payload).reduce((n, p) => n + p.count, 0)
    if (!total) {
      say('Nothing to back up yet.', 'error')
      return
    }
    // The KDF yields every 20ms and reports progress, so the tab stays
    // responsive and the count goes up rather than looking wedged.
    say('Saving… 0%', 'info')
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
  } catch (e) {
    say(e?.message || 'Could not save the backup.', 'error')
  } finally {
    // Cleared BEFORE the close, so a parent that ignores the event is not
    // left holding a modal stuck on 'save'.
    busy.value = null
    if (saved) emit('close')
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
  // between 2026-11-04 and 2026-11-08 asks for the recovery phrase by name
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
  // also be sealed with a recovery phrase or a wallet passphrase, which
  // decryptBackup reads from the header and treats correctly.
  if (!password.value && pending.value.info.encrypted) {
    say(`Enter the ${pending.value.info.asksFor} for this file.`, 'error')
    return
  }
  const { text } = pending.value
  busy.value = 'restore'
  say('Opening… 0%', 'info')
  try {
    const { decryptBackup } = await import('@/services/backup')
    const { applyBackup } = await import('@/stores/backupdata')
    const payload = await decryptBackup(text, password.value,
      (f) => say(`Opening… ${Math.round(f * 100)}%`, 'info'))
    const { skipped } = applyBackup(payload, await walletRefs())


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
    say([
      'Restored.',
      skipped.length ? `${skipped.join(', ')} left in the file.` : '',
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
        <!-- LABELS. It said "labels and contacts" until 2026-11-08, and the
             file has never held a contact: a Tango connection is a row in
             silnt.payjoin_contacts naming BOTH user ids, it lives on the
             server, and it cannot be re-created from one side — the other has
             to accept. So a backup could not bring back a connection somebody
             removed even if it tried, and saying "contacts" promised exactly
             that. What the word was reaching for was the BitMail pins, which
             are tamper evidence rather than an address book. -->
        <p class="text-dim text-sm" style="margin:0">
          Backs up your labels.
        </p>

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
          <label>{{ pending ? `${pending.info.asksFor} for this file` : 'Password' }}</label>
          <input class="input" type="text" v-model="password"
                 :placeholder="pending ? pending.info.asksFor : 'Password'"
                 autocomplete="off" autocapitalize="off" spellcheck="false"
                 @keyup.enter="pending ? openPending() : doSave()" />
        </div>

        <!-- Only while saving is the password the thing that can be lost. Once
             a file is in hand the question is what opens THAT file, and this
             warning would be answering the wrong one. -->
        <div v-if="!pending" class="alert alert-error" style="padding:10px;border-radius:6px">
          <p class="text-sm" style="margin:0">
            <strong>Remember this password.</strong> It is the only thing that
            opens the file, and no one — including us — can recover it.
          </p>
        </div>

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
