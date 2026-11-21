// check:memo — the memo on Send: 200 characters, one line, kept on the device,
// shown in Activity, and carried by the backup.
//
// Requested 2026-11-21. A memo is a note the SENDER writes to themselves. It is
// not in the transaction and not sent to the server, so every way it could end
// up somewhere else is a thing this checks. Comments are stripped before any
// source assertion (the trap check:stealth and check:backup both fell into).
import fs from 'node:fs';

// A localStorage for the web stores, which reach for the global.
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
};

const { MEMO_MAX, clampMemo, memoLength } = await import('../src/services/memo.ts');
const { saveTxMemo, getTxMemo } = await import('../src/stores/txmemos.js');
const { BACKUP_KEYS, collectBackup, applyBackup } = await import('../src/stores/backupdata.js');

let bad = 0;
const ok = (name, cond, extra) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`);
  if (!cond) { bad++; if (extra) console.log('     ' + extra); }
};
const strip = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '')
  .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const read = (f) => strip(fs.readFileSync(f, 'utf8'));

console.log('the rule');
ok('the limit is 200', MEMO_MAX === 200);
ok('200 characters are kept whole', clampMemo('a'.repeat(200)).length === 200);
ok('201 are cut to 200', Array.from(clampMemo('a'.repeat(201))).length === 200);
ok('an emoji is one character, and a cut never splits one',
  Array.from(clampMemo('😀'.repeat(250))).length === 200 &&
  !/[\ud800-\udbff](?![\udc00-\udfff])/.test(clampMemo('😀'.repeat(250))));
ok('a newline or tab becomes a space: one line',
  clampMemo('rent\nfor\tNovember\r\n') === 'rent for November');
ok('trimmed, and empty means none', clampMemo('   ') === '' && clampMemo(null) === '' && clampMemo(undefined) === '');
ok('a number is text, not a crash', clampMemo(0) === '0');
ok('the counter counts characters', memoLength('😀a') === 2);

console.log('the web store');
saveTxMemo('tx1', '  coffee  ');
ok('saved trimmed, read back', getTxMemo('tx1') === 'coffee');
saveTxMemo('tx1', '');
ok('an emptied memo clears it', getTxMemo('tx1') === null);
saveTxMemo('tx2', 'x'.repeat(500));
ok('an oversized memo is cut on the way in', Array.from(getTxMemo('tx2')).length === 200);
ok('no txid, nothing stored', (saveTxMemo('', 'x'), getTxMemo('') === null));
ok('it is in localStorage only: the key is the one the backup names',
  BACKUP_KEYS.txMemos === 'thrilla_tx_memos_v1' && mem.has('thrilla_tx_memos_v1'));

console.log('the backup, web');
saveTxMemo('txA', 'invoice 42');
const file = collectBackup([], {});
ok('a memo is in the file', file.sections.txMemos && file.sections.txMemos.txA === 'invoice 42');
mem.clear();
const rep = applyBackup(file, []);
ok('restored into an empty browser', getTxMemo('txA') === 'invoice 42' && rep.sections.txMemos.added >= 1);
ok('and not reported as a section it did not understand', !rep.skipped.includes('txMemos'));
saveTxMemo('txA', 'edited since');
applyBackup(file, []);
ok('the FILE wins where both hold the same txid', getTxMemo('txA') === 'invoice 42');
saveTxMemo('txNew', 'written after the backup');
applyBackup(file, []);
ok('a memo written since, for another txid, is left alone', getTxMemo('txNew') === 'written after the backup');
mem.clear();
applyBackup({ app: 'whispa', payloadVersion: 1, exportedAt: 0, sections: {
  txMemos: { big: 'y'.repeat(5000), num: 7, obj: { a: 1 }, nl: 'a\nb', fine: 'ok' } } }, []);
ok('a hand-edited file cannot park an unbounded string', Array.from(getTxMemo('big') || '').length === 200);
ok('or something that is not text', getTxMemo('num') === null && getTxMemo('obj') === null);
ok('newlines in a file are flattened too', getTxMemo('nl') === 'a b');

console.log('the backup, phone (source)');
const RN = read('src/services/backupData.ts');
ok('the collector reads the memo store', /loadTxMemos\(\)/.test(RN) && /sections\.txMemos = txMemos/.test(RN));
ok('the restore writes it back, clamped', /persistTxMemos\(existing\)/.test(RN) && /clampMemo\(memo\)/.test(RN));
ok('and names it a known section', /KNOWN_SECTIONS = \['txLabels', 'txMemos'/.test(RN));

console.log('Send, web');
const SV = read('src/views/SendView.vue');
ok('the field is capped at the limit', /:maxlength="MEMO_MAX"/.test(SV));
ok('it is saved at BOTH broadcasts', (SV.match(/saveTxMemo\(res\.txid, memo\.value\)/g) || []).length === 2);
ok('it travels with the tab and the draft', /memo: memo\.value/.test(SV) && /memo\.value = s\.memo/.test(SV) && /'amount', 'memo'/.test(SV));
ok('it is cleared with the form', /amount\.value = null; memo\.value = ''/.test(SV));
ok('it is not offered while a swap is funding', /v-if="!isSwapFunding" class="field">\s*<label>Memo/.test(SV));
ok('the draft store keeps it', /memo: t\.memo/.test(read('src/stores/senddraft.js')));

console.log('Send, phone');
const SS = read('src/screens/SendScreen.tsx');
ok('the field is capped at the limit', /maxLength=\{MEMO_MAX\}/.test(SS));
ok('it is saved at BOTH broadcasts', (SS.match(/useTxMemoStore\.getState\(\)\.setMemo\(res\.txid, memo\)/g) || []).length === 2);
ok('it is in the draft and cleared with the form', /memo,\n    \}\);/.test(SS) && /setMemo\(''\);/.test(SS));
ok('the broadcast callback depends on it', /recipient, memo, amountSats/.test(SS));

console.log('Activity');
ok('web: the row and the detail', (read('src/views/TransactionsView.vue').match(/getTxMemo\(/g) || []).length >= 4);
ok('phone: the row carries it', /memo\?: string/.test(read('src/components/TransactionList.tsx')) && /txMemoMap\[it\.id\]/.test(read('src/screens/WalletScreen.tsx')));
ok('phone: the detail sheet shows it', /useTxMemoStore/.test(read('src/components/TxDetailModal.tsx')) && /Memo<\/Text>/.test(read('src/components/TxDetailModal.tsx')));

console.log('device only');
ok('the phone store is the keystore and nothing else', /Keychain/.test(read('src/services/txMemos.ts')) && !/fetch\(|api\./.test(read('src/services/txMemos.ts')));
ok('neither client sends it to the server', !/memo/i.test(
  (read('src/api/index.js').match(/broadcast[\s\S]{0,400}/gi) || []).join('')));
ok('the duress wipe erases the phone store', /useTxMemoStore\.getState\(\)\.clearAll\(\)/.test(read('src/services/duress.ts')));
ok('the phone loads it at start', /loadTxMemos\(\)/.test(read('src/App.tsx')));

process.exit(bad ? 1 : 0);
