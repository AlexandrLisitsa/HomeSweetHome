/**
 * The router console card: rates in Mbit/s from any data-rate unit, the
 * status pill, the WAN address's kind, today's peak and average from the
 * recorder's history, the 7 d / 30 d statistics, the range buttons, the taps,
 * and that it fetches nothing and keeps no timer once it is off the page.
 *
 *     node HomeAssistant/tools/test_router_card.js
 *
 * The addresses here are made up: the house's real one never goes in git.
 * Exit status is 0 when everything passes, 1 otherwise.
 */

"use strict";

const { fire, loadCard, mkHass, S } = require("./fake_dom");

const FILE = "router-console-card.js";
const DOWN = "sensor.archer_c80_ac1900_mu_mimo_wi_fi_router_download_speed";
const UP = "sensor.archer_c80_ac1900_mu_mimo_wi_fi_router_upload_speed";
const IP = "sensor.archer_c80_ac1900_mu_mimo_wi_fi_router_external_ip";
let failed = 0;
let passed = 0;

function eq(label, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) passed++;
  else {
    failed++;
    console.log("  FAIL " + label + ": " + JSON.stringify(got) + "  want " + JSON.stringify(want));
  }
}
const check = (label, ok) => eq(label, !!ok, true);

const iso = (ms) => new Date(ms).toISOString();

function states(over) {
  const now = Date.now();
  return Object.assign({
    [DOWN]: S("1024", { unit_of_measurement: "KiB/s" }, { last_updated: iso(now - 20e3) }),
    [UP]: S("128", { unit_of_measurement: "KiB/s" }, { last_updated: iso(now - 20e3) }),
    [IP]: S("100.64.0.10", {}, { last_changed: iso(now - 3600e3) }),
  }, over || {});
}

/** A card with a fake hass; `ws` answers callWS. Put on the page with `connect`. */
function mount(st, ws, cfg) {
  const L = loadCard(FILE);
  const card = new L.Card();
  card.setConfig(cfg || {});
  const hass = mkHass(st || states(), { callWS: ws });
  card.hass = hass;
  L.flushTimers();
  const $ = (s) => card.shadowRoot.querySelector(s);
  return { L, card, hass, $ };
}

const settle = () => new Promise((r) => setImmediate(r));

