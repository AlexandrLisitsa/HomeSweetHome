package ua.pp.homesweeethome.irbridge

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.lifecycle.LifecycleService
import androidx.lifecycle.lifecycleScope
import java.net.Inet4Address
import java.net.NetworkInterface

/**
 * Keeps the HTTP listener alive.
 *
 * On a 2018 phone running Android 10 this is the part that actually decides
 * whether the project works. Three things fight you:
 *
 *  - **Doze.** A screen-off, unplugged phone suspends the wifi radio. A
 *    partial wake lock plus a high-perf wifi lock keeps the socket answerable.
 *  - **Battery optimisation.** Even a foreground service gets frozen if the
 *    app is "optimised". [MainActivity] walks you to the exemption screen.
 *  - **Wifi power save.** Some routers age out the ARP entry for a sleeping
 *    phone. A static DHCP lease on the router side is the real fix.
 *
 * Leave the phone on the charger. An always-on IR bridge is a mains-powered
 * appliance that happens to be shaped like a phone.
 */
class BridgeService : LifecycleService() {

    private lateinit var prefs: Prefs
    private lateinit var log: RingLog
    private lateinit var ir: IrTransmitter
    private lateinit var repo: CodeRepository
    private lateinit var sweep: SweepController
    private lateinit var ac: AcController
    private lateinit var server: HttpServer

    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null

    override fun onCreate() {
        super.onCreate()
        prefs = Prefs(this)
        log = shared
        ir = IrTransmitter(this)
        repo = CodeRepository(this)
        sweep = SweepController(lifecycleScope, repo, ir, log)
        ac = AcController(this, prefs, ir, log)
        server = HttpServer(lifecycleScope, prefs, ir, repo, sweep, ac, log)

        log.info("service starting; irEmitter=${ir.hasEmitter} carriers=${ir.carrierRanges}")
        if (!ir.hasEmitter) {
            log.warn("this device reports NO IR emitter — /ir/* will fail")
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)

        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }

        val port = runCatching { server.start() }.getOrElse {
            log.warn("could not bind port ${prefs.port}: ${it.message}")
            startForeground(NOTIFICATION_ID, buildNotification("Failed to bind port ${prefs.port}"))
            stopSelf()
            return START_NOT_STICKY
        }

        acquireLocks()
        startForeground(NOTIFICATION_ID, buildNotification("Listening on ${localIp()}:$port"))
        running = true
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        runCatching { sweep.stop() }
        runCatching { server.stop() }
        releaseLocks()
        log.info("service stopped")
        super.onDestroy()
    }

    override fun onBind(intent: Intent): IBinder? {
        super.onBind(intent)
        return null
    }

    // ------------------------------------------------------------------- locks

    private fun acquireLocks() {
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "irbridge:cpu").apply {
            setReferenceCounted(false)
            acquire()
        }
        val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            WifiManager.WIFI_MODE_FULL_LOW_LATENCY
        } else {
            @Suppress("DEPRECATION")
            WifiManager.WIFI_MODE_FULL_HIGH_PERF
        }
        wifiLock = wm.createWifiLock(mode, "irbridge:wifi").apply {
            setReferenceCounted(false)
            acquire()
        }
        log.info("wake + wifi locks held")
    }

    private fun releaseLocks() {
        runCatching { wakeLock?.takeIf { it.isHeld }?.release() }
        runCatching { wifiLock?.takeIf { it.isHeld }?.release() }
        wakeLock = null
        wifiLock = null
    }

    // ------------------------------------------------------------ notification

    private fun buildNotification(text: String): Notification {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "IR bridge",
                NotificationManager.IMPORTANCE_LOW,
            ).apply { description = "Keeps the HTTP-to-infrared bridge running" }
            (getSystemService(NotificationManager::class.java)).createNotificationChannel(channel)
        }

        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val stop = PendingIntent.getService(
            this,
            1,
            Intent(this, BridgeService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("IR bridge")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(open)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Stop", stop)
            .build()
    }

    companion object {
        const val CHANNEL_ID = "irbridge"
        const val NOTIFICATION_ID = 42
        const val ACTION_STOP = "ua.pp.homesweeethome.irbridge.STOP"

        /**
         * The log outlives any single service instance so the UI can show what
         * happened during a crash-and-restart.
         */
        val shared = RingLog()

        @Volatile
        var running: Boolean = false
            private set

        fun start(context: Context) {
            val intent = Intent(context, BridgeService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.startService(
                Intent(context, BridgeService::class.java).setAction(ACTION_STOP)
            )
        }

        /** First non-loopback IPv4 address, which on this phone is the wifi one. */
        fun localIp(): String = runCatching {
            NetworkInterface.getNetworkInterfaces().asSequence()
                .filter { it.isUp && !it.isLoopback }
                .flatMap { it.inetAddresses.asSequence() }
                .filterIsInstance<Inet4Address>()
                .firstOrNull()?.hostAddress
        }.getOrNull() ?: "0.0.0.0"
    }
}
