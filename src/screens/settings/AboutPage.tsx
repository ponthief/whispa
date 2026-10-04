import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Linking, StyleSheet, View } from 'react-native';
import { Button, Group, Help, InfoRow, NavRow, Note, Page } from './ui';
import { colors } from '@/theme';
import { displayVersion } from '@/version';
import {
  checkForUpdate,
  fetchExpectedSha256,
  flavorAssetName,
  UpdateCheckError,
  type ReleaseInfo,
} from '@services/updateCheck';
import {
  cancelDownload,
  canInstall,
  discardDownload,
  downloadApk,
  formatBytes,
  installApk,
  IN_APP_INSTALL_SUPPORTED,
  onDownloadProgress,
  openInstallSettings,
} from '@services/apkInstaller';

const REPO = 'https://github.com/ponthief/whispa';

type Stage =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'found'; release: ReleaseInfo }
  | { kind: 'downloading'; release: ReleaseInfo; bytes: number; total: number }
  | { kind: 'verified'; release: ReleaseInfo; path: string; sha256: string };

export default function AboutPage({ onBack }: { onBack: () => void }) {
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const open = (url: string) => Linking.openURL(url).catch(() => {});

  // ── find out whether there is one ──────────────────────────────────────────
  const onCheck = useCallback(async () => {
    setError(null);
    setStage({ kind: 'checking' });
    try {
      const status = await checkForUpdate();
      if (!mounted.current) return;
      if (!status.updateAvailable) {
        setStage({ kind: 'idle' });
        Alert.alert(
          'Up to date',
          `You have ${status.current}, which is the newest release.`,
        );
        return;
      }
      setStage({ kind: 'found', release: status.latest });
    } catch (e: any) {
      if (!mounted.current) return;
      setStage({ kind: 'idle' });
      setError(
        e instanceof UpdateCheckError
          ? e.message
          : e?.message || 'The update check did not complete.',
      );
    }
  }, []);

  // ── download it, with the hash checked as it arrives ───────────────────────
  const onDownload = useCallback(async (release: ReleaseInfo) => {
    setError(null);
    if (!release.apkUrl || !release.apkName) {
      setError(
        `This release has no ${flavorAssetName()}.`,
      );
      return;
    }

    // Android 8 and later require the user to allow this app to ask, once, in
    // Settings. Better to find out before spending 37 MB of their data.
    try {
      const perm = await canInstall();
      if (!perm.allowed) {
        Alert.alert(
          'Android needs your permission',
          'Android has to allow WhiSPa to install an update. Turn it on in the ' +
            'next screen, then tap Download again.',
          [
            { text: 'Not now', style: 'cancel' },
            { text: 'Open settings', onPress: () => openInstallSettings().catch(() => {}) },
          ],
        );
        return;
      }
    } catch {
      // Could not read the setting; let the install attempt report it instead
      // of blocking on a check that is itself failing.
    }

    let stop: (() => void) | undefined;
    try {
      const expected = await fetchExpectedSha256(release);
      if (!mounted.current) return;

      setStage({
        kind: 'downloading',
        release,
        bytes: 0,
        total: release.apkBytes ?? -1,
      });
      stop = onDownloadProgress((p) => {
        if (!mounted.current) return;
        setStage((s) =>
          s.kind === 'downloading'
            ? { ...s, bytes: p.bytes, total: p.total > 0 ? p.total : s.total }
            : s,
        );
      });

      const got = await downloadApk(release.apkUrl, expected, release.apkName);
      if (!mounted.current) return;
      setStage({ kind: 'verified', release, path: got.path, sha256: got.sha256 });
    } catch (e: any) {
      if (!mounted.current) return;
      setStage({ kind: 'found', release });
      // E_CANCELLED is the user's own doing, so it is not an error to report.
      if (e?.code !== 'E_CANCELLED') {
        setError(
          e instanceof UpdateCheckError
            ? e.message
            : e?.message || 'The download did not finish.',
        );
      }
    } finally {
      stop?.();
    }
  }, []);

  const onCancel = useCallback(() => {
    cancelDownload().catch(() => {});
  }, []);

  const onInstall = useCallback(async (path: string) => {
    setError(null);
    try {
      await installApk(path);
    } catch (e: any) {
      setError(e?.message || 'Could not start the installer.');
    }
  }, []);

  const onDiscard = useCallback((release: ReleaseInfo) => {
    discardDownload().catch(() => {});
    setStage({ kind: 'found', release });
  }, []);

  // ── the update section ─────────────────────────────────────────────────────
  let updateRows: React.ReactNode;
  if (stage.kind === 'checking') {
    updateRows = <Note kind="info">Asking github.com…</Note>;
  } else if (stage.kind === 'downloading') {
    const { bytes, total } = stage;
    const pct = total > 0 ? Math.min(100, Math.round((bytes / total) * 100)) : null;
    updateRows = (
      <>
        <InfoRow
          first
          title={`Downloading ${stage.release.version}`}
          value={
            pct === null
              ? formatBytes(bytes)
              : `${pct}%  ·  ${formatBytes(bytes)} of ${formatBytes(total)}`
          }
        />
        <View style={styles.track}>
          <View style={[styles.fill, pct === null ? styles.fillUnknown : { width: `${pct}%` }]} />
        </View>
        <Button label="Cancel" kind="secondary" onPress={onCancel} />
      </>
    );
  } else if (stage.kind === 'verified') {
    updateRows = (
      <>
        <InfoRow first title="Ready to install" value={stage.release.version} />
        <InfoRow title="SHA-256 checked" value={`${stage.sha256.slice(0, 16)}…`} />
        <Button label="Install now" onPress={() => onInstall(stage.path)} />
        <Button
          label="Delete the download"
          kind="secondary"
          onPress={() => onDiscard(stage.release)}
        />
      </>
    );
  } else if (stage.kind === 'found') {
    const r = stage.release;
    updateRows = (
      <>
        <InfoRow first title="Newer release" value={r.version} />
        {r.apkBytes ? (
          <InfoRow title="Download size" value={formatBytes(r.apkBytes)} />
        ) : null}
        {IN_APP_INSTALL_SUPPORTED && r.apkUrl ? (
          <Button label={`Download ${r.version}`} onPress={() => onDownload(r)} />
        ) : null}
        <NavRow title="Release notes" onPress={() => open(r.pageUrl)} />
        {!IN_APP_INSTALL_SUPPORTED && r.apkUrl ? (
          <NavRow
            title="Download in a browser"
            help={r.apkName || undefined}
            onPress={() => open(r.apkUrl as string)}
          />
        ) : null}
      </>
    );
  } else {
    updateRows = (
      <NavRow title="Check for updates" help="Asks github.com" onPress={onCheck} />
    );
  }

  return (
    <Page title="About" onBack={onBack}>
      <Group title="Version">
        <InfoRow first title="WhiSPa" value={displayVersion()} />
      </Group>

      <Group title="Update">
        {updateRows}
        {error ? <Note kind="error">{error}</Note> : null}
      </Group>

      <Group title="Source">
        <NavRow
          first
          title="Source code"
          help="github.com/ponthief/whispa"
          onPress={() => open(REPO)}
        />
      </Group>

      <Help>
        Set in Geist and Geist Mono, by Vercel with basement.studio, under the
        SIL Open Font License 1.1.
      </Help>
    </Page>
  );
}

const styles = StyleSheet.create({
  track: {
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    overflow: 'hidden',
    marginTop: 10,
    marginBottom: 4,
  },
  fill: {
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.primary,
  },
  // No content length: show a part-filled bar rather than a bar that claims a
  // percentage it does not have.
  fillUnknown: { width: '35%' },
});
