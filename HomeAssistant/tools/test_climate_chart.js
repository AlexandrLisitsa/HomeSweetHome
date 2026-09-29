/**
 * Fixture tests for the chart maths in config/www/climate-console-card.js.
 *
 *     node HomeAssistant/tools/test_climate_chart.js
 *
 * WHY THESE AND NOT A RENDERING TEST
 *
 * Everything the chart gets wrong, it gets wrong quietly. A y axis that
 * divides its span into uneven gaps still draws five tidy lines; a zoom that
 * loses its anchor still zooms; a decimator that drops an extreme still
 * produces a plausible curve; a mean weighted by sample count still prints a
 * number in the right range. None of it throws, and none of it looks wrong in
 * a screenshot unless you already know the answer.
 *
 * So these assert the answers. The card is loaded as-is -- no build step, no
 * copy of the logic to drift out of sync -- against a small DOM stub, and the
 * pure methods are called on the real prototype.
 *
 * Exit status is 0 when every case passes, 1 otherwise.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const CARD = path.join(__dirname, "..", "config", "www", "climate-console-card.js");

/* --- just enough DOM for the module to evaluate --------------------------- */

function loadCard() {
  let Klass = null;
  const sandbox = {
    HTMLElement: class {},
    CustomEvent: class {},
    customElements: { get: () => undefined, define: (_n, k) => { Klass = k; } },
    window: { customCards: [], setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {} },
    // installFonts() bails out when there is no head, which is what we want:
    // the test is about arithmetic, not about @font-face.
    document: { head: null, getElementById: () => null, createElement: () => ({}) },
    console: { info: () => {} },
    Math: Math, Date: Date, Number: Number, JSON: JSON,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(CARD, "utf8"), sandbox, { filename: CARD });
  if (!Klass) throw new Error("the card did not define a custom element");
  // The sandbox comes back too: the card reaches for ITS `window`, not the
  // test process's, so anything that stubs a timer has to reach in here.
  return { Card: Klass, sandbox: sandbox };
}

const { Card, sandbox } = loadCard();

/** A bare object wearing the card's prototype: the pure methods need no DOM. */
function bare(state) {
  return Object.assign(Object.create(Card.prototype), {
    _view: null, _dom: null, _hist: new Map(), _inflight: new Map(),
    _range: "24h", _built: false, _hv: {}, _el: null, _hass: null, _config: null,
  }, state || {});
}

/* --- runner --------------------------------------------------------------- */

let pass = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(name + (detail ? " -- " + detail : ""));
}

function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  check(name, g === w, "got " + g + ", wanted " + w);
}

function near(name, got, want, tol) {
  check(name, Math.abs(got - want) <= tol,
    "got " + got + ", wanted " + want + " +/-" + tol);
}

const MIN = 60000, HOUR = 3600000, DAY = 24 * HOUR;

/* --- 1. the y domain, which has to divide evenly --------------------------- */
//
// The bug this pins: a 2.5 step printed at zero decimals gave "28 25 23 20 18"
// for five evenly spaced grid lines. Every axis must have one step throughout,
// and must cover every point handed to it.
{
  const c = bare();
  const series = (vals) => [vals.map((v, i) => [i * MIN, v])];
  const cases = [
    ["flat room", [24.6, 24.6, 24.7], 0.4, 3],
    ["hall live", [19.8, 25.4, 22.0], 0.8, 3],
    ["kitchen spike", [23.0, 24.1, 31.2], 0.4, 3],
    ["humidity", [46, 50, 53], 2, 8],
    ["humidity spike", [40, 62, 78], 2, 8],
    ["negative", [-8.2, -1.0, 3.4], 0.4, 3],
    ["single point", [24.07], 0.4, 3],
  ];
  for (const [name, vals, pad, minSpan] of cases) {
    const d = c._domain(series(vals), pad, minSpan);
    const step = (d.hi - d.lo) / 4;
    const labels = [0, 1, 2, 3, 4].map((i) => d.hi - step * i);
    // Uniform by construction, but assert it: this is the invariant that broke.
    const gaps = labels.slice(1).map((v, i) => +(labels[i] - v).toFixed(9));
    check("domain/" + name + ": one step throughout",
      gaps.every((g) => Math.abs(g - gaps[0]) < 1e-9), JSON.stringify(gaps));
    check("domain/" + name + ": covers the data",
      d.lo <= Math.min.apply(null, vals) && d.hi >= Math.max.apply(null, vals),
      JSON.stringify(d) + " vs " + JSON.stringify(vals));
    check("domain/" + name + ": honours minSpan", d.hi - d.lo >= minSpan - 1e-9,
      JSON.stringify(d));
    // Every label must print back exactly at the precision the card picks.
    let dec = 0;
    while (dec < 2 && Math.abs(step * Math.pow(10, dec) % 1) > 1e-9) dec++;
    check("domain/" + name + ": labels are exact at " + dec + "dp",
      labels.every((v) => Math.abs(Number(v.toFixed(dec)) - v) < 1e-9),
      JSON.stringify(labels.map((v) => v.toFixed(dec))));
  }
  check("domain: empty series has no domain", c._domain([], 0.4, 3) === null);
}

/* --- 2. the slice, which feeds the axis, the stats and the hover ----------- */
//
// One sample beyond each edge, or the line stops short of the frame and the
// window looks like it has gaps at both ends.
{
  const c = bare();
  const pts = [0, 10, 20, 30, 40, 50].map((m) => [m * MIN, m]);
  eq("slice: interior keeps one either side",
    c._slice(pts, 20 * MIN, 30 * MIN).map((q) => q[1]), [10, 20, 30, 40]);
  eq("slice: whole window is everything",
    c._slice(pts, -HOUR, HOUR).map((q) => q[1]), [0, 10, 20, 30, 40, 50]);
  eq("slice: past the right edge keeps the last sample",
    c._slice(pts, 60 * MIN, 70 * MIN).map((q) => q[1]), [50]);
  eq("slice: before the left edge keeps the first",
    c._slice(pts, -20 * MIN, -10 * MIN).map((q) => q[1]), [0]);
  eq("slice: empty input", c._slice([], 0, HOUR), []);
}

/* --- 3. the mean, weighted by time and not by row count ------------------- */
//
// A sensor that fires ten times in a draughty minute and once in a still hour
// must not let the minute outvote the hour.
{
  const c = bare();
  const burst = [];
  for (let i = 0; i < 10; i++) burst.push([i * 1000, 30]);
  burst.push([10 * 1000, 20]);
  burst.push([10 * 1000 + HOUR, 20]);
  const m = c._mean(burst);
  check("mean: an hour at 20 outweighs ten seconds at 30", m < 20.1,
    "got " + m + " (a row-count mean would be ~29)");
  near("mean: two equal halves", c._mean([[0, 10], [HOUR, 20], [2 * HOUR, 20]]), 15, 1e-9);
  eq("mean: one point is itself", c._mean([[0, 24.5]]), 24.5);
  eq("mean: nothing has no mean", c._mean([]), null);
}

