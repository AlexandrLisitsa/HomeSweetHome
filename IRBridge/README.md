# IR Bridge

An HTTP-to-infrared relay that runs on an Android phone, so Home Assistant can
drive a dumb air conditioner through the phone's IR blaster.

```
Home Assistant (Dell 5070 / Proxmox)
        │  POST /ir/raw  { "pattern": [4400,4400,560,1680, …] }
        ▼
Mi A2 Lite : 8765          ← this app
        │  ConsumerIrManager.transmit(38000, pattern)
        ▼
   IR LED  ))))  Daewoo split unit
```

---

## Read this before you write any more code

Two facts shape the whole project, and both are worth knowing on day one.

**1. Your phone can transmit IR but cannot receive it.** `ConsumerIrManager`
is emit-only — there is no Android API for capturing IR, on any phone. So the
phone can never learn a code from your KT-9018E remote. It can only replay
codes that came from somewhere else.

**2. There is no Daewoo A/C entry in any public IR database.** I checked the
two that matter: [SmartIR](https://github.com/smartHomeHub/SmartIR) has 358
climate code sets across 129 manufacturers and not one Daewoo; irdb has a
`Daewoo` folder, but it is TV and VCR codes (RC5 and Proton protocols), no
climate. This is not an oversight — Daewoo split units are OEM builds, so the
protocol that works is usually some *other* brand's.

That second fact is why this app ships a brute-force sweeper instead of a
Daewoo driver. `app/src/main/assets/candidates.json` holds **315 distinct A/C
protocols** extracted from SmartIR and converted to raw microsecond timings,
ordered with the families most likely to answer a Daewoo unit first
(Midea/Coolix, then Gree, TCL, Electra, Samsung, LG, then everything else).
You sweep them, watch the A/C, and note which one makes it beep.

Expect this to work or not work in about twenty minutes of sitting in front of
the unit. If it doesn't, see [When the sweep finds
nothing](docs/protocol-sweep.md#when-the-sweep-finds-nothing).

---

## Build it

Open `IRBridge/` in IntelliJ IDEA as its own project — it is a standalone
Gradle build inside this mono-repo, with its own wrapper and version catalog.
You need the Android plugin and an Android SDK with platform 34; IDEA will
offer to fetch both, or point it at an existing SDK with a `local.properties`
containing `sdk.dir=/path/to/Android/Sdk`.

```bash
./gradlew :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Versions are pinned in `gradle/libs.versions.toml`. Ktor is held at **2.3.12**
deliberately — `embeddedServer` changed its return type in Ktor 3, and 2.3.x is
the branch with the most Android mileage.

## Set the phone up

The app is a control panel; everything real happens over HTTP.

1. Launch it, note the address and the auth token, press **Start**.
2. Press **Battery settings** and set the app to unrestricted. This is the
   single most common reason a phone-hosted service stops answering after an
   hour.
3. Give the phone a **static DHCP lease** on your router. If its address moves,
   every `rest_command` breaks silently.
4. Leave it on the charger, screen off, pointed at the A/C. An always-on IR
   bridge is a mains appliance that happens to be shaped like a phone.

Check it from the Proxmox host:

```bash
curl -s http://<phone-ip>:8765/health | jq
```

```json
{
  "ok": true, "version": "0.1.0",
  "hasIrEmitter": true,
  "carrierRanges": ["30000-60000"],
  "candidateCount": 315,
  "sweepRunning": false,
  "uptimeSeconds": 12
}
```

If `hasIrEmitter` is `false`, stop and check the hardware — the Mi A2 Lite is
the Android One build of the Redmi 6 Pro and
[does have an IR emitter](https://www.fonearena.com/xiaomi-mi-a2-lite_8953.html),
unlike the plain Mi A2, so a `false` here means the wrong device or a broken
emitter.

## Wire up Home Assistant

The Home Assistant side lives in the mirrored config,
[`HomeAssistant/config/`](../HomeAssistant/config/), which is the only copy.
`config/irbridge/rest_commands.yaml` holds the commands. The token and the
phone's URLs (one `irbridge_url_*` key per endpoint, because `!secret` replaces a
whole value) go in the box's `secrets.yaml`; the full list is in
[`HomeAssistant/examples/secrets.yaml.example`](../HomeAssistant/examples/secrets.yaml.example):

```yaml
irbridge_token: 0123456789abcdef0123456789abcdef
irbridge_url_health: "http://<phone-ip>:8765/health"
# ... and the other irbridge_url_* keys
```

In `configuration.yaml`:

```yaml
rest_command: !include irbridge/rest_commands.yaml
```

`config/packages/irbridge_package.yaml` adds a
health sensor plus the three scripts that drive the sweep from the UI, so you
can run it from your phone while standing in front of the A/C rather than from
an SSH session.

Then, from Developer Tools → Actions:

```yaml
action: rest_command.irbridge_send_candidate
data:
  idx: 22
  command: "on"
```

### Once it works: the thermostat, and then the meter

`config/packages/irbridge_ac.yaml` turns the working protocol into a real
`climate` entity — a thermostat card with mode, setpoint, fan and swing. It
speaks MQTT rather than HTTP because Home Assistant has no template platform
for `climate`, so that is the only route to a thermostat card without writing
a custom component. Mode, setpoint, fan and swing run in optimistic mode,
which is honest: the bridge cannot read the unit, and a state topic would only
be a nicer-looking lie.

`config/packages/irbridge_ac_energy.yaml` is the interesting one, and it needs
hardware this project otherwise does without: **an energy meter on the A/C's
circuit** (a Zigbee plug is enough). Watts are the one thing IR cannot give
you, and they answer the question the rest of this project has to guess at —
is it actually running?

That buys three things the thermostat could not have:

- **A measured `hvac_action`.** The card's status line reads Cooling, Heating,
  Drying, Fan, **Idle** or Off from the meter. `idle` in particular is not
  expressible any other way: setpoint reached, compressor stopped, fan still
  turning. Mode remains what we asked for; action becomes what is happening.
- **Drift detection.** `binary_sensor.a_c_drift` turns on when the bridge's
  belief and the circuit disagree for fifteen minutes — which is what using the
  physical remote looks like from here. It does not auto-correct: a missed frame
  wants a resend and a deliberate remote press wants to be left alone, and
  guessing wrong means an A/C that switches itself back on at night.
- **Consumption.** kWh and cost per day and per month off the plug's own
  cumulative counter, plus runtime, compressor hours, and compressor starts
  (a unit short-cycling twenty times an hour is being asked for a setpoint it
  cannot hold).

Two thresholds separate standby from fan-only from compressor, and they are
`input_number`s rather than constants because only your unit knows them — the
comments on `irbridge_ac_standby_watts` and `irbridge_ac_compressor_watts` in
the package say how to find them. The card that puts all of it
on one screen is `climate-console-card.js` on the climate dashboard.

Both packages are checked before deployment by two tools that exist because
`ha core check` cannot do either job. From `HomeAssistant/`:

```
python ../IRBridge/tools/check_ha_entities.py config   # every entity id resolves
python ../IRBridge/tools/check_ha_templates.py         # every template renders right
```

Nothing in Home Assistant declares an entity id — they are derived from `name:`
by slugify, and from the config key for helpers and scripts. So a template
naming a sensor that does not exist is not an error: the config validates, the
restart succeeds, and the value reads `unknown` until somebody notices.
`check_ha_entities.py` is the thing that notices. And since `ha core check`
parses YAML without ever rendering a template, `check_ha_templates.py` renders
them all against twelve scenarios — standby, fan-only, a compressor at 700 W,
both directions of drift, and the post-restart case — and asserts each result.

## Tools

Host-side Python 3. `check_ha_entities.py` and `check_ha_templates.py` also need
`python -m pip install -r tools/requirements.txt`; the rest are stdlib-only.

| Script | Does | Changes anything live? |
| --- | --- | --- |
| `tools/verify_codecs.py` | a line-for-line Python mirror of `Codecs.kt` with its assertions, so the codec logic is tested without an Android SDK | no |
| `tools/extract_codes.py` | regenerates `app/src/main/assets/candidates.json`, the sweep table, from a SmartIR checkout | no |
| `tools/extract_ac_codes.py` | keeps one SmartIR set's whole mode × fan × temperature matrix, for stateful control, as `app/src/main/assets/ac_codes.json` | no |
| `tools/check_ha_entities.py` | cross-checks every entity id the Home Assistant YAML references against the ids it creates | no |
| `tools/check_ha_templates.py` | renders the Jinja in `packages/irbridge_ac_energy.yaml` against fake states | no |

## Docs

| Doc | About |
| --- | --- |
| [`docs/protocol-sweep.md`](docs/protocol-sweep.md) | finding which IR code set your A/C answers to |
| [`docs/api.md`](docs/api.md) | the bridge's HTTP API |
| [`docs/verification.md`](docs/verification.md) | what the tests and hardware runs prove, and what is assumed |
| [`docs/stateful-climate.md`](docs/stateful-climate.md) | what a real `climate` entity needs on top of the stateless bridge |
