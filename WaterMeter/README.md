# WaterMeter: a camera on the cold-water meter

An ESP32-CAM reads the bathroom's **cold-water meter** the same way [`MeterCam`](../MeterCam/README.md) reads the gas
meter: the board wakes, photographs the dial and posts the frames to the MeterCam service. The service then reads
the digits and hands Home Assistant a reading. Today the cold-water reading is typed in by hand
([`HomeAssistant/docs/gas-and-water-meters.md`](../HomeAssistant/docs/gas-and-water-meters.md)).

**Status:** parts chosen 2026-10-12, not yet bought. Firmware, wiring and the service side come once they arrive.

## The site

- Two meters side by side under the bath panel: hot (red, left) and cold (blue, right). Only **cold** is read.
  One camera covers one meter face at this distance, so hot would need a second board.
- The meters face **down**, with about **40 mm** between the meter glass and the decorative panel.
- So the board lies flat under the meter, lens about 20–25 mm from the glass. The stock OV2640 lens has to be
  screwed out a little to focus that close (once, by hand).
- The ESP32-CAM-MB programmer base adds about 15 mm and does not fit there. It is used only for the first USB
  flash; later updates come over Wi-Fi, as with the gas camera.
- A phone charger in a socket feeds the board. No 230 V cable runs to the meter: only 5 V.

## Parts to buy: 632 UAH

All on prom.ua with Smart delivery, and each seller's subtotal clears its minimum order. Prices were checked on
2026-10-12.

| # | Part | Shop (minimum order) | Price, UAH |
|---|---|---|---|
| 1 | **ESP32-CAM with OV2640** (AI-Thinker layout, 27×41 mm, 4 MB PSRAM) | [prom.ua (1Дюйм)](https://prom.ua/ua/p2224538685-modul-kamery-esp32.html) (200) | 351 |
| 2 | **ESP32-CAM-MB programmer base, USB-C** (FT232, Reset and Download buttons), for the first flash only | [prom.ua (Носуль)](https://prom.ua/ua/p2199400728-esp32-cam-usb.html) (100) | 199 |
| 3 | **Phone charger**, 2 USB, 2.4 A | [prom.ua (GoMarket)](https://prom.ua/ua/p3221702885-setevoe-zaryadnoe-ustrojstvo.html) (none) | 82 |
| | **Total** | | **632** |

**Not bought:**
- **Cable:** two broken 2 m USB cables are spliced into one longer one. Only power is needed, so only the red
  (+5 V) and black (GND) wires are joined. The USB-A plug goes into the charger, and the other end is soldered
  straight to the board's **5V** and **GND** pins. At the board's 0.2–0.3 A, about 4 m of cable loses almost nothing.
- **Box:** left out for now. If it is needed later, only the lens needs a clear window: a flat box with a hole
  over the lens and a piece of microscope slide glued over it. Plastic lids are too cloudy for a photo this close.

**Before paying:** check the charger's photo to make sure its ports are USB-A. A buyer review of the ESP32-CAM
listing reports one board that would not flash. Носуль can also supply a matched ESP32-CAM with the base, for a
surcharge not listed on the page.