/* --- 4. decimation must never lose an extreme ----------------------------- */
//
// The kitchen hitting 31 for one minute inside a 30 d window is the single
// most interesting row in it, and an even stride is exactly what drops it.
{
  const c = bare();
  const pts = [];
  for (let i = 0; i < 5000; i++) pts.push([i * MIN, 24 + Math.sin(i / 50) * 0.3]);
  pts[3777] = [3777 * MIN, 31.2];
  pts[1234] = [1234 * MIN, 18.1];
  const out = c._decimate(pts, 600);
  check("decimate: respects the budget", out.length <= 620, "got " + out.length);
  const vals = out.map((q) => q[1]);
  check("decimate: keeps the maximum", vals.indexOf(31.2) >= 0);
  check("decimate: keeps the minimum", vals.indexOf(18.1) >= 0);
  eq("decimate: keeps the first sample", out[0], pts[0]);
  eq("decimate: keeps the last sample", out[out.length - 1], pts[pts.length - 1]);
  let sorted = true;
  for (let i = 1; i < out.length; i++) if (out[i][0] < out[i - 1][0]) sorted = false;
  check("decimate: still runs forwards in time", sorted);
  eq("decimate: under budget is untouched", c._decimate(pts.slice(0, 100), 600).length, 100);
}

/* --- 5. the viewport: clamping, following, and the zoom anchor ------------- */
{
  const now = Date.now();
  const c = bare();

  c._setView(now - 2 * HOUR, now);
  check("setView: a window ending at now follows", c._view.follow === true);

  c._setView(now - 3 * DAY, now - 2 * DAY);
  check("setView: a window in the past does not follow", c._view.follow === false);

  c._setView(now - HOUR, now + 5 * DAY);
  check("setView: the right edge cannot pass now", c._view.end <= now + 1, c._view.end - now);

  c._setView(now - 1000, now);
  near("setView: a span below the floor is widened", c._view.end - c._view.start, MIN, 1);

  c._setView(now - 400 * DAY, now);
  near("setView: a span above the ceiling is narrowed",
    c._view.end - c._view.start, 30 * DAY, 1000);

  // The anchor is the whole point of a wheel zoom: the instant under the
  // cursor has to stay under the cursor, or the chart swims away from it.
  // The base sits far enough in the past that zooming out 2.5x cannot reach
  // now -- the clamp there is tested separately below, because it is allowed
  // to move the anchor and nothing else is.
  for (const factor of [0.4, 0.8, 1.6, 3.0]) {
    const v = bare();
    v._syncSegs = () => {};
    v._drawCharts = () => {};
    v._refreshCharts = () => {};
    const base = { t0: now - 20 * HOUR, t1: now - 16 * HOUR };
    const anchor = base.t0 + (base.t1 - base.t0) * 0.25;
    v._zoomFrom(base, anchor, factor);
    const frac = (anchor - v._view.start) / (v._view.end - v._view.start);
    near("zoom x" + factor + ": the anchor stays under the cursor", frac, 0.25, 0.001);
    near("zoom x" + factor + ": the span scales",
      v._view.end - v._view.start, (base.t1 - base.t0) / factor, 2);
  }

  // Zooming out at the live edge is the one case that may move the anchor:
  // the window would have to show the future to keep it, and it will not.
  {
    const v = bare();
    v._syncSegs = () => {};
    v._drawCharts = () => {};
    v._refreshCharts = () => {};
    const base = { t0: now - 4 * HOUR, t1: now };
    v._zoomFrom(base, now - HOUR, 0.4);
    check("zoom out at the live edge: never shows the future", v._view.end <= now + 1,
      v._view.end - now);
    check("zoom out at the live edge: stays following", v._view.follow === true);
    near("zoom out at the live edge: the span still scales",
      v._view.end - v._view.start, 10 * HOUR, 2);
  }
}

/* --- 6. which preset serves a zoomed window ------------------------------- */
//
// The smallest one that covers it, so zooming in sharpens the line instead of
// magnifying the same sparse points.
{
  const c = bare();
  eq("presetFor: ten minutes", c._presetFor(10 * MIN), "3h");
  eq("presetFor: exactly 3h", c._presetFor(3 * HOUR), "3h");
  eq("presetFor: 4h", c._presetFor(4 * HOUR), "24h");
  eq("presetFor: 3 days", c._presetFor(3 * DAY), "7d");
  eq("presetFor: 10 days", c._presetFor(10 * DAY), "30d");
  eq("presetFor: beyond the longest", c._presetFor(400 * DAY), "30d");
}

/* --- 7. what the x axis covers, in the three viewport states -------------- */
{
  const now = Date.now();
  const rec = { start: now - DAY, end: now };

  const live = bare();
  eq("domainX: no view is the fetched window", live._domainX(rec), { t0: rec.start, t1: rec.end });

  const follow = bare({ _view: { start: now - 3 * HOUR, end: now - HOUR, follow: true } });
  const d = follow._domainX(rec);
  eq("domainX: a following view keeps its span", d.t1 - d.t0, 2 * HOUR);
  eq("domainX: a following view takes its right edge from the data", d.t1, rec.end);

  const pinned = bare({ _view: { start: now - 9 * HOUR, end: now - 8 * HOUR, follow: false } });
  eq("domainX: a pinned view is itself",
    pinned._domainX(rec), { t0: now - 9 * HOUR, t1: now - 8 * HOUR });

  check("stale: a pinned window is never stale",
    pinned._stale() === false);
}

/* --- 8. the hover has to hit-test against what was drawn ------------------ */
//
// _project must agree with _pathOf exactly, or the dot sits off the line.
{
  const c = bare();
  const dom = { lo: 22, hi: 26 };
  const t0 = 0, t1 = 100 * MIN;
  const pts = [[0, 24], [50 * MIN, 25.5], [100 * MIN, 22.5]];
  const xy = c._project(pts, dom, 1000, 250, t0, t1);
  const d = c._pathOf(pts, dom, 1000, 250, t0, t1);
  const fromPath = d.replace(/[ML]/g, "").trim().split(/\s+/).map(Number);
  const flat = [];
  xy.forEach((q) => flat.push(+q[0].toFixed(1), +q[1].toFixed(1)));
  eq("project: agrees with the drawn path", flat, fromPath);
  eq("project: clamps x into the frame",
    c._project([[-5 * HOUR, 24]], dom, 1000, 250, t0, t1)[0][0], 0);
  eq("project: nothing to project", c._project([], dom, 1000, 250, t0, t1), []);
}

/* --- 9. parsing the recorder's two reply shapes --------------------------- */
{
  const c = bare();
  const reply = {
    "sensor.a": [{ s: "24.1", lu: 1000 }, { s: "unavailable", lu: 2000 }, { s: "24.3", lu: 3000 }],
    "sensor.b": [{ state: "50", last_updated: "2026-09-16T00:00:00+00:00" }],
  };
  eq("parse: skips non-numeric states",
    c._parse(reply, "sensor.a").map((q) => q[1]), [24.1, 24.3]);
  eq("parse: seconds become milliseconds", c._parse(reply, "sensor.a")[0][0], 1000000);
  eq("parse: the older ISO shape still reads",
    c._parse(reply, "sensor.b").map((q) => q[1]), [50]);
  // The guard that stops a silent sensor borrowing its neighbour's history.
  eq("parse: a missing entity in a batched reply is empty, not borrowed",
    c._parse(reply, "sensor.missing"), []);
  eq("parse: a single-key reply still falls back",
    c._parse({ "sensor.only": [{ s: "7", lu: 5 }] }, "sensor.other").map((q) => q[1]), [7]);

  // The target line: the value is an attribute, and `off` means no target.
  const climate = {
    "climate.x": [
      { s: "cool", lu: 1000, a: { temperature: 24 } },
      { s: "cool", lu: 2000 },
      { s: "off", lu: 3000, a: { temperature: 24 } },
      { s: "cool", lu: 4000, a: { temperature: 21 } },
    ],
  };
  eq("parse: an attribute carries forward across rows that omit it",
    c._parse(climate, "climate.x", "temperature").map((q) => q[1]), [24, 24, 21]);
  eq("parse: an off unit is aiming at nothing",
    c._parse(climate, "climate.x", "temperature").map((q) => q[0]), [1000000, 2000000, 4000000]);
}

