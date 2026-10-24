// Push notifications (Firebase Cloud Messaging).
//
// Notifications arrive when the app is closed (e.g. a server-side background scan
// found a payment). Android displays notification-type messages automatically;
// this module just handles permission + registering the device token with the
// backend so the server knows where to send.
//
// Everything is wrapped so the app works fine when Firebase ISN'T configured
// (no android/app/google-services.json) — push simply stays off.
import { NativeModules, PermissionsAndroid, Platform } from 'react-native';
import * as api from './api';
import { usePushBanner } from '@stores/pushBanner';
import { alertsOn } from '@stores/notifyStore';
import { useNavStore } from '@stores/navStore';

let unsubscribeRefresh: (() => void) | null = null;
let unsubscribeMessage: (() => void) | null = null;

// ── Firebase may not be in this build at all ────────────────────────────────
//
// The F-Droid build excludes @react-native-firebase/* from autolinking (see
// react-native.config.js and FDROID.md), because Firebase Cloud Messaging is a
// proprietary Google SDK and an F-Droid build should not carry one. The npm
// packages stay installed, so this file still resolves — what is missing is
// the NATIVE module behind it.
//
// Which is why the import is no longer at the top. A static
// `import messaging from '@react-native-firebase/messaging'` resolves fine and
// then throws "You attempted to use a firebase module that's not installed
// natively" the first time anything calls it — at app start, from an effect,
// with a message naming a library the user has never heard of.
//
// Asked of NativeModules rather than of a build flag, because the question is
// "is the native side here", and that is the thing that actually answers it.
// A flag can disagree with the APK; this cannot.
//
// NOT platform-gated. iOS registers for push through the same module, and
// gating this on Android would have switched iOS push off as a side effect of
// an Android packaging decision.
export function pushAvailable(): boolean {
  return !!NativeModules.RNFBMessagingModule;
}

// The module's default export, loaded on demand. It is both callable (for the
// instance) and the carrier of AuthorizationStatus, so the two uses below both
// come from here. Typed loosely on purpose: importing the package's types at
// the top is the static dependency this is avoiding.
function fcm(): any {
  if (!pushAvailable()) throw new Error('push-unavailable');
  return require('@react-native-firebase/messaging').default;
}

// Every caller below already sits in a try/catch with a safe default, so a
// throw from here degrades to "push is off" rather than to a crash. The
// explicit early returns in register/unregister are there anyway, because
// control flow through an exception for the ordinary case of a build without
// Firebase would be the wrong shape.
function messaging(): any {
  return fcm()();
}

// Every `type` the backend sets on a push (siLNt views_api.py).
//
// The value has to be known in two languages: here, to choose the wording of a
// foreground banner, and in Kotlin, where
// notify/PaymentNotificationReceiver.kt refuses an unknown type outright. The
// messages are data-only, so a type the receiver does not know produces not a
// plain notification but silence — which is how Tango pushes existed on the
// server for weeks and reached nobody with the app closed. Listed once here so
// scripts/check-settings-ui.cjs can hold the Kotlin side to it, and
// siLNt tests/test_fcm_message.py to the same set from the other end.
export const PUSH_TYPES = [
  'payment',
  'send_confirmed',
  'test',
  'tango',
] as const;

// Show a foreground FCM message as an in-app banner. Android does NOT display
// notification-type messages while the app is in the foreground, so without this
// a payment that lands with the app open would be silent.
//
// The fallback title and body are chosen from `data.type`, not fixed: this used
// to default to "Payment received" for anything it didn't recognise, so a Tango
// from a server that sent no title would have announced itself as money
// arriving.
function handleForegroundMessage(msg: any): void {
  try {
    // Alerts turned off in Settings → stay quiet. The token is also
    // unregistered in that case, so this is just belt and braces for a message
    // that was already in flight (or a removal that failed while offline).
    if (!alertsOn()) return;
    // Data-only now: the server stopped sending a `notification` block so the
    // firebase SDK would not display the background notification itself, which
    // is what let notify/PaymentNotificationReceiver.kt build one with the logo
    // on it. So title and body come out of the data map. The `notification`
    // fallback stays for a message sent by an older server.
    const n = msg?.notification;
    const d = msg?.data;
    const type = d?.type;
    // A send confirming is announced locally by useSendConfirmations, which
    // knows the amount — the push deliberately carries none, since FCM message
    // bodies pass through Google in plaintext. Showing both would double-banner
    // the same event, so with the app open the local one wins. This push exists
    // for the case the app is closed, which Android displays itself.
    if (type === 'send_confirmed') return;
    const tango = type === 'tango';
    // The server only pushes about a round when something happened to it, so
    // this is the earliest the app can know. Without it the screen waited on
    // the watcher's next poll — up to twenty seconds of a cancelled round
    // still showing as live, with its coins still held.
    if (tango) useNavStore.getState().bumpTango();
    const title =
      d?.title || n?.title || (tango ? 'Tango' : 'Payment received');
    const body =
      d?.body ||
      n?.body ||
      (tango ? 'Open WhiSPa to look.' : 'You have a new payment.');
    usePushBanner.getState().show({ title, body });
  } catch {
    /* never let a malformed message break the handler */
  }
}

