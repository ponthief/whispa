import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, View } from 'react-native';
import * as api from '@services/api';
import { hasWalletKeys, removeWalletKeys } from '@services/secureKeys';
import { useAuthStore } from '@stores/authStore';
import { resetCatchUp } from '../../hooks/useCatchUpScan';
import { useSilntWallet } from '../../hooks/useSilntWallet';
import { colors, space } from '@/theme';
import { Block, Button, Field, Group, InfoRow, Note, Page } from './ui';

// The wallet itself: what it is, how it treats small coins, and how to let go
// of it. The dust threshold lives here rather than under a "coin control"
// heading of its own — it is one number, and a page for one number is a page
// nobody finds.
export default function WalletPage({ onBack }: { onBack: () => void }) {
  const inkey = useAuthStore((s) => s.inkey);
  const { wallet, reload } = useSilntWallet();

  const [prefs, setPrefs] = useState<api.UserPrefs | null>(null);
  const [dustDraft, setDustDraft] = useState('');
  const [loadingPrefs, setLoadingPrefs] = useState(true);
  const [savingDust, setSavingDust] = useState(false);
  const [dustError, setDustError] = useState<string | null>(null);
  const [dustSaved, setDustSaved] = useState(false);

  const [removing, setRemoving] = useState(false);
  const [removeMsg, setRemoveMsg] = useState<string | null>(null);

  const loadPrefs = useCallback(async () => {
    if (!inkey) return;
    try {
      const p = await api.getUserPrefs(inkey);
      setPrefs(p);
      setDustDraft(
        p.dust_threshold_sats != null ? String(p.dust_threshold_sats) : '',
      );
    } catch {
      /* leave unset */
    } finally {
      setLoadingPrefs(false);
    }
  }, [inkey]);

  useEffect(() => {
    loadPrefs();
  }, [loadPrefs]);

  const currentOverride =
    prefs?.dust_threshold_sats != null ? String(prefs.dust_threshold_sats) : '';
  const dirty = dustDraft.trim() !== currentOverride;

  const saveDust = useCallback(async () => {
    if (!inkey) return;
    setSavingDust(true);
    setDustError(null);
    setDustSaved(false);
    try {
      const n = Number(dustDraft);
      // Empty / 0 clears the override → back to the admin default.
      const value =
        dustDraft.trim() === '' || !Number.isFinite(n) || n <= 0 ? null : n;
      if (value != null && value > 10000) {
        setDustError('Maximum is 10,000 sats.');
        setSavingDust(false);
        return;
      }
      const p = await api.updateUserPrefs(inkey, value);
      setPrefs(p);
      setDustDraft(
        p.dust_threshold_sats != null ? String(p.dust_threshold_sats) : '',
      );
      setDustSaved(true);
    } catch (e: any) {
      setDustError(e?.message || 'Could not save. Please try again.');
    } finally {
      setSavingDust(false);
    }
  }, [inkey, dustDraft]);

  const doRemoveWallet = useCallback(async () => {
    if (!inkey || !wallet) return;
    setRemoving(true);
    setRemoveMsg(null);
    try {
      // Best-effort: pull this wallet's scan key off the server first so nothing
      // lingers there if the delete itself is retried. Deleting the wallet
      // removes its record, coins, labeled addresses, and BitMail DNS too.
      try {
        await api.disableBackgroundScan(inkey, wallet.id);
      } catch {
        /* not enabled / already gone — ignore */
      }
      await api.deleteSilntWallet(inkey, wallet.id);
      // Wipe the local keys and forget the catch-up evaluation for this id.
      await removeWalletKeys(wallet.id);
      resetCatchUp(wallet.id);
      setRemoveMsg('Wallet removed. Create or import one on the Wallet tab.');
      reload();
    } catch (e: any) {
      setRemoveMsg(
        e?.message || 'Could not remove the wallet. Please try again.',
      );
    } finally {
      setRemoving(false);
    }
  }, [inkey, wallet, reload]);

  const onRemoveWallet = useCallback(async () => {
    if (!inkey || !wallet) return;
    // Only allow removal from a device that holds the wallet's keys — proof the
    // user can recover it from their seed afterwards (mirrors the web gate).
    if (!(await hasWalletKeys(wallet.id))) {
      Alert.alert(
        'Keys not on this phone',
        "This wallet's keys aren't stored here, so it can't be removed from " +
          'this phone. Recover the wallet from its recovery phrase first, then ' +
          'remove it.',
      );
      return;
    }
    Alert.alert(
      'Remove this wallet?',
      `This removes "${wallet.title || 'this wallet'}" from the server ` +
        '(its address and the record of its coins) and erases its keys from ' +
        'this phone. Your bitcoin stays safe on-chain — only the wallet data ' +
        'is deleted. You can restore the wallet, and rescan its coins, from ' +
        'your recovery phrase (and passphrase, if you set one). This can’t be ' +
        'undone here.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove wallet', style: 'destructive', onPress: doRemoveWallet },
      ],
    );
  }, [inkey, wallet, doRemoveWallet]);

  return (
    <Page
      title="Wallet"
      subtitle="This wallet's own settings, and how to remove it."
      onBack={onBack}>
      <Group title="This wallet">
        <InfoRow first title="Name" value={wallet?.title || '—'} mono={false} />
        <InfoRow title="Network" value={wallet?.network || '—'} />
      </Group>

      <Group
        title="Dust"
        footer={
          prefs
            ? `Currently using ${prefs.effective_dust_threshold} sats${
                prefs.dust_threshold_sats == null
                  ? ' — the server default.'
                  : ' — your own setting.'
              }`
            : undefined
        }>
        <Block
          first
          title="Flag coins at or below"
          help={`Coins under this size are frozen automatically. Blank uses the server default${
            prefs ? ` of ${prefs.admin_default_dust} sats` : ''
          }.`}>
          {loadingPrefs ? (
            <View style={{ marginTop: space.lg }}>
              <ActivityIndicator color={colors.primary} />
            </View>
          ) : (
            <>
              <Field
                value={dustDraft}
                onChangeText={(t: string) => {
                  setDustDraft(t.replace(/[^0-9]/g, ''));
                  setDustSaved(false);
                  setDustError(null);
                }}
                keyboardType="number-pad"
                placeholder={prefs ? String(prefs.admin_default_dust) : 'default'}
                action="Save"
                onAction={saveDust}
                actionBusy={savingDust}
                actionDisabled={!dirty}
              />
              {dustError ? <Note kind="error">{dustError}</Note> : null}
              {dustSaved ? <Note kind="ok">Saved</Note> : null}
            </>
          )}
        </Block>
      </Group>

      <Group title="Danger zone">
        <Block
          first
          title="Remove this wallet"
          help="Removes the wallet from the server — its address and the record of its coins — and erases its keys from this phone. Your bitcoin stays safe on-chain; only the wallet data goes. You can restore it, and rescan its coins, from your recovery phrase and passphrase.">
          <Button
            label="Remove wallet"
            kind="danger"
            onPress={onRemoveWallet}
            busy={removing}
            disabled={!wallet}
            style={{ marginTop: space.md }}
          />
          {removeMsg ? <Note kind="info">{removeMsg}</Note> : null}
        </Block>
      </Group>
    </Page>
  );
}
