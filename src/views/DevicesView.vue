<script setup>
import { ref, onMounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import * as api from '@/api'

const auth = useAuthStore()
const router = useRouter()
// The admin build compiles the user routes out, so Account may not exist here.
const hasAccountPage = computed(() => router.hasRoute('config'))

const devices       = ref([])
const currentDevice = ref(null)
const cap           = ref(5)
const loading       = ref(false)
const error         = ref(null)
const revoking      = ref(null)
const signingOut    = ref(false)

async function loadDevices() {
  loading.value = true; error.value = null
  try {
    const res = await api.listDevices(auth.inkey)
    devices.value       = res.devices || []
    currentDevice.value = res.current_device || null
    cap.value           = res.cap || 5
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

async function revoke(dev) {
  const isCurrent = dev.device_id === currentDevice.value
  const msg = isCurrent
    ? 'Revoke trust on THIS device? You will be signed out and this device will need to confirm via email next time.'
    : 'Revoke trust on this device? It will need to confirm via email next sign-in.'
  if (!confirm(msg)) return
  revoking.value = dev.id
  error.value = null
  try {
    const res = await api.revokeDevice(auth.inkey, dev.id)
    // The backend tells us authoritatively whether we just revoked our own
    // session. If so, log out and leave — do NOT call loadDevices(), since this
    // session is now untrusted and would 403 (which looked like an "unexpected
    // error" even though the revoke succeeded).
    if (res && res.was_current) {
      auth.logout()
      window.location.href = '/login'
      return
    }
    await loadDevices()
  } catch (e) {
    error.value = 'Failed to revoke: ' + (e.detail || e.message)
  } finally {
    revoking.value = null
  }
}

async function signOutOthers() {
  if (!confirm('Sign out all other devices? Only this device will remain trusted.')) return
  signingOut.value = true; error.value = null
  try {
    const res = await api.signOutOtherDevices(auth.inkey)
    await loadDevices()
    alert(`${res.removed_count} other device(s) signed out.`)
  } catch (e) {
    error.value = 'Failed: ' + e.message
  } finally {
    signingOut.value = false
  }
}

function fmtAge(ts) {
  if (!ts) return '—'
  const now = Math.floor(Date.now() / 1000)
  const diff = now - ts
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

function browserName(ua) {
  if (!ua) return 'Unknown'
  if (ua.includes('Brave')) return 'Brave'   // must precede Chrome — Brave's UA also contains "Chrome/"
  if (ua.includes('Edg/')) return 'Edge'
  if (ua.includes('Chrome/')) return 'Chrome'
  if (ua.includes('Firefox/')) return 'Firefox'
  if (ua.includes('Safari/')) return 'Safari'
  return ua.slice(0, 30) + (ua.length > 30 ? '…' : '')
}

function osName(ua) {
  if (!ua) return ''
  if (ua.includes('Windows')) return 'Windows'
  if (ua.includes('Mac OS X')) return 'macOS'
  if (ua.includes('Android')) return 'Android'
  if (ua.includes('iPhone') || ua.includes('iPad')) return 'iOS'
  if (ua.includes('Linux')) return 'Linux'
  return ''
}

const hasOtherDevices = computed(
  () => devices.value.filter(d => d.device_id !== currentDevice.value).length > 0
)

onMounted(loadDevices)
</script>

<template>
  <div class="page-wrap">
    <div class="page-inner">
      <!-- THE WAY BACK. This is a ROUTE, reached from one button on Account
           and from nowhere else, and it had no link out — reported 2026-11-09
           as "clicking on Trusted devices, there is no way to go back to
           Account". Same shape as ScanView's "← Wallet". -->
      <!-- GUARDED, because this same component is the admin portal's devices
           page and the admin build has no `config` route at all — an
           unresolvable named target throws where it is rendered, so an
           ungated link would trade one missing way back for a broken page. -->
      <router-link v-if="hasAccountPage" :to="{ name: 'config' }"
                   class="btn btn-ghost btn-sm"
                   style="margin-bottom:10px">← Account</router-link>

      <div class="page-header">
        <h2 class="page-title">Trusted Devices</h2>
        <p class="text-dim text-sm" style="margin-top:4px">
          Up to {{ cap }} devices may be trusted at once.
          Currently using {{ devices.length }} / {{ cap }}.
        </p>
      </div>

      <div v-if="error" class="alert alert-error">⚠ {{ error }}</div>

      <div v-if="loading" class="text-center text-dim" style="padding:30px">
        <span class="spinner"></span> Loading…
      </div>

      <div v-else-if="!devices.length" class="text-center text-dim" style="padding:30px">
        No trusted devices yet.
      </div>

      <div v-else style="display:flex;flex-direction:column;gap:8px">
        <div
          v-for="dev in devices"
          :key="dev.id"
          class="card"
          :class="{ 'current-device': dev.device_id === currentDevice }"
          style="padding:12px"
        >
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px">
            <div style="flex:1;min-width:0">
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                <strong style="font-size:14px">
                  {{ browserName(dev.user_agent) }}
                  <span v-if="osName(dev.user_agent)" class="text-dim">— {{ osName(dev.user_agent) }}</span>
                </strong>
                <span
                  v-if="dev.device_id === currentDevice"
                  class="badge"
                  style="background:rgba(16,185,129,.1);color:#10b981;border:1px solid rgba(16,185,129,.4)"
                >This device</span>
              </div>
              <div class="text-dim text-xs" style="margin-top:4px">
                Added: {{ fmtAge(dev.confirmed_at) }} · Last seen: {{ fmtAge(dev.last_seen_at) }}
                <span v-if="dev.ip" title="May be a proxy/CDN IP — not a trust signal"> · Ingress IP: {{ dev.ip }}</span>
              </div>
              <div class="mono text-xs text-dim" style="margin-top:2px;word-break:break-all">
                {{ dev.user_agent || '—' }}
              </div>
            </div>
            <button
              class="btn btn-danger btn-sm"
              :disabled="revoking === dev.id"
              @click="revoke(dev)"
            >
              <span v-if="revoking === dev.id" class="spinner" style="width:10px;height:10px;border-width:1.5px"></span>
              <span v-else>Revoke</span>
            </button>
          </div>
        </div>
      </div>

      <div v-if="hasOtherDevices" style="margin-top:20px">
        <button
          class="btn btn-warn"
          :disabled="signingOut"
          @click="signOutOthers"
        >
          <span v-if="signingOut" class="spinner"></span>
          Sign out all other devices
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.current-device { border-color: var(--orange-dim) !important; }
</style>
