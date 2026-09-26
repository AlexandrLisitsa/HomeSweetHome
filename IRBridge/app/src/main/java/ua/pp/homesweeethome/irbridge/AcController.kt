package ua.pp.homesweeethome.irbridge

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * The full state table for one A/C protocol.
 *
 * [patterns] is a pool of distinct microsecond frames; [map] and [off] point
 * into it by index. Duplicates are pooled because they are real: on Midea,
 * `heat_cool` emits an identical frame for every fan speed, since the unit
 * picks its own fan in auto mode.
 */
@Serializable
data class AcCodeSet(
    val source: String = "",
    val setId: String = "",
    val manufacturer: String = "",
    val supportedModels: List<String> = emptyList(),
    val carrierHz: Int = 38_000,
    val minTemp: Int = 18,
    val maxTemp: Int = 30,
    val tempStep: Int = 1,
    val modes: List<String> = emptyList(),
    val fans: List<String> = emptyList(),
    /** Index into [patterns] for the power-off frame. */
    val off: Int = -1,
    /** mode -> fan -> temperature -> index into [patterns]. */
    val map: Map<String, Map<String, Map<String, Int>>> = emptyMap(),
    val patterns: List<List<Int>> = emptyList(),
)

/** What the bridge believes the unit is currently set to. */
data class AcState(
    val power: Boolean,
    val mode: String,
    val temp: Int,
    val fan: String,
    /**
     * Whether the vane is believed to be swinging.
     *
     * Carried alongside the rest of the state but *not* part of it: swing is
     * its own standalone message in this protocol, so it never appears in the
     * frame the other four fields produce. See [AcController.swing].
     */
    val swing: Boolean = false,
) {
    /** Home Assistant's climate vocabulary folds power into the mode. */
    val hvacMode: String get() = if (power) mode else "off"
}

/**
 * Stateful control for a single, known A/C protocol.
 *
 * The thing to understand before reading this: **an A/C remote has no deltas.**
 * There is no "temperature up" code. Every button press transmits the entire
 * state — power, mode, temperature, fan — as one frame, and the unit adopts
 * it wholesale. So [set] takes a partial update, merges it onto the last known
 * state, and sends the frame for the *result*. Sending "24 degrees" without
 * also saying "cool, low fan" is not possible at the protocol level.
 *
 * The consequence is that this class holds an *assumed* state, not a real one.
 * `ConsumerIrManager` cannot receive, so there is no way to ask the unit what
 * it is actually doing. Anyone using the physical remote desynchronises us
 * silently. That is inherent to one-way IR; [resend] is the mitigation, not a
 * fix. State is persisted through [Prefs] so a service restart or a reboot
 * does not silently reset the model to defaults while the unit keeps running.
 */
