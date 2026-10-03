# Setting up the board

From the parts on the desk to the meter on the Energy dashboard. Follow the
steps in order: step 8 has to happen before step 9, or Home Assistant books the
meter's whole lifetime as one hour's consumption.

You need:

- the **Lolin NodeMCU V3** (ESP8266) and a micro-USB cable;
- the **MH-Sensor-Series** photodiode module (LM393 board with `VCC`, `GND`,
  `DO`, `AO`);
- three female-female jumper wires;
- black electrical tape, or anything else that keeps room light off the
  sensor;
- the USB charger for the **inverter-backed socket** next to the meter. It keeps
  the board counting through grid outages.

## 1. Wire the sensor to the board

```
  MH-Sensor-Series                Lolin NodeMCU V3
  ┌──────────────┐               ┌──────────────────┐
  │          VCC ●───────────────● 3V               │
  │          GND ●───────────────● G                │
  │           DO ●  (not used)   │                  │
  │           AO ●───────────────● A0               │
  └──────────────┘               └──────────────────┘
```

| Module pin | Lolin V3 pin | Note |
| --- | --- | --- |
| `VCC` | `3V` (3.3 V) | **Never `VIN` or 5 V.** `AO` swings up to the supply voltage, and `A0` must stay at or below 3.3 V. |
| `GND` | `G` | Any `G` pin. |
| `AO` | `A0` | The analog output. The board reads it 100 times a second. |
| `DO` | — | Leave it unconnected. The firmware does its own thresholding, with hysteresis the comparator does not have. |

The blue potentiometer on the module only affects `DO`, so it doesn't matter
here.

## 2. Make an MQTT login for the board

The board logs in to the Mosquitto add-on with a Home Assistant user of its
own. Mosquitto accepts Home Assistant users directly.

1. Home Assistant → **Settings → People → Users** (switch on **Advanced
   mode** in your profile if the Users tab is missing) → **Add user**.
2. Display name `Electricity meter`, username `electricity-meter`, and a long
   random password.
3. Turn on **Can only log in from the local network**. Leave
   **Administrator** off.

## 3. Fill in `config.h`

`ElectricityMeter/firmware/electricity-meter/include/config.h` holds the
secrets and is git-ignored. Yours is from stage one, so it has WiFi and OTA
but no MQTT. Copy the MQTT block from `config.h.example` into it:

```c
#define MQTT_HOST        "192.168.0.3"
#define MQTT_PORT        1883
#define MQTT_USER        "electricity-meter"
#define MQTT_PASSWORD    "<the password from step 2>"
```

If the MQTT lines are missing, the build stops with an error that says so.

## 4. Flash the firmware

Run this from **PowerShell**, never Git Bash: PlatformIO refuses MSys and
leaves a broken esptool behind.

**Over the cable** (first time, or with the board on the desk):

```powershell
cd ElectricityMeter\firmware\electricity-meter
pio run -e usb -t upload -t monitor
```

**Over WiFi** (if the board is still on the meter running stage one):

```powershell
cd ElectricityMeter\firmware\electricity-meter
$env:ELECTRICITY_METER_OTA_PASSWORD = '<OTA_PASSWORD from config.h>'
pio run -e ota -t upload --upload-port <board-ip>
```

The serial monitor should show, within a few seconds:

```
# ElectricityMeter 2.0.0, one sample every 10 ms
# register 0 pulses, levels on 950 off 820
# WiFi up: http://192.168.0.xx/  (http://electricity-meter.local/)  RSSI -60 dBm
# MQTT: connecting to 192.168.0.3:1883
# MQTT: connected
# register restored: 0 pulses
```

`MQTT: failed, state 5` means the broker rejected the login: check the user
and password from steps 2 and 3. `state -2` means it couldn't reach
192.168.0.3 at all.

Give the board a **fixed DHCP lease** in the router, so its address never
moves.

## 5. Check it in Home Assistant

**Settings → Devices & services → MQTT → Electricity meter.** The device has
six entities:

| Entity | What it is | Right now |
| --- | --- | --- |
| `sensor.electricity_meter_power` | Power, W | live |
| `sensor.electricity_meter_energy` | The meter's register, kWh | **unavailable**, which is correct until step 8 |
| `number.electricity_meter_reading` | Meter reading (Configuration) | 0 |
| `number.electricity_meter_threshold_on` | Flash on level | 950 |
| `number.electricity_meter_threshold_off` | Flash off level | 820 |
| `button.electricity_meter_restart` | Restart | |

