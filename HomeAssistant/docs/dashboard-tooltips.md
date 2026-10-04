# Dashboard tooltips

Every meaningful element on our custom cards (`config/www/*.js`) explains itself
on hover. This is the standard those tooltips follow; `MANIFEST.md` §8 makes it a
rule and `tools/test_card_tooltips.js` enforces it in CI.

## The format

```text
<Name> — <live state>        line 1: what you are looking at, and its state if it has one
<What it is or does.>        line 2: one sentence in plain words, the meaning, not the entity id
E.g. <concrete example>      line 3: real numbers from this house
<Limit or tap hint>          line 4, optional
```

- **Three or four lines, each at most 90 characters.** A browser tooltip is a
  small grey box; anything longer wraps into a wall nobody reads.
- **Line 1 is always there.** An element with a state shows it after an em dash
  (`Grid — 231.4 V · NOMINAL`); one without a state (a range button) is just its
  name (`24 h`).
- **Line 2 says what it means**, not where it comes from. "Mains voltage at the
  inverter input", not "sensor.powmr_inverter_grid_voltage".
- **Line 3 starts with `E.g.`** and is concrete: a number, a time, or a state
  change you would actually see. "E.g. at 23:00 it switches to the grid", never
  "E.g. it shows the voltage".
- **Line 4 is optional**: a limit ("Cannot be on together with Auto.") or a tap
  hint when a tap does something non-obvious ("Tap: toggles. Hold: settings.").
  Opening the entity's own dialog is obvious and not worth a line.

## Where the text lives

- **One `HELP` map per card**, keyed by a stable key, holds lines 2–4. It is
  static text; keep it in step with the doc it summarises.
- **Line 1 is built when the card patches**, from the live state.
- **The text goes in a `data-tip` attribute, never a native `title`.** A
  browser closes a native tooltip the moment its text changes, and line 1 holds
  a live state that changes every few seconds, so a `title` tooltip vanishes
  before it can be read. `data-tip` is assigned with `=`, never appended to, so
  a re-patch cannot stack descriptions.
- **One component draws every box**: `config/www/card-tip.js`. Each card
  imports it (`import { cardTip } from "./card-tip.js?v=<its VERSION>"`) and
  calls `cardTip(this, this.shadowRoot)` once. The box lives in
  `document.body`, so no card can clip it, and re-reads the element under the
  pointer whenever the card's DOM changes: it stays open and its line 1 updates
  in place, even over a card that redraws itself whole. It turns the four lines
  into the design in [MANIFEST.md §8](../../MANIFEST.md#tooltip-design): line 1
  becomes the header (name, mono value, and a state pill when the value ends in
  a status word it knows), the `E.g.` line gets its chip, and line 4 gets a hand
  icon when it starts with Tap, Hold, Drag or Press, an info icon otherwise.
  Touch screens get no tooltip; a touch has no hover.
- **The element must take the pointer**: `pointer-events: none` hides its tooltip.

## What gets one

**Everything meaningful**: chips, switches, buttons, selects, sliders, inputs,
tiles, badges, meters, status words, legend items, grid cells, room markers, and
anything that opens a dialog on tap.

- **One tooltip per meaning.** A child that means the same as its parent (a
  chip's icon and label) has no tooltip of its own and inherits the parent's. A
  child that means something else (a sub-label that opens a different entity)
  gets its own.
- **Repeated items share one description.** The 168 hours of the DTEK grid, the
  eight battery cells and the stat columns differ only in line 1.

**Exempt:**

- decoration: dividers, backgrounds, glows, airflow animation;
- section labels (`.plabel`, `h2`) and prose that already explains itself
  (`.lede`, `.blurb`, `.foot`, `.hint`);
- axis tick labels;
- chart plot areas: their own hover bubble is the tooltip, and a second box
  would fight it. The chart's gesture help goes on its name or window label.
- built-in Home Assistant cards (`heading`, `markdown`, `history-graph`): they
  cannot carry tooltips (markdown's sanitiser strips `title`). Their meaning goes
  into the heading text; anything that needs tooltips is a custom card.

## Style

- English; a space before a unit (`230 V`, `60 %`); an en dash for ranges
  (`23:00–07:00`, `185–250 V`); 24-hour time.
- The em dash `—` separates a name from its state on line 1 only.
- Use this house's numbers: the 23:00–07:00 night tariff, the 185–250 V grid
  window, the 8S 280 Ah pack.

## Examples

| Element | Good | Bad |
| --- | --- | --- |
| Switch chip | `Night charging only — on`<br>`Charges from the grid only on the night tariff, 23:00–07:00.`<br>`E.g. on: charging stops at 07:00 and starts again at 23:00.`<br>`Cannot be on together with Auto.` | `Toggle Night only` |
| Value tile | `Grid — 231.4 V · NOMINAL`<br>`Mains voltage at the inverter input; the bar runs 200–250 V.`<br>`E.g. below 185 V for 5 s, Protect moves the house to the battery.` | `Grid voltage` |
| Button | `24 h`<br>`Shows the last 24 hours on the chart.`<br>`E.g. the night charge appears as the 23:00–07:00 climb.` | *(none)* |
| Grid cell | `Mo 19:00 — scheduled outage`<br>`One hour of DTEK's weekly schedule for our queue.`<br>`E.g. red from 19:00 to 22:00: expect no grid for those three hours.` | `Mo 19:00 — scheduled outage` |
| Status word | `Feed — Healthy`<br>`Whether the DTEK poller still gets fresh, well-formed data.`<br>`E.g. Stale: the last poll failed, so the card shows the last good answer.` | `Healthy` |

## The check

`tools/test_card_tooltips.js` renders every custom card against a fake `hass`
and a small DOM, collects every element in scope, and fails when one has no
tooltip (its own or an ancestor's), has fewer than three or more than four lines,
has a line over 90 characters, or has no line starting `E.g.`. It also fails on
any native `title`, on a card that does not import `card-tip.js` at its current
version, and when a
tooltip open over a tile closes or keeps stale text across a sensor update. It
runs in CI with the other card tests.