/* --- 10. the live tail -------------------------------------------------- */
//
// _ingest appends the sample `set hass` just handed us, so the line moves
// between recorder polls instead of sitting frozen under tiles that do not.
{
  const now = Date.now();
  const c = bare({
    _built: true,
    _config: { tab: "rooms", living_temp: "sensor.lt", living_hum: "sensor.lh",
      bedroom_temp: "sensor.bt", bedroom_hum: "sensor.bh",
      kitchen_temp: "sensor.kt", kitchen_hum: "sensor.kh" },
    _hass: { states: {
      "sensor.lt": { state: "25.0", last_updated: new Date(now).toISOString() },
    } },
  });
  let drawn = 0;
  c._drawCharts = () => { drawn++; };
  c._hist.set("t-living|24h", {
    at: now - 5 * MIN, start: now - DAY, end: now - 5 * MIN,
    pts: [[now - DAY, 24.0], [now - 5 * MIN, 24.4]], note: null,
  });
  c._ingest();
  const rec = c._hist.get("t-living|24h");
  eq("ingest: the live sample is on the end", rec.pts[rec.pts.length - 1][1], 25);
  check("ingest: the right edge moved to now", rec.end >= now - 1);
  check("ingest: it redrew", drawn === 1);

  // A second pass with the same state must not append it twice: an unchanged
  // state fires a state report, which the recorder does not store.
  c._ingest();
  eq("ingest: an unchanged state is not a second row", c._hist.get("t-living|24h").pts.length, 3);

  // A pinned window is over and must not grow a tail.
  c._hist.set("t-living|@100-200", {
    at: now, start: 100000, end: 200000, pts: [[100000, 24]], note: null,
  });
  c._ingest();
  eq("ingest: pinned windows are left alone",
    c._hist.get("t-living|@100-200").pts.length, 1);

  // An empty window stays empty: "no history recorded" is a true statement,
  // and one live point stretched over 24h would be a worse answer.
  c._hist.set("t-bedroom|24h", { at: now, start: now - DAY, end: now, pts: [], note: "no history recorded" });
  c._ingest();
  eq("ingest: an empty window is not seeded", c._hist.get("t-bedroom|24h").pts.length, 0);
}

/* --- 11. window labels and pin keys -------------------------------------- */
{
  const now = Date.now();
  eq("winLabel: live has no label", bare()._winLabel({ t0: 0, t1: DAY }), "");
  eq("winLabel: a following window is 'last <span>'",
    bare({ _view: { follow: true } })._winLabel({ t0: now - 150 * MIN, t1: now }),
    "last 2.5 hours");
  eq("spanWords: minutes", bare()._spanWords(8 * MIN), "8 minutes");
  eq("spanWords: one minute is singular", bare()._spanWords(MIN), "1 minute");
  eq("spanWords: days", bare()._spanWords(3 * DAY), "3 days");
  const pinned = bare({ _view: { start: 0, end: DAY, follow: false } })
    ._winLabel({ t0: now - 9 * HOUR, t1: now - 8 * HOUR });
  check("winLabel: a pinned window states both edges", / – /.test(pinned), pinned);
  eq("pinKey: rounds to whole seconds",
    bare()._pinKey("t-living", 1700000000123, 1700003600456), "t-living|@1700000000-1700003600");
}

/* --- 12. dew point, because it is the one derived number on a room card --- */
{
  const c = bare();
  // Textbook pairs, to within the Magnus approximation's own error.
  near("dew: 25C / 50%", c._dew(25, 50), 13.9, 0.2);
  near("dew: 20C / 100% is the temperature", c._dew(20, 100), 20, 0.1);
  near("dew: 30C / 30%", c._dew(30, 30), 10.5, 0.3);
  eq("dew: no reading, no dew point", c._dew(null, 50), null);
  eq("dew: nonsense humidity is not a dew point", c._dew(24, 0), null);
}

/* --- 13. the dial, which is now draggable -------------------------------- */
//
// _fracAt is the inverse of _polar, and the two have to agree exactly or the
// knob lands somewhere other than under the finger that dropped it. The dead
// zone at the bottom is the part worth pinning: 90 degrees of ring that mean
// nothing, which a drag WILL cross.
{
  const c = bare();
  const R = 100;
  // A 200x200 box centred on the origin of the dial's own coordinates.
  const rect = { left: 0, top: 0, width: 200, height: 200 };

  for (const f of [0, 0.25, 0.5, 0.75, 1]) {
    const [x, y] = c._polar(100, 100, R, f);
    near("dial: frac " + f + " round-trips through the geometry",
      c._fracAt(x, y, rect), f, 1e-6);
  }

  // Straight down is the middle of the 90-degree gap. Either end is defensible;
  // what is not is a jump to the far end from one pixel across the centre line.
  const below = c._fracAt(100, 190, rect);
  check("dial: the dead zone resolves to an end", below === 0 || below === 1, String(below));
  // Just past the top of the sweep (clockwise of 'max') must stay at max.
  const pastMax = c._polar(100, 100, R, 1);
  near("dial: a hair past max stays at max",
    c._fracAt(pastMax[0] + 6, pastMax[1] + 6, rect), 1, 1e-9);
  // Just before the start of the sweep must stay at min.
  const beforeMin = c._polar(100, 100, R, 0);
  near("dial: a hair before min stays at min",
    c._fracAt(beforeMin[0] + 6, beforeMin[1] - 6, rect), 0, 1e-9);

  // Distance from the centre must not matter: HA's dial lets you drag with a
  // finger well outside the ring, and so does this one.
  const mid = c._polar(100, 100, 40, 0.6);
  near("dial: the radius is irrelevant", c._fracAt(mid[0], mid[1], rect), 0.6, 1e-6);

  // The snap has to land on the unit's own grid, not on multiples of the step:
  // a range starting at 16 with a 0.5 step has no setpoint at 16.25, and a
  // range starting at 18 with a step of 1 has none at 18.5.
  const snap = (lo, hi, step, frac) => {
    const raw = lo + (hi - lo) * frac;
    const steps = Math.round((raw - lo) / step);
    return Math.round(Math.max(lo, Math.min(hi, lo + steps * step)) * 100) / 100;
  };
  eq("dial: hall snaps to whole degrees", snap(18, 30, 1, 0.31), 22);
  eq("dial: bedroom snaps to halves", snap(16, 30, 0.5, 0.33), 20.5);
  eq("dial: the bottom end is reachable", snap(16, 30, 0.5, 0), 16);
  eq("dial: the top end is reachable", snap(16, 30, 0.5, 1), 30);
  check("dial: every snap is on the grid",
    [0, 0.13, 0.4, 0.66, 0.91, 1].every((f) => {
      const v = snap(16, 30, 0.5, f);
      return Math.abs((v - 16) / 0.5 - Math.round((v - 16) / 0.5)) < 1e-9;
    }));
}

