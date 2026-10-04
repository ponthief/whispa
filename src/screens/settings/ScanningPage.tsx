import React, { useCallback, useEffect, useState } from 'react';
import { Alert } from 'react-native';
import * as api from '@services/api';
import * as catchUpPref from '@services/catchUpPref';
import { getWalletKeys } from '@services/secureKeys';
import { useAuthStore } from '@stores/authStore';
import { useSilntWallet } from '../../hooks/useSilntWallet';
import { Block, Chips, Group, Note, Page, SwitchRow } from './ui';



// Finding payments: whether the server helps, and how much this phone will do
// without asking.
export default function ScanningPage({ onBack }: { onBack: () => void }) {
  const inkey = useAuthStore((s) => s.inkey);
  const { wallet } = useSilntWallet();
  const walletId = wallet?.id ?? null;

  const [bgEnabled, setBgEnabled] = useState(false);
  const [bgBusy, setBgBusy] = useState(false);
  const [bgMsg, setBgMsg] = useState<string | null>(null);

  const [catchUpBlocks, setCatchUpBlocks] = useState<number>(
    catchUpPref.FOLLOW_SERVER,
  );

  useEffect(() => {
    catchUpPref.getCatchUpBlocks().then(setCatchUpBlocks);
  }, []);

  useEffect(() => {
    if (!inkey || !walletId) return;
    api
      .getBackgroundScan(inkey, walletId)
      .then(setBgEnabled)
      .catch(() => {
        /* leave the switch off if the status can't be read */
      });
  }, [inkey, walletId]);

  // The server's own threshold was fetched here, to describe what "following
  // the server" meant in the footer below. The footer went; the request went
  // with it rather than being left to run on every visit and feed nothing.
  // The decision itself never lived here — catchUpPref reads the threshold
  // again at scan time.

  const applyBackgroundScan = useCallback(
    async (enable: boolean) => {
      if (!inkey || !walletId) return;
      setBgBusy(true);
      setBgMsg(null);
      try {
        if (enable) {
          const keys = await getWalletKeys(walletId);
          if (!keys?.scanSecret) {
            setBgMsg('This wallet’s keys are not on this phone. Recover them first.');
            return;
          }
          await api.enableBackgroundScan(inkey, walletId, keys.scanSecret);
          setBgEnabled(true);
        } else {
          await api.disableBackgroundScan(inkey, walletId);
          setBgEnabled(false);
        }
      } catch (e: any) {
        setBgMsg(e?.message || 'Could not update background scanning.');
      } finally {
        setBgBusy(false);
      }
    },
    [inkey, walletId],
  );

  const onToggleBackgroundScan = useCallback(
    (value: boolean) => {
      if (!value) {
        applyBackgroundScan(false);
        return;
      }
      // Enabling uploads the scan key — get explicit, informed consent.
      Alert.alert(
        'Turn on background scanning?',
        "This uploads this wallet's scan key to the server so it can find your " +
          'incoming payments while the app is closed. The server will then be ' +
          'able to see your payment history — but it can never spend your funds ' +
          '(your spend key never leaves this phone). You can turn it off anytime.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Turn on', onPress: () => applyBackgroundScan(true) },
        ],
      );
    },
    [applyBackgroundScan],
  );

  const onPickCatchUp = useCallback(
    async (blocks: number) => {
      // Tapping the active choice clears the override and hands the decision
      // back to the server, which is otherwise unreachable once one is set.
      const next = blocks === catchUpBlocks ? catchUpPref.FOLLOW_SERVER : blocks;
      setCatchUpBlocks(next);
      if (next === catchUpPref.FOLLOW_SERVER) {
        await catchUpPref.clearCatchUpBlocks();
      } else {
        await catchUpPref.setCatchUpBlocks(next);
      }
    },
    [catchUpBlocks],
  );

  return (
    <Page
      title="Scanning"
      subtitle="Searching the chain for your Silent Payments."
      onBack={onBack}>
      <Group title="On the server">
        <SwitchRow
          first
          title="Background scanning"
          help="Scanning takes place server side using your scan key — detection only, it can never spend your funds."
          value={bgEnabled}
          onValueChange={onToggleBackgroundScan}
          busy={bgBusy}
          disabled={!walletId}
        />
        {bgMsg ? (
          <Block>
            <Note kind="error">{bgMsg}</Note>
          </Block>
        ) : null}
      </Group>

      {/* The catch-up limit. It used to be a single admin number applied to
          every client at once — chosen for browsers, inherited by phones on
          mobile data. This phone can now say how much it will do quietly;
          leaving it alone follows the server as before. */}
      <Group title="On this phone">
        <Block
          first
          title="Scan automatically"
          help="Leave the wallet unscanned for up to this much before asking.">
          <Chips
            options={catchUpPref.CATCH_UP_CHOICES.map((o) => ({
              key: o.blocks,
              label: o.label,
            }))}
            selected={catchUpBlocks}
            onSelect={onPickCatchUp}
          />
        </Block>
      </Group>
    </Page>
  );
}
