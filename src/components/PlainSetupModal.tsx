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
import { getWalletKeys, storeWalletKeys } from '@services/secureKeys';
import { deriveSilentPayment, isValidMnemonic } from '@services/spKeys';
import SeedInput from './SeedInput';
import { colors } from '@/theme';

const PRIMARY = colors.primary;

/**
 * One-off prompt for wallets stored before the plain chain existed: their
 * keystore entry has no BIP-84 account key, so it gets derived from the recovery
 * phrase once and saved. After this the phrase is never asked for again.
 *
 * The phrase is checked by re-deriving the wallet's Silent Payment address from
 * it — a wrong phrase or a forgotten passphrase is a different wallet entirely,
 * and would otherwise install an account key for addresses the user can't see.
 */
export default function PlainSetupModal({
  visible,
  wallet,
  onClose,
  onReady,
}: {
  visible: boolean;
  wallet: api.SilntWallet;
  onClose: () => void;
  onReady: () => void;
}) {
  const [mnemonic, setMnemonic] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setMnemonic('');
    setPassphrase('');
    setError(null);
  }, [visible]);

  const onSubmit = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const words = mnemonic.trim().toLowerCase().split(/\s+/).filter(Boolean);
      if (words.length !== 12) {
        throw new Error('Recovery phrase must be exactly 12 words.');
      }
      const phrase = words.join(' ');
      if (!isValidMnemonic(phrase)) {
        throw new Error(
          'Invalid recovery phrase — the checksum (last word) is incorrect.',
        );
      }
      const derived = deriveSilentPayment(phrase, passphrase, wallet.network);
      if (
        derived.spAddress.toLowerCase() !== (wallet.sp_address || '').toLowerCase()
      ) {
        throw new Error(
          "That phrase doesn't match this wallet's address. Check the words and passphrase.",
        );
      }
      const existing = await getWalletKeys(wallet.id);
      await storeWalletKeys(wallet.id, {
        scanSecret: existing?.scanSecret || derived.scanSecret,
        spendKey: existing?.spendKey || derived.spendKey,
        refundAddress: derived.refundAddress,
        sweepAccount: derived.sweepAccount,
      });
      onReady();
      onClose();
    } catch (e: any) {
      setError(e?.message || 'Could not set up SegWit addresses.');
    } finally {
      setBusy(false);
    }
  }, [mnemonic, passphrase, wallet, onReady, onClose]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <ScrollView keyboardShouldPersistTaps="handled">
            <Text style={styles.heading}>Set up SegWit addresses</Text>
            <Text style={styles.sub}>
              This wallet predates SegWit addresses, so its key for them needs
              deriving once. Enter your recovery phrase and this device handles
              them from then on — you won't be asked again.
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

            {error ? <Text style={styles.error}>{error}</Text> : null}

            <TouchableOpacity
              style={[styles.primaryBtn, busy && styles.btnDisabled]}
              onPress={onSubmit}
              disabled={busy}>
              {busy ? (
                <ActivityIndicator color={colors.onPrimary} />
              ) : (
                <Text style={styles.primaryBtnText}>Set up</Text>
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
  feeRow: { flexDirection: 'row', alignItems: 'center' },
  feeInput: { flex: 1 },
  secondaryBtn: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingVertical: 11,
    paddingHorizontal: 14,
    marginLeft: 8,
  },
  secondaryBtnText: { fontSize: 14, fontWeight: '600', color: colors.text },
  spinner: { marginTop: 18 },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 14,
  },
  rowLabel: { fontSize: 13, color: colors.muted },
  rowValue: { fontSize: 15, fontWeight: '600', color: colors.text },
  mono: {
    fontFamily: 'monospace',
    fontSize: 12,
    color: colors.text,
    marginTop: 14,
    lineHeight: 18,
  },
  hint: { fontSize: 12, color: colors.faint, marginTop: 12, lineHeight: 17 },
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
