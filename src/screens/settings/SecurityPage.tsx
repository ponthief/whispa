import React, { useCallback, useEffect, useState } from 'react';
import { Alert } from 'react-native';
import { useAppLockStore } from '@stores/appLockStore';
import * as appLock from '@services/appLock';
import * as appPin from '@services/appPin';
import { hasSeed } from '@services/seedVault';
import { useSilntWallet } from '../../hooks/useSilntWallet';
import DevicesModal from '../../components/DevicesModal';
import PinSetupModal from '../../components/PinSetupModal';
import SeedRevealModal from '../../components/SeedRevealModal';
import { DEVICE_TRUST_ENABLED } from '@/theme';
import {
  Block,
  Chips,
  Group,
  Help,
  NavRow,
  Note,
  Page,
  SwitchRow,
} from './ui';

// Everything that decides who can get into this app and what they can see.
//
// Gathered on one page because these settings only make sense against each
// other: the auto-lock delay is meaningless with nothing locking, the duress PIN
// needs a PIN to hide behind, and the recovery phrase is only revealable because
// one of the two guards it. On the old single-page Settings the phrase sat under
// "Scanning", four screens of scrolling from the lock it depends on.
export default function SecurityPage({ onBack }: { onBack: () => void }) {
  const bioEnabled = useAppLockStore((s) => s.bioEnabled);
  const setBioEnabled = useAppLockStore((s) => s.setBioEnabled);
  const pinSet = useAppLockStore((s) => s.pinSet);
  const setPinSet = useAppLockStore((s) => s.setPinSet);
  const lockAnyEnabled = useAppLockStore((s) => s.enabled);
  const autoLockMs = useAppLockStore((s) => s.autoLockMs);
  const setAutoLockMs = useAppLockStore((s) => s.setAutoLockMs);

  const [biometry, setBiometry] = useState<string | null>(null);
  const [lockBusy, setLockBusy] = useState(false);
  const [lockMsg, setLockMsg] = useState<string | null>(null);
  const [hasDuress, setHasDuress] = useState(false);
  const [pinModal, setPinModal] = useState<null | 'normal' | 'duress'>(null);
  const [devicesOpen, setDevicesOpen] = useState(false);

  const { wallet } = useSilntWallet();
  const [seedStored, setSeedStored] = useState(false);
  const [seedOpen, setSeedOpen] = useState(false);

  useEffect(() => {
    appLock.biometryType().then(setBiometry);
  }, []);

  useEffect(() => {
    appPin.hasDuressPin().then(setHasDuress);
  }, [pinSet]);

  useEffect(() => {
    if (!wallet) return;
    hasSeed(wallet.id).then(setSeedStored);
  }, [wallet]);

  const onToggleLock = useCallback(
    async (val: boolean) => {
      setLockBusy(true);
      setLockMsg(null);
      try {
        if (val) {
          const res = await appLock.enable();
          setBioEnabled(res.ok);
          if (!res.ok) {
            setLockMsg(
              res.reason === 'not-enforceable'
                ? 'Your phone did not tie the lock to your fingerprint, so it ' +
                  'would have opened on the first tap and has been left off. ' +
                  'This happens when no fingerprint or face is enrolled yet, ' +
                  'or the sensor is locked out after failed attempts — enrol ' +
                  'one or wait a minute, then try again.'
                : res.reason === 'cancelled'
                ? 'Not turned on: the confirmation was cancelled.'
                : 'Could not turn this on. Set up a fingerprint, face, or screen PIN on your phone first.',
            );
          }
        } else {
          // The lock is what guards the stored session now that the password is
          // not asked for on launch, so the LAST method cannot be removed. The
          // app would otherwise bounce straight to the setup screen, which
          // reads as a bug rather than a rule.
          if (!pinSet) {
            setLockMsg(
              'This is the only way to unlock the app. Set an app PIN first, or sign out to stop keeping your sign-in on this phone.',
            );
            return;
          }
          await appLock.disable();
          setBioEnabled(false);
        }
      } finally {
        setLockBusy(false);
      }
    },
    [setBioEnabled, pinSet],
  );

  const onTogglePin = useCallback(
    (v: boolean) => {
      if (v) {
        setPinModal('normal');
        return;
      }
      if (!bioEnabled) {
        Alert.alert(
          'Keep your PIN',
          'This is the only way to unlock the app. Turn on biometric unlock first, or sign out to stop keeping your sign-in on this phone.',
        );
        return;
      }
      Alert.alert(
        'Turn off the app PIN?',
        'This removes your PIN and any duress PIN, and returns to biometric unlock.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Turn off',
            style: 'destructive',
            onPress: async () => {
              await appPin.clearPins();
              setPinSet(false);
              setHasDuress(false);
            },
          },
        ],
      );
    },
    [setPinSet, bioEnabled],
  );

  const onToggleDuress = useCallback((v: boolean) => {
    if (v) {
      setPinModal('duress');
      return;
    }
    appPin.setDuressPin(null).then(() => setHasDuress(false));
  }, []);

  const onPinDone = useCallback(() => {
    setPinModal(null);
    appPin.hasPin().then(setPinSet);
    appPin.hasDuressPin().then(setHasDuress);
  }, [setPinSet]);

  return (
    <Page
      title="Security"
      subtitle="What it takes to open this app, and what it will show you."
      onBack={onBack}>
      <Group title="Unlocking">
        <SwitchRow
          first
          title="Biometric unlock"
          help={
            biometry
              ? `Ask for ${biometry} or your phone's PIN when reopening the app.`
              : "Ask for your phone's PIN or biometrics when reopening the app."
          }
          value={bioEnabled}
          onValueChange={onToggleLock}
          busy={lockBusy}
        />
        <SwitchRow
          title="App PIN"
          help="Unlock with a 6-digit PIN instead. When on, it replaces biometrics and makes a duress PIN available."
          value={pinSet}
          onValueChange={onTogglePin}
        />
        {pinSet ? (
          <NavRow title="Change PIN" value="Change" onPress={() => setPinModal('normal')} />
        ) : null}
        {lockMsg ? (
          <Block>
            <Note kind="error">{lockMsg}</Note>
          </Block>
        ) : null}
      </Group>

      {/* "Hide balances" was a switch here AND a tap on the balance itself,
          which is where anybody who wants it reaches for it — the row's own
          help text had to explain the gesture that replaces it. One control,
          on the thing it controls. The store and the gesture are untouched;
          only the duplicate went. */}

      {/* Only meaningful once something locks — with no lock configured this is
          a choice about nothing, so it is not offered. */}
      {lockAnyEnabled ? (
        <Group
          title="Ask again after"
          footer={
            autoLockMs === 0
              ? 'Switching away to check something means unlocking on the way back.'
              : 'Time spent in another app counts towards this, so a quick glance elsewhere and back does not ask again.'
          }>
          <Block first>
            <Chips
              options={appLock.AUTO_LOCK_CHOICES.map((o) => ({
                key: o.ms,
                label: o.label.replace('After ', ''),
              }))}
              selected={autoLockMs}
              onSelect={setAutoLockMs}
            />
          </Block>
        </Group>
      ) : null}

      {pinSet ? (
        <Group title="Under coercion">
          <SwitchRow
            first
            title="Duress PIN"
            help="A second PIN that, entered at the lock screen, wipes this phone's wallet keys, turns off server-side scanning, and signs you out. Nothing can be spent from here afterwards; your coins stay safe on-chain and come back from your recovery phrase. Use it if you are ever forced to unlock."
            value={hasDuress}
            onValueChange={onToggleDuress}
          />
        </Group>
      ) : null}

      {/* Only offered when the phrase is actually on this phone. A dead button
          for older wallets would suggest a second copy exists somewhere, which
          is the belief that loses coins. */}
      {wallet && !seedStored ? (
        <Group title="Recovery phrase">
          <Block first>
            <Note kind="info">
              Not on this phone. It is shown once when a wallet is created, and
              is not kept here afterwards — so there is nothing to reveal. If
              you still have the words, they restore this wallet anywhere.
            </Note>
          </Block>
        </Group>
      ) : null}

      {/* The footer here said it asks for your PIN first and that a passphrase
          is not included. The first half the reveal demonstrates by doing it;
          the second half belongs ON the reveal, where somebody is looking at
          twelve words deciding whether that is their whole backup —
          SeedRevealModal says it there, beside the words. */}
      {seedStored && wallet ? (
        <Group title="Recovery phrase">
          <NavRow
            first
            title="Show recovery phrase"
            help="The twelve words that can restore this wallet anywhere."
            onPress={() => setSeedOpen(true)}
          />
        </Group>
      ) : null}

      {DEVICE_TRUST_ENABLED ? (
        <Group
          title="Devices"
          footer="Each device is confirmed by email before it can use your wallet.">
          <NavRow
            first
            title="Trusted devices"
            value="Manage"
            onPress={() => setDevicesOpen(true)}
          />
        </Group>
      ) : null}

      {!lockAnyEnabled ? (
        <Help>
          With no lock set, anyone holding this phone is already inside your
          wallet — the password is not asked for again once you have signed in.
        </Help>
      ) : null}

      {DEVICE_TRUST_ENABLED ? (
        <DevicesModal visible={devicesOpen} onClose={() => setDevicesOpen(false)} />
      ) : null}

      {wallet ? (
        <SeedRevealModal
          visible={seedOpen}
          walletId={wallet.id}
          onClose={() => setSeedOpen(false)}
          onForgotten={() => setSeedStored(false)}
        />
      ) : null}

      <PinSetupModal
        visible={pinModal !== null}
        mode={pinModal === 'duress' ? 'duress' : 'normal'}
        onClose={() => setPinModal(null)}
        onDone={onPinDone}
      />
    </Page>
  );
}
