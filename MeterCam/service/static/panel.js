// MeterCam panel. No framework, no build, no CDN: it must load on the LAN with
// the internet down. Every fetch is caused by a click or by the Live tab's
// refresh, and that refresh runs only while the tab is visible -- a panel left
// open in a background tab sends nothing.
"use strict";

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const state = { meter: $("#meter").value, tab: "live", day: null, kind: "all", days: 7, loaded: {} };
const LIVE_EVERY_MS = 60000;

async function getJSON(url, opts) {
  const r = await fetch(url, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || r.status + " " + r.statusText);
  return body;
}

function ago(seconds) {
  if (seconds == null || !isFinite(seconds)) return "—";
  const s = Math.max(0, Math.round(seconds));
  if (s < 90) return s + " s";
  if (s < 5400) return Math.round(s / 60) + " min";
  if (s < 172800) return (s / 3600).toFixed(1) + " h";
  return Math.round(s / 86400) + " d";
}
const bytes = (n) => n >= 1 << 30 ? (n / (1 << 30)).toFixed(2) + " GB" : n >= 1 << 20 ? (n / (1 << 20)).toFixed(1) + " MB" : Math.round(n / 1024) + " KB";
const stat = (k, v, s = "", cls = "") => `<div class="stat"><div class="k">${esc(k)}</div><div class="v ${cls}">${v}</div><div class="s">${s}</div></div>`;
const imgUrl = (r, thumb) => `/img/${encodeURIComponent(state.meter)}/${r.kind}/${r.day}/${encodeURIComponent(r.file)}${thumb ? "?thumb=1" : ""}`;
const fmtVal = (v) => v == null ? "—" : Number(v).toFixed(2);

// ---------------------------------------------------------------- tabs
function show(tab) {
  state.tab = tab;
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  document.querySelectorAll(".tab").forEach((s) => s.classList.toggle("on", s.id === tab));
  try { localStorage.setItem("metercam.tab", tab); } catch (e) { /* private mode */ }
  load(tab);
  schedule();
}
function load(tab, force) {
  if (!force && state.loaded[tab]) return;
  state.loaded[tab] = true;
  ({ live: loadLive, gallery: loadGallery, trend: loadTrend, storage: loadStorage, firmware: loadFirmware })[tab]();
}
$("#tabs").addEventListener("click", (e) => { if (e.target.dataset.tab) show(e.target.dataset.tab); });
$("#meter").addEventListener("change", (e) => { state.meter = e.target.value; state.loaded = {}; state.day = null; load(state.tab); });

// ---------------------------------------------------------------- live
let liveTimer = null;
function schedule() {
  clearTimeout(liveTimer);
  liveTimer = null;
  if (state.tab === "live" && document.visibilityState === "visible") {
    liveTimer = setTimeout(() => { loadLive(); schedule(); }, LIVE_EVERY_MS);
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.tab === "live") loadLive();
  schedule();
});

