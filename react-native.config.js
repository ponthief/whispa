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
  // The React Native app does its own QR scanning with react-native-camera-kit
  // (see src/components/QRScanner.tsx), so nothing on the mobile side loses a
  // capability. Note this does NOT remove MLKit from the Android APK:
  // react-native-camera-kit depends on com.google.mlkit:barcode-scanning
  // itself, which is where libbarhopper_v3.so and the .tflite models come
  // from.
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
    ...(NO_PUSH
      ? {
          '@react-native-firebase/app': EXCLUDED,
          '@react-native-firebase/messaging': EXCLUDED,
        }
      : {}),
  },
};
