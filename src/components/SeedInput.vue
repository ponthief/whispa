<script setup>
import { ref, computed, nextTick } from 'vue'
import { BIP39_WORDS } from '@/data/bip39-english.js'

const props = defineProps({
  modelValue: { type: String, default: '' },
  rows:       { type: Number, default: 3 },
  placeholder:{ type: String, default: 'twelve or twenty-four word seed phrase' },
})
const emit = defineEmits(['update:modelValue'])

const ta       = ref(null)
const revealed = ref(false)             // masked by default
const suggestions = ref([])
const activeSug   = ref(0)

const wordset = BIP39_WORDS.length ? new Set(BIP39_WORDS) : null

// Invalid-word hint: words the user typed that aren't in the BIP-39 list. Only
// when the list is present; purely advisory (never blocks submission).
const invalidWords = computed(() => {
  if (!wordset) return []
  const words = (props.modelValue || '').trim().toLowerCase().split(/\s+/).filter(Boolean)
  // don't flag the word currently being typed (no trailing space yet)
  const endsMidWord = props.modelValue.length > 0 && !/\s$/.test(props.modelValue)
  const check = endsMidWord ? words.slice(0, -1) : words
  return [...new Set(check.filter(w => !wordset.has(w)))]
})

function onInput(e) {
  emit('update:modelValue', e.target.value)
  updateSuggestions(e.target)
}

// Autocomplete for the word at the cursor.
function currentWordInfo(el) {
  const val = el.value
  const pos = el.selectionStart ?? val.length
  const before = val.slice(0, pos)
  const m = before.match(/(\S+)$/)          // the partial word right before cursor
  const word = m ? m[1] : ''
  const start = m ? pos - word.length : pos
  return { word: word.toLowerCase(), start, pos, val }
}

function updateSuggestions(el) {
  if (!wordset) { suggestions.value = []; return }
  const { word } = currentWordInfo(el)
  if (word.length < 2) { suggestions.value = []; return }
  // exact match already complete → no need to suggest
  const matches = BIP39_WORDS.filter(w => w.startsWith(word)).slice(0, 6)
  suggestions.value = (matches.length === 1 && matches[0] === word) ? [] : matches
  activeSug.value = 0
}

function applySuggestion(sug) {
  const el = ta.value
  if (!el) return
  const { start, pos, val } = currentWordInfo(el)
  // replace the partial word with the suggestion + a trailing space
  const next = val.slice(0, start) + sug + ' ' + val.slice(pos)
  emit('update:modelValue', next)
  suggestions.value = []
  nextTick(() => {
    el.focus()
    const caret = start + sug.length + 1
    el.setSelectionRange(caret, caret)
  })
}

function onKeydown(e) {
  if (!suggestions.value.length) return
  if (e.key === 'ArrowDown') { e.preventDefault(); activeSug.value = (activeSug.value + 1) % suggestions.value.length }
  else if (e.key === 'ArrowUp') { e.preventDefault(); activeSug.value = (activeSug.value - 1 + suggestions.value.length) % suggestions.value.length }
  else if (e.key === 'Enter' || e.key === 'Tab') {
    // complete the highlighted suggestion
    e.preventDefault(); applySuggestion(suggestions.value[activeSug.value])
  } else if (e.key === 'Escape') { suggestions.value = [] }
}

function onBlur() {
  // delay so a click on a suggestion still registers
  setTimeout(() => { suggestions.value = [] }, 150)
}
</script>

<template>
  <div class="seed-field">
    <div class="seed-input-wrap">
      <textarea
        ref="ta"
        :value="modelValue"
        :rows="rows"
        :placeholder="placeholder"
        spellcheck="false"
        autocomplete="off"
        autocapitalize="off"
        autocorrect="off"
        class="input seed-textarea"
        :class="{ masked: !revealed }"
        @input="onInput"
        @keydown="onKeydown"
        @blur="onBlur"
      ></textarea>
      <button type="button" class="seed-eye" :title="revealed ? 'Hide phrase' : 'Show phrase'"
              @click="revealed = !revealed">{{ revealed ? 'Hide' : 'Show' }}</button>

      <ul v-if="suggestions.length" class="seed-suggest">
        <li v-for="(s, i) in suggestions" :key="s"
            :class="{ active: i === activeSug }"
            @mousedown.prevent="applySuggestion(s)">{{ s }}</li>
      </ul>
    </div>

    <p v-if="invalidWords.length" class="text-dim text-xs seed-warn">
      Not in the BIP-39 word list: <strong>{{ invalidWords.join(', ') }}</strong> — check spelling.
    </p>
  </div>
</template>

<style scoped>
.seed-field { position: relative; }
.seed-input-wrap { position: relative; }
.seed-textarea {
  width: 100%;
  font-family: var(--font-mono);
  font-size: 13px;
  resize: vertical;
  padding-right: 64px;
}
/* Mask characters while keeping the textarea editable. Chromium/Safari honor
   -webkit-text-security; other engines fall back to the security font. */
.seed-textarea.masked {
  -webkit-text-security: disc;
  text-security: disc;
}
.seed-eye {
  position: absolute; top: 6px; right: 6px;
  background: var(--orange-dim, #F7931A33);
  color: var(--orange, #F7931A);
  border: 1px solid var(--orange, #F7931A);
  border-radius: 6px; cursor: pointer;
  font-size: 12px; font-weight: 600; line-height: 1;
  padding: 5px 10px;
}
.seed-eye:hover { background: var(--orange, #F7931A); color: #0E1330; }
.seed-suggest {
  position: absolute; z-index: 30; left: 0; right: 64px; top: 100%;
  margin: 4px 0 0; padding: 4px; list-style: none;
  background: var(--panel, #161C42); border: 1px solid var(--border, #2A3358);
  border-radius: 8px; max-height: 200px; overflow-y: auto;
}
.seed-suggest li {
  padding: 6px 10px; border-radius: 6px; cursor: pointer;
  font-family: var(--font-mono); font-size: 13px;
}
.seed-suggest li.active, .seed-suggest li:hover { background: var(--orange-dim, #F7931A33); }
.seed-warn { margin-top: 6px; }
</style>
