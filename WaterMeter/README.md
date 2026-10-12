# WaterMeter: a camera on the cold-water meter

An ESP32-CAM reads the bathroom's **cold-water meter** the same way [`MeterCam`](../MeterCam/README.md) reads the gas
meter: the board wakes, photographs the dial and posts the frames to the MeterCam service. The service then reads
the digits and hands Home Assistant a reading. Today the cold-water reading is typed in by hand
([`HomeAssistant/docs/gas-and-water-meters.md`](../HomeAssistant/docs/gas-and-water-meters.md)).

**Status:** parts chosen 2026-10-12, not yet bought. The software is ready on the gas meter's
code (below); the board, its aim and its ROIs come once the parts arrive.

## Software: the gas camera's, reused

Nothing new runs anywhere. Each piece is the gas meter's, with a water entry beside it:

| Piece | Where | For water |
|---|---|---|
| Firmware | [`MeterCam/firmware/gas-cam/`](../MeterCam/firmware/gas-cam) | env `water-cam`: same source, posts `?meter=water`, versions `water-cam-<n>`, fetches `water-cam.bin` ([`firmware.md`](../MeterCam/docs/firmware.md)) |
| Reading service | MeterCam, LXC 104 | a `water` block in the box's `config.json` (template in [`config.example.json`](../MeterCam/service/config.example.json)): 8 drums, 3 decimals read, 2 published, continuous gearing |
| Firmware updates | MeterCam, LXC 104 | its own channel, `data/firmware/version-water.txt`. It is never offered the gas build |
| Home Assistant | [`water_meter.yaml`](../HomeAssistant/config/packages/water_meter.yaml) | `input_number.water_meter_cold_camera_reading`. `sensor.cold_water_meter_reading` takes the higher of it and the typed reading, so the Energy history stays one series |
| Stale alert | [`metercam_watch.yaml`](../HomeAssistant/config/packages/metercam_watch.yaml) | `sensor.water_camera_last_accepted`, and an alert after 6 h without an accepted reading. Quiet until the camera's first accepted reading |
| Monthly submission | MeterBots, LXC 105 | `/water/web/*`: the dneprvoda.com.ua web cabinet, whole m³ ([`water-web.md`](../MeterBots/docs/water-web.md)). The utility's Telegram bot answers only that it is blocked. The Home Assistant side (ask on the 1st, a Submit button) is still to come |

Tests: `MeterCam/tests/test_routes.py` (firmware channels), `test_reader.py` sections 2g, 2h and 9
(the config template, a water reading through the gate, the channels through the real app),
`test_firmware_config.py` (the two builds), and `HomeAssistant/tools/check_automations.py`
sections 12 and 13 (both reading sensors, the water alert).

## Install checklist

1. Flash once over the MB base: `pio run -e water-cam -t upload` (PowerShell, from
   `MeterCam/firmware/gas-cam`), with `config.h` already filled in for the gas board.
2. Wire the spliced cable to 5V/GND, lay the board under the meter, and focus the lens.
3. Press RST for a wake, look at `/last.jpg?meter=water`, and redo the `water` block's ROIs and
   `/data/ref/water.jpg` from that frame. Check the gearing (continuous or jump) on the photo.
4. Deploy the service and the HA packages (they are backward compatible), and restart HA so the new
   helper exists.
5. Publish later builds as `water-cam-<n>.bin` → `water-cam.bin`, then `version-water.txt`.

## The site

- Two meters side by side under the bath panel: hot (red, left) and cold (blue, right). Only **cold** is read.
  One camera covers one meter face at this distance, so hot would need a second board.
- The meters face **down**, with about **40 mm** between the meter glass and the decorative panel.
- So the board lies flat under the meter, lens about 20–25 mm from the glass. The stock OV2640 lens has to be
  screwed out a little to focus that close (once, by hand).
- The ESP32-CAM-MB programmer base adds about 15 mm and does not fit there. It is used only for the first USB
  flash; later updates come over Wi-Fi, as with the gas camera.
- A phone charger in a socket feeds the board. No 230 V cable runs to the meter: only 5 V.

## Parts to buy: 658 UAH

One order from one prom.ua seller, СЦ Екран, both items with Smart. Prom's Smart delivery is free only when one
seller's subtotal is at least 200 UAH, and this seller's own minimum is 400 UAH. The order clears both. Prices were
checked on 2026-10-12. Every charger this seller sells comes with a cable. The only cheaper one, at 159 UAH,
has a Lightning cable, which is no use here.

| # | Part | Price, UAH |
|---|---|---|
| 1 | [**ESP32-CAM with OV2640 and the programmer base**](https://prom.ua/ua/p3034708996-plata-razrabotki-esp32.html), kit (ESP32-CAM-MB for the first USB flash) | 489 |
| 2 | [**Charger LDNIO A2219**](https://prom.ua/ua/p1824668257-zaryadnoe-ustrojstvo-ldnio.html), 2 × USB-A, 5 V 2.4 A, with a USB-A → micro-USB cable | 169 |
| | **Total, one seller, Smart** | **658** |

Alternatives checked on 2026-10-12 cost more, or come without a Smart charger. 1Дюйм has the board at 351 UAH and a
CH341A at 155 UAH, but no mains charger and no in-stock CH340. ФОП Корнієнко has the board and base at 634.80 UAH,
but no charger. Rozetka had no cheaper ESP32-CAM in stock.

**Not bought:**
- **Cable:** two broken 2 m USB cables are spliced into one longer one. Only power is needed, so only the red
  (+5 V) and black (GND) wires are joined. The USB-A plug goes into the charger, and the other end is soldered
  straight to the board's **5V** and **GND** pins. At the board's 0.2–0.3 A, about 4 m of cable loses almost nothing.
- **Box:** left out for now. If it is needed later, only the lens needs a clear window: a flat box with a hole
  over the lens and a piece of microscope slide glued over it. Plastic lids are too cloudy for a photo this close.

**Before paying:** check that the listing still shows the Smart badge, and that the photo shows the MB base in the kit.
Test the board on the base as soon as it arrives. The seller lists 14 days for exchange and return.
