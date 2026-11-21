import * as Keychain from 'react-native-keychain';

// Device-only memos for transactions, keyed by txid — the note the sender types
// on the Send screen. See services/memo.ts for what a memo is and is not.
//
// Beside services/txLabels.ts and for the same reasons, copied rather than
// shared because the two are different data with different lifetimes: a label
// says who a payment was to, a memo says what it was for, and either can exist
// without the other. NEVER sent to the server. In the platform keystore,
// because "what I paid for" is the metadata this wallet exists to keep private,
// and because that is what lets the duress wipe erase it with the keys.

const MEMOS_SERVICE = 'com.thrilla.txmemos';

export type TxMemoMap = Record<string, string>;

export async function loadTxMemos(): Promise<TxMemoMap> {
  try {
    const c = await Keychain.getGenericPassword({ service: MEMOS_SERVICE });
    if (!c) return {};
    const parsed = JSON.parse(c.password);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as TxMemoMap;
  } catch {
    return {};
  }
}

export async function persistTxMemos(map: TxMemoMap): Promise<void> {
  try {
    await Keychain.setGenericPassword('txmemos', JSON.stringify(map), {
      service: MEMOS_SERVICE,
      accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED,
    });
  } catch {
    /* keystore unavailable — the in-memory map still applies this session */
  }
}

// Erased by the duress PIN with the keys and the labels: a note on what a
// payment was for is as much "who I paid" as the label is.
export async function wipeTxMemos(): Promise<void> {
  try {
    await Keychain.resetGenericPassword({ service: MEMOS_SERVICE });
  } catch {
    /* best-effort, same as the key wipe */
  }
}
