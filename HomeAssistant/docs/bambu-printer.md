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
| `sensor.p2s_ams_1_tray_1` … `_4`, `sensor.p2s_external_spool` | filament per slot; `type` and `color` in the attributes |

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

## Dashboard

`dashboards/lovelace.dashboard_printer.json`, at `/dashboard-printer`:
print, camera, temperatures and AMS, in built-in cards only. The camera card
fetches stills only while the page is open, so it costs nothing at idle.
Push it with:

```sh
python tools/ha_dashboard.py --create dashboard-printer --title "3D printer" --icon mdi:printer-3d
python tools/ha_dashboard.py --push dashboards/lovelace.dashboard_printer.json --url-path dashboard-printer
```

The integration also installs its own Lovelace cards (`ha-bambulab-cards`,
registered as a resource automatically); they are not used here.
