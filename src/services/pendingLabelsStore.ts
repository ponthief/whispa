import * as Keychain from 'react-native-keychain';

import * as api from './api';
import { countQueued, flushPendingLabels } from './pendingLabels';
import type { PendingLabelQueue } from './pendingLabels';

// Where the phone keeps the labels a restore could not place yet.
//
// The rules are in services/pendingLabels.ts; this is the keystore half, and
// it is deliberately the same shape as services/txLabels.ts.
//
// IN THE KEYSTORE for the reason that file gives about its own map: a label is
// not a secret the way a spend key is, but "who I paid" against a txid is
// exactly the metadata this wallet exists to keep private, and the keystore
// encrypts it at rest. It is also what lets the duress wipe take it — which it
// must, since this queue holds the same labels txLabels does, waiting.

const PENDING_SERVICE = 'com.thrilla.pendinglabels';

export async function loadPendingLabels(): Promise<PendingLabelQueue | null> {
  try {
    const c = await Keychain.getGenericPassword({ service: PENDING_SERVICE });
    if (!c) return null;
    return JSON.parse(c.password);
  } catch {
    return null;
  }
}

export async function savePendingLabels(queue: PendingLabelQueue): Promise<void> {
  try {
    // Nothing owed means the record goes, rather than an empty one being
    // written: its presence is what says there is work left.
    if (!countQueued(queue)) {
      await Keychain.resetGenericPassword({ service: PENDING_SERVICE });
      return;
    }
    await Keychain.setGenericPassword('pendinglabels', JSON.stringify(queue), {
      service: PENDING_SERVICE,
      accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED,
    });
  } catch {
    /* keystore unavailable — the labels stay owed and the next flush retries */
  }
}

/**
 * Try the queue again, wired to this client's storage and api.
 *
 * Called when a scan finishes — the moment the coins a label was waiting for
 * appear — and once when the wallet screen loads, which covers the scan that
 * ran while the app was closed, or on the web, or on the server's own
 * background scanner. None of those reaches the progress store.
 *
 * COSTS NOTHING WHEN NOTHING IS OWED: one keystore read and it returns, with
 * no network call at all, which is what makes it safe on both of those paths.
 * It never throws; a label that is still owed stays owed.
 */
export async function flushLabelQueue(inkey: string | null): Promise<void> {
  if (!inkey) return;
  try {
    await flushPendingLabels({
      api: api as any,
      inkey,
      load: loadPendingLabels,
      save: savePendingLabels,
      liveWallets: async () =>
        ((await api.getSilntWallets(inkey)) || []).map((w: any) => ({
          id: w.id,
          spAddress: w.sp_address || '',
        })),
    });
  } catch {
    /* the queue keeps them; the next scan tries again */
  }
}

/** Taken by the duress wipe, with the labels it is holding. */
export async function wipePendingLabels(): Promise<void> {
  try {
    await Keychain.resetGenericPassword({ service: PENDING_SERVICE });
  } catch {
    /* best-effort, same as the key wipe */
  }
}
