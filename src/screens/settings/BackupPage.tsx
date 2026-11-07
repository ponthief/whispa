import React, { useCallback, useState } from 'react';
import { NativeModules, Platform } from 'react-native';
import { useAuthStore } from '@stores/authStore';
import * as api from '@services/api';
import type { BackupFileInfo } from '@services/backup';
import {
  backupFilename,
  decryptBackup,
  encryptBackup,
  inspectBackupFile,
  validateBackupPassword,
} from '@services/backup';
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
  // THE FILE COMES FIRST ON A RESTORE (2026-11-08, on the user's instruction:
  // "when restoring user selects the file and if the file is encrypted it
  // should ask for a password"). A chosen file waits here while its password
  // is typed. Until the picker has run there is nothing to ask about, and the
  // screen cannot know which secret that particular file wants.
  const [pending, setPending] = useState<null | { text: string; info: BackupFileInfo }>(null);
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
    // ONE FIELD, NO CONFIRMATION (2026-11-08: "drop confirm password field,
    // one field is sufficient"). What that gives up is the only check a
    // password has: a typo here seals a file nobody can open and nothing finds
    // out until a restore. What stands in its place is that the field is not
    // masked, so what was typed can be read back before pressing this.
    const bad = validateBackupPassword(password);
    if (bad) {
      say(bad, true);
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
  }, [password, walletRefs]);

  // THE PICKER OPENS STRAIGHT AWAY. Nothing is asked for first: until a file
  // has been chosen there is nothing to ask about.
  const onPickFile = useCallback(async () => {
    setBusy('restore');
    say(null);
    try {
      const text = await native().open();
      // A cancelled picker resolves rather than rejecting — backing out is
      // not an error and must not read as one.
      if (!text) {
        say('Cancelled.');
        return;
      }
      const info = inspectBackupFile(text);
      // A file this build cannot read is refused HERE, before any password is
      // asked for: making somebody type a secret for a file that was never
      // going to open is the question before the answer all over again.
      if (!info.readable) {
        say(info.problem, true);
        return;
      }
      setPending({ text, info });
      // CHOOSING A FILE ALWAYS ASKS, and the field is cleared to make sure of
      // it. Opening with whatever happened to be typed already is the bug
      // that was reported in the first place — "I was able to restore from
      // file w/o being prompted for password" — and it would be back the
      // moment a save and a restore shared a field across one session. The
      // password that seals a new backup is not evidence about an old file.
      //
      // What to ask for comes from the FILE's own header, so a backup written
      // between 2026-11-04 and 2026-11-08 asks for the recovery phrase by
      // name rather than failing to open and leaving the user guessing.
      setPassword('');
      say(
        info.encrypted
          ? `This backup is encrypted. Enter its ${info.asksFor} and press Open.`
          : 'Press Open to restore this backup.',
      );
    } catch (e: any) {
      say(e?.message || 'Could not read that file.', true);
    } finally {
      setBusy(null);
    }
  }, []);

  // Opening the file already in hand. Separate from the picker, so a password
  // typed after the fact does not send the user back through it.
  const onRestore = useCallback(async () => {
    if (!pending) return;
    // No length rule on this path: that is enforced on write, and refusing an
    // older file for failing today's policy would strand it. An older file may
    // be sealed with a recovery phrase or a wallet passphrase, which
    // decryptBackup reads from the header and treats correctly.
    if (!password && pending.info.encrypted) {
      say(`Enter the ${pending.info.asksFor} for this file.`, true);
      return;
    }
    setBusy('restore');
    say(null);
    try {
      const text = pending.text;
      say('Opening… 0%');
      const payload = await decryptBackup(text, password, (f) =>
        say(`Opening… ${Math.round(f * 100)}%`));
      // The live wallets decide where a backed-up wallet's labels go: an id
      // from the file may belong to a wallet that has since been deleted and
      // added back, which gives it a new one.
      const live = await walletRefs().catch(() => []);
      const { skipped } = await applyBackup(payload as any, live);
      // ONE WORD, and the web modal says the same (2026-11-08: "do not say
      // Nothing new, Restored is fine"). The file IS restored whether or not
      // anything changed — a merge that added nothing still means every label
      // in it is now here, which is what the user came to find out. A section
      // this client cannot store is still named rather than counted as
      // restored.
      say(
        ['Restored.', skipped.length ? `${skipped.join(', ')} left in the file.` : '']
          .filter(Boolean)
          .join(' '),
      );
      // Done with. A FAILURE keeps it, so a wrong password is retyped against
      // the file already in hand rather than going back through the picker.
      setPending(null);
      // AND THE PASSWORD GOES WITH IT, reported on the web as "after
      // restoring, I clicked save backup w/o password and pop up
      // disappeared": the field still held what had been typed to OPEN the
      // file, so Save sealed a new backup with it, having asked nothing.
      setPassword('');
    } catch (e: any) {
      say(e?.message || 'Could not read that backup.', true);
    } finally {
      setBusy(null);
    }
  }, [password, pending, walletRefs]);

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
          {/* ONE FIELD. The confirmation box went on 2026-11-08 ("drop
              confirm password field, one field is sufficient"). It was the
              checksum a password does not have; what is left in its place is
              that this field is not masked, so what was typed can be read
              back before pressing Save. */}
          <Block first>
            <LineInput
              value={password}
              onChangeText={setPassword}
              placeholder={pending ? pending.info.asksFor : 'Backup password'}
            />
            <Help>
              {pending
                ? `The ${pending.info.asksFor} this file was saved with.`
                : 'At least 8 characters. Used only for this file, and never ' +
                  'written into it.'}
            </Help>
          </Block>
          {/* A FILE IS CHOSEN FIRST AND THE PASSWORD ASKED FOR SECOND, so
              once one is waiting the screen is about that file and nothing
              else: offering Save beside it would seal a NEW backup under the
              password being typed to open an old one. */}
          {pending ? (
            <>
              <Block>
                <Button
                  label={busy === 'restore' ? 'Working…' : 'Open backup'}
                  kind="primary"
                  onPress={onRestore}
                  busy={busy === 'restore'}
                  disabled={!!busy}
                />
              </Block>
              <Block>
                <Button
                  label="Cancel"
                  kind="secondary"
                  onPress={() => {
                    setPending(null);
                    say(null);
                  }}
                  disabled={!!busy}
                />
              </Block>
            </>
          ) : (
            <>
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
                  onPress={onPickFile}
                  busy={busy === 'restore'}
                  disabled={!!busy}
                />
              </Block>
            </>
          )}
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
