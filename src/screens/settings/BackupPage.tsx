import React, { useCallback, useState } from 'react';
import { NativeModules, Platform } from 'react-native';
import { useAuthStore } from '@stores/authStore';
import * as api from '@services/api';
import { backupFilename, decryptBackup, encryptBackup } from '@services/backup';
import { applyBackup, collectBackup, countItems } from '@services/backupData';
import { Block, Button, Group, Help, Note, Page, TextArea } from './ui';

// The backup screen.
//
// WHAT IT IS FOR, and the copy says so in one line: a phone that is lost,
// stolen or reinstalled. Those three take the device-only data with them —
// labels and pinned contacts — and nothing can rebuild it. The coins are not
// at risk in any of them: they are on the chain and come back from the
// recovery phrase.
//
// THE FILE IS SEALED WITH THE RECOVERY PHRASE and carries no key material at
// all (2026-11-04, on the user's instruction). The BIP-39 passphrase is not
// mentioned on this screen: it belongs to importing a wallet, which is a
// different screen and a different job. What this screen must land instead is
// that losing the phrase loses everything, which is why that note is the red
// one.
//
// The phrase is checked for being a phrase — BIP-39's own checksum, in
// services/backup.ts — before anything is encrypted, so a mistyped one cannot
// produce a file nobody can ever open.

type Native = {
  save(filename: string, text: string): Promise<string | null>;
  open(): Promise<string | null>;
};

// Asked of NativeModules rather than of Platform alone, for the reason push.ts
// gives about its own module: the question is "is the native side here", and a
// build flag can disagree with the APK while this cannot.
export function backupFileAvailable(): boolean {
  return Platform.OS === 'android' && !!NativeModules.BackupFile;
}

function native(): Native {
  const m = NativeModules.BackupFile as Native | undefined;
  if (!m) throw new Error('backup-file-unavailable');
  return m;
}

