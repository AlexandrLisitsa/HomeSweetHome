"""A small Home Assistant automation simulator, for tests on the host.

    from ha_automation_sim import House, Simulator, load_package, ...

Runs the real automations out of a package (or automations.yaml) against a
fake house: a dict of entity states and attributes and a clock. It exists so a
test can say "this is the house, this changed, what did the automation do?"
without a Home Assistant instance. Used by test_adaptive_charge.py,
test_outage_precharge.py, test_battery_runtime.py and test_tariff_switch.py.

    house = House(now=datetime(2026, 11, 2, 23, 0, tzinfo=KYIV))
    house.set("sensor.adaptive_charge_plan", "charging", current=30)
    sim = Simulator(house, load_package(PKG)["automation"])
    runs = sim.fire(house.change("sensor.adaptive_charge_plan", "full", current=2))
    runs[0].calls      # [Call('select.select_option', ...)]

What it does
------------
Triggers   state (entity_id str/list, from/to/not_from/not_to incl. lists and
           `to: ~`, attribute), time_pattern (hours/minutes/seconds with
           "/n", n, "*"; smaller units default to 0 as in HA), time (`at:`
           "HH:MM[:SS]", or the int a YAML 1.1 sexagesimal turns it into),
           homeassistant start. Old (`platform:`) and new (`trigger:`) keys.
Conditions state (entity_id list = all, state list, attribute), template
           (and the bare-template shorthand), and / or / not.
           The automation's `condition:` block is evaluated when the trigger
           fires; action-step conditions when the run reaches them. With
           `sim.fire(event, run=False)` + `sim.drain()` a test can change the
           house in between, as a queued run would see it.
Actions    variables, condition (stops the run), choose (+ default),
           if/then/else, stop, service/action calls (recorded; templated
           target and data), notify.* (also recorded in `run.notifications`),
           event (recorded), repeat for_each, delay/wait_template (recorded
           and skipped -- no time passes).
Effects    input_boolean.turn_on/turn_off/toggle, input_number.set_value
           (state becomes a float string, "30.0", as HA stores it),
           select.select_option (str(option)), datetime.set_value (a naive
           value is read as local time with fold=0 and stored as a UTC ISO
           string, as HA's datetime entity does), switch.turn_on/off.
Templates  rendered in a jinja2 ImmutableSandboxedEnvironment with HA's
           globals and filters: states, is_state (value or list), state_attr,
           is_state_attr, now, utcnow, as_datetime, as_timestamp, as_local,
           timestamp_custom, timedelta, is_number (finite only, as HA), int /
           float (raise without a default, as HA), round (HA's: int at
           precision 0), min/max globals. Results are parsed back to native
           types the way HA does (ast.literal_eval, but "07" or "1_0" stay
           strings, and str results stay the raw text).

Fidelity limits -- what it does NOT model
-----------------------------------------
* Effects are applied silently: a service call that changes the house does
  not fire state events of its own. Chain them by hand with house.change().
* No real concurrency. `mode: single` takes the first trigger of an event and
  drops the rest; queued/parallel/restart enqueue every match (up to `max`)
  and run them one after the other. `restart` does not cancel anything.
* Unsupported (raise NotImplementedError rather than guess): `for:` on
  triggers and conditions, numeric_state, time/sun/zone/device conditions,
  template/event/mqtt/... triggers, repeat while/until/count, parallel,
  sequence blocks, response_variable, `enabled: false`, `continue_on_error`
  is ignored, entity-id `at:` in time triggers.
* Naive datetimes are read as Europe/Kyiv local time (the box's zone); HA
  reads them in the process's zone, which is the same there.
* `states` is only callable (`states('x.y')`), not `states.sensor.x`.
* Template sensors themselves are not run: set their state/attributes in the
  house. Render their templates with `render()`.
* Undefined variables render as empty, like HA's non-strict mode, but HA
  also logs a warning; nothing here does.
"""
import ast
import math
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import yaml
from jinja2.filters import do_int
from jinja2.sandbox import ImmutableSandboxedEnvironment

KYIV = ZoneInfo("Europe/Kyiv")
_SENTINEL = object()


# --- loading -----------------------------------------------------------------

class HaLoader(yaml.SafeLoader):
    """SafeLoader that shrugs at !secret / !include instead of dying."""


