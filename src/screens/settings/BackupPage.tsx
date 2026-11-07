import React, { useCallback, useState } from 'react';
import { NativeModules, Platform } from 'react-native';
import { useAuthStore } from '@stores/authStore';
import * as api from '@services/api';
import { backupFilename, decryptBackup, encryptBackup } from '@services/backup';
import { applyBackup, collectBackup, countItems } from '@services/backupData';
import { Block, Button, Group, Help, LineInput, Note, Page } from './ui';

// The backup screen.
//
// WHAT IT IS FOR, and the copy says so in one line: a phone that is lost,
// stolen or reinstalled. Those three take the device-only data with them —
// labels and pinned contacts — and nothing can rebuild it. The coins are not
// at risk in any of them: they are on the chain and come back from the
// recovery phrase.
//
// THE FILE IS SEALED WITH A PASSWORD THE USER CHOOSES and carries no key
// material at all (2026-11-08, on the user's instruction). It asked for the
// recovery phrase until then, which was out of proportion: a backup of labels
// does not justify typing the one secret that cannot be reissued, and every
// extra screen those twelve words appear on is another place they can be seen
// or phished. The BIP-39 passphrase is not mentioned here either — it belongs
// to importing a wallet, which is a different screen and a different job.
//
// ASKED FOR TWICE on export. A phrase was checked against BIP-39's own
// checksum before anything was encrypted; a password has no checksum, so a
// mistyped one seals a file nobody can ever open and nothing finds out until
// a restore. The confirm field is what replaces that check — not politeness.
//
// Restore asks once and does not apply the length rule: an older file may be
// sealed with a recovery phrase or a wallet passphrase, decryptBackup reads
// the header and treats each correctly, and refusing one for failing today's
// policy would strand it.

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
  const [confirm, setConfirm] = useState('');
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
    // THE BUTTONS ARE LIVE WHATEVER THE FIELDS HOLD, so every requirement is
    // stated here rather than by greying something out. Reported on the web as
    // "you dropped Restore!! I've backed up and now I can't restore" — the
    // button was there and disabled, which a dead control with no explanation
    // is indistinguishable from. Same shape here, so the same fix.
    if (!password) {
      say('Enter a password first — it is what will open the file.', true);
      return;
    }
    // A mismatch must never reach encryptBackup, which cannot tell a confirmed
    // password from a typo and would seal a file nobody can open.
    if (password !== confirm) {
      say('Type the same password in both boxes to save.', true);
      return;
    }
    setBusy('export');
    say(null);
    try {
      const payload = await collectBackup(
        Platform.OS === 'ios' ? 'ios' : 'android',
        await walletRefs(),
      );
      const total = countItems(payload);
      if (!total) {
        say('Nothing to back up yet.', true);
        return;
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
      say(where ? 'Saved.' : 'Cancelled.');
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
  }, [password, confirm, walletRefs]);

  const onRestore = useCallback(async () => {
    // Say what is missing rather than opening a system picker whose result is
    // going to be refused. No confirm on this path and no length rule: an
    // older file may be sealed with a recovery phrase or a wallet passphrase,
    // and refusing it for failing today's policy would strand it.
    if (!password) {
      say('Enter the password you used when you saved the backup, then press ' +
        'this again.', true);
      return;
    }
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
      // The live wallets decide where a backed-up wallet's labels go: an id
      // from the file may belong to a wallet that has since been deleted and
      // added back, which gives it a new one.
      const live = await walletRefs().catch(() => []);
      const { sections, skipped } = await applyBackup(payload as any, live);
      const added = Object.values(sections).reduce((n, r) => n + r.added, 0);
      // SAYS WHETHER IT RESTORED, AND STOPS (2026-11-08, on the user's
      // instruction: "restore text is too long and meaningless, just say
      // whether restored or not"), and the web modal says the same two
      // things. The old line reported added, kept, re-matched wallets and
      // leftovers at once — every number true, none of them the question.
      // The two outcomes stay apart because they are different answers, and
      // a section this client cannot store is still named rather than
      // counted as restored.
      say(
        [
          added ? 'Restored.' : 'Nothing new — it was all already here.',
          skipped.length ? `${skipped.join(', ')} left in the file.` : '',
        ]
          .filter(Boolean)
          .join(' '),
      );
    } catch (e: any) {
      say(e?.message || 'Could not read that backup.', true);
    } finally {
      setBusy(null);
    }
  }, [password, walletRefs]);

  return (
    <Page title="Backup & Restore" onBack={onBack}>
      <Group title="What this saves">
        {/* ONE LINE, and the same one the web modal uses (2026-11-08, on the
            user's instruction: "text must be really simple: backup labels,
            contacts"). "What only this phone knows" went with it — the two
            screens were each naming their own device, which is a distinction
            the reader does not need and which the web could not state without
            saying "browser". What it saves is what it saves. */}
        <Block first>
          <Help>Backs up your labels and contacts.</Help>
        </Block>
        {/* The "your coins are not in this file, they live on the Bitcoin
            network and come back from your recovery phrase" paragraph was
            here until 2026-11-08. It went from the web on the user's
            instruction, and from here as a consequence rather than by
            request: it is the only line left that names the recovery phrase,
            and leaving it would undo the point of no longer asking for one.
            What it was defending against — somebody reading this as a wallet
            backup — the first line already handles by saying what IS saved. */}
        {/* The red one, and it is about the PASSWORD now. The file holds
            labels and is sealed with a password that exists nowhere else, so
            that password is the single point of failure for this file — and
            unlike the recovery phrase it protects nothing that spends. */}
        <Block>
          <Note kind="error">
            Remember this password. It is the only thing that opens the file,
            it is not stored anywhere, and no one — including us — can recover
            it or the file's contents without it.
          </Note>
        </Block>
      </Group>

      {backupFileAvailable() ? (
        <Group title="Backup file">
          {/* NOT MASKED (2026-11-08, on the user's instruction, and the web
              modal matches). A per-file password with no checksum, typed once
              — seeing it is the only way to tell you are typing what you typed
              before, and a masked field is how "I can't restore" happens when
              the file is fine and the typing was not. */}
          <Block first>
            <LineInput
              value={password}
              onChangeText={setPassword}
              placeholder="Backup password"
            />
            <Help>
              At least 8 characters. Used only for this file, and never written
              into it.
            </Help>
          </Block>
          {/* The confirm field is the checksum a password does not have.
              Export only: a restore proves the password by opening the file,
              and an older file may be sealed with something else entirely. So
              it appears only once there is something to confirm. */}
          {password ? (
            <Block>
              <LineInput
                value={confirm}
                onChangeText={setConfirm}
                placeholder="Confirm password (only to save)"
              />
              {confirm && password !== confirm ? (
                <Note kind="error">The two passwords do not match.</Note>
              ) : null}
            </Block>
          ) : null}
          <Block>
            <Button
              label={busy === 'export' ? 'Working…' : 'Save a backup'}
              kind="primary"
              onPress={onExport}
              busy={busy === 'export'}
              disabled={!!busy}
            />
          </Block>
          <Block>
            <Button
              label={busy === 'restore' ? 'Working…' : 'Restore from a file'}
              kind="secondary"
              onPress={onRestore}
              busy={busy === 'restore'}
              disabled={!!busy}
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
