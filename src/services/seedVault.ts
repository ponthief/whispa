import * as Keychain from 'react-native-keychain';

// The seed phrase, kept on this device so it can be shown again.
//
// WHY THIS IS NOT A NEW EXPOSURE: the keystore already holds this wallet's
// spendKey — "the spend key can move funds", per services/secureKeys — and its
// BIP-84 account xprv. Anything that can read the phrase out of the keystore
// could already have emptied the wallet with what was next to it. The phrase is
// marginally broader (it regenerates every derivation, including ones not made
// yet) but it is not the difference between safe and not.
//
// What it buys is the case that has no recovery today: the phrase is shown once
// at creation, and a user who was interrupted, or who wrote a word down wrong,
// had no second chance. The wallet kept working, so nothing looked wrong until
// the device was lost.
//
// WHAT IS DELIBERATELY NOT HERE: the BIP-39 passphrase. It is the one factor
// that is not on the device, so a keystore dump does not yield a working
// recovery of a passphrase-protected wallet. That also means the reveal is
// INCOMPLETE for those wallets, which the reveal has to say out loud — a user
// who thinks twelve words are enough will find out otherwise at the worst
// possible moment.
//
// Kept in its own keystore entry rather than inside the WalletKeys record so
// that reading keys for a scan or a send — which happens constantly — does not
// pull the phrase into JS memory. It is read only when it is being shown.
//
// Erased by the duress PIN and by wallet removal (services/secureKeys drives
// both from its index), and by the user directly, so anyone who would rather
// the phrase not be re-revealable can say so after backing it up.

export function seedServiceFor(walletId: string): string {
  return `com.thrilla.seed.${walletId}`;
}

export async function saveSeed(
  walletId: string,
  mnemonic: string,
): Promise<boolean> {
  const phrase = mnemonic.trim();
  if (!phrase) return false;
  try {
    await Keychain.setGenericPassword(walletId, phrase, {
      service: seedServiceFor(walletId),
      accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED,
    });
    return true;
  } catch {
    // The wallet is already created and working at this point, so a keystore
    // refusal must not fail it. The cost is that this wallet's phrase cannot be
    // re-revealed, which is the behaviour every wallet had before this existed.
    return false;
  }
}

export async function readSeed(walletId: string): Promise<string | null> {
  try {
    // getGenericPassword resolves to `false` when there is no entry, so this
    // cannot be an optional-chain on a property.
    const c = await Keychain.getGenericPassword({
      service: seedServiceFor(walletId),
    });
    if (!c) return null;
    return c.password.trim() || null;
  } catch {
    return null;
  }
}

export async function hasSeed(walletId: string): Promise<boolean> {
  return (await readSeed(walletId)) != null;
}

export async function forgetSeed(walletId: string): Promise<void> {
  try {
    await Keychain.resetGenericPassword({ service: seedServiceFor(walletId) });
  } catch {
    /* best-effort, like the key wipe */
  }
}
