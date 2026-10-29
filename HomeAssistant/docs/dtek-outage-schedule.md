# DTEK outage schedule

`config/packages/dtek_shutdowns.yaml` plus `config/dtek/dtek_poll.py` pull the
distributor's own view of this address — the queue it sits in, whether DTEK has
an outage recorded against it, and the hourly stabilisation schedule for today
and tomorrow — off the AJAX endpoint behind
[the shutdowns page](https://www.dtek-dnem.com.ua/ua/shutdowns). A `command_line:`
sensor runs the script every five minutes.

The point is not to know that the power is out; the inverter already knows that
within five seconds. It is to tell a scheduled four-hour window apart from the
eight-minute fault that looks identical from inside the house — which is what
`binary_sensor.grid_outage_unscheduled` answers. The other half is acting on
the schedule: [outage-precharge.md](outage-precharge.md) fills the battery
before a scheduled window. The dashboard's second tab, **Load shedding**, is
where you build what the house steps down while the power is out
([load-shedding.md](load-shedding.md)).

Three keys in `/config/secrets.yaml` on the box (see
[`examples/secrets.yaml.example`](../examples/secrets.yaml.example)), and they must
match DTEK's own spelling, which is not a formality — DTEK can carry the same
street twice, with its words in a different order, as separate streets in
different queues:

```yaml
dtek_city:   "<city, exactly as DTEK spells it>"
dtek_street: "<street, exactly as DTEK spells it>"
dtek_house:  "<house number>"
```

Look the spelling up rather than guessing it. The same script does it, and
`DTEK_CITY` / `DTEK_STREET` / `DTEK_HOUSE` override secrets.yaml so it runs
from here too:

```sh
python config/dtek/dtek_poll.py --find "<city>" --street "<first letters of the street>"
DTEK_CITY="<city>" DTEK_STREET="<street>" DTEK_HOUSE="<house>" python config/dtek/dtek_poll.py --verbose
```

The endpoint is undocumented and can change. Two failures are worth
recognising: `Bad Request (#400)` is a dead session or CSRF token, which the
script re-establishes by itself, and `{"result":false,"text":"Error"}` means
either the address is misspelt or the form encoding regressed — the bracket
parameter names have to be percent-encoded, and that is the first thing to
check. `dtek_poll.py`'s docstring is the protocol manual.

## DTEK decides what gets drawn, and says so

The `getHomeNum` answer carries six booleans next to the address data, and
DTEK's own page draws nothing it has not been given permission to draw:

| flag | gates |
| --- | --- |
| `showTablePlan` | the recurring weekly table — with `showTableSchedule`, and with no `else` branch, so a false here means the site shows no grid at all |
| `showTableSchedule` | the same table, one level up |
| `showTableFact` | the today/tomorrow tables |
| `showCurSchedule` | the today/tomorrow section as a whole |
| `showCurOutageParam` | the "no power at your address" banner |
| `showUserGroup` | the queue name beside the address form |

`showTablePlan` has been **false** since DTEK suspended stabilisation
schedules, which is the case that matters: `preset.data` still holds a full
weekly pattern, and it no longer applies. Reading the pattern and ignoring the
flag publishes a schedule DTEK has withdrawn — which is what this did until
03.09.2026.

`visibility()` in `dtek_poll.py` transcribes those rules, including the two
overrides the page applies locally on top of the flags
(`discon-schedule.js:48-53` and `:1107-1112`) and the `tableHidden()` cases at
`:413`. It publishes `week_in_effect`, `schedule_visible`, `hidden_reason` and
the six flags verbatim; the card gates the weekly grid and the two week-derived
hero tiles on the first of those. **A hidden grid is a normal state of the
world, not a fault** — `binary_sensor.dtek_data_stale` stays off through it.

Absent flags default to *shown*. A field DTEK renames must not blank a grid
that is still being published; that is this same bug inverted and harder to
notice, and section 9 of `test_dtek_schedule.py` pins it.

One more stamp worth knowing about: `updated_at` is DTEK's own
"information updated" date and is minutes old, whereas `schedule_update`
stamps the last schedule DTEK published and has read `24.07.2026 08:30` since
they were suspended. Reading only the second makes a live feed look six weeks
dead.

`dashboards/lovelace.dashboard_dtek.json` is the **Shutdowns** dashboard,
sitting directly under Power station in the sidebar. Almost all of it is one
custom card, `config/www/dtek-shutdowns-card.js`, placed twice: `[hero,
timeline, week]` and `[source]`.

- `hero`: the headline, the applied-schedule note, DTEK's stated reason and
  notice, a status pill, and a **24-hour clock** of today: each hour an arc
  coloured from the applied schedule (else the weekly table, else grey), split
  where DTEK splits the hour, the past dimmed, a hand at now, and the countdown
  to the next change in the middle. Three stat tiles under it.
- `timeline`: the section the feature exists for. Today, 00:00–24:00, on four
  rows against the clock's hours: grid down (the inverter's measurement), DTEK's
  live notice (`binary_sensor.dtek_outage_now`), the schedule
  (`binary_sensor.dtek_scheduled_dark`, plus the rest of today from the row), and
  outages nobody announced (`binary_sensor.grid_outage_unscheduled`). The past
  comes from one `history/history_during_period` request for the four since
  midnight, made only while the card is on screen: again when one of them
  changes, and at most every 5 minutes otherwise. Without an answer it says so
  and still draws the schedule. It replaced the stock `history-graph`.
