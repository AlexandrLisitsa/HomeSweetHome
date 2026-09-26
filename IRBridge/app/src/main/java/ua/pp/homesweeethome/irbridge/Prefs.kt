package ua.pp.homesweeethome.irbridge

import android.content.Context
import java.security.SecureRandom

/**
 * Two settings and a shared secret. Nothing here is worth a database.
 */
class Prefs(context: Context) {

    private val sp = context.getSharedPreferences("irbridge", Context.MODE_PRIVATE)

    var port: Int
        get() = sp.getInt(KEY_PORT, DEFAULT_PORT)
        set(v) = sp.edit().putInt(KEY_PORT, v.coerceIn(1024, 65535)).apply()

    var autostart: Boolean
        get() = sp.getBoolean(KEY_AUTOSTART, true)
        set(v) = sp.edit().putBoolean(KEY_AUTOSTART, v).apply()

    /**
     * A bearer token, generated once on first run.
     *
     * This is a LAN service with no TLS, so the token stops a stray script or
     * a guest on the wifi from cycling your air conditioner. It is not
     * protection against someone already sniffing your network — for that,
     * keep the phone on an IoT VLAN.
     */
    var token: String
        get() {
            sp.getString(KEY_TOKEN, null)?.let { return it }
            val fresh = generateToken()
            sp.edit().putString(KEY_TOKEN, fresh).apply()
            return fresh
        }
        set(v) = sp.edit().putString(KEY_TOKEN, v).apply()

    fun regenerateToken(): String = generateToken().also { token = it }

    // --- assumed A/C state ---------------------------------------------------
    //
    // Persisted because the bridge can only ever *assume* what the unit is
    // doing — IR is write-only. If this reset to defaults on every service
    // restart, a reboot would leave Home Assistant showing "off, 24C" while
    // the A/C carried on cooling at 18. Wrong-but-remembered beats
    // wrong-and-forgotten: at least the next command starts from the last
    // thing we actually sent.

    var acPower: Boolean
        get() = sp.getBoolean(KEY_AC_POWER, false)
        set(v) = sp.edit().putBoolean(KEY_AC_POWER, v).apply()

    var acMode: String
        get() = sp.getString(KEY_AC_MODE, DEFAULT_AC_MODE) ?: DEFAULT_AC_MODE
        set(v) = sp.edit().putString(KEY_AC_MODE, v).apply()

    var acTemp: Int
        get() = sp.getInt(KEY_AC_TEMP, DEFAULT_AC_TEMP)
        set(v) = sp.edit().putInt(KEY_AC_TEMP, v).apply()

    var acFan: String
        get() = sp.getString(KEY_AC_FAN, DEFAULT_AC_FAN) ?: DEFAULT_AC_FAN
        set(v) = sp.edit().putString(KEY_AC_FAN, v).apply()

    /**
     * The weakest belief in here.
     *
     * Everything above is remembered because we *sent* it. Swing is a toggle
     * with no "set to on" form, so this is a guess about which end of a toggle
     * the unit is on, and one press from the physical remote inverts it
     * without telling us. It is still worth keeping: an inverted flag makes a
     * Home Assistant switch feel backwards, whereas no flag at all makes the
     * switch impossible to build.
     */
    var acSwing: Boolean
        get() = sp.getBoolean(KEY_AC_SWING, false)
        set(v) = sp.edit().putBoolean(KEY_AC_SWING, v).apply()

    private fun generateToken(): String {
        val bytes = ByteArray(16)
        SecureRandom().nextBytes(bytes)
        return bytes.joinToString("") { "%02x".format(it) }
    }

    companion object {
        const val DEFAULT_PORT = 8765
        private const val KEY_PORT = "port"
        private const val KEY_TOKEN = "token"
        private const val KEY_AUTOSTART = "autostart"

        const val DEFAULT_AC_MODE = "cool"
        const val DEFAULT_AC_TEMP = 24
        const val DEFAULT_AC_FAN = "mid"
        private const val KEY_AC_POWER = "ac_power"
        private const val KEY_AC_MODE = "ac_mode"
        private const val KEY_AC_TEMP = "ac_temp"
        private const val KEY_AC_FAN = "ac_fan"
        private const val KEY_AC_SWING = "ac_swing"
    }
}
