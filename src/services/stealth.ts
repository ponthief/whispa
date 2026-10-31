import { NativeModules, Platform } from 'react-native';

// Stealth mode: which icon and name this app wears on the home screen.
//
// Android shows one icon per enabled `activity-alias` carrying MAIN/LAUNCHER.
// The manifest declares three onto MainActivity — the real one and two decoys
// — and stealth/StealthModule.kt flips which is enabled. Nothing about the app
// itself changes: the same MainActivity opens behind whichever icon was
// tapped, straight into the app lock if one is set.
//
// WHAT IT HIDES: the wallet's name and icon from somebody scrolling the home
// screen or the app drawer.
//
// WHAT IT DOES NOT HIDE, and the Settings copy says all of this rather than
// letting somebody infer more protection than exists:
//
//   * The app name in Settings → Apps, and in the storage and battery lists.
//     Those read the application label, which an alias cannot change.
//   * The notification header, for the same reason — which is why turning
//     stealth on turns push off. See SecurityPage.
//   * Anybody who taps the decoy. It opens the wallet. The disguise is
//     against a glance, not against a search, and the app lock and the duress
//     PIN are what stand behind it.

export type StealthAlias = 'default' | 'calculator' | 'notes';

export const STEALTH_ALIASES: { key: StealthAlias; label: string }[] = [
  { key: 'default', label: 'WhiSPa' },
  { key: 'calculator', label: 'Calculator' },
  { key: 'notes', label: 'Notes' },
];

type Native = {
  getAlias(): Promise<StealthAlias>;
  setAlias(name: StealthAlias): Promise<StealthAlias>;
};

// Asked of NativeModules rather than of Platform.OS alone, for the reason
// push.ts gives about its own module: the question is "is the native side
// here", and a build can disagree with a flag while it cannot disagree with
// this. It also keeps an older install that predates the module from throwing
// on a screen that merely renders.
//
// Platform is checked too, because the mechanism is Android's: iOS has no
// equivalent short of alternate app icons, which is a different API with a
// different set of limitations and is not what this is.
export function stealthAvailable(): boolean {
  return Platform.OS === 'android' && !!NativeModules.StealthModule;
}

function native(): Native {
  const m = NativeModules.StealthModule as Native | undefined;
  if (!m) throw new Error('stealth-unavailable');
  return m;
}

// Read from the PackageManager, never from app storage.
//
// The enabled state is what the launcher actually obeys, and it survives the
// app's own data being cleared — so a copy kept in a store can disagree with
// the icon on the home screen. A screen offering to change it has to show
// what is true.
export async function currentAlias(): Promise<StealthAlias> {
  if (!stealthAvailable()) return 'default';
  try {
    return await native().getAlias();
  } catch {
    return 'default';
  }
}

export async function setAlias(name: StealthAlias): Promise<StealthAlias> {
  return native().setAlias(name);
}

// Whether a decoy is being worn. One expression, so a third decoy added later
// cannot leave a caller testing `=== 'calculator'` and quietly treating the
// new one as "stealth is off" — which would leave push on under a disguise.
export function isDisguised(alias: StealthAlias): boolean {
  return alias !== 'default';
}