/* --- 14. what is drawn between asking and being answered ------------------ */
//
// The bug this pins: two taps on + sent 25.5 then 26, the 25.5 came back
// first, the card read its OWN earlier request as the unit disagreeing, and
// the dial settled on 25.5 for a setpoint the user had taken to 26.
{
  const ENT = "climate.x";
  const fresh = () => bare({ _sent: {}, _missed: {}, _resend: {} });

  {
    const c = fresh();
    eq("settle: nothing pending is the entity's own reading", c._settle(ENT, 24), 24);
  }

  {
    // One press: hold what was asked for until the entity says it.
    const c = fresh();
    c._send(ENT, 25.5, 25);
    eq("settle: holds a lone request", c._settle(ENT, 25), 25.5);
    eq("settle: yields when echoed", c._settle(ENT, 25.5), 25.5);
    eq("settle: and forgets it", Object.keys(c._sent).length, 0);
  }

  {
    // The burst. Every intermediate value is one of ours coming home.
    const c = fresh();
    c._send(ENT, 25.5, 25);
    c._send(ENT, 26, 25.5);
    eq("settle: burst holds the last request", c._settle(ENT, 25), 26);
    eq("settle: an earlier request coming back is not an answer",
      c._settle(ENT, 25.5), 26);
    eq("settle: still pending after that", Object.keys(c._sent).length, 1);
    eq("settle: the last one lands", c._settle(ENT, 26), 26);
    eq("settle: and forgets it", Object.keys(c._sent).length, 0);
  }

  {
    // Three taps, answered out of order, which is what a slow unit does.
    const c = fresh();
    c._send(ENT, 24, 23.5);
    c._send(ENT, 24.5, 24);
    c._send(ENT, 25, 24.5);
    eq("settle: long burst holds the last", c._settle(ENT, 24), 25);
    eq("settle: and through the second echo", c._settle(ENT, 24.5), 25);
    eq("settle: until the last arrives", c._settle(ENT, 25), 25);
  }

  {
    // A number we never sent IS the unit speaking -- a clamp, a step of its
    // own, or the physical remote -- and it wins at once.
    const c = fresh();
    c._send(ENT, 35, 24);
    eq("settle: a clamp wins immediately", c._settle(ENT, 30), 30);
    eq("settle: and clears the request", Object.keys(c._sent).length, 0);
  }

  {
    // Nothing to read yet: an unavailable entity must not drop the request.
    const c = fresh();
    c._send(ENT, 22, 24);
    eq("settle: holds while the entity is dark", c._settle(ENT, null), 22);
  }

  {
    // And a request nothing ever answers expires rather than sticking.
    const c = fresh();
    c._send(ENT, 22, 24);
    c._sent[ENT].at -= 16000;
    eq("settle: an unanswered request expires", c._settle(ENT, 24), 24);
    eq("settle: and is forgotten", Object.keys(c._sent).length, 0);
  }

  {
    // The trim slider shares the mechanism, on its own entity and scale.
    const c = fresh();
    c._send("number.fan", 80, 28);
    eq("settle: the trim holds too", c._settle("number.fan", 28), 80);
    eq("settle: the trim yields to the unit's own number",
      c._settle("number.fan", 62), 62);
  }
}

/* --- 15. where a press on the dial counts ---------------------------------- */
//
// The bug this pins: _onDialDown set the value from wherever the press
// landed, and the press target was the whole square. With 25 on a hall dial,
// pressing the number in the middle set 28, just above it 24, just below it
// 18, and the empty corner 22. The middle of this dial is a readout.
{
  const c = bare();
  // A 290px element carrying the card's 220-unit box, centred at (145,145).
  const rect = { left: 0, top: 0, width: 290, height: 290 };
  const unit = 290 / 220;
  // Where the knob sits for the hall's 25 on an 18..30 dial.
  const at = (25 - 18) / (30 - 18);
  const px = (ux, uy) => [145 + ux * unit, 145 + uy * unit];
  const hit = (ux, uy) => { const [x, y] = px(ux, uy); return c._dialHit(x, y, rect, at); };
  // A point `r` units out along the sweep at `frac`.
  const along = (frac, r) => {
    const a = (135 + 270 * frac) * Math.PI / 180;
    return [r * Math.cos(a), r * Math.sin(a)];
  };

  eq("dialhit: the readout in the middle is not the control", hit(0, 0), null);
  eq("dialhit: just above the number is not either", hit(0, -20), null);
  eq("dialhit: just below the number is not either", hit(0, 20), null);
  eq("dialhit: nor beside it", hit(-30, 0), null);
  eq("dialhit: nor the corner of the box", hit(-99, -99), null);

  {
    const [x, y] = along(at, 88);
    eq("dialhit: the knob itself is a grab", hit(x, y), "knob");
  }
  {
    // A finger a few degrees off the knob is still a grab, not a step.
    const [x, y] = along(at + 0.03, 88);
    eq("dialhit: a near miss is still a grab", hit(x, y), "knob");
  }
  {
    // The far side of the ring is a deliberate move.
    const [x, y] = along(0.1, 88);
    eq("dialhit: the ring away from the knob sets a value", hit(x, y), "ring");
  }
  {
    // Touch tolerance: inside and outside the 12-unit stroke still count.
    const [xi, yi] = along(0.1, 72);
    const [xo, yo] = along(0.1, 104);
    eq("dialhit: a little inside the ring counts", hit(xi, yi), "ring");
    eq("dialhit: a little outside the ring counts", hit(xo, yo), "ring");
  }
  {
    // The 90-degree gap at the bottom is not a place to start from, or a tap
    // under the number leaps to an end of the range.
    eq("dialhit: the gap below the dial starts nothing", hit(0, 88), null);
    eq("dialhit: and neither side of it does", hit(-40, 78), null);
  }
  check("dialhit: a rect with no size cannot be hit",
    c._dialHit(10, 10, { left: 0, top: 0, width: 0, height: 0 }, at) === null);
  {
    // An unknown setpoint has no knob to grab, but the ring still works.
    const [x, y] = along(0.4, 88);
    eq("dialhit: no setpoint, the ring still answers",
      c._dialHit.apply(c, px(x, y).concat([rect, NaN])), "ring");
  }
}