export default function BackupPage({ onBack }: { onBack: () => void }) {
  const [phrase, setPhrase] = useState('');
  const inkey = useAuthStore((s) => s.inkey);
  const [busy, setBusy] = useState<null | 'export' | 'restore'>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState(false);

  const say = (m: string | null, isErr = false) => {
    setMsg(m);
    setErr(isErr);
  };

  // The account's wallets, as references. Needed on both paths: on export to
  // record what the labels belong to, on restore to find where they go now.
  const walletRefs = useCallback(async () => {
    const list = inkey ? await api.getSilntWallets(inkey) : [];
    return (list || []).map((w: any) => ({
      id: w.id,
      title: w.title || 'Wallet',
      network: w.network,
      spAddress: w.sp_address || '',
    }));
  }, [inkey]);

  const onExport = useCallback(async () => {
    setBusy('export');
    say(null);
    try {
      const payload = await collectBackup(
        Platform.OS === 'ios' ? 'ios' : 'android',
        await walletRefs(),
      );
      const total = countItems(payload);
      if (!total) {
        say('Nothing to back up yet — no labels on this phone.', true);
        return;
      }
      // The KDF runs for seconds on a phone. It yields every 20ms and reports
      // progress, so the screen counts up instead of freezing — the first
      // version blocked the JS thread and read as a hang, with the native
      // spinner still turning because only JavaScript had stopped.
      say('Encrypting… 0%');
      const text = await encryptBackup(payload, phrase, (f) =>
        say(`Encrypting… ${Math.round(f * 100)}%`));
      const where = await native().save(backupFilename(), text);
      // null is the user backing out of the system picker, which is not a
      // failure and must not be reported as one.
      say(
        where
          ? `Saved ${total} label${total === 1 ? '' : 's'}. Open it again with the ` +
            'same recovery phrase.'
          : 'Cancelled.',
      );
    } catch (e: any) {
      say(e?.message || 'Could not write the backup.', true);
    } finally {
      setBusy(null);
    }
    // phrase and walletRefs BELONG here. Without them this closure keeps the
    // values from first render — an empty phrase for the life of the screen —
    // and would encrypt against a string the user never typed. lint caught the
    // same shape once already; it is what CLAUDE.md records about the network
    // check that passed for the exact case it existed to refuse.
  }, [phrase, walletRefs]);

  const onRestore = useCallback(async () => {
    setBusy('restore');
    say(null);
    try {
      const text = await native().open();
      if (!text) {
        say('Cancelled.');
        return;
      }
      say('Opening… 0%');
      const payload = await decryptBackup(text, phrase, (f) =>
        say(`Opening… ${Math.round(f * 100)}%`));
      const total = countItems(payload as any);
      // The live wallets decide where a backed-up wallet's labels go: an id
      // from the file may belong to a wallet that has since been deleted and
      // added back, which gives it a new one.
      const live = await walletRefs().catch(() => []);
      const { sections, skipped, remapped } = await applyBackup(payload as any, live);
      const added = Object.values(sections).reduce((n, r) => n + r.added, 0);
      const kept = Object.values(sections).reduce((n, r) => n + r.kept, 0);
      // Reports what actually changed. "Restored" over a file whose every entry
      // was already here reads as though something happened.
      say(
        [
          added
            ? `Restored ${added} of ${total} label${total === 1 ? '' : 's'}.`
            : `Nothing to add — everything in that file was already on this phone.`,
          kept ? `${kept} were already here and were left alone.` : '',
          remapped
            ? `${remapped} wallet${remapped === 1 ? '' : 's'} had been removed and ` +
              'added back; their labels were re-matched.'
            : '',
          // Said rather than counted as restored. A backup from the web app
          // carries sections this phone has nothing to put them in.
          skipped.length
            ? `This phone does not use ${skipped.join(', ')}, so ${
                skipped.length === 1 ? 'that was' : 'those were'
              } left in the file.`
            : '',
        ]
          .filter(Boolean)
          .join(' '),
      );
    } catch (e: any) {
      say(e?.message || 'Could not read that backup.', true);
    } finally {
      setBusy(null);
    }
  }, [phrase, walletRefs]);

  return (
    <Page title="Backup" onBack={onBack}>
      <Group title="What this saves">
        <Block first>
          <Help>
            Use this if your phone is lost or stolen, or if you reinstall the
            app. It saves what only this phone knows: your transaction labels,
            SegWit address labels and pinned contacts.
          </Help>
        </Block>
        <Block>
          <Help>
            Your coins are not in this file and do not need to be. They live on
            the Bitcoin network, and your wallet finds them again from your
            recovery phrase.
          </Help>
        </Block>
        {/* The red one. The file is sealed with the phrase and holds nothing
            else, so the phrase is the single point of failure for both the
            backup and the wallet — and it is the one thing this app cannot
            ever recover for anybody. */}
        <Block>
          <Note kind="error">
            Keep your recovery phrase somewhere safe. It opens this backup and
            it is the only way to restore your wallet. If you lose it, no one —
            including us — can get your wallet or this file back.
          </Note>
        </Block>
      </Group>

      {backupFileAvailable() ? (
        <Group title="Backup file">
          <Block first>
            <TextArea
              value={phrase}
              onChangeText={setPhrase}
              placeholder="Your recovery phrase"
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
            />
            <Help>
              Your backup is encrypted with your recovery phrase. It is never
              written into the file.
            </Help>
          </Block>
          <Block>
            <Button
              label={busy === 'export' ? 'Working…' : 'Save a backup'}
              kind="primary"
              onPress={onExport}
              busy={busy === 'export'}
              disabled={!!busy || !phrase.trim()}
            />
          </Block>
          <Block>
            <Button
              label={busy === 'restore' ? 'Working…' : 'Restore from a file'}
              kind="secondary"
              onPress={onRestore}
              busy={busy === 'restore'}
              disabled={!!busy || !phrase.trim()}
            />
          </Block>
          {msg ? (
            <Block>
              <Note kind={err ? 'error' : 'info'}>{msg}</Note>
            </Block>
          ) : null}
        </Group>
      ) : (
        <Group title="Backup file">
          <Block first>
            <Note kind="info">
              Saving a backup needs a newer build of the app than this one.
            </Note>
          </Block>
        </Group>
      )}
    </Page>
  );
}
