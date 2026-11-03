import React, { useCallback, useState } from 'react';
import { NativeModules, Platform } from 'react-native';
import { backupFilename, decryptBackup, encryptBackup } from '@services/backup';
import { applyBackup, collectBackup, countItems } from '@services/backupData';
import { Block, Button, Field, Group, Help, Note, Page } from './ui';

// A backup of what this phone knows and the server does not.
//
// IT IS NOT A WALLET BACKUP, and the copy leads with that rather than letting
// anyone infer it. The file holds transaction labels, SegWit address labels and
// nothing else — no mnemonic, no keys, no passphrase. The coins come back from
// the recovery phrase and from nothing in this file. See services/backup.ts for
// why the file password is deliberately NOT the wallet's BIP-39 passphrase.

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
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<null | 'export' | 'restore'>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState(false);

  const say = (m: string | null, isErr = false) => {
    setMsg(m);
    setErr(isErr);
  };

  const onExport = useCallback(async () => {
    setBusy('export');
    say(null);
    try {
      const payload = await collectBackup(Platform.OS === 'ios' ? 'ios' : 'android');
      const total = countItems(payload);
      if (!total) {
        say('Nothing to back up yet — no labels on this phone.', true);
        return;
      }
      // Argon2id at 19 MiB takes a few seconds on a phone, on the JS thread.
      // Said before it happens, so the screen does not just sit there.
      say('Encrypting…');
      const text = encryptBackup(payload, password);
      const where = await native().save(backupFilename(), text);
      // null is the user backing out of the system picker, which is not a
      // failure and must not be reported as one.
      say(
        where
          ? `Saved ${total} item${total === 1 ? '' : 's'}. Keep the file and its password together.`
          : 'Cancelled.',
      );
    } catch (e: any) {
      say(e?.message || 'Could not write the backup.', true);
    } finally {
      setBusy(null);
    }
  }, [password]);

  const onRestore = useCallback(async () => {
    setBusy('restore');
    say(null);
    try {
      const text = await native().open();
      if (!text) {
        say('Cancelled.');
        return;
      }
      say('Opening…');
      const payload = decryptBackup(text, password);
      const total = countItems(payload as any);
      const report = await applyBackup(payload as any);
      const added = Object.values(report).reduce((n, r) => n + r.added, 0);
      const kept = Object.values(report).reduce((n, r) => n + r.kept, 0);
      // Reports what actually changed. "Restored" over a file whose every entry
      // was already here reads as though something happened.
      say(
        added
          ? `Restored ${added} of ${total} item${total === 1 ? '' : 's'}.` +
            (kept ? ` ${kept} were already here and were left alone.` : '')
          : `Nothing to add — all ${total} item${total === 1 ? '' : 's'} were already on this phone.`,
      );
    } catch (e: any) {
      say(e?.message || 'Could not read that backup.', true);
    } finally {
      setBusy(null);
    }
  }, [password]);

  return (
    <Page title="Backup" onBack={onBack}>
      <Group title="What this saves">
        <Block first>
          <Help>
            Your transaction labels and SegWit address labels — what this phone
            knows and the server does not. A reinstall loses all of it, and
            nothing can rebuild it.
          </Help>
        </Block>
        {/* Stated here, not discovered at the worst moment. Somebody who
            believes this file is their wallet will not write down the phrase. */}
        <Block>
          <Note kind="info">
            This is not a wallet backup. It holds no keys and no recovery phrase,
            so it cannot bring your coins back — your recovery phrase does that,
            and it is the only thing that can. Restoring needs the phrase and
            this file.
          </Note>
        </Block>
      </Group>

      {backupFileAvailable() ? (
        <Group title="Backup file">
          <Block first>
            <Field
              value={password}
              onChangeText={setPassword}
              placeholder="A password for the file"
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              action="Save"
              onAction={onExport}
              actionBusy={busy === 'export'}
              actionDisabled={!!busy || !password}
            />
            {/* Said where the choice is made, because the wrong choice here is
                the one that matters: a file encrypted with the wallet's
                passphrase would be an offline oracle for the one secret that
                is not on the device. */}
            <Help>
              Use a different password to your wallet's passphrase. Losing this
              one loses only the file — never your coins.
            </Help>
          </Block>
          <Block>
            <Button
              label={busy === 'restore' ? 'Working…' : 'Restore from a file'}
              kind="secondary"
              onPress={onRestore}
              busy={busy === 'restore'}
              disabled={!!busy || !password}
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
