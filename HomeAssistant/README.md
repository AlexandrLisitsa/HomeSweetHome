# HomeAssistant

A live [Home Assistant](https://www.home-assistant.io/) configuration, mirrored
into git, plus the tooling to pull it down, push changes back and talk to the
box. It runs a Home Assistant OS install with the SSH add-on, Zigbee2MQTT,
ESPHome devices (see [`../PowerStation`](../PowerStation)), an Android phone used
as an IR blaster (see [`../IRBridge`](../IRBridge)) and Google Home.

The point of mirroring is that every change to the house is a `git diff` you can
read before it goes live, and a `git revert` if it was wrong.

## What's in it

- **`config/`**: the whole Home Assistant configuration: automations, packages and
  scripts, with every live entity id in English.
- **Custom Lovelace cards** in `config/www/`: the Power station (inverter and
  battery, [`docs/power-station-dashboard.md`](docs/power-station-dashboard.md)),
  Climate, Shutdowns (DTEK) and Home (floor plan, see
  [`../FloorPlan`](../FloorPlan)) dashboards. Each card is versioned
  (see [MANIFEST, Versions](../MANIFEST.md#6-versions)).
- **The DTEK outage schedule**: a poller for the distributor's queue and hourly
  schedule, so a planned outage can be told apart from a fault
  ([`docs/dtek-outage-schedule.md`](docs/dtek-outage-schedule.md)).
- **Outage pre-charge**: when DTEK schedules an outage, the battery is charged
  to full before it starts, at the lowest current that makes it and at night
  rates when they suffice ([`docs/outage-precharge.md`](docs/outage-precharge.md)).
- **Adaptive night charge**: the night-tariff charge runs at the lowest current
  that still fills the pack by 07:00, re-sized every 10 minutes
  ([`docs/adaptive-charge.md`](docs/adaptive-charge.md)).
- **Load shedding**: during an outage, devices step down one by one as the
  battery drains, with a warning one step ahead and everything put back when
  the grid returns. The rules are built on the Shutdowns dashboard: any device,
  any number of steps, any action it supports
  ([`docs/load-shedding.md`](docs/load-shedding.md)).
- **Electricity from the meter itself**: a photodiode on its imp/kWh LED,
  over MQTT, split day/night for the Energy dashboard
  ([`docs/electricity-meter.md`](docs/electricity-meter.md)).
- **Gas and water on the Energy dashboard**, from hand-read meters
  ([`docs/gas-and-water-meters.md`](docs/gas-and-water-meters.md)).
- **Monthly gas reading to Gazmerezhi**: on the 1st the phone shows the meter
  photo and the number, and one button sends it through the operator's Telegram bot
  ([`docs/gas-reading-submission.md`](docs/gas-reading-submission.md)).
- **Monthly electricity reading to YASNO**: at the end of the month the phone
  shows the meter's day and night readings, and one button sends them through
  YASNO's Telegram bot
  ([`docs/electricity-reading-submission.md`](docs/electricity-reading-submission.md)).
  Every Monday `packages/meterbots_session.yaml` asks MeterBots whether its
  Telegram session is still logged in, and notifies if not, so a dead session
  is found before the month-end ask.
- **Two air conditioners**: an infrared one through [`../IRBridge`](../IRBridge)
  and a networked one ([`docs/climate-dashboard.md`](docs/climate-dashboard.md)).
- **Google Home and Gemini**: entities exposed through the Google Assistant
  integration, with the spoken names kept in a git-ignored file
  ([`docs/private-files.md`](docs/private-files.md)). Google reaches the box
  through a Cloudflare Tunnel ([`../Proxmox/docs/103-cloudflare.md`](../Proxmox/docs/103-cloudflare.md)).
- **`tools/`**: pulling the mirror, pushing cards and dashboards, reading and
  calling the API, and local checks (below).

## Prerequisites

- Home Assistant OS (or Supervised) with the **Terminal & SSH** add-on.
- An SSH key authorised in that add-on, and a long-lived access token (below).
- `sh`, `ssh`, `tar` and Python 3.11+ with `pip install -r tools/requirements.txt`.

| Thing | Value |
| --- | --- |
| Host | your HA box, e.g. `homeassistant.local` — HTTP on `8123`, SSH on `22` as root |
| SSH alias | `ha` in `~/.ssh/config`, with a dedicated key such as `~/.ssh/ha_ed25519` |
| Mirror | `config/` — committed, a verbatim copy of the box's `/config` |
| Dashboards | `dashboards/` — committed; the Lovelace configs out of `.storage` |
| Private files | see [`docs/private-files.md`](docs/private-files.md) and [`examples/`](examples) |
| Registry snapshots | `.state/` — gitignored, audit input only |
| Credentials | `secrets.env` — gitignored; see `secrets.env.example` |

## Access, once

Two credentials, both revocable, doing different jobs. SSH edits `/config`, runs
`ha core check` and restarts. The token reads live entity state and reloads
automations *without* a restart, which is the difference between a 5-second and
a 60-second iteration loop.

**1. SSH key.** Generate a dedicated key (`ssh-keygen -t ed25519 -f ~/.ssh/ha_ed25519`)
and add a `Host ha` entry to `~/.ssh/config`. To authorise it: Home Assistant →
Settings → Add-ons → the SSH add-on → Configuration → add the line from
`~/.ssh/ha_ed25519.pub` to `authorized_keys` → Save → Restart the add-on. If the
field is not shown, switch that panel to YAML mode (three dots → *Edit in YAML*).

Adding a key does **not** disable password login. Set a long random password (or
none) in the add-on as well.

**2. Long-lived access token.** Home Assistant → avatar (bottom-left) →
Security → Long-lived access tokens → Create token. Shown once. Paste it into
`secrets.env` (copy `secrets.env.example` first).

Verify both:

```sh
ssh -o BatchMode=yes ha "ha core info"
sh tools/ha_get.sh /api/config
```

## Tools

| Script | Does | Prompts? |
| --- | --- | --- |
| `tools/ha_pull.sh` | one `tar czf -` over SSH into `config/`, plus three registry snapshots and every Lovelace dashboard | no — read-only on the box |
| `tools/ha_get.sh` | GET against the REST API — `sh tools/ha_get.sh /api/states` | no — GET-only by construction |
| `tools/_ha_env.sh` | not a command: sourced by `ha_get.sh` and `ha_call.sh` to load `HA_URL` / `HA_TOKEN` from `secrets.env` | — |
| `tools/ha_call.sh` | calls a service — **changes the house** | yes, deliberately |
| `tools/ha_dashboard.py` | create / push / reorder Lovelace dashboards over the WebSocket API — **changes the house** | yes, deliberately |
| `tools/ha_registry.py` | lists orphaned registry rows and open repairs; `--remove` / `--clear-stats` **change the house** | reads: no. writes: yes |
| `tools/check_dtek_templates.py` | renders every Jinja template in `packages/dtek_shutdowns.yaml` and the DTEK dashboard against fake states | no — pure local |
| `tools/check_climate_card.py` | cross-references every entity `climate-console-card.js` names against `/api/states` | no — GET-only |
| `tools/test_dtek_schedule.py` | fixture tests for `config/dtek/dtek_poll.py`'s schedule maths | no — no network |
| `tools/test_outage_precharge.py` | renders the outage pre-charge plan in `packages/outage_precharge.yaml` and runs its drive and started automations through the simulator | no — pure local |
| `tools/test_adaptive_charge.py` | renders the adaptive night charge plan in `packages/adaptive_charge.yaml` and runs its drive, outage-off and guard automations through the simulator, DST included | no — pure local |
| `tools/test_battery_runtime.py` | renders `packages/battery_runtime.yaml`: runtime remaining, time to full and its edge triggers, against idle, unavailable, flat and full packs | no — pure local |
| `tools/test_tariff_switch.py` | runs the day/night tariff automation in `config/automations.yaml` at 07:00 / 23:00, on HA start and over DST weekends | no — pure local |
| `tools/test_electricity_submit.py` | the monthly YASNO reading: `config/electricity/electricity_submit.py`'s window and month, the same window in `packages/electricity_submit.yaml` for every day of three years, and its button handler's parsing | no — pure local |
| `tools/test_gas_submit.py` | `config/gas/gas_submit.py` against a fake MeterCam on localhost: where it finds MeterCam, the month, the photo, the state file | no — localhost only |
| `tools/ha_automation_sim.py` | not a command: a small simulator the tests above use to run a package's `automation:` list against a fake house (limits in its docstring) | — |
| `tools/test_power_cards.js` | render and logic tests for the inverter, battery and load-shedding cards against a fake `hass` and a small DOM | no — pure local |
| `tools/test_load_shedding.py` | renders the load-shedding engine's templates in `packages/load_shedding.yaml` (decision, warnings, validator, stores, restore) against fake states | no — pure local |
| `tools/test_climate_chart.js` | fixture tests for the climate card's chart and dial maths | no — no network |

`ha_pull.sh` extracts to a temp dir and swaps, so a failed pull leaves the old
mirror intact, and a file deleted on the box shows up as a deletion in git
rather than lingering. It refuses to install a mirror containing anything from
the exclude list.

## Deploying a change

Edit `config/` here, never the box, so the change is a `git diff` first. Run the
local checks below, copy the changed file over (`ssh ha` does the transfer, the
same way `ha_www_push.sh` does for `/config/www`), then `ssh ha "ha core check"`
and restart or reload. Finish with `sh tools/ha_pull.sh`: an empty diff is the
proof the box now matches the repo.

The one-shot IRBridge installer (`ha_preflight.sh` → `ha_deploy.sh` →
`ha_verify.sh`, and its `DEPLOY.md` runbook) did the first install on
2026-08-23 and has since been removed; it is in git history if it is ever
needed again.

Local checks worth running before any transfer, all read-only:

```sh
python ../IRBridge/tools/check_ha_entities.py config
python ../IRBridge/tools/check_ha_templates.py
python tools/check_dtek_templates.py
python tools/test_dtek_schedule.py
python tools/test_outage_precharge.py
python tools/test_adaptive_charge.py
python tools/test_battery_runtime.py
python tools/test_tariff_switch.py
python tools/test_gas_submit.py
python tools/test_electricity_submit.py
python tools/test_load_shedding.py
node tools/test_power_cards.js
```

The DTEK, pre-charge, adaptive-charge and load-shedding ones need `python -m pip install -r tools/requirements.txt`;
`ha_dashboard.py` needs it too, for `websocket-client`.

The first cross-references every entity id the YAML *references* against the
ones it *creates* — a template pointing at a nonexistent sensor is not a config
error, so it deploys fine and reads `unknown` forever. It also checks line
endings, which is why `.gitattributes` pins `*.sh` and `*.yaml` to LF: HAOS runs
BusyBox `ash`, which does not tolerate CRLF, and Git Bash hides the problem
locally.

## Backups

HA makes a full, encrypted backup every night and keeps it in two places: 3
copies on its own disk and 14 on Google Drive, through the *Google Drive*
integration (signed in as the household's infrastructure Google account). The
backup encryption key must also be in the household password manager: without
it no copy can be restored. Settings → System → Backups shows both locations.

The mirror in `config/` is not a backup: it leaves out the database,
`.storage` and every secret. What the whole home's backups look like, and how to
restore HA onto a fresh VM, is in
[`../Proxmox/docs/backups.md`](../Proxmox/docs/backups.md).

The Proxmox host's off-site backups report here: `packages/backup_alerts.yaml`
takes a webhook from the backup hook and passes a failed upload, an aborted
job or a nearly full Drive to `notify.household`.

## Docs

| Doc | About |
| --- | --- |
| [`docs/private-files.md`](docs/private-files.md) | what is never mirrored into git, and the household-language files kept out of it |
| [`docs/dtek-outage-schedule.md`](docs/dtek-outage-schedule.md) | the DTEK outage-schedule poller, its sensors and its card |
| [`docs/outage-precharge.md`](docs/outage-precharge.md) | charging the battery to full before a scheduled DTEK outage, and its icon on the AC charge chip |
| [`docs/adaptive-charge.md`](docs/adaptive-charge.md) | the night charge at the lowest current that fills the pack by 07:00, and its icon on the AC charge chip |
| [`docs/load-shedding.md`](docs/load-shedding.md) | the load-shedding engine and its constructor tab: steps, warnings, holds, overrides, restore, backup |
| [`docs/electricity-meter.md`](docs/electricity-meter.md) | the meter-reading board's entities, the day/night split, the Energy dashboard swap, correcting the register |
| [`docs/gas-and-water-meters.md`](docs/gas-and-water-meters.md) | hand-read gas and water meters on the Energy dashboard |
| [`docs/gas-reading-submission.md`](docs/gas-reading-submission.md) | the monthly gas reading to Gazmerezhi's Telegram bot, confirmed from the phone |
| [`docs/electricity-reading-submission.md`](docs/electricity-reading-submission.md) | the monthly day/night electricity reading to YASNO's Telegram bot: the T21/T22 registers, calibrating them, the ask and the buttons |
| [`docs/power-station-dashboard.md`](docs/power-station-dashboard.md) | the Power station dashboard: the inverter and battery cards, the grid-return countdown, the palette |
| [`docs/climate-dashboard.md`](docs/climate-dashboard.md) | the climate dashboard and its checker |
| [`docs/ac-features.md`](docs/ac-features.md) | the inventory of both A/C units' features the climate card is built from |
| [`docs/renaming-entities.md`](docs/renaming-entities.md) | renaming entity ids across the registry, dashboards and YAML |
| [`docs/remote-access-security.md`](docs/remote-access-security.md) | how HA is reached from the internet: the traffic flow, and how each request is accepted or denied |
