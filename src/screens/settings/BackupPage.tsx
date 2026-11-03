import React, { useCallback, useState } from 'react';
import { NativeModules, Platform } from 'react-native';
import { useAuthStore } from '@stores/authStore';
import * as api from '@services/api';
import { deriveSilentPayment } from '@services/spKeys';
import {
  backupFilename,
  decryptBackup,
  encryptBackup,
  verifySeedPassphrase,
} from '@services/backup';
import { applyBackup, collectBackup, countItems, seededWalletCount } from '@services/backupData';
import { Block, Button, Field, Group, Help, Note, Page } from './ui';

// A backup of this wallet and what this phone knows about it.
//
// IT CARRIES THE RECOVERY PHRASE, and not the BIP-39 passphrase. That is the
// keystore's own line: the phrase is already on this device (seedVault), the
// passphrase deliberately is not, and a backup drawn on the same line is worth
// no more to a thief than the phone. Restoring takes the file, the file's
// password, AND the passphrase out of the owner's head.
//
// The passphrase prompt here is a READINESS CHECK, not storage. Nothing writes
// it anywhere. It derives each wallet's address from phrase + passphrase and
// compares, so somebody who has forgotten it finds out now rather than years
// later with the phone gone — a mistyped passphrase otherwise derives a
// perfectly valid, completely different, empty wallet, silently.

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
  const [passphrase, setPassphrase] = useState('');
  const inkey = useAuthStore((s) => s.inkey);
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
      const list = inkey ? await api.getSilntWallets(inkey) : [];
      const wallets = (list || []).map((w: any) => ({
        id: w.id,
        title: w.title || 'Wallet',
        network: w.network,
        spAddress: w.sp_address || '',
      }));
      const payload = await collectBackup(
        Platform.OS === 'ios' ? 'ios' : 'android',
        wallets,
      );
      const seeded = seededWalletCount(payload);
      const total = countItems(payload);
      if (!total && !seeded) {
        say('Nothing to back up yet — no wallet keys or labels on this phone.', true);
        return;
      }

      // BEFORE ENCRYPTING ANYTHING. A backup written against a passphrase its
      // owner cannot reproduce is a file that looks like insurance and is not.
      if (seeded) {
        const checks = verifySeedPassphrase(
          (payload.wallets || [])
            .filter((w) => !!w.mnemonic)
            .map((w) => ({
              walletId: w.id,
              title: w.title,
              spAddress: w.spAddress,
              mnemonic: w.mnemonic as string,
              network: w.network,
            })),
          passphrase,
          deriveSilentPayment,
        );
        const bad = checks.filter((c) => !c.ok);
        if (bad.length) {
          // Named, because with more than one wallet the answer "which one"
          // is the difference between a typo and a different passphrase.
          say(
            `That passphrase does not match ${bad.map((b) => b.title).join(', ')}. ` +
              'A backup you cannot restore is not a backup, so nothing was written.',
            true,
          );
          return;
        }
      }
      // The KDF runs for seconds on a phone. It yields every 20ms and reports
      // progress, so the screen counts up instead of freezing — the first
      // version blocked the JS thread and read as a hang, with the native
      // spinner still turning because only JavaScript had stopped.
      say('Encrypting… 0%');
      const text = await encryptBackup(payload, password, (f) =>
        say(`Encrypting… ${Math.round(f * 100)}%`));
      const where = await native().save(backupFilename(), text);
      // null is the user backing out of the system picker, which is not a
      // failure and must not be reported as one.
      say(
        where
          ? `Saved ${seeded} wallet${seeded === 1 ? '' : 's'} and ${total} label${total === 1 ? '' : 's'}. ` +
            'You will need this file, its password, and your wallet passphrase to restore.'
          : 'Cancelled.',
      );
    } catch (e: any) {
      say(e?.message || 'Could not write the backup.', true);
    } finally {
      setBusy(null);
    }
    // inkey and passphrase BELONG here. Without them this closure keeps the
    // values from first render — an empty passphrase for the life of the
    // screen — and the readiness check would validate a string the user never
    // typed. lint caught it; it is the same stale-closure shape CLAUDE.md
    // records from the network check that passed for the case it existed to
    // refuse.
  }, [password, passphrase, inkey]);

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
      const payload = await decryptBackup(text, password, (f) =>
        say(`Opening… ${Math.round(f * 100)}%`));
      const total = countItems(payload as any);
      const report = await applyBackup(payload as any);
      const added = Object.values(report).reduce((n, r) => n + r.added, 0);
      const kept = Object.values(report).reduce((n, r) => n + r.kept, 0);
      const seeds = report.recoveryPhrases?.added || 0;
      // Reports what actually changed. "Restored" over a file whose every entry
      // was already here reads as though something happened.
      say(
        added
          ? (seeds ? `Restored ${seeds} recovery phrase${seeds === 1 ? '' : 's'}. ` : '') +
            `Restored ${added - seeds} of ${total} label${total === 1 ? '' : 's'}.` +
            (kept ? ` ${kept} were already here and were left alone.` : '')
          : `Nothing to add — everything in that file was already on this phone.`,
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
            Your recovery phrase, plus your transaction and SegWit address
            labels. A reinstall loses the labels and nothing can rebuild them.
          </Help>
        </Block>
        {/* The honest shape of the file, said where the decision is made.
            Somebody who thinks this file alone is their wallet will store it
            carelessly; somebody who thinks it is useless will not keep it. */}
        <Block>
          <Note kind="info">
            This file holds your recovery phrase but NOT your passphrase.
            Restoring takes three things: this file, its password, and your
            wallet passphrase from memory. Keep the file somewhere you would be
            comfortable keeping a spare key — and keep its password somewhere
            else.
          </Note>
        </Block>
        {/* Writing the phrase down stays the real backup. A file depends on a
            device, a service and a password; twelve words on paper do not. */}
        <Block>
          <Note kind="info">
            This does not replace writing your recovery phrase down. A file can
            be lost with the account it sits in.
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
          {/* Asked for, never stored. It is checked against each wallet's known
              address so a forgotten passphrase surfaces here rather than during
              a restore that silently builds a different, empty wallet. */}
          <Block>
            <Field
              value={passphrase}
              onChangeText={setPassphrase}
              placeholder="Your wallet passphrase"
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              action="Check"
              onAction={onExport}
              actionBusy={busy === 'export'}
              actionDisabled={!!busy || !password}
            />
            <Help>
              Checked against your wallet, never saved to the file. If it does
              not match, nothing is written.
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
