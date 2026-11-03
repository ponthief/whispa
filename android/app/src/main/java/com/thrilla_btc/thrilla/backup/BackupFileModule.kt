package com.thrilla_btc.thrilla.backup

import android.app.Activity
import android.content.Intent
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.BaseActivityEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.ByteArrayOutputStream

/**
 * Save and open a backup file, through the Storage Access Framework.
 *
 * WHY SAF AND NOT A FILE PATH. The app writes nowhere the user cannot reach and
 * asks for no storage permission: ACTION_CREATE_DOCUMENT and ACTION_OPEN_DOCUMENT
 * put the system picker in front of the user, who chooses Drive, Downloads, an
 * SD card or anywhere else, and this process is handed a one-off URI for exactly
 * that file. A backup belongs wherever its owner keeps things, which is not a
 * directory this app picks — and on a wallet, "needs access to all your files"
 * is a permission worth never asking for.
 *
 * WHY HAND-WRITTEN rather than a filesystem library: the same reason
 * updater/ApkInstallerModule and scanner/ZxingScannerModule are. This is two
 * intents and two streams, and an npm native dependency is a thing F-Droid has
 * to be able to build and a thing that can start pulling in a blob.
 *
 * TEXT IN, TEXT OUT. The module moves a UTF-8 string and knows nothing about
 * what is in it; the encryption happens in JavaScript (services/backup.ts)
 * before this is ever called. Nothing here should ever learn what a backup
 * contains, and nothing here should ever be handed a plaintext one.
 *
 * ONE OPERATION AT A TIME. `pending` is cleared BEFORE the promise is settled,
 * so a result that somehow arrives twice cannot settle a promise that has since
 * moved on — the pattern ZxingScannerModule documents, for the same reason.
 */
class BackupFileModule(
    private val reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "BackupFile"

  private var pending: Promise? = null
  private var pendingText: String? = null

  private val activityListener: ActivityEventListener =
      object : BaseActivityEventListener() {
        override fun onActivityResult(
            activity: Activity?,
            requestCode: Int,
            resultCode: Int,
            data: Intent?
        ) {
          when (requestCode) {
            REQUEST_SAVE -> finishSave(resultCode, data)
            REQUEST_OPEN -> finishOpen(resultCode, data)
            else -> return
          }
        }
      }

  init {
    reactContext.addActivityEventListener(activityListener)
  }

  override fun invalidate() {
    reactContext.removeActivityEventListener(activityListener)
    // A reload with the picker open would otherwise leave JavaScript awaiting a
    // promise nothing can settle.
    pending?.reject("cancelled", "The app reloaded before the file was chosen.")
    pending = null
    pendingText = null
  }

  /** Ask the user where to put [text], under a suggested [filename]. */
  @ReactMethod
  fun save(filename: String, text: String, promise: Promise) {
    val activity = currentActivity
    if (activity == null) {
      promise.reject("no-activity", "No activity to open the file picker from.")
      return
    }
    if (pending != null) {
      promise.reject("busy", "A file is already open.")
      return
    }
    pending = promise
    pendingText = text
    val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
      addCategory(Intent.CATEGORY_OPENABLE)
      type = "application/json"
      putExtra(Intent.EXTRA_TITLE, filename)
    }
    try {
      activity.startActivityForResult(intent, REQUEST_SAVE)
    } catch (e: Exception) {
      pending = null
      pendingText = null
      promise.reject("no-picker", "This device has no file picker.", e)
    }
  }

  /** Ask the user for a backup file and return its text. */
  @ReactMethod
  fun open(promise: Promise) {
    val activity = currentActivity
    if (activity == null) {
      promise.reject("no-activity", "No activity to open the file picker from.")
      return
    }
    if (pending != null) {
      promise.reject("busy", "A file is already open.")
      return
    }
    pending = promise
    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
      addCategory(Intent.CATEGORY_OPENABLE)
      // Not "application/json": a backup that has been through Drive, a chat
      // app or a mail client routinely comes back as octet-stream or text/plain,
      // and filtering on the declared type hides the user's own file from them
      // with nothing saying why. The content is validated in JavaScript, which
      // is where the only real answer lives.
      type = "*/*"
    }
    try {
      activity.startActivityForResult(intent, REQUEST_OPEN)
    } catch (e: Exception) {
      pending = null
      promise.reject("no-picker", "This device has no file picker.", e)
    }
  }

  private fun finishSave(resultCode: Int, data: Intent?) {
    val promise = pending ?: return
    val text = pendingText
    pending = null
    pendingText = null
    if (resultCode != Activity.RESULT_OK || data?.data == null || text == null) {
      promise.resolve(null) // cancelled; not an error
      return
    }
    try {
      reactContext.contentResolver.openOutputStream(data.data!!, "w").use { out ->
        if (out == null) throw IllegalStateException("The chosen location cannot be written to.")
        out.write(text.toByteArray(Charsets.UTF_8))
        out.flush()
      }
      promise.resolve(data.data.toString())
    } catch (e: Exception) {
      promise.reject("write-failed", e.message ?: "Could not write the file.", e)
    }
  }

  private fun finishOpen(resultCode: Int, data: Intent?) {
    val promise = pending ?: return
    pending = null
    if (resultCode != Activity.RESULT_OK || data?.data == null) {
      promise.resolve(null) // cancelled; not an error
      return
    }
    try {
      val bytes = reactContext.contentResolver.openInputStream(data.data!!).use { input ->
        if (input == null) throw IllegalStateException("That file cannot be read.")
        val buf = ByteArrayOutputStream()
        val chunk = ByteArray(8192)
        var read = input.read(chunk)
        var total = 0
        while (read >= 0) {
          total += read
          // A backup is kilobytes. The cap is here so that picking a video by
          // mistake fails immediately instead of pulling hundreds of megabytes
          // into the JavaScript bridge and taking the app down with it.
          if (total > MAX_BYTES) {
            throw IllegalStateException("That file is too large to be a backup.")
          }
          buf.write(chunk, 0, read)
          read = input.read(chunk)
        }
        buf.toByteArray()
      }
      promise.resolve(String(bytes, Charsets.UTF_8))
    } catch (e: Exception) {
      promise.reject("read-failed", e.message ?: "Could not read the file.", e)
    }
  }

  companion object {
    private const val REQUEST_SAVE = 0x4201
    private const val REQUEST_OPEN = 0x4202
    private const val MAX_BYTES = 8 * 1024 * 1024
  }
}
