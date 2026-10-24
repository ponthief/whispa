package com.thrilla_btc.thrilla.scanner

import android.os.Bundle
import com.journeyapps.barcodescanner.CaptureActivity
import com.journeyapps.barcodescanner.DecoratedBarcodeView

/**
 * ZXing's capture screen with camera settings that can actually read a QR
 * code off a monitor.
 *
 * WHY THIS EXISTS. The stock `CaptureActivity` reported on 2026-10-24 as
 * "not reading a QR code on a monitor", and the defaults explain it. A backlit
 * screen is the hard case for every one of them:
 *
 *   focusMode = AUTO           periodic autofocus that hunts at the close
 *                              range a monitor is read from
 *   barcodeSceneMode = false   the camera HAL has a mode tuned for codes and
 *                              it was not being asked for
 *   metering = false           a monitor IS a light source, so centre-weighted
 *                              metering is what stops auto-exposure blowing
 *                              the white modules out
 *
 * MLKit hid all three, because its detector is simply more forgiving than
 * ZXing's. Swapping it out for a free one means asking the camera for what
 * MLKit was getting away without.
 *
 * TIMING, which is the part that is easy to get wrong. CaptureActivity.onCreate
 * runs `initializeContent()`, then `CaptureManager.initializeFromIntent()` —
 * and that second call constructs a FRESH `CameraSettings` and installs it,
 * throwing away anything configured earlier. So this cannot go in an
 * `initializeContent()` override; it has to come after `super.onCreate`.
 *
 * It is still early enough: the camera is not opened until `onResume`, which
 * runs after `onCreate` returns. Settings applied here are the ones the camera
 * is opened with.
 *
 * ORIENTATION is set in the manifest rather than here. The library declares
 * its own CaptureActivity `sensorLandscape`, which turns a phone held upright
 * into a sideways preview with a letterbox framing rect. Ours is `fullSensor`
 * so it follows how the phone is actually held; CaptureManager still locks to
 * whatever that was at launch, so the preview does not flip mid-scan.
 */
class WhispaCaptureActivity : CaptureActivity() {

  // Captured on the way past rather than looked up afterwards.
  // CaptureActivity keeps its view private, and the alternative —
  // findViewById(com.google.zxing.client.android.R.id.zxing_barcode_scanner) —
  // reaches into the library's R class, which AGP 8's non-transitive R makes
  // a compile-time coin toss. This hook is public API and needs no R at all.
  private var scannerView: DecoratedBarcodeView? = null

  override fun initializeContent(): DecoratedBarcodeView {
    val view = super.initializeContent()
    scannerView = view
    return view
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    // Runs initializeContent() above, then initializeFromIntent(), which
    // installs a fresh CameraSettings over anything set before it.
    super.onCreate(savedInstanceState)

    val view = scannerView ?: return
    val settings = view.cameraSettings

    settings.isContinuousFocusEnabled = true
    settings.isBarcodeSceneModeEnabled = true
    settings.isMeteringEnabled = true
    // NOT scanInverted: it doubles the decode work to handle light-on-dark
    // codes, which is not what a monitor shows, and halves the frame rate for
    // the ordinary case.

    view.cameraSettings = settings
  }
}