HaLoader.add_multi_constructor("!", lambda loader, suffix, node: None)


def load_package(path):
    return yaml.load(Path(path).read_text(encoding="utf-8"), Loader=HaLoader)


def find(automations, key, value):
    """The automation whose `id` (or `alias`) is `value`."""
    return next(a for a in automations if a.get(key) == value)


# --- the house -----------------------------------------------------------------

@dataclass
class State:
    entity_id: str
    state: str
    attributes: dict = field(default_factory=dict)

    @property
    def domain(self):
        return self.entity_id.split(".")[0]

    @property
    def name(self):
        return self.attributes.get("friendly_name", self.entity_id)


@dataclass
class StateChanged:
    entity_id: str
    old: State
    new: State


@dataclass
class TimeTick:
    now: datetime


@dataclass
class Started:
    pass


START = Started()


class House:
    """Entity states, attributes and a clock. Missing entities read `unknown`."""

    def __init__(self, now):
        self.now = now
        self.entities = {}

    def set(self, entity_id, state, **attrs):
        """Set a state without an event (the house as it already is)."""
        self.entities[entity_id] = State(entity_id, str(state), dict(attrs))

    def get(self, entity_id):
        return self.entities.get(entity_id)

    def state(self, entity_id):
        s = self.entities.get(entity_id)
        return s.state if s else "unknown"

    def attr(self, entity_id, name):
        s = self.entities.get(entity_id)
        return s.attributes.get(name) if s else None

    def change(self, entity_id, state=None, keep_attrs=True, **attrs):
        """Change a state (or only attributes, with state=None); return the event."""
        old = self.entities.get(entity_id)
        base = dict(old.attributes) if (old and keep_attrs) else {}
        base.update(attrs)
        new = State(entity_id, str(state) if state is not None else
                    (old.state if old else "unknown"), base)
        self.entities[entity_id] = new
        return StateChanged(entity_id, old, new)

    def tick(self, now):
        """Move the clock; return the time event for the new moment."""
        self.now = now
        return TimeTick(now)


# --- templates -----------------------------------------------------------------

def _raise_no_default(name, value):
    raise ValueError("Template error: %s got invalid input '%s' and no default"
                     % (name, value))


def is_number(value):
    try:
        f = float(value)
    except (TypeError, ValueError):
        return False
    return math.isfinite(f)


def _parse_dt(value):
    if isinstance(value, datetime):
        return value
    try:
        return datetime.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None


def as_datetime(value, default=_SENTINEL):
    if type(value) is datetime:
        return value
    try:
        return datetime.fromtimestamp(float(value), timezone.utc)
    except (TypeError, ValueError, OverflowError):
        pass
    if isinstance(value, str):
        d = _parse_dt(value)
        if d is not None:
            return d
        return None if default is _SENTINEL else default
    if default is _SENTINEL:
        _raise_no_default("as_datetime", value)
    return default


def _local(d):
    return d if d.tzinfo else d.replace(tzinfo=KYIV)


def as_timestamp(value, default=_SENTINEL):
    d = _parse_dt(value)
    if d is None:
        if default is _SENTINEL:
            _raise_no_default("as_timestamp", value)
        return default
    return _local(d).timestamp()


def as_local(value):
    return _local(value).astimezone(KYIV)


def timestamp_custom(value, fmt="%Y-%m-%d %H:%M:%S", local=True, default=_SENTINEL):
    try:
        ts = float(value)
        return datetime.fromtimestamp(ts, KYIV if local else timezone.utc).strftime(fmt)
    except (TypeError, ValueError, OverflowError):
        if default is _SENTINEL:
            _raise_no_default("timestamp_custom", value)
        return default


def ha_int(value, default=_SENTINEL, base=10):
    out = do_int(value, default=_SENTINEL, base=base)
    if out is _SENTINEL:
        if default is _SENTINEL:
            _raise_no_default("int", value)
        return default
    return out


def ha_float(value, default=_SENTINEL):
    try:
        return float(value)
    except (TypeError, ValueError):
        if default is _SENTINEL:
            _raise_no_default("float", value)
        return default


