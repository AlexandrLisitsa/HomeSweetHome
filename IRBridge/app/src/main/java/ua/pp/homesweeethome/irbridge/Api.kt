package ua.pp.homesweeethome.irbridge

import kotlinx.serialization.Serializable

// ------------------------------------------------------------------- requests

@Serializable
data class RawRequest(
    /** Alternating mark/space durations in microseconds. */
    val pattern: List<Int>,
    val carrierHz: Int? = null,
    val repeat: Int? = null,
    val gapMs: Long? = null,
)

@Serializable
data class ProntoRequest(
    val hex: String,
    val repeat: Int? = null,
    val gapMs: Long? = null,
)

@Serializable
data class BroadlinkRequest(
    val base64: String,
    val repeat: Int? = null,
    val gapMs: Long? = null,
)

@Serializable
data class SendCandidateRequest(
    val command: String? = null,
    val repeat: Int? = null,
)

@Serializable
data class SweepStartRequest(
    val from: Int? = null,
    val to: Int? = null,
    val delayMs: Long? = null,
    val command: String? = null,
    val repeat: Int? = null,
)

@Serializable
data class SweepStepRequest(
    val idx: Int? = null,
    val command: String? = null,
    val repeat: Int? = null,
)

@Serializable
data class MarkRequest(val windowMs: Long? = null)

/**
 * Every field is optional and merged onto the bridge's current assumed state.
 *
 * That is not laziness about validation — it mirrors the hardware. The unit
 * has no notion of "change only the temperature"; the frame carries the whole
 * state either way. Letting a caller send `{"temp": 23}` and have the bridge
 * fill in the rest is the only way a Home Assistant thermostat card can work.
 *
 * `mode: "off"` is accepted as a synonym for `power: false`, matching how a
 * climate entity expresses it.
 */
@Serializable
data class AcSetRequest(
    val power: Boolean? = null,
    val mode: String? = null,
    val temp: Int? = null,
    val fan: String? = null,
    val repeat: Int? = null,
)

/**
 * Swing is a toggle with no readback, so "on" is a request to reach a state
 * rather than a command that expresses one.
 *
 * Omit [on] to toggle unconditionally — the honest choice when nobody knows
 * where the vane is. Set it and the bridge skips a press it believes would be
 * redundant, which is what makes a Home Assistant switch behave. [force]
 * presses anyway, for when the physical remote has been used and the
 * remembered flag is stale.
 */
@Serializable
data class AcSwingRequest(
    val on: Boolean? = null,
    val force: Boolean = false,
    val repeat: Int? = null,
)

// ------------------------------------------------------------------ responses

@Serializable
data class HealthResponse(
    val ok: Boolean,
    val version: String,
    val hasIrEmitter: Boolean,
    val carrierRanges: List<String>,
    val candidateCount: Int,
    val sweepRunning: Boolean,
    val uptimeSeconds: Long,
)

@Serializable
data class TransmitResponse(
    val ok: Boolean = true,
    val format: String,
    val marks: Int,
    val frameMicros: Int,
    val repeats: Int,
    val carrierHz: Int,
    val wallMillis: Long,
)

@Serializable
data class CandidateSummary(
    val idx: Int,
    val id: String,
    val manufacturer: String,
    val models: List<String>,
    val onMarks: Int,
    val hasOff: Boolean,
)

@Serializable
data class CandidateListResponse(
    val total: Int,
    val returned: Int,
    val offset: Int,
    val source: String,
    val items: List<CandidateSummary>,
)

@Serializable
data class MarkResponse(
    val ok: Boolean = true,
    val windowMs: Long,
    val suspects: List<SweepController.Sent>,
    val note: String,
)

@Serializable
data class AcStateResponse(
    val ok: Boolean = true,
    val power: Boolean,
    /** `off` when powered down, otherwise the operating mode. */
    val hvacMode: String,
    val mode: String,
    val temp: Int,
    val fan: String,
    /**
     * Believed swing state. Weaker than the fields above — see [Prefs.acSwing].
     * Never affected by `/ac/set` or `/ac/resend`.
     */
    val swing: Boolean,
    /**
     * Absent on a plain state read, and also when a swing call decided the
     * press would be redundant and sent nothing.
     */
    val sent: TransmitResponse? = null,
)

@Serializable
data class AcCapabilitiesResponse(
    val ok: Boolean = true,
    val manufacturer: String,
    val setId: String,
    val source: String,
    val modes: List<String>,
    val fans: List<String>,
    val minTemp: Int,
    val maxTemp: Int,
    val tempStep: Int,
    val carrierHz: Int,
    val frameCount: Int,
    /**
     * Axes this protocol ignores, e.g. `heat_cool` emitting the same frame
     * for every fan speed. Surfaced so a UI can grey the control out rather
     * than letting someone wonder why the button does nothing.
     */
    val invariants: List<String>,
    /**
     * The entries in [modes] that no shipped frame backs — assembled by
     * encoding the protocol directly, because SmartIR's tables cover
     * mode x fan x temperature and nothing else.
     *
     * Reported separately because it is a genuinely different level of
     * confidence: everything else here came from frames that shipped with
     * SmartIR, and these did not.
     */
    val synthesizedModes: List<String> = emptyList(),
    /** Whether `/ac/swing` and `/ac/swing/step` will do anything. */
    val swingSupported: Boolean = false,
)

@Serializable
data class LogResponse(val lines: List<String>)

@Serializable
data class ErrorResponse(val ok: Boolean = false, val error: String)

fun Candidate.summary() = CandidateSummary(
    idx = idx,
    id = id,
    manufacturer = manufacturer,
    models = models,
    onMarks = on.size,
    hasOff = off.isNotEmpty(),
)
