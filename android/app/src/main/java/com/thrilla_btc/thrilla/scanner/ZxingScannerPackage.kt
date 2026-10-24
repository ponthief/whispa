package com.thrilla_btc.thrilla.scanner

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * Registers ZxingScannerModule. Added by hand in MainApplication, since
 * autolinking only covers modules that arrive as npm packages.
 */
class ZxingScannerPackage : ReactPackage {

  override fun createNativeModules(
      reactContext: ReactApplicationContext
  ): List<NativeModule> = listOf(ZxingScannerModule(reactContext))

  override fun createViewManagers(
      reactContext: ReactApplicationContext
  ): List<ViewManager<*, *>> = emptyList()
}
