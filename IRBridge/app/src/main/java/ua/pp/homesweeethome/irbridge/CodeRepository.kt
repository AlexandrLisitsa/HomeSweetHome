package ua.pp.homesweeethome.irbridge

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

@Serializable
data class CandidateSet(
    val source: String = "",
    val tickMicros: Double = 0.0,
    val carrierHz: Int = 38_000,
    val count: Int = 0,
    val candidates: List<Candidate> = emptyList(),
)

@Serializable
data class Candidate(
    val idx: Int,
    val id: String,
    val manufacturer: String,
    val models: List<String> = emptyList(),
    /** A representative "turn on, cool, mid fan, mid temp" frame, in µs. */
    val on: List<Int> = emptyList(),
    /** The power-off frame, in µs. May be empty for a few sets. */
    val off: List<Int> = emptyList(),
) {
    fun pattern(command: String): IntArray = when (command.lowercase()) {
        "on" -> on.toIntArray()
        "off" -> off.toIntArray()
        else -> throw IrError("unknown command '$command' (use on|off)")
    }

    val label: String
        get() = buildString {
            append(manufacturer)
            if (models.isNotEmpty()) append(" (").append(models.joinToString(", ")).append(")")
        }
}

/**
 * The bundled brute-force table: one representative frame per distinct A/C
 * protocol found in the SmartIR database, ordered so the families most likely
 * to answer a Daewoo split unit come first.
 *
 * There is no Daewoo entry in any public database — that is the whole reason
 * this table exists. Daewoo split units are OEM builds, so the working code
 * is almost always some other brand's protocol.
 */
class CodeRepository(private val context: Context) {

    private val json = Json { ignoreUnknownKeys = true }

    @Volatile
    private var cached: CandidateSet? = null

    suspend fun load(): CandidateSet {
        cached?.let { return it }
        return withContext(Dispatchers.IO) {
            cached ?: run {
                val text = context.assets.open(ASSET).bufferedReader().use { it.readText() }
                json.decodeFromString<CandidateSet>(text).also { cached = it }
            }
        }
    }

    suspend fun get(idx: Int): Candidate {
        val set = load()
        return set.candidates.firstOrNull { it.idx == idx }
            ?: throw IrError("no candidate with idx=$idx (have 0..${set.candidates.size - 1})")
    }

    suspend fun search(query: String?): List<Candidate> {
        val all = load().candidates
        if (query.isNullOrBlank()) return all
        val q = query.trim().lowercase()
        return all.filter { c ->
            c.manufacturer.lowercase().contains(q) ||
                c.models.any { it.lowercase().contains(q) } ||
                c.id == q
        }
    }

    companion object {
        const val ASSET = "candidates.json"
    }
}
