package com.thrilla_btc.thrilla.scanner

import android.app.Activity
import android.content.Intent
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.BaseActivityEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.google.zxing.client.android.Intents
import com.journeyapps.barcodescanner.CaptureActivity

/**
 * QR scanning with ZXing, so the APK carries no proprietary blob.
 *
 * WHY THIS REPLACED A LIBRARY THAT ALREADY WORKED. `react-native-camera-kit`
 * scans fine, and on Android it does it through
 * `com.google.mlkit:barcode-scanning`, which ships `libbarhopper_v3.so` and
 * `.tflite` models — closed-source binaries from Google. F-Droid will not
 * build an app that contains one, and that is the whole reason this file
 * exists. See FDROID.md.
 *
 * iOS KEEPS camera-kit. Its podspec depends on `React-Core` and nothing else —
 * the iOS side decodes with AVFoundation and never had MLKit in it. So this is
 * an Android-only replacement, `react-native.config.js` excludes camera-kit
 * from ANDROID autolinking only, and `components/QRScanner.tsx` branches on
 * the platform. Replacing both would have thrown away a working iOS path to
 * solve an Android packaging problem.
 *
 * WHY AN ACTIVITY RATHER THAN AN EMBEDDED VIEW. zxing-android-embedded offers
 * both: `CaptureActivity`, launched with an Intent, and `DecoratedBarcodeView`,
 * which could be wrapped in a ReactViewManager to keep the scanner inside our
 * own Modal with our own overlay. The second is what the old screen looked
 * like, and it is also a custom ViewManager with a camera lifecycle to get
 * right — surface creation, pause/resume, orientation, teardown on unmount.
 * The Activity is the library's well-trodden path and is far harder to get
 * subtly wrong. The cost is honest and visible: the scanner is now ZXing's
 * screen rather than ours.
 *
 * ONE SCAN, ONE PROMISE. `pending` is cleared before it is resolved, so a
 * result that somehow arrives twice cannot resolve a promise that has moved
 * on, and a second `scan()` while one is open is refused rather than
 * silently replacing the first caller's promise — which would leave that
 * caller waiting forever.
 */
class ZxingScannerModule(
    private val reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "ZxingScanner"

  private var pending: Promise? = null

  private val activityListener: ActivityEventListener =
      object : BaseActivityEventListener() {
        override fun onActivityResult(
            activity: Activity?,
            requestCode: Int,
            resultCode: Int,
            data: Intent?
        ) {
          if (requestCode != REQUEST_CODE) return
          val promise = pending ?: return
          pending = null

          if (resultCode != Activity.RESULT_OK || data == null) {
            // Cancelled — the back button, or the Activity being dismissed.
            // NOT an error: the user closing a scanner is an ordinary outcome
            // and the JS side treats null as "nothing scanned".
            promise.resolve(null)
            return
          }
          val contents = data.getStringExtra(Intents.Scan.RESULT)
          promise.resolve(contents)
        }
      }

  init {
    reactContext.addActivityEventListener(activityListener)
  }

  override fun invalidate() {
    reactContext.removeActivityEventListener(activityListener)
    // A reload with the scanner open would otherwise leave a promise that
    // nothing can ever settle.
    pending?.resolve(null)
    pending = null
    super.invalidate()
  }

  @ReactMethod
  fun scan(promptText: String?, promise: Promise) {
    val activity = currentActivity
    if (activity == null) {
      promise.reject("no-activity", "No activity to launch the scanner from.")
      return
    }
    if (pending != null) {
      promise.reject("busy", "A scan is already open.")
      return
    }

    val intent =
        Intent(activity, CaptureActivity::class.java).apply {
          action = Intents.Scan.ACTION
          // QR only. The wallet has no use for a barcode on a tin of beans,
          // and narrowing the formats makes the decode both faster and less
          // likely to return something the caller then has to reject.
          putExtra(Intents.Scan.FORMATS, "QR_CODE")
          putExtra(Intents.Scan.PROMPT_MESSAGE, promptText ?: "Point at a QR code")
          // No beep: a wallet that chirps in a shop announces what you are
          // doing. The old scanner was silent and this keeps it that way.
          putExtra(Intents.Scan.BEEP_ENABLED, false)
          // No TIMEOUT extra. CaptureActivity already decodes once and
          // finishes, so there is nothing to ask for — and ZXing reads
          // TIMEOUT as "milliseconds of inactivity before the scan fails",
          // which at 0 is a scanner that closes the moment it opens.
        }

    pending = promise
    try {
      activity.startActivityForResult(intent, REQUEST_CODE)
    } catch (e: Exception) {
      pending = null
      promise.reject("launch-failed", e.message, e)
    }
  }

  companion object {
    // Arbitrary but must not collide with another module's. ApkInstaller does
    // not use startActivityForResult, so nothing else in this app claims one.
    private const val REQUEST_CODE = 0x5A58 // 'ZX'
  }
}
