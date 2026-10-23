/**
 * The DTEK card against the applied schedule (today / tomorrow), on a pinned
 * clock. Added after the first real stabilisation outage, 17.10.2026
 * 13:30-17:00, when the hero said "The power is on" with the window running
 * and the card never drew the day DTEK had applied.
 *
 *     node HomeAssistant/tools/test_dtek_card.js
 *
 * Exit status is 0 when everything passes, 1 otherwise.
 */

"use strict";

const { loadCard, mkHass, S } = require("./fake_dom");

const FILE = "dtek-shutdowns-card.js";
const GRID = "binary_sensor.powmr_inverter_grid_condition_safe";
const TODAY = "yyyyyyyyyyyyysnnnyyyyyyy"; // 17.10.2026: 13:30-17:00 off
let failed = 0;
let passed = 0;

function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) passed++;
  else {
    failed++;
    console.log("  FAIL " + label + ": " + JSON.stringify(got) + "  want " + JSON.stringify(want));
  }
}

/** A Date whose "now" is pinned to a local wall-clock time on 17.10.2026. */
function pinnedDate(hh, mm) {
  const fixed = new Date(2026, 9, 17, hh, mm).getTime();
  return class extends Date {
    constructor(...args) { if (args.length) super(...args); else super(fixed); }
    static now() { return fixed; }
  };
}

function render(at, attrs, opts) {
  opts = opts || {};
  const [hh, mm] = at.split(":").map(Number);
  const L = loadCard(FILE, { Date: pinnedDate(hh, mm) });
  const card = new L.Card();
  card.setConfig({ blocks: opts.blocks || ["hero", "days"] });
  card.hass = mkHass({
    "sensor.dtek_shutdowns": S("ok", Object.assign({
      queue: "1.1", outage_active: false, schedule_in_effect: true,
      schedule_update: "17.10.2026 10:41", today: TODAY, tomorrow: null,
      week: null, week_in_effect: false, hidden_reason: "plan_off",
      fetched_at: new Date(2026, 9, 17, hh, mm).toISOString(),
    }, attrs || {})),
    [GRID]: S(opts.gridDown ? "on" : "off"),
    "binary_sensor.grid_outage_unscheduled": S("off"),
    "binary_sensor.dtek_data_stale": S("off"),
  });
  const root = card.shadowRoot;
  const text = (sel) => {
    const el = root.querySelector(sel);
    return el ? el.textContent : null;
  };
  const tile = (k) => {
    const t = root.querySelectorAll(".tile").find((x) => x.querySelector(".k").textContent === k);
    return t ? [t.querySelector(".v").textContent, t.querySelector(".s").textContent] : null;
  };
  return { root, text, tile, wrap: root.querySelector(".wrap") };
}

console.log("hero inside a scheduled window, mains present");
let r = render("13:39");
eq("headline", r.text("h1"), "Scheduled outage until 17:00.");
eq("lede", r.text(".lede"), "DTEK's schedule for (1.1) has 13:30–17:00 off. The inverter still sees mains.");
eq("orange, not green", /--accent:var\(--warning-color/.test(r.wrap.getAttribute("style")), true);
eq("next window tile is the running one", r.tile("Next window"), ["13:30–17:00", "now, ends in 3h 21m"]);

console.log("hero inside the window, mains gone");
r = render("13:45", {}, { gridDown: true });
eq("headline", r.text("h1"), "The power is off.");
eq("lede names the end", r.text(".lede"),
  "The inverter sees no mains, as DTEK's schedule for (1.1) has it: off 13:30–17:00, back by 17:00 (in 3h 15m).");

console.log("the first half of 13:00 is lit");
r = render("13:10", { next_outage_start: new Date(2026, 9, 17, 13, 30).toISOString(),
                      next_outage_end: new Date(2026, 9, 17, 17, 0).toISOString() });
eq("headline", r.text("h1"), "The power is on.");
eq("next window", r.tile("Next window")[0], "13:30–17:00");

console.log("after the window");
r = render("17:00");
eq("headline", r.text("h1"), "The power is on.");

console.log("a window across midnight");
r = render("23:40", { today: "yyyyyyyyyyyyyyyyyyyyyynnn".slice(0, 24), tomorrow: "nnyyyyyyyyyyyyyyyyyyyyyy" });
eq("headline carries +1", r.text("h1"), "Scheduled outage until 02:00+1.");
r = render("23:40", { today: "yyyyyyyyyyyyyyyyyyyyyynn", tomorrow: null }, { gridDown: true });
eq("tomorrow unpublished: no false end time", r.text(".lede"),
  "The inverter sees no mains, as DTEK's schedule for (1.1) has it: off 22:00–00:00+1, back by midnight unless tomorrow's table extends it.");

console.log("possible outage hours");
r = render("10:15", { today: "yyyyyyyyyymmyyyyyyyyyyyy" });
eq("hedged wording", r.text(".lede"), "DTEK's schedule for (1.1) has 10:00–12:00 as a possible outage. The inverter still sees mains.");

console.log("the days block");
r = render("13:39");
const cols = r.root.querySelectorAll(".days .day");
eq("two columns", cols.map((c) => c.querySelector(".dname").textContent), ["Today", "Tomorrow"]);
eq("dates under them", cols.map((c) => c.querySelector(".dsub").textContent), ["17.10", "18.10"]);
eq("24 cells each", cols.map((c) => c.querySelectorAll(".c").length), [24, 24]);
eq("today's total", cols[0].querySelector(".dtot").textContent, "3.5h");
eq("tomorrow unpublished", cols[1].querySelector(".dtot").textContent, "—");
const cls = (i) => cols[0].querySelectorAll(".c")[i].getAttribute("class");
eq("13:00 is the split, and now", cls(13), "c out-2 now");
eq("14:00 is out", cls(14), "c out");
eq("12:00 is on", cls(12), "c on");
eq("tomorrow is hatched", cols[1].querySelectorAll(".c")[0].getAttribute("class"), "c unknown");
r = render("13:39", { schedule_in_effect: false, today: null });
eq("no schedule in force: one sentence", r.text(".days .note"),
  "No stabilisation schedule is in force, so DTEK has applied nothing to today or tomorrow.");
eq("... and a green hero", r.text("h1"), "The power is on.");

console.log("debug_state on overrides the schedule");
{
  const L = loadCard(FILE, { Date: pinnedDate(13, 39) });
  const card = new L.Card();
  card.setConfig({ blocks: ["hero"], debug_state: "on" });
  card.hass = mkHass({
    "sensor.dtek_shutdowns": S("ok", { queue: "1.1", schedule_in_effect: true, today: TODAY }),
    [GRID]: S("off"),
  });
  eq("headline", card.shadowRoot.querySelector("h1").textContent, "The power is on.");
}

console.log(failed ? "test_dtek_card: " + failed + " FAILED, " + passed + " passed"
  : "test_dtek_card: ok — " + passed + " checks passed");
process.exit(failed ? 1 : 0);
