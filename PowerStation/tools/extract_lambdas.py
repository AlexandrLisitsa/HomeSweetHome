#!/usr/bin/env python3
"""Turn the decision logic of power-station.yaml into a host-compilable C++ header.

The unit tests in test_firmware_logic.cpp must exercise the lambdas that are
flashed, not a copy of them. This script reads the YAML, substitutes
${...} variables, and emits every lambda and every simple action list
(script bodies, switch handlers, select/number/datetime on_value, number
set_action, binary sensor triggers, intervals, on_time) as plain C++
functions. Entities become fake objects from firmware_stubs.h; id(x)
resolves to them.

Only a small set of actions is translated (lambda, logger.log,
script.execute, switch.turn_on/off, if with switch.is_on or lambda
conditions). Anything else raises, so a new kind of action in the YAML is
noticed instead of silently skipped. on_boot is deliberately left out: it
waits on the UART and NTP, which is framework sequencing, not decision logic.

Usage: python extract_lambdas.py [yaml] [out_header]
"""

import re
import sys
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
DEFAULT_YAML = HERE.parent / "power-station.yaml"
DEFAULT_OUT = HERE / "build" / "firmware_logic.gen.h"


class Tagged(str):
    """A scalar that carried a YAML tag such as !secret or !lambda."""


class Loader(yaml.SafeLoader):
    pass


def _any_tag(loader, tag_suffix, node):
    if isinstance(node, yaml.ScalarNode):
        return Tagged(loader.construct_scalar(node))
    if isinstance(node, yaml.SequenceNode):
        return loader.construct_sequence(node)
    return loader.construct_mapping(node)


Loader.add_multi_constructor("!", _any_tag)


class ExtractError(Exception):
    pass


def substitute(text, subs):
    def repl(m):
        name = m.group(1) or m.group(2)
        if name not in subs:
            raise ExtractError(f"unknown substitution ${{{name}}}")
        return str(subs[name])

    return re.sub(r"\$\{(\w+)\}|\$(\w+)", repl, text)


def cpp_str(s):
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def as_list(v):
    if v is None:
        return []
    return v if isinstance(v, list) else [v]


def period_name(p):
    return re.sub(r"[^0-9a-zA-Z]", "_", str(p))