async function loadLive() {
  let o;
  try { o = await getJSON(`/api/overview?meter=${encodeURIComponent(state.meter)}`); }
  catch (e) { $("#live-stats").innerHTML = stat("Service", "error", esc(e.message), "bad"); return; }
  const now = o.now;
  const last = o.last || {};
  const acc = o.last_accepted || {};
  const accAge = acc.at_epoch ? now - acc.at_epoch : null;
  const due = o.next_wake_epoch ? o.next_wake_epoch - now : null;
  const late = due != null && due < -300;
  const fwRun = last.firmware;
  const fwOk = !fwRun || !o.firmware_offered || fwRun === o.firmware_offered;
  $("#live-stats").innerHTML = [
    stat("Last accepted", fmtVal(acc.value), acc.at_epoch ? ago(accAge) + " ago" : "never",
      accAge == null ? "warn" : accAge > 3 * o.wake_interval_s ? "bad" : "ok"),
    stat("Last read", last.accepted ? "accepted" : last.at ? "refused" : "—",
      last.at ? esc(last.at.replace("T", " ")) + (last.accepted ? "" : " · " + esc(last.reason_class || "")) : "",
      last.accepted ? "ok" : last.at ? "bad" : ""),
    stat("Next wake", due == null ? "—" : late ? "late" : "in " + ago(due),
      due == null ? "" : late ? ago(-due) + " overdue" : "every " + ago(o.wake_interval_s), late ? "bad" : ""),
    stat("Firmware", esc(fwRun || "—"), "offered: " + esc(o.firmware_offered || "none"), fwOk ? "" : "warn"),
    stat("Home Assistant", o.publish.write && o.publish.entity ? "writing" : "not writing",
      esc(o.publish.entity || "no write_entity"), o.publish.write && o.publish.entity ? "ok" : "warn"),
    stat("Service", o.config_ok ? "ok" : "config error", o.config_ok ? "up " + ago(o.uptime_s) : esc(o.config_error), o.config_ok ? "ok" : "bad"),
  ].join("");
  const t = Date.now();
  $("#live-last").src = `/live/${encodeURIComponent(state.meter)}/last.jpg?t=${t}`;
  $("#live-acc").src = `/live/${encodeURIComponent(state.meter)}/last_accepted.jpg?t=${t}`;
  $("#live-last-cap").textContent = last.at ? `Newest frame · ${last.at.replace("T", " ")} · ${last.accepted ? fmtVal(last.value) : "refused: " + (last.reason || "")}` : "Newest frame";
  $("#live-acc-cap").textContent = acc.at ? `Last accepted · ${fmtVal(acc.value)} · ${String(acc.at).slice(0, 16).replace("T", " ")}` : "Last accepted";
  $("#live-detail").innerHTML = last.file
    ? `<h2>Newest read</h2>${drumsHtml(last)}<p><button id="live-open">Open in gallery view</button></p>` : "";
  const btn = $("#live-open");
  if (btn) btn.onclick = () => openDetail(last);
}

// ---------------------------------------------------------------- gallery
async function loadGallery() {
  const sel = $("#g-day");
  $("#g-grid").innerHTML = '<p class="muted">Loading…</p>';
  if (!state.day) {
    try {
      const d = await getJSON("/api/days");
      const days = d.days.filter((x) => x.meters[state.meter]);
      sel.innerHTML = days.map((x) => {
        const m = x.meters[state.meter] || {};
        return `<option value="${x.day}">${x.day} · ${m.raw || 0} ok · ${m.rejected || 0} refused</option>`;
      }).join("") || `<option value="">nothing archived</option>`;
      state.day = days.length ? days[0].day : null;
    } catch (e) { $("#g-grid").innerHTML = `<p class="bad">${esc(e.message)}</p>`; return; }
  }
  if (!state.day) { $("#g-grid").innerHTML = ""; return; }
  sel.value = state.day;
  let data;
  try { data = await getJSON(`/api/reads?meter=${encodeURIComponent(state.meter)}&day=${state.day}&kind=${state.kind}`); }
  catch (e) { $("#g-grid").innerHTML = `<p class="bad">${esc(e.message)}</p>`; return; }
  const reads = data.reads.slice().reverse();
  $("#g-count").textContent = `${reads.length} reads`;
  state.reads = reads;
  $("#g-grid").innerHTML = reads.map((r, i) => `
    <button class="tile ${r.accepted ? "" : "refused"}" data-i="${i}">
      <img loading="lazy" src="${imgUrl(r, true)}" alt="">
      <div class="t">${esc((r.at || "").slice(11))} · <b>${fmtVal(r.value)}</b>
        ${r.accepted ? "" : `<div class="r" title="${esc(r.reason)}">${esc(r.reason || "refused")}</div>`}</div>
    </button>`).join("");
}
$("#g-day").addEventListener("change", (e) => { state.day = e.target.value; load("gallery", true); });
$("#g-kind").addEventListener("click", (e) => {
  if (!e.target.dataset.kind) return;
  state.kind = e.target.dataset.kind;
  document.querySelectorAll("#g-kind button").forEach((b) => b.classList.toggle("on", b === e.target));
  load("gallery", true);
});
$("#g-grid").addEventListener("click", (e) => {
  const tile = e.target.closest(".tile");
  if (tile) openDetail(state.reads[+tile.dataset.i]);
});

function drumsHtml(r) {
  const drums = r.drums || [];
  const conf = r.confidence || [];
  if (!drums.length) return `<p class="muted">No drums read${r.reason ? ": " + esc(r.reason) : ""}.</p>`;
  return `<div class="drums">${drums.map((d, i) => {
    const c = conf[i];
    const cls = c == null ? "" : c < 0.3 ? "bad" : c < 0.5 ? "warn" : "ok";
    return `<div class="drum"><b>${d == null ? "?" : Number(d).toFixed(1)}</b><small class="${cls}">${c == null ? "" : Math.round(c * 100) + "%"}</small></div>`;
  }).join("")}</div>`;
}