// Ask the OS for notification permission. Called at first launch so the user is
// prompted early (before device-trust/token registration), and again defensively
// inside registerForPush. Returns true if notifications are allowed.
//
// Android 13+ (API 33) gates notifications behind the POST_NOTIFICATIONS runtime
// permission, which the OS does NOT auto-grant, and messaging().requestPermission()
// alone doesn't reliably show the Android system dialog — so request it explicitly.
// If already granted, PermissionsAndroid.request returns immediately with no
// second dialog. No-op that resolves true on Android <13. Safe if native push
// isn't available.
export async function ensureNotificationPermission(): Promise<boolean> {
  try {
    if (Platform.OS === 'android') {
      if (Number(Platform.Version) < 33) return true; // auto-granted pre-13
      const res = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
      );
      return res === PermissionsAndroid.RESULTS.GRANTED;
    }
    // iOS: the FCM/APNs authorization prompt.
    const status = await messaging().requestPermission();
    return (
      status === fcm().AuthorizationStatus.AUTHORIZED ||
      status === fcm().AuthorizationStatus.PROVISIONAL
    );
  } catch {
    return false;
  }
}

// Is the OS notification permission currently granted? Unlike
// ensureNotificationPermission this never prompts — Settings uses it to warn
// when payment alerts are switched on but the phone is blocking them anyway.
// Returns true when it can't tell (no native module, Android < 13), so the UI
// doesn't cry wolf.
export async function hasNotificationPermission(): Promise<boolean> {
  try {
    if (Platform.OS === 'android') {
      if (Number(Platform.Version) < 33) return true;
      return await PermissionsAndroid.check(
        PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
      );
    }
    const status = await messaging().hasPermission();
    return (
      status === fcm().AuthorizationStatus.AUTHORIZED ||
      status === fcm().AuthorizationStatus.PROVISIONAL
    );
  } catch {
    return true;
  }
}

// Ask for notification permission (Android 13+ prompts), get the FCM token, and
// register it with the backend. Also keeps the backend in sync if the token
// rotates. Safe no-op if Firebase/native push isn't available.
export async function registerForPush(inkey: string): Promise<void> {
  // No Firebase in this build (F-Droid) — there is no token to hand the
  // server and nothing to unregister. Returns quietly: a build without
  // push is a supported configuration, not a failure.
  if (!pushAvailable()) return;
  try {
    // Alerts off in Settings → don't hand the server a token to push to.
    // Callers already gate on the pref; this is a second line of defence so
    // no code path can quietly re-enable notifications the user switched off.
    if (!alertsOn()) return;

    // Ensure the OS notification permission (no-op / no second dialog if the
    // first-launch prompt already granted it). Without a grant, pushes are
    // silently dropped, so don't bother registering a token.
    if (!(await ensureNotificationPermission())) return;

    const token = await messaging().getToken();
    if (token) await api.registerPushToken(inkey, token);

    if (unsubscribeRefresh) unsubscribeRefresh();
    unsubscribeRefresh = messaging().onTokenRefresh(async (t: string) => {
      try {
        await api.registerPushToken(inkey, t);
      } catch {
        /* transient — will re-register next launch */
      }
    });

    // Foreground messages: display them ourselves (Android won't).
    if (unsubscribeMessage) unsubscribeMessage();
    unsubscribeMessage = messaging().onMessage(async (msg: any) => {
      handleForegroundMessage(msg);
    });
  } catch {
    // Firebase not configured or native module unavailable — leave push off.
  }
}

// Stop this device from receiving pushes (on logout, or when the user turns
// alerts off in Settings).
export async function unregisterForPush(inkey: string): Promise<void> {
  // No Firebase in this build (F-Droid) — there is no token to hand the
  // server and nothing to unregister. Returns quietly: a build without
  // push is a supported configuration, not a failure.
  if (!pushAvailable()) return;
  try {
    if (unsubscribeRefresh) {
      unsubscribeRefresh();
      unsubscribeRefresh = null;
    }
    if (unsubscribeMessage) {
      unsubscribeMessage();
      unsubscribeMessage = null;
    }
    const token = await messaging().getToken();
    if (token) await api.unregisterPushToken(inkey, token);
  } catch {
    /* ignore */
  }
}