class Generator:
    def __init__(self, cfg):
        self.cfg = cfg
        self.subs = {k: str(v) for k, v in (cfg.get("substitutions") or {}).items()}
        self.entities = []  # (cpp_type, id, ctor_args)
        self.functions = []  # C++ source of each generated function
        self.wiring = []  # statements run by fw_wire()
        self.resets = []  # statements run by fw_reset()
        self.lambda_count = 0
        self.skipped = []

    # --- actions ---------------------------------------------------------

    def lam(self, text, ret="void"):
        self.lambda_count += 1
        body = substitute(str(text), self.subs)
        body = "\n".join("    " + line for line in body.splitlines())
        return f"[&]() -> {ret} {{\n{body}\n  }}()"

    def condition(self, cond):
        if not isinstance(cond, dict) or len(cond) != 1:
            raise ExtractError(f"unsupported condition {cond!r}")
        (kind, arg), = cond.items()
        if kind == "switch.is_on":
            return f"id({arg}).state"
        if kind == "switch.is_off":
            return f"!id({arg}).state"
        if kind == "lambda":
            return self.lam(arg, "bool")
        raise ExtractError(f"unsupported condition {kind}")

    def actions(self, acts, indent="  "):
        if isinstance(acts, dict) and "then" in acts:
            acts = acts["then"]
        if isinstance(acts, dict):
            acts = [acts]
        out = []
        for act in acts:
            if not isinstance(act, dict) or len(act) != 1:
                raise ExtractError(f"unsupported action {act!r}")
            (kind, arg), = act.items()
            if kind == "lambda":
                out.append(f"{indent}{self.lam(arg)};")
            elif kind == "logger.log":
                out.append(f"{indent}fw_log({cpp_str(substitute(str(arg), self.subs))});")
            elif kind == "script.execute":
                out.append(f"{indent}id({arg}).execute();")
            elif kind in ("switch.turn_on", "switch.turn_off"):
                out.append(f"{indent}id({arg}).{kind.split('.')[1]}();")
            elif kind == "if":
                out.append(f"{indent}if ({self.condition(arg['condition'])}) {{")
                out.extend(self.actions(arg.get("then", []), indent + "  "))
                if "else" in arg:
                    out.append(f"{indent}}} else {{")
                    out.extend(self.actions(arg["else"], indent + "  "))
                out.append(f"{indent}}}")
            else:
                raise ExtractError(f"unsupported action {kind}")
        return out

    def func(self, name, params, acts):
        body = "\n".join(self.actions(acts))
        self.functions.append(f"inline void {name}({params}) {{\n{body}\n}}\n")

    def value_func(self, name, ret, text):
        self.lambda_count += 1
        body = substitute(str(text), self.subs)
        self.functions.append(f"inline {ret} {name}() {{\n{body}\n}}\n")

    # --- sections --------------------------------------------------------

    def entity(self, cpp_type, eid, *args):
        self.entities.append((cpp_type, eid, args))

    def run(self):
        c = self.cfg
        if "on_boot" in c.get("esphome", {}):
            self.skipped.append("esphome.on_boot (UART/NTP wait sequencing)")

        for g in as_list(c.get("globals")):
            init = g.get("initial_value")
            init = "{}" if init is None else substitute(str(init), self.subs)
            self.functions_globals = getattr(self, "functions_globals", [])
            self.functions_globals.append(f"inline {g['type']} {g['id']}{{}};")
            self.resets.append(f"ids::{g['id']} = {g['type']}({init if init != '{}' else ''});")

        for t in as_list(c.get("time")):
            self.entity("FakeClock", t["id"])
            for i, ot in enumerate(t.get("on_time", [])):
                h = substitute(str(ot.get("hours", "x")), self.subs)
                self.func(f"time_{t['id']}_on_time_{h}", "", ot)

        for u in as_list(c.get("uart")):
            self.entity("FakeUart", u["id"])

        for s in as_list(c.get("script")):
            self.entity("FakeScript", s["id"], cpp_str(s["id"]))
            self.func(f"script_{s['id']}", "", s)
            self.wiring.append(f"ids::{s['id']}.body = &script_{s['id']};")

        for s in as_list(c.get("sensor")):
            self._sensor_ids(s)
            if s.get("platform") == "template" and "lambda" in s:
                self.value_func(f"{s['id']}_lambda", "esphome::optional<float>", s["lambda"])

        for sw in as_list(c.get("switch")):
            if sw.get("platform") == "template":
                self.entity("FakeSwitch", sw["id"], cpp_str(sw["id"]), "true")
                for trig in ("on_turn_on", "on_turn_off"):
                    if trig in sw:
                        self.func(f"{sw['id']}_{trig}", "", sw[trig])
                        self.wiring.append(f"ids::{sw['id']}.{trig} = &{sw['id']}_{trig};")
            else:
                for key, sub in sw.items():
                    if isinstance(sub, dict) and "id" in sub:
                        self.entity("FakeSwitch", sub["id"], cpp_str(sub["id"]), "false")

        for sel in as_list(c.get("select")):
            opts = ", ".join(cpp_str(o) for o in sel["options"])
            self.entity("FakeSelect", sel["id"], cpp_str(sel["id"]), f"{{{opts}}}",
                        cpp_str(sel.get("initial_option", sel["options"][0])))
            if "on_value" in sel:
                self.func(f"{sel['id']}_on_value", "std::string x", sel["on_value"])
                self.wiring.append(f"ids::{sel['id']}.on_value = &{sel['id']}_on_value;")

        for n in as_list(c.get("number")):
            self.entity("FakeNumber", n["id"], cpp_str(n["id"]), str(float(n["min_value"])),
                        str(float(n["max_value"])), str(float(n.get("initial_value", "NAN"))),
                        "true" if n.get("optimistic") else "false")
            for trig in ("on_value", "set_action"):
                if trig in n:
                    self.func(f"{n['id']}_{trig}", "float x", n[trig])
                    self.wiring.append(f"ids::{n['id']}.{trig} = &{n['id']}_{trig};")

        for d in as_list(c.get("datetime")):
            self.entity("FakeDateTime", d["id"], cpp_str(str(d.get("initial_value", ""))))
            if "on_value" in d:
                self.func(f"{d['id']}_on_value", "", d["on_value"])
                self.wiring.append(f"ids::{d['id']}.on_value = &{d['id']}_on_value;")

        for b in as_list(c.get("binary_sensor")):
            self.entity("FakeBinarySensor", b["id"])
            if "lambda" in b:
                self.value_func(f"{b['id']}_lambda", "esphome::optional<bool>", b["lambda"])
            for trig in ("on_press", "on_release"):
                if trig in b:
                    self.func(f"{b['id']}_{trig}", "", b[trig])
                    self.wiring.append(f"ids::{b['id']}.{trig} = &{b['id']}_{trig};")
            if "filters" in b:
                self.skipped.append(f"binary_sensor {b['id']} filters {[list(f)[0] for f in b['filters']]} (framework)")

        seen = {}
        for iv in as_list(c.get("interval")):
            name = period_name(iv["interval"])
            seen[name] = seen.get(name, 0) + 1
            if seen[name] > 1:
                name += f"_{seen[name]}"
            self.func(f"interval_{name}", "", iv)

        return self.render()

    def _sensor_ids(self, node):
        if isinstance(node, dict):
            if "id" in node and ("name" in node or "platform" in node):
                self.entity("FakeSensor", node["id"])
            for v in node.values():
                if isinstance(v, dict):
                    self._sensor_ids(v)

    def render(self):
        out = [
            "// GENERATED by PowerStation/tools/extract_lambdas.py from power-station.yaml.",
            "// Do not edit: re-run the generator. Lambda bodies below are copied verbatim.",
            "#pragma once",
            '#include "firmware_stubs.h"',
            "",
            "namespace ids {",
        ]
        for t, eid, args in self.entities:
            a = ", ".join(args)
            out.append(f"inline {t} {eid}{{{a}}};" if a else f"inline {t} {eid};")
        out.extend(getattr(self, "functions_globals", []))
        out.append("}  // namespace ids")
        out.append("#define id(x) (ids::x)")
        out.append("")
        out.extend(self.functions)
        out.append("inline void fw_reset() {")
        for t, eid, args in self.entities:
            out.append(f"  ids::{eid}.reset();")
        out.extend("  " + r for r in self.resets)
        out.append("}")
        out.append("inline void fw_wire() {")
        out.extend("  " + w for w in self.wiring)
        out.append("}")
        out.append(f"constexpr int FW_LAMBDA_COUNT = {self.lambda_count};")
        return "\n".join(out) + "\n"


def count_yaml_lambdas(cfg):
    n = 0

    def walk(node, under_boot=False):
        nonlocal n
        if isinstance(node, dict):
            for k, v in node.items():
                if k == "lambda" and not under_boot:
                    n += 1
                walk(v, under_boot or k == "on_boot")
        elif isinstance(node, list):
            for v in node:
                walk(v, under_boot)

    walk(cfg)
    return n


def main():
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_YAML
    dst = Path(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_OUT
    cfg = yaml.load(src.read_text(encoding="utf-8"), Loader=Loader)
    gen = Generator(cfg)
    try:
        text = gen.run()
    except ExtractError as e:
        print(f"extract_lambdas: {e}", file=sys.stderr)
        return 2
    expected = count_yaml_lambdas(cfg)
    if gen.lambda_count != expected:
        print(f"extract_lambdas: extracted {gen.lambda_count} lambdas but the YAML has "
              f"{expected} outside on_boot - a lambda sits somewhere the generator "
              "does not look", file=sys.stderr)
        return 2
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(text, encoding="utf-8", newline="\n")
    print(f"extract_lambdas: {gen.lambda_count} lambdas -> {dst}")
    for s in gen.skipped:
        print(f"extract_lambdas: not extracted: {s}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
