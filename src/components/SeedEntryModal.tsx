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
import { deriveSilentPayment, isValidMnemonic } from '@services/spKeys';
import { saveSeed } from '@services/seedVault';
import SeedInput from './SeedInput';
import { colors } from '@/theme';

// PUT THE WORDS ON THIS PHONE for a wallet that works without them.
//
// Added 2026-11-09, after four rounds of "I still cannot see the seed phrase".
// Every fix before this one was about carrying the words somewhere: into the
// backup file, out of it, between the two clients. None of them could do
// anything for the case the user was actually in — a wallet created in the web
// app BEFORE the browser started keeping phrases. There were no words anywhere
// in the system to carry. The file was not at fault and neither was the
// restore; there was simply nothing to find, and the only copy in existence was
// the one the user wrote down at creation.
//
// So the missing piece was never a message explaining that. It was a FIELD.
// Recover Keys has had this exact form all along and renders only while the
// keys are missing, so a working wallet — which is every wallet this applies
// to — could not reach it.
//
// The phrase is CHECKED, not taken on trust: derive from (words, passphrase)
// and require the wallet's own sp_address back. One wrong word or a wrong
// passphrase gives a different wallet, so this is a complete test, and it is
// what stops somebody storing a phrase that will not open anything.
//
// Nothing leaves the device. The derivation is local and `saveSeed` writes to
// the keystore; the server is never told.

interface Props {
  visible: boolean;
  wallet: api.SilntWallet | null;
  onClose: () => void;
  onSaved: () => void;
}

export default function SeedEntryModal({ visible, wallet, onClose, onSaved }: Props) {
  const [mnemonic, setMnemonic] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Cleared on OPEN as well as on close: twelve words left in a field across
  // two openings is the same bug the backup screen was reported for, with a
  // worse secret in it.
  useEffect(() => {
    if (!visible) return;
    setMnemonic('');
    setPassphrase('');
    setError(null);
    setBusy(false);
  }, [visible]);

  const submit = useCallback(async () => {
    if (!wallet) return;
    const phrase = mnemonic.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!phrase) {
      setError('Enter the 12 words.');
      return;
    }
    if (phrase.split(' ').length !== 12 || !isValidMnemonic(phrase)) {
      setError('Invalid seed phrase — the checksum (last word) is incorrect.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const keys = deriveSilentPayment(phrase, passphrase, wallet.network);
      if (keys.spAddress.toLowerCase() !== (wallet.sp_address || '').toLowerCase()) {
        setError("That doesn't match this wallet. Check the words and passphrase.");
        return;
      }
      // `false` is a failure, not a shrug: a keystore refusal here leaves the
      // screen claiming the words are saved when the next read will find
      // nothing.
      if (!(await saveSeed(wallet.id, phrase))) {
        setError('This phone would not store the phrase. Try again.');
        return;
      }
      onSaved();
      onClose();
    } catch (e: any) {
      setError(e?.message || 'Could not check that phrase.');
    } finally {
      setBusy(false);
    }
  }, [wallet, mnemonic, passphrase, onSaved, onClose]);

  if (!wallet) return null;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <ScrollView keyboardShouldPersistTaps="handled">
            <Text style={styles.heading}>Enter seed phrase</Text>
            <Text style={styles.sub}>
              Checked against this wallet, then kept on this phone. Nothing is
              sent to the server.
            </Text>

            <Text style={styles.label}>Seed phrase (12 words)</Text>
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
              placeholder="Leave empty if you did not set one"
              placeholderTextColor={colors.faint}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry={false}
              onSubmitEditing={submit}
            />

            {error ? <Text style={styles.error}>{error}</Text> : null}

            {/* Live whatever the fields hold — the handler says what is
                missing, where a greyed-out button says nothing. */}
            <TouchableOpacity
              style={[styles.primaryBtn, busy && styles.btnDisabled]}
              onPress={submit}
              disabled={busy}>
              {busy ? (
                <ActivityIndicator color={colors.onPrimary} />
              ) : (
                <Text style={styles.primaryBtnText}>Save on this phone</Text>
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
  error: { color: colors.danger, fontSize: 13, marginTop: 14 },
  primaryBtn: {
    backgroundColor: colors.primary,
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
