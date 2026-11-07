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
  remapWalletIds,
  validateBackupPassword,
} from '@services/backup';
import { applyBackup, collectBackup, countItems } from '@services/backupData';
import { collectWalletSeeds, restoreWallets } from '@services/walletBackup';
import { hasSeed, readSeed, saveSeed } from '@services/seedVault';
import { hasWalletKeys, storeWalletKeys } from '@services/secureKeys';
import { deriveSilentPayment } from '@services/spKeys';
import { resetCatchUp } from '../../hooks/useCatchUpScan';
import { applyServerLabels, collectServerLabels } from '@services/serverLabels';
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
      // The BIRTH height, so a restored wallet rescans from where it began.
      // See walletBackup.BackupWalletRef for why the resume point is the wrong
      // number to carry.
      lastHeight: typeof w.last_height === 'number' ? w.last_height : undefined,
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
      const refs = await walletRefs();
      // THE PASSPHRASE IS CHECKED AGAINST EACH WALLET before a single phrase
      // is written ("if wrong passphrase entered the wallet doesn't get backed
      // up"). A wallet it does not open is left out and named below, rather
      // than sealed under a secret that cannot open it — which would make a
      // file that looks perfectly fine and restores nothing.
      const { seeds, leftOut } = await collectWalletSeeds(
        { readSeed, deriveSilentPayment }, password, refs);
      const withSeeds = refs.map((w) =>
        seeds[w.id] ? { ...w, mnemonic: seeds[w.id] } : w);
      if (!Object.keys(seeds).length && refs.length) {
        say(
          'That passphrase does not open any of your wallets, so none would ' +
            'be in the file. Check it and try again.',
          true,
        );
        return;
      }
      // The SERVER-side coin labels too (2026-11-08). silnt.utxos.label is
      // where an SP coin's label lives, and it was not in the file, so a
      // restore brought back a SegWit label and not an SP one.
      const payload = await collectBackup(
        Platform.OS === 'ios' ? 'ios' : 'android',
        withSeeds,
        inkey ? await collectServerLabels(api as any, inkey, refs) : {},
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
      const missed = leftOut.length
        ? ` ${leftOut.length} wallet${leftOut.length === 1 ? '' : 's'} left out: ` +
          leftOut
            .map((w) =>
              `${w.title} (${w.reason === 'passphrase'
                ? 'different passphrase'
                : 'no recovery phrase saved here'})`)
            .join(', ') + '.'
        : '';
      // null is the user backing out of the system picker, which is not a
      // failure and must not be reported as one.
      say(where ? `Saved.${missed}` : 'Cancelled.', !!(where && missed));
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
  }, [inkey, password, walletRefs]);

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
      let live = await walletRefs().catch(() => []);

      // WALLETS FIRST, LABELS SECOND, and the order is the whole point: a
      // label is filed against a wallet id, so recreating the wallets before
      // applying them means the labels land on the wallets this restore just
      // made rather than being remapped to nothing. `live` is re-read after,
      // so the remap sees the new ids.
      //
      // This is the use case the feature exists for (2026-11-08): "user
      // loses, replaces the phone, reinstalls the app... he can just restore
      // from the backup instead of importing wallet or entering wallet
      // recovery keys."
      let walletReport = null as Awaited<ReturnType<typeof restoreWallets>> | null;
      const fileWallets = ((payload as any).wallets || []) as any[];
      if (inkey && fileWallets.length) {
        walletReport = await restoreWallets(
          {
            deriveSilentPayment,
            createWallet: (data) => api.createSilntWallet(inkey, data) as any,
            storeWalletKeys,
            saveSeed,
            // What this device already has, asked per wallet. Without these a
            // reinstall adopts nothing: the wallets are all on the account
            // and the keys are all missing, which is exactly "restore on
            // mobile didn't work, it still said wallet keys need recovery".
            hasKeys: hasWalletKeys,
            hasSeed,
            onCreated: resetCatchUp,
          },
          password,
          fileWallets,
          live,
        );
        if (walletReport.created.length) {
          live = await walletRefs().catch(() => live);
        }
      }

      const { skipped } = await applyBackup(payload as any, live);
      // The server-side half, over the network and therefore after the local
      // one: a failure here must not cost the labels already written.
      const srv = inkey
        ? await applyServerLabels(
            api as any, inkey, (payload as any).sections || {},
            remapWalletIds((payload as any).wallets, live), live)
        : {};
      // Named apart from the `pending` FILE above — this one counts labels.
      const pendingLabels =
        (srv.coinLabels?.pending || 0) + (srv.addressLabels?.pending || 0);
      // ONE WORD, and the web modal says the same (2026-11-08: "do not say
      // Nothing new, Restored is fine"). The file IS restored whether or not
      // anything changed — a merge that added nothing still means every label
      // in it is now here, which is what the user came to find out. A section
      // this client cannot store is still named rather than counted as
      // restored.
      const madeWallets = walletReport?.created.length || 0;
      const gotKeys = walletReport?.adopted.length || 0;
      const walletTrouble = [
        ...(walletReport?.mismatched || []).map(
          (w) => `${w.title} (its phrase and this passphrase do not match it)`),
        ...(walletReport?.failed || []).map((w) => `${w.title} (${w.message})`),
      ];
      say(
        [
          'Restored.',
          // Named before the labels, because a wallet coming back is the
          // headline and a label is not. The scan is said in the same breath:
          // a restored wallet has no coins until one runs, and somebody
          // looking at a zero balance needs to know that now rather than
          // concluding their money is gone.
          madeWallets
            ? `${madeWallets} wallet${madeWallets === 1 ? '' : 's'} restored — ` +
              'scan to find their coins.'
            : '',
          // The reinstall case, and the common one: the wallets were still on
          // the account and only their keys were missing here.
          gotKeys
            ? `${gotKeys} wallet${gotKeys === 1 ? '' : 's'} got their keys back — ` +
              'scan to find their coins.'
            : '',
          walletTrouble.length
            ? `Not restored: ${walletTrouble.join(', ')}.`
            : '',
          // A label whose coin is not here yet. The coins come back from the
          // chain, so this is the normal state between adding a wallet back
          // and finishing a rescan.
          pendingLabels
            ? `${pendingLabels} label${pendingLabels === 1 ? '' : 's'} need their ` +
              'coins scanned first — scan, then restore again.'
            : '',
          skipped.length ? `${skipped.join(', ')} left in the file.` : '',
        ]
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
  }, [inkey, password, pending, walletRefs]);

  return (
    <Page title="Backup & Restore" onBack={onBack}>
      <Group title="What this saves">
        {/* ONE LINE, and the same one the web modal uses. "What only this
            phone knows" went first — the two screens were each naming their
            own device, which the reader does not need and which the web could
            not state without saying "browser".

            AND "CONTACTS" WENT ON 2026-11-08. The file has never held one: a
            Tango connection is a row in silnt.payjoin_contacts naming BOTH
            user ids, it lives on the server, and it cannot be re-created from
            one side — the other has to accept. A backup could not bring back
            a connection somebody removed even if it tried, and the word
            promised exactly that. What it was reaching for was the web's
            BitMail pins, which are tamper evidence rather than an address
            book, and which this client does not store at all. */}
        <Block first>
          <Help>Backs up your wallets and labels.</Help>
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
        {/* THE RED ONE SAYS WHAT THE FILE IS, which changed on 2026-11-08
            when it started carrying recovery phrases. Anyone holding the file
            and the passphrase can spend the coins — that is the cost of being
            able to restore a wallet without typing twelve words, and it is
            not something to leave anybody to work out. */}
        <Block>
          <Note kind="error">
            Keep this file private. It holds your wallets, so anyone with the
            file and your passphrase can spend your coins. Your passphrase is
            not in it and is not stored anywhere — without it no one,
            including us, can open the file.
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
              placeholder={pending ? pending.info.asksFor : 'Wallet passphrase'}
            />
            <Help>
              {pending
                ? `The ${pending.info.asksFor} this file was saved with.`
                : 'The passphrase your wallet was created with. A wallet it ' +
                  'does not open is left out of the file.'}
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
