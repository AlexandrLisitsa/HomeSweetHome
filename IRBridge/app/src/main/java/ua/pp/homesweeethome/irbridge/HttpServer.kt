package ua.pp.homesweeethome.irbridge

import io.ktor.http.HttpStatusCode
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.application.Application
import io.ktor.server.application.ApplicationCall
import io.ktor.server.application.ApplicationCallPipeline
import io.ktor.server.application.call
import io.ktor.server.application.install
import io.ktor.server.cio.CIO
import io.ktor.server.engine.ApplicationEngine
import io.ktor.server.engine.embeddedServer
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.plugins.statuspages.StatusPages
import io.ktor.server.request.path
import io.ktor.server.request.receive
import io.ktor.server.request.receiveText
import io.ktor.server.response.respond
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import io.ktor.server.routing.routing
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.serialization.json.Json

/**
 * The HTTP surface Home Assistant talks to.
 *
 * Everything is POST-with-JSON except the read-only endpoints, because that is
 * what `rest_command` in Home Assistant expresses most cleanly.
 */
class HttpServer(
    private val scope: CoroutineScope,
    private val prefs: Prefs,
    private val ir: IrTransmitter,
    private val repo: CodeRepository,
    private val sweep: SweepController,
    private val ac: AcController,
    private val log: RingLog,
) {

    private var engine: ApplicationEngine? = null
    private val startedAt = System.currentTimeMillis()

    /**
     * The engine's parent scope.
     *
     * The bare `embeddedServer(...)` overload parents the engine on
     * `GlobalScope` with no exception handler, so a bind failure reaches
     * Android's default uncaught-exception handler and kills the process — on
     * top of `start()` throwing. Supervising it here keeps a port conflict to
     * a log line, and keeps an engine failure from cancelling a running sweep.
     *
     * The supervisor is parented on the service's own job, so if [stop] is
     * never reached — an exception on the way out of `onDestroy`, a killed
     * process — the engine still goes down with the service instead of
     * outliving it.
     */
    private val engineScope = CoroutineScope(
        scope.coroutineContext + SupervisorJob(scope.coroutineContext[Job]) +
            CoroutineExceptionHandler { _, t -> log.warn("http engine failed: ${t.message}") }
    )

    /**
     * @throws java.net.BindException if the port is already taken.
     *
     * CIO's `start(wait = false)` awaits its internal startup job before
     * returning, so a bind failure is thrown from here rather than surfacing
     * later inside the engine's own coroutine — which is what lets
     * [BridgeService] catch it and put the reason in the notification.
     */
    fun start(): Int {
        // Idempotent. A second start used to bind again, fail with
        // BindException because the first engine holds the port, and the
        // service's error path then stopped the WORKING server along with it.
        if (engine != null) return boundPort
        val port = prefs.port
        engine = engineScope.embeddedServer(CIO, port = port, host = "0.0.0.0") { module() }
            .also { it.start(wait = false) }
        boundPort = port
        log.info("http server listening on 0.0.0.0:$port")
        return port
    }

    val isRunning: Boolean get() = engine != null

    /** The port the running engine is bound to; prefs.port may have moved since. */
    private var boundPort: Int = 0

    /**
     * Short grace period on purpose: this is called from `onDestroy` on the
     * main thread, and a service has roughly ten seconds before the watchdog
     * takes an interest.
     */
    fun stop() {
        engine?.stop(100, 500)
        engine = null
        log.info("http server stopped")
    }

    private fun Application.module() {
        install(ContentNegotiation) {
            json(Json {
                ignoreUnknownKeys = true
                encodeDefaults = true
                prettyPrint = false
            })
        }

        install(StatusPages) {
            exception<Throwable> { call, cause ->
                val status = if (cause is IrError) HttpStatusCode.BadRequest
                else HttpStatusCode.InternalServerError
                log.warn("${call.request.path()} -> ${cause.javaClass.simpleName}: ${cause.message}")
                call.respond(status, ErrorResponse(error = cause.message ?: cause.toString()))
            }
        }

        // Shared-secret gate. /health stays open so a Home Assistant binary
        // sensor can ping it without carrying credentials around.
        intercept(ApplicationCallPipeline.Plugins) {
            if (call.request.path() == "/health") return@intercept
            val expected = prefs.token
            val provided = call.request.headers[TOKEN_HEADER]
                ?: call.request.queryParameters["token"]
            if (expected.isNotEmpty() && provided != expected) {
                call.respond(HttpStatusCode.Unauthorized, ErrorResponse(error = "bad or missing token"))
                return@intercept finish()
            }
        }

        routing {

            get("/health") {
                call.respond(
                    HealthResponse(
                        ok = true,
                        version = BuildConfig.VERSION_NAME,
                        hasIrEmitter = ir.hasEmitter,
                        carrierRanges = ir.carrierRanges,
                        candidateCount = repo.load().candidates.size,
                        sweepRunning = sweep.isRunning,
                        uptimeSeconds = (System.currentTimeMillis() - startedAt) / 1000,
                    )
                )
            }

            get("/log") {
                val limit = call.request.queryParameters["limit"]?.toIntOrNull() ?: 60
                call.respond(LogResponse(log.snapshot(limit.coerceIn(1, 300))))
            }

            // ------------------------------------------------------- raw sending

            post("/ir/raw") {
                val req = call.receive<RawRequest>()
                val report = ir.transmit(
                    pattern = req.pattern.toIntArray(),
                    carrierHz = req.carrierHz ?: IrTransmitter.DEFAULT_CARRIER_HZ,
                    repeat = req.repeat ?: 1,
                    gapMs = req.gapMs ?: 40,
                ).getOrThrow()
                call.respond(report.toResponse("raw"))
            }

            post("/ir/pronto") {
                val req = call.receive<ProntoRequest>()
                val decoded = Codecs.fromPronto(req.hex)
                val report = ir.transmit(
                    pattern = decoded.pattern,
                    carrierHz = decoded.carrierHz,
                    repeat = req.repeat ?: 1,
                    gapMs = req.gapMs ?: 40,
                ).getOrThrow()
                call.respond(report.toResponse(decoded.format))
            }

            post("/ir/broadlink") {
                val req = call.receive<BroadlinkRequest>()
                val decoded = Codecs.fromBroadlinkBase64(req.base64)
                val report = ir.transmit(
                    pattern = decoded.pattern,
                    carrierHz = decoded.carrierHz,
                    repeat = req.repeat ?: decoded.repeatHint.coerceAtLeast(1),
                    gapMs = req.gapMs ?: 40,
                ).getOrThrow()
                call.respond(report.toResponse(decoded.format))
            }

            // -------------------------------------------------- candidate table

            get("/codes") {
                val q = call.request.queryParameters["q"]
                val offset = call.request.queryParameters["offset"]?.toIntOrNull() ?: 0
                val limit = (call.request.queryParameters["limit"]?.toIntOrNull() ?: 50)
                    .coerceIn(1, 400)
                val all = repo.search(q)
                val page = all.drop(offset).take(limit)
                call.respond(
                    CandidateListResponse(
                        total = all.size,
                        returned = page.size,
                        offset = offset,
                        source = repo.load().source,
                        items = page.map { it.summary() },
                    )
                )
            }

            post("/codes/{idx}/send") {
                val idx = call.parameters["idx"]?.toIntOrNull()
                    ?: throw IrError("path segment must be an integer index")
                val req = call.receiveOrDefault { SendCandidateRequest() }
                val candidate = repo.get(idx)
                val command = req.command ?: "on"
                val pattern = candidate.pattern(command)
                if (pattern.isEmpty()) throw IrError("candidate $idx has no '$command' frame")
                val report = ir.transmit(pattern, repeat = req.repeat ?: 1).getOrThrow()
                log.info("sent [$idx] ${candidate.label} ($command)")
                call.respond(report.toResponse("candidate:$idx:$command"))
            }

            // ------------------------------------------------- stateful A/C control

            get("/ac/capabilities") {
                val set = ac.codes()
                call.respond(
                    AcCapabilitiesResponse(
                        manufacturer = set.manufacturer,
                        setId = set.setId,
                        source = set.source,
                        modes = ac.modes(),
                        fans = set.fans,
                        minTemp = set.minTemp,
                        maxTemp = set.maxTemp,
                        tempStep = set.tempStep,
                        carrierHz = set.carrierHz,
                        frameCount = set.patterns.size,
                        invariants = ac.invariants(),
                        synthesizedModes = ac.synthesizedModes(),
                        swingSupported = ac.isCoolix(),
                    )
                )
            }

            // A read, not a measurement. See AcController: this is what the
            // bridge last sent, not what the unit is doing.
            get("/ac/state") { call.respond(ac.state().toResponse()) }

            post("/ac/set") {
                val req = call.receive<AcSetRequest>()
                val (state, report) = ac.set(
                    power = req.power,
                    mode = req.mode,
                    temp = req.temp,
                    fan = req.fan,
                    repeat = req.repeat ?: 1,
                )
                call.respond(state.toResponse(report.toResponse("ac:${state.hvacMode}")))
            }

            post("/ac/resend") {
                val req = call.receiveOrDefault { AcSetRequest() }
                val (state, report) = ac.resend(repeat = req.repeat ?: 1)
                call.respond(state.toResponse(report.toResponse("ac:resend:${state.hvacMode}")))
            }

            // Swing is not part of the state frame, so it gets its own routes
            // rather than a field on /ac/set. Folding it in would mean every
            // temperature change re-pressed a toggle and reversed the vane.

            post("/ac/swing") {
                val req = call.receiveJsonOrEmpty { AcSwingRequest() }
                val (state, report) = ac.swing(
                    desired = req.on,
                    force = req.force,
                    repeat = req.repeat ?: 1,
                )
                // report is null when the press was judged redundant; the
                // response then carries the state with no `sent` block.
                call.respond(
                    state.toResponse(
                        report?.toResponse("ac:swing:${if (state.swing) "on" else "off"}")
                    )
                )
            }

            post("/ac/swing/step") {
                val req = call.receiveJsonOrEmpty { AcSwingRequest() }
                val report = ac.swingStep(repeat = req.repeat ?: 1)
                call.respond(ac.state().toResponse(report.toResponse("ac:swing:step")))
            }

            // ----------------------------------------------------------- sweeping

            post("/sweep/start") {
                val req = call.receiveOrDefault { SweepStartRequest() }
                call.respond(
                    sweep.start(req.from, req.to, req.delayMs, req.command, req.repeat)
                )
            }

            post("/sweep/step") {
                val req = call.receiveOrDefault { SweepStepRequest() }
                call.respond(sweep.step(req.idx, req.command, req.repeat))
            }

            post("/sweep/stop") { call.respond(sweep.stop()) }

            get("/sweep/status") { call.respond(sweep.status()) }

            post("/sweep/mark") {
                val req = call.receiveOrDefault { MarkRequest() }
                val window = req.windowMs ?: SweepController.REACTION_WINDOW_MS
                val suspects = sweep.mark(window)
                call.respond(
                    MarkResponse(
                        windowMs = window,
                        suspects = suspects,
                        note = if (suspects.isEmpty()) {
                            "nothing was sent in the last ${window}ms"
                        } else {
                            "newest first — retry each with POST /codes/{idx}/send to confirm"
                        },
                    )
                )
            }

            post("/sweep/clear-hits") {
                sweep.clearHits()
                call.respond(sweep.status())
            }
        }
    }

    private fun AcState.toResponse(sent: TransmitResponse? = null) = AcStateResponse(
        power = power,
        hvacMode = hvacMode,
        mode = mode,
        temp = temp,
        fan = fan,
        swing = swing,
        sent = sent,
    )

    private fun TransmitReport.toResponse(format: String) = TransmitResponse(
        format = format,
        marks = marks,
        frameMicros = frameMicros,
        repeats = repeats,
        carrierHz = carrierHz,
        wallMillis = wallMillis,
    )

    companion object {
        const val TOKEN_HEADER = "X-Auth-Token"
    }
}

