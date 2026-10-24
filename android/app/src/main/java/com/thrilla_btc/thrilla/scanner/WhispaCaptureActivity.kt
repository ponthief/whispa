package com.thrilla_btc.thrilla.scanner

import android.os.Bundle
import com.journeyapps.barcodescanner.CaptureActivity
import com.journeyapps.barcodescanner.DecoratedBarcodeView

/**
 * ZXing's capture screen with ONE setting changed: continuous focus.
 *
 * WHAT THE DEVICE LOG SAID (2026-10-24). A logcat from a failing scan settled
 * most of the question. Against the stock `CaptureActivity`:
 *
 *   - the Activity launches, the camera opens on the Camera1 legacy path, and
 *     `CameraPreview: Starting preview` appears — the line immediately before
 *     `previewActive = true; previewStarted()`, which is what calls
 *     `BarcodeView.startDecoderThread()`. `CaptureManager.decode()` has already
 *     set the mode to SINGLE by then, so THE DECODER THREAD RUNS.
 *   - a second camera stream (YCbCr_420_888, CPU_READ_OFTEN) is configured
 *     0.4s later: the decoder asking for its first frame.
 *   - ~380 frames are delivered over the 13 seconds the screen is open.
 *   - `DecodeHintManager: Hints from the Intent: {TRY_HARDER=true}` — the
 *     intent is parsed and the decoder is configured.
 *   - no exception, anywhere.
 *
 * So the wiring is not the problem. Frames reach a running decoder and the
 * decoder cannot read them. That is the IMAGE.
 *
 * AND THE SAME LOG NAMES THE ONE IMAGE SETTING WE CONTROL:
 *
 *   CameraConfiguration: Requesting focus mode value from among: [auto]
 *   CameraConfiguration: Supported focus mode values:
 *                            [auto, macro, continuous-video, continuous-picture]
 *   CameraConfiguration: Focus mode already set to auto
 *   ...
 *   focus-distances=Infinity,Infinity,Infinity
 *
 * ZXing asked for exactly one focus mode — `auto` — on a device that offers
 * `continuous-picture`. That list of one is `CameraConfigurationUtils.setFocus`
 * taking its `FocusMode.AUTO` branch, which is the library default. Under
 * Camera1, `auto` means the lens moves only when something calls `autoFocus()`,
 * which `AutoFocusManager` does about every two seconds; the lens is reported
 * parked at infinity. MLKit ran through camera-kit with continuous focus. A
 * lens at infinity will not resolve a dense QR at reading distance, and that is
 * a real behavioural difference between the scanner that worked and this one.
 *
 * WHY THIS IS NOT THE CHANGE THAT WAS ALREADY REVERTED. The earlier
 * WhispaCaptureActivity set continuous focus too — and `SCENE_MODE_BARCODE` and
 * metering with it, and changed the manifest orientation to `fullSensor` in the
 * same commit. Four variables. It failed, and was reverted on the reasoning
 * that under Camera1 a scene mode can make focus mode read-only, which would
 * pin the very focus being requested alongside it. If that reasoning is right,
 * continuous focus WITHOUT a scene mode has never actually been tried. That is
 * the whole of this file.
 *
 * So: no `barcodeSceneModeEnabled`, no `meteringEnabled`, no `scanInverted`, no
 * preview-size change, and the manifest keeps the library's own
 * `sensorLandscape` — the orientation the failing build ran at. Focus mode is
 * the only thing that differs from the build this is compared against.
 *
 * HOW TO TELL WHETHER IT TOOK, without reading the code: the same
 * `CameraConfiguration` line changes. It should read
 *
 *   Requesting focus mode value from among:
 *       [continuous-picture, continuous-video, auto]
 *
 * and then `Can set focus mode to: continuous-picture`. If it still says
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
