# Water camera: parts

The second camera reads the cold-water meter. It is the same AI-Thinker
ESP32-CAM as the gas camera ([`firmware.md`](firmware.md)), inside a sealed box
with a clear lid, because the pipe beside a cold-water meter sweats.

Everything here comes from Ukrainian shops. Prices are from prom.ua on
2026-10-04.

## Parts

| # | Part | Why | Where / price |
| --- | --- | --- | --- |
| 1 | **Enclosure: Gainta G221CMF**, 115×90×80 mm, polycarbonate, IP65, clear lid, mounting flanges | Small and sealed. The 80 mm depth puts the lens about 6–7 cm from the dial, which suits the OV2640. | [РАДІОМАГ on prom.ua](https://prom.ua/ua/p1416624851-g221cmf-gainta-korpus.html), ~288 ₴ |
| 1b | *Alternative:* Gainta G258C, 80×160×55 mm, PC, IP65, clear lid | Longer and shallower, if the meter sits in a tight niche | prom.ua, ~860–1280 ₴ |
| 2 | **ESP32-CAM (AI-Thinker, OV2640)**, plus an ESP32-CAM-MB USB board if none is to hand | Same board as the gas camera, so the same firmware runs on it | [ardu.prom.ua](https://ardu.prom.ua/ua/p1224387627-esp32-cam-bluetooth.html) / [prom.ua](https://prom.ua/ua/p1408299058-modul-kamery-esp32.html), ~250–500 ₴; [with CH340](https://prom.ua/p1443664205-kontroller-razrabotki-esp32.html) ~740 ₴ |
| 3 | 2× **white 5 mm LEDs** | Same no-resistor wiring on IO13/IO14 as the gas camera. White only: red light washes out the red drums. | any radio shop |
| 4 | **PG7 cable gland** (IP68) | Brings the power cable in without breaking the seal | radio shop, ~15–30 ₴ |
| 5 | **5 V / 2 A USB adapter + cable**, or 5 V from a nearby supply | The ESP32-CAM draws a lot at Wi-Fi start; a weak adapter means brown-out resets | – |
| 6 | **Silica gel packets**, 2–3 × 5 g | Stops the inside of the lid fogging | – |
| 7 | **Black matte EVA foam** or black tape | The light baffle, see below | – |
| 8 | M3 nylon standoffs + screws | Fix the board to the box floor | – |
| 9 | **Pipe clamps + a small aluminium angle bracket** | Holds the box over the dial, clamped to the pipe beside the meter | building shop / Epicentr |

## What matters more than the box

- **Reflections off the clear lid.** The gas camera moved its LEDs off the lens
  axis to keep their glare off the digits; a clear lid makes it worse, because
  LED light bounces off the inside of the lid straight into the lens. Put a
  black foam tube around the lens that reaches the lid, black out the lid's
  inside except a window over the dial, and keep the LEDs outside the tube,
  angled at the dial.
- **Focus.** At 6–7 cm the stock OV2640 lens must be turned for close focus:
  crack its glue dot and rotate it. Not the 120°/160° wide-angle modules: their
  distortion bends the digits and hurts the reading.

## Open questions

These change the list and are not answered yet:

- **Where the meter is** (riser niche, behind a toilet panel) and whether there
  is 230 V nearby. Without power this becomes a battery build with different
  parts.
- **Meter size.** Assumed the usual DN15 with a ~50 mm dial; a larger dial may
  need the shallower or larger box.
- **Whether the meter's own glass fogs.** A sealed box does not help with that.