/**
 * `receive` for endpoints where an empty body is legitimate — Home Assistant's
 * `rest_command` sends `{}` and `curl -XPOST` with no `-d` sends nothing at all.
 *
 * A plain `runCatching` here would also swallow the [CancellationException]
 * raised when a client hangs up mid-body, and the handler would then fire an
 * IR frame based on default values. Cancellation is rethrown.
 */
private suspend inline fun <reified T : Any> ApplicationCall.receiveOrDefault(
    default: () -> T,
): T = try {
    receive<T>()
} catch (c: CancellationException) {
    throw c
} catch (_: Throwable) {
    default()
}

private val bodyJson = Json { ignoreUnknownKeys = true }

/**
 * Strict sibling of [receiveOrDefault], for endpoints where quietly falling
 * back to defaults would actuate the hardware the wrong way.
 *
 * `/ac/swing` with no body means "toggle". That makes an unparseable body
 * indistinguishable from an absent one under [receiveOrDefault] — so
 * `{"on": true}` carrying a stray backslash, which is an easy thing to produce
 * given that PowerShell and every other shell disagree about JSON quoting,
 * would silently become a blind toggle. On a switch that reads as the vane
 * moving the opposite way to the one that was asked for.
 *
 * An absent or empty body still means toggle. A present but broken one is a
 * 400 saying so.
 */
private suspend inline fun <reified T : Any> ApplicationCall.receiveJsonOrEmpty(
    default: () -> T,
): T {
    val text = try {
        receiveText()
    } catch (c: CancellationException) {
        throw c
    } catch (_: Throwable) {
        return default()
    }
    if (text.isBlank()) return default()
    return try {
        bodyJson.decodeFromString<T>(text)
    } catch (c: CancellationException) {
        throw c
    } catch (t: Throwable) {
        throw IrError("body is not valid JSON for this endpoint: ${t.message}")
    }
}
