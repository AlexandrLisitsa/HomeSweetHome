# Bambu Lab P2S

The P2S Combo (printer + AMS 2 Pro) is in Home Assistant through
[ha-bambulab](https://github.com/greghesp/ha-bambulab), installed from the
Marketplace. It sends alerts to the household's phones and has its own
**3D printer** dashboard.

## How it is connected

- **Local MQTT, cloud still on.** The integration was added in *Bambu Lab
  cloud* mode with **Connect directly to printer mqtt** switched on. Status
  comes straight from the printer over the LAN (`sensor.p2s_mqtt_connection_mode`
  reads `local`), and the Bambu account is used only for the job name, the
  cover image and print history. The Handy app and cloud printing keep working;
  LAN-only mode is off.
- **HA watches, it doesn't drive.** The P2S firmware signs its MQTT commands
  while the printer is linked to the cloud, so the only thing HA can control
  is the chamber light. Pause, stop, temperatures and fans go through the
  screen or Bambu Handy. The integration raises an *MQTT Encryption Enabled*
  repair about it; the repair was dismissed on purpose. Full control would need
  Developer LAN mode, which cuts off the cloud, Handy and remote printing.
  Status, alerts, the camera and the AMS are unaffected.
- **Address.** The integration takes the printer's IP from the Bambu cloud and
  keeps it in the config entry. The printer is on DHCP for now; once the router
  pins it, change the host under *Settings → Devices → Bambu Lab → Configure*
  and add it to the network table in the root README.
- **Camera.** The P2S streams over RTSP only when **LAN Mode Liveview** is on
  in the printer's network settings. Until then `camera.p2s_camera` is
  `unavailable`.
- **Access code.** If the printer's access code changes (after a reset, or by
  hand on its screen), re-run *Configure* on the integration; the cloud hands
  over the new one.

## Entities

The device is **P2S**, plus **P2S AMS** and **P2S External Spool**. The
integration names entities after the serial number; they were renamed to drop
it, so every entity id is `*.p2s_*` and the serial stays out of git. The ones
this repo uses:

| Entity | What |
| --- | --- |
| `sensor.p2s_print_status` | `idle`, `prepare`, `running`, `pause`, `finish`, `failed`, `offline` |
| `sensor.p2s_print_progress`, `sensor.p2s_remaining_time`, `sensor.p2s_end_time` | progress, hours left, finish time |
| `sensor.p2s_task_name`, `image.p2s_cover_image` | the job and its sliced plate |
| `binary_sensor.p2s_hms_errors` | the printer's health system; attributes `1-Error`, `1-Severity`, … and `Count` |
| `binary_sensor.p2s_print_error` | the print error; attributes `code`, `error` |
| `sensor.p2s_ams_1_tray_1` … `_4`, `sensor.p2s_external_spool` | filament per slot; `type`, `color`, `empty` and `remain` (RFID %, else -1) in the attributes |

`IRBridge/tools/check_ha_entities.py` treats `sensor.p2s_`, `binary_sensor.p2s_`
and `image.p2s_` as external, like the other config-entry devices.

## Alerts

`config/packages/bambu_printer.yaml`, all to `notify.household`, channel
*3D printer*:

| Automation | When | Says |
| --- | --- | --- |
| `p2s_print_finished` | status goes from running/pause/prepare to `finish` | the job name and weight, with the plate image |
| `p2s_print_failed` | the same, to `failed` | the job name and the printer's error text, with the plate image |
| `p2s_hms_error` | `binary_sensor.p2s_hms_errors` turns on | each HMS error with its severity |

Done and failed share the tag `p2s_print`, so one replaces the other on the
phone. The `from:` states keep a restart from firing them: after a restart
the status comes back from `unknown` straight to the last job's end state.

## Filament left

The P2S knows what is left only on RFID Bambu spools: the tray's `remain`
attribute is a percentage there and `-1` on anything else (the Generic PLA in
A1 reads `-1`). So the same package keeps HA's own count, in grams:

| Entity | What |
| --- | --- |
| `input_number.p2s_filament_a1` … `_a4`, `input_number.p2s_filament_ext` | grams left per slot; no `initial:`, so they survive restarts |
| `input_number.p2s_spool_size` | what a fresh spool counts as (1000 g) |

