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
import { deriveSilentPayment, spAddressFromKeys } from '@services/spKeys';
import { resetCatchUp } from '../../hooks/useCatchUpScan';
import { applyServerLabels, collectServerLabels } from '@services/serverLabels';
import { Block, Button, Group, Help, LineInput, Note, Page } from './ui';

// The backup screen.
//
// WHAT IT IS FOR, and the copy says so in one line: a phone that is lost,
// stolen or reinstalled. Those three take the device-only data with them —
// labels and pinned contacts — and nothing can rebuild it. The coins are not
// at risk in any of them: they are on the chain and come back from the
// seed phrase.
//
// THE FILE IS SEALED WITH A PASSWORD THE USER CHOOSES and carries no key
// material at all (2026-11-08, on the user's instruction). It asked for the
// seed phrase until then, which was out of proportion: a backup of labels
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
// sealed with a seed phrase or a wallet passphrase, decryptBackup reads
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

/**
 * Let React render what was just set before the thread is taken again.
 *
 * A `setState` followed by synchronous work never reaches the screen: the
 * update is queued and the JS thread goes straight into the next derivation,
 * so the message that was meant to explain the wait arrives after it. One
 * macrotask is enough, and it costs a frame.
 */
const paint = () => new Promise<void>((r) => setTimeout(r, 0));

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
                : 'no seed phrase saved here'})`)
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
      // between 2026-11-04 and 2026-11-08 asks for the seed phrase by
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
    // be sealed with a seed phrase or a wallet passphrase, which
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
            // Verifies the keys a WEB backup carries, where there is no
            // phrase to re-derive from.
            spAddressFromKeys,
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
            // THE SILENT STRETCH, reported 2026-11-09 as "nothing happens for
            // some time… and then suddenly it restores". Everything past the
            // KDF is a network call or a synchronous derivation, so the
            // screen stayed on the KDF's last message for the whole restore.
            onProgress: async (done, total, title) => {
              say(total > 1
                ? `Restoring ${title} (${done} of ${total})…`
                : `Restoring ${title}…`);
              await paint();
            },
          },
          password,
          fileWallets,
          live,
        );
        if (walletReport.created.length) {
          live = await walletRefs().catch(() => live);
        }
      }

      say('Restoring labels…');
      await paint();
      await applyBackup(payload as any, live);
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

      // EVERY WALLET IN THE FILE IS ACCOUNTED FOR, out loud.
      //
      // This is the third report of "restore didn't work, it still says
      // wallet keys need recovery", and the first two were real bugs in what
      // the restore DID. This one is about what it SAYS: `noPhrase` — a file
      // that carries wallet records with no seed phrase in them — was
      // counted and then never mentioned, so a backup saved by the web app,
      // or by a build from before phrases were carried, or one whose wallet
      // was left out at save time because its passphrase did not match,
      // restored nothing and reported "Restored."
      //
      // A silent no-op is indistinguishable from a broken feature, and the
      // user has no way to tell which file they are holding. Now the screen
      // says which case it is and what to do about it.
      const noPhrase = walletReport?.noPhrase || 0;
      say(
        [
          'Restored successfully.',
          // ONE CLAUSE, and only when a wallet came back (2026-11-09: "drop
          // the text about restoring — just say Restored successfully, no
          // bitmail pinned etc"). It survives the cut because a restored
          // wallet has NO COINS until a scan runs, and somebody looking at a
          // zero balance with nothing on screen concludes their money is
          // gone. The counts went; this is what to do next.
          madeWallets || gotKeys ? 'Scan to find your coins.' : '',
          walletTrouble.length
            ? `Not restored: ${walletTrouble.join(', ')}.`
            : '',
          // THE CASE THAT USED TO BE SILENT. The file knows about the wallet
          // and carries no phrase for it, so there is nothing here to restore
          // one from — and the fix is on the SAVE side, on a phone that holds
          // the phrase.
          // NOT "no seed phrase" ANY MORE, which is what a web backup got
          // told until 2026-11-08: "there is no recovery phrase, just the
          // passphrase!!" — correct, and the file had keys in it the whole
          // time. A file reaching this now carries neither, so it is an old
          // one, and what to do about it is the only useful thing to say.
          noPhrase
            ? `${noPhrase} wallet${noPhrase === 1 ? '' : 's'} in this file ` +
              'could not be restored: it carries no keys for them. It was ' +
              'saved by an older version — save a new backup and use that.'
            : '',
          // A label whose coin is not here yet. The coins come back from the
          // chain, so this is the normal state between adding a wallet back
          // and finishing a rescan — and it is the one thing the user has to
          // come BACK and do, which is why it outlived the cut.
          pendingLabels
            ? `${pendingLabels} label${pendingLabels === 1 ? '' : 's'} need their ` +
              'coins scanned first — scan, then restore again.'
            : '',
          // GONE, all of it: the wallets-made and keys-back counts, the
          // "already set up on this device" no-op, the file-holds-no-wallets
          // note, and `skipped` — which is what named bitmailPins and is the
          // "no bitmail pinned etc" in the report. Every one was true and none
          // was the question, which is how this grew to four clauses twice.
          // What is left is the outcome, what to do next, and what did NOT
          // restore.
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
        {/* NO CONTENTS LINE. Dropped on the web on 2026-11-09 ("text Backs
            up your wallets needs to go") and here with it, because two
            screens offering one feature and describing it differently is the
            thing this file keeps having to undo.

            It was load-bearing and what it carried has to go somewhere: it
            was the last line saying what is IN the file, so the red sentence
            below is now the whole of it and must keep naming the wallet
            passphrase as the key. "labels" also replaced "labels and
            contacts" on 2026-11-08 for being a promise the file could not
            keep — nothing claims contacts now because nothing claims
            anything, and the only way that comes back is a new line here. */}
        {/* The "your coins are not in this file, they live on the Bitcoin
            network and come back from your seed phrase" paragraph was
            here until 2026-11-08. It went from the web on the user's
            instruction, and from here as a consequence rather than by
            request: it is the only line left that names the seed phrase,
            and leaving it would undo the point of no longer asking for one.
            What it was defending against — somebody reading this as a wallet
            backup — the first line already handles by saying what IS saved. */}
        {/* The red one, and it is about the PASSWORD now. The file holds
            labels and is sealed with a password that exists nowhere else, so
            that password is the single point of failure for this file — and
            unlike the seed phrase it protects nothing that spends. */}
        {/* THE RED ONE IS ONE LINE (2026-11-08, on the user's instruction:
            "text in red is too long: Encrypted with wallet passphrase. Store
            safely"). It ran to three sentences — what the file holds, that
            anyone with it and the passphrase can spend, and that nobody can
            recover the passphrase. Every clause true, and a warning nobody
            finishes reading warns nobody.

            What the short line keeps is the pair that decides what somebody
            does with the file: the key is the WALLET passphrase, not a
            password this screen invented, and the file is worth storing
            safely. What it drops is the spelled-out consequence. The line
            above it said what was in the file until 2026-11-09; with that
            gone this sentence is the only thing left on the screen about
            either, so it must keep naming the wallet passphrase. */}
        <Block>
          <Note kind="error">
            Encrypted with wallet passphrase. Store safely.
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
                : 'The passphrase your wallet was created with.'}
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
