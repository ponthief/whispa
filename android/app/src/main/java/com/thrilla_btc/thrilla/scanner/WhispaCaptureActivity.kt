package com.thrilla_btc.thrilla.scanner

import android.os.Bundle
import com.journeyapps.barcodescanner.CaptureActivity
import com.journeyapps.barcodescanner.DecoratedBarcodeView

/**
 * ZXing's capture screen with one camera setting changed: continuous focus.
 *
 * READ THIS FIRST, because the file's history is misleading. The scanner bug
 * this was written during was **not a camera bug at all**: `QrModal.vue` drew
 * the web app's receive QR inverted — bright orange modules on near-black —
 * and ZXing decodes dark-on-light only, where MLKit had not cared. Fixing the
 * QR fixed the scanner. Nothing in this file was the cause, and nothing in it
 * is proven to be the cure.
 *
 * SO WHY DOES IT STILL EXIST. Continuous focus is defensible on its own
 * terms, and the device log is the argument:
 *
 *   CameraConfiguration: Requesting focus mode value from among: [auto]
 *   CameraConfiguration: Supported focus mode values:
 *                            [auto, macro, continuous-video, continuous-picture]
 *   focus-distances=Infinity,Infinity,Infinity
 *
 * A list of one is `CameraConfigurationUtils.setFocus` taking its
 * `FocusMode.AUTO` branch, the library default. Under Camera1 `auto` moves the
 * lens only when something calls `autoFocus()`, which `AutoFocusManager` does
 * about every two seconds; the device offers `continuous-picture` and was not
 * being asked for it. A scanner that tracks focus is better than one that
 * hunts, whatever today's bug turned out to be.
 *
 * But it is UNVALIDATED. It was aimed at a cause that turned out to be wrong,
 * and the scanner was never seen working with it off and the QR fixed. If the
 * scanner ever misbehaves again, this and the `TRY_HARDER` hint in
 * `ZxingScannerModule` are the first two things to take back out.
 *
 * ONE SETTING, and `check:fdroid` counts them: it fails if this class assigns
 * more than one `settings.*`. That is not a ban on tuning, it is a ban on
 * tuning blind — the first version of this file set continuous focus,
 * `SCENE_MODE_BARCODE` and metering, and changed the manifest orientation, all
 * in one commit. Four variables for one symptom, so its failure ruled out
 * nothing and the revert that followed ruled out nothing either.
 *
 * ORIENTATION is in the manifest, and is `fullUser` rather than the library's
 * `sensorLandscape` — a phone held upright was getting a sideways, stretched
 * preview. The manifest entry has the reasoning, including why portrait also
 * gives the decoder a better-shaped crop.
 *
 * HOW TO TELL WHETHER THE FOCUS SETTING TOOK, without reading any code: that
 * same `CameraConfiguration` line should now read
 *
 *   Requesting focus mode value from among:
 *       [continuous-picture, continuous-video, auto]
 *
 * followed by `Can set focus mode to: continuous-picture`. If it still says
 * `[auto]`, this file is not being used and the manifest or the module is
 * wrong — not the camera.
 *
 * TIMING, which is the part that is easy to get wrong. `CaptureActivity.onCreate`
 * runs `initializeContent()`, then `CaptureManager.initializeFromIntent()` — and
 * that second call constructs a FRESH `CameraSettings` and installs it, throwing
 * away anything configured earlier. So this cannot go in an `initializeContent()`
 * override; it has to come after `super.onCreate`. It is still early enough: the
 * camera is not opened until `onResume`.
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

    // The one change. setContinuousFocusEnabled(true) sets
    // CameraSettings.focusMode = FocusMode.CONTINUOUS, which is what makes
    // CameraConfigurationUtils.setFocus ask for continuous-picture first.
    settings.isContinuousFocusEnabled = true

    view.cameraSettings = settings
  }
}
