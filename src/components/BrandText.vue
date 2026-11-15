<script setup>
import { computed } from 'vue'
import BitcoinSign from '@/components/BitcoinSign.vue'

// Text in which the B of "BitMail" is the Bitcoin sign (2026-11-15: "make a
// changes to display for Bitmail so that B is Bitcoin logo").
//
// It is for places the NAME is shown — the nav, a page or card heading — and
// not for running prose, where a drawn glyph in the middle of a sentence is
// noise. It also splits on the name alone, so "BitMail Requests" keeps its
// second word and a string with no BitMail in it renders unchanged.
//
// The sign is drawn, never typed: see BitcoinSign.vue for why the character is
// not safe. An `aria-label` on the wrapper keeps the name readable aloud as
// "BitMail", where the drawn B alone would read as "Bitcoin".
const props = defineProps({ text: { type: String, default: '' } })

const parts = computed(() => {
  const out = []
  const re = /BitMail/g
  let last = 0, m
  while ((m = re.exec(props.text)) !== null) {
    if (m.index > last) out.push({ t: props.text.slice(last, m.index) })
    out.push({ name: true })
    last = m.index + m[0].length
  }
  if (last < props.text.length) out.push({ t: props.text.slice(last) })
  return out
})
</script>

<template>
  <span :aria-label="text">
    <template v-for="(p, i) in parts" :key="i"><span v-if="p.name" class="brand-name"><BitcoinSign class="brand-btc" aria-hidden="true" />itMail</span><template v-else>{{ p.t }}</template></template>
  </span>
</template>

<style scoped>
/* The drawn sign has about a quarter of its width as padding on each side, which
   is right beside a number and wrong inside a word: "BitMail" read as "B itMail".
   Pulled in so the strokes sit where the letter would. */
.brand-btc { margin: 0 -0.2em 0 -0.12em; }
/* One unbreakable unit: in the phone-width bottom nav the label is narrow
   enough to wrap, and a break between the sign and "itMail" left a lone B-sign
   on one line and the rest of the word on the next. */
.brand-name { white-space: nowrap; }
</style>
