package com.thrilla_btc.thrilla.stealth

import android.content.ComponentName
import android.content.pm.PackageManager
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Stealth mode: which launcher icon this app wears.
 *
 * Android gives an app one icon per enabled `activity-alias` carrying
 * MAIN/LAUNCHER. The manifest declares three aliases onto MainActivity — the
 * real one plus two decoys — and this module flips which is enabled, so the
 * home screen shows a calculator or a notepad instead of a wallet.
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE: there is ALWAYS at least one
 * enabled alias. Zero enabled is an app with no icon on any launcher and no
 * way to start it — for a wallet, somebody's money behind a door with no
 * handle, recoverable only by reinstalling and restoring the recovery phrase,
 * which many people do not have to hand. So [setAlias] enables the target
 * FIRST and only then disables the others, and it refuses a name it does not
 * recognise rather than disabling everything and leaving nothing on.
 *
 * DONT_KILL_APP is passed on every call. Without it Android is free to stop
 * the process the moment the component it was launched from is disabled, so
 * the user taps the toggle and the app vanishes — which reads as a crash, and
 * on this screen, mid-settings, reads as a crash caused by turning on a
 * security feature.
 *
 * WHAT THIS CANNOT HIDE, and the UI says so rather than implying otherwise:
 * the app name in Settings → Apps, in the storage and battery lists, in the
 * recent-apps card, and in the header of every push notification. All of those
 * come from the application label, which an alias does not touch. The app
 * turns push off while a decoy is worn for exactly that reason.
 */
class StealthModule(
    private val reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "StealthModule"

    /**
     * The aliases, by the key JavaScript uses. These strings are part of the
     * component identity Android stores — a launcher remembers the component
     * behind a pinned icon — so they are frozen. Renaming one leaves anybody
     * who pinned it with an icon that opens nothing.
     */
    private val aliases = linkedMapOf(
        "default" to ".Launcher",
        "calculator" to ".LauncherCalculator",
        "notes" to ".LauncherNotes"
    )

    /**
     * The package the alias CLASSES live in: the Gradle `namespace`, which is
     * NOT the applicationId.
     *
     * This is the repo's oldest Android trap and it caught this file on its
     * first build. `namespace` is com.thrilla_btc.thrilla and `applicationId`
     * is com.whispawallet.app (com.whispawallet.app.signet on signet), so a
     * component built from getPackageName() — the applicationId — names
     * com.whispawallet.app.Launcher, which does not exist.
     * setComponentEnabledSetting answers that with
     * IllegalArgumentException: Unknown component, every call fails, and the
     * user gets "Could not change the icon" with no clue why.
     *
     * app/build.gradle says the same thing about `build_config_package` and
     * react-native-config: BuildConfig is generated under the NAMESPACE, not
     * under the applicationId. Same divergence, same mistake.
     *
     * The two halves of a ComponentName are different things and both matter:
     * the package is the INSTALLED package (the applicationId, which is what
     * getPackageName returns and what differs per flavor), and the class is
     * the fully-qualified alias (namespace + name, identical on both flavors).
     *
     * check:stealth pins this constant against `namespace` in build.gradle,
     * because nothing else would notice them drifting apart until a user
     * tried to turn stealth on.
     */
    private val aliasPackage = "com.thrilla_btc.thrilla"

    private fun component(suffix: String) =
        ComponentName(reactContext.packageName, aliasPackage + suffix)

    /**
     * Which alias is enabled right now, read from the PackageManager rather
     * than from anything this app stored.
     *
     * That matters: the enabled state survives app data being cleared and is
     * the thing the launcher actually obeys, so a value kept in JS storage can
     * disagree with what is on the home screen. The screen that offers to
     * change it has to show what is true, not what was last chosen here.
     *
     * COMPONENT_ENABLED_STATE_DEFAULT means "whatever the manifest says", so
     * it is only the real launcher that reads as enabled under it — the decoys
     * ship `android:enabled="false"`.
     */
    @ReactMethod
    fun getAlias(promise: Promise) {
        try {
            val pm = reactContext.packageManager
            var found = "default"
            for ((key, suffix) in aliases) {
                val state = pm.getComponentEnabledSetting(component(suffix))
                val on = state == PackageManager.COMPONENT_ENABLED_STATE_ENABLED ||
                    (state == PackageManager.COMPONENT_ENABLED_STATE_DEFAULT && suffix == ".Launcher")
                if (on) { found = key; break }
            }
            promise.resolve(found)
        } catch (e: Exception) {
            promise.reject("stealth_read_failed", e.message, e)
        }
    }

    /**
     * Wear [name]'s icon.
     *
     * ENABLE FIRST, DISABLE AFTER. Between the two calls the app briefly has
     * two icons, which is cosmetic and self-correcting. The other order leaves
     * a window with none, and a process killed in that window — by the system,
     * by a low-memory kill, by the user — never reaches the enable call. One
     * ordering is an odd second on the home screen; the other is a wallet that
     * cannot be opened.
     */
    @ReactMethod
    fun setAlias(name: String, promise: Promise) {
        val target = aliases[name]
        if (target == null) {
            // Refused rather than defaulted. Falling back to "default" here
            // would silently turn stealth OFF for a caller that asked for
            // something it thought was a disguise.
            promise.reject("stealth_unknown_alias", "No launcher icon called '$name'.")
            return
        }
        try {
            val pm = reactContext.packageManager

            pm.setComponentEnabledSetting(
                component(target),
                PackageManager.COMPONENT_ENABLED_STATE_ENABLED,
                PackageManager.DONT_KILL_APP
            )

            for ((key, suffix) in aliases) {
                if (key == name) continue
                pm.setComponentEnabledSetting(
                    component(suffix),
                    PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
                    PackageManager.DONT_KILL_APP
                )
            }

            promise.resolve(name)
        } catch (e: Exception) {
            promise.reject("stealth_write_failed", e.message, e)
        }
    }
}
