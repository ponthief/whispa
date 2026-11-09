/**
 * Let the screen render what was just set, before the thread is taken again.
 *
 * WHY THIS KEEPS BEING NEEDED. A state update is queued, not drawn: React
 * hands it to the renderer when the JS thread next goes idle. So a message set
 * immediately before synchronous work arrives AFTER that work — which, for
 * everything in the backup path, is the whole of the wait it was meant to
 * explain. The symptom is always the same and always reads as a dead button:
 *
 *   2026-11-09, the restore loop — "nothing happens for some time, there is no
 *   progress and then suddenly it restores."
 *   2026-11-09, the open itself — "pressing Open backup file after passphrase
 *   entered shows as if nothing is happening!!"
 *
 * The second one is the same bug one step earlier. `decryptBackup` parses the
 * file and decodes three base64 blobs before the KDF's first yield, and
 * `encryptBackup` is the same in reverse; on a large file that is long enough
 * to notice, and the "Opening…" set on the line above had not been drawn.
 *
 * One macrotask is enough and it costs a frame. Await it after setting a
 * message and before any synchronous stretch — that is the entire contract.
 *
 * Not a React hook and not RN-specific: `setTimeout` is in both runtimes, so
 * the browser modal uses it for the same reason.
 */
export function paint(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