function kv(pairs) {
  return `<dl class="kv">${pairs.filter(([, v]) => v != null && v !== "").map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl>`;
}

function openDetail(r) {
  const a = r.align || {};
  $("#d-body").innerHTML = `
    <h2 style="margin-top:0">${esc((r.at || "").replace("T", " "))} · ${r.accepted ? '<span class="ok">accepted</span>' : '<span class="bad">refused</span>'}</h2>
    <div class="pair">
      <figure><img src="${imgUrl(r)}" alt="Archived frame"><figcaption>As the camera sent it</figcaption></figure>
      <figure id="d-replay-fig" hidden><img id="d-replay-img" alt="Replay"><figcaption id="d-replay-cap"></figcaption></figure>
    </div>
    ${drumsHtml(r)}
    ${kv([
      ["Value", esc(fmtVal(r.value))], ["Prevalue", esc(fmtVal(r.prevalue))], ["Delta", esc(r.delta)],
      ["Reason", esc(r.reason)], ["Lowest confidence", r.confidence_min == null ? null : Math.round(r.confidence_min * 100) + "%"],
      ["Alignment", a.ok == null ? null : esc(`${a.ok ? "ok" : "failed"} · ${a.inliers ?? "?"}/${a.matches ?? "?"} inliers · shift ${a.dx ?? "?"}, ${a.dy ?? "?"} px · ${a.rotation_deg ?? "?"}°${a.reason ? " · " + a.reason : ""}`)],
      ["Firmware", esc(r.firmware)], ["Took", r.duration_ms == null ? null : r.duration_ms + " ms"],
      ["Other frames of this wake", r.extras && r.extras.length ? r.extras.map((x) => `<a href="${imgUrl({ ...r, file: x })}" target="_blank">${esc(x)}</a>`).join(", ") : null],
      ["File", `<a href="${imgUrl(r)}" target="_blank">${esc(r.file)}</a>`],
    ])}
    <p><button class="primary" id="d-replay">Replay with the current config</button>
      <span class="muted">Runs this frame through the reader again: nothing is published or archived.</span></p>
    <div id="d-replay-out"></div>`;
  $("#d-replay").onclick = () => replay(r);
  $("#detail").showModal();
}

