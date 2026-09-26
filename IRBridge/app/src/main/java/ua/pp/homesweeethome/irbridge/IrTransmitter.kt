package ua.pp.homesweeethome.irbridge

import android.content.Context
import android.hardware.ConsumerIrManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/**
 * Thin, serialised wrapper around [ConsumerIrManager].
 *
 * Two things matter here and nothing else does:
 *
 *  1. `transmit` blocks the calling thread for the whole duration of the
 *     pattern, so it never runs on the main thread.
 *  2. Two overlapping transmits produce garbage on the wire — the A/C sees a
 *     corrupt frame and silently ignores it. A [Mutex] makes the emitter a
 *     single-consumer resource, which is what it physically is.
 */
class IrTransmitter(context: Context) {

    private val manager =
        context.getSystemService(Context.CONSUMER_IR_SERVICE) as? ConsumerIrManager

    private val lock = Mutex()

    val hasEmitter: Boolean get() = manager?.hasIrEmitter() == true

    /** Carrier ranges the hardware admits to supporting, as "min-max" strings. */
    val carrierRanges: List<String>
        get() = runCatching {
            manager?.carrierFrequencies?.map { "${it.minFrequency}-${it.maxFrequency}" }
        }.getOrNull().orEmpty()

    private fun supportsCarrier(hz: Int): Boolean {
        val ranges = runCatching { manager?.carrierFrequencies }.getOrNull() ?: return true
        if (ranges.isEmpty()) return true
        return ranges.any { hz >= it.minFrequency && hz <= it.maxFrequency }
    }

    /**
     * Send [pattern] (alternating mark/space durations in microseconds).
     *
     * @param repeat how many times to send the whole frame. A/C remotes
     *   normally send a frame once; two or three copies costs nothing and
     *   survives a badly aimed phone.
     * @param gapMs quiet time between repeats. Below ~30 ms some receivers
     *   treat the second frame as a continuation of the first.
     */
    suspend fun transmit(
        pattern: IntArray,
        carrierHz: Int = DEFAULT_CARRIER_HZ,
        repeat: Int = 1,
        gapMs: Long = 40,
    ): Result<TransmitReport> = withContext(Dispatchers.IO) {
        val emitter = manager
            ?: return@withContext Result.failure(IrError("no ConsumerIrManager on this device"))
        if (!emitter.hasIrEmitter()) {
            return@withContext Result.failure(IrError("device reports no IR emitter"))
        }

        val clean = sanitise(pattern).getOrElse { return@withContext Result.failure(it) }
        if (!supportsCarrier(carrierHz)) {
            return@withContext Result.failure(
                IrError("carrier ${carrierHz}Hz outside supported ranges $carrierRanges")
            )
        }

        val reps = repeat.coerceIn(1, 10)
        val startedAt = System.currentTimeMillis()

        val failure: Throwable? = lock.withLock {
            var err: Throwable? = null
            for (i in 0 until reps) {
                if (i > 0) delay(gapMs)
                val attempt = runCatching { emitter.transmit(carrierHz, clean) }
                if (attempt.isFailure) {
                    err = attempt.exceptionOrNull()
                    break
                }
            }
            err
        }
        if (failure != null) {
            return@withContext Result.failure(
                IrError("transmit() failed: ${failure.message}", failure)
            )
        }

        Result.success(
            TransmitReport(
                marks = clean.size,
                frameMicros = clean.sum(),
                repeats = reps,
                carrierHz = carrierHz,
                wallMillis = System.currentTimeMillis() - startedAt,
            )
        )
    }

    /**
     * Reject or repair the things that actually go wrong with hand-assembled
     * and database-sourced patterns.
     */
    private fun sanitise(pattern: IntArray): Result<IntArray> {
        if (pattern.isEmpty()) return Result.failure(IrError("empty pattern"))
        if (pattern.any { it <= 0 }) {
            return Result.failure(IrError("pattern contains a non-positive duration"))
        }
        if (pattern.size > MAX_MARKS) {
            return Result.failure(IrError("pattern has ${pattern.size} marks, max $MAX_MARKS"))
        }

        // Drop a trailing space: it is pure dead air, and some emitters refuse
        // an even-length pattern outright.
        var out = pattern
        if (out.size % 2 == 0) out = out.copyOf(out.size - 1)

        val total = out.sum()
        if (total > MAX_FRAME_MICROS) {
            return Result.failure(
                IrError("frame is ${total}us, max ${MAX_FRAME_MICROS}us — likely a decode error")
            )
        }
        return Result.success(out)
    }

    companion object {
        const val DEFAULT_CARRIER_HZ = 38_000

        /** Emitters start failing well before this; it is a sanity bound. */
        const val MAX_MARKS = 1024

        /** 2 s of continuous IR is already absurd for an A/C frame. */
        const val MAX_FRAME_MICROS = 2_000_000
    }
}

class IrError(message: String, cause: Throwable? = null) : Exception(message, cause)

data class TransmitReport(
    val marks: Int,
    val frameMicros: Int,
    val repeats: Int,
    val carrierHz: Int,
    val wallMillis: Long,
)
