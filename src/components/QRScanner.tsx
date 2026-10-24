import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Modal,
  NativeModules,
  PermissionsAndroid,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { colors } from '@/theme';

/*
 * QR scanning, and it is two different things on the two platforms.
 *
 * ANDROID goes through ZXing, in a native module of our own
 * (android/.../scanner/ZxingScannerModule.kt). react-native-camera-kit scanned
 * through com.google.mlkit:barcode-scanning, which ships libbarhopper_v3.so and
 * .tflite models — closed binaries F-Droid will not build. See FDROID.md.
 *
 * What that costs, visibly: ZXing opens its OWN full-screen Activity, so the
 * Modal, the frame overlay and the Cancel button below are iOS's now. The
 * alternative was wrapping ZXing's DecoratedBarcodeView in a custom
 * ViewManager to keep the scanner inside our Modal — a camera lifecycle to get
 * right for a cosmetic match, on the screen where a mistake means a send
 * cannot be started.
 *
 * iOS KEEPS camera-kit, whose podspec needs React-Core alone and whose decode
 * is AVFoundation's. MLKit was never on that side, so there is nothing to fix
 * and no reason to lose a working in-app scanner.
 *
 * The component's contract is unchanged either way: it renders when `visible`,
 * calls `onScanned` once with a trimmed string, and `onClose` when it is done.
 * Callers do not branch.
 */

interface Props {
  visible: boolean;
  onClose: () => void;
  onScanned: (value: string) => void;
}

type PermState = 'checking' | 'granted' | 'denied';

const IS_ANDROID = Platform.OS === 'android';

// LOOKED UP AT CALL TIME, not at module load. `NativeModules.X` read at import
// is a snapshot of whatever the bridge had registered at that instant, and
// this file is imported from SendScreen's module graph — early. A module that
// registers later reads as absent forever, and the only symptom is a scanner
// that closes the moment it opens.
type ZxingModule = { scan(prompt: string | null): Promise<string | null> };
const zxing = (): ZxingModule | undefined =>
  NativeModules.ZxingScanner as ZxingModule | undefined;

// WHY THE FAILURES ARE LOUD NOW.
//
// Every branch below used to end in `onClose()`, which closes the sheet and
// says nothing — and three rounds of "the scanner does not work" were spent
// guessing which branch it was, because a missing native module, a refused
// permission and a scan that returned nothing all looked identical from the
// outside.
//
// A wallet should not normally shout at people. This is the exception: the
// alternative is a control that silently does nothing, which is worse, and
// the message names the stage so a report can say which one.
function report(stage: string, detail?: string) {
  Alert.alert(
    'Scanner',
    detail ? `${stage}\n\n${detail}` : stage,
    [{ text: 'OK' }],
    { cancelable: true },
  );
}

export default function QRScanner({ visible, onClose, onScanned }: Props) {
  if (IS_ANDROID) return <AndroidScanner {...{ visible, onClose, onScanned }} />;
  return <IosScanner {...{ visible, onClose, onScanned }} />;
}

/* ── Android: ZXing's own Activity ──────────────────────────────────────── */