def ha_round(value, precision=0, method="common", default=_SENTINEL):
    try:
        v = float(value)
    except (TypeError, ValueError):
        if default is _SENTINEL:
            _raise_no_default("round", value)
        return default
    if method == "ceil":
        v = math.ceil(v * 10 ** precision) / 10 ** precision
    elif method == "floor":
        v = math.floor(v * 10 ** precision) / 10 ** precision
    else:
        v = round(v, precision)
    return int(v) if precision == 0 else v


def make_env(house):
    env = ImmutableSandboxedEnvironment()

    def _states(eid):
        return house.state(eid)

    def _is_state(eid, value):
        s = house.state(eid) if house.get(eid) else None
        return s in value if isinstance(value, list) else s == value

    def _is_state_attr(eid, name, value):
        return house.attr(eid, name) == value

    g = dict(states=_states, is_state=_is_state, state_attr=house.attr,
             is_state_attr=_is_state_attr, now=lambda: house.now,
             utcnow=lambda: house.now.astimezone(timezone.utc),
             as_datetime=as_datetime, as_timestamp=as_timestamp,
             as_local=as_local, timedelta=timedelta, is_number=is_number,
             int=ha_int, float=ha_float,
             min=lambda *a: min(*a), max=lambda *a: max(*a))
    env.globals.update(g)
    env.filters.update(is_number=is_number, int=ha_int, float=ha_float,
                       round=ha_round, as_datetime=as_datetime,
                       as_timestamp=as_timestamp, as_local=as_local,
                       timestamp_custom=timestamp_custom)
    env.tests["is_number"] = is_number
    # HA's regex tests: `match` anchors at the start (re.match), `search` not.
    env.tests["match"] = lambda value, pattern, ignorecase=False: bool(
        re.match(pattern, str(value), re.IGNORECASE if ignorecase else 0))
    env.tests["search"] = lambda value, pattern, ignorecase=False: bool(
        re.search(pattern, str(value), re.IGNORECASE if ignorecase else 0))
    return env


_NUMERIC = re.compile(r"^[+-]?(?!0\d)\d*(?:\.\d*)?$")


def parse_result(text):
    """HA's native-type parsing of a rendered template."""
    try:
        result = ast.literal_eval(text)
    except (ValueError, SyntaxError, TypeError, MemoryError, RecursionError):
        return text
    if isinstance(result, (str, complex)):
        return text
    if isinstance(result, (int, float)) and not isinstance(result, bool) \
            and _NUMERIC.match(text) is None:
        return text
    return result


def render(template, house, variables=None, parse=True):
    """Render one template string as HA would, native types included."""
    if not isinstance(template, str):
        return template
    out = make_env(house).from_string(template).render(**(variables or {})).strip()
    return parse_result(out) if parse else out


def render_complex(value, house, variables):
    if isinstance(value, dict):
        return {render_complex(k, house, variables): render_complex(v, house, variables)
                for k, v in value.items()}
    if isinstance(value, list):
        return [render_complex(v, house, variables) for v in value]
    return render(value, house, variables)


def as_boolean(value):
    """HA's template.result_as_boolean."""
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "on", "enable")
    return False


# --- triggers ------------------------------------------------------------------

def _as_list(x):
    return x if isinstance(x, list) else [x]


def _platform(trig):
    return trig.get("platform", trig.get("trigger"))


def _unsupported(what):
    raise NotImplementedError("ha_automation_sim does not model %s" % what)


def _pattern_match(pattern, value):
    if pattern is None or pattern == "*":
        return True
    p = str(pattern)
    if p.startswith("/"):
        return value % int(p[1:]) == 0
    return value == int(p)


def _time_at(at):
    if isinstance(at, int):              # YAML 1.1 read 23:00:00 as 82800
        return at // 3600, at // 60 % 60, at % 60
    parts = [int(p) for p in str(at).split(":")]
    if len(parts) == 2:
        parts.append(0)
    return tuple(parts)