- `week`: DTEK's recurring weekly table, a column per day with the hours down
  the side. While a schedule is applied (`today` / `tomorrow`, from `fact`),
  today's and tomorrow's columns show it instead, and their tooltips say so; an
  unpublished tomorrow keeps the recurring row. When DTEK withholds the table,
  the reason takes its place, followed by just today and tomorrow when a
  schedule is applied, because `plan_off` only withdraws the weekly table.
- `days`: today and tomorrow alone, as the week block draws them. Kept so an
  older config still renders; the dashboard no longer uses it.
- `source`: where the data came from.

The card is drawn in the house's console palette (graphite, muted sage / amber
/ red, IBM Plex from `config/www/fonts/`), like the Power station. Its colours
are its own (`--ds-*`), not the HA theme's, so it reads the same under the
light theme; `tools/test_dtek_card.js` holds every text colour to 4.5:1 on both
panel shades. Animations pause while the card is off screen or the tab hidden.

The hero ranks its states, highest first:

1. **Mains measured down:** "The power is off", in red. Inside an applied
   window the lede gives the window and when it ends ("off 13:30–17:00, back
   by 17:00"). If tomorrow is unpublished and the window reaches midnight, it
   says so rather than invent an end.
2. **A live DTEK notice** (`outage_active`): "DTEK reports an outage", in
   orange.
3. **Inside an applied window, mains still up:** "Scheduled outage until
   17:00", in orange. On 17.10.2026 the window opened at 13:30 and the mains
   lasted until 13:42. Before this rule the card said "The power is on" for
   the whole window.
4. Otherwise **"The power is on"**, in green, turning amber with an "Outage
   soon" pill an hour before the next window starts, so the page warns before
   the alert does.

The "Next window" tile reads the running window while inside one ("now, ends
in 3h 21m"). `next_outage_start` is null then, because the window has already
started.

`❌ Alert: Grid Outage!` and `✅ Power Restored` (in `automations.yaml`) quote
the same thing. Inside an applied window the alert says "On DTEK's schedule
(queue 1.1): off until 17:00." Before, it said "DTEK has nothing on record",
because DTEK never records a stabilisation window as an outage. A restore
inside the window says "Back early".

Note what is deliberately *not* there: the raw entity values. The second design
iteration dropped the Entities list, and the tile grids went with the first, so
`sensor.dtek_next_outage_start` and friends are now only in the badges, the
timeline, and Developer Tools. That is a display decision, not a hint
that something broke.

It is a custom card and not markdown cards because HA sanitises markdown
through `filterXSS` (`frontend/src/resources/markdown-worker.ts`) and that
allowlist has no `style` attribute, no `<style>` tag and no `title` on
`div`/`span`. There is no inline CSS to be had in a markdown card, and no core
card draws an hour grid. The first iteration drew the same tables with block
characters inside a code fence for exactly that reason; this replaces them.

**`www/` is the one part of `/config` that is deployed rather than pulled.** It
is not in `ha_pull.sh`'s exclude list, so whatever is on the box comes back into
git on the next pull. Three things about it that git cannot record:

```sh
sh tools/ha_www_push.sh                     # tree -> /config/www
ssh ha "ha core restart"                    # ONCE, only if /config/www was absent
python tools/ha_dashboard.py --card dtek-shutdowns-card.js
```

1. `/local/` is registered as a static route **at startup, and only if
   `/config/www` exists at that moment**. The first card ever shipped therefore
   needs one restart or every `/local/` URL 404s. Nothing after that does.
2. The resource registration lives in `.storage/lovelace_resources`. That file
   *is* mirrored — `ha_pull.sh` discovers dashboards by the `lovelace` prefix
   and picks it up — but re-applying it into a fresh HA is the `--card`
   command above, which is idempotent and repoints an existing entry rather
   than adding a second.
3. The browser caches an ES module hard. Bump the card's `VERSION` on every
   change and re-run `--card`, or you are looking at the old one. The `?v=` is
   that `VERSION` (see [Versions](../../MANIFEST.md#6-versions)): `--card` reads it
   from the file, and `--resource` refuses a `?v=` that is not `X.Y.Z`.

The card carries its own copy of the schedule alphabet, because it draws a
colour per letter and `dtek_poll.py` cannot reach into a browser.
`tools/check_dtek_templates.py` section 8 asserts the two agree — a letter the
card has never seen renders as a hatched "unknown" cell *and* drops out of the
hour totals, which is a silent undercount on a dashboard that otherwise looks
fine.

`debug_state: outage | unscheduled | stale | on` in the card config forces the
hero into one of those layouts, render-only. It exists because the honest way
to see the outage layout would be to set
`binary_sensor.powmr_inverter_grid_condition_safe` to `on` in Developer Tools,
which fires `❌ Alert: Grid Outage!` and pushes to both phones. Take it out
again afterwards.

Its sidebar *position* comes from `panelOrder` in
`.storage/frontend.user_data_<user>`, which is per-user and is **not** mirrored
by `ha_pull.sh` — the one part of that dashboard git does not record. Re-apply
it with `tools/ha_dashboard.py --order dashboard-dtek --after dashboard-inverter`.

DTEK suspended stabilisation schedules on 24.07.2026 and brought the daily ones
back late on 25.10.2026. The first of them was queue 1.1, 18:00–22:00 on
26.10, and DTEK withdrew it again that afternoon. While they were suspended,
`binary_sensor.dtek_schedule_in_effect` read off and everything
schedule-shaped read `unknown`. That is the right answer whenever it happens
again, not a fault. The weekly table is still withheld (`hidden_reason:
plan_off`), so the week block shows the reason and then today and tomorrow,
while the alerts run on `fact`. If the weekly table comes back, its cells are
mostly `maybe`. The grid draws those as amber hatching, not red, and counts a
possible outage as off, the same way `OFF_HALVES` and the alerts already do.

## When the schedule changes

`📅 DTEK schedule changed` (`dtek_schedule_changed` in the package) pushes
whenever DTEK adds, withdraws or moves a window:

> DTEK queue 1.1: cancelled 18:00–22:00 today. No windows left on the schedule.

The 15-minute alerts cannot do this job. They count down to the next edge, and
a withdrawn window just never arrives. On 26.10.2026 DTEK published
18:00–22:00 overnight and republished the day as all `y` at 15:34. The next
outage sensors went back to `unknown` and nobody heard a thing.

It diffs the `windows` attribute between two polls. `windows` lists every
window that has not ended yet as `[start, end]`, and it is `[]` with no
schedule in force. A running window keeps its real start, so the list only
changes when DTEK changes it. A window that just ends between two polls is not
reported as cancelled, and a moved window reads as one cancelled and one new.
The message ends with the windows the change left alone ("Still on: …").

A change that only cancels goes out on the `DTEK emergency ends` channel.
Anything with a new window goes on `DTEK emergency starts`. Each message has the
tag `dtek_schedule`, so a schedule revised three times in one evening leaves one
notification on the phone. Section 5g of `check_dtek_templates.py` replays
26.10, and section 13 of `test_dtek_schedule.py` pins the list itself.
