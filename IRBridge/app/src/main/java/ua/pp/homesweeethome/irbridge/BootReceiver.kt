package ua.pp.homesweeethome.irbridge

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Restart the bridge after a reboot, so a power cut does not silently take the
 * air conditioner offline until someone notices and opens the app.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        val action = intent?.action ?: return
        if (action != Intent.ACTION_BOOT_COMPLETED &&
            action != "android.intent.action.QUICKBOOT_POWERON"
        ) return

        if (!Prefs(context).autostart) return
        BridgeService.shared.info("boot completed — autostarting bridge")
        BridgeService.start(context)
    }
}
