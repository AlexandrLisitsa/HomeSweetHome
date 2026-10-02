/*
 * load-shedding-card -- the constructor for config/packages/load_shedding.yaml
 *
 * The "Load shedding" tab of the Shutdowns dashboard. Build the rules here:
 * add any device, give it steps -- "at N % battery, do <action>" -- where the
 * action is any service of that device's own domain, with its fields drawn
 * from Home Assistant's own service descriptions. The package is the engine;
 * this card never decides anything, it only edits the rules and shows what
 * the engine is doing. Full write-up: HomeAssistant/docs/load-shedding.md.
 *
 *   type: custom:load-shedding-card
 *   blocks: [hero, upcoming, rules, backup]   # any subset, in any order
 *
 * `upcoming` is the "Coming up" table: every armed device's next step and how
 * far away it is, highlighted inside the warning margin, with Keep on / Put
 * back / Release buttons (script.load_shedding_hold / _release).
 *
 * Laid out like its neighbour dtek-shutdowns-card.js: the same `blocks:`
 * option, the same hero / tiles / head / blurb / foot styling, and the view
 * splits the blocks into sections with headings between them. Several cards
 * on one view share ONE draft (SHARED below), so the Backup block's Import
 * lands in the Rules block's editor.
 *
 * Editing is on a local draft: nothing reaches Home Assistant until Save,
 * which calls script.load_shedding_save_config. That script validates and
 * raises on a bad config; the error is shown under the Save bar.
 *
 * Bump VERSION on every edit and register it with
 *
 *   python HomeAssistant/tools/ha_dashboard.py --card load-shedding-card.js
 */

const CARD = "load-shedding-card";
const VERSION = "3.1.2";

const RED = "var(--error-color, #db4437)";
const GREEN = "var(--success-color, #43a047)";
const AMBER = "var(--warning-color, #ffa600)";

const BLOCKS = ["hero", "upcoming", "rules", "backup"];

const DEFAULTS = {
  config: "sensor.load_shedding_config",
  state: "sensor.load_shedding",
  master: "input_boolean.load_shedding_enabled",
  soc: "sensor.jkbms_gateway_bms_state_of_charge",
  runtime: "sensor.battery_runtime_remaining",
  // on = UNSAFE (device_class: safety)
  grid_unsafe: "binary_sensor.powmr_inverter_grid_condition_safe",
  save_script: "load_shedding_save_config",
  hold_script: "load_shedding_hold",
  release_script: "load_shedding_release",
  blocks: BLOCKS.slice(),
};

// Domains that are readings, not devices: nothing to switch.
const NOT_DEVICES = ["sensor", "binary_sensor", "zone", "person", "sun", "weather",
  "device_tracker", "event", "update", "image", "tts", "stt", "conversation",
  "calendar", "todo", "notify", "automation", "script", "scene", "group",
  "persistent_notification", "assist_satellite", "wake_word", "ai_task"];

// Services that make no sense as a step.
const HIDDEN_SERVICES = ["reload", "toggle"];

// Selector types typed as plain text.
const TEXT_TYPES = ["text", "string", "template", "entity", "time", "duration"];

const ICONS = {
  climate: "mdi:air-conditioner", light: "mdi:lightbulb-outline", switch: "mdi:power-socket-eu",
  fan: "mdi:fan", input_boolean: "mdi:toggle-switch-outline", media_player: "mdi:television",
  cover: "mdi:window-shutter", water_heater: "mdi:water-boiler", humidifier: "mdi:air-humidifier",
  vacuum: "mdi:robot-vacuum", lock: "mdi:lock-outline", number: "mdi:ray-vertex",
  select: "mdi:format-list-bulleted", button: "mdi:gesture-tap-button",
};

// The one action that is not a real service: relative to the setpoint the
// device had before its first step, resolved by the package.
const ADJUST = {
  name: "Change temperature by",
  fields: { by: { required: true,
    selector: { number: { min: -10, max: 10, step: 0.5, unit_of_measurement: "°" } } } },
};

const clone = (o) => JSON.parse(JSON.stringify(o === undefined ? null : o));

/*
 * One draft for every card on the page. `null` = not editing: the stored
 * rules are shown as they are. Cards subscribe and re-render on change.
 */
const SHARED = window.__loadSheddingShared || (window.__loadSheddingShared = {
  draft: null,
  error: "",
  saving: false,
  subs: new Set(),
  set(draft) {
    this.draft = draft;
    this.error = "";
    this.subs.forEach((fn) => fn());
  },
  notify() { this.subs.forEach((fn) => fn()); },
});

class LoadSheddingCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._print = null;
    this._pending = false;
    this._ui = { picker: false, query: "", adv: {}, guard: {}, exportOpen: false, importText: "" };
    this._onShared = () => this._render(true);
    this.shadowRoot.addEventListener("click", (ev) => this._onClick(ev));
    this.shadowRoot.addEventListener("change", (ev) => this._onChange(ev));
    this.shadowRoot.addEventListener("input", (ev) => this._onInput(ev));
    this.shadowRoot.addEventListener("focusout", () => {
      if (this._pending) window.setTimeout(() => this._render(true), 0);
    });
  }

  setConfig(config) {
    const cfg = Object.assign({}, DEFAULTS, config || {});
    if (!Array.isArray(cfg.blocks) || !cfg.blocks.length
        || cfg.blocks.some((b) => BLOCKS.indexOf(b) < 0)) {
      throw new Error(CARD + ": blocks must be a non-empty list of " + BLOCKS.join(", "));
    }
    this._config = cfg;
    this._print = null;
    if (this._hass) this._render(true);
  }

  set hass(hass) {
    this._hass = hass;
    if (this._config) this._render(false);
  }

  connectedCallback() {
    SHARED.subs.add(this._onShared);
  }

  disconnectedCallback() {
    SHARED.subs.delete(this._onShared);
  }

  getCardSize() {
    const per = { hero: 5, upcoming: 4, rules: 12, backup: 4 };
    return this._config ? this._config.blocks.reduce((t, b) => t + (per[b] || 0), 0) : 20;
  }

  static getStubConfig() {
    return {};
  }

  // --- reading ---------------------------------------------------------------

  _obj(id) {
    return (this._hass && this._hass.states && this._hass.states[id]) || null;
  }

  _state(id) {
    const st = this._obj(id);
    return st ? st.state : "unknown";
  }

  _num(id) {
    const v = parseFloat(this._state(id));
    return Number.isFinite(v) ? v : null;
  }

  /** The rules as saved. */
  _stored() {
    const a = (this._obj(this._config.config) || {}).attributes || {};
    return {
      override_step: Number.isFinite(Number(a.override_step)) ? Number(a.override_step) : 10,
      warn_margin: Number.isFinite(Number(a.warn_margin)) ? Number(a.warn_margin) : 1,
      devices: Array.isArray(a.devices) ? a.devices : [],
    };
  }

  /** The rules being shown: the draft if there is one. */
  _rules() {
    return SHARED.draft || this._stored();
  }

  _dirty() {
    return !!SHARED.draft && JSON.stringify(SHARED.draft) !== JSON.stringify(this._stored());
  }

  _shed() {
    const a = (this._obj(this._config.state) || {}).attributes || {};
    return a.loads && typeof a.loads === "object" ? a.loads : {};
  }

  _edit(fn) {
    const d = clone(this._rules());
    fn(d);
    SHARED.set(d);
  }

  _services(domain) {
    const all = (this._hass && this._hass.services && this._hass.services[domain]) || {};
    const names = Object.keys(all).filter((s) => HIDDEN_SERVICES.indexOf(s) < 0);
    const rank = (s) => (s === "turn_off" ? 0 : s === "turn_on" ? 1 : 2);
    names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    const list = names.map((s) => ({ action: domain + "." + s, name: this._svcName(domain, s), def: all[s] }));
    if (domain === "climate") {
      list.splice(Math.min(list.length, 2), 0,
        { action: "climate.adjust_temperature", name: ADJUST.name, def: ADJUST });
    }
    return list;
  }

  _svcName(domain, svc) {
    const loc = this._hass && this._hass.localize
      && this._hass.localize("component." + domain + ".services." + svc + ".name");
    return loc || (svc.charAt(0).toUpperCase() + svc.slice(1)).replace(/_/g, " ");
  }

  _fieldName(domain, svc, key) {
    const loc = this._hass && this._hass.localize
      && this._hass.localize("component." + domain + ".services." + svc + ".fields." + key + ".name");
    return loc || key.replace(/_/g, " ");
  }

  /** Service fields, sections flattened; `adv` marks a collapsed section or advanced field. */
  _fields(def) {
    const out = [];
    const walk = (fields, adv) => Object.entries(fields || {}).forEach(([key, f]) => {
      if (f && f.fields && !f.selector) walk(f.fields, adv || !!f.collapsed);
      else out.push({ key, f: f || {}, adv: adv || !!(f && f.advanced) });
    });
    walk(def && def.fields, false);
    return out;
  }

  /** Does this entity support this field (the selector's `filter`)? */
  _supports(entity, f) {
    const flt = f.filter;
    if (!flt) return true;
    const st = this._obj(entity);
    if (!st) return true;
    const a = st.attributes || {};
    if (flt.supported_features) {
      const sf = Number(a.supported_features) || 0;
      if (!flt.supported_features.some((bit) => (sf & bit) === bit)) return false;
    }
    if (flt.attribute) {
      for (const [k, vals] of Object.entries(flt.attribute)) {
        const have = Array.isArray(a[k]) ? a[k] : a[k] === undefined ? [] : [a[k]];
        if (!have.some((v) => vals.indexOf(v) >= 0)) return false;
      }
    }
    return true;
  }

  _fingerprint() {
    const c = this._config;
    const rules = this._rules();
    const ids = [c.config, c.state, c.master, c.soc, c.runtime, c.grid_unsafe];
    const parts = ids.map((id) => {
      const st = this._obj(id);
      return st ? st.state + JSON.stringify(st.attributes) : "-";
    });
    rules.devices.forEach((d) => {
      const st = this._obj(d.entity);
      const a = (st && st.attributes) || {};
      parts.push(d.entity + "=" + (st ? st.state : "-") + "/" + a.temperature + "/" + a.brightness
        + "/" + a.percentage);
    });
    return parts.join("|") + "|" + JSON.stringify(SHARED.draft) + SHARED.error + SHARED.saving
      + JSON.stringify(this._ui);
  }

  // --- events ------------------------------------------------------------------

  _target(ev, attr) {
    return ev.composedPath().find((n) => n.dataset && n.dataset[attr] !== undefined);
  }

  _onClick(ev) {
    const node = this._target(ev, "act");
    if (!node || !this._hass) return;
    const act = node.dataset.act;
    const di = node.dataset.dev !== undefined ? Number(node.dataset.dev) : null;
    const si = node.dataset.step !== undefined ? Number(node.dataset.step) : null;
    ev.stopPropagation();

    if (act === "master") {
      this._hass.callService("input_boolean", "toggle", { entity_id: this._config.master });
    } else if (act === "more") {
      const e = new Event("hass-more-info", { bubbles: true, composed: true });
      e.detail = { entityId: node.dataset.ent };
      this.dispatchEvent(e);
    } else if (act === "enable") {
      this._edit((d) => { d.devices[di].enabled = d.devices[di].enabled === false; });
    } else if (act === "remove-dev") {
      this._edit((d) => { d.devices.splice(di, 1); });
    } else if (act === "add-step") {
      this._edit((d) => {
        const dev = d.devices[di];
        dev.steps = dev.steps || [];
        const lowest = dev.steps.reduce((m, s) => Math.min(m, Number(s.soc) || 100), 100);
        const svcs = this._services(dev.entity.split(".")[0]);
        // Ten below the lowest, floored at 5 -- and if that % is already a step
        // (the floor usually), the next free one down, then up, so Save never
        // refuses a step the button just made with "two steps at 5%".
        const taken = dev.steps.map((s) => Number(s.soc));
        const want = dev.steps.length ? Math.max(5, lowest - 10) : 80;
        let soc = want;
        for (let n = want; taken.indexOf(soc) >= 0 && n > 1; ) soc = --n;
        for (let n = want; taken.indexOf(soc) >= 0 && n < 100; ) soc = ++n;
        dev.steps.push({ soc: taken.indexOf(soc) >= 0 ? want : soc,
          action: svcs.length ? svcs[0].action : "", data: {} });
      });
    } else if (act === "remove-step") {
      this._edit((d) => { d.devices[di].steps.splice(si, 1); });
    } else if (act === "adv") {
      this._ui.adv[di + "." + si] = !this._ui.adv[di + "." + si];
      this._render(true);
    } else if (act === "guard") {
      this._ui.guard[di] = !this._ui.guard[di];
      this._render(true);
    } else if (act === "picker") {
      this._ui.picker = !this._ui.picker;
      this._ui.query = "";
      this._render(true);
    } else if (act === "pick") {
      const entity = node.dataset.ent;
      const st = this._obj(entity);
      const name = (st && st.attributes && st.attributes.friendly_name) || entity;
      const base = entity.split(".")[1].replace(/[^a-z0-9_]/g, "_").slice(0, 24);
      this._ui.picker = false;
      this._edit((d) => {
        let id = base;
        let n = 2;
        while (d.devices.some((x) => x.id === id)) id = base + "_" + n++;
        d.devices.push({ id, name, entity, enabled: true, steps: [] });
      });
    } else if (act === "hold" || act === "release") {
      const script = act === "hold" ? this._config.hold_script : this._config.release_script;
      this._hass.callService("script", script, { id: node.dataset.id });
    } else if (act === "save") {
      this._save();
    } else if (act === "discard") {
      SHARED.set(null);
    } else if (act === "export") {
      this._ui.exportOpen = !this._ui.exportOpen;
      this._render(true);
    } else if (act === "copy") {
      const txt = JSON.stringify(this._stored(), null, 2);
      if (navigator.clipboard) navigator.clipboard.writeText(txt).catch(() => {});
    } else if (act === "download") {
      const blob = new Blob([JSON.stringify(this._stored(), null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "load-shedding.json";
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } else if (act === "import") {
      try {
        const parsed = JSON.parse(this._ui.importText);
        if (!parsed || !Array.isArray(parsed.devices)) throw new Error("no devices list");
        this._ui.importText = "";
        // Export writes warn_margin, so Import keeps it -- read the way the
        // stored rules and the settings field read it, 1 when it is not a number.
        const margin = parsed.warn_margin === null || parsed.warn_margin === ""
          ? NaN : Number(parsed.warn_margin);
        SHARED.set({ override_step: Number(parsed.override_step) || 10,
          warn_margin: Number.isFinite(margin) ? margin : 1, devices: parsed.devices });
      } catch (e) {
        SHARED.error = "Import: that is not a rules JSON (" + e.message + ").";
        SHARED.notify();
      }
    }
  }

  _onInput(ev) {
    const el = ev.target;
    if (!el || !el.dataset) return;
    if (el.dataset.kind === "query") {
      this._ui.query = el.value;
      this._renderPickerList();
    } else if (el.dataset.kind === "import") {
      this._ui.importText = el.value;
    }
  }

  _onChange(ev) {
    const el = ev.target;
    if (!el || !el.dataset || !el.dataset.kind) return;
    const kind = el.dataset.kind;
    if (["query", "import"].indexOf(kind) >= 0) return;
    const di = el.dataset.dev !== undefined ? Number(el.dataset.dev) : null;
    const si = el.dataset.step !== undefined ? Number(el.dataset.step) : null;
    this._edit((d) => {
      const dev = di !== null ? d.devices[di] : null;
      const step = dev && si !== null ? dev.steps[si] : null;
      if (kind === "name") dev.name = el.value.trim() || dev.entity;
      else if (kind === "soc") step.soc = el.value === "" ? null : Number(el.value);
      else if (kind === "action") { step.action = el.value; step.data = {}; }
      else if (kind === "field") {
        const key = el.dataset.field;
        const v = this._parseField(el);
        if (key === "__all") {
          // An action HA no longer lists: its data is edited as one object.
          step.data = v && typeof v === "object" && !Array.isArray(v) ? v : {};
        } else {
          step.data = step.data || {};
          if (v === undefined) delete step.data[key];
          else step.data[key] = v;
        }
      } else if (kind === "guard") {
        dev.guard = dev.guard || {};
        if (el.value.trim()) dev.guard[el.dataset.field] = el.value.trim();
        else delete dev.guard[el.dataset.field];
        if (!Object.keys(dev.guard).length) delete dev.guard;
      } else if (kind === "ostep") d.override_step = Number(el.value) || 10;
      else if (kind === "margin") d.warn_margin = Number.isFinite(Number(el.value)) ? Number(el.value) : 1;
    });
  }

  _parseField(el) {
    const t = el.dataset.type;
    if (t === "boolean") return el.checked;
    const raw = el.value;
    if (raw === "") return undefined;
    if (t === "number") return Number.isFinite(Number(raw)) ? Number(raw) : undefined;
    if (t === "rgb") {
      const p = raw.split(",").map((x) => Number(x.trim()));
      return p.length === 3 && p.every(Number.isFinite) ? p : undefined;
    }
    if (t === "json") {
      try { return JSON.parse(raw); } catch (e) { return raw; }
    }
    return raw;
  }

  async _save() {
    if (!SHARED.draft || SHARED.saving) return;
    const problems = this._problems(SHARED.draft);
    if (problems.length) {
      SHARED.error = problems.join("; ");
      SHARED.notify();
      return;
    }
    SHARED.saving = true;
    SHARED.notify();
    try {
      // The script answers {ok, errors}; a refusal is not an exception.
      const res = await this._hass.callService("script", this._config.save_script,
        { config: SHARED.draft }, undefined, false, true);
      const answer = (res && res.response) || {};
      SHARED.saving = false;
      if (answer.ok === false) {
        SHARED.error = "Not saved: " + (answer.errors || []).join("; ");
        SHARED.notify();
      } else {
        SHARED.set(null);
      }
    } catch (e) {
      SHARED.saving = false;
      SHARED.error = "Not saved: " + ((e && e.message) || e);
      SHARED.notify();
    }
  }

  /** The same checks the script makes, so most mistakes never leave the page. */
  _problems(rules) {
    const out = [];
    rules.devices.forEach((d) => {
      const seen = [];
      (d.steps || []).forEach((s, i) => {
        const soc = Number(s.soc);
        if (s.soc === null || s.soc === "" || !Number.isFinite(soc) || soc < 1 || soc > 100) {
          out.push(d.name + ": step " + (i + 1) + " needs a battery % of 1-100");
        } else if (seen.indexOf(soc) >= 0) out.push(d.name + ": two steps at " + soc + "%");
        else seen.push(soc);
        if (!s.action) out.push(d.name + ": step " + (i + 1) + " needs an action");
      });
    });
    return out;
  }

  // --- rendering ---------------------------------------------------------------

  _esc(s) {
    return String(s === undefined || s === null ? "" : s).replace(/[&<>"']/g, (ch) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  }

  _hhmm(iso) {
    const t = Date.parse(iso || "");
    return Number.isFinite(t)
      ? new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
      : "";
  }

  _toggle(on, attrs, label) {
    return `<button class="sw ${on ? "on" : ""}" ${attrs} role="switch" aria-checked="${on}"
      title="${this._esc(label)}"><i></i></button>`;
  }

  _render(force) {
    if (!this._hass || !this._config) return;
    const active = this.shadowRoot.activeElement;
    if (active && /^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName)) {
      // Do not pull the field out from under a typing hand; catch up on blur.
      this._pending = true;
      return;
    }
    const print = this._fingerprint();
    if (!force && print === this._print) return;
    this._print = print;
    this._pending = false;

    const render = { hero: () => this._heroHTML(), upcoming: () => this._upcomingHTML(),
      rules: () => this._rulesHTML(), backup: () => this._backupHTML() };
    const parts = this._config.blocks.map((b) => render[b]());
    this.shadowRoot.innerHTML = `<style>${STYLE}</style><div class="wrap">${parts.join("")}</div>`;
  }

  /** Every enabled device's steps, for the bar. */
  _marks(rules, shed) {
    const out = [];
    rules.devices.forEach((d) => {
      if (d.enabled === false) return;
      (d.steps || []).forEach((s) => {
        const soc = Number(s.soc);
        if (!Number.isFinite(soc)) return;
        const rec = shed[d.id];
        out.push({ soc, name: d.name, done: !!rec && Number(rec.step_soc) <= soc });
      });
    });
    return out.sort((a, b) => b.soc - a.soc);
  }

  _heroHTML() {
    const c = this._config;
    const master = this._state(c.master) === "on";
    const gridDown = this._state(c.grid_unsafe) === "on";
    const soc = this._num(c.soc);
    const runtime = this._num(c.runtime);
    const shed = this._shed();
    const rules = this._stored();
    const count = Object.keys(shed).length;

    let accent;
    let word;
    let lede;
    if (!master) {
      accent = "var(--disabled-text-color)";
      word = "Off";
      lede = "Nothing is changed automatically. Turn it on to arm the rules.";
    } else if (gridDown) {
      accent = RED;
      word = "Armed";
      lede = "The grid is down and the house is on battery. Devices step down as the battery passes their %.";
    } else {
      accent = GREEN;
      word = "Standing by";
      lede = "The grid is up, so nothing changes whatever the battery says. The rules apply only during an outage.";
    }

    const marks = this._marks(rules, shed).map((m, i) => `
      <div class="mark ${m.done ? "done" : ""} ${i % 2 ? "alt" : ""}" style="left:${m.soc}%">
        <span>${this._esc(m.name)} · ${Math.round(m.soc)}%</span></div>`).join("");

    return `
      <ha-card class="hero" style="--accent:${accent}">
        <div class="pad hero-pad">
          <div class="hero-left">
            <div class="eyebrow">
              <span class="dot"></span>
              <span class="lbl">Load shedding</span>
            </div>
            <h1>${word}</h1>
            <p class="lede">${lede}</p>
            <div class="arm">
              ${this._toggle(master, 'data-act="master"', "Load shedding")}
              <span>${master ? "Rules armed" : "Rules off"}</span>
            </div>
          </div>
          <div class="tiles">
            <div class="tile"><span class="k">Battery</span>
              <span class="v">${soc === null ? "—" : Math.round(soc) + "%"}</span></div>
            <div class="tile"><span class="k">Grid</span>
              <span class="v" style="color:${gridDown ? RED : GREEN}">${gridDown ? "down" : "up"}</span></div>
            <div class="tile"><span class="k">Runtime left</span>
              <span class="v ${runtime === null ? "dim" : ""}">${runtime === null ? "—" : runtime.toFixed(1) + " h"}</span>
              <span class="s">at the current draw</span></div>
            <div class="tile"><span class="k">Stepped down</span>
              <span class="v" style="color:${count ? AMBER : "inherit"}">${count} / ${rules.devices.length}</span>
              <span class="s">devices</span></div>
          </div>
        </div>
        <div class="pad barpad">
          <div class="bar">
            <div class="fill" style="width:${soc === null ? 0 : Math.max(0, Math.min(100, soc))}%"></div>
            ${marks}
          </div>
          <div class="scale"><span>0%</span><span>battery</span><span>100%</span></div>
        </div>
      </ha-card>`;
  }

  /**
   * Where each device fires next, worked out the way the package does: a hold
   * waits for override_step below where it was placed, otherwise the highest
   * step below the battery that is deeper than the step already applied.
   */
  _upcoming() {
    const rules = this._stored();
    const shed = this._shed();
    const soc = this._num(this._config.soc);
    const rows = [];
    rules.devices.forEach((d) => {
      if (d.enabled === false || !(d.steps || []).length) return;
      const rec = shed[d.id];
      const held = !!rec && rec.override_soc !== null && rec.override_soc !== undefined;
      const applied = !!rec && !held && rec.step_soc !== null && rec.step_soc !== undefined;
      const steps = d.steps.filter((s) => Number.isFinite(Number(s.soc)));
      let next = null;
      if (held) {
        const at = Number(rec.override_soc) - rules.override_step;
        const reached = steps.filter((s) => Number(s.soc) >= at).sort((a, b) => a.soc - b.soc)[0];
        next = { at, step: reached || null };
      } else {
        const below = steps.filter((s) => soc === null || Number(s.soc) < soc)
          .filter((s) => !applied || Number(s.soc) < Number(rec.step_soc))
          .sort((a, b) => b.soc - a.soc)[0];
        if (below) next = { at: Number(below.soc), step: below };
      }
      const g = d.guard || {};
      const st = this._obj(d.entity);
      const on = (st && ["off", "unavailable", "unknown"].indexOf(st.state) < 0)
        || (!!g.running && this._state(g.running) === "on");
      const away = next && soc !== null ? soc - next.at : null;
      rows.push({ d, rec, held, applied, next, on, away,
        soon: on && away !== null && away > 0 && away <= rules.warn_margin });
    });
    // Closest first; devices with nothing left last.
    return rows.sort((a, b) => (a.away === null ? 1e9 : a.away) - (b.away === null ? 1e9 : b.away));
  }

  _stepLabel(d, step) {
    if (!step) return "deepest step reached";
    const domain = d.entity.split(".")[0];
    const svc = String(step.action || "").split(".")[1] || "";
    const name = step.action === "climate.adjust_temperature" ? ADJUST.name : this._svcName(domain, svc);
    const data = step.data || {};
    const bits = Object.entries(data).map(([k, v]) => k.replace(/_/g, " ") + " " + v);
    return name + (bits.length ? " (" + bits.join(", ") + ")" : "");
  }

  _upcomingHTML() {
    const outage = this._state(this._config.grid_unsafe) === "on";
    const armed = this._state(this._config.master) === "on";
    const margin = this._stored().warn_margin;
    const rows = this._upcoming();
    const body = rows.map((r) => {
      let state;
      let btn = "";
      if (r.held) {
        state = `<span class="st warn">kept on by you</span>`;
        btn = `<button class="btn small" data-act="release" data-id="${this._esc(r.d.id)}">Release</button>`;
      } else if (r.applied) {
        state = `<span class="st bad">stepped down at ${Math.round(r.rec.step_soc)}%</span>`;
        btn = `<button class="btn small" data-act="hold" data-id="${this._esc(r.d.id)}"
          ${outage ? "" : "disabled"}>Put back</button>`;
      } else {
        state = r.on ? (r.soon ? `<span class="st warn">about to step down</span>` : `<span class="st">on</span>`)
          : `<span class="st dim">off — left alone</span>`;
        btn = `<button class="btn small" data-act="hold" data-id="${this._esc(r.d.id)}"
          ${outage && r.on && r.next ? "" : "disabled"}>Keep on</button>`;
      }
      const at = r.next ? Math.round(r.next.at) + "%" : "—";
      const away = r.away === null ? "—" : r.away > 0 ? Math.round(r.away * 10) / 10 + "%" : "now";
      return `<tr class="${r.soon && !r.held ? "soon" : ""}">
        <td><span class="name" data-act="more" data-ent="${r.d.entity}">${this._esc(r.d.name)}</span></td>
        <td>${r.next ? this._esc(this._stepLabel(r.d, r.next.step)) : `<span class="st dim">nothing left</span>`}</td>
        <td class="mono">${at}</td>
        <td class="mono">${away}</td>
        <td>${state}</td>
        <td class="act">${btn}</td></tr>`;
    }).join("");
    const note = !armed ? "The rules are off, so nothing will step down."
      : outage ? "Highlighted rows are within " + margin + "% of their next step; the phones get one warning with a Keep it on button."
        : "The grid is up, so nothing will step down. Keep on and Put back work during an outage.";
    return `
      <ha-card>
        <div class="pad">
          <div class="head"><h2>Coming up</h2><span class="stamp">closest first</span></div>
          <p class="blurb">${this._esc(note)}</p>
          ${rows.length ? `
          <div class="tablewrap"><table>
            <thead><tr><th>Device</th><th>Next step</th><th>At</th><th>In</th><th>Now</th><th></th></tr></thead>
            <tbody>${body}</tbody>
          </table></div>` : `<p class="empty">No device has steps yet.</p>`}
        </div>
      </ha-card>`;
  }

  _status(d) {
    const rec = this._shed()[d.id];
    const st = this._obj(d.entity);
    if (!st) return { cls: "bad", text: "entity not found" };
    if (rec) {
      if (rec.override_soc !== null && rec.override_soc !== undefined) {
        const step = Number(this._stored().override_step) || 10;
        return { cls: "warn", text: "changed back by you · steps down again at "
          + Math.round(rec.override_soc - step) + " %" };
      }
      return { cls: "bad", text: "at its " + Math.round(rec.step_soc) + " % step since "
        + this._hhmm(rec.since) + " (battery " + rec.soc + " %)" + (rec.plug_cut ? " · plug cut" : "")
        + " · back when the grid returns" };
    }
    const a = st.attributes || {};
    let now = st.state;
    if (a.temperature !== undefined && a.temperature !== null && st.state !== "off") now += " · " + a.temperature + "°";
    if (a.brightness !== undefined && a.brightness !== null) now += " · " + Math.round(a.brightness / 2.55) + " %";
    if (a.percentage !== undefined && a.percentage !== null) now += " · " + a.percentage + " %";
    if (d.enabled === false) return { cls: "dim", text: now + " · disabled" };
    if (!(d.steps || []).length) return { cls: "dim", text: now + " · no steps yet" };
    return { cls: "", text: now };
  }

  _rulesHTML() {
    const rules = this._rules();
    const dirty = this._dirty();
    const problems = SHARED.draft ? this._problems(SHARED.draft) : [];
    // Devices in the order they go: highest first step first.
    const order = rules.devices.map((d, i) => ({ d, i,
      top: (d.steps || []).reduce((m, s) => Math.max(m, Number(s.soc) || 0), 0) }))
      .sort((a, b) => b.top - a.top);
    const devs = order.map(({ d, i }, n) => this._deviceHTML(d, i, n)).join("");
    let bar = "";
    if (dirty || SHARED.error) {
      const msg = SHARED.error || (problems.length ? problems.join("; ") : "Unsaved changes");
      bar = `<div class="savebar ${SHARED.error || problems.length ? "err" : ""}">
        <span>${this._esc(msg)}</span>
        ${dirty ? `<button class="btn" data-act="discard">Discard</button>
          <button class="btn primary" data-act="save" ${problems.length || SHARED.saving ? "disabled" : ""}>
            ${SHARED.saving ? "Saving…" : "Save"}</button>`
          : `<button class="btn" data-act="discard">Dismiss</button>`}
      </div>`;
    }

    return `
      <ha-card>
        <div class="pad">
          <div class="head"><h2>Rules</h2><span class="stamp">the device with the highest first step goes first</span></div>
          <p class="blurb">Each device steps down as the battery drains: at each step it is set to what that
            step says, and the deepest step reached wins. A device that is off is left alone. When the grid
            has been back for five minutes, everything is put back the way it was.</p>
          ${bar}
          ${devs || `<p class="empty">No devices yet. Add one below.</p>`}
          <div class="addrow">
            <button class="btn" data-act="picker">${this._ui.picker ? "Close" : "+ Add device"}</button>
          </div>
          ${this._ui.picker ? `
          <div class="picker">
            <input class="txt" data-kind="query" placeholder="Search devices — name or entity id"
                   value="${this._esc(this._ui.query)}">
            <div class="plist">${this._pickerList()}</div>
          </div>` : ""}
        </div>
      </ha-card>`;
  }

  _pickerList() {
    const q = (this._ui.query || "").toLowerCase();
    const taken = this._rules().devices.map((d) => d.entity);
    const rows = Object.values(this._hass.states)
      .filter((s) => NOT_DEVICES.indexOf(s.entity_id.split(".")[0]) < 0 && taken.indexOf(s.entity_id) < 0)
      .filter((s) => !q || s.entity_id.toLowerCase().indexOf(q) >= 0
        || String((s.attributes || {}).friendly_name || "").toLowerCase().indexOf(q) >= 0)
      .sort((a, b) => a.entity_id.localeCompare(b.entity_id))
      .slice(0, 40);
    if (!rows.length) return `<p class="empty">Nothing matches.</p>`;
    return rows.map((s) => {
      const domain = s.entity_id.split(".")[0];
      return `<button class="pick" data-act="pick" data-ent="${s.entity_id}">
        <ha-icon icon="${(s.attributes || {}).icon || ICONS[domain] || "mdi:power-plug"}"></ha-icon>
        <span class="pn">${this._esc((s.attributes || {}).friendly_name || s.entity_id)}</span>
        <code>${s.entity_id}</code><span class="ps">${this._esc(s.state)}</span></button>`;
    }).join("");
  }

  _renderPickerList() {
    const box = this.shadowRoot.querySelector(".plist");
    if (box) box.innerHTML = this._pickerList();
  }

  _deviceHTML(d, i, n) {
    const domain = d.entity.split(".")[0];
    const st = this._obj(d.entity);
    const status = this._status(d);
    const enabled = d.enabled !== false;
    const steps = (d.steps || []).map((s, si) => ({ s, si }))
      .sort((a, b) => (Number(b.s.soc) || 0) - (Number(a.s.soc) || 0));
    const g = d.guard || {};
    const guardOpen = this._ui.guard[i] !== undefined ? this._ui.guard[i] : Object.keys(g).length > 0;

    return `
      <div class="dev ${enabled ? "" : "off"}">
        <div class="devhead">
          <span class="n">${n + 1}</span>
          <ha-icon icon="${(st && st.attributes && st.attributes.icon) || ICONS[domain] || "mdi:power-plug"}"></ha-icon>
          <div class="who">
            <input class="txt name" data-kind="name" data-dev="${i}" value="${this._esc(d.name)}" aria-label="Name">
            <span class="sub"><code data-act="more" data-ent="${d.entity}">${d.entity}</code>
              <span class="st ${status.cls}">${this._esc(status.text)}</span></span>
          </div>
          ${this._toggle(enabled, `data-act="enable" data-dev="${i}"`, "Use this device")}
          <button class="icon" data-act="remove-dev" data-dev="${i}" title="Remove device">✕</button>
        </div>
        <div class="steps">
          ${steps.map(({ s, si }) => this._stepHTML(d, i, s, si)).join("")}
          <button class="btn small" data-act="add-step" data-dev="${i}">+ Add step</button>
        </div>
        <div class="guard">
          <button class="link" data-act="guard" data-dev="${i}">${guardOpen ? "▾" : "▸"} Make sure it is really off${
            Object.keys(g).length ? " · on" : ""}</button>
          ${guardOpen ? `
          <p class="blurb">For a device whose "off" might not arrive (an infrared A/C). After a step that turns it
            off, if <b>running</b> still says on 90 s later, or <b>online</b> says the bridge is down, the <b>plug</b> is cut.
            The plug comes back on first when the grid returns.</p>
          <div class="gfields">
            ${this._guardInput(i, "plug", g.plug, "switch", "Plug (switch)")}
            ${this._guardInput(i, "running", g.running, "binary_sensor", "Running (binary sensor)")}
            ${this._guardInput(i, "online", g.online, "binary_sensor", "Online (binary sensor)")}
          </div>` : ""}
        </div>
      </div>`;
  }

  _guardInput(i, field, value, domain, label) {
    return `<label class="gf"><span class="cap">${label}</span>
      <input class="txt" list="ents-${domain}" data-kind="guard" data-dev="${i}" data-field="${field}"
             value="${this._esc(value || "")}" placeholder="${domain}.…">
      ${this._datalist(domain)}</label>`;
  }

  _datalist(domain) {
    const ids = Object.keys(this._hass.states).filter((e) => e.startsWith(domain + ".")).sort();
    return `<datalist id="ents-${domain}">${ids.map((e) => `<option value="${e}">`).join("")}</datalist>`;
  }

  _stepHTML(d, i, s, si) {
    const domain = d.entity.split(".")[0];
    const svcs = this._services(domain);
    const cur = svcs.find((x) => x.action === s.action);
    const options = svcs.map((x) => `<option value="${x.action}" ${x.action === s.action ? "selected" : ""}>
      ${this._esc(x.name)}</option>`).join("")
      + (!cur && s.action ? `<option value="${this._esc(s.action)}" selected>${this._esc(s.action)}</option>` : "");
    const soc = Number(s.soc);
    const showAdv = !!this._ui.adv[i + "." + si];
    const data = s.data || {};
    let fieldsHTML = "";
    let hasAdv = false;
    if (cur) {
      const svc = s.action.split(".")[1];
      const fields = this._fields(cur.def).filter((f) => this._supports(d.entity, f.f));
      hasAdv = fields.some((f) => f.adv && data[f.key] === undefined);
      fieldsHTML = fields.filter((f) => !f.adv || showAdv || data[f.key] !== undefined)
        .map((f) => this._fieldHTML(d, i, si, svc, f, data[f.key])).join("");
    } else if (s.action) {
      fieldsHTML = `<label class="fld"><span class="cap">data (JSON)</span>
        <input class="txt mono" data-kind="field" data-type="json" data-dev="${i}" data-step="${si}"
               data-field="__all" value="${this._esc(JSON.stringify(data))}"></label>`;
    }
    let more = "";
    if (hasAdv && !showAdv) more = `<button class="link" data-act="adv" data-dev="${i}" data-step="${si}">more fields</button>`;
    else if (showAdv) more = `<button class="link" data-act="adv" data-dev="${i}" data-step="${si}">fewer fields</button>`;
    return `
      <div class="step">
        <span class="at">at</span>
        <input class="num soc" type="number" min="1" max="100" step="1" data-kind="soc"
               data-dev="${i}" data-step="${si}" value="${Number.isFinite(soc) && s.soc !== null ? soc : ""}"><span class="u">%</span>
        <span class="arrow">→</span>
        <select class="sel" data-kind="action" data-dev="${i}" data-step="${si}">${options}</select>
        <span class="flds">${fieldsHTML}</span>
        ${more}
        <button class="icon" data-act="remove-step" data-dev="${i}" data-step="${si}" title="Remove step">✕</button>
      </div>`;
  }

  /** One service field, as the input its selector asks for. */
  _fieldHTML(d, i, si, svc, fld, value) {
    const domain = d.entity.split(".")[0];
    const key = fld.key;
    const sel = fld.f.selector || {};
    const type = Object.keys(sel)[0] || "text";
    const cfg = sel[type] || {};
    const label = this._fieldName(domain, svc, key) + (fld.f.required ? " *" : "");
    const base = `data-kind="field" data-dev="${i}" data-step="${si}" data-field="${key}"`;
    const st = this._obj(d.entity);
    const a = (st && st.attributes) || {};
    let input;

    // A `state` selector means "one of this entity's values": hvac_modes for a
    // climate's hvac_mode, fan_modes for its fan_mode, and so on.
    let options = null;
    if (type === "select") {
      options = (cfg.options || []).map((o) => (typeof o === "object" ? o : { value: o, label: o }));
    } else if (type === "state") {
      // HA names the lists two ways: fan_modes / hvac_modes, effect_list / source_list.
      const base = cfg.attribute || ((domain === "climate" && key === "hvac_mode") ? "hvac_mode" : key);
      const list = [base + "s", base + "_list"].map((k) => a[k]).find(Array.isArray);
      if (list) options = list.map((o) => ({ value: o, label: String(o).replace(/_/g, " ") }));
    }

    if (options) {
      input = `<select class="sel" ${base} data-type="text">
        <option value="" ${value === undefined ? "selected" : ""}>—</option>
        ${options.map((o) => `<option value="${this._esc(o.value)}" ${String(o.value) === String(value) ? "selected" : ""}>
          ${this._esc(o.label)}</option>`).join("")}</select>`;
    } else if (type === "number" || type === "color_temp") {
      const unit = cfg.unit_of_measurement || (type === "color_temp" ? "K" : "");
      input = `<input class="num" type="number" ${base} data-type="number"
        ${cfg.min !== undefined ? `min="${cfg.min}"` : ""} ${cfg.max !== undefined ? `max="${cfg.max}"` : ""}
        step="${cfg.step || "any"}" value="${value === undefined ? "" : this._esc(value)}">${
        unit ? `<span class="u">${this._esc(unit)}</span>` : ""}`;
    } else if (type === "boolean") {
      input = `<input type="checkbox" ${base} data-type="boolean" ${value ? "checked" : ""}>`;
    } else if (type === "color_rgb") {
      input = `<input class="txt" ${base} data-type="rgb" placeholder="255, 120, 0"
        value="${Array.isArray(value) ? value.join(", ") : ""}">`;
    } else if (TEXT_TYPES.indexOf(type) >= 0 || type === "state") {
      input = `<input class="txt" ${base} data-type="text" value="${value === undefined ? "" : this._esc(value)}">`;
    } else {
      input = `<input class="txt mono" ${base} data-type="json" placeholder="JSON"
        value="${value === undefined ? "" : this._esc(JSON.stringify(value))}">`;
    }
    return `<label class="fld"><span class="cap">${this._esc(label)}</span><span class="in">${input}</span></label>`;
  }

  _backupHTML() {
    const rules = this._rules();
    const json = JSON.stringify(this._stored(), null, 2);
    return `
      <ha-card>
        <div class="pad">
          <div class="head"><h2>Settings and backup</h2></div>
          <div class="kvrow">
            <div>
              <span class="name">Override step</span>
              <p class="blurb">Change a stepped-down device back yourself and it stays that way until the battery has
                fallen this much further. Then the deepest step reached is applied again.</p>
            </div>
            <span class="in"><input class="num" type="number" min="1" max="50" step="1" data-kind="ostep"
              value="${this._esc(rules.override_step)}"><span class="u">%</span></span>
          </div>
          <div class="kvrow">
            <div>
              <span class="name">Warn before a step</span>
              <p class="blurb">How close to a step the phones are warned, with a Keep it on button. 1% means a step at
                50% warns at 51%. 0 turns the warnings off.</p>
            </div>
            <span class="in"><input class="num" type="number" min="0" max="20" step="1" data-kind="margin"
              value="${this._esc(rules.warn_margin === undefined ? 1 : rules.warn_margin)}"><span class="u">%</span></span>
          </div>
          <div class="kvrow">
            <div>
              <span class="name">Export</span>
              <p class="blurb">The rules live in Home Assistant, not in git. Keep a copy.</p>
            </div>
            <span class="btns">
              <button class="btn" data-act="export">${this._ui.exportOpen ? "Hide" : "Show JSON"}</button>
              <button class="btn" data-act="copy">Copy</button>
              <button class="btn" data-act="download">Download</button>
            </span>
          </div>
          ${this._ui.exportOpen ? `<textarea class="code" readonly>${this._esc(json)}</textarea>` : ""}
          <div class="kvrow">
            <div>
              <span class="name">Import</span>
              <p class="blurb">Paste exported JSON. It opens as unsaved changes in the editor; nothing is
                replaced until you press Save.</p>
            </div>
            <span class="btns"><button class="btn" data-act="import">Load into editor</button></span>
          </div>
          <textarea class="code" data-kind="import" placeholder='{"override_step": 10, "devices": [...]}'>${
            this._esc(this._ui.importText)}</textarea>
          <p class="foot">Rules are saved through <code>script.load_shedding_save_config</code>, which checks them.
            The engine is <code>packages/load_shedding.yaml</code>; it acts only while the inverter reports the grid as
            unsafe. Card ${VERSION}.</p>
        </div>
      </ha-card>`;
  }
}

// --- styles: the Shutdowns card's, plus the editor -----------------------------
const STYLE = `
:host { display: block; }
.wrap {
  --mono: var(--code-font-family, ui-monospace, "Roboto Mono", SFMono-Regular, Consolas, monospace);
  display: flex; flex-direction: column; gap: 16px;
  font-family: var(--paper-font-body1_-_font-family, Roboto, system-ui, sans-serif);
  font-size: 14px; line-height: 1.45; color: var(--primary-text-color);
  -webkit-font-smoothing: antialiased;
}
.pad { padding: 20px 22px; display: flex; flex-direction: column; gap: 14px; }
h1 { margin: 0; font-size: 34px; font-weight: 300; line-height: 1.15; }
h2 { margin: 0; font-size: 17px; font-weight: 500; }
p { margin: 0; }
code { font-family: var(--mono); font-size: 12px; }
b { font-weight: 500; }

.hero { border-left: 4px solid var(--accent); }
.hero-pad { padding: 24px 28px 8px; flex-direction: row; flex-wrap: wrap; gap: 32px; align-items: center; }
.hero-left { flex: 1 1 380px; min-width: 240px; display: flex; flex-direction: column; gap: 10px; }
.eyebrow { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.eyebrow .lbl, .tile .k, .scale, .cap {
  font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--secondary-text-color);
}
.eyebrow .lbl { font-size: 12px; letter-spacing: .12em; }
.dot { width: 10px; height: 10px; border-radius: 50%; flex: 0 0 auto; background: var(--accent);
  animation: lspulse 2.4s ease-in-out infinite; }
@keyframes lspulse { 0%, 100% { opacity: 1 } 50% { opacity: .35 } }
@media (prefers-reduced-motion: reduce) { .dot { animation: none } }
.hero h1 { color: var(--accent); }
.lede { font-size: 16px; opacity: .82; max-width: 46ch; text-wrap: pretty; }
.arm { display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--secondary-text-color); }
.tiles { flex: 1 1 420px; display: flex; flex-wrap: wrap; gap: 12px; }
.tile { flex: 1 1 130px; background: var(--secondary-background-color, rgba(127,127,127,.12));
  border-radius: 10px; padding: 14px 16px; display: flex; flex-direction: column; gap: 4px; }
.tile .v { font-size: 22px; font-weight: 400; font-family: var(--mono); }
.tile .v.dim { color: var(--disabled-text-color); }
.tile .s { font-size: 12px; color: var(--secondary-text-color); }

.barpad { padding: 8px 28px 20px; gap: 6px; }
.bar { position: relative; height: 12px; border-radius: 6px; margin-top: 40px;
  background: rgba(127,127,127,.16); }
.fill { position: absolute; inset: 0 auto 0 0; border-radius: 6px; background: var(--success-color, #43a047); opacity: .55; }
.mark { position: absolute; top: -5px; bottom: -5px; width: 2px; margin-left: -1px; background: ${AMBER}; }
.mark.done { background: ${RED}; }
.mark span { position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%); margin-bottom: 4px;
  font-family: var(--mono); font-size: 10px; white-space: nowrap; color: var(--secondary-text-color); }
.mark.alt span { margin-bottom: 18px; }
.scale { display: flex; justify-content: space-between; }

.head { display: flex; flex-wrap: wrap; gap: 12px; align-items: baseline; }
.head h2 { flex: 1 1 auto; }
.stamp { font-size: 12px; color: var(--secondary-text-color); }
.blurb { font-size: 13px; color: var(--secondary-text-color); max-width: 70ch; text-wrap: pretty; }
.empty { font-size: 13px; color: var(--disabled-text-color); }
.foot { border-top: 1px solid var(--divider-color); padding-top: 12px;
  font-size: 12px; color: var(--secondary-text-color); line-height: 1.6; }

.savebar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 10px 14px;
  border-radius: 10px; background: rgba(3,169,244,.10); border: 1px solid rgba(3,169,244,.35); font-size: 13px; }
.savebar span { flex: 1 1 auto; }
.savebar.err { background: rgba(219,68,55,.10); border-color: rgba(219,68,55,.45); }

.dev { border: 1px solid var(--divider-color); border-radius: 12px; padding: 14px 16px;
  display: flex; flex-direction: column; gap: 10px; }
.dev.off { opacity: .6; }
.devhead { display: flex; align-items: center; gap: 12px; }
.devhead .n { font-family: var(--mono); color: var(--secondary-text-color); width: 1.2em; text-align: right; }
.devhead ha-icon { --mdc-icon-size: 22px; color: var(--secondary-text-color); }
.who { flex: 1 1 auto; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.sub { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: baseline; font-size: 12px; }
.sub code { color: var(--secondary-text-color); cursor: pointer; }
.st { color: var(--primary-text-color); }
.st.dim { color: var(--secondary-text-color); }
.st.bad { color: ${RED}; }
.st.warn { color: ${AMBER}; }

.steps { display: flex; flex-direction: column; gap: 8px; padding-left: 34px; }
.step { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; padding: 8px 10px;
  border-radius: 10px; background: var(--secondary-background-color, rgba(127,127,127,.08)); }
.at, .arrow, .u { color: var(--secondary-text-color); font-size: 13px; }
.flds { display: contents; }
.fld { display: inline-flex; flex-direction: column; gap: 2px; }
.fld .in { display: inline-flex; align-items: center; gap: 4px; }
.guard { padding-left: 34px; display: flex; flex-direction: column; gap: 8px; }
.gfields { display: flex; flex-wrap: wrap; gap: 10px; }
.gf { display: inline-flex; flex-direction: column; gap: 2px; min-width: 220px; }

.txt, .num, .sel, .code {
  font: inherit; font-size: 13px; color: var(--primary-text-color);
  background: var(--card-background-color, transparent); border: 1px solid var(--divider-color);
  border-radius: 8px; padding: 6px 8px; box-sizing: border-box;
}
.txt.name { font-size: 15px; border-color: transparent; padding: 2px 6px; margin-left: -6px; background: transparent; }
.txt.name:hover, .txt.name:focus { border-color: var(--divider-color); }
.txt.mono, .code { font-family: var(--mono); font-size: 12px; }
.num { width: 5.5em; font-family: var(--mono); }
.num.soc { width: 4.2em; }
.sel { max-width: 16em; }
.code { width: 100%; min-height: 120px; resize: vertical; }
.txt:focus, .num:focus, .sel:focus, .code:focus { outline: 2px solid var(--primary-color, #03a9f4); outline-offset: -1px; }

.btn { font: inherit; font-size: 13px; padding: 6px 14px; border-radius: 8px; cursor: pointer;
  border: 1px solid var(--divider-color); background: transparent; color: var(--primary-text-color); }
.btn:hover { background: rgba(127,127,127,.12); }
.btn.primary { background: var(--primary-color, #03a9f4); border-color: transparent; color: var(--text-primary-color, #fff); }
.btn[disabled] { opacity: .5; cursor: default; }
.btn.small { align-self: flex-start; padding: 4px 10px; font-size: 12px; }
.btns { display: inline-flex; gap: 8px; flex-wrap: wrap; }
.icon { border: 0; background: transparent; color: var(--secondary-text-color); cursor: pointer;
  font-size: 14px; width: 28px; height: 28px; border-radius: 8px; }
.icon:hover { background: rgba(127,127,127,.14); color: var(--primary-text-color); }
.link { border: 0; background: transparent; color: var(--primary-color, #03a9f4); cursor: pointer;
  font: inherit; font-size: 12px; padding: 0; align-self: flex-start; }
.addrow { display: flex; }
.picker { display: flex; flex-direction: column; gap: 8px; }
.plist { display: flex; flex-direction: column; max-height: 320px; overflow-y: auto;
  border: 1px solid var(--divider-color); border-radius: 10px; }
.pick { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border: 0; background: transparent;
  color: var(--primary-text-color); text-align: left; cursor: pointer; font: inherit; font-size: 13px;
  border-bottom: 1px solid var(--divider-color); }
.pick:last-child { border-bottom: 0; }
.pick:hover { background: rgba(127,127,127,.10); }
.pick ha-icon { --mdc-icon-size: 18px; color: var(--secondary-text-color); }
.pick .pn { flex: 1 1 auto; }
.pick code, .pick .ps { color: var(--secondary-text-color); }
.tablewrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th { text-align: left; font-weight: 400; font-size: 11px; letter-spacing: .08em; text-transform: uppercase;
  color: var(--secondary-text-color); padding: 6px 10px; border-bottom: 1px solid var(--divider-color); }
td { padding: 9px 10px; border-bottom: 1px solid var(--divider-color); vertical-align: middle; }
tr:last-child td { border-bottom: 0; }
td.mono { font-family: var(--mono); white-space: nowrap; }
td.act { text-align: right; white-space: nowrap; }
td .name { cursor: pointer; }
td .name:hover { text-decoration: underline; text-underline-offset: 3px; }
tr.soon td { background: rgba(255,166,0,.10); }
tr.soon td:first-child { box-shadow: inset 3px 0 0 ${AMBER}; }
.kvrow { display: flex; align-items: center; gap: 16px; justify-content: space-between; flex-wrap: wrap;
  border-top: 1px solid var(--divider-color); padding-top: 12px; }
.kvrow .name { font-size: 15px; }
.kvrow .in { display: inline-flex; align-items: center; gap: 4px; }

.sw { position: relative; flex: none; width: 40px; height: 22px; border-radius: 11px; border: 0;
  background: var(--disabled-text-color); opacity: .6; cursor: pointer; padding: 0; }
.sw i { position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%;
  background: #fff; transition: left .15s; }
.sw.on { background: var(--primary-color, #03a9f4); opacity: 1; }
.sw.on i { left: 21px; }

@media (max-width: 560px) {
  .steps, .guard { padding-left: 0; }
  .hero-pad, .barpad { padding-left: 18px; padding-right: 18px; }
}
`;

if (!customElements.get(CARD)) customElements.define(CARD, LoadSheddingCard);

window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === CARD)) {
  window.customCards.push({
    type: CARD,
    name: "Load shedding",
    description: "Build the rules that step devices down as the battery drains during an outage.",
    preview: false,
  });
}

console.info("%c " + CARD + " %c " + VERSION + " ",
             "background:#cf3c33;color:#fff;border-radius:3px 0 0 3px",
             "background:#333;color:#fff;border-radius:0 3px 3px 0");
