# DTEK outage schedule

`config/packages/dtek_shutdowns.yaml` plus `config/dtek/dtek_poll.py` pull the
distributor's own view of this address — the queue it sits in, whether DTEK has
an outage recorded against it, and the hourly stabilisation schedule for today
and tomorrow — off the AJAX endpoint behind
[the shutdowns page](https://www.dtek-dnem.com.ua/ua/shutdowns). The same run
also reads YASNO's public per-queue status and the popup on DTEK's home page,
the two places Ukrenergo's emergency outages show up
([below](#ukrenergos-emergency-outages)). A `command_line:` sensor runs the
script every five minutes.

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

The endpoint is undocumented and can change. Three failures are worth
recognising: `Bad Request (#400)` is a dead session or CSRF token, which the
script re-establishes by itself, and `{"result":false,"text":"Error"}` means
either the address is misspelt or the form encoding regressed — the bracket
parameter names have to be percent-encoded, and that is the first thing to
check. The third is an answer that is not JSON at all, as on 04.11.2026
21:53–22:58, an hour of them that cleared up on DTEK's side. The script waits
10 s and asks once more. If the second answer isn't JSON either, the poll goes
stale with an error that names what came back (`DTEK answered 200 text/html, …
not JSON: <page title>`). The body is kept as `captures/nonjson_*.txt` (last
10). `dtek_poll.py`'s docstring is the protocol manual.

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
  to the next change in the middle. While DTEK's live notice is up (an
  emergency outage has no schedule behind it), its span is drawn over the hours
  as a hatched red arc, to the minute, and the countdown runs to the notice's
  end time ("until back", or "overdue" once it has passed). Three stat tiles
  under it.
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
4. **Ukrenergo's emergency outages announced, mains still up:** "The power is
   on", but amber, with an "Emergency outages" pill: the power can go at any
   time and no schedule applies. The clock's hours turn amber (hours the
   schedule has definitely off stay red), the centre reads "emergency
   outages", and the Next window tile says schedules don't apply now. With
   mains down it is rank 1, but the pill says "Power off" rather than "Off ·
   not announced", because the popup is the announcement.
5. Otherwise **"The power is on"**, in green, turning amber with an "Outage
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

DTEK does sometimes record a schedule window against the address, an hour or
so into it: type 2 (the emergency code) with the reason `Стабілізаційне
відключення (Згідно графіку погодинних відключень)`. That record is the
schedule, which the 15-minute warning already announced, so the DTEK record
alerts stay silent for it: no "DTEK emergency outage", no "restore time
revised", no "estimate passed", no "outage cleared". The only record
messages are a change of kind: a stabilisation record turning into a real
emergency (`⚠️ Alert: DTEK emergency outage`), and an emergency DTEK
reclassifies as the schedule (`📅 DTEK: back to the schedule, no longer an
emergency`). Before 05.11.2026 the record pinged "DTEK emergency outage" at
01:08, in the middle of a window.

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
`binary_sensor.grid_down` to `on` in Developer Tools,
which fires `❌ Alert: Grid Outage!` and pushes to both phones. Take it out
again afterwards.

`debug_banner: emergency | pending | notice | yasno | none` does the same for
the popup: DTEK's 01.11.2026 text in red, the same text grey (`pending`, the
sensor still debouncing), another area's notice in grey, the one-line red
notice the card draws when YASNO alone turned the sensor on, or nothing. For a
page you can click through, `debug_state_entity` and `debug_banner_entity`
name an `input_select` each, whose options are those values plus `live`; the
card follows them as they change. That is how the Playground for this feature
was built: two temporary helpers above one full Shutdowns card, all removed
afterwards. Real dashboards set none of the four.

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

## Ukrenergo's emergency outages

When generation runs short, Ukrenergo orders emergency outages: no schedule,
no end time. DTEK announces them **only** in a hand-written popup on its home
page, `<div id="modal-attention">`, which its own script shows on load
whenever it is in the page. No AJAX answer mentions it, and every house
entry stays blank. On 01.11.2026 it read "За рішенням Укренерго запроваджено
екстрені відключення по місту Дніпро" while `binary_sensor.dtek_outage_now`
said off.

So each run also GETs `/ua` gzipped (~72 KB, ~20 MB a day) and reads that
div: `fetch_banner()` and `parse_banner()` in `dtek_poll.py`. A page without
the div means no announcement. A page without the site's own markup is an
error, not "none", so a challenge page cannot clear a real announcement. The
sensor publishes:

| attribute | |
| --- | --- |
| `banner_title`, `banner_text` | DTEK's words, verbatim, one line per paragraph |
| `banner_scope` | `city`, `region`, `country` (all of Ukraine, or no place named) or `other` (somewhere else): which place the popup names |
| `banner_emergency` | whether it announces emergency outages here, now |
| `banner_checked_at` | when the popup was last read successfully |
| `banner_error` | why the latest read failed, else null |

A failed read never fails the poll. The last banner stays, `banner_checked_at`
keeps its old time, and `banner_error` says why. It is not a `warnings` entry
on purpose: those trigger captures, and a flaky GET would rotate the real ones
out. Captures do fire when the banner text changes, with the banner in
`_meta`, so real wordings pile up to test against.

