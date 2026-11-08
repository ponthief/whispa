import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import { useAppLockStore, authenticateGuarded } from '@stores/appLockStore';
import { verifyPin } from '@services/appPin';
import { readSeed, forgetSeed } from '@services/seedVault';
import PinPad from './PinPad';
import { colors } from '@/theme';

const PRIMARY = colors.primary;
const PIN_LENGTH = 6;

interface Props {
  visible: boolean;
  walletId: string;
  onClose: () => void;
  // Bumped when the phrase is forgotten, so the caller can hide its entry point.
  onForgotten?: () => void;
}

// Shows the seed phrase again, behind the app lock.
//
// The gate is re-asked here rather than trusted from the app being unlocked. It
// is worth less than it looks against an attacker holding an unlocked phone —
// they could already spend — and that is not who it is for. It is for the
// moment the phone is handed over, or read over a shoulder: the phrase is the
// one secret in the app that survives a wipe and a new device, so it should not
// be one tap from the settings list.
//
// Deliberately does not show the BIP-39 passphrase, because the device does not
// have it. That makes the reveal INCOMPLETE for a passphrase-protected wallet,
// and saying so is the whole point of the warning below: a user who believes
// twelve words are enough discovers otherwise only when recovering.
export default function SeedRevealModal({
  visible,
  walletId,
  onClose,
  onForgotten,
}: Props) {
  const pinSet = useAppLockStore((s) => s.pinSet);
  const bioEnabled = useAppLockStore((s) => s.bioEnabled);

  const [phrase, setPhrase] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!visible) {
      // Dropped the moment the modal closes: no reason for it to sit in state
      // behind a settings list.
      setPhrase(null);
      setPin('');
      setPinError(false);
      setBusy(false);
      setError(null);
      setCopied(false);
    }
  }, [visible]);

  const load = useCallback(async () => {
    const stored = await readSeed(walletId);
    if (!stored) {
      // Wallets created before the phrase was stored, and any whose owner chose
      // to forget it. Nothing to show and nothing to be done about it.
      // SAYS WHAT IS TRUE HERE, not where the words went. A wallet restored
      // from a web backup never had a phrase typed into this device — the
      // file carries derived keys and the browser has never held words — so
      // "it was shown once when the wallet was created" sends somebody
      // hunting for a copy that was never made. See SecurityPage.
      setError(
        'That seed phrase was not entered on this phone, so there is nothing to show.',
      );
      return;
    }
    setPhrase(stored);
  }, [walletId]);

  // ── Biometric gate ──
  const promptBiometric = useCallback(async () => {
    setBusy(true);
    setError(null);
    // Guarded for the same reason as the send gate: auto-lock "Immediately"
    // would lock the app behind this prompt and swallow the reveal.
    const ok = await authenticateGuarded('Confirm to show your seed phrase');
    setBusy(false);
    if (ok) await load();
    else setError("Couldn't verify it's you.");
  }, [load]);

  // ── PIN gate ──
  const submitPin = useCallback(
    async (entered: string) => {
      setBusy(true);
      // Only the normal PIN reveals. A duress PIN is NOT honoured here: its
      // whole purpose is to look like a successful unlock while destroying the
      // keys, and handing over the recovery phrase would undo that in the one
      // situation it exists for. It reads as a wrong PIN instead.
      const kind = await verifyPin(entered);
      setPin('');
      if (kind === 'normal') {
        setPinError(false);
        setBusy(false);
        await load();
        return;
      }
      setPinError(true);
      setBusy(false);
    },
    [load],
  );

  useEffect(() => {
    if (!busy && pin.length === PIN_LENGTH) submitPin(pin);
  }, [pin, busy, submitPin]);

  const onForget = useCallback(() => {
    Alert.alert(
      'Forget this phrase?',
      'This device will no longer be able to show it. Make sure your written copy is correct and complete first — including your passphrase, if you set one. Your wallet and funds are unaffected.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Forget',
          style: 'destructive',
          onPress: async () => {
            await forgetSeed(walletId);
            onForgotten?.();
            onClose();
          },
        },
      ],
    );
  }, [walletId, onForgotten, onClose]);

  const words = phrase ? phrase.trim().split(/\s+/) : [];

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <ScrollView keyboardShouldPersistTaps="handled">
            <Text style={styles.heading}>Seed phrase</Text>

            {phrase ? (
              <>
                <View style={styles.warnBox}>
                  <Text style={styles.warnText}>
                    Anyone with these words can spend your coins. Write them
                    down on paper and keep them offline — never in a photo, a
                    note, or a password manager you do not control.
                  </Text>
                </View>

                <View style={styles.words}>
                  {words.map((w, i) => (
                    <View key={`${i}-${w}`} style={styles.wordCell}>
                      <Text style={styles.wordIndex}>{i + 1}</Text>
                      <Text style={styles.word}>{w}</Text>
                    </View>
                  ))}
                </View>

                {/* The gap that loses funds silently. The passphrase is not on
                    the device, so these words alone do not recover a wallet
                    that has one. */}
                <Text style={styles.hint}>
                  If you set a passphrase, it is NOT shown here and is not
                  stored on this device. These words alone will not recover your
                  wallet without it.
                </Text>

                <TouchableOpacity
                  style={styles.ghostBtn}
                  onPress={() => {
                    Clipboard.setString(phrase);
                    setCopied(true);
                  }}>
                  <Text style={styles.ghostBtnText}>
                    {copied ? '✓ Copied' : 'Copy to clipboard'}
                  </Text>
                </TouchableOpacity>
                <Text style={styles.hint}>
                  The clipboard is readable by other apps. Clear it when you are
                  done, or write the words down instead.
                </Text>

                <TouchableOpacity style={styles.dangerBtn} onPress={onForget}>
                  <Text style={styles.dangerBtnText}>
                    Forget this phrase on this device
                  </Text>
                </TouchableOpacity>
              </>
            ) : pinSet ? (
              <>
                <Text style={styles.sub}>Enter your PIN to show it.</Text>
                <PinPad
                  value={pin}
                  onChange={(v) => {
                    setPinError(false);
                    setPin(v);
                  }}
                  length={PIN_LENGTH}
                  disabled={busy}
                />
                {busy ? (
                  <ActivityIndicator color={PRIMARY} style={styles.spinner} />
                ) : pinError ? (
                  <Text style={styles.error}>Incorrect PIN. Try again.</Text>
                ) : null}
              </>
            ) : bioEnabled ? (
              <>
                <Text style={styles.sub}>
                  Confirm it's you to show your seed phrase.
                </Text>
                <TouchableOpacity
                  style={[styles.primaryBtn, busy && styles.btnDisabled]}
                  onPress={promptBiometric}
                  disabled={busy}>
                  {busy ? (
                    <ActivityIndicator color={colors.onPrimary} />
                  ) : (
                    <Text style={styles.primaryBtnText}>Confirm</Text>
                  )}
                </TouchableOpacity>
              </>
            ) : (
              // Cannot normally happen: a stored session requires a lock
              // (App.tsx). Refusing is the right answer regardless — an
              // ungated reveal is not something to fall back to.
              <Text style={styles.error}>
                Set up App Lock or an App PIN first — showing your recovery
                phrase needs something to check it against.
              </Text>
            )}

            {error ? <Text style={styles.error}>{error}</Text> : null}

            <TouchableOpacity style={styles.linkBtn} onPress={onClose}>
              <Text style={styles.linkBtnText}>
                {phrase ? 'Done' : 'Cancel'}
              </Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: 22,
    maxHeight: '92%',
  },
  heading: { fontSize: 20, fontWeight: '700', color: colors.text },
  sub: { fontSize: 14, color: colors.muted, marginTop: 8, marginBottom: 18, lineHeight: 20 },
  warnBox: {
    borderWidth: 1,
    borderColor: colors.danger,
    borderRadius: 10,
    padding: 12,
    marginTop: 14,
  },
  warnText: { fontSize: 12, color: colors.text, lineHeight: 18 },
  words: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 16 },
  wordCell: {
    flexDirection: 'row',
    alignItems: 'baseline',
    width: '50%',
    paddingVertical: 6,
    paddingRight: 8,
  },
  wordIndex: { fontSize: 11, color: colors.faint, width: 22 },
  word: { fontSize: 15, color: colors.text, fontFamily: 'monospace' },
  hint: { fontSize: 12, color: colors.faint, marginTop: 12, lineHeight: 17 },
  primaryBtn: {
    backgroundColor: PRIMARY,
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
  },
  primaryBtnText: { color: colors.onPrimary, fontSize: 16, fontWeight: '600' },
  btnDisabled: { opacity: 0.5 },
  ghostBtn: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 18,
  },
  ghostBtnText: { color: colors.text, fontSize: 14, fontWeight: '600' },
  dangerBtn: {
    borderWidth: 1,
    borderColor: colors.danger,
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 18,
  },
  dangerBtnText: { color: colors.danger, fontSize: 14, fontWeight: '600' },
  spinner: { marginTop: 16 },
  error: { color: colors.danger, fontSize: 13, marginTop: 14, lineHeight: 18 },
  linkBtn: { marginTop: 22, paddingVertical: 8, alignItems: 'center' },
  linkBtnText: { color: colors.muted, fontSize: 15, fontWeight: '600' },
});
