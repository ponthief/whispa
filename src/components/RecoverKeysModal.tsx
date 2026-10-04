import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import * as api from '@services/api';
import { storeWalletKeys } from '@services/secureKeys';
import { deriveSilentPayment, isValidMnemonic } from '@services/spKeys';
import { resetCatchUp } from '../hooks/useCatchUpScan';
import { saveSeed } from '@services/seedVault';
import { usePlainStatus } from '@stores/plainStatus';
import SeedInput from './SeedInput';
import { colors } from '@/theme';

const PRIMARY = colors.primary;

interface Props {
  visible: boolean;
  wallet: api.SilntWallet | null;
  onClose: () => void;
  onRecovered: () => void;
}

export default function RecoverKeysModal({
  visible,
  wallet,
  onClose,
  onRecovered,
}: Props) {
  const [mnemonic, setMnemonic] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      setMnemonic('');
      setPassphrase('');
      setError(null);
    }
  }, [visible, wallet]);

  const onSubmit = useCallback(async () => {
    setError(null);
    if (!wallet) return;
    const words = mnemonic.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length !== 12) {
      setError('Recovery phrase must be exactly 12 words.');
      return;
    }
    const phrase = words.join(' ');
    if (!isValidMnemonic(phrase)) {
      setError('Invalid recovery phrase — the checksum (last word) is incorrect.');
      return;
    }
    setBusy(true);
    try {
      // Derive entirely on-device, then confirm it reproduces THIS wallet's
      // address before trusting it — a wrong phrase or passphrase derives a
      // different address. Nothing is sent to the server.
      const keys = deriveSilentPayment(phrase, passphrase, wallet.network);
      if (
        keys.spAddress.toLowerCase() !== (wallet.sp_address || '').toLowerCase()
      ) {
        throw new Error(
          "That phrase doesn't match this wallet's address. Check the words and passphrase.",
        );
      }
      await storeWalletKeys(wallet.id, {
        scanSecret: keys.scanSecret,
        spendKey: keys.spendKey,
        refundAddress: keys.refundAddress,
        sweepAccount: keys.sweepAccount,
      });
      // AND KEEP THE PHRASE, so Security can show it again. saveSeed ran only
      // in CreateWalletModal, so a wallet restored from its words — which is
      // most wallets on a second device, and every wallet older than the
      // vault — had `hasSeed` false forever and no reveal to offer.
      //
      // Not a new exposure, and this is the moment that proves it: the phrase
      // was just checked against this wallet's own SP address, and the keys it
      // derived are going into the same keystore on the line above. The BIP-39
      // passphrase is still NOT stored — see services/seedVault — so a
      // passphrase-protected wallet's reveal stays incomplete, which the
      // reveal itself says.
      await saveSeed(wallet.id, phrase);
      resetCatchUp(wallet.id);
      // The recovered keys include the BIP-84 account key, which is what the
      // plain-address card and the background watcher read to decide whether
      // there is a plain chain at all. Both read it once, so without this they
      // keep saying there isn't one — the card offering to set it up, the plain
      // balance missing from the wallet screen — until they happen to remount.
      usePlainStatus.getState().requestRefresh();
      onRecovered();
      onClose();
    } catch (e: any) {
      setError(e?.message || 'Recovery failed. Check the phrase and try again.');
    } finally {
      setBusy(false);
    }
  }, [wallet, mnemonic, passphrase, onRecovered, onClose]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <ScrollView keyboardShouldPersistTaps="handled">
            <Text style={styles.heading}>Recover wallet keys</Text>
            <Text style={styles.sub}>
              Enter this wallet's 12-word recovery phrase to restore its keys on
              this device. Keys stay on-device — they're never sent to the server.
            </Text>

            <Text style={styles.label}>Recovery phrase (12 words)</Text>
            <SeedInput
              value={mnemonic}
              onChangeText={setMnemonic}
              placeholder="word1 word2 word3 …"
            />

            <Text style={styles.label}>Passphrase</Text>
            <TextInput
              style={styles.input}
              value={passphrase}
              onChangeText={setPassphrase}
              placeholder="Leave blank if none"
              placeholderTextColor={colors.faint}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
            />
            <Text style={styles.hint}>
              If this wallet was created with a BIP-39 passphrase, enter the exact
              same one. Leave blank otherwise.
            </Text>

            {error ? <Text style={styles.error}>{error}</Text> : null}

            <TouchableOpacity
              style={[styles.primaryBtn, busy && styles.btnDisabled]}
              onPress={onSubmit}
              disabled={busy}>
              {busy ? (
                <ActivityIndicator color={colors.onPrimary} />
              ) : (
                <Text style={styles.primaryBtnText}>Recover Keys</Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity style={styles.linkBtn} onPress={onClose} disabled={busy}>
              <Text style={styles.linkBtnText}>Cancel</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 20,
    maxHeight: '90%',
  },
  heading: { fontSize: 20, fontWeight: 'bold', color: colors.text },
  sub: { fontSize: 13, color: colors.muted, marginTop: 8, lineHeight: 19 },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.label,
    marginTop: 16,
    marginBottom: 6,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    color: colors.text,
    backgroundColor: colors.surfaceAlt,
  },
  mnemonic: { minHeight: 76, textAlignVertical: 'top' },
  hint: { fontSize: 12, color: colors.faint, marginTop: 6, lineHeight: 17 },
  error: { color: colors.danger, fontSize: 13, marginTop: 14 },
  primaryBtn: {
    backgroundColor: PRIMARY,
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 22,
  },
  primaryBtnText: { color: colors.onPrimary, fontSize: 16, fontWeight: '600' },
  btnDisabled: { opacity: 0.5 },
  linkBtn: { marginTop: 12, paddingVertical: 8, alignItems: 'center' },
  linkBtnText: { color: colors.muted, fontSize: 14, fontWeight: '600' },
});
