# What is verified, and what isn't

`tools/verify_codecs.py` is a line-for-line Python mirror of `Codecs.kt` with
19 assertions, all passing. It checks the decoders against **real protocol
timings rather than against themselves**: a SmartIR Midea frame must come out
as a 4400/4400 header with 560/560 and 560/1680 bits, a Gree one as 9000/4500,
a Daikin one as 3500/1700 — which is what those protocols actually specify. It
also checks the `0x00 hi lo` escape decodes big-endian, that RF (`0xb2`)
packets are refused rather than silently mangled, that unpadded base64 still
decodes, and that all 315 bundled frames survive `IrTransmitter.sanitise`
(odd length, no non-positive durations, under 2 s, under 1024 marks).

```bash
python3 tools/verify_codecs.py     # 19/19 pass with a SmartIR checkout
```

The checks against real SmartIR frames need a checkout at `/tmp/SmartIR` (see
below); without one they are skipped and the rest (9) still run.

Both Home Assistant YAML files are parse-checked.

The Kotlin is built by Gradle in CI: the `IRBridge Android build` job runs
`./gradlew :app:assembleDebug` on every push, so a change that does not
compile does not merge. Before Gradle was available, the sandbox this was
first written in had no Android SDK and no Maven access, so the eleven `.kt`
files of the time (twelve now, with `AcController.kt`) were compiled with a real `kotlinc` 2.0.21 against the actual
`kotlinx-coroutines-core-jvm` jar plus stubs transcribed from the tagged Ktor
2.3.12, androidx and AOSP sources. Clean under `-Werror`. That pass caught four
real defects, all now fixed:

- a process-wide `SimpleDateFormat` in `RingLog` written from Ktor's CIO
  workers, the sweep coroutine and the service at once — it corrupts its
  internal `Calendar` under concurrency and throws from inside `format`. Now
  `ThreadLocal`.
- the engine was parented on `GlobalScope` with no exception handler, so a port
  conflict could take the process down on top of `start()` throwing. Now a
  supervised scope with a handler.
- `SweepController.step()` was missing the empty-table guard `start()` has,
  turning into `coerceIn(0, -1)` → 500 instead of a clean 400.
- `runCatching { call.receive() }` also swallowed the `CancellationException`
  from a client disconnecting mid-body, and the handler would then fire an IR
  frame built from default values.

**Since verified on hardware:** `:app:assembleDebug` builds a working debug
APK, and it has run on the phone — the sweep found this unit's real protocol
(candidate index 0, SmartIR set 1380) at 4 m with a bright room light on. The
protocol maths — the part that is genuinely
miserable to debug from a phone taped to a shelf — is also the part with
automated checks.

`tools/extract_codes.py` regenerates `candidates.json` from a SmartIR checkout
if you want to re-cut the table:

```bash
git clone --depth 1 https://github.com/smartHomeHub/SmartIR.git /tmp/SmartIR
python3 tools/extract_codes.py     # writes app/src/main/assets/candidates.json
```

Once the sweep has found your unit's set, `tools/extract_ac_codes.py` keeps that
one set's whole mode × fan × temperature matrix instead of a single on/off pair
— the table a stateful `climate` entity needs
([stateful-climate.md](stateful-climate.md)). Patterns
are stored as microsecond arrays, identical ones pooled by index:

```bash
python3 tools/extract_ac_codes.py 1380 /tmp/SmartIR/codes/climate/1380.json
# writes app/src/main/assets/ac_codes.json
```

The host-side tools need Python 3; `check_ha_entities.py` and
`check_ha_templates.py` also need `python -m pip install -r tools/requirements.txt`.
The `extract_*.py` and `verify_codecs.py` scripts are stdlib-only.
