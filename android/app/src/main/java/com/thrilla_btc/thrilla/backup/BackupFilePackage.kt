package com.thrilla_btc.thrilla.backup

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * Registers BackupFileModule. Added by hand in MainApplication, beside the
 * other local modules, since autolinking only covers npm packages.
 */
class BackupFilePackage : ReactPackage {

  override fun createNativeModules(
      reactContext: ReactApplicationContext
  ): List<NativeModule> = listOf(BackupFileModule(reactContext))

  override fun createViewManagers(
      reactContext: ReactApplicationContext
  ): List<ViewManager<*, *>> = emptyList()
}