def match_trigger(trig, event, idx):
    """The trigger variables if `trig` fires for `event`, else None."""
    if "for" in trig:
        _unsupported("`for:` on triggers")
    p = _platform(trig)
    base = {"platform": p, "id": str(trig.get("id", idx)), "idx": str(idx)}
    if p == "homeassistant":
        if isinstance(event, Started) and trig.get("event") == "start":
            return dict(base, event="start")
        return None
    if p == "time_pattern":
        if not isinstance(event, TimeTick):
            return None
        h, m, s = trig.get("hours"), trig.get("minutes"), trig.get("seconds")
        if m is None and h is not None:
            m = 0
        if s is None and m is not None:
            s = 0
        t = event.now
        if _pattern_match(h, t.hour) and _pattern_match(m, t.minute) and _pattern_match(s, t.second):
            return dict(base, now=t)
        return None
    if p == "time":
        if not isinstance(event, TimeTick):
            return None
        t = event.now
        for at in _as_list(trig["at"]):
            if isinstance(at, str) and "." in at and ":" not in at:
                _unsupported("entity-id `at:` in time triggers")
            if (t.hour, t.minute, t.second) == _time_at(at):
                return dict(base, now=t)
        return None
    if p == "state":
        if not isinstance(event, StateChanged):
            return None
        if event.entity_id not in _as_list(trig["entity_id"]):
            return None
        attribute = trig.get("attribute")
        keys = ("from", "to", "not_from", "not_to")
        match_all = all(k not in trig for k in keys)

        def value(s):
            if s is None:
                return None
            return s.state if attribute is None else s.attributes.get(attribute)

        old_v, new_v = value(event.old), value(event.new)
        if attribute is not None and old_v == new_v:
            return None

        def ok(v, want, not_want):
            if want is not None and v not in _as_list(want):
                return False
            if not_want is not None and v in _as_list(not_want):
                return False
            return True

        if not ok(old_v, trig.get("from"), trig.get("not_from")) \
                or not ok(new_v, trig.get("to"), trig.get("not_to")) \
                or (not match_all and old_v == new_v):
            return None
        if event.old is not None and event.new is not None and match_all \
                and attribute is None and event.old == event.new:
            return None
        return dict(base, entity_id=event.entity_id, from_state=event.old,
                    to_state=event.new, attribute=attribute)
    _unsupported("%r triggers" % p)


# --- conditions ----------------------------------------------------------------

def check_condition(cond, house, variables):
    if isinstance(cond, str):                    # template shorthand
        return as_boolean(render(cond, house, variables))
    if "for" in cond:
        _unsupported("`for:` on conditions")
    kind = cond.get("condition")
    if kind == "template":
        return as_boolean(render(cond["value_template"], house, variables))
    if kind == "state":
        wanted = [str(v) for v in _as_list(cond["state"])]
        attribute = cond.get("attribute")
        results = []
        for eid in _as_list(cond["entity_id"]):
            s = house.get(eid)
            if s is None:
                results.append(False)
            elif attribute is None:
                results.append(s.state in wanted)
            else:
                results.append(s.attributes.get(attribute) in _as_list(cond["state"]))
        return any(results) if cond.get("match") == "any" else all(results)
    if kind == "and":
        return all(check_condition(c, house, variables) for c in cond["conditions"])
    if kind == "or":
        return any(check_condition(c, house, variables) for c in cond["conditions"])
    if kind == "not":
        return not any(check_condition(c, house, variables) for c in cond["conditions"])
    _unsupported("%r conditions" % kind)


# --- actions -------------------------------------------------------------------

@dataclass
class Call:
    service: str
    target: dict
    data: dict

    @property
    def entity_id(self):
        e = self.target.get("entity_id")
        return e[0] if isinstance(e, list) and len(e) == 1 else e


@dataclass
class Run:
    automation: str
    trigger: dict
    calls: list = field(default_factory=list)
    events: list = field(default_factory=list)
    skipped: list = field(default_factory=list)   # delays and waits
    stopped: str = None                           # 'condition' / 'stop' / None
    variables: dict = field(default_factory=dict)

    @property
    def notifications(self):
        return [c for c in self.calls if c.service.startswith("notify.")]

    def services(self):
        return [c.service for c in self.calls]


class _Stop(Exception):
    pass


