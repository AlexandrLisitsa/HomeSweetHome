package ua.pp.homesweeethome.irbridge

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import ua.pp.homesweeethome.irbridge.databinding.ActivityMainBinding

/**
 * A control panel, not an app. Everything real happens over HTTP; this screen
 * exists to start the service, show you the URL and token to paste into Home
 * Assistant, and let you watch the log while you point the phone at the A/C.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var b: ActivityMainBinding
    private lateinit var prefs: Prefs
    private val ir by lazy { IrTransmitter(this) }

    private val notificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* advisory */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        b = ActivityMainBinding.inflate(layoutInflater)
        setContentView(b.root)
        prefs = Prefs(this)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }

        b.port.setText(prefs.port.toString())
        b.autostart.isChecked = prefs.autostart
        b.token.text = prefs.token

        b.autostart.setOnCheckedChangeListener { _, checked -> prefs.autostart = checked }

        b.start.setOnClickListener {
            val port = b.port.text.toString().toIntOrNull()
            if (port == null || port < 1024 || port > 65535) {
                toast("Port must be between 1024 and 65535")
                return@setOnClickListener
            }
            prefs.port = port
            BridgeService.start(this)
            b.root.postDelayed({ refresh() }, 600)
        }

        b.stop.setOnClickListener {
            BridgeService.stop(this)
            b.root.postDelayed({ refresh() }, 600)
        }

        b.regenerate.setOnClickListener {
            b.token.text = prefs.regenerateToken()
            toast("New token — update Home Assistant, then restart the service")
        }

        b.copyCurl.setOnClickListener {
            val cmd = """curl -s http://${BridgeService.localIp()}:${prefs.port}/health"""
            copy(cmd)
            toast("Health check copied")
        }

        b.copyToken.setOnClickListener {
            copy(prefs.token)
            toast("Token copied")
        }

        b.battery.setOnClickListener { openBatterySettings() }

        lifecycleScope.launch {
            BridgeService.shared.flow.collectLatest { lines ->
                b.log.text = lines.joinToString("\n")
            }
        }
    }

    override fun onResume() {
        super.onResume()
        refresh()
    }

    private fun refresh() {
        val ip = BridgeService.localIp()
        b.status.text = buildString {
            append(if (BridgeService.running) "● running" else "○ stopped")
            append("\nhttp://").append(ip).append(':').append(prefs.port)
            append("\nIR emitter: ").append(if (ir.hasEmitter) "present" else "NOT FOUND")
            if (ir.carrierRanges.isNotEmpty()) {
                append("\ncarrier Hz: ").append(ir.carrierRanges.joinToString(", "))
            }
        }
        b.start.isEnabled = !BridgeService.running
        b.stop.isEnabled = BridgeService.running
    }

    /**
     * Battery optimisation is the single most common reason a phone-hosted
     * service stops answering after an hour. Send the user straight there.
     */
    private fun openBatterySettings() {
        val direct = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
            .setData(Uri.parse("package:$packageName"))
        val fallback = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
        runCatching { startActivity(direct) }
            .recoverCatching { startActivity(fallback) }
            .onFailure { toast("Open Settings → Battery → unrestricted manually") }
    }

    private fun copy(text: String) {
        val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText("irbridge", text))
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
}
