# PowerStation

ESPHome firmware for an ESP32 that drives a PowMr hybrid inverter over UART and reads a JKBMS LiFePO4 battery over BLE. Its "logic brain" picks the inverter power priority (`Utility First` / `SBU Battery`) based on grid health, time-of-day tariff, and user switches exposed to Home Assistant. A second, independent script gates battery charging to the cheap night tariff window when `Night Charging Only` is enabled.

For a full explanation of how the firmware behaves — decision rules, magic numbers, the PI30 protocol, command queue mechanics, failure modes — see [`docs/architecture.md`](docs/architecture.md).

## Prerequisites

- Docker Desktop (Windows/macOS) or Docker Engine (Linux).
- For the **first** flash only: a USB cable to the ESP32 and, on Windows, [`usbipd-win`](https://github.com/dorssel/usbipd-win) to forward the serial device into the container. After that, OTA over WiFi is used.
- `secrets.yaml` in this folder. On a fresh clone, copy the example and fill it in:

  ```powershell
  Copy-Item secrets.yaml.example secrets.yaml
  # then edit secrets.yaml
  ```

## Commands

All commands are run from inside `PowerStation/`.

| Action | Command |
| --- | --- |
| Validate config (resolves `!secret`, checks schema) | `docker compose run --rm esphome config power-station.yaml` |
| Compile firmware | `docker compose run --rm esphome compile power-station.yaml` |
| OTA upload to a known device IP | `docker compose run --rm esphome run power-station.yaml --device <esp-ip>` |
| Stream logs from a running device | `docker compose run --rm esphome logs power-station.yaml --device <esp-ip>` |
| Clean build cache | `docker compose run --rm esphome clean power-station.yaml` |

## First-time USB flash (Windows)

1. Plug the ESP32 in via USB.
2. In an admin PowerShell: `usbipd list` to find the bus ID, then `usbipd bind --busid <x-y>` and `usbipd attach --wsl --busid <x-y>`.
3. Uncomment the `privileged: true` and `devices:` lines in `docker-compose.yml`.
4. Run `docker compose run --rm esphome run power-station.yaml --device /dev/ttyUSB0`.
5. Re-comment the USB block once the device is on WiFi — every subsequent upload is OTA.

## Home Assistant

The device is discovered automatically by the [ESPHome integration](https://www.home-assistant.io/integrations/esphome/) via mDNS once it is on the same network as HA. When HA prompts for an **encryption key** during adoption, enter the value of `api_encryption_key` from your `secrets.yaml`. You only need to do this once; HA stores it.

Re-pair the device in HA after rotating the key.

For the full list of sensors and controls exposed to HA see [§12 of the architecture doc](docs/architecture.md#12-home-assistant-interface).

## Notes

- `.esphome/` (build cache) and `secrets.yaml` are gitignored.
- The ESP32 toolchain lives in a named Docker volume (`powerstation_esphome-platformio`) mounted at `/root/.platformio`. Without it, `run --rm` discards the toolchain and re-downloads it on every build; adding it took a warm rebuild from 152 s to 78 s. Wipe it with `docker volume rm powerstation_esphome-platformio` if a toolchain install ever goes bad.
- The previous WiFi password lived in the YAML and is therefore in git history — rotate the WiFi password once you've confirmed the new build flashes successfully.

## Docs

| Doc | About |
| --- | --- |
| [`docs/architecture.md`](docs/architecture.md) | how the firmware works: decision rules, grid-health detection, the PI30 protocol, the command queue, failure modes |
