<script setup>
// The Bitcoin sign (₿), DRAWN rather than typed — the same drawing, point for
// point, as the phone's components/BitcoinSign.tsx.
//
// The obvious implementation is the character U+20BF, and it is not safe: it
// only reached Unicode in 2017, so a browser or OS font that predates it shows
// an empty box, and on this app it would sit in the nav and on the balance. The
// phone drew it for exactly that reason (Android 6-7 renders the character as
// tofu). An inline SVG looks the same in every font and every browser, and
// follows the surrounding text colour through `currentColor`.
//
// A capital B whose stem is crossed at the top and the bottom by two short
// strokes — that is the sign, and it is what is drawn here.
defineProps({
  // Any CSS length. `1em` by default so it scales with the text it sits in.
  size: { type: String, default: '1em' },
  // Stroke weight relative to the glyph; raise it beside bold text.
  weight: { type: Number, default: 2.1 },
})
</script>

<template>
  <svg class="btc-sign" :width="size" :height="size" viewBox="0 0 24 24" fill="none"
       stroke="currentColor" :stroke-width="weight" stroke-linecap="round"
       stroke-linejoin="round" role="img" aria-label="Bitcoin">
    <!-- Upper and lower bowls of the B -->
    <path d="M7 4h6.2a3.6 3.6 0 0 1 0 7.2H7" />
    <path d="M7 11.2h7a3.9 3.9 0 0 1 0 7.8H7" />
    <!-- Stem -->
    <path d="M7 4v15" />
    <!-- The two strokes through it, top and bottom -->
    <path d="M10.2 1.6V4M14 1.6V4M10.2 19v2.4M14 19v2.4" />
  </svg>
</template>

<style scoped>
/* Sits on the text baseline rather than floating above it, and never shrinks
   inside a flex row. */
.btc-sign { display: inline-block; vertical-align: -0.14em; flex-shrink: 0; }
</style>