class AcController(
    private val context: Context,
    private val prefs: Prefs,
    private val ir: IrTransmitter,
    private val log: RingLog,
) {

    private val json = Json { ignoreUnknownKeys = true }
    private val lock = Mutex()

    @Volatile
    private var cached: AcCodeSet? = null

    @Volatile
    private var coolix: Boolean? = null

    suspend fun codes(): AcCodeSet {
        cached?.let { return it }
        return withContext(Dispatchers.IO) {
            cached ?: run {
                val text = context.assets.open(ASSET).bufferedReader().use { it.readText() }
                val set = json.decodeFromString<AcCodeSet>(text)
                if (set.off !in set.patterns.indices) {
                    throw IrError("$ASSET has no usable 'off' frame")
                }
                cached = set
                set
            }
        }
    }

    fun state(): AcState = AcState(
        power = prefs.acPower,
        mode = prefs.acMode,
        temp = prefs.acTemp,
        fan = prefs.acFan,
        swing = prefs.acSwing,
    )

    /**
     * Whether frames can be assembled for this code set instead of looked up.
     *
     * Decided by decoding the set's own power-off frame — the one frame known
     * to work on the hardware — and asking whether it is a Coolix message. If
     * it is, the whole set is, and [Codecs.Coolix] can reach combinations the
     * set does not contain. If a future `ac_codes.json` belongs to some other
     * protocol this goes false and the synthesized endpoints refuse, rather
     * than firing invented frames at an air conditioner.
     */
    suspend fun isCoolix(): Boolean {
        coolix?.let { return it }
        val set = codes()
        return Codecs.Coolix.looksLikeCoolix(set.patterns[set.off].toIntArray())
            .also { coolix = it }
    }

    /**
     * Modes [set] will accept: the code set's own, plus any this bridge can
     * build itself. Ordered with the shipped ones first, since those are the
     * ones proven on hardware.
     */
    suspend fun modes(): List<String> {
        val set = codes()
        if (!isCoolix()) return set.modes
        return set.modes + SYNTHETIC_MODES.filterNot { it in set.modes }
    }

    /** The subset of [modes] that no shipped frame backs. */
    suspend fun synthesizedModes(): List<String> {
        if (!isCoolix()) return emptyList()
        val set = codes()
        return SYNTHETIC_MODES.filterNot { it in set.modes }
    }

    /**
     * Merge a partial update onto the current state and transmit the result.
     *
     * A [mode] of `"off"` is accepted as a synonym for `power = false`, because
     * that is how Home Assistant's climate entity expresses it — it has no
     * separate power attribute. The previous mode is kept, so turning the unit
     * back on restores what it was doing rather than snapping to a default.
     */
    suspend fun set(
        power: Boolean? = null,
        mode: String? = null,
        temp: Int? = null,
        fan: String? = null,
        repeat: Int = 1,
    ): Pair<AcState, TransmitReport> = lock.withLock {
        val set = codes()
        val current = state()

        val requestedMode = mode?.lowercase()?.trim()
        val modeIsOff = requestedMode == "off"

        val next = AcState(
            power = when {
                modeIsOff -> false
                power != null -> power
                // Naming a mode is an implicit "and turn it on" — a climate
                // card sends hvac_mode=cool to start cooling, not to arm a
                // mode for later.
                requestedMode != null -> true
                else -> current.power
            },
            mode = if (requestedMode != null && !modeIsOff) requestedMode else current.mode,
            temp = temp ?: current.temp,
            fan = fan?.lowercase()?.trim() ?: current.fan,
            // Carried through untouched. A state frame cannot express swing,
            // so sending one neither starts nor stops it.
            swing = current.swing,
        ).let { validate(set, modes(), it) }

        val pattern = resolve(set, next)
        val report = ir.transmit(
            pattern = pattern,
            carrierHz = set.carrierHz,
            repeat = repeat,
        ).getOrThrow()

        prefs.acPower = next.power
        prefs.acMode = next.mode
        prefs.acTemp = next.temp
        prefs.acFan = next.fan

        log.info(
            if (next.power) "ac ${next.mode} ${next.temp}C fan=${next.fan}"
            else "ac off"
        )
        next to report
    }

    /**
     * Re-assert the current state. The standard fix for a drifted model.
     *
     * Note what this deliberately leaves alone: swing. Re-asserting a toggle
     * would *reverse* it, so a resend that "fixed" everything would break the
     * one thing it touched. [swing] has to be driven explicitly.
     */
    suspend fun resend(repeat: Int = 1): Pair<AcState, TransmitReport> =
        set(repeat = repeat)

    /**
     * Start or stop the vane swinging.
     *
     * Coolix has no "swing on" — only a toggle, and it travels as its own
     * complete message rather than as a bit inside the state frame. Two things
     * follow from that, both of which shape this signature:
     *
     *  - it must never be folded into [set] or [resend], because a second
     *     press undoes the first. [resolve] never reads [AcState.swing];
     *  - "on" is a request to *reach* a state, not a command. A Home Assistant
     *    switch sends on and off explicitly, so [desired] lets a caller skip a
     *    press the bridge believes is redundant instead of reversing the vane.
     *    Pass null to toggle unconditionally, which is the honest option when
     *    nobody knows where the vane is.
     *
     * [force] presses regardless of the remembered flag — the escape hatch for
     * when someone has used the physical remote and the belief is stale. The
     * returned report is null when nothing was transmitted.
     */
    suspend fun swing(
        desired: Boolean? = null,
        force: Boolean = false,
        repeat: Int = 1,
    ): Pair<AcState, TransmitReport?> = lock.withLock {
        requireCoolix("swing")
        val current = state()

        if (desired != null && desired == current.swing && !force) {
            log.info("ac swing already ${onOff(desired)}, nothing sent")
            return@withLock current to null
        }

        val report = ir.transmit(
            pattern = Codecs.Coolix.press(Codecs.Coolix.SWING),
            carrierHz = codes().carrierHz,
            repeat = repeat,
        ).getOrThrow()

        val next = current.copy(swing = desired ?: !current.swing)
        prefs.acSwing = next.swing
        log.info("ac swing -> ${onOff(next.swing)}")
        next to report
    }

    /**
     * Nudge the vertical vane one position along.
     *
     * Stateless by nature — the step wraps around and the unit reports nothing,
     * so there is no flag worth keeping. Useful for parking the vane somewhere
     * specific, which continuous swing cannot do.
     */
    suspend fun swingStep(repeat: Int = 1): TransmitReport = lock.withLock {
        requireCoolix("swing step")
        ir.transmit(
            pattern = Codecs.Coolix.press(Codecs.Coolix.SWING_V_STEP),
            carrierHz = codes().carrierHz,
            repeat = repeat,
        ).getOrThrow().also { log.info("ac swing step") }
    }

    private suspend fun requireCoolix(what: String) {
        if (!isCoolix()) {
            val set = codes()
            throw IrError(
                "$what is assembled from the Coolix protocol, but $ASSET " +
                    "(${set.manufacturer} set ${set.setId}) does not decode as " +
                    "Coolix — refusing to send an invented frame"
            )
        }
    }

    private fun onOff(b: Boolean) = if (b) "on" else "off"

    /**
     * Which axes a mode genuinely ignores, derived from the frames rather than
     * assumed.
     *
     * If every fan speed in a mode resolves to the same frame, the protocol
     * does not encode fan for that mode and the control is decorative. Saying
     * so beats letting someone conclude the bridge is broken.
     */
    suspend fun invariants(): List<String> {
        val set = codes()
        val out = mutableListOf<String>()
        for ((mode, byFan) in set.map) {
            val fanKeys = byFan.keys.filter { it != "_" }
            if (fanKeys.size > 1) {
                val perFan = fanKeys.map { byFan.getValue(it) }
                if (perFan.all { it == perFan.first() }) out += "$mode: fan ignored"
            }
            val tempRefs = byFan.values.flatMap { it.entries }
                .filter { it.key != "_" }
                .map { it.value }
            if (tempRefs.size > 1 && tempRefs.all { it == tempRefs.first() }) {
                out += "$mode: temperature ignored"
            }
        }
        // A synthesized mode has no shipped frames to compare, so what it
        // ignores is a property of the encoder instead of something derived.
        // See AcController.synthesize for why dry pins the fan field.
        for (mode in synthesizedModes()) {
            if (mode == "dry") out += "dry: fan ignored"
        }
        return out
    }

    /**
     * Reject nonsense loudly rather than silently sending the wrong frame.
     * Temperature is clamped instead — a thermostat card that slides to 31
     * means "as cold as you go", and refusing it is less useful than obeying
     * the nearest thing the protocol can express.
     */
    private fun validate(set: AcCodeSet, allowedModes: List<String>, s: AcState): AcState {
        if (s.mode !in allowedModes) {
            throw IrError("unknown mode '${s.mode}' (have ${allowedModes.joinToString("|")}, or 'off')")
        }
        if (set.fans.isNotEmpty() && s.fan !in set.fans) {
            throw IrError("unknown fan '${s.fan}' (have ${set.fans.joinToString("|")})")
        }
        return s.copy(temp = s.temp.coerceIn(set.minTemp, set.maxTemp))
    }

    private fun resolve(set: AcCodeSet, s: AcState): IntArray {
        if (!s.power) return set.patterns[set.off].toIntArray()
        if (s.mode !in set.modes) return synthesize(s)

        val byFan = set.map[s.mode]
            ?: throw IrError("no frames for mode '${s.mode}'")
        // "_" is the placeholder this set's generator uses for an axis the
        // protocol does not vary on.
        val byTemp = byFan[s.fan] ?: byFan["_"]
            ?: throw IrError("no frames for ${s.mode}/${s.fan}")
        val ref = byTemp[s.temp.toString()] ?: byTemp["_"]
            ?: throw IrError("no frame for ${s.mode}/${s.fan}/${s.temp}")

        return set.patterns.getOrNull(ref)?.toIntArray()
            ?: throw IrError("frame index $ref is outside the pattern pool")
    }

    /**
     * Build a frame for a mode the code set does not ship.
     *
     * Reached only for [SYNTHETIC_MODES], and only once [isCoolix] has agreed,
     * so the encoding below is the same one that reproduces all 156 shipped
     * frames exactly.
     *
     * Dry ignores fan on purpose. Coolix pins the fan field to
     * [Codecs.Coolix.FAN_AUTO0] in both dry and auto, exactly as this set's own
     * `heat_cool` frames do — so honouring a fan request here would mean
     * emitting a frame no real remote produces.
     */
    private fun synthesize(s: AcState): IntArray {
        val value = when (s.mode) {
            "dry" -> Codecs.Coolix.stateFrame(
                mode = Codecs.Coolix.MODE_DRY,
                fan = Codecs.Coolix.FAN_AUTO0,
                tempCode = Codecs.Coolix.tempCode(s.temp),
            )
            else -> throw IrError("no way to assemble a frame for mode '${s.mode}'")
        }
        return Codecs.Coolix.press(value)
    }

    companion object {
        const val ASSET = "ac_codes.json"

        /**
         * Modes reachable by encoding the protocol rather than by looking up a
         * shipped frame. SmartIR's tables carry mode x fan x temperature only,
         * so dry — a plain mode bit on the wire — is simply missing from them.
         */
        val SYNTHETIC_MODES = listOf("dry")
    }
}
