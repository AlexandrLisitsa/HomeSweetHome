package ua.pp.homesweeethome.irbridge

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Walks the candidate table one frame at a time so you can sit in front of the
 * A/C and watch for the beep.
 *
 * The design point that matters: **you will react late.** By the time you have
 * registered a beep and tapped a button, the sweep has moved on. So the
 * controller keeps a timestamped trail of what it just sent, and `mark`
 * returns the whole window of plausible culprits rather than a single index.
 * Narrowing three candidates by hand takes seconds; restarting a 20-minute
 * sweep because the index was off by two does not.
 */
class SweepController(
    private val scope: CoroutineScope,
    private val repo: CodeRepository,
    private val ir: IrTransmitter,
    private val log: RingLog,
) {

    @Serializable
    data class Sent(
        val idx: Int,
        val label: String,
        val atEpochMs: Long,
        val ok: Boolean,
        val detail: String = "",
    )

    @Serializable
    data class Status(
        val running: Boolean,
        val command: String,
        val cursor: Int,
        val from: Int,
        val to: Int,
        val sentCount: Int,
        val failedCount: Int,
        val delayMs: Long,
        val recent: List<Sent>,
        val hits: List<Sent>,
        val etaSeconds: Long,
    )

    private val trail = CopyOnWriteArrayList<Sent>()
    private val hits = CopyOnWriteArrayList<Sent>()

    @Volatile private var job: Job? = null
    @Volatile private var cursor = 0
    @Volatile private var from = 0
    @Volatile private var to = 0
    @Volatile private var command = "on"
    @Volatile private var delayMs = DEFAULT_DELAY_MS
    @Volatile private var failed = 0

    val isRunning: Boolean get() = job?.isActive == true

    suspend fun start(
        from: Int?,
        to: Int?,
        delayMs: Long?,
        command: String?,
        repeat: Int?,
    ): Status {
        if (isRunning) throw IrError("a sweep is already running — stop it first")

        val all = repo.load().candidates
        if (all.isEmpty()) throw IrError("candidate table is empty")

        this.command = (command ?: "on").lowercase()
        if (this.command !in setOf("on", "off")) {
            throw IrError("command must be 'on' or 'off'")
        }
        this.from = (from ?: 0).coerceIn(0, all.size - 1)
        this.to = (to ?: (all.size - 1)).coerceIn(this.from, all.size - 1)
        this.delayMs = (delayMs ?: DEFAULT_DELAY_MS).coerceIn(500L, 60_000L)
        this.cursor = this.from
        this.failed = 0
        trail.clear()

        val reps = (repeat ?: 1).coerceIn(1, 3)
        log.info("sweep: ${this.from}..${this.to} cmd=${this.command} delay=${this.delayMs}ms")

        job = scope.launch {
            try {
                while (isActive && cursor <= this@SweepController.to) {
                    sendOne(all[cursor], reps)
                    cursor++
                    if (cursor <= this@SweepController.to) delay(this@SweepController.delayMs)
                }
                log.info("sweep finished at idx=${cursor - 1}")
            } catch (t: Throwable) {
                log.warn("sweep aborted: ${t.message}")
                throw t
            }
        }
        return status()
    }

    /** Send exactly one candidate and advance. Useful for a careful manual pass. */
    suspend fun step(idx: Int?, command: String?, repeat: Int?): Status {
        if (isRunning) throw IrError("a sweep is running — stop it first")
        val all = repo.load().candidates
        if (all.isEmpty()) throw IrError("candidate table is empty")
        val target = (idx ?: cursor).coerceIn(0, all.size - 1)
        this.command = (command ?: this.command).lowercase()
        cursor = target
        sendOne(all[target], (repeat ?: 1).coerceIn(1, 3))
        cursor = (target + 1).coerceAtMost(all.size - 1)
        return status()
    }

    private suspend fun sendOne(c: Candidate, reps: Int) {
        val pattern = runCatching { c.pattern(command) }.getOrElse {
            record(c, false, it.message ?: "no pattern")
            return
        }
        if (pattern.isEmpty()) {
            record(c, false, "no '$command' frame in this set")
            return
        }
        ir.transmit(pattern, repeat = reps).fold(
            onSuccess = { record(c, true, "${it.marks} marks, ${it.frameMicros}us") },
            onFailure = { record(c, false, it.message ?: "transmit failed") },
        )
    }

    private fun record(c: Candidate, ok: Boolean, detail: String) {
        if (!ok) failed++
        val s = Sent(c.idx, c.label, System.currentTimeMillis(), ok, detail)
        trail.add(0, s)
        while (trail.size > TRAIL_SIZE) trail.removeAt(trail.size - 1)
        log.info("${if (ok) "tx" else "!!"} [${c.idx}] ${c.label} — $detail")
    }

    fun stop(): Status {
        job?.cancel()
        job = null
        log.info("sweep stopped at idx=$cursor")
        return status()
    }

    /**
     * "That one did something." Returns every frame sent inside the reaction
     * window, newest first — the hit is almost always the second or third
     * entry, not the first.
     */
    fun mark(windowMs: Long = REACTION_WINDOW_MS): List<Sent> {
        val cutoff = System.currentTimeMillis() - windowMs
        val window = trail.filter { it.atEpochMs >= cutoff && it.ok }.take(MARK_WINDOW_MAX)
        window.forEach { s -> if (hits.none { it.idx == s.idx }) hits.add(s) }
        log.info("MARK -> ${window.joinToString { "[${it.idx}] ${it.label}" }}")
        return window
    }

    fun clearHits() {
        hits.clear()
    }

    fun status(): Status {
        val remaining = (to - cursor).coerceAtLeast(0)
        return Status(
            running = isRunning,
            command = command,
            cursor = cursor,
            from = from,
            to = to,
            sentCount = trail.size,
            failedCount = failed,
            delayMs = delayMs,
            recent = trail.take(TRAIL_SIZE),
            hits = hits.toList(),
            etaSeconds = if (isRunning) remaining * delayMs / 1000 else 0,
        )
    }

    companion object {
        /** Long enough to see the A/C react, short enough to finish in one sitting. */
        const val DEFAULT_DELAY_MS = 4_000L

        /** How far back `mark` looks. Roughly two sweep steps plus human lag. */
        const val REACTION_WINDOW_MS = 12_000L

        const val MARK_WINDOW_MAX = 5
        const val TRAIL_SIZE = 20
    }
}