async function replay(r) {
  const btn = $("#d-replay");
  btn.disabled = true;
  btn.textContent = "Reading…";
  try {
    const out = await getJSON("/api/replay", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ meter: state.meter, kind: r.kind, day: r.day, file: r.file }),
    });
    if (out.annotated) {
      $("#d-replay-img").src = out.annotated;
      $("#d-replay-fig").hidden = false;
    }
    const same = out.value === r.value;
    $("#d-replay-cap").textContent = `Replayed: ${fmtVal(out.value)}${out.reason ? " · " + out.reason : ""}`;
    $("#d-replay-out").innerHTML = `<h2>Replay</h2>${drumsHtml({ drums: out.drums, confidence: (out.confidence || {}).per_drum, reason: out.reason })}
      ${kv([["Value now", esc(fmtVal(out.value)) + (same ? ' <span class="muted">(same as then)</span>' : ` <span class="warn">(was ${esc(fmtVal(r.value))})</span>`)],
            ["Reason", esc(out.reason)], ["Alignment", out.align ? esc(JSON.stringify(out.align)) : null], ["Took", out.duration_ms + " ms"]])}
      <p class="muted">Single-frame read: the agreement check and the gate are not applied, so “accepted” is not shown.</p>`;
  } catch (e) {
    $("#d-replay-out").innerHTML = `<p class="bad">${esc(e.message)}</p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Replay with the current config";
  }
}

// ---------------------------------------------------------------- trend
$("#t-days").addEventListener("click", (e) => {
  if (!e.target.dataset.days) return;
  state.days = +e.target.dataset.days;
  document.querySelectorAll("#t-days button").forEach((b) => b.classList.toggle("on", b === e.target));
  load("trend", true);
});

const W = 900, H = 220, P = { l: 56, r: 12, t: 10, b: 24 };
function axisTime(points, x) {
  const ticks = [];
  const seen = new Set();
  points.forEach((p) => { const d = (p.at || "").slice(5, 10); if (d && !seen.has(d)) { seen.add(d); ticks.push([x(p.t), d]); } });
  const step = Math.ceil(ticks.length / 10);
  return ticks.filter((_, i) => i % step === 0).map(([px, d]) => `<text x="${px}" y="${H - 6}">${d}</text>`).join("");
}
const ts = (at) => new Date(at + ":00").getTime();

function loadTrend() {
  getJSON(`/api/series?meter=${encodeURIComponent(state.meter)}&days=${state.days}`).then((s) => {
    const pts = s.points.filter((p) => p.at).map((p) => ({ ...p, t: ts(p.at) }));
    if (!pts.length) { $("#t-value").innerHTML = '<p class="muted">Nothing archived in this range.</p>'; $("#t-conf").innerHTML = ""; $("#t-days-chart").innerHTML = ""; return; }
    const t0 = Math.min(...pts.map((p) => p.t)), t1 = Math.max(...pts.map((p) => p.t)) || t0 + 1;
    const x = (t) => P.l + (W - P.l - P.r) * (t - t0) / Math.max(1, t1 - t0);

    // Reading: accepted values as a line.
    const acc = pts.filter((p) => p.accepted && p.value != null);
    if (acc.length) {
      const lo = Math.min(...acc.map((p) => p.value)), hi = Math.max(...acc.map((p) => p.value));
      const pad = (hi - lo) * 0.08 || 0.5;
      const y = (v) => H - P.b - (H - P.t - P.b) * (v - (lo - pad)) / ((hi + pad) - (lo - pad));
      const path = acc.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.value).toFixed(1)}`).join("");
      const yt = [lo, (lo + hi) / 2, hi].map((v) => `<text x="4" y="${y(v) + 4}">${v.toFixed(2)}</text><line x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/>`).join("");
      $("#t-value").innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Accepted readings">${yt}<path d="${path}" fill="none" stroke="var(--s1)" stroke-width="2"/>${axisTime(pts, x)}
        <text x="${W - P.r}" y="${P.t + 10}" text-anchor="end">+${(hi - lo).toFixed(2)} over the range</text></svg>`;
    } else {
      $("#t-value").innerHTML = '<p class="muted">No accepted reading in this range.</p>';
    }

    // Confidence: every read with one, coloured by verdict, against the gate's floors.
    const y2 = (c) => H - P.b - (H - P.t - P.b) * c;
    const th = s.thresholds || {};
    const lines = [[th.min_confidence, "min_confidence"], [th.min_confidence_last_digit, "last drum"]]
      .filter(([v]) => v != null)
      .map(([v, label]) => `<line x1="${P.l}" x2="${W - P.r}" y1="${y2(v)}" y2="${y2(v)}" stroke="var(--bad)" stroke-dasharray="4 4"/><text x="${W - P.r}" y="${y2(v) - 4}" text-anchor="end">${label} ${v}</text>`).join("");
    const dots = pts.filter((p) => p.confidence_min != null).map((p) =>
      `<circle cx="${x(p.t).toFixed(1)}" cy="${y2(p.confidence_min).toFixed(1)}" r="2.6" fill="${p.accepted ? "var(--s2)" : "var(--bad)"}"><title>${esc(p.at)} ${Math.round(p.confidence_min * 100)}%${p.accepted ? "" : " · " + esc(p.reason_class)}</title></circle>`).join("");
    const yt2 = [0, 0.5, 1].map((v) => `<text x="4" y="${y2(v) + 4}">${v * 100}%</text>`).join("");
    $("#t-conf").innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Lowest drum confidence">${yt2}${lines}${dots}${axisTime(pts, x)}</svg>`;

    // Per day: accepted plus refusals stacked by reason.
    const reasons = [...new Set(s.per_day.flatMap((d) => Object.keys(d.refused)))];
    const palette = ["var(--bad)", "var(--warn)", "#9b6bd1", "#c4588f", "#7d8a96", "#b07a3c"];
    const colour = (k) => palette[reasons.indexOf(k) % palette.length];
    const maxN = Math.max(1, ...s.per_day.map((d) => d.accepted + Object.values(d.refused).reduce((a, b) => a + b, 0)));
    const bw = (W - P.l - P.r) / s.per_day.length;
    const yb = (n) => (H - P.t - P.b) * n / maxN;
    const bars = s.per_day.map((d, i) => {
      let top = H - P.b;
      const seg = (n, fill, label) => { if (!n) return ""; const h = yb(n); top -= h; return `<rect x="${P.l + i * bw + 1}" y="${top}" width="${Math.max(1, bw - 2)}" height="${h}" fill="${fill}"><title>${d.day} · ${label}: ${n}</title></rect>`; };
      return seg(d.accepted, "var(--ok)", "accepted") + reasons.map((k) => seg(d.refused[k] || 0, colour(k), k)).join("")
        + (s.per_day.length <= 14 || i % Math.ceil(s.per_day.length / 10) === 0 ? `<text x="${P.l + i * bw + bw / 2}" y="${H - 6}" text-anchor="middle">${d.day.slice(5)}</text>` : "");
    }).join("");
    $("#t-days-chart").innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Reads per day"><text x="4" y="${P.t + 10}">${maxN}</text>${bars}</svg>`;
    $("#t-legend").innerHTML = `<span><i style="background:var(--ok)"></i>accepted</span>` + reasons.map((k) => `<span><i style="background:${colour(k)}"></i>${esc(k)}</span>`).join("");
  }).catch((e) => { $("#t-value").innerHTML = `<p class="bad">${esc(e.message)}</p>`; });
}

