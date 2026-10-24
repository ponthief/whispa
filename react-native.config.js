// WHISPA_NO_PUSH=1 drops Firebase from the native build. See FDROID.md.
//
// Firebase Cloud Messaging is a proprietary Google SDK, and an F-Droid build
// should not carry one. The npm packages stay installed so the JavaScript
// still resolves; what this removes is the AUTOLINKING, and with it the
// Firebase AARs and their .so files.
//
// services/push.ts asks NativeModules whether the native side is there rather
// than reading this variable, so the app discovers the answer from the APK it
// is actually running in — a flag can disagree with what was built, and that
// disagreement would surface as a crash on launch.
//
// This does NOT make the build free of proprietary code. react-native-camera-kit
// depends on com.google.mlkit:barcode-scanning, which is where
// libbarhopper_v3.so and the .tflite models come from, and that is a separate
// problem with its own answer (FDROID.md).
const NO_PUSH = process.env.WHISPA_NO_PUSH === '1';
const EXCLUDED = { platforms: { ios: null, android: null } };

module.exports = {
  project: {
    ios: {},
    android: {},
  },
  dependency: {
    platforms: {
      android: null,
      ios: null,
    },
  },
  // Capacitor belongs to the Vue web app, not to React Native.
  //
  // src/components/QrScanModal.vue scans QR codes through
  // @capacitor-mlkit/barcode-scanning, so the dependency is real and stays.
  // But React Native autolinks it too, and on iOS that broke the build
  // outright:
  //
  //   duplicate symbol '_OBJC_CLASS_$_AppDelegate' in:
  //       .../Thrilla.build/.../AppDelegate.o
  //       .../CapacitorCordova/Cordova.framework/Cordova(AppDelegate.o)
  //
  // Cordova.framework defines its own AppDelegate, which collides with the
  // one every React Native app has.
  //
  // Android never hit this, and the reason is worth writing down: RN's Android
  // autolinking looks for a native module class and finds none, so it already
  // skips this package — `npx react-native config` reports
  // "android=- ios=yes" for it. iOS autolinking only needs a podspec, which
  // Capacitor ships. Both platforms are pinned to null here so the exclusion
  // is stated rather than relying on that asymmetry staying as it is.
  //
  // The React Native app does its own QR scanning (see
  // src/components/QRScanner.tsx), so nothing on the mobile side loses a
  // capability by excluding this one. Android scans with ZXing and iOS with
  // camera-kit; the camera-kit entry below has the asymmetry.
  //
  // This exclusion is not what removed MLKit from the APK — that is the
  // camera-kit entry below, and it only became true on 2026-10-24. Before
  // then camera-kit scanned through com.google.mlkit:barcode-scanning on
  // Android, which is where libbarhopper_v3.so and the .tflite models came
  // from, and this comment said so.
  dependencies: {
    '@capacitor-mlkit/barcode-scanning': {
      platforms: {
        ios: null,
        android: null,
      },
    },
    '@capacitor/core': {
      platforms: {
        ios: null,
        android: null,
      },
    },
    // ANDROID ONLY, and the asymmetry is the whole point.
    //
    // react-native-camera-kit's Android side scans through
    // com.google.mlkit:barcode-scanning — libbarhopper_v3.so and .tflite
    // models, which F-Droid will not build. Android uses ZXing instead
    // (android/.../scanner/ZxingScannerModule.kt), so camera-kit has nothing
    // left to do there.
    //
    // iOS KEEPS IT. That podspec depends on React-Core and nothing else: the
    // decode is AVFoundation's and MLKit was never in it. Excluding both
    // platforms would have thrown away a working iOS scanner to solve an
    // Android packaging problem. components/QRScanner.tsx branches to match.
    'react-native-camera-kit': {
      platforms: {
        android: null,
      },
    },
    ...(NO_PUSH
      ? {
          '@react-native-firebase/app': EXCLUDED,
          '@react-native-firebase/messaging': EXCLUDED,
        }
      : {}),
  },
};