The card never shows a kept banner as the current one. Once `banner_checked_at`
is more than 20 minutes old (the emergency sensor's limit), it hides the
announcement box. The live schedule line still says which regime applies. On 03.11.2026 the site started
answering the page GET with HTTP 403 (an Imperva bot check) at 06:55, while
the AJAX endpoint kept working. The morning "екстрені" text then stayed up
under a popup that already said "стабілізаційні". The bot check has stayed, so
the popup is now usually unread and YASNO's status (next) carries the flag.

### YASNO's queue status

YASNO's own site and app read a public JSON feed:
`https://app.yasno.ua/api/blackout-service/public/shutdowns/regions/3/dsos/301/planned-outages`
(region 3 is Dnipro, dso 301 is DTEK Dnipro Grids). It answers a plain GET:
no cookies, no challenge, about 6 KB. For every queue, `1.1` to `6.2`, it
gives `today` and `tomorrow`, each with a `date` and a `status`:
`ScheduleApplies`, `WaitingForSchedule`, `NoOutages`, or `EmergencyShutdowns`
during Ukrenergo's emergency outages. The open-source
[ha-yasno-outages](https://github.com/denysdovhan/ha-yasno-outages)
integration reads the same feed, and its users report `EmergencyShutdowns`
during real emergencies.

Each run reads it after the DTEK poll, whether or not that poll worked:
`fetch_yasno()`, `yasno_verdict()` and `apply_yasno()` in `dtek_poll.py`. Found
on 04.11.2026, when every other source was closed: the popup is in the
bot-checked HTML only (no AJAX method returns it), ua.energy and
`api.yasno.com.ua` answer scripts with a WAF page, and no Telegram channel
posts both the start and the end. The sensor publishes:

| attribute | |
| --- | --- |
| `yasno_status_today`, `yasno_status_tomorrow` | YASNO's status for our queue |
| `yasno_emergency` | whether YASNO puts us under emergency outages today |
| `yasno_emergency_queues` | every queue it puts under them today |
| `yasno_updated_on` | when YASNO last changed our queue |
| `yasno_checked_at` | when the feed was last read successfully |
| `yasno_error` | why the latest read failed, else null |

`yasno_emergency` is strict in the same way as the popup rules below. It needs
the exact `EmergencyShutdowns`, on a `today` block whose date really is today,
for one of **our** queues: an emergency can cover only part of the city, and
YASNO marks it per queue. With no queue known (DTEK unread), it needs every
queue under emergency outages. An unknown status goes into `warnings`, which
turns on `binary_sensor.dtek_format_drift`, and never raises the flag. A
failed read keeps the last verdict, the same way the banner does. When our
status changes, the raw answer is saved as `captures/yasno_*.json`.
Section 15 of `test_dtek_schedule.py` covers all of it, starting from the real
answer of 04.11.2026 (`tools/fixtures/yasno_planned_20261104.json`).

### Built to miss rather than cry wolf

An alert hangs off this, so a false "on" costs more than a late one. The text
is on the dashboard whatever the flag says.

1. **One sentence at a time** (`banner_emergency()`). A sentence counts only
   if it has all four:
   - the outage words (`екстрен… відключен…`, one н or two);
   - a now-in-force verb: запроваджено, застосовано, діють, тривають,
     введено, оголошено…;
   - none of the not-now words: скасовано, завершено, припинено, не діють,
     більше не, вчора, минул…, запобігання, уникнути, можливі, загроза,
     ризик;
   - a place that includes us, read off **that same sentence**: this city,
     this region, the whole country, or no place at all. The city comes
     from `dtek_city` with at most a two-letter case ending (Дніпро, Дніпра,
     Дніпрі), so neither Дніпропетровській nor DTEK's own name, Дніпровські
     електромережі, counts as the city. The region is
     Дніпропетровськ… / Дніпропетровщин…. The country is Україн…, країн…,
     по всій, всіх регіонах. A sentence naming no place is DTEK's own
     popup speaking about its own area: on 03.11.2026 "За наказом НЕК
     Укренерго введені екстрені відключення електроенергії." named nothing
     and was about us.

   A notice naming somewhere else (a preposition and a capitalised name,
   "у Києві", "в Харкові", or any oblast but ours), advice to save power,
   or an all-clear is shown in grey and never raises the flag.
2. **Two polls must agree.** `binary_sensor.dtek_emergency_shutdowns` has
   `delay_on: 10 min`.
3. **Fresh or nothing.** The sensor is on when a source read in the last 20
   minutes says so: YASNO's `yasno_emergency` or the popup's
   `banner_emergency`. With neither read for 20 minutes it goes
   `unavailable`, not `on`. Its `source` attribute says which one is behind
   an `on`: `yasno`, `banner` or `both`.

The card turns red and amber from that binary sensor, never from the raw
attribute. When the sensor is on and there is no fresh popup to quote, the
card shows one line instead: "YASNO marks queue 3.2 as under emergency
outages". It never brings back a kept popup as today's. Section 14 of `test_dtek_schedule.py` replays the real popup and
the false-positive sentences; section 5h of `check_dtek_templates.py` covers
the sensor and the alerts.

### The alerts

`⚠️ Alert: Ukrenergo emergency outages` fires when the sensor goes `off` →
`on`, and `✅ Alert: Ukrenergo emergency outages lifted` on `on` → `off`, on
the same two channels as the DTEK outage pair and with one tag,
`dtek_emergency_banner`, so "lifted" replaces "announced" on the lock screen:

> За рішенням Укренерго запроваджено екстрені відключення по місту Дніпро. No
> schedule applies and DTEK gives no end time. The inverter still sees mains.
> Battery 100%.

DTEK's line is quoted only when the popup is a source of this `on`. When YASNO
alone turned it on, the message starts "YASNO marks queue 3.2 as under
emergency outages." instead, so an old popup is never sent as news.

Edges out of `unknown` (a restart) or `unavailable` (an unread popup) fire
nothing. That includes the sensor's first `on` after it is created, so an
emergency already running when this is deployed is not pushed.

`binary_sensor.grid_outage_unscheduled` and the grid alerts do not read any of
this yet: during emergency outages every outage is still unscheduled, which
is true.

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
