# The camera firmware

`firmware/gas-cam/` is an AI-Thinker ESP32-CAM (OV2640, 4 MB PSRAM) on PlatformIO
with the Arduino core. It has one build, `src/main.cpp`. The board-specific
pins are in `include/board.h`; secrets and tunables are in `include/config.h`,
which is gitignored and copied from `include/config.h.example`.

## Wiring

| What | Pin | Notes |
| --- | --- | --- |
| Left LED | **IO14** | white, anode to the pin, cathode to GND, **no resistor** |
| Right LED | **IO13** | same |
| On-board flash | IO4 | never lit; held LOW, including through deep sleep |
| GND | either GND pin | |

On the AI-Thinker's left header, top to bottom, the pins are: 5V · **GND** ·
IO12 · **IO13** · IO15 · **IO14** · IO2 · IO4.

- **No resistors, white LEDs only.** A white LED drops 3.0–3.2 V against the
  pin's 3.3 V, so the pin's own driver limits the current, and the LEDs are lit
  about a second per wake. A red or yellow LED (about 2 V) wired the same way
  draws as much as the pin can give, roughly 40 mA, which is the ESP32's
  absolute maximum. Red is wrong here anyway: under red light the red decimal
  drums wash out.
- **Why 13 and 14.** With no SD card the free pins are 2, 4, 12, 13, 14 and
  15. 16 is PSRAM chip-select. 2, 12 and 15 are strapping pins: IO12 held high
  at reset selects the wrong flash voltage and the board looks dead. 4 is the
  on-axis flash.
- **Why not the on-board flash.** It sits beside the lens and fires down the
  optical axis, so its reflection off the meter's glass lands on the digits.
  The two LEDs sit on the lid rim either side of the slot's short axis, which
  puts their hotspots on the black mask instead.

## Building

```powershell
cd MeterCam\firmware\gas-cam
copy include\config.h.example include\config.h   # once: WiFi, MeterCam's address, token
pio run
```

**Build from PowerShell, never Git Bash.** PlatformIO refuses MSys/Mingw and
leaves a half-installed esptool behind that every later build trips over. The
output is `.pio\build\gas-cam\firmware.bin` (the OTA image) and
`firmware.factory.bin` (bootloader, partition table, OTA data and app, written
at 0x0).

## Versions

`FIRMWARE_VERSION` in `config.h` is `gas-cam-<n>`. **Bump `n` for every build
that is published.** The board compares numbers, not strings: it updates only
to a higher `n`.

## Publishing an update (over the air)

The board must already run a build that updates itself, gas-cam-5 or later.
On the box, in `/opt/metercam/data/firmware/`:

1. Copy the new `firmware.bin` there as `gas-cam-<n>.bin`. Keep the previous one:
   it is the rollback.
2. `cp gas-cam-<n>.bin gas-cam.bin.new && mv gas-cam.bin.new gas-cam.bin`
3. `printf gas-cam-<n> > version.txt.new && mv version.txt.new version.txt`

Binary first, then version, so a board never sees the new version paired with
the old binary. On its next wake the board sees the offer in the `/read`
answer, downloads `gas-cam.bin`, reboots, and runs a wake on the new build
straight away. The service logs `firmware gas-cam.bin served`, and the next
`read gas fw=gas-cam-<n>` line confirms it.

If the image does not report the version it was published as, the board does
not loop: it tries each offered version once, then again only after 12 wakes
(six hours).

## Rolling back

Republish the old image under a **higher** number: rebuild the old source with
`FIRMWARE_VERSION "gas-cam-<n+1>"`, then publish it as above. Copying an old
`.bin` over `gas-cam.bin` does nothing, because its version is lower than what
the board runs.

## Flashing over USB

Needed only for the first flash, a partition-table change, or a board that can
no longer update itself. Put the board on the MB programmer shield.

```powershell
pio run -t upload
```

**Publish the same version on the server first.** If `version.txt` offers a
higher number than the build being flashed, the freshly flashed board updates
itself to the server's build on its first wake.

Partitions are `min_spiffs`: two 1.875 MB app slots, which is what OTA needs.
The build is about 1.08 MB.
