<template>
  <div class="login-page">
    <div class="login-card">
      <div class="card-body" style="text-align:center">
        <div class="login-header">
          <div class="header-icon">
            <img src="/icon.png" alt="WhiSPa Wallet" />
          </div>
        </div>

        <div v-if="loading">
          <div class="spinner" style="width:32px;height:32px;margin:24px auto;border-width:3px"></div>
          <h2 style="margin-bottom:8px">Verifying your email…</h2>
          <p class="text-dim">Activating your account.</p>
        </div>

        <div v-else-if="success">
          <div style="font-size:48px;margin-bottom:12px">✓</div>
          <h2 style="margin-bottom:8px">Account activated!</h2>
          <p class="text-dim" style="margin-bottom:8px">Welcome,</p>
          <p class="mono text-orange" style="margin-bottom:24px;font-size:14px">{{ username }}</p>
          <p class="text-dim text-sm" style="margin-bottom:24px">You can now sign in to WhiSPa.</p>
          <!-- Carries the username through, so the sign-in form arrives with it
               filled in. This page is usually opened from a mail client, in a
               different tab or browser from the one that registered, so nothing
               the register form stored locally is reachable here — the username
               the server just confirmed is all there is to pass on. The
               password still has to be typed: the browser never had it. -->
          <router-link :to="{ name: 'login', query: { u: username } }"
                       class="btn btn-primary w-full"
                       style="display:block;text-decoration:none">SIGN IN</router-link>
        </div>

        <div v-else>
          <div style="font-size:48px;margin-bottom:12px">⚠</div>
          <h2 style="margin-bottom:8px">Verification failed</h2>
          <p class="text-dim" style="margin-bottom:8px">{{ error }}</p>
          <p class="text-dim text-sm" style="margin-bottom:24px">
            Verification links expire after 1 hour. Please register again.
          </p>
          <!-- /verify stays in both builds because it is reached from a link
               in an email, and /register no longer does — so in the admin
               build this button would hit the catch-all and land on the login
               page. The route it points at has to exist for the button to be
               worth drawing. -->
          <router-link v-if="!isAdminBuild" to="/register" class="btn btn-primary w-full" style="display:block;text-decoration:none">REGISTER AGAIN</router-link>
          <router-link to="/login" class="text-dim text-sm" style="display:inline-block;margin-top:16px">← Back to sign in</router-link>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import * as api from '@/api'

const route   = useRoute()
// See the REGISTER AGAIN button: /register is compiled out of the admin build.
const isAdminBuild = (import.meta.env.VITE_APP_ROLE || 'user') === 'admin'

const loading  = ref(true)
const success  = ref(false)
const username = ref('')
const error    = ref('')

onMounted(async () => {
  const token = route.query.token
  if (!token) {
    loading.value = false
    error.value = 'No verification token in the link.'
    return
  }

  try {
    const res = await api.verifyRegistration(token)
    if (res && res.success) {
      success.value  = true
      username.value = res.username
    } else {
      error.value = 'Verification could not be completed.'
    }
  } catch (e) {
    error.value = e.message || 'Invalid or expired verification link.'
  } finally {
    loading.value = false
  }
})
</script>
