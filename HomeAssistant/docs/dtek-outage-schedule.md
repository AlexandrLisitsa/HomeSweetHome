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
`binary_sensor.grid_outage_unscheduled` answers. The dashboard's second tab,
**Load shedding**, is where you build what the house steps down while the power is out
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
the six flags verbatim; the card gates the heatmap and the two week-derived
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
custom card, `config/www/dtek-shutdowns-card.js`, in three stacked full-width
blocks: a hero status banner (headline, the applied-schedule note, DTEK's stated
reason, and three stat tiles), the 7×24 heatmap of DTEK's recurring weekly
table — or, when DTEK is withholding it, the reason why, in place of the grid
and with the card left standing — and where the data came from. Below it, the section the feature exists
for — DTEK's claim and the inverter's measurement on one `history-graph` axis.

Note what is deliberately *not* there: the raw entity values. The second design
iteration dropped the Entities list, and the tile grids went with the first, so
`sensor.dtek_next_outage_start` and friends are now only in the badges, the
comparison graph, and Developer Tools. That is a display decision, not a hint
that something broke.

It is a custom card and not markdown cards because HA sanitises markdown
through `filterXSS` (`frontend/src/resources/markdown-worker.ts`) and that
allowlist has no `style` attribute, no `<style>` tag and no `title` on
`div`/`span`. There is no inline CSS to be had in a markdown card, and no core
card draws a heatmap. The first iteration drew the same tables with block
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

Note that DTEK suspended stabilisation schedules on 24.07.2026, so
`binary_sensor.dtek_schedule_in_effect` is currently off and everything
schedule-shaped reads `unknown`. That is the correct answer, not a fault, and
it means those code paths are exercised only by `tools/test_dtek_schedule.py`
until the schedules return. It also means the recurring table is the only
schedule there is to draw, and that its cells are almost all `maybe` — the
heatmap reads orange, not red, and counts a possible outage as off exactly as
`OFF_HALVES` and the alerts already do.
