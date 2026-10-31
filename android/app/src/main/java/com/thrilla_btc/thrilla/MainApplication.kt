package com.thrilla_btc.thrilla

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeHost
import com.facebook.react.ReactPackage
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.load
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.facebook.react.defaults.DefaultReactNativeHost
import com.facebook.react.flipper.ReactNativeFlipper
import com.facebook.soloader.SoLoader
import com.thrilla_btc.thrilla.scanner.ZxingScannerPackage
import com.thrilla_btc.thrilla.stealth.StealthPackage
import com.thrilla_btc.thrilla.updater.ApkInstallerPackage

class MainApplication : Application(), ReactApplication {

  override val reactNativeHost: ReactNativeHost =
      object : DefaultReactNativeHost(this) {
        override fun getPackages(): List<ReactPackage> =
            PackageList(this).packages.apply {
              // Autolinking only covers modules that arrive as npm packages;
              // this one lives in this repo. See updater/ApkInstallerModule.kt
              // for why downloading and installing an update is written here
              // rather than pulled in as a filesystem library.
              add(ApkInstallerPackage())
              // QR scanning, with ZXing rather than MLKit — see
              // scanner/ZxingScannerModule.kt and FDROID.md. Also local
              // rather than autolinked, for the same reason.
              add(ZxingScannerPackage())
              // Stealth mode — which launcher icon the app wears. Local for
              // the same reason, and see stealth/StealthModule.kt for the one
              // rule it exists to enforce (never zero enabled aliases).
              add(StealthPackage())
            }

        override fun getJSMainModuleName(): String = "index"

        override fun getUseDeveloperSupport(): Boolean = BuildConfig.DEBUG

        override val isNewArchEnabled: Boolean = BuildConfig.IS_NEW_ARCHITECTURE_ENABLED
        override val isHermesEnabled: Boolean = BuildConfig.IS_HERMES_ENABLED
      }

  override val reactHost: ReactHost
    get() = getDefaultReactHost(this.applicationContext, reactNativeHost)

  override fun onCreate() {
    super.onCreate()
    SoLoader.init(this, false)
    if (BuildConfig.IS_NEW_ARCHITECTURE_ENABLED) {
      // If you opted-in for the New Architecture, we load the native entry point for this app.
      load()
    }
    ReactNativeFlipper.initializeFlipper(this, reactNativeHost.reactInstanceManager)
  }
}
