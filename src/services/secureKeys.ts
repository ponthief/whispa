import * as Keychain from 'react-native-keychain';
import { forgetSeed } from './seedVault';

// Per-wallet secure storage for Silent Payments keys (scan_secret + spend_key).
// Backed by the platform keystore (Android Keystore / iOS Keychain) via
// react-native-keychain. The spend key can move funds, so these must never be
// written to plain storage. One keychain "service" entry per wallet id.

export interface WalletKeys {
  scanSecret: string;
  spendKey: string;
  // The wallet's BIP-84 refund address (services/spKeys). PUBLIC, not key
  // material — it lives here only because this is already the per-wallet record
  // and deriving it needs the mnemonic, which exists in memory only at
  // create/recover time. Absent on wallets stored before it was derived.
  refundAddress?: string;
  // BIP-84 ACCOUNT extended private key (m/84'/coin'/0'), for the plain address
  // chain. Held here so the wallet can hand out a fresh plain address per
  // payment and sign from it without the user re-entering their seed phrase.
  //
  // A smaller secret than the spendKey already in this record: it reaches one
  // branch holding coins in transit, where the spend key reaches the whole
  // wallet. Wiped with everything else by the duress PIN. Absent on wallets
  // stored before it existed — PlainSetupModal backfills it.
  //
  // The NAME is deliberately left as-is: it is a key in the serialized keystore
  // blob on devices in the wild, and renaming it would silently orphan their
  // account key and send them back through the recovery-phrase prompt.
  sweepAccount?: string;
}

function serviceFor(walletId: string): string {
  return `com.thrilla.wallet.${walletId}`;
}

// react-native-keychain can't enumerate services, so we keep our own index of
// wallet ids that have keys stored. This lets the duress wipe erase *every*
// wallet's keys without needing the server or a live session.
const INDEX_SERVICE = 'com.thrilla.wallet.index';

async function readIndex(): Promise<string[]> {
  try {
    const c = await Keychain.getGenericPassword({ service: INDEX_SERVICE });
    if (!c) return [];
    const arr = JSON.parse(c.password);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

async function writeIndex(ids: string[]): Promise<void> {
  try {
    await Keychain.setGenericPassword('index', JSON.stringify([...new Set(ids)]), {
      service: INDEX_SERVICE,
      accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED,
    });
  } catch {
    /* ignore */
  }
}

export async function storeWalletKeys(
  walletId: string,
  keys: WalletKeys,
): Promise<boolean> {
  try {
    await Keychain.setGenericPassword(
      walletId,
      JSON.stringify(keys),
      {
        service: serviceFor(walletId),
        accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED,
      },
    );
    await writeIndex([...(await readIndex()), walletId]);
    return true;
  } catch {
    return false;
  }
}

export async function getWalletKeys(walletId: string): Promise<WalletKeys | null> {
  try {
    const creds = await Keychain.getGenericPassword({ service: serviceFor(walletId) });
    if (!creds) return null;
    const parsed = JSON.parse(creds.password);
    if (parsed?.scanSecret && parsed?.spendKey) {
      // Self-heal the wipe index: keys stored before the index existed (or on a
      // prior app version) get recorded on first read, so the duress wipe can
      // reach every wallet. Only writes when actually missing.
      const idx = await readIndex();
      if (!idx.includes(walletId)) await writeIndex([...idx, walletId]);
      return parsed as WalletKeys;
    }
    return null;
  } catch {
    return null;
  }
}

export async function hasWalletKeys(walletId: string): Promise<boolean> {
  return (await getWalletKeys(walletId)) != null;
}

export async function removeWalletKeys(walletId: string): Promise<void> {
  try {
    await Keychain.resetGenericPassword({ service: serviceFor(walletId) });
  } catch {
    /* ignore */
  }
  // The stored seed phrase lives in its own entry (services/seedVault) and
  // would otherwise outlive the wallet it belongs to.
  await forgetSeed(walletId);
  await writeIndex((await readIndex()).filter((id) => id !== walletId));
}

// Erase EVERY wallet's keys from this device (used by the duress PIN). Works
// offline from the local index; funds remain safe on-chain and recover from the
// seed. Best-effort — never throws.
export async function wipeAllWalletKeys(): Promise<void> {
  const ids = await readIndex();
  for (const id of ids) {
    try {
      await Keychain.resetGenericPassword({ service: serviceFor(id) });
    } catch {
      /* keep going — wipe as much as possible */
    }
    // A stored phrase reconstructs every key this loop is erasing, so a wipe
    // that left it behind would not be a wipe at all.
    await forgetSeed(id);
  }
  try {
    await Keychain.resetGenericPassword({ service: INDEX_SERVICE });
  } catch {
    /* ignore */
  }
}