| Automation | When | Does |
| --- | --- | --- |
| `p2s_filament_used` | status goes from running/pause/prepare to `finish` or `failed` | takes the job's sliced grams per slot (`sensor.p2s_print_weight`'s `AMS 1 Tray N` attributes) off each counter; a failed job takes its share up to the progress it reached; never below 0 |
| `p2s_spool_loaded` | a tray's `empty` attribute goes `true` → `false` | sets that slot to `p2s_spool_size` |

A spool put back half-used is the one case the reset gets wrong: tap the slot
on the console card and type the right figure into its counter. Counting began
on 07.11.2026 with A1 at 984 g (a 1 kg spool less two door handles, about
16 g). The sliced weight is the slicer's estimate, so the count drifts a few
percent per spool; weigh a spool now and then and correct it. When a spool has
an RFID figure, the card shows that instead of the count. The external spool's
attribute key in `print_weight` has not been seen yet; the automation takes any
key that mentions "xternal". `tools/check_automations.py` section 14 pins both
automations.

## Dashboard

`dashboards/lovelace.dashboard_printer.json`, at `/dashboard-printer`: one
**panel** view holding the console card below, nothing else. Push it with:

```sh
python tools/ha_dashboard.py --create dashboard-printer --title "3D printer" --icon mdi:printer-3d
python tools/ha_dashboard.py --push dashboards/lovelace.dashboard_printer.json --url-path dashboard-printer
```

The integration also installs its own Lovelace cards (`ha-bambulab-cards`,
registered as a resource automatically); they are not used here.

## Console card

`config/www/p2s-printer-console-card.js` (`custom:p2s-printer-console-card`,
no required keys) draws the whole printer as one page. It follows the "P2S
dashboard" design (07.11.2026), with IBM Plex in place of Inter and JetBrains
Mono, since cards load no fonts from the internet. Tests:
`tools/test_printer_card.js`.

- **It fills the view.** Put it alone in a **panel** view. The card is the
  viewport's height minus HA's top bar (`--p2s-height` overrides that), and
  everything inside sizes itself from the card's own width and height, so
  resizing the window refits it. Nothing scrolls. Landscape (wider than
  1.15 × tall): virtual printer + AMS on the left, progress + camera on the
  right. Portrait: one column of printer, progress, camera, AMS, with the AMS
  shrunk to one line. Checked at 1740×845 down to 360×640.
- **Virtual printer.** An SVG of the P2S drawn from live data: the bed steps
  down and the part rises with progress, the toolhead scans while printing, the
  fan spins over 60 °C, the AMS spools take their trays' colours, and the
  door, chamber light, front display and a failed print's spaghetti all
  follow the printer. Its tags (nozzle, bed, chamber, layer, AMS) open the
  sensor on a tap; when the drawing is narrower than 600 px they become a
  strip under it.
- **Camera only while printing.** During `prepare`, `running` and `pause` the
  camera box shows a still from `camera_proxy`, refreshed every 10 s while the
  page is visible (`camera_view: live` mounts a `picture-entity` stream
  instead). Any other time the timer and the camera card are gone and the box
  shows the last plate image, so an idle printer costs nothing.
- **Filament left.** Each AMS slot shows its grams left with a bar of the
  spool, amber under 100 g and red at 0; the AMS tag on the printer shows the
  feeding slot's. Tapping a slot opens its counter (or the tray, for an RFID
  spool). While a job runs, if the feeding slot holds less than the job still
  needs, the error line says so ("A1 has 80 g left; this job needs about 135 g
  more").
- **Errors.** HMS errors and the print error show as one line under the
  header, only while there is one.
- **Playground keys.** `debug_status: <status>` forces a status with mock
  numbers; nothing is sent to the printer. `debug_status_entity:
  input_select.…` follows a helper with the options `live` plus the seven
  statuses and shows the design's "Preview state" bar, with a door preview
  button that draws the door open or shut. Real dashboards set neither. The
  card was designed on such a Playground (a temporary dashboard and helper,
  deleted on 07.11.2026); make a new one the same way to try changes.

Register a new version with `python tools/ha_dashboard.py --card
p2s-printer-console-card.js`.
