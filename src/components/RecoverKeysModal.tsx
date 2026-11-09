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
import { NativeModules } from 'react-native';
import * as api from '@services/api';
import { hasWalletKeys, storeWalletKeys } from '@services/secureKeys';
import { deriveSilentPayment, isValidMnemonic, spAddressFromKeys } from '@services/spKeys';
import { decryptBackup, inspectBackupFile } from '@services/backup';
import { restoreWallets } from '@services/walletBackup';
import { hasSeed } from '@services/seedVault';
import { resetCatchUp } from '../hooks/useCatchUpScan';
import { saveSeed } from '@services/seedVault';
import { paint } from '@services/paint';
import { usePlainStatus } from '@stores/plainStatus';
import { useAuthStore } from '@stores/authStore';
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
  // A BACKUP FILE IS THE OTHER WAY OUT OF THIS SCREEN (2026-11-08, on the
  // user's instruction: "should move restore under recover keys as user
  // should be able to fully restore wallet from there"). This is where
  // somebody lands when a wallet cannot scan, and until now the only exit was
  // typing twelve words — which is exactly what a backup exists to avoid.
  //
  // A CHOSEN FILE TAKES OVER THE SCREEN, and that is a fix rather than a
  // layout preference. The file's secret first shared the wallet-passphrase
  // field further down the sheet, which read on screen as no prompt at all:
  // "it didn't prompt me for a passphrase, there was no field where to enter
  // it — clicked Open file and then got warned to enter passphrase but below
  // where the seed phrase text is". Exactly so. The Open button sat ABOVE the
  // field it needed, with a 12-word input in between, so the only way to find
  // the field was to press Open, fail, and read the error.
  //
  // So the two routes out of this screen are never on screen together: with a
  // file in hand the sheet is the file, its secret, and Open, in that order,
  // and the phrase form is one tap away. A field doing double duty for two
  // different secrets is also how the backup screen's own
  // "restored without being prompted for a password" bug happened.
  const inkey = useAuthStore((st) => st.inkey);
  const [file, setFile] = useState<null | { text: string; asksFor: string }>(null);
  const [filePass, setFilePass] = useState('');
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      setMnemonic('');
      setPassphrase('');
      setFile(null);
      setFilePass('');
      setNote(null);
      setError(null);
    }
  }, [visible, wallet]);

  // Pick the file. Nothing is asked for first: until one is chosen there is
  // nothing to ask about, and the file's own header says which secret it
  // wants — the same rule the Backup screen follows.
  const pickBackup = useCallback(async () => {
    setError(null);
    setNote(null);
    setBusy(true);
    try {
      const mod = (NativeModules as any).BackupFile;
      if (!mod) throw new Error('This build cannot open files.');
      const text: string | null = await mod.open();
      if (!text) return;            // backing out is not an error
      const info = inspectBackupFile(text);
      if (!info.readable) throw new Error(info.problem || 'That is not a backup.');
      setFile({ text, asksFor: info.asksFor });
      // Emptied on every pick, for the reason the Backup screen states: a
      // secret typed for one file is not evidence about the next one.
      setFilePass('');
      setNote(null);
    } catch (e: any) {
      setError(e?.message || 'Could not read that file.');
    } finally {
      setBusy(false);
    }
  }, []);

  const openBackup = useCallback(async () => {
    if (!file) return;
    if (!filePass) {
      setError(`Enter the ${file.asksFor} for this file.`);
      return;
    }
    if (!inkey) {
      setError('Sign in again before restoring.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      setNote('Opening backup file…');
      // REPORTED 2026-11-09: "pressing Open backup file after passphrase
      // entered shows as if nothing is happening!!" — and it was not: the
      // note and the button's spinner were both set and neither had been
      // drawn. decryptBackup parses the file and decodes three base64 blobs
      // before the KDF's first yield, and a state update in front of
      // synchronous work arrives after it. One macrotask puts both on screen
      // first. See services/paint.ts.
      await paint();
      const payload: any = await decryptBackup(file.text, filePass,
        (f) => setNote(`Opening… ${Math.round(f * 100)}%`));
      setNote('Reading your wallets…');
      await paint();
      const live = (await api.getSilntWallets(inkey).catch(() => []) as any[])
        .map((w: any) => ({ id: w.id, spAddress: w.sp_address || '' }));
      const r = await restoreWallets(
        {
          deriveSilentPayment,
          spAddressFromKeys,
          createWallet: (data) => api.createSilntWallet(inkey, data) as any,
          storeWalletKeys,
          saveSeed,
          hasKeys: hasWalletKeys,
          hasSeed,
          onCreated: resetCatchUp,
          // The stretch after the KDF, which this screen reported nothing for
          // at all: one synchronous deriveSilentPayment per wallet, plus the
          // creates and the keystore writes.
          onProgress: async (done, total, title) => {
            setNote(total > 1
              ? `Restoring ${title} (${done} of ${total})…`
              : `Restoring ${title}…`);
            await paint();
          },
        },
        filePass, payload.wallets || [], live);
      const done = r.created.length + r.adopted.length;
      if (!done) {
        const why = r.mismatched.length
          ? 'its keys do not match this wallet'
          : r.noPhrase
            ? 'that file carries no keys — save a new backup and use that'
            : r.failed.length
              ? r.failed[0].message
              : 'this device already had everything in it';
        setError(`Nothing to restore: ${why}.`);
        setNote(null);
        return;
      }
      // A FINISHED RESTORE DROPS BOTH; a failed one keeps the file, so a
      // mistyped secret is retyped against what is already in hand.
      setFile(null);
      setFilePass('');
      setNote(null);
      onRecovered();
    } catch (e: any) {
      setError(e?.message || 'Could not open that backup.');
      setNote(null);
    } finally {
      setBusy(false);
    }
  }, [file, inkey, filePass, onRecovered]);

  const onSubmit = useCallback(async () => {
    setError(null);
    if (!wallet) return;
    const words = mnemonic.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length !== 12) {
      setError('Seed phrase must be exactly 12 words.');
      return;
    }
    const phrase = words.join(' ');
    if (!isValidMnemonic(phrase)) {
      setError('Invalid seed phrase — the checksum (last word) is incorrect.');
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
              Restore this wallet from a backup file, or enter its 12-word
              seed phrase. Keys stay on-device — they're never sent to the
              server.
            </Text>

            {file ? (
              /* A FILE IS IN HAND: this sheet is now about that file, and the
                 order is the fix — what was chosen, the secret it asks for,
                 then Open. The button used to sit above the field it needed
                 with a 12-word input in between, so the prompt was invisible
                 until pressing Open produced an error naming it. */
              <>
                <Text style={styles.label}>Backup file</Text>
                <Text style={styles.hint}>
                  Ready to open. Enter the {file.asksFor} this backup was saved
                  with.
                </Text>

                <Text style={styles.label}>
                  {file.asksFor.charAt(0).toUpperCase() + file.asksFor.slice(1)}{' '}
                  for this file
                </Text>
                <TextInput
                  style={styles.input}
                  value={filePass}
                  onChangeText={setFilePass}
                  placeholder={`The ${file.asksFor} that opens it`}
                  placeholderTextColor={colors.faint}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoFocus
                  // Not masked, for the reason the Backup screen gives: a
                  // per-file secret with no checksum, typed once, where seeing
                  // it is the only way to tell you typed what you typed before.
                  secureTextEntry={false}
                  onSubmitEditing={openBackup}
                />

                {note ? <Text style={styles.hint}>{note}</Text> : null}
                {error ? <Text style={styles.error}>{error}</Text> : null}

                <TouchableOpacity
                  style={[styles.primaryBtn, busy && styles.btnDisabled]}
                  onPress={openBackup}
                  disabled={busy}>
                  {busy ? (
                    <ActivityIndicator color={colors.onPrimary} />
                  ) : (
                    <Text style={styles.primaryBtnText}>🔓 Open backup</Text>
                  )}
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.linkBtn}
                  onPress={pickBackup}
                  disabled={busy}>
                  <Text style={styles.linkBtnText}>Choose a different file</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.linkBtn}
                  onPress={() => {
                    setFile(null);
                    setFilePass('');
                    setNote(null);
                    setError(null);
                  }}
                  disabled={busy}>
                  <Text style={styles.linkBtnText}>
                    Use a seed phrase instead
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.linkBtn} onPress={onClose} disabled={busy}>
                  <Text style={styles.linkBtnText}>Cancel</Text>
                </TouchableOpacity>
              </>
            ) : (
              /* THE FILE FIRST (2026-11-08: "should move restore under recover
                 keys as user should be able to fully restore wallet from
                 there"). This is the screen somebody reaches when a wallet
                 cannot scan, and the only way out of it used to be typing
                 twelve words — which is the thing a backup exists to avoid. */
              <>
                <TouchableOpacity
                  style={[styles.primaryBtn, busy && styles.btnDisabled]}
                  onPress={pickBackup}
                  disabled={busy}>
                  {busy ? (
                    <ActivityIndicator color={colors.onPrimary} />
                  ) : (
                    <Text style={styles.primaryBtnText}>
                      ↑ Restore from backup file
                    </Text>
                  )}
                </TouchableOpacity>

                <Text style={[styles.hint, { textAlign: 'center', marginTop: 10 }]}>
                  or
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
                  placeholder="Leave blank if none"
                  placeholderTextColor={colors.faint}
                  autoCapitalize="none"
                  autoCorrect={false}
                  secureTextEntry
                />
                <Text style={styles.hint}>
                  If this wallet was created with a BIP-39 passphrase, enter the
                  exact same one. Leave blank otherwise.
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
              </>
            )}
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