function AndroidScanner({ visible, onClose, onScanned }: Props) {
  // THE CALLBACKS LIVE IN REFS, AND THAT IS THE WHOLE OF A BUG THAT MADE
  // SCANNING SILENTLY DO NOTHING (2026-10-24).
  //
  // SendScreen passes them inline — `onClose={() => setScanning(false)}` —
  // so they get a fresh identity on every one of its renders, and it renders
  // constantly: an amount field, a slider, fee tiers, a poller. With them in
  // the dependency array below, the sequence was:
  //
  //   1. visible → true, effect runs, the scanner Activity launches
  //   2. SendScreen re-renders for any reason at all
  //   3. deps changed, so React runs this effect's CLEANUP: active = false
  //   4. the effect re-runs, sees launched.current, and returns early
  //   5. the user scans; the promise from step 1 resolves; `if (!active)`
  //      throws the result away
  //
  // The scanner opened, read the code, closed, and nothing happened. It looked
  // like a scanner that could not read.
  //
  // So the effect depends on `visible` ALONE, and the result is guarded on
  // whether the component is still mounted rather than on whether this
  // particular effect invocation is still current. Refs rather than
  // useCallback, because the fix has to hold however the PARENT chooses to
  // pass its props — a caller is entitled to pass an inline arrow.
  const onCloseRef = useRef(onClose);
  const onScannedRef = useRef(onScanned);
  useEffect(() => {
    onCloseRef.current = onClose;
    onScannedRef.current = onScanned;
  });

  // Mount state, not effect state. A scan in flight has to survive every
  // re-render of the screen underneath it.
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  // The launch is an effect rather than a render, because there is nothing to
  // render: the scanner is another Activity on top of ours.
  //
  // `launched` makes it once per open. Without it a re-run of this effect
  // would stack a second scanner Activity on the first.
  const launched = useRef(false);

  useEffect(() => {
    if (!visible) {
      launched.current = false;
      return;
    }
    if (launched.current) return;
    launched.current = true;

    (async () => {
      try {
        const mod = zxing();
        if (!mod) {
          // No native module. An old build, or an autolinking/registration
          // mistake. Named explicitly because it is indistinguishable from
          // every other failure once the sheet has closed.
          onCloseRef.current();
          report(
            'The scanner is not available in this build.',
            'NativeModules.ZxingScanner is missing. The recipient can still ' +
              'be pasted in.',
          );
          return;
        }

        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.CAMERA,
        );
        if (!mounted.current) return;
        if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
          onCloseRef.current();
          report(
            'Camera permission is required to scan.',
            `Permission result: ${granted}`,
          );
          return;
        }

        const value = await mod.scan('Point at a QR code');
        if (!mounted.current) return;
        // null is a cancel (back button) and is an ordinary outcome — the one
        // branch that stays quiet, because a user who pressed back does not
        // need telling what they just did.
        if (value) onScannedRef.current(String(value).trim());
        onCloseRef.current();
      } catch (e: any) {
        if (!mounted.current) return;
        onCloseRef.current();
        // Carries the native code and message through: "no-activity",
        // "busy" and "launch-failed" are raised by ZxingScannerModule and
        // each means something different.
        report(
          'The scanner could not run.',
          `${e?.code ? `[${e.code}] ` : ''}${e?.message || String(e)}`,
        );
      }
    })();
  }, [visible]);

  return null;
}

/* ── iOS: camera-kit, in our own Modal ──────────────────────────────────── */

function IosScanner({ visible, onClose, onScanned }: Props) {
  const [perm, setPerm] = useState<PermState>('checking');
  const handled = useRef(false);

  useEffect(() => {
    if (!visible) {
      handled.current = false;
      setPerm('checking');
      return;
    }
    // camera-kit triggers its own permission prompt on iOS.
    setPerm('granted');
  }, [visible]);

  const onRead = useCallback(
    (event: any) => {
      if (handled.current) return;
      const value = event?.nativeEvent?.codeStringValue;
      if (!value) return;
      handled.current = true; // guard against multiple rapid reads
      onScanned(String(value).trim());
      onClose();
    },
    [onScanned, onClose],
  );

  // Required lazily so the Android build, where camera-kit is excluded from
  // autolinking, never resolves it. A static import would be a native module
  // that is not there.
  let Camera: any = null;
  let CameraType: any = null;
  try {
    const ck = require('react-native-camera-kit');
    Camera = ck.Camera;
    CameraType = ck.CameraType;
  } catch {
    Camera = null;
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.root}>
        {perm === 'granted' && Camera ? (
          <Camera
            style={StyleSheet.absoluteFill}
            cameraType={CameraType?.Back}
            scanBarcode
            onReadCode={onRead}
          />
        ) : perm === 'denied' ? (
          <View style={styles.center}>
            <Text style={styles.msg}>
              Camera permission is required to scan. Enable it for WhiSPa in
              your device settings.
            </Text>
          </View>
        ) : (
          <View style={styles.center}>
            <Text style={styles.msg}>Requesting camera…</Text>
          </View>
        )}

        {perm === 'granted' && Camera ? (
          <View style={styles.overlay} pointerEvents="box-none">
            <View style={styles.frame} />
            <Text style={styles.hint}>Point at a QR code</Text>
          </View>
        ) : null}

        <TouchableOpacity style={styles.cancel} onPress={onClose}>
          <Text style={styles.cancelText}>Cancel</Text>
        </TouchableOpacity>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
  msg: { color: '#fff', fontSize: 15, textAlign: 'center', lineHeight: 22 },
  overlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  frame: {
    width: 240,
    height: 240,
    borderWidth: 3,
    borderColor: colors.primary,
    borderRadius: 16,
    backgroundColor: 'transparent',
  },
  hint: { color: '#fff', fontSize: 14, marginTop: 20, fontWeight: '600' },
  cancel: {
    position: 'absolute',
    bottom: 40,
    alignSelf: 'center',
    backgroundColor: 'rgba(255,255,255,0.15)',
    paddingHorizontal: 32,
    paddingVertical: 12,
    borderRadius: 24,
  },
  cancelText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
