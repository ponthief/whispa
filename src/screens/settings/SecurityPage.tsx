import React, { useCallback, useEffect, useState } from 'react';
import { Alert } from 'react-native';
import { useAppLockStore } from '@stores/appLockStore';
import * as appLock from '@services/appLock';
import * as appPin from '@services/appPin';
import {
  STEALTH_ALIASES,
  type StealthAlias,
  currentAlias,
  isDisguised,
  setAlias as setStealthAlias,
  stealthAvailable,
} from '@services/stealth';
import { useNotifyStore } from '@stores/notifyStore';
import { hasSeed } from '@services/seedVault';
import * as api from '@services/api';
import { useAuthStore } from '@stores/authStore';
import Config from 'react-native-config';
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
// needs a PIN to hide behind, and the seed phrase is only revealable because
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

  // EVERY WALLET ON THIS NETWORK, not just the one `useSilntWallet` picks.
  //
  // Reported 2026-11-08: *"I am still unable to see the Seed phrase reveal in
  // either web or mobile — in mobile it says: not stored on this phone, but
  // it's restored from a file wallet!!"*
  //
  // `pickSilntWallet` returns the FIRST wallet matching this build's network,
  // so with more than one the section answered about a wallet the reader was
  // not asking about, under a heading that named none of them. The rest of the
  // phone app is single-wallet by design; this screen is per-wallet
  // bookkeeping, so it lists them and each row says its own state.
  const inkey = useAuthStore((st) => st.inkey);
  const [wallets, setWallets] = useState<api.SilntWallet[]>([]);
  const [seedStored, setSeedStored] = useState<Record<string, boolean>>({});
  const [seedOpen, setSeedOpen] = useState<string | null>(null);

  useEffect(() => {
    appLock.biometryType().then(setBiometry);
  }, []);

  useEffect(() => {
    appPin.hasDuressPin().then(setHasDuress);
  }, [pinSet]);

  // Re-read on every mount, because a restore that happened since lands here
  // as a changed answer and nothing else would notice.
  const loadSeedState = useCallback(async () => {
    if (!inkey) return;
    let list: api.SilntWallet[] = [];
    try {
      list = (await api.getSilntWallets(inkey)) || [];
    } catch {
      return; // leave the section out rather than claim a wallet has no words
    }
    const net = Config.NETWORK_LOCK;
    const mine = net ? list.filter((w) => w.network === net) : list;
    setWallets(mine);
    const marks: Record<string, boolean> = {};
    await Promise.all(
      mine.map(async (w) => {
        marks[w.id] = await hasSeed(w.id).catch(() => false);
      }),
    );
    setSeedStored(marks);
  }, [inkey]);

  useEffect(() => {
    loadSeedState();
  }, [loadSeedState]);

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

  // ── Stealth mode ──────────────────────────────────────────────────────────
  // Read from the PackageManager on mount, not from a store: the enabled state
  // is what the launcher obeys and it outlives this app's own data, so a cached
  // copy can disagree with the icon actually on the home screen.
  const [alias, setAliasState] = useState<StealthAlias>('default');
  const [aliasMsg, setAliasMsg] = useState<string | null>(null);
  const setAlerts = useNotifyStore((s) => s.setAlerts);

  useEffect(() => {
    let cancelled = false;
    currentAlias().then((a) => {
      if (!cancelled) setAliasState(a);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const onPickAlias = useCallback(
    async (next: StealthAlias) => {
      if (next === alias) return;
      setAliasMsg(null);
      try {
        await setStealthAlias(next);
        setAliasState(next);
        // ALERTS OFF WITH THE DISGUISE ON. A notification's header carries the
        // application label, which an activity-alias cannot touch — so a
        // payment arriving under a calculator icon would still say WhiSPa on
        // the lock screen, which is the one place it most matters.
        //
        // Turning them back on is left to the user rather than restored
        // automatically: somebody who turned the disguise off has not
        // necessarily decided they want their lock screen naming this app
        // again, and Notifications is one tap away.
        if (isDisguised(next)) {
          await setAlerts(false);
        }
      } catch (e: any) {
        // The icon did not change, so neither does what is on screen. Saying
        // so beats a chip that looks selected over a home screen that
        // disagrees with it.
        setAliasMsg(
          e?.message === 'stealth-unavailable'
            ? 'This build cannot change the launcher icon.'
            : 'Could not change the icon. Your home screen is unchanged.',
        );
      }
    },
    [alias, setAlerts],
  );

  const onPinDone = useCallback(() => {
    setPinModal(null);
    appPin.hasPin().then(setPinSet);
    appPin.hasDuressPin().then(setHasDuress);
  }, [setPinSet]);

  return (
    <Page title="Security" onBack={onBack}>
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
          a choice about nothing, so it is not offered.

          "Auto-lock" is the name the rest of the code has always used for this
          (services/appLock.ts, hooks/useIdleLock.ts) and the chips read as its
          value: Auto-lock · 1 minute. It was titled "Ask again after", which
          is a sentence fragment the chips have to finish.

          NO FOOTER AT ALL. Two paragraphs lived under these chips. One
          explained that background time counts towards the timer, which is a
          timer nobody was wondering about; the other said "Immediately" means
          a glance at another app costs an unlock, which the word immediately
          already says. Both are gone — the chips are the control and they are
          legible without a note under them. */}
      {lockAnyEnabled ? (
        <Group title="Auto-lock">
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

      {/* HOME-SCREEN DISGUISE, and the copy is careful about what it is not.
          Stealth mode changes which launcher alias is enabled, so the icon and
          name on the home screen become a calculator or a notepad. The app
          behind it is unchanged — a tap opens WhiSPa, into the lock above if
          one is set. It hides the wallet from a glance, not from a search.

          Only rendered when the native module is there: on iOS, and on any
          build predating it, offering a switch that stores a preference
          nothing can honour is the failure NotificationsPage already names. */}
      {stealthAvailable() ? (
        <Group title="Home screen">
          <Block first>
            <Chips
              options={STEALTH_ALIASES}
              selected={alias}
              onSelect={onPickAlias}
            />
          </Block>
          {/* ONE LINE (2026-11-08, on the user's instruction: "under home
              screen drop the complete text, just say: Show app icon as one of
              the above"). It was a Help line that restated the chips and a
              four-sentence note on what a disguise does NOT hide — the app
              name under Settings → Apps, the storage and battery lists, and
              that a tap still opens the wallet. Every clause true, and all of
              it in front of a control whose three labelled chips are already
              the whole decision.

              What is NOT dropped is the alerts note below, because that is not
              an explanation: turning a disguise on turns notifications off,
              and a feature that silently stops payment alerts has to say so
              where it is switched on. */}
          <Block>
            <Help>Show the app icon as one of the above.</Help>
          </Block>
          {isDisguised(alias) ? (
            <Block>
              <Note kind="info">
                Alerts are off while a disguise is on. A notification shows the
                app it came from, and that name is one no icon can change.
              </Note>
            </Block>
          ) : null}
          {aliasMsg ? (
            <Block>
              <Note kind="error">{aliasMsg}</Note>
            </Block>
          ) : null}
        </Group>
      ) : null}

      {pinSet ? (
        <Group title="Under coercion">
          <SwitchRow
            first
            title="Duress PIN"
            help="A second PIN that, entered at the lock screen, wipes this phone's wallet keys, turns off server-side scanning, and signs you out. Nothing can be spent from here afterwards; your coins stay safe on-chain and come back from your seed phrase. Use it if you are ever forced to unlock."
            value={hasDuress}
            onValueChange={onToggleDuress}
          />
        </Group>
      ) : null}

      {/* Only offered when the phrase is actually on this phone. A dead button
          for older wallets would suggest a second copy exists somewhere, which
          is the belief that loses coins. */}
      {/* AND IT SAYS WHAT IS TRUE OF THIS DEVICE, nothing more (2026-11-08,
          reported against a wallet restored from a web backup file: "shows
          that seed phrase cannot be shown in Security. That is not right…
          if store just spend/scan keys and not seed phrase, just say that
          seed phrase was not entered on the phone").

          The old line explained WHERE the words went — shown once at creation,
          not kept afterwards — and that story is simply false for this wallet.
          A web backup carries the derived keys and never a phrase, because
          keyvault.js has never held one; the restore worked exactly as it
          should and there were no words anywhere in it. Telling somebody their
          phrase "is not kept here" invites them to go looking for a copy that
          was never made. What is true on every path is the one fact this
          screen can actually see: the phrase was never typed in on this
          device, and the keys that spend are. */}
      {/* ONE ROW PER WALLET, each saying its own state, and the wallet NAMED.
          With a single wallet that reads exactly as before; with two it stops
          answering about one while the reader is asking about the other. */}
      {wallets.length ? (
        <Group title="Seed phrase">
          {wallets.map((w, i) =>
            seedStored[w.id] ? (
              <NavRow
                key={w.id}
                first={i === 0}
                title={`Show seed phrase${wallets.length > 1 ? ` — ${w.title}` : ''}`}
                help="The twelve words that can restore this wallet anywhere."
                onPress={() => setSeedOpen(w.id)}
              />
            ) : (
              <Block key={w.id} first={i === 0}>
                <Note kind="info">
                  {wallets.length > 1 ? `${w.title}: not` : 'Not'} entered on
                  this phone, so there is nothing to show. This wallet's scan
                  and spend keys are stored here, so it still scans and sends.
                </Note>
                {/* WHAT WOULD BRING THE WORDS, which the flat denial above
                    left somebody to guess at — and guessing is what the report
                    was: *"it says not stored on this phone, but it's restored
                    from a file wallet!!"*. Both halves are true and neither is
                    obvious: a file saved from the WEB app carries the derived
                    keys and never the words, because the browser has never
                    held them; a file saved from THIS app carries them. */}
                <Help>
                  Restoring a backup brings the words back when the file has
                  them. Both apps put them in now; a file saved before they
                  did, or made for a wallet whose words were never kept, has
                  none to give.
                </Help>
              </Block>
            ),
          )}
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

      {seedOpen ? (
        <SeedRevealModal
          visible
          walletId={seedOpen}
          onClose={() => setSeedOpen(null)}
          onForgotten={() => {
            setSeedStored((prev) => ({ ...prev, [seedOpen]: false }));
            setSeedOpen(null);
          }}
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
