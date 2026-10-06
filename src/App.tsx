import React, { useEffect, useRef, useState } from 'react';
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';
import {
  ActivityIndicator,
  AppState,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import WalletScreen from './screens/WalletScreen';
import SendScreen from './screens/SendScreen';
import ReceiveScreen from './screens/ReceiveScreen';
import SettingsScreen from './screens/SettingsScreen';
import TangoScreen from './screens/TangoScreen';
import LoginScreen from './screens/LoginScreen';
import RegisterScreen from './screens/RegisterScreen';
import ForgotPasswordScreen from './screens/ForgotPasswordScreen';
import DeviceConfirmScreen from './screens/DeviceConfirmScreen';
import LockScreen from './screens/LockScreen';
import LockSetupScreen from './screens/LockSetupScreen';
import { useAuthStore } from '@stores/authStore';
import { useAppLockStore } from '@stores/appLockStore';
import { useNotifyStore } from '@stores/notifyStore';
import { useBalancePrivacy } from '@stores/balancePrivacy';
import { useIdleLock } from './hooks/useIdleLock';
import { useVerifyLink } from './hooks/useVerifyLink';
import { touchActivity } from '@services/sessionActivity';
import {
  ensureNotificationPermission,
  registerForPush,
  unregisterForPush,
} from '@services/push';
import PushBanner from './components/PushBanner';
import BitcoinSign from './components/BitcoinSign';
import { useSendConfirmations } from './hooks/useSendConfirmations';
import { usePlainWatch } from './hooks/usePlainWatch';
import { useTangoWatch } from './hooks/useTangoWatch';
import { useNavStore, TabKey as NavTabKey } from '@stores/navStore';
import { useTxLabelStore } from '@stores/txLabelStore';
import { useSegwitLabels } from '@stores/segwitLabelStore';
import { usePlainHistory } from '@stores/plainHistoryStore';
import { colors, fonts, DEVICE_TRUST_ENABLED } from '@/theme';

// Scan lives inside Receive now (Address / Scan toggle), so it's no longer a tab.
// Defined in the nav store so screens can navigate without importing App.
type TabKey = NavTabKey;

// `icon` is a character; `Icon` a drawn one. The wallet tab uses the drawn sign
// because U+20BF is missing from Roboto before Android 8.0 (API 26) and this
// app supports 23 — and because it should match the balance exactly.
type TabIcon = React.ComponentType<{ size?: number; color: string; weight?: number }>;

const TABS: {
  key: TabKey;
  label: string;
  icon?: string;
  Icon?: TabIcon;
  Screen: React.ComponentType;
}[] = [
  { key: 'wallet', label: 'Wallet', Icon: BitcoinSign, Screen: WalletScreen },
  { key: 'send', label: 'Send', icon: '↑', Screen: SendScreen },
  { key: 'receive', label: 'Receive', icon: '↓', Screen: ReceiveScreen },
  // Its own tab, not a Settings page. The other party can start a Tango,
  // and something you did not start has to be somewhere you pass without
  // going looking — the same argument as Send and Receive.
  { key: 'tango', label: 'Tango', icon: '⇄', Screen: TangoScreen },
  { key: 'settings', label: 'Settings', icon: '⚙', Screen: SettingsScreen },
];

const PRIMARY = colors.primary;
const INACTIVE = colors.inactive;

function TabIconFor(
  tab: { icon?: string; Icon?: TabIcon },
  color: string,
) {
  const Icon = tab.Icon;
  if (Icon) {
    return <Icon size={26} color={color} weight={2.6} />;
  }
  return <Text style={[styles.tabIcon, { color }]}>{tab.icon}</Text>;
}

function TabBar({
  active,
  onSelect,
}: {
  active: TabKey;
  onSelect: (key: TabKey) => void;
}) {
  const insets = useSafeAreaInsets();
  // A Tango waiting on you is the one thing in this app that goes stale on
  // its own — rounds expire in a day, with both sides' coins reserved against
  // them until they do — so it gets a count, not just a dot.
  const tangoPending = useNavStore((s) => s.tangoPending);
  return (
    <View style={[styles.tabBar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
      {TABS.map((tab) => {
        const focused = tab.key === active;
        const color = focused ? PRIMARY : INACTIVE;
        return (
          <TouchableOpacity
            key={tab.key}
            style={styles.tabItem}
            onPress={() => onSelect(tab.key)}
            accessibilityRole="button"
            accessibilityState={{ selected: focused }}
            accessibilityLabel={tab.label}>
            <View style={styles.tabIconBox}>
              {TabIconFor(tab, color)}
              {tab.key === 'tango' && tangoPending > 0 ? (
                <View style={styles.tabBadge}>
                  <Text style={styles.tabBadgeText}>
                    {tangoPending > 9 ? '9+' : tangoPending}
                  </Text>
                </View>
              ) : null}
            </View>
            <Text style={[styles.tabLabel, { color }]}>{tab.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function Shell() {
  // The active tab lives in a store rather than local state, so a prompt on one
  // screen can send the user to another (see stores/navStore).
  const active = useNavStore((s) => s.tab);
  const setActive = useNavStore((s) => s.setTab);
  // App-wide, so a send confirming while the user is on Receive or Settings
  // still surfaces.
  useSendConfirmations();
  // Coins arriving on the plain bech32 chain: nothing else would notice them,
  // since they are not Silent Payments outputs the scanner finds.
  usePlainWatch();
  // Whose turn it is in a Tango. App-wide rather than on the Tango tab,
  // because the point is to notice one while you are somewhere else.
  useTangoWatch();
  // Device-only transaction labels: read once from the keystore so the wallet
  // list can render them synchronously.
  const loadTxLabels = useTxLabelStore((s) => s.load);
  // Same for the plain chain's own send history, which no server holds.
  const loadPlainHistory = usePlainHistory((s) => s.load);
  // And what each SegWit address was handed out for, so a coin row can say
  // who paid it without waiting on a keystore read.
  const loadSegwitLabels = useSegwitLabels((s) => s.load);
  useEffect(() => {
    loadTxLabels();
    loadPlainHistory();
    loadSegwitLabels();
  }, [loadTxLabels, loadPlainHistory, loadSegwitLabels]);
  const ActiveScreen =
    TABS.find((t) => t.key === active)?.Screen ?? WalletScreen;

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
      <View style={styles.content}>
        <ActiveScreen />
      </View>
      <TabBar active={active} onSelect={setActive} />
    </View>
  );
}

// Held while the keystore is asked whether there is a session. One keystore
// read, so this is a frame or two — but rendering the login screen and then
// yanking it away looks like a bug, and rendering nothing looks like a crash.
function SplashGate() {
  return (
    <View style={styles.splash}>
      <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
      <ActivityIndicator color={PRIMARY} />
    </View>
  );
}

type AuthScreen = 'login' | 'register' | 'forgot';

// Minimal auth-flow navigator (the app has no router; a state switch is enough
// for the three unauthenticated screens).
function AuthNavigator() {
  const [screen, setScreen] = useState<AuthScreen>('login');
  switch (screen) {
    case 'register':
      return <RegisterScreen onBackToLogin={() => setScreen('login')} />;
    case 'forgot':
      return <ForgotPasswordScreen onBackToLogin={() => setScreen('login')} />;
    default:
      return (
        <LoginScreen
          onCreateAccount={() => setScreen('register')}
          onForgotPassword={() => setScreen('forgot')}
        />
      );
  }
}

const App = () => {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const deviceStatus = useAuthStore((s) => s.deviceStatus);
  const inkey = useAuthStore((s) => s.inkey);
  const hydrating = useAuthStore((s) => s.hydrating);

  // Register this device for push while signed in; unregister on sign-out (using
  // the last-known key, since inkey is cleared by logout). No-op when Firebase
  // isn't configured.
  //
  // Wait until the device is TRUSTED before registering: /fcm/token is gated by
  // require_trusted_device, so registering during the pending-confirmation step
  // just 403s (noise) — and because deviceStatus isn't in the deps, the token
  // would otherwise never register once the device is confirmed. Gating on it
  // (and depending on it) both silences the 403 and registers right after the
  // 6-digit confirmation succeeds.
  //
  // Also gated on the "Alerts" pref (Settings → Notifications): with it off,
  // this device holds no server-side token, which is what actually stops the
  // system notification while the app is closed. Waiting for `notifyReady`
  // avoids registering a token on launch only to remove it a tick later when
  // the persisted pref turns out to be off.
  const deviceReady = !DEVICE_TRUST_ENABLED || deviceStatus === 'trusted';
  const alerts = useNotifyStore((s) => s.alerts);
  const notifyReady = useNotifyStore((s) => s.ready);
  const refreshNotify = useNotifyStore((s) => s.refresh);
  const refreshBalancePrivacy = useBalancePrivacy((s) => s.refresh);
  const lastInkey = useRef<string | null>(null);
  useEffect(() => {
    if (!notifyReady) return;
    if (isAuthenticated && inkey && deviceReady) {
      if (alerts) {
        lastInkey.current = inkey;
        registerForPush(inkey);
      } else {
        // Alerts off: make sure the server has no token for this device. Re-run
        // on every session (not just on the switch flip) so a removal that
        // failed while offline is retried instead of leaving pushes coming.
        lastInkey.current = null;
        unregisterForPush(inkey);
      }
    } else if (lastInkey.current) {
      unregisterForPush(lastInkey.current);
      lastInkey.current = null;
    }
  }, [isAuthenticated, inkey, deviceReady, alerts, notifyReady]);

  const lockEnabled = useAppLockStore((s) => s.enabled);
  const lockReady = useAppLockStore((s) => s.ready);
  const autoLockMs = useAppLockStore((s) => s.autoLockMs);
  const locked = useAppLockStore((s) => s.locked);
  const unlocking = useAppLockStore((s) => s.unlocking);
  const refreshLock = useAppLockStore((s) => s.refresh);
  const lock = useAppLockStore((s) => s.lock);
  const setUnlocking = useAppLockStore((s) => s.setUnlocking);

  // Idle timeout: lock after inactivity. It used to sign out, which now would
  // additionally erase the stored session — see hooks/useIdleLock.
  useIdleLock();

  // Load the app-lock, notification and balance-privacy preferences once at
  // startup.
  useEffect(() => {
    refreshLock();
    refreshNotify();
    refreshBalancePrivacy();
  }, [refreshLock, refreshNotify, refreshBalancePrivacy]);

  // An email-verification link that opened the app rather than a browser. Sits
  // at this level because it must be caught whether the app was launched by the
  // link or was already running on the register screen.
  useVerifyLink();

  // Sign in from the session kept on this device, if there is one. This is what
  // makes the login screen a first-run step rather than a launch ritual.
  const restore = useAuthStore((s) => s.restore);
  useEffect(() => {
    restore();
  }, [restore]);

  // Prompt for notification permission at first launch, so the user can allow
  // payment alerts before (and independently of) device-trust + FCM token
  // registration. The token itself is registered later, once the device is
  // trusted (effect above); by then this grant is already in place, so
  // registerForPush won't show a second dialog.
  //
  // Skipped when alerts are switched off, so a user who turned them off isn't
  // asked again on the next launch for a permission the app won't use.
  useEffect(() => {
    if (notifyReady && alerts) ensureNotificationPermission();
  }, [notifyReady, alerts]);

  // Locking on leaving the foreground, but ONLY for the "Immediately" setting.
  //
  // This used to be unconditional, so glancing at another app — checking an
  // address someone sent you, copying an amount — cost a fingerprint every time
  // you came back. That is the behaviour people turn locks off over. Every
  // other setting hands the job to the idle timer, which counts time in the
  // background as unused (no touches happen there) and locks once the chosen
  // delay has passed. See hooks/useIdleLock.
  //
  // Still 'background' and not the transient 'inactive' the OS emits during the
  // unlock prompt itself, which would re-lock mid-unlock.
  useEffect(() => {
    if (autoLockMs !== 0) return;
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background' && lockEnabled && !unlocking) lock();
    });
    return () => sub.remove();
  }, [autoLockMs, lockEnabled, unlocking, lock]);

  // Back in the foreground means no OS prompt is in front of us any more,
  // whatever became of the promise that was waiting on it. Clearing the flag
  // here — not only on the lock screen, which is where it used to live — is
  // what stops a prompt that died with the activity from leaving `unlocking`
  // stuck true and the rule above permanently disarmed.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') setUnlocking(false);
    });
    return () => sub.remove();
  }, [setUnlocking]);

  // When device-trust is on, an authenticated-but-unconfirmed device must clear
  // the confirmation flow before reaching the wallet.
  const needsDeviceConfirm =
    DEVICE_TRUST_ENABLED && isAuthenticated && deviceStatus !== 'trusted';

  const showLock = isAuthenticated && lockEnabled && locked;

  // A stored session with nothing guarding it is the one state this must never
  // render the wallet in: the password is no longer asked for, so without a PIN
  // or biometric anyone holding the phone is already inside. Waiting for
  // lockReady keeps a launch from flashing this screen before the preference
  // has been read back.
  const needsLockSetup = isAuthenticated && lockReady && !lockEnabled;

  return (
    <SafeAreaProvider>
      {/* Passive activity tracker: every touch refreshes the idle timer without
          intercepting the gesture (capture handler returns false). */}
      <View
        style={styles.appRoot}
        onStartShouldSetResponderCapture={() => {
          touchActivity();
          return false;
        }}>
        {/* Order matters. Hydrating first, so a stored session never flashes
            the login screen on the way in. Lock setup before device
            confirmation: an unguarded session is this app's problem to fix
            before it starts talking to the server about which device it is. */}
        {/* `!lockReady` counts as still starting up, not just `hydrating`.
            The session restore and the lock-preference read are separate
            async reads, and if the session lands first there is a frame or two
            where a locked wallet has enabled=false and ready=false — long
            enough to render Shell and kick off its data loads before the lock
            screen replaces it. Holding the splash until both are in closes
            that window. */}
        {hydrating || (isAuthenticated && !lockReady) ? (
          <SplashGate />
        ) : !isAuthenticated ? (
          <AuthNavigator />
        ) : showLock ? (
          <LockScreen />
        ) : needsLockSetup ? (
          <LockSetupScreen />
        ) : needsDeviceConfirm ? (
          <DeviceConfirmScreen />
        ) : (
          <Shell />
        )}
        {/* Foreground push messages overlay everything except the lock screen
            (no point surfacing wallet activity while locked). */}
        {isAuthenticated && !showLock ? <PushBanner /> : null}
      </View>
    </SafeAreaProvider>
  );
};

const styles = StyleSheet.create({
  appRoot: {
    flex: 1,
  },
  splash: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  root: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    flex: 1,
  },
  tabBar: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
    paddingTop: 8,
  },
  tabItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabIconBox: {
    height: 26,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
  },
  // Sits over the icon's top-right. The box is only 26pt tall, so the badge
  // overhangs it rather than fitting inside — overflow stays visible, which it
  // is by default on both platforms for a View.
  tabBadge: {
    position: 'absolute',
    top: -2,
    right: -12,
    minWidth: 16,
    height: 16,
    paddingHorizontal: 4,
    borderRadius: 8,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabBadgeText: {
    color: colors.onPrimary,
    fontSize: 10,
    fontWeight: '700',
    lineHeight: 16,
  },
  tabIcon: {
    fontSize: 20,
  },
  // The one piece of text on every screen, so it sets the app's font before
  // anything else does. fontFamily carries the weight — see theme.ts on why
  // fontWeight must not appear beside a bundled family.
  tabLabel: {
    fontFamily: fonts.sansSemi,
    fontSize: 11,
    letterSpacing: 0.4,
  },
});

export default App;
