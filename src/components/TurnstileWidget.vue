<template>
  <div class="ts-wrap">
    <div ref="host" class="ts-host"></div>
    <p v-if="failed" class="text-red text-xs ts-note">
      ⚠ The human-verification check could not load. Reload the page, or disable
      anything blocking <span class="text-mono">challenges.cloudflare.com</span>.
    </p>
  </div>
</template>

<script setup>
/*
 * Cloudflare Turnstile, rendered explicitly rather than by class name.
 *
 * WHY EXPLICIT. The implicit mode scans the DOM for `.cf-turnstile` when the
 * script loads, which in a single-page app is whatever happened to be mounted
 * at that moment. Navigate to /register a second time and the widget is a
 * blank box — the script has already run and will not run again. Rendering by
 * hand from onMounted ties the widget's life to this component's.
 *
 * THE TOKEN IS SINGLE USE, which drives the rest of this file. Cloudflare
 * refuses a second presentation of one, so every path that could lead to the
 * form being submitted again has to produce a fresh solve:
 *
 *   - `expired-callback`, because a solve times out after a few minutes and
 *     somebody reading the terms will hit that
 *   - the parent calling reset() after a failed registration, for the case
 *     where the server rejected something else entirely (a taken username)
 *     and the user is about to press the button again with a spent token
 *
 * Both clear the token upward, so the submit button disables itself rather
 * than letting a second attempt fail for a reason that has nothing to do with
 * what the user typed.
 *
 * FAILING TO LOAD IS REPORTED, NOT SWALLOWED. A blocked script leaves an
 * empty div, an inert button and no explanation — the user concludes the site
 * is broken, which it is, invisibly. `failed` renders a line naming the host
 * to unblock.
 */
import { ref, onMounted, onBeforeUnmount } from 'vue'

const props = defineProps({
  siteKey: { type: String, required: true },
})
const emit = defineEmits(['token'])

const host   = ref(null)
const failed = ref(false)
let widgetId = null

const SCRIPT_SRC =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'

// One script tag for the life of the page, shared by every mount. Appending it
// per mount would load Turnstile several times over, and the second load
// clobbers the first's widget registry.
let scriptPromise = null
function loadScript() {
  if (window.turnstile) return Promise.resolve()
  if (scriptPromise) return scriptPromise
  scriptPromise = new Promise((resolve, reject) => {
    const el = document.createElement('script')
    el.src = SCRIPT_SRC
    el.async = true
    el.defer = true
    el.onload = resolve
    el.onerror = () => {
      // Cleared so a later mount (a reload of the route, a retry) gets a
      // fresh attempt rather than the rejected promise forever.
      scriptPromise = null
      reject(new Error('turnstile script failed to load'))
    }
    document.head.appendChild(el)
  })
  return scriptPromise
}

function reset() {
  emit('token', '')
  try {
    if (widgetId !== null && window.turnstile) window.turnstile.reset(widgetId)
  } catch (_) { /* a reset that cannot run is not worth an error */ }
}
defineExpose({ reset })

onMounted(async () => {
  try {
    await loadScript()
    if (!host.value || !window.turnstile) throw new Error('turnstile unavailable')
    widgetId = window.turnstile.render(host.value, {
      sitekey: props.siteKey,
      // The app is dark everywhere; the default 'auto' follows the OS and
      // renders a white panel on a dark card for anyone on a light system.
      theme: 'dark',
      callback: (token) => emit('token', token),
      'expired-callback': () => emit('token', ''),
      'error-callback': () => { emit('token', ''); failed.value = true },
    })
  } catch (_) {
    failed.value = true
    emit('token', '')
  }
})

onBeforeUnmount(() => {
  // Leaving the widget behind leaks an iframe and a timer per visit to the
  // route, and Turnstile keeps polling for them.
  try {
    if (widgetId !== null && window.turnstile) window.turnstile.remove(widgetId)
  } catch (_) { /* ignore */ }
  widgetId = null
})
</script>

<style scoped>
.ts-wrap { display: flex; flex-direction: column; gap: 8px; }
/* Turnstile renders a fixed-size iframe. Reserving the height stops the submit
   button jumping down the page the moment the widget appears — which, on a
   form, means a click landing on something the user did not aim at. */
.ts-host { min-height: 65px; }
.ts-note { margin: 0; line-height: 1.5; }
</style>
