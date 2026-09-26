# MeterCam

Reads the gas meter's printed digits from a photograph and answers, over HTTP,
with a number and a verdict on whether to believe it.

The meter is an **Itron Gallus 2000 G4** (serial U06000650, 2011; Qmax 6 m³/h,
Qmin 0.04, Pmax 0.5 bar). Its index is eight drums behind a glass window: five
black-on-white, then three **white-on-red** decimals, so it reads to 0.001 m³.
All eight are read; the value published to Home Assistant stops at 0.01 m³, for
reasons in [What is published, and what is only read](docs/pitfalls.md#what-is-published-and-what-is-only-read).

---

## Why this exists

`HomeAssistant/config/packages/gas_meter.yaml` holds the gas reading in an
`input_number` that somebody types after crouching down to look at the dial.
That works — the monthly total is right, and it reconciles to the kopeck against
the Naftogaz invoice. What it cannot do is tell you anything *within* a month.
Every reading lands in the hour it was typed, so the Energy dashboard's daily
and hourly bars are, in the README's own words, fiction.

At about 20 m³ a month this house turns the last drum roughly 28 times an hour,
so the published value moves about three times an hour — against one typed
reading a month. A camera reading every five minutes turns those fictional bars
into a real consumption curve — and makes a leak or a jammed boiler something you notice
rather than something you reconstruct from a bill.

The reed-switch route was tried first and failed: `gas-meter-reed-trial` found
no magnet in either red drum, and a phone magnetometer confirmed it with no
periodic component at the drum's rotation period. Optical depends on nothing
hidden inside the meter, which after that is the property worth paying for.

---

## Getting started

### 1. Models and config

```sh
sh models/fetch.sh                       # ~870 KB, four .tflite files
cp service/config.example.json config.json
```

Neither the weights nor `config.json` are committed — the first because
jomjol's repositories state no licence, the second because it holds the
camera's address. `config.example.json` is the template and carries the
reasoning for every setting.

### 2. Run it

```sh
docker compose up -d
curl -s localhost:8770/health | jq
```

`"auth": "DISABLED"` in that response means `METERCAM_TOKEN` is unset, which is
how the LAN deployment runs: the service and everything that talks to it sit on
one home network. Setting it is one line in `.env` beside `docker-compose.yml`,
and the Home Assistant `rest_command` carries a commented-out header ready for
it. Worth revisiting if the network ever stops being trusted — `/archive` will
hand every stored photograph of the house to anything that asks.

### 3. Aim the camera

This is the part that decides whether the project works, and no amount of code
substitutes for it. Open:

```
http://localhost:8770/roi
```

Press **Capture** repeatedly while moving the phone until the eight drums fill
as much of the frame as possible and every digit is crisp.

Three things to get right, in order of how much trouble they cause:

- **Focus — the known problem on this phone.** `curvals.focusmode` reads
  `fixed` and refuses every value: `macro`, `auto`, `continuous-picture`,
  `continuous-video`, `edof` and `infinity` were each set and each silently
  ignored. `focus_distance` is advertised by the app's own page but never
  appears in `curvals`. The only control that does anything is the bare
  `/focus` endpoint, which is why that is in `prepare_urls` and the focusmode
  call is not.

  A phone's fixed focus is usually hyperfocal — sharp from about a metre out —
  so a dial at 20 cm may simply be blurred. That sets up the real tension:
  close enough for eight drums to span 400+ px, far enough to be sharp. Shoot
  the meter and look before assuming either way. If it is soft, the fixes in
  increasing order of effort are a clip-on macro lens, a capture app that
  exposes Camera2 manual focus, or going straight to the ESP32-CAM — where
  focus is set by unscrewing the lens and is therefore never in doubt.
- **Glare.** The index sits behind glass, and the reference photo already shows
  a bright band across the top of the digits from ordinary room light. A light
  directly in front of the meter reflects straight back into the lens. Come in
  at an angle, or light from the side.
- **Fill the frame.** Eight drums across 800 px of a 2592 px sensor gives each
  drum about 100 px, which is ample for a 20×32 model input. Eight drums across
  200 px is not.

### 4. Reference frame, then ROIs

Once the camera is in its **final** position, press **Set reference**. Every
later photo is warped onto that frame, so a nudged phone costs nothing — but
the ROIs are coordinates *in it*, so moving the camera afterwards means doing
this step again.

Then draw **one** box over the whole row of drums, set the count to 8, and press
**Split selection into**. Eight hand-drawn rectangles are eight chances to be a
pixel out; one box cut into eight is not. Nudge individual boxes afterwards if
the drums are not quite evenly spaced.

Press **Test**. You get each crop as the model sees it, what it read, and the
assembled total. Iterate here — this is the loop.

Finally, paste the JSON into `config.json` under `meters.gas.rois`. No restart
needed — the config is a bind mount and is re-read on every request, so an edit
takes effect on the next call.

### 5. Check it against the dial

```sh
curl -s 'localhost:8770/read?meter=gas&prevalue=2246.916' | jq
```

Compare with what the meter actually says. Then collect a corpus across a day —
daylight, dusk, dark with the torch — because those are the frames that decide
whether this still works in February:

```sh
python tools/grab.py --config config.json --meter gas --every 300
```

Write the true reading into the `.txt` beside each frame — the **whole**
dial, all eight drums — and `tests/test_reader.py` starts checking against
them. `tools/score.py` judges those labels against `dial`, not against the
published `value`, so the drum that is no longer published is still scored.

---

## Tests

```sh
python tests/test_reader.py        # 86 checks, no dependencies
docker compose exec metercam python tests/test_reader.py   # 113, the real model
```

Sections 1–3 are pure arithmetic and live in `service/digits.py`, which imports
nothing third-party — so they run on a bare workstation without OpenCV, numpy
or a TFLite runtime. That split is deliberate: those are the functions whose
failure is irreversible, so they are the ones nobody should have an excuse to
skip. Sections 4, 6 and 7 need OpenCV and the weights, so they run in the
container and skip loudly outside it; section 5 is the corpus and skips loudly
when it is absent.

---

## Layout

| Path | What |
| --- | --- |
| `service/digits.py` | The carry rule and the gate. Stdlib only |
| `service/reader.py` | Capture, align, crop, infer. The imaging half |
| `service/app.py` | Routes. No scheduler, no state, no calls into HA |
| `service/roi.html` | The editor. Dependency-free on purpose — it gets used on the floor next to a gas meter |
| `service/aim.html` | The `/aim` page: take a photo, nothing else. Same no-dependency rule as the editor |
| `service/config.example.json` | Template, with the reasoning for every setting |
| `models/fetch.sh` | Downloads the weights. Not committed |
| `tools/grab.py` | Corpus collector |
| `tests/test_reader.py` | Plain asserts, no pytest |
| `tools/score.py` | Scores the labelled corpus. The go/no-go before Home Assistant writes anything |
| `deploy/` | Creates LXC 104 on the hypervisor and runs the stack in it. See its own README |
| `firmware/gas-cam/` | The camera itself: AI-Thinker ESP32-CAM, deep sleep, pushes frames, pulls its own updates |

---

## Deployment

`docker compose up -d` above is the bench. The house runs it in **LXC 104 on
the Proxmox host, at <metercam-ip>** — same Dockerfile, same compose file, which
is the arrangement this Dockerfile's header has described from the start.

```sh
sh deploy/lxc_create.sh       # once
sh deploy/lxc_provision.sh    # once: Docker, and the frame-retention timer
sh deploy/deploy.sh           # as often as you like
sh deploy/probe_cpu.sh        # prove the runtime executes on that CPU
```

[`docs/deployment.md`](docs/deployment.md) has the rest, including the three things that will bite: the
hypervisor's Celeron **has no AVX**, the alignment reference and the ROIs are
one matched pair that must travel together, and nothing prunes the archived
frames until `lxc_provision.sh` installs a timer that does.

---

## Not done yet

- **Home Assistant — wired, and deliberately switched off.**
  `HomeAssistant/config/packages/metercam_gas.yaml` holds a `rest_command`, a
  script and a poll automation. The automation ships `initial_state: false`, so
  it stays off across restarts until that line is deleted; until then run
  `script.metercam_read_gas` by hand and read
  `input_text.gas_meter_camera_status`. Same code path either way.

  Not a `rest:` sensor: one polls on its own and stores whatever comes back,
  including refused readings, which means filtering after the fact on a
  `total_increasing` sensor — the one place that does not work. The script
  reads the verdict first and writes only on `accepted`.

  Deleting `initial_state: false` is the whole of going live, and it should not
  happen before `tools/score.py` passes on a real corpus.
- **Aim, then re-reference.** The camera has to be fixed where it will stay,
  then **Set reference** in `/roi` and the ROIs redrawn against that frame. The
  reference and the ROIs are one matched pair; skipping this produces confident
  wrong numbers rather than errors. Until it is done every read is refused —
  correctly.
- **The ESP32-CAM — firmware written and compiling, not yet on the wall.**
  `firmware/gas-cam/` is an Arduino/PlatformIO project rather than an ESPHome
  node, and the reason is deep sleep: the board overheats awake, ESPHome has no
  comfortable way to wake, shoot, push and sleep, and a sleeping node cannot
  serve a snapshot to anybody. It builds at 18% RAM and 34% of a `huge_app`
  partition, the second slot being what makes OTA possible at all.

  ```sh
  cd firmware/gas-cam
  cp include/config.h.example include/config.h    # wifi, token, pins
  pio run -t upload                               # first flash, over the MB shield
  ```

  **Build it from PowerShell, never Git Bash** — PlatformIO refuses MSys and
  leaves a half-installed esptool that every later build trips over. Same trap
  as `PowerStation/`.

  Two LEDs off to the sides on GPIO12/13, not the module's own flash: the
  on-board LED sits beside the lens and fires straight down the optical axis,
  so against glass it reflects into the frame and hides the drum it was meant
  to light. **GPIO12 is a strapping pin** — held high at reset the board does
  not boot. A 10k to ground on that line and stop thinking about it.

  After the first flash it updates itself: it asks `/firmware/version.txt` in
  the window where the radio is already up, and downloads when the answer
  *differs* from its own version — not "is greater than", so a rollback works
  the same way.

- **Preprocessing — implemented, off, and unmeasured.** `preprocess` in the
  config offers `clahe` (CLAHE on L in LAB, colour preserved), `green` (keep
  green, drop red and blue, which turns the three white-on-red decimals into
  white on near-black) and `clahe+green`, per meter or per ROI. All of them
  raise contrast and all of them move the crops away from the distribution
  `dig-class100` was trained on, and nothing here knows which way that trade
  lands on this meter. `tools/score.py --preprocess none,clahe,green` runs the
  corpus under each and prints them side by side. There is no corpus, so there
  is no answer — turning one on before there is one is a guess wearing a
  measurement's clothes.
- **Cold water.** A second entry under `meters` and a second camera. The service
  has been multi-meter from the first commit for that reason.

## Docs

| Doc | About |
| --- | --- |
| [`docs/architecture.md`](docs/architecture.md) | where the logic lives (camera, service, Home Assistant) and where it deliberately does not |
| [`docs/api.md`](docs/api.md) | the service's HTTP endpoints and auth |
| [`docs/pitfalls.md`](docs/pitfalls.md) | the things that are easy to get wrong when reading a dial |
| [`docs/guardrails.md`](docs/guardrails.md) | each guard against a bad reading, and what it is worth |
| [`docs/deployment.md`](docs/deployment.md) | creating and deploying LXC 104 on the Proxmox host |
