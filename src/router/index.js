import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { pushToast } from '@/stores/toasts'

const APP_ROLE = import.meta.env.VITE_APP_ROLE || 'user'
const IS_ADMIN_BUILD = APP_ROLE === 'admin'

// Public routes exist in BOTH builds (you must log in to either).
const publicRoutes = [
  { path: '/login',    name: 'login',    component: () => import('@/views/LoginView.vue'),          meta: { public: true } },
  { path: '/register', name: 'register', component: () => import('@/views/RegisterView.vue'),       meta: { public: true } },
  // Public, and public in the ADMIN build too: the signup form links to it,
  // and a terms page that 404s for half the deployments is worse than none.
  { path: '/terms', name: 'terms', component: () => import('@/views/TermsView.vue'), meta: { public: true } },
  { path: '/forgot', name: 'forgot', component: () => import('@/views/ForgotPasswordView.vue'), meta: { public: true } },
  { path: '/reset',  name: 'reset',  component: () => import('@/views/ResetPasswordView.vue'),  meta: { public: true } },
  { path: '/verify', name: 'verify', component: () => import('@/views/VerifyEmailView.vue'),    meta: { public: true } },
  { path: '/pending-device', name: 'pending-device', component: () => import('@/views/PendingDeviceView.vue'), meta: { pending: true } },
]

// User-app routes — the normal wallet UI. Compiled out of the admin build.
const userRoutes = [
  { path: '/',       name: 'wallets', component: () => import('@/views/WalletsView.vue')  },
  { path: '/utxos',  name: 'utxos',   component: () => import('@/views/UtxosView.vue')    },
  { path: '/transactions', name: 'transactions', component: () => import('@/views/TransactionsView.vue') },
  { path: '/send',   name: 'send',    component: () => import('@/views/SendView.vue')     },
  { path: '/swap',   name: 'swap',    component: () => import('@/views/SwapView.vue')     },
  { path: '/payjoin', name: 'payjoin', component: () => import('@/views/PayJoinView.vue') },
  { path: '/tango', name: 'tango', component: () => import('@/views/TangoView.vue') },
  { path: '/scan',   name: 'scan',    component: () => import('@/views/ScanView.vue')     },
  { path: '/bitmail', name: 'bitmail', component: () => import('@/views/BitMailView.vue') },
  { path: '/config', name: 'config',  component: () => import('@/views/ConfigView.vue')  },
  { path: '/devices', name: 'devices', component: () => import('@/views/DevicesView.vue') },
]

// Admin-portal routes — only present in the admin build (admin.thrilla.me).
const adminRoutes = [
  { path: '/', name: 'admin', component: () => import('@/views/AdminView.vue'), meta: { admin: true } },
  { path: '/requests', name: 'bitmail-requests', component: () => import('@/views/BitMailRequestsView.vue'), meta: { admin: true } },
  { path: '/accounts', name: 'accounts', component: () => import('@/views/AccountsView.vue'), meta: { admin: true } },
  // The admin operates their own account too — let them manage their own trusted
  // devices from the admin portal (same page/endpoints as the user app; it only
  // ever acts on the caller's own devices, never another user's).
  { path: '/devices', name: 'devices', component: () => import('@/views/DevicesView.vue'), meta: { admin: true } },
]

const routes = [
  ...publicRoutes,
  ...(IS_ADMIN_BUILD ? adminRoutes : userRoutes),
  { path: '/:pathMatch(.*)*', redirect: '/' },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

router.beforeEach((to) => {
  const auth = useAuthStore()
  if (to.meta.public) return
  if (to.meta.pending) {
    if (!auth.hasCredentials) return { name: 'login' }
    return
  }
  if (!auth.hasCredentials) return { name: 'login' }
  if (to.name === 'login' && auth.hasCredentials) {
    return { name: IS_ADMIN_BUILD ? 'admin' : 'wallets' }
  }
  // Swaps need a Boltz backend (regtest/mainnet only — no Boltz signet).
  if (to.name === 'swap') {
    const lock = import.meta.env.VITE_NETWORK_LOCK || null
    if (lock !== 'regtest' && lock !== 'mainnet') return { name: 'wallets' }
  }
  // PayJoin is behind an explicit build flag (default off). It is the PSBT
  // flavour: descriptors, P2WPKH and an external signer, which is why it is
  // still here — Sparrow is on the other end. It cannot carry Silent Payments
  // at all (a PSBT identifies its inputs by derivation path, and an SP UTXO's
  // key is a one-off from a tweak), and the Silent Payments PayJoin that used
  // to sit beside it has been replaced by Tango on both clients.
  if (to.name === 'payjoin') {
    if (import.meta.env.VITE_PAYJOIN_ENABLED !== 'true') return { name: 'wallets' }
  }
  // Tango has a switch of its own, not the PayJoin one. They are different
  // features to a user — a PayJoin pays someone, a Tango pays nobody — and
  // they will not be ready to turn on at the same moment. Default off, like
  // both PayJoins.
  if (to.name === 'tango') {
    if (import.meta.env.VITE_TANGO_ENABLED !== 'true') return { name: 'wallets' }
  }
})

router.onError((error, to) => {
  console.error('[ROUTER ERROR]', error)
  // A failed dynamic import almost always means a NEW build was deployed and
  // this still-open page is referencing old, now-missing chunk hashes. A single
  // full reload fetches the fresh index.html + chunks and lands on the target.
  const msg = String(error?.message || error || '')
  const isStaleChunk = /dynamically imported module|Importing a module script failed|Failed to fetch/i.test(msg)
  if (isStaleChunk) {
    const guard = 'silnt_chunk_reload_at'
    const last = Number(sessionStorage.getItem(guard) || 0)
    // Guard against a reload loop: only auto-reload once per 10s.
    if (Date.now() - last > 10000) {
      sessionStorage.setItem(guard, String(Date.now()))
      const dest = (to && to.fullPath) ? to.fullPath : window.location.pathname
      window.location.assign(dest)
      return
    }
  }
  // Other errors (or a repeat within the guard window): surface visibly — on
  // mobile there's no console, and a silently failed mount looks like "the
  // button does nothing".
  try {
    pushToast('Navigation error: ' + msg, { type: 'error', timeout: 12000 })
  } catch { /* toast unavailable — console still has it */ }
})

export default router