/* --- 16. the value is sticky, so a hand on a boundary cannot flick it ----- */
//
// The bug this pins: rounding alone puts a step boundary every 22.5 degrees
// on the hall dial, and a hand resting on one flicks the value between its
// two neighbours -- the knob teleporting back and forth, and a setpoint you
// cannot land on. Real measurements off the live card: a hand drags this
// dial between 45 and 139 units from the centre at 0.8 device pixel ratio,
// so the noise the hysteresis has to cover is about a sixth of a step.
{
  const c = bare();
  const HALL = { lo: 18, hi: 30, step: 1 };
  const BED = { lo: 16, hi: 30, step: 0.5 };
  // frac of the sweep that lands exactly on a given value
  const fracOf = (lim, v) => (v - lim.lo) / (lim.hi - lim.lo);

  eq("snap: with nothing held it takes the nearest step",
    c._snap(HALL, fracOf(HALL, 25), null), 25);
  eq("snap: and rounds a value between two of them",
    c._snap(HALL, fracOf(HALL, 25.4), null), 25);

  // Sitting on the 25/26 boundary with 25 held: it stays 25.
  const boundary = fracOf(HALL, 25.5);
  eq("snap: the boundary itself does not tip it", c._snap(HALL, boundary, 25), 25);
  eq("snap: nor does a nudge past it", c._snap(HALL, boundary + 0.004, 25), 25);
  eq("snap: nor a nudge back", c._snap(HALL, boundary - 0.004, 25), 25);
  // Approached from above, the same boundary holds 26.
  eq("snap: and from the other side it holds 26", c._snap(HALL, boundary, 26), 26);

  // A sixth of a step of noise either way never moves a held value -- this is
  // the number the whole thing is sized against.
  const sixth = (1 / 6) / ((HALL.hi - HALL.lo) / HALL.step);
  check("snap: a sixth of a step of noise moves nothing",
    [-3, -2, -1, 0, 1, 2, 3].every((k) =>
      c._snap(HALL, fracOf(HALL, 25) + k * sixth, 25) === 25));

  // Three quarters of a step of real travel does, and not a hair less: the
  // threshold is 0.5 + DRAG_HYST, so 25.75 is still 25 and 25.8 is 26.
  eq("snap: a hair under three quarters of a step holds",
    c._snap(HALL, fracOf(HALL, 25.75), 25), 25);
  eq("snap: deliberate travel still gets there",
    c._snap(HALL, fracOf(HALL, 25.8), 25), 26);
  eq("snap: and downward too", c._snap(HALL, fracOf(HALL, 24.2), 25), 24);

  // Every value is reachable, which is the thing a too-eager filter breaks.
  const reached = [];
  for (let v = HALL.lo; v <= HALL.hi; v++) {
    reached.push(c._snap(HALL, fracOf(HALL, v), v === HALL.lo ? null : v - 1));
  }
  eq("snap: every setpoint on the dial can be landed on", reached,
    [18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30]);
  eq("snap: including both ends", [c._snap(HALL, 0, 25), c._snap(HALL, 1, 25)], [18, 30]);

  // Halves on the bedroom unit, on the step GRID: a range starting at 16 with
  // a 0.5 step has no setpoint at 16.25.
  eq("snap: the bedroom lands on halves", c._snap(BED, fracOf(BED, 23.5), null), 23.5);
  check("snap: and never between them",
    [0, 0.13, 0.4, 0.66, 0.91, 1].every((f) => {
      const v = c._snap(BED, f, null);
      return Math.abs((v - BED.lo) / BED.step - Math.round((v - BED.lo) / BED.step)) < 1e-9;
    }));

  // The dead zone still resolves to an end rather than a wild value, which is
  // what keeps a drag past the bottom of the ring from wrapping 30 to 18.
  const rect = { left: 0, top: 0, width: 200, height: 200 };
  const atDeg = (deg) => {
    const a = deg * Math.PI / 180;
    return c._fracAt(100 + 80 * Math.cos(a), 100 + 80 * Math.sin(a), rect);
  };
  near("dial: past the bottom-left end clamps to the minimum", atDeg(110), 0, 1e-9);
  near("dial: past the bottom-right end clamps to the maximum", atDeg(70), 1, 1e-9);
  near("dial: the sweep still starts at 135 degrees", atDeg(135), 0, 1e-9);
  near("dial: and ends at 45", atDeg(45), 1, 1e-9);
}

/* --- 17. the dial's centre is not a place to read an angle from ----------- */
//
// The bug this pins: a hand that drifts toward the middle while dragging.
// Angular sensitivity goes as 1/r, so near the centre a couple of pixels of
// mouse is tens of degrees of knob -- measured live at 21 degrees per 2 px,
// running the setpoint from 24 to 30 in one short straight pull. Drawing the
// knob at the pointer exposed all of it, which is why it shook.
{
  const c = bare();
  // A 290px dial carrying the card's 220-unit box: one unit is this wide.
  const unit = 290 / 220;
  const at = (r) => c._dragUsable(r * unit, 0, unit);

  eq("dragzone: dead centre is not readable", at(0), false);
  eq("dragzone: four units out is not readable", at(4), false);
  eq("dragzone: just inside the threshold is not readable", at(24.9), false);
  eq("dragzone: at the threshold it is", at(25), true);
  // Measured off the live card: a hand drags this dial between 45 and 139
  // units out. The dead zone has to stay clear of that, or a third of the
  // drag does nothing -- which is how a filter for shaking became a dial you
  // could not set 25 on.
  eq("dragzone: the whole of a real hand's range is readable",
    [45, 60, 88, 110, 139].every(at), true);
  eq("dragzone: the ring itself certainly is", at(88), true);
  eq("dragzone: and beyond the ring too", at(120), true);
  eq("dragzone: a rect with no size reads nothing", c._dragUsable(50, 50, 0), false);
  // Radially symmetric -- the threshold is a circle, not a box.
  check("dragzone: the same in every direction",
    [0, 45, 90, 135, 180, 225, 270, 315].every((deg) => {
      const a = deg * Math.PI / 180;
      return c._dragUsable(45 * unit * Math.cos(a), 45 * unit * Math.sin(a), unit) === true
        && c._dragUsable(10 * unit * Math.cos(a), 10 * unit * Math.sin(a), unit) === false;
    }));

  // And the point of the number: at the threshold, two pixels of mouse stay
  // well under a third of the hall unit's 22.5-degree step. Inside it they
  // do not, which is the whole reason the zone exists.
  const degPer2px = (rUnits) => Math.atan(2 / (rUnits * unit)) * 180 / Math.PI;
  check("dragzone: four units in, a 2px wobble is most of a step",
    degPer2px(4) > 22.5 / 2, degPer2px(4).toFixed(2) + " deg");

  /*
   * The deadband and the dead zone are one design, and this is the bolt that
   * holds them together: at EVERY radius the drag will read, a hand's 2 px of
   * tremor has to move the knob less than the deadband, or it gets through
   * and the dial shakes. The tightest case is the innermost readable radius.
   */
  /*
   * And the bolt holding the dead zone to the hysteresis: at the innermost
   * radius still read, a pointer's noise has to stay well under the 0.2 of a
   * step the value is sticky by. Sized at 0.8 device pixel ratio -- the real
   * measurement -- where one mouse pixel is 1.25 CSS pixels.
   */
  const MOUSE_PX = 1.25;
  const stepsFor = (px, rUnits) =>
    (Math.atan(px * MOUSE_PX / (rUnits * unit)) * 180 / Math.PI) / 22.5;
  // Across the measured band, three mouse pixels of noise stay inside the
  // hysteresis, so nothing a hand does by accident moves the setpoint.
  check("dragzone: 3 mouse pixels never reach the hysteresis, 45 units out",
    stepsFor(3, 45) < 0.25, stepsFor(3, 45).toFixed(3) + " steps");
  check("dragzone: nor on the ring", stepsFor(3, 88) < 0.25,
    stepsFor(3, 88).toFixed(3) + " steps");
  check("dragzone: nor out at the far end of a hand's reach",
    stepsFor(3, 139) < 0.25, stepsFor(3, 139).toFixed(3) + " steps");
  // Inside that band the guarantee weakens with 1/r until the dead zone ends
  // it, which is the honest shape of the thing: it is a singularity, not a
  // cliff, and a hand does not go there.
  check("dragzone: the guarantee is weaker close in, and says so",
    stepsFor(3, 26) > 0.25, stepsFor(3, 26).toFixed(3) + " steps");
}

