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
const confirm = ref('')
const busy = ref(null)
const msg = ref('')
const err = ref(false)
const fileInput = ref(null)

function say(m, isError = false) {
  msg.value = m
  err.value = isError
}

// Nothing survives the modal being opened or shut.
watch(() => props.show, () => {
  password.value = ''
  confirm.value = ''
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
    say('Enter a password first — it is what will open the file.', true)
    return
  }
  // A mismatch must never reach encryptBackup, which cannot tell a confirmed
  // password from a typo and would seal a file nobody can open.
  if (password.value !== confirm.value) {
    say('Type the same password in both boxes to save.', true)
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
      say('Nothing to back up yet.', true)
      return
    }
    // The KDF yields every 20ms and reports progress, so the tab stays
    // responsive and the count goes up rather than looking wedged.
    say('Saving… 0%')
    const text = await encryptBackup(payload, password.value,
      (f) => say(`Saving… ${Math.round(f * 100)}%`))
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
    say(e?.message || 'Could not save the backup.', true)
  } finally {
    // Cleared BEFORE the close, so a parent that ignores the event is not
    // left holding a modal stuck on 'save'.
    busy.value = null
    if (saved) emit('close')
  }
}

// Restore needs the password BEFORE the file picker, so say so rather than
// opening a picker whose result is going to be refused.
function startRestore() {
  if (busy.value) return
  if (!password.value) {
    say('Enter the password you used when you saved the backup, then press this again.', true)
    return
  }
  say('')
  fileInput.value?.click()
}

async function onPickFile(ev) {
  const file = ev.target.files && ev.target.files[0]
  // Cleared immediately so picking the SAME file twice still fires a change.
  ev.target.value = ''
  if (!file) return
  // Restore takes the password the file was SAVED with, which for an older
  // file may be a recovery phrase or a wallet passphrase — decryptBackup reads
  // the header and treats each correctly. So no confirm field on this path,
  // and no length rule: that is enforced on write, and refusing an old file
  // for failing today's policy would strand it.
  if (!password.value) {
    say('Enter the password for this backup first.', true)
    return
  }
  busy.value = 'restore'
  say('Opening… 0%')
  try {
    const { decryptBackup } = await import('@/services/backup')
    const { applyBackup } = await import('@/stores/backupdata')
    const payload = await decryptBackup(await file.text(), password.value,
      (f) => say(`Opening… ${Math.round(f * 100)}%`))
    const { sections, skipped } = applyBackup(payload, await walletRefs())
    const added = Object.values(sections).reduce((n, r) => n + r.added, 0)

    // SAYS WHETHER IT RESTORED, AND STOPS (2026-11-08, on the user's
    // instruction: "restore text is too long and meaningless, just say
    // whether restored or not"). It used to report added, kept, re-matched
    // wallets and leftovers in one four-clause sentence — every number true,
    // none of them the question being asked, which was "did it work".
    //
    // The two outcomes are still told apart, because they are different
    // answers: a file whose every entry was already present changed nothing,
    // and "Restored" over that reads as though something happened.
    //
    // The one thing kept past that is a section this client cannot store —
    // the phone's, in a file this one opened. Short, and by name, because
    // dropping it would have the screen claim a restore it did not do. It
    // appears only for a cross-client file.
    say([
      added ? 'Restored.' : 'Nothing new — it was all already here.',
      skipped.length ? `${skipped.join(', ')} left in the file.` : '',
    ].filter(Boolean).join(' '))
  } catch (e) {
    say(e?.message || 'Could not read that backup.', true)
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
        <!-- "text must be really simple: backup labels, contacts". One line. -->
        <p class="text-dim text-sm" style="margin:0">
          Backs up your labels and contacts.
        </p>

        <!-- NOT MASKED, on the user's instruction (2026-11-08) and it is the
             right call here. This is a per-file password typed once, not an
             account credential, and it has no checksum — seeing it is the only
             way to tell you are typing what you typed before. A masked field
             is also how "I can't restore" happens: the file is fine, the
             typing was not, and nothing on screen can say which. -->
        <div class="field">
          <label>Password</label>
          <input class="input" type="text" v-model="password"
                 placeholder="Password" autocomplete="off"
                 autocapitalize="off" spellcheck="false" />
        </div>

        <!-- Confirm only matters when SAVING: a mistyped password seals a file
             nobody can ever open and nothing finds out until a restore. A
             restore proves the password by opening the file, so it is hidden
             until there is something to confirm. -->
        <div v-if="password" class="field">
          <label>Confirm password <span class="text-dim text-xs">(only to save)</span></label>
          <input class="input" type="text" v-model="confirm"
                 placeholder="Type it again" autocomplete="off"
                 autocapitalize="off" spellcheck="false" />
          <p v-if="confirm && password !== confirm"
             class="text-error text-xs" style="margin:6px 0 0">
            The two passwords do not match.
          </p>
        </div>

        <div class="alert alert-error" style="padding:10px;border-radius:6px">
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
          <button class="btn btn-primary btn-sm" :disabled="!!busy" @click="doSave">
            {{ busy === 'save' ? '…' : '↓ Save backup' }}
          </button>
          <button class="btn btn-ghost btn-sm" :disabled="!!busy" @click="startRestore">
            {{ busy === 'restore' ? '…' : '↑ Restore from backup' }}
          </button>
          <input ref="fileInput" type="file" accept="application/json,.json"
                 style="display:none" @change="onPickFile" />
        </div>

        <p v-if="msg" class="text-sm" :style="err ? 'color:var(--red)' : 'color:var(--green)'"
           style="margin:0">{{ msg }}</p>
      </div>
    </div>
  </div>
</template>