// ---------------------------------------------------------------- storage
function loadStorage() {
  getJSON("/api/days").then((d) => {
    const used = d.total.bytes, cap = d.cap_bytes;
    $("#s-stats").innerHTML = stat("Archive", bytes(used), `of ${bytes(cap)} ceiling`, used > cap * 0.9 ? "warn" : "")
      + stat("Frames", d.total.frames, "every meter") + stat("Days kept", d.days.length, d.days.length ? `oldest ${d.days[d.days.length - 1].day}` : "");
    $("#s-fill").style.width = Math.min(100, 100 * used / cap).toFixed(1) + "%";
    const meters = [...new Set(d.days.flatMap((x) => Object.keys(x.meters)))];
    $("#s-table").innerHTML = `<tr><th>Day</th><th>Age</th>${meters.map((m) => `<th>${esc(m)} ok / refused</th>`).join("")}<th>Size</th></tr>`
      + d.days.map((x) => `<tr><td>${x.day}</td><td>${x.age_days} d</td>${meters.map((m) => { const c = x.meters[m] || {}; return `<td>${c.raw || 0} / ${c.rejected || 0}</td>`; }).join("")}<td>${bytes(x.bytes)}</td></tr>`).join("");
  }).catch((e) => { $("#s-stats").innerHTML = `<p class="bad">${esc(e.message)}</p>`; });
}

// ---------------------------------------------------------------- firmware
function loadFirmware() {
  getJSON(`/api/overview?meter=${encodeURIComponent(state.meter)}`).then((o) => {
    $("#f-stats").innerHTML = stat("On offer", esc(o.firmware_offered || "none"), "what /read answers with")
      + stat("Board runs", esc((o.last || {}).firmware || "—"), "as of its last wake");
  }).catch(() => {});
}
let armed = null;
$("#f-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const version = form.version.value.trim();
  const go = $("#f-go");
  // Two clicks, not a confirm() dialog: the second one names what it publishes.
  if (armed !== version) {
    armed = version;
    go.textContent = `Really publish ${version}?`;
    setTimeout(() => { if (armed === version) { armed = null; go.textContent = "Publish"; } }, 8000);
    return;
  }
  armed = null;
  go.disabled = true;
  go.textContent = "Publishing…";
  try {
    const out = await getJSON("/api/firmware", { method: "POST", body: new FormData(form) });
    $("#f-msg").innerHTML = `<span class="ok">Published ${esc(out.published)} (${bytes(out.bytes)}). The board takes it on its next wake.</span>`;
    form.reset();
    loadFirmware();
  } catch (err) {
    $("#f-msg").innerHTML = `<span class="bad">${esc(err.message)}</span>`;
  } finally {
    go.disabled = false;
    go.textContent = "Publish";
  }
});

// ---------------------------------------------------------------- start
let first = "live";
try { first = localStorage.getItem("metercam.tab") || "live"; } catch (e) { /* private mode */ }
show(document.getElementById(first) ? first : "live");