def _apply(call, house):
    eids = _as_list(call.target.get("entity_id") or call.data.get("entity_id") or [])
    svc, d = call.service, call.data
    for eid in eids:
        if svc in ("input_boolean.turn_on", "switch.turn_on"):
            house.change(eid, "on")
        elif svc in ("input_boolean.turn_off", "switch.turn_off"):
            house.change(eid, "off")
        elif svc == "input_boolean.toggle":
            house.change(eid, "off" if house.state(eid) == "on" else "on")
        elif svc == "input_number.set_value":
            house.change(eid, str(float(d["value"])))
        elif svc == "select.select_option":
            house.change(eid, str(d["option"]))
        elif svc == "datetime.set_value":
            v = d["datetime"]
            dt = v if isinstance(v, datetime) else datetime.fromisoformat(str(v))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=KYIV, fold=0)
            house.change(eid, dt.astimezone(timezone.utc).isoformat())


def _run_steps(steps, house, run):
    for step in steps or []:
        _run_step(step, house, run)


def _run_step(step, house, run):
    v = run.variables
    if "enabled" in step and step["enabled"] is False:
        _unsupported("`enabled: false`")
    if "variables" in step:
        for k, t in step["variables"].items():
            v[k] = render_complex(t, house, v)
    elif "condition" in step:
        if not check_condition(step, house, v):
            raise _Stop("condition")
    elif "choose" in step:
        for opt in step["choose"]:
            if all(check_condition(c, house, v) for c in _as_list(opt.get("conditions", []))):
                _run_steps(opt.get("sequence"), house, run)
                return
        _run_steps(step.get("default"), house, run)
    elif "if" in step:
        if all(check_condition(c, house, v) for c in _as_list(step["if"])):
            _run_steps(step.get("then"), house, run)
        else:
            _run_steps(step.get("else"), house, run)
    elif "stop" in step:
        if "response_variable" in step:
            _unsupported("response_variable")
        raise _Stop("stop")
    elif "service" in step or "action" in step:
        svc = render(step.get("service", step.get("action")), house, v)
        target = render_complex(step.get("target", {}), house, v)
        data = render_complex(step.get("data", {}), house, v)
        call = Call(svc, target, data)
        run.calls.append(call)
        _apply(call, house)
    elif "event" in step:
        run.events.append((step["event"], render_complex(step.get("event_data", {}), house, v)))
    elif "delay" in step or "wait_template" in step:
        run.skipped.append(step)
    elif "repeat" in step:
        rep = step["repeat"]
        if "for_each" not in rep:
            _unsupported("repeat without for_each")
        items = render_complex(rep["for_each"], house, v)
        for i, item in enumerate(items, 1):
            v["repeat"] = {"item": item, "index": i, "first": i == 1,
                           "last": i == len(items)}
            _run_steps(rep["sequence"], house, run)
        v.pop("repeat", None)
    else:
        _unsupported("action step %r" % sorted(step))


# --- the simulator -----------------------------------------------------------

def _key(auto, *names):
    for n in names:
        if n in auto:
            return auto[n]
    return []


class Simulator:
    """Feeds events to automations and runs them against the house."""

    def __init__(self, house, automations):
        self.house = house
        self.automations = _as_list(automations)
        self.pending = []
        self.history = []

    def triggered(self, auto, event):
        """Every trigger of `auto` that fires for `event`, as trigger variables."""
        out = []
        for i, trig in enumerate(_as_list(_key(auto, "triggers", "trigger"))):
            tv = match_trigger(trig, event, i)
            if tv is not None:
                out.append(tv)
        return out

    def fire(self, event, run=True):
        """Match `event`, evaluate each automation's conditions now, queue the runs.

        With run=True (the default) the queue is drained and the finished
        runs are returned; with run=False they wait for drain().
        """
        for auto in self.automations:
            matched = self.triggered(auto, event)
            mode = auto.get("mode", "single")
            if mode == "single":
                matched = matched[:1]
            else:
                matched = matched[:auto.get("max", 10)]
            for tv in matched:
                variables = {"trigger": tv}
                conds = _as_list(_key(auto, "conditions", "condition"))
                if all(check_condition(c, self.house, variables) for c in conds):
                    self.pending.append((auto, tv))
        return self.drain() if run else []

    def drain(self):
        done = []
        while self.pending:
            auto, tv = self.pending.pop(0)
            r = Run(auto.get("id", auto.get("alias")), tv, variables={"trigger": tv})
            try:
                _run_steps(_as_list(_key(auto, "actions", "action")), self.house, r)
            except _Stop as stop:
                r.stopped = str(stop)
            done.append(r)
        self.history.extend(done)
        return done
