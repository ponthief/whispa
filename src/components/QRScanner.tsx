import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
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
const Zxing = NativeModules.ZxingScanner as
  | { scan(prompt: string | null): Promise<string | null> }
  | undefined;

export default function QRScanner({ visible, onClose, onScanned }: Props) {
  if (IS_ANDROID) return <AndroidScanner {...{ visible, onClose, onScanned }} />;
  return <IosScanner {...{ visible, onClose, onScanned }} />;
}

/* ── Android: ZXing's own Activity ──────────────────────────────────────── */

function AndroidScanner({ visible, onClose, onScanned }: Props) {
  // The launch is an effect rather than a render, because there is nothing to
  // render: the scanner is another Activity on top of ours.
  //
  // `launched` makes it once per open. Without it any re-render while visible
  // — a parent's state change, a keyboard dismissal — would stack a second
  // scanner Activity on the first.
  const launched = useRef(false);

  useEffect(() => {
    if (!visible) {
      launched.current = false;
      return;
    }
    if (launched.current) return;
    launched.current = true;

    let active = true;
    (async () => {
      try {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.CAMERA,
        );
        if (!active) return;
        if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
          onClose();
          return;
        }
        if (!Zxing) {
          // The module is missing — an old build, or a packaging mistake.
          // Closing is the honest outcome: there is no scanner, and the
          // recipient field can still be pasted into.
          onClose();
          return;
        }
        const value = await Zxing.scan('Point at a QR code');
        if (!active) return;
        // null is a cancel (back button), which is an ordinary outcome and
        // not an error — close without calling onScanned.
        if (value) onScanned(String(value).trim());
        onClose();
      } catch {
        if (active) onClose();
      }
    })();

    return () => {
      active = false;
    };
  }, [visible, onClose, onScanned]);

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
