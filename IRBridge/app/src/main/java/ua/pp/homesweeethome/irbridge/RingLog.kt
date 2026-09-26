package ua.pp.homesweeethome.irbridge

import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.ConcurrentLinkedDeque

/**
 * A small in-memory log the UI and `GET /log` can both read.
 *
 * When the phone is taped to a shelf pointing at an air conditioner, `adb
 * logcat` is not where you want to be reading from.
 */
class RingLog(private val capacity: Int = 300) {

    private val lines = ConcurrentLinkedDeque<String>()
    private val _flow = MutableStateFlow<List<String>>(emptyList())
    val flow: StateFlow<List<String>> = _flow

    /**
     * Per-thread, because this log is written from Ktor's CIO workers, the
     * sweep coroutine and the service at the same time — and a shared
     * [SimpleDateFormat] corrupts its internal Calendar under concurrency and
     * throws from inside `format`.
     */
    private val stamp = ThreadLocal.withInitial {
        SimpleDateFormat("HH:mm:ss.SSS", Locale.US)
    }

    fun info(msg: String) = add("I", msg)
    fun warn(msg: String) = add("W", msg)

    private fun add(level: String, msg: String) {
        val line = "${stamp.get()!!.format(Date())} $level $msg"
        lines.addFirst(line)
        while (lines.size > capacity) lines.pollLast()
        _flow.value = lines.toList()
        if (level == "W") Log.w(TAG, msg) else Log.i(TAG, msg)
    }

    fun snapshot(limit: Int = 100): List<String> = lines.take(limit)

    companion object {
        const val TAG = "IrBridge"
    }
}
