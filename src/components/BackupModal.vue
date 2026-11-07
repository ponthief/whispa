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
  // Checked here as well as by the disabled button: a mismatch must never
  // reach encryptBackup, which cannot tell a confirmed password from a typo
  // and would seal a file nobody can open.
  if (password.value !== confirm.value) {
    say('The two passwords do not match.', true)
    return
  }
  busy.value = 'save'
  say('')
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
    say(`Saved ${total} item${total === 1 ? '' : 's'}.`)
  } catch (e) {
    say(e?.message || 'Could not save the backup.', true)
  } finally {
    busy.value = null
  }
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
    const { applyBackup, describeBackup } = await import('@/stores/backupdata')
    const payload = await decryptBackup(await file.text(), password.value,
      (f) => say(`Opening… ${Math.round(f * 100)}%`))
    const total = describeBackup(payload).reduce((n, p) => n + p.count, 0)
    const { sections, skipped, remapped } = applyBackup(payload, await walletRefs())
    const added = Object.values(sections).reduce((n, r) => n + r.added, 0)
    const kept = Object.values(sections).reduce((n, r) => n + r.kept, 0)

    // Reports what actually changed. "Restored" over a file whose every entry
    // was already present reads as if something happened.
    say([
      added
        ? `Restored ${added} of ${total} item${total === 1 ? '' : 's'}.`
        : `Nothing to add — all ${total} were already here.`,
      kept ? `${kept} were already here and were left alone.` : '',
      remapped
        ? `${remapped} wallet${remapped === 1 ? '' : 's'} had been removed and added ` +
          'back; their labels were re-matched.'
        : '',
      skipped.length ? `${skipped.join(', ')} were left in the file.` : '',
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
        <h2>Backup</h2>
        <button class="btn btn-ghost btn-sm btn-icon" @click="close">✕</button>
      </div>
      <div class="card-body" style="display:flex;flex-direction:column;gap:14px">
        <!-- "text must be really simple: backup labels, contacts". One line. -->
        <p class="text-dim text-sm" style="margin:0">
          Backs up your labels and contacts.
        </p>

        <div class="field">
          <label>Password</label>
          <input class="input" type="password" v-model="password"
                 placeholder="Password" autocomplete="new-password" />
        </div>

        <!-- Confirm only matters when SAVING: a password has no checksum, so a
             mistyped one seals a file nobody can ever open and nothing finds
             out until a restore. A restore proves the password by opening the
             file, so it does not need this. -->
        <div class="field">
          <label>Confirm password <span class="text-dim text-xs">(to save)</span></label>
          <input class="input" type="password" v-model="confirm"
                 placeholder="Type it again" autocomplete="new-password" />
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

        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-primary btn-sm"
                  :disabled="busy || !password || password !== confirm" @click="doSave">
            {{ busy === 'save' ? '…' : '↓ Save backup' }}
          </button>
          <button class="btn btn-ghost btn-sm" :disabled="busy || !password"
                  @click="fileInput?.click()">
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