/* --- 18. the accent map, and the name that once shadowed it --------------- */
//
// The bug this pins: the per-tab paint cache was called `this._acc`, the same
// name as the method that maps an hvac_action to an accent -- and an instance
// property shadows a prototype method. It sat latent because the bedroom unit
// publishes no hvac_action and the hall only consults the map while its unit
// is ON, so the one call site threw the moment the living room A/C came on.
{
  const c = bare();
  check("acc: the action map is callable on an instance",
    typeof c._acc === "function");
  check("acc: and so is the hero accent",
    typeof c._heroAcc === "function" && typeof c._accOf === "function");

  // Painting the dial caches an accent; that must not break the map.
  c._heroAccs = {};
  c._heroAccs.bed = { c: "#38b6ff" };
  check("acc: caching a painted accent leaves the map alone",
    typeof c._acc === "function" && c._accOf("bed").c === "#38b6ff");
  check("acc: an untouched tab falls back rather than throwing",
    c._accOf("hall") !== undefined);
}

/* --- a setpoint the unit never answered ----------------------------------- */
//
// The bug this pins: this unit lands a given setpoint about five times in
// eight -- the miss either keeps the old value or overshoots by a degree --
// and the card used to report that by sliding the number back with no
// explanation, which is indistinguishable from a button that never fired.
// A miss is now remembered, and cleared the moment it stops being true.
{
  const ENT = "climate.bed";
  const withTemp = (t) => ({ _hass: { states: { [ENT]: { state: "cool",
    attributes: { temperature: t, min_temp: 16, max_temp: 30, target_temp_step: 0.5 } } } } });

  // Asked for 16.0, the unit stayed on 17.0, and the window ran out.
  const c = bare(Object.assign(withTemp(17), {
    _sent: { [ENT]: { value: 16, was: 17, trail: [16], at: Date.now() - 999999 } },
    _missed: {}, _resend: {},
  }));
  eq("miss: an unanswered send hands back the unit's own reading",
    c._settle(ENT, 17), 17);
  check("miss: and is remembered", !!c._missed[ENT]);
  eq("miss: with both numbers in it",
    [c._missed[ENT].want, c._missed[ENT].got], [16, 17]);
  eq("miss: which the tab can read back",
    [c._missOf(ENT).want, c._missOf(ENT).got], [16, 17]);

  // The unit came round to it later, by whatever route: nothing left to say.
  c._hass.states[ENT].attributes.temperature = 16;
  check("miss: clears itself once the unit gets there", c._missOf(ENT) === null);
  check("miss: and is gone, not just hidden", !c._missed[ENT]);

  // Stale misses do not sit on the tab forever.
  const old = bare(Object.assign(withTemp(17), {
    _sent: {}, _resend: {},
    _missed: { [ENT]: { want: 16, got: 17, at: Date.now() - 999999 } },
  }));
  check("miss: an old one stops being shown", old._missOf(ENT) === null);

  // A send that WAS answered leaves nothing behind.
  const ok = bare(Object.assign(withTemp(16), {
    _sent: { [ENT]: { value: 16, was: 17, trail: [16], at: Date.now() } },
    _missed: {}, _resend: {},
  }));
  eq("miss: an answered send settles on the answer", ok._settle(ENT, 16), 16);
  check("miss: and records no miss", !ok._missed[ENT]);

  // A fresh press supersedes the complaint from the last one.
  const again = bare(Object.assign(withTemp(17), {
    _sent: {}, _resend: {},
    _missed: { [ENT]: { want: 16, got: 17, at: Date.now() } },
  }));
  again._send(ENT, 16.5, 17);
  check("miss: pressing again clears the last complaint", !again._missed[ENT]);
}

/* --- values the unit passes through on its way ---------------------------- */
//
// The bug this pins: asked for 16.5 the unit reported 17.5 one second later,
// 16.5 three seconds after that, then 17.5 again. The card took the first
// 17.5 as the answer, so a press on "-" drew as a jump UP -- and deleting the
// pending send took the one repeat with it. Only a send marked noisy gets
// this window; a clamp on any other entity still wins at once.
{
  const ENT = "climate.bed";
  const now = Date.now();
  const pend = (extra) => Object.assign(
    { value: 16.5, was: 17, trail: [16.5], at: now, last: now }, extra || {});

  const noisy = bare({ _sent: { [ENT]: pend({ noisy: true }) }, _missed: {}, _resend: {} });
  eq("grace: the overshoot on the way is not the answer", noisy._settle(ENT, 17.5), 16.5);
  check("grace: and the send survives it, so the repeat can still fire",
    !!noisy._sent[ENT]);
  eq("grace: the value asked for still ends it", noisy._settle(ENT, 16.5), 16.5);

  // Same reading, same entity, but nothing marked it noisy.
  const plain = bare({ _sent: { [ENT]: pend() }, _missed: {}, _resend: {} });
  eq("grace: an unmarked send yields to the unit at once", plain._settle(ENT, 17.5), 17.5);
  eq("grace: and is forgotten", Object.keys(plain._sent).length, 0);

  // Once the window has passed, the unit's word wins on a noisy send too.
  const late = bare({ _sent: { [ENT]: pend({ noisy: true, last: now - 60000 }) },
    _missed: {}, _resend: {} });
  eq("grace: after the window the unit's word wins", late._settle(ENT, 17.5), 17.5);
}

/* --- the one repeat ------------------------------------------------------- */
//
// Armed by a press, fires once, and only while the value is still outstanding.
{
  const ENT = "climate.bed";
  const calls = [];
  const timers = [];
  const mk = (temp, sent) => bare({
    _hass: { states: { [ENT]: { state: "cool", attributes: { temperature: temp } } } },
    _sent: sent, _missed: {}, _resend: {},
    _call: (d, s, data) => calls.push([d, s, data]),
  });

  // The card calls the sandbox's window.setTimeout, so record through that.
  const realTimeout = sandbox.window.setTimeout;
  sandbox.window.setTimeout = (fn) => { timers.push(fn); return timers.length; };

  const c = mk(17, { [ENT]: { value: 16, was: 17, trail: [16], at: Date.now() } });
  c._armResend(ENT, "climate", "set_temperature", "temperature");
  eq("resend: nothing goes out until the timer fires", calls.length, 0);
  timers[0]();
  eq("resend: then the same value, once", calls,
    [["climate", "set_temperature", { entity_id: ENT, temperature: 16 }]]);
  check("resend: and the send is marked so it cannot repeat again",
    c._sent[ENT].retried === true);
  c._armResend(ENT, "climate", "set_temperature", "temperature");
  timers[1]();
  eq("resend: a second timer on a retried send sends nothing more", calls.length, 1);

  // Landed while the timer was running: no repeat at all.
  const landed = mk(16, { [ENT]: { value: 16, was: 17, trail: [16], at: Date.now() } });
  const before = calls.length;
  landed._armResend(ENT, "climate", "set_temperature", "temperature");
  timers[timers.length - 1]();
  eq("resend: a value that arrived in time is not repeated", calls.length, before);

  sandbox.window.setTimeout = realTimeout;
}

/* --- modes in which the setpoint is not a control ------------------------- */
//
// The bug this pins: in `fan_only` the bedroom unit ignores set_temperature
// entirely -- it keeps its setpoint and answers nothing -- while min_temp
// still reads 16.0 and supported_features still claims TARGET_TEMPERATURE.
// The card drew a live "-" that took the press and then lost it.
{
  const c = bare({ _hass: { states: {
    "climate.bed": { state: "fan_only", attributes: {} },
    "climate.hall": { state: "fan_only", attributes: {} },
  } } });
  check("frozen: fan_only freezes the bedroom setpoint",
    c._setpointFrozen("climate.bed", "bed") === true);
  check("frozen: the infrared hall unit is never frozen",
    c._setpointFrozen("climate.hall", "hall") === false);
  c._hass.states["climate.bed"].state = "cool";
  check("frozen: cool is a working setpoint again",
    c._setpointFrozen("climate.bed", "bed") === false);
}