(async () => {
  /* --- units and the live tiles --------------------------------------------- */
  {
    const m = mount();
    // 1024 KiB/s = 8.388608 Mbit/s; 128 KiB/s = 1.048576 Mbit/s.
    eq("download in Mbit/s from KiB/s", m.$(".t-down .v").textContent, "8.4");
    eq("upload in Mbit/s from KiB/s", m.$(".t-up .v").textContent, "1.0");
    const other = mount(states({ [DOWN]: S("250", { unit_of_measurement: "Mbit/s" }),
      [UP]: S("500", { unit_of_measurement: "kbit/s" }) }));
    eq("Mbit/s stays as it is, above 100 without decimals", other.$(".t-down .v").textContent, "250");
    eq("kbit/s under 1 Mbit/s gets two decimals", other.$(".t-up .v").textContent, "0.50");
    const odd = mount(states({ [DOWN]: S("12", { unit_of_measurement: "furlongs" }) }));
    eq("an unknown unit shows a dash, not a guess", odd.$(".t-down .v").textContent, "—");
    eq("the tiles open their entity", [m.$(".t-down"), m.$(".t-up"), m.$(".t-ip")].map((t) => t.getAttribute("data-more")),
      [DOWN, UP, IP]);
    check("before history arrives the tiles say so", /loading/.test(m.$(".t-down .sub").textContent));
    eq("…and the bars stay empty, not full against the live rate alone",
      [m.$(".t-down .bar b").style.width, m.$(".t-up .bar b").style.width], ["0%", "0%"]);
  }

  /* --- the status pill --------------------------------------------------------- */
  {
    eq("fresh rates: Online", mount().$(".pill-t").textContent, "Online");
    const old = iso(Date.now() - 11 * 60e3);
    eq("eleven minutes without a reading: Stale", mount(states({
      [DOWN]: S("1", { unit_of_measurement: "KiB/s" }, { last_updated: old }),
      [UP]: S("1", { unit_of_measurement: "KiB/s" }, { last_updated: old }) })).$(".pill-t").textContent, "Stale");
    const gone = mount(states({ [DOWN]: S("unavailable"), [UP]: S("unavailable") }));
    eq("both rates unavailable: No data", gone.$(".pill-t").textContent, "No data");
    check("…in the warning tone", gone.$(".pill").className.indexOf("warn") >= 0);
    eq("…and the tiles draw dashes", gone.$(".t-down .v").textContent, "—");
  }

  /* --- the WAN address --------------------------------------------------------- */
  {
    const kind = (ip) => mount(states({ [IP]: S(ip) })).$(".t-ip .tag").className;
    eq("100.64.0.0/10 is carrier-grade NAT", ["100.64.0.10", "100.127.255.1"].map(kind), ["tag cgnat", "tag cgnat"]);
    eq("100.63 and 100.128 are not", ["100.63.0.1", "100.128.0.1"].map(kind), ["tag public", "tag public"]);
    eq("RFC 1918 is behind another router", ["10.1.2.3", "172.16.0.1", "172.31.9.9", "192.168.1.5"].map(kind),
      ["tag private", "tag private", "tag private", "tag private"]);
    eq("172.32 is public", kind("172.32.0.1"), "tag public");
    eq("nothing or junk is no address", ["unknown", "", "unavailable", "not an ip"].map(kind),
      ["tag none", "tag none", "tag none", "tag none"]);
    const m = mount();
    check("CGNAT says no inbound ports", /no inbound/.test(m.$(".t-ip .tag").textContent));
    check("the tooltip names the address and its kind", /^External IP — 100\.64\.0\.10 · CGNAT/.test(
      m.$(".t-ip").getAttribute("data-tip")));
    check("…and when it last changed", /since \d\d:\d\d|since \d+ \w{3}/.test(m.$(".t-ip .sub").textContent));
  }

  /* --- history: today's peak and average, the 24 h chart ----------------------- */
  {
    const now = Date.now();
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    const t0 = Math.max(midnight.getTime() + 60e3, now - 3 * 3600e3);
    const span = now - t0;
    // 1024 KiB/s for the first half of today's window, 0 for the second: avg ≈ 4.2, peak 8.4.
    const ws = (msg) => {
      if (msg.type !== "history/history_during_period") return {};
      return {
        [DOWN]: [{ s: "1024", lu: t0 / 1000 }, { s: "0", lu: (t0 + span / 2) / 1000 }],
        [UP]: [{ state: "128", last_updated: iso(t0) }],
      };
    };
    const live = states({ [DOWN]: S("0", { unit_of_measurement: "KiB/s" }, { last_updated: iso(now) }) });
    const m = mount(live, ws);
    m.card.isConnected = true;
    m.card.connectedCallback();
    await settle();
    const req = m.hass.ws.find((x) => x.type === "history/history_during_period");
    check("connecting fetches the last 24 h of both rates", req && req.entity_ids.join() === [DOWN, UP].join()
      && req.minimal_response && req.no_attributes);
    eq("today's peak and average, time-weighted", m.$(".t-down .sub").textContent, "peak 8.4 · avg 4.2 today");
    eq("full-row history parses too", m.$(".t-up .sub").textContent, "peak 1.0 · avg 1.0 today");
    // Download is 0 now against an 8.4 peak; upload 1.05 now against its own 1.05 peak.
    eq("with history the bars run against the 24 h peak", [m.$(".t-down .bar b").style.width,
      m.$(".t-up .bar b").style.width], ["0%", "100%"]);
    check("the chart draws both lines", m.$(".l-down").getAttribute("d").length > 10
      && m.$(".l-up").getAttribute("d").length > 10);
    eq("no hourly peaks at 24 h", [m.$(".p-down").getAttribute("d"), m.$(".k-peak").hidden], ["", true]);
    check("the chart's tooltip has the window's peaks", /^Throughput — 24 h · peak 8\.4 down, 1\.0 up Mbit\/s/.test(
      m.$(".plot").getAttribute("data-tip")));
    check("the note is hidden when there is data", m.$(".note").hidden);

    const broken = mount(states(), () => { throw new Error("boom"); });
    broken.card.isConnected = true;
    broken.card.connectedCallback();
    await settle();
    check("a failed fetch says so on the chart", /history unavailable — boom/.test(broken.$(".note").textContent)
      && !broken.$(".note").hidden);
    const none = mount(states(), () => ({}));
    none.card.isConnected = true;
    none.card.connectedCallback();
    await settle();
    eq("an empty reply says there is no history", none.$(".note").textContent, "no history recorded");
  }

  /* --- the range buttons and the statistics ------------------------------------ */
  {
    const now = Date.now();
    const ws = (msg) => {
      if (msg.type !== "recorder/statistics_during_period") return {};
      const rows = [1, 2, 3].map((h) => ({ start: now - h * 3600e3, mean: 100 * h, max: 400 * h }));
      return { [DOWN]: rows, [UP]: rows.map((r) => ({ start: iso(r.start), mean: 10, max: 20 })) };
    };
    const m = mount(states(), ws);
    m.card.isConnected = true;
    m.card.connectedCallback();
    await settle();
    eq("24 h is the default", m.$(".seg .on").getAttribute("data-val"), "24h");
    check("no statistics are asked for at 24 h", !m.hass.ws.some((x) => x.type === "recorder/statistics_during_period"));
    fire(m.$("[data-val='7d']"), "click");
    await settle();
    const req = m.hass.ws.find((x) => x.type === "recorder/statistics_during_period");
    check("7 d asks for hourly mean and max", req && req.period === "hour" && req.types.join() === "mean,max");
    eq("7 d is pressed", [m.$(".seg .on").getAttribute("data-val"), m.$("[data-val='7d']").getAttribute("aria-pressed")],
      ["7d", "true"]);
    check("hourly peaks are drawn dashed", m.$(".p-down").getAttribute("d").length > 5 && !m.$(".k-peak").hidden);
    // 3 × 400 KiB/s max = 1200 KiB/s ≈ 9.8 Mbit/s.
    check("the 7 d tooltip quotes the hourly peak", /^Throughput — 7 d · peak 9\.8 down/.test(
      m.$(".plot").getAttribute("data-tip")));
    const n = m.hass.ws.length;
    fire(m.$("[data-val='7d']"), "click");
    await settle();
    eq("pressing the shown range again fetches nothing", m.hass.ws.length, n);
    fire(m.$("[data-val='30d']"), "click");
    await settle();
    const r30 = m.hass.ws.filter((x) => x.type === "recorder/statistics_during_period").pop();
    check("30 d asks for 30 days", r30 && Date.parse(r30.end_time) - Date.parse(r30.start_time) > 29 * 86400e3);
    let threw = null;
    try { mount(states(), null, { range: "1y" }); } catch (e) { threw = e.message; }
    check("an unknown range is refused", /range must be one of 24h, 7d, 30d/.test(threw || ""));
    threw = null;
    try { mount(states(), null, { download: "nope" }); } catch (e) { threw = e.message; }
    check("an entity that is not an entity id is refused", /download must be an entity id/.test(threw || ""));
  }

  /* --- taps -------------------------------------------------------------------- */
  {
    const m = mount();
    const seen = [];
    m.card.addEventListener("hass-more-info", (e) => seen.push(e.detail.entityId));
    fire(m.$(".t-ip .v"), "click");
    fire(m.$(".t-up"), "click");
    eq("a tap on a tile, or inside one, opens its entity", seen, [IP, UP]);
    eq("no service is called", m.hass.calls.length, 0);
  }

  /* --- nothing runs off the page ----------------------------------------------- */
  {
    const intervals = [];
    const cleared = [];
    const m = mount(states(), () => ({}));
    m.L.sandbox.window.setInterval = (fn, ms) => { intervals.push(ms); return 7; };
    m.L.sandbox.window.clearInterval = (id) => cleared.push(id);
    m.card.isConnected = true;
    m.card.connectedCallback();
    eq("on the page: one 5-minute refresh timer", intervals, [300000]);
    m.card.disconnectedCallback();
    eq("off the page: the timer is cleared", cleared, [7]);
    const before = m.hass.ws.length;
    m.card.hass = mkHass(states(), { callWS: () => ({}) });
    eq("a new hass while off the page fetches nothing", m.hass.ws.length, before);
    m.L.sandbox.document.hidden = true;
    const hid = mount(states(), () => ({}));
    hid.L.sandbox.document.hidden = true;
    hid.card.isConnected = true;
    hid.card.connectedCallback();
    eq("a hidden tab fetches nothing", hid.hass.ws.length, 0);
  }

  if (failed) {
    console.log("test_router_card: " + failed + " failed, " + passed + " passed");
    process.exit(1);
  }
  console.log("test_router_card: ok — " + passed + " checks");
})();
