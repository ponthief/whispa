package com.thrilla_btc.thrilla.stealth

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * Registers StealthModule. Added by hand in MainApplication, beside
 * ApkInstallerPackage and ZxingScannerPackage, since autolinking only covers
 * modules that arrive as npm packages.
 */
class StealthPackage : ReactPackage {

  override fun createNativeModules(
      reactContext: ReactApplicationContext
  ): List<NativeModule> = listOf(StealthModule(reactContext))

  override fun createViewManagers(
      reactContext: ReactApplicationContext
  ): List<ViewManager<*, *>> = emptyList()
}
