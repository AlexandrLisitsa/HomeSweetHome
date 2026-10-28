# Dashboard visual ideas

A backlog of visual effects for the house dashboards, collected on 2026-10-29
from a walk through every view in the browser. Nothing here is built yet; each
item is a proposal. Tick it off and move the detail into the card's own doc once
it ships.

## Where the dashboards stand

| Dashboard | View | State |
|---|---|---|
| Home | Floor plan | Live lamps, airflow, tints and power path; since 1.14.0 also day/night, presence ripples and theme-proof colours (section 1). |
| Power station | Inverter, Battery | Polished dark console: IBM Plex fonts, marching flow lines, pulsing chips. |
| Climate | Rooms, Living room A/C, Bedroom A/C | Console style, dial and charts. Solid. |
| Shutdowns | Shutdowns | Stock HA look: default font, grey `history-graph` bars. Out of step with the rest. |
| Shutdowns | Load shedding | Console style, plain battery bar with threshold markers. |

## Ground rules for every effect

- **Browser-only.** CSS and GPU animation in the card; no new sensors, template
  entities, pollers or timers on the box — the server must spend no CPU on it.
- **Same palette.** Colours and type come from the dashboard design system in
  [`MANIFEST.md`](../../MANIFEST.md); no new one-off colours.
- **Pause when hidden.** Stop animation loops on `document.hidden` and when the
  card scrolls out of view (`IntersectionObserver`).
- **Respect reduced motion.** Every effect has a still fallback under
  `prefers-reduced-motion: reduce`, as the existing keyframes already do.
- **Meaning first.** An effect has to show a real state (power, occupancy,
  temperature, a schedule); no decoration for its own sake.
- **Tooltips** follow [the tooltip standard](dashboard-tooltips.md).

## 1. Floor plan — make the house come alive

Card: `config/www/floorplan-card.js`; pipeline in `FloorPlan/` (see its README).

Already there before this backlog (1.13.0), so not new work: each lamp lights its
room (overlay added with `plus-lighter`, opacity by brightness) with a ring gauge
and glow on its icon; A/C airflow streams in the mode's colour; the floor tint
outside 20–26 °C; the power path from grid and pack to every load, width and pace
by watts; the outage dim and status chip; load-shedding rings.

Done in 1.14.0:

- [x] **Readable under any theme and on any picture.** The card's colours are its
  own (`--fp-*`), never HA's text colours (dark in the light theme, which made the
  phone rows unreadable); every label on the plan sits on a dark pill. The tests
  hold every text/background pair to 4.5:1, a pill as if over pure white.
- [x] **Day and night.** A noon render (`base_day.png`) fades in over the night one
  by `sun.sun` elevation, −6° to +6°; lamps add half their light at full day.
- [x] **Motion ripple.** Rings ripple out from the hallway and bathroom presence
  sensors while they see someone.
- [x] **Switch-on bloom.** A lamp turning on flashes once behind its icon.
- [x] **Glass chips.** The icon discs are lit from above-left and lifted off the
  picture by a soft shadow; same sizes and ring gauge.
- [x] **Pause when not visible.** Every animation holds while the tab is hidden or
  the card is off screen.

## 2. Shutdowns — redesign to match the consoles

Card: `config/www/dtek-shutdowns-card.js`; dashboard
`dashboards/lovelace.dashboard_dtek.json`.

- [ ] **24-hour outage clock.** A ring showing the day's outage windows in red, a
  sweeping hand at the current time, and a countdown to the next change in the
  middle.
- [ ] **Breathing hero.** The "power is on / off" banner gets a slow breathing glow:
  green (on), amber (outage soon), red (off).
- [ ] **Styled timeline.** Replace the grey `history-graph` (grid down, DTEK says
  outage, on the schedule, unscheduled) with a timeline drawn in the card, in the
  console palette.
- [ ] **Typography.** Switch to IBM Plex, same as the Power station.

## 3. Power station and battery

Cards: `config/www/powmr-inverter-console-card.js`,
`config/www/jkbms-battery-console-card.js`.

- [ ] **Odometer numbers.** Values roll to the new reading instead of jumping.
- [ ] **Glow follows power.** A flow tile's glow and its connector's dash speed
  scale with the watts flowing through it.
- [ ] **Liquid SOC.** The battery gauge fills like liquid, with a shimmer while
  charging.
- [ ] **Balancing pulse.** Cells being balanced pulse in the cell row.
- [ ] **Chart polish.** A gradient fill under each history line and a pulsing dot
  at the latest value.

## 4. Climate

Card: `config/www/climate-console-card.js`.

- [ ] **Gradient dial.** The setpoint arc shows a cold → warm gradient, coloured by
  mode, with a slow spin while the compressor runs.
- [ ] **Tinted rooms.** Each room card's background is tinted by its temperature.

## 5. Load shedding

Card: `config/www/load-shedding-card.js`.

- [ ] **Live thresholds.** Step markers light up as the battery approaches them.
- [ ] **Danger zone.** A red band below the lowest step on the battery bar.

## Files each item touches

```
HomeAssistant/
├── config/www/
│   ├── floorplan-card.js                 section 1
│   ├── dtek-shutdowns-card.js            section 2
│   ├── powmr-inverter-console-card.js    section 3
│   ├── jkbms-battery-console-card.js     section 3
│   ├── climate-console-card.js           section 4
│   └── load-shedding-card.js             section 5
├── dashboards/
│   ├── lovelace.dashboard_dtek.json      section 2 (history-graph → card timeline)
│   └── lovelace_resources.json           version bump per card
├── tools/
│   ├── test_floorplan_card.js            section 1
│   ├── test_dtek_card.js                 section 2
│   └── test_power_cards.js               section 3
└── docs/
    ├── power-station-dashboard.md        section 3
    ├── climate-dashboard.md              section 4
    ├── dtek-outage-schedule.md           section 2
    └── load-shedding.md                  section 5
```

## Suggested order

1. ~~Floor plan (section 1)~~ — done in floorplan-card 1.14.0.
2. Shutdowns redesign (section 2) — brings the odd page in line.
3. Sections 3–5 — polish on pages that already look good.

One `feature/` branch per section off `master`; check each in the browser on
desktop and phone width before deploying to the box.