/* --- the ring, where an arc stops being well determined -------------------- */
//
// The bug this pins: the whole sweep was one `A` command, and an SVG arc with
// nearly opposite endpoints has an ill-determined centre. Where the chord
// exceeds 2r the spec says to scale the radius up, so a chord a hair too long
// is drawn on a BIGGER circle, somewhere else. On this dial that falls on
// 25.5 -- 183.2 degrees, 0.069 of slack -- with both ends rounded to 0.1
// before the renderer sees them, which is why the arc jumped there and only
// there. Quarter turns cannot get near it.
{
  const c = bare();
  const R = 88, CX = 110, CY = 110;
  const seg = /A (\d+(?:\.\d+)?)  0 (\d) 1 ([-\d.]+) ([-\d.]+)/g;

  const chords = (frac) => {
    const d = c._arc(CX, CY, R, frac).d;
    const start = d.match(/^M ([-\d.]+) ([-\d.]+)/);
    let at = [Number(start[1]), Number(start[2])];
    const out = [];
    let m;
    seg.lastIndex = 0;
    while ((m = seg.exec(d)) !== null) {
      const to = [Number(m[3]), Number(m[4])];
      out.push({ chord: Math.hypot(to[0] - at[0], to[1] - at[1]), large: m[2] });
      at = to;
    }
    return out;
  };

  let worst = 0, worstAt = null, anyLarge = false;
  // Every setpoint the bedroom dial can hold, and then some.
  for (let t = 16; t <= 30.0001; t += 0.5) {
    const frac = (t - 16) / 14;
    for (const s of chords(frac)) {
      if (s.chord > worst) { worst = s.chord; worstAt = t; }
      if (s.large !== "0") anyLarge = true;
    }
  }
  check("arc: no segment comes near the diameter, 25.5 included",
    worst < 2 * R * 0.75, "worst chord " + worst.toFixed(3) + " at " + worstAt
      + ", diameter " + 2 * R);
  check("arc: and none of them needs the large-arc flag", !anyLarge);

  // The endpoint is still the point the knob is drawn at, to the tenth.
  for (const t of [16, 20, 25, 25.5, 26, 30]) {
    const frac = (t - 16) / 14;
    const a = c._arc(CX, CY, R, frac);
    const ang = (135 + 270 * (frac >= 0.9999 ? 269.9 / 270 : frac)) * Math.PI / 180;
    near("arc: the end of " + t + " is where the angle says (x)",
      a.x, CX + R * Math.cos(ang), 0.02);
    near("arc: the end of " + t + " is where the angle says (y)",
      a.y, CY + R * Math.sin(ang), 0.02);
  }

  // The one that was breaking: leaving 25.5 in either direction must move the
  // knob by one step's worth of arc and no more.
  const endAt = (t) => c._arc(CX, CY, R, (t - 16) / 14);
  const gap = (a, b) => Math.hypot(endAt(a).x - endAt(b).x, endAt(a).y - endAt(b).y);
  const stride = gap(21, 21.5);
  for (const [a, b] of [[25, 25.5], [25.5, 26], [24.5, 25], [26, 26.5]]) {
    near("arc: " + a + " -> " + b + " moves one step, like anywhere else",
      gap(a, b), stride, 0.15);
  }
}

/* --- the switch a swing command flips by itself ---------------------------- */
//
// The bug this pins: asking the bedroom unit for `horizontal` switches Frost
// protect on -- the switch entity flips and the unit shows FP on its panel for
// about fifteen seconds. `both` did it in one run of two. The option is wanted,
// so the card undoes the side effect instead of withholding the button, and
// the undo is deliberately narrow: only after a swing the card itself sent,
// only inside the window, only once, and never when Frost protect was already
// on before the command went out.
{
  const ENT = "climate.bed";
  const FP = "switch.153931629566331_frost_protect";
  const mk = (fp) => {
    const calls = [];
    const c = bare({
      _hass: { states: { [ENT]: { state: "cool", attributes: { swing_mode: "off" } },
        [FP]: { state: fp, attributes: {} } } },
      _config: { bed_climate: ENT, hall_climate: "climate.hall" },
      _swingGuard: null,
      _call: (d, s2, data) => calls.push([d, s2, data]),
    });
    return { c, calls };
  };

  // The ordinary case: off before, on after, switched back off once.
  {
    const { c, calls } = mk("off");
    c._guardSwing(ENT, "bed");
    check("swing guard: armed by the press", !!c._swingGuard);
    c._checkSwingGuard();
    eq("swing guard: nothing to undo while it stays off", calls.length, 0);
    c._hass.states[FP].state = "on";
    c._checkSwingGuard();
    eq("swing guard: switches it back off when it comes on",
      calls, [["switch", "turn_off", { entity_id: FP }]]);
    c._checkSwingGuard();
    eq("swing guard: and only once", calls.length, 1);
  }

  // Someone turned Frost protect on themselves and then moved the vanes.
  {
    const { c, calls } = mk("on");
    c._guardSwing(ENT, "bed");
    check("swing guard: not armed when it was already on", !c._swingGuard);
    c._checkSwingGuard();
    eq("swing guard: so a deliberate Frost protect is left alone", calls.length, 0);
  }

  // It comes on long after the swing: not ours to undo.
  {
    const { c, calls } = mk("off");
    c._guardSwing(ENT, "bed");
    c._swingGuard.until = Date.now() - 1;
    c._hass.states[FP].state = "on";
    c._checkSwingGuard();
    eq("swing guard: the window closes", calls.length, 0);
    check("swing guard: and disarms itself", !c._swingGuard);
  }

  // Nothing was sent by the card at all.
  {
    const { c, calls } = mk("off");
    c._hass.states[FP].state = "on";
    c._checkSwingGuard();
    eq("swing guard: an unprompted Frost protect is nobody's business",
      calls.length, 0);
  }

  // The infrared unit has no such switch, so nothing is ever armed for it.
  {
    const { c } = mk("off");
    c._guardSwing("climate.hall", "hall");
    check("swing guard: the hall unit has nothing to guard", !c._swingGuard);
  }
}

