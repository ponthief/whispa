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
import Clipboard from '@react-native-clipboard/clipboard';
import Config from 'react-native-config';
import { useAuthStore } from '@stores/authStore';
import * as api from '@services/api';
import { storeWalletKeys } from '@services/secureKeys';
import {
  deriveSilentPayment,
  generateMnemonic,
  isValidMnemonic,
  validateNewWalletPassphrase,
} from '@services/spKeys';
import { resetCatchUp } from '../hooks/useCatchUpScan';
import { useSeedBackup } from '@stores/seedBackup';
import { saveSeed } from '@services/seedVault';
import SeedInput from './SeedInput';
import { colors } from '@/theme';

const PRIMARY = colors.primary;

interface Props {
  visible: boolean;
  onClose: () => void;
  onCreated: () => void;
}

type Step = 'form' | 'reveal' | 'verify';
type VerifyPrompt = { index: number; answer: string };
type Mode = 'generate' | 'import';

export default function CreateWalletModal({ visible, onClose, onCreated }: Props) {
  const inkey = useAuthStore((s) => s.inkey);
  const netLock = Config.NETWORK_LOCK || 'mainnet';
  const network = netLock.toUpperCase();

  const [step, setStep] = useState<Step>('form');
  const [mode, setMode] = useState<Mode>('generate');
  const [title, setTitle] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [mnemonicInput, setMnemonicInput] = useState('');
  const [birthHeight, setBirthHeight] = useState('');
  const [minScanHeight, setMinScanHeight] = useState(0);
  const [tip, setTip] = useState(0);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Valid birth-height range for an import: [indexer start block, chain tip].
  // Below the start there's no tweak data to scan; above the tip is a
  // future/invalid block.
  useEffect(() => {
    if (!inkey) return;
    api
      .getAppConfig(inkey)
      .then((c) => setMinScanHeight(Number(c?.min_scan_height) || 0))
      .catch(() => {});
    api
      .getChainTip(inkey)
      .then((t) => setTip(Number(t?.height) || 0))
      .catch(() => {});
  }, [inkey]);

  const [mnemonic, setMnemonic] = useState<string>('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [copied, setCopied] = useState(false);

  // A reveal interrupted by the app lock. The modal was unmounted while the
  // phrase was on screen, so pick it back up rather than returning the user to
  // a wallet screen with no way to see it again.
  const pendingMnemonic = useSeedBackup((s) => s.mnemonic);
  useEffect(() => {
    if (pendingMnemonic && step === 'form' && !mnemonic) {
      setMnemonic(pendingMnemonic);
      setStep('reveal');
    }
    // Runs on mount and whenever a pending backup appears; the guards keep it
    // from dragging a user who is mid-form back to a reveal.
  }, [pendingMnemonic, step, mnemonic]);

  // Seed-backup verification (mirrors the web): after showing the seed, quiz the
  // user on a few random word positions before finishing. Entirely on-device.
  const [verifyPrompts, setVerifyPrompts] = useState<VerifyPrompt[]>([]);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setStep('form');
    setMode('generate');
    setTitle('');
    setPassphrase('');
    setMnemonicInput('');
    setBirthHeight('');
    setShowAdvanced(false);
    setCreating(false);
    setError(null);
    setMnemonic('');
    setAcknowledged(false);
    setCopied(false);
    setVerifyPrompts([]);
    setVerifyError(null);
  }, []);

  const onCreate = useCallback(async () => {
    setError(null);
    if (!title.trim()) {
      setError('Please enter a title for the wallet.');
      return;
    }
    if (!inkey) {
      setError('Not logged in.');
      return;
    }

    // Establish the seed for this wallet: freshly generated, or the user's import.
    let seedPhrase: string;
    let lastHeight: number | undefined;
    if (mode === 'import') {
      const words = mnemonicInput.trim().toLowerCase().split(/\s+/).filter(Boolean);
      if (words.length !== 12) {
        setError('Seed phrase must be exactly 12 words.');
        return;
      }
      seedPhrase = words.join(' ');
      if (!isValidMnemonic(seedPhrase)) {
        setError('Invalid seed phrase — the checksum (last word) is incorrect.');
        return;
      }
      // IMPORT IS FOR WHISPA WALLETS, so the passphrase is required here too
      // (2026-11-03). It used to be exempt, on the reasoning that a wallet made
      // elsewhere might not have one — but every WhiSPa wallet is generated
      // through the branch below, which has always demanded a passphrase, so
      // the exemption only ever admitted wallets this app did not make.
      //
      // It is also what the encrypted backup now rests on: the file is sealed
      // with the wallet's passphrase, so a wallet without one cannot be backed
      // up at all. Letting such a wallet in through import would create an
      // account that silently cannot use the feature.
      const importPpErr = validateNewWalletPassphrase(passphrase);
      if (importPpErr) {
        setError(
          `${importPpErr} Every WhiSPa wallet has a passphrase — if you are ` +
            `restoring a wallet made in another app, it cannot be imported here.`,
        );
        return;
      }
      const height = Number(birthHeight);
      if (!birthHeight || !Number.isFinite(height) || height < 0) {
        setError('Enter the wallet birth height (block number) to import.');
        return;
      }
      // The indexer has no tweak data before its start block, so a wallet born
      // below it can never scan.
      if (minScanHeight && height < minScanHeight) {
        setError(
          `Birth height must be at least ${minScanHeight} — the indexer has no data before that block.`,
        );
        return;
      }
      // A birth height in the future (above the chain tip) is invalid — nothing
      // to scan there.
      if (tip && height > tip) {
        setError(
          `Birth height can't be above the current chain tip (${tip}).`,
        );
        return;
      }
      lastHeight = Math.floor(height);
    } else {
      // The passphrase is mixed into the seed and cannot be recovered if
      // forgotten. Required on import too — see the note there.
      const ppErr = validateNewWalletPassphrase(passphrase);
      if (ppErr) {
        setError(ppErr);
        return;
      }
      try {
        seedPhrase = generateMnemonic();
      } catch (e: any) {
        // Secure-RNG guard tripped (e.g. remote JS debugging) — never fall back
        // to a weak seed.
        setError(e?.message || 'Could not generate a secure seed on this device.');
        return;
      }
    }

    // Derive keys ON THIS DEVICE. The mnemonic and private keys never leave the
    // phone — the server only ever receives the public sp_address.
    let keys;
    try {
      keys = deriveSilentPayment(seedPhrase, passphrase, netLock);
    } catch (e: any) {
      // Surface the underlying reason (e.g. a normalization error) instead of a
      // generic message, so a real derivation failure is diagnosable.
      setError(
        'Could not derive wallet keys on this device' +
          (e?.message ? `: ${e.message}` : '.'),
      );
      return;
    }

    const data: {
      title: string;
      sp_address: string;
      last_height?: number;
    } = { title: title.trim(), sp_address: keys.spAddress };
    if (lastHeight !== undefined) data.last_height = lastHeight;

    setCreating(true);
    try {
      const res = await api.createSilntWallet(inkey, data);
      // Persist the locally-derived SP keys in the platform keystore so this
      // device can scan (and later spend). These come from local derivation, not
      // the response — the server never had them.
      await storeWalletKeys(res.wallet_id, {
        scanSecret: keys.scanSecret,
        spendKey: keys.spendKey,
        refundAddress: keys.refundAddress,
        sweepAccount: keys.sweepAccount,
      });
      // A reimport reuses the same seed-derived id — let it be re-evaluated for
      // catch-up scanning instead of being treated as already-checked.
      resetCatchUp(res.wallet_id);
      if (mode === 'generate') {
        // Fresh seed — show it once so the user can back it up.
        //
        // Parked in the store BEFORE the step changes, so it exists outside this
        // component from the moment it is displayed. A lock unmounts the modal;
        // without this the only copy of the phrase went with it.
        useSeedBackup.getState().begin(res.wallet_id, seedPhrase);
        // Kept so it can be shown again — see services/seedVault for why that
        // is not a new exposure next to the spend key already stored. Awaited
        // so the reveal below is never the only copy in existence.
        await saveSeed(res.wallet_id, seedPhrase);
        setMnemonic(seedPhrase);
        setStep('reveal');
      } else {
        // Import: the user already has their phrase, but store it anyway so
        // "show my seed phrase" works the same on an imported wallet as on
        // a generated one. They typed it, so nothing new is learned by keeping
        // it beside the keys it just derived.
        await saveSeed(res.wallet_id, seedPhrase);
        onCreated();
        reset();
        onClose();
      }
    } catch (e: any) {
      setError(e?.message || 'Could not create wallet.');
    } finally {
      setCreating(false);
    }
  }, [
    title,
    passphrase,
    mode,
    mnemonicInput,
    birthHeight,
    minScanHeight,
    tip,
    inkey,
    netLock,
    onCreated,
    onClose,
    reset,
  ]);

  const finishReveal = useCallback(() => {
    // The user has confirmed the phrase, so the app's responsibility for it
    // ends here — and only here.
    useSeedBackup.getState().done();
    onCreated();
    reset();
    onClose();
  }, [onCreated, reset, onClose]);

  const startVerify = useCallback(() => {
    const words = mnemonic ? mnemonic.trim().split(/\s+/) : [];
    if (words.length < 3) {
      // Nothing sensible to quiz — just finish.
      finishReveal();
      return;
    }
    // Pick 3 distinct random positions (like the web). Math.random is fine here —
    // this only chooses which words to quiz, it's not security-sensitive.
    const picks = new Set<number>();
    while (picks.size < 3) picks.add(Math.floor(Math.random() * words.length));
    setVerifyPrompts(
      [...picks].sort((a, b) => a - b).map((i) => ({ index: i + 1, answer: '' })),
    );
    setVerifyError(null);
    setStep('verify');
  }, [mnemonic, finishReveal]);

  const setPromptAnswer = useCallback((index: number, answer: string) => {
    setVerifyPrompts((prev) =>
      prev.map((p) => (p.index === index ? { ...p, answer } : p)),
    );
    setVerifyError(null);
  }, []);

  const checkVerify = useCallback(() => {
    const words = mnemonic ? mnemonic.trim().split(/\s+/) : [];
    const ok = verifyPrompts.every(
      (p) =>
        (p.answer || '').trim().toLowerCase() ===
        (words[p.index - 1] || '').toLowerCase(),
    );
    if (!ok) {
      setVerifyError("That doesn't match. Check your written copy and try again.");
      return;
    }
    finishReveal();
  }, [mnemonic, verifyPrompts, finishReveal]);

  const copyMnemonic = useCallback(() => {
    Clipboard.setString(mnemonic);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [mnemonic]);

  const words = mnemonic ? mnemonic.trim().split(/\s+/) : [];

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={step === 'form' ? onClose : undefined}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          {step === 'form' ? (
            <ScrollView keyboardShouldPersistTaps="handled">
              <Text style={styles.heading}>New Wallet</Text>
              <Text style={styles.networkTag}>{network}</Text>

              <View style={styles.segment}>
                <TouchableOpacity
                  style={[styles.segBtn, mode === 'generate' && styles.segBtnOn]}
                  onPress={() => {
                    setMode('generate');
                    setError(null);
                  }}>
                  <Text
                    style={[
                      styles.segText,
                      mode === 'generate' && styles.segTextOn,
                    ]}>
                    Generate
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.segBtn, mode === 'import' && styles.segBtnOn]}
                  onPress={() => {
                    setMode('import');
                    setError(null);
                  }}>
                  <Text
                    style={[
                      styles.segText,
                      mode === 'import' && styles.segTextOn,
                    ]}>
                    Import
                  </Text>
                </TouchableOpacity>
              </View>

              <Text style={styles.label}>Wallet name</Text>
              <TextInput
                style={styles.input}
                value={title}
                onChangeText={setTitle}
                placeholder="My Wallet"
                placeholderTextColor={colors.faint}
                maxLength={40}
                autoFocus
              />

              {mode === 'import' ? (
                <>
                  <Text style={styles.label}>Seed phrase (12 words)</Text>
                  <SeedInput
                    value={mnemonicInput}
                    onChangeText={setMnemonicInput}
                    placeholder="word1 word2 word3 …"
                  />
                  <Text style={styles.hint}>
                    Import only a Silent Payments wallet's seed phrase.
                    WhiSPa derives keys at the BIP-352 path (m/352′), so a
                    regular Bitcoin wallet phrase won't recover those coins here
                    — it would just start a new, empty SP wallet.
                  </Text>
                  <Text style={styles.label}>Born at height (block)</Text>
                  <TextInput
                    style={styles.input}
                    value={birthHeight}
                    onChangeText={(t) => setBirthHeight(t.replace(/[^0-9]/g, ''))}
                    placeholder={minScanHeight ? `e.g. ${minScanHeight}` : 'e.g. 840000'}
                    placeholderTextColor={colors.faint}
                    keyboardType="number-pad"
                  />
                  <Text style={styles.hint}>
                    The block height the wallet was created at. Scanning starts
                    here, so an accurate value avoids missing funds.
                    {minScanHeight && tip
                      ? ` Must be between ${minScanHeight} and the current tip (${tip}).`
                      : minScanHeight
                        ? ` Must be at least ${minScanHeight} — the indexer has no data before that block.`
                        : ''}
                  </Text>
                </>
              ) : null}

              {mode === 'generate' ? (
                <>
                  <Text style={styles.label}>BIP-39 passphrase (required)</Text>
                  <TextInput
                    style={styles.input}
                    value={passphrase}
                    onChangeText={setPassphrase}
                    placeholder="12+ chars — letters, numbers & symbols"
                    placeholderTextColor={colors.faint}
                    autoCapitalize="none"
                    autoCorrect={false}
                    secureTextEntry
                  />
                  <Text style={styles.hint}>
                    An extra secret mixed into your seed — needed every time you
                    restore this wallet, and it CANNOT be recovered if forgotten.
                    You'll back it up on the next screen with your seed phrase.
                    Use standard keyboard characters (letters, numbers, and
                    symbols like ! ? # $); avoid accented or non-English letters.
                  </Text>
                </>
              ) : (
                <>
                  <TouchableOpacity
                    onPress={() => setShowAdvanced((v) => !v)}
                    style={styles.advancedToggle}>
                    <Text style={styles.advancedText}>
                      {showAdvanced ? '▾' : '▸'} Advanced (optional passphrase)
                    </Text>
                  </TouchableOpacity>
                  {showAdvanced ? (
                    <>
                      <Text style={styles.label}>BIP-39 passphrase</Text>
                      <TextInput
                        style={styles.input}
                        value={passphrase}
                        onChangeText={setPassphrase}
                        placeholder="Leave blank for none"
                        placeholderTextColor={colors.faint}
                        autoCapitalize="none"
                        autoCorrect={false}
                        secureTextEntry
                      />
                      <Text style={styles.hint}>
                        If this wallet was created with a passphrase, enter the
                        exact same one.
                      </Text>
                    </>
                  ) : null}
                </>
              )}

              {error ? <Text style={styles.error}>{error}</Text> : null}

              <TouchableOpacity
                style={[styles.primaryBtn, creating && styles.btnDisabled]}
                onPress={onCreate}
                disabled={creating}>
                {creating ? (
                  <ActivityIndicator color={colors.onPrimary} />
                ) : (
                  <Text style={styles.primaryBtnText}>
                    {mode === 'import' ? 'Import Wallet' : 'Create Wallet'}
                  </Text>
                )}
              </TouchableOpacity>
              <TouchableOpacity style={styles.linkBtn} onPress={onClose}>
                <Text style={styles.linkBtnText}>Cancel</Text>
              </TouchableOpacity>
            </ScrollView>
          ) : step === 'reveal' ? (
            <ScrollView keyboardShouldPersistTaps="handled">
              <Text style={styles.heading}>Save your seed phrase</Text>
              <Text style={styles.warn}>
                Write these 12 words down in order — AND your passphrase below.
                You need BOTH to recover this wallet, and neither can be shown
                again. A lost passphrase means lost funds.
              </Text>

              <View style={styles.wordGrid}>
                {words.map((w, i) => (
                  <View key={`${i}-${w}`} style={styles.wordChip}>
                    <Text style={styles.wordIndex}>{i + 1}</Text>
                    <Text style={styles.wordText}>{w}</Text>
                  </View>
                ))}
              </View>

              <TouchableOpacity style={styles.copyBtn} onPress={copyMnemonic}>
                <Text style={styles.copyBtnText}>
                  {copied ? '✓ Copied' : 'Copy phrase'}
                </Text>
              </TouchableOpacity>

              {passphrase ? (
                <View style={styles.passphraseReveal}>
                  <Text style={styles.label}>Passphrase</Text>
                  <Text style={styles.passphraseValue} selectable>
                    {passphrase}
                  </Text>
                  <Text style={styles.hint}>
                    Required together with the 12 words. Store it as carefully as
                    your seed phrase — it cannot be recovered.
                  </Text>
                </View>
              ) : null}

              <TouchableOpacity
                style={styles.checkRow}
                onPress={() => setAcknowledged((v) => !v)}>
                <View style={[styles.checkbox, acknowledged && styles.checkboxOn]}>
                  {acknowledged ? <Text style={styles.checkMark}>✓</Text> : null}
                </View>
                <Text style={styles.checkLabel}>
                  I have saved my seed phrase and passphrase.
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.primaryBtn, !acknowledged && styles.btnDisabled]}
                onPress={startVerify}
                disabled={!acknowledged}>
                <Text style={styles.primaryBtnText}>Continue</Text>
              </TouchableOpacity>
            </ScrollView>
          ) : (
            <ScrollView keyboardShouldPersistTaps="handled">
              <Text style={styles.heading}>Verify your backup</Text>
              <Text style={styles.hint}>
                Enter the following words from the seed phrase you just saved,
                to confirm you wrote it down correctly.
              </Text>

              {verifyPrompts.map((p) => (
                <View key={p.index}>
                  <Text style={styles.label}>Word #{p.index}</Text>
                  <TextInput
                    style={styles.input}
                    value={p.answer}
                    onChangeText={(t) => setPromptAnswer(p.index, t)}
                    placeholder={`Word ${p.index}`}
                    placeholderTextColor={colors.faint}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                </View>
              ))}

              {verifyError ? (
                <Text style={styles.error}>{verifyError}</Text>
              ) : null}

              <TouchableOpacity style={styles.primaryBtn} onPress={checkVerify}>
                <Text style={styles.primaryBtnText}>Confirm</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.linkBtn}
                onPress={() => {
                  setVerifyError(null);
                  setStep('reveal');
                }}>
                <Text style={styles.linkBtnText}>Back to phrase</Text>
              </TouchableOpacity>
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
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
  networkTag: {
    alignSelf: 'flex-start',
    marginTop: 6,
    marginBottom: 8,
    fontSize: 11,
    fontWeight: '700',
    color: PRIMARY,
    backgroundColor: 'rgba(249,115,22,0.12)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    overflow: 'hidden',
  },
  segment: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceAlt,
    borderRadius: 10,
    padding: 3,
    marginTop: 14,
  },
  segBtn: { flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: 'center' },
  segBtnOn: { backgroundColor: colors.surface },
  segText: { fontSize: 14, fontWeight: '600', color: colors.muted },
  segTextOn: { color: PRIMARY },
  mnemonicInput: { minHeight: 76, textAlignVertical: 'top' },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.label,
    marginTop: 14,
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
  hint: { fontSize: 12, color: colors.faint, marginTop: 6 },
  advancedToggle: { marginTop: 16 },
  advancedText: { color: PRIMARY, fontSize: 13, fontWeight: '600' },
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

  warn: {
    fontSize: 13,
    color: colors.danger,
    marginTop: 10,
    marginBottom: 16,
    lineHeight: 19,
  },
  wordGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  wordChip: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '48%',
    backgroundColor: colors.bg,
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    marginBottom: 8,
  },
  wordIndex: {
    fontSize: 11,
    color: colors.faint,
    width: 20,
    fontVariant: ['tabular-nums'],
  },
  wordText: { fontSize: 15, fontWeight: '600', color: colors.text },
  copyBtn: {
    borderWidth: 1,
    borderColor: PRIMARY,
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
    marginTop: 6,
  },
  copyBtnText: { color: PRIMARY, fontSize: 14, fontWeight: '600' },
  passphraseReveal: {
    marginTop: 16,
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
  },
  passphraseValue: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.text,
    fontFamily: 'monospace',
    marginTop: 2,
  },
  checkRow: { flexDirection: 'row', alignItems: 'center', marginTop: 20 },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: PRIMARY,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  checkboxOn: { backgroundColor: PRIMARY },
  checkMark: { color: colors.onPrimary, fontSize: 14, fontWeight: 'bold' },
  checkLabel: { flex: 1, fontSize: 14, color: colors.strong },
});
