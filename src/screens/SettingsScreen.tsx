import React, { useCallback, useEffect, useState } from 'react';
import { BackHandler } from 'react-native';
import { useAppLockStore } from '@stores/appLockStore';
import { useAuthStore } from '@stores/authStore';
import { useNotifyStore } from '@stores/notifyStore';
import AboutPage from './settings/AboutPage';
import AccountPage from './settings/AccountPage';
import NotificationsPage from './settings/NotificationsPage';
import ScanningPage from './settings/ScanningPage';
import SecurityPage from './settings/SecurityPage';
import WalletPage from './settings/WalletPage';
import { Group, NavRow, Page } from './settings/ui';

// Settings, as a menu of six pages rather than one scroll of eight sections.
//
// It was one page, and the length was the problem: the recovery phrase was
// buried under "Scanning", the dust threshold came second because it happened to
// be written second, and finding anything meant reading everything. Each page
// here is short enough to take in without scrolling, and the menu says what is
// on it — with the current setting on the right where the app already knows it,
// so checking whether the lock is on costs no taps at all.
//
// The app has no router (see stores/navStore), so this is a state switch, with
// Android's back button wired to it. Rendering the menu underneath and the page
// on top would need a stack; one at a time is what the tab bar expects.

type PageKey =
  | 'account'
  | 'security'
  | 'notifications'
  | 'scanning'
  | 'wallet'
  | 'about';

export default function SettingsScreen() {
  const [page, setPage] = useState<PageKey | null>(null);

  const username = useAuthStore((s) => s.username);
  const pinSet = useAppLockStore((s) => s.pinSet);
  const bioEnabled = useAppLockStore((s) => s.bioEnabled);
  const lockEnabled = useAppLockStore((s) => s.enabled);
  const alerts = useNotifyStore((s) => s.alerts);

  const back = useCallback(() => setPage(null), []);

  // Hardware back closes the open page instead of leaving the app. Returning
  // false on the menu hands the press back to the OS, so Settings is still an
  // exit point the way every other tab is.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (page === null) return false;
      setPage(null);
      return true;
    });
    return () => sub.remove();
  }, [page]);

  if (page === 'account') return <AccountPage onBack={back} />;
  if (page === 'security') return <SecurityPage onBack={back} />;
  if (page === 'notifications') return <NotificationsPage onBack={back} />;
  if (page === 'scanning') return <ScanningPage onBack={back} />;
  if (page === 'wallet') return <WalletPage onBack={back} />;
  if (page === 'about') return <AboutPage onBack={back} />;

  // What the lock is, in the two words the menu has room for. "Off" is the one
  // worth seeing from here without opening anything.
  const lockSummary = !lockEnabled
    ? 'Off'
    : pinSet
    ? 'PIN'
    : bioEnabled
    ? 'Biometric'
    : 'On';
  // NAMES ONLY. Every row carried a line listing what was inside it —

  // "Username, email, invites, signing out" under Account, and so on —

  // which is a table of contents for a page one tap away. The `value` is

  // kept where there is one: "On"/"Off" beside Notifications answers a

  // question the name cannot.

  return (
    <Page title="Settings" subtitle={username ? `Signed in as ${username}` : undefined}>
      <Group title="You">
        <NavRow
          first
          title="Account"
          value={username || undefined}
          onPress={() => setPage('account')}
        />
      </Group>

      <Group title="This phone">
        <NavRow
          first
          title="Security"
          value={lockSummary}
          danger={!lockEnabled}
          onPress={() => setPage('security')}
        />
        <NavRow
          title="Notifications"
          value={alerts ? 'On' : 'Off'}
          onPress={() => setPage('notifications')}
        />
      </Group>

      <Group title="Wallet">
        <NavRow
          first
          title="Scanning"
          onPress={() => setPage('scanning')}
        />
        <NavRow
          title="Wallet"
          onPress={() => setPage('wallet')}
        />
      </Group>

      <Group title="App">
        <NavRow
          first
          title="About"
          onPress={() => setPage('about')}
        />
      </Group>
    </Page>
  );
}