/* --- the room dot, at and past the ends of the dial ------------------------ */
//
// The bug this pins: a room outside the dial's range hid the dot entirely.
// The hall dial starts at 18 and a winter room sits under it for weeks, so
// the marking vanished for the whole season it was most useful -- and a
// missing dot looks exactly like a missing sensor. It pins to the end it ran
// past now, and only an unreadable sensor hides it.
{
  const ENT = "climate.bed";
  const marks = {};
  const el = (id) => (marks[id] = marks[id] || {
    attrs: {}, textContent: "",
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k]; },
  });

  const c = bare({
    _rmark: {},
    _el: { q: (sel) => el(sel.replace(/^#/, "")) },
  });
  const paint = (room, lo, hi, targetFrac) => {
    c._rmark = {};                       // each case stands on its own
    c._paintRoomMark("bed", room, lo, hi, targetFrac, { c: "#38b6ff" });
    const dot = el("bed-rmark"), title = el("bed-rmark-t");
    return {
      shown: dot.attrs.opacity === "1",
      cx: dot.attrs.cx === undefined ? null : Number(dot.attrs.cx),
      cy: dot.attrs.cy === undefined ? null : Number(dot.attrs.cy),
      fill: dot.attrs.fill,
      title: title.textContent,
    };
  };

  // The ends of a 16-30 dial, for comparison.
  const atLo = paint(16, 16, 30, 0.5);
  const atHi = paint(30, 16, 30, 0.5);

  const below = paint(9, 16, 30, 0.5);
  check("dot: a room below the dial is still drawn", below.shown === true);
  eq("dot: pinned to the low end, not floating off it",
     [below.cx, below.cy], [atLo.cx, atLo.cy]);
  check("dot: and says so when you hover",
        /below everything/.test(below.title), below.title);

  const above = paint(41, 16, 30, 0.5);
  check("dot: a room above the dial is still drawn", above.shown === true);
  eq("dot: pinned to the high end", [above.cx, above.cy], [atHi.cx, atHi.cy]);
  check("dot: and says which way it went",
        /above everything/.test(above.title), above.title);

  // In range, nothing changed.
  const mid = paint(23, 16, 30, 0.5);
  check("dot: an ordinary reading is not pinned to either end",
        mid.cx !== atLo.cx && mid.cx !== atHi.cx);
  eq("dot: and reads plainly", mid.title, "Room 23.0 °C");

  // The fill still says which side of the setpoint the room is on, and that
  // has to keep working for a pinned dot -- below the dial is below the
  // target by definition.
  check("dot: below the dial is a hole in the arc, like any reading under "
        + "the setpoint", below.fill !== "#38b6ff");
  eq("dot: above the dial takes the accent, like any reading over it",
     above.fill, "#38b6ff");

  // Only an unusable reading hides it.
  const none = paint(null, 16, 30, 0.5);
  check("dot: no reading hides it", none.shown === false);
  const flat = paint(23, 20, 20, 0.5);
  check("dot: and so does a dial with no span", flat.shown === false);
}

/* --- comfort badges ------------------------------------------------------- */
//
// Temperature and humidity are separate axes, each with a quiet middle and a
// mild and a strong step either side. The rows are the table the ladder was
// agreed from; the edges are where an off-by-one would hide.
{
  const c = bare();
  const labels = (t, h) => c._comfort(t, h).map((b) => b.label);
  const rows = [
    ["winter bedroom, radiators on", 23, 24, ["Very dry"]],
    ["winter living room", 21, 35, ["Dry"]],
    ["cold hallway", 18, 45, ["Cool"]],
    ["ideal", 23, 50, ["Comfortable"]],
    ["summer afternoon", 28, 55, ["Warm"]],
    ["kitchen while cooking", 25, 66, ["Humid"]],
    ["bathroom after a shower", 24, 78, ["Very humid"]],
    ["heatwave, no AC", 33, 62, ["Hot", "Humid"]],
    ["cool and damp autumn", 19, 72, ["Cool", "Very humid"]],
    ["no reading", null, 50, ["No data"]],
  ];
  rows.forEach(([name, t, h, want]) => eq("comfort: " + name, labels(t, h), want));

  // Edges. Humidity is rounded to a whole percent before it is judged.
  eq("comfort: 29.4 % rounds to 29, very dry", labels(23, 29.4), ["Very dry"]);
  eq("comfort: 29.5 % rounds to 30, dry", labels(23, 29.5), ["Dry"]);
  eq("comfort: 39 % is still dry", labels(23, 39), ["Dry"]);
  eq("comfort: 40 % is comfortable", labels(23, 40), ["Comfortable"]);
  eq("comfort: 60.4 % rounds to 60, comfortable", labels(23, 60.4), ["Comfortable"]);
  eq("comfort: 60.5 % rounds to 61, humid", labels(23, 60.5), ["Humid"]);
  eq("comfort: 70 % is still humid", labels(23, 70), ["Humid"]);
  eq("comfort: 71 % is very humid", labels(23, 71), ["Very humid"]);
  eq("comfort: 31.9 °C is warm", labels(31.9, 50), ["Warm"]);
  eq("comfort: hot starts at 32 °C", labels(32, 50), ["Hot"]);

  // Every badge carries an icon, and every label has its own.
  const all = [[18, 24], [23, 35], [28, 66], [33, 78], [23, 50], [null, null]]
    .flatMap(([t, h]) => c._comfort(t, h));
  check("comfort: every badge has an mdi icon",
        all.every((b) => /^mdi:[a-z-]+$/.test(b.icon)));
  const byLabel = new Map(all.map((b) => [b.label, b.icon]));
  eq("comfort: no two labels share an icon",
     new Set(byLabel.values()).size, byLabel.size);
}

/* --- power button: the hall unit resumes its last mode ------------------- */
//
// The bug this pins: the hall A/C is an MQTT climate with no power topic, and
// climate.turn_on on those picks the first of heat_cool / heat / cool --
// Auto. The button must resume the mode the bridge remembers instead.
{
  const HALL = "climate.daewoo_a_c", BED = "climate.bedroom_ac",
        ASSUMED = "sensor.a_c_assumed_state";
  const press = (ent, states) => {
    const calls = [];
    const c = bare({
      _config: { hall_climate: HALL, hall_assumed: ASSUMED, bed_climate: BED },
      _hass: { states, callService: (d, s, data) => calls.push([d, s, data]) },
    });
    const node = { getAttribute: (k) => ({ "data-act": "power", "data-ent": ent })[k] || null };
    c._onClick({ composedPath: () => [node], stopPropagation() {}, preventDefault() {} });
    return calls;
  };
  const hall = (state, mode, modes) => ({
    [HALL]: { state, attributes: { hvac_modes: modes || ["off", "cool", "heat", "heat_cool", "fan_only", "dry"] } },
    [ASSUMED]: { state: "off", attributes: { mode } },
  });

  eq("power: hall off -> resumes the remembered mode",
     press(HALL, hall("off", "fan_only")),
     [["climate", "set_hvac_mode", { entity_id: HALL, hvac_mode: "fan_only" }]]);
  eq("power: hall off, nothing remembered -> cool, never Auto",
     press(HALL, hall("off", undefined)),
     [["climate", "set_hvac_mode", { entity_id: HALL, hvac_mode: "cool" }]]);
  eq("power: a remembered mode the unit no longer offers -> cool",
     press(HALL, hall("off", "auto_dry")),
     [["climate", "set_hvac_mode", { entity_id: HALL, hvac_mode: "cool" }]]);
  eq("power: no hvac_modes published yet -> trust the remembered mode",
     press(HALL, { [HALL]: { state: "off", attributes: {} },
                   [ASSUMED]: { state: "off", attributes: { mode: "heat" } } }),
     [["climate", "set_hvac_mode", { entity_id: HALL, hvac_mode: "heat" }]]);
  eq("power: hall on -> turn_off",
     press(HALL, hall("cool", "cool")),
     [["climate", "turn_off", { entity_id: HALL }]]);
  eq("power: bedroom off -> turn_on (its integration resumes by itself)",
     press(BED, { [BED]: { state: "off", attributes: {} } }),
     [["climate", "turn_on", { entity_id: BED }]]);
}

/* --- report -------------------------------------------------------------- */

if (failures.length) {
  console.log("test_climate_chart: " + failures.length + " failure(s), " + pass + " passed");
  failures.forEach((f) => console.log("  - " + f));
  process.exit(1);
}
console.log("test_climate_chart: ok — " + pass + " checks passed");