## 6. Bench check

Open `http://<board-ip>/` on your phone. The top line shows the register, the
power and the levels; the graph below shows the raw sensor.

1. Cover the sensor with a finger: the value drops to the dark level.
2. Flash a phone torch at it once: the value jumps above 950, and the pulse
   count goes up by exactly **one**. Holding the torch on it still counts one.
   A new pulse needs the value to fall below 820 first.

## 7. Mount it on the meter

1. Find the meter's **imp/kWh LED**. On the NIK 2102 it's the small red LED
   marked `6400 imp/kWh`, which blinks faster the more the flat draws.
2. Put the photodiode (the small dark bulb on the module) right over it, and
   tape the module down **so no room light reaches it**. Light leaking in is the
   most likely cause of wrong counts. Golden-data capture showed that a sensor
   being handled reaches 900 and higher.
3. Plug the board into the **inverter-backed socket**.
4. On the phone page, watch a few blinks. They should look like stage one
   measured: a baseline near **760** and peaks near **1014**, each a few
   samples wide. If your baseline or peaks are clearly different (the sensor
   sits differently), set the levels about a quarter of the way in from each
   end:
   - **on** ≈ peak − (peak − baseline) / 4 (at 760/1014: about 950)
   - **off** ≈ baseline + (peak − baseline) / 4 (at 760/1014: about 820)

   Set them in Home Assistant (the two level numbers). The board accepts a level
   only if `1 ≤ off < on ≤ 1023`; a refused value snaps back.

## 8. Set the meter reading

1. Read the register off the meter's display, in kWh. If the display cycles
   through T1 / T2 / total, take the **total**.
2. Type it into **Meter reading** (`number.electricity_meter_reading`) and press
   Enter.
3. `sensor.electricity_meter_energy` becomes available and shows the same
   number.

**Set it once.** Each change jumps the register, and anything already counting
from it (the day/night meters, the Energy dashboard) counts the jump as
consumption. If you ever need to correct it again, see
[`HomeAssistant/docs/electricity-meter.md`](../../HomeAssistant/docs/electricity-meter.md).

## 9. Turn on the day/night split and the Energy dashboard

Ask Claude to deploy it, or follow
[`HomeAssistant/docs/electricity-meter.md`](../../HomeAssistant/docs/electricity-meter.md):

1. `HomeAssistant/config/packages/electricity_meter.yaml` goes to the box,
   followed by `ha core restart`. That creates the day/night meters
   `sensor.electricity_meter_tariff_day` and `_night`.
2. On the Energy dashboard, the grid sources switch from the inverter's
   `powmr_inverter_grid_real_tariff_day/night` to the meter's, at the same
   4.32 / 2.16 UAH prices. Grid power switches to
   `sensor.electricity_meter_power`.

## 10. Check it against the meter

- **After 30 minutes:** the display's kWh and `sensor.electricity_meter_energy`
  should differ by no more than the display's last digit.
- **After a day:** the same check over a longer run. A slow drift means blinks
  are being missed (raise the sensitivity: lower **on**) or counted twice
  (lower **off** further below the peak's falling edge). The energy sensor's
  `uncertain` attribute counts gaps long enough to have hidden a blink. It
  should stay at or near 0.

## Troubleshooting

| What you see | Likely cause | What to do |
| --- | --- | --- |
| The device never shows up in HA | MQTT login failing | Watch the serial monitor (step 4) for `MQTT: failed, state N`. |
| Energy stays unavailable | The register hasn't been set | Step 8. |
| Power reads 0 while things are on | No blinks detected | Phone page: do the peaks pass the **on** level? If not, lower it, or re-centre the sensor on the LED. |
| Count runs fast | Room light, or one blink counted twice | Re-tape the sensor. Check the falling edge on the phone page goes below **off**. |
| Count runs slow | **on** too high for the weaker blinks | Lower **on**, keeping it well above the baseline. |
| `uncertain` keeps rising | WiFi trouble stalling the sampler | Check the RSSI on the phone page. Below about −80 dBm, move the router or the board. |
| Power stays at a high reading after the load stops | It decays rather than dropping | It can't be more than one blink's worth over the time since the last blink. At 100 W a blink is 5.6 s apart, so a drop takes a few seconds to show. |
