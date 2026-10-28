"""Sagebrush's JSON records (design-estimates-progress r4 §3 and §6,
design-agent-api-library r3 §4 to §7): estimate/1, progress/1, outcome/1,
partial/1 and checkpoint/1.

Every record is a plain JSON object whose "schema" names it, such as
"sagebrush.progress/1".  Field names are stable: a later version adds fields
compatibly (the schemas allow unknown fields), and only an incompatible change
makes a new version.  The conventions: times in seconds, memory in bytes,
work in the operation's named unit, integers beyond 2^53 as decimal strings.

SCHEMAS holds the five schemas (JSON Schema 2020-12); docs/schemas/*.v1.json
are generated from them (`python3 lib/sagebrush/records.py --write-schemas`)
and checked to match.  validate(record) checks a record against its schema
with this module's own validator, which needs nothing outside the standard
library and runs in both runtimes.

    sage: from sagebrush import records
    sage: r = records.progress_untracked(7, 0, "factor")
    sage: r["status"], r["reason"]
    ('untracked', 'all 32 progress slots are in use')
    sage: records.validate(r) is r
    True
    sage: records.validate({"schema": "sagebrush.progress/1", "call_id": 7})
    Traceback (most recent call last):
    ...
    ValueError: sagebrush.progress/1: "parent_id" is missing
"""

import json as _json

SCHEMA_IDS = ("estimate", "progress", "outcome", "partial", "checkpoint")
_BASE = "https://sagebrush.space/schemas/"

# ---- shared pieces

_COUNT = {"anyOf": [{"type": "integer", "minimum": 0}, {"type": "string", "pattern": "^[0-9]+$"}]}
_SECONDS = {"type": "number", "minimum": 0}
_BYTES = {"type": "integer", "minimum": 0}
_NULL = {"type": "null"}


def _nullable(s):
    return {"anyOf": [s, _NULL]}


_INTERVAL = {
    "type": "object",
    "required": ["typical_s", "high_s", "samples", "label"],
    "properties": {
        "typical_s": _SECONDS,
        "high_s": _nullable(_SECONDS),
        "samples": {"type": "integer", "minimum": 0},
        "label": {"const": "estimated time"},
        "note": {"type": "string"},
    },
}
_MEM = {
    "type": "object",
    "required": ["typical_bytes", "high_bytes", "label", "assumptions"],
    "properties": {
        "typical_bytes": _nullable(_BYTES),
        "high_bytes": _nullable(_BYTES),
        "label": {"enum": ["known", "bound", "forecast", "unknown", "required"]},
        "assumptions": {"type": "array", "items": {"type": "string"}},
    },
}
_FIT = {
    "type": "object",
    "required": ["outcome", "estimate_bytes", "host_capacity", "guard_ceiling_bytes", "options"],
    "properties": {
        "outcome": {"enum": [
            "unknown",
            "estimated to exceed the observed capacity",
            "uncertain",
            "estimated to fit, high unavailable",
            "estimated to fit, high unavailable (observed capacity)",
            "estimated to fit the observed capacity",
            "estimated to fit",
            "exceeds a hard ceiling",
        ]},
        "estimate_bytes": {
            "type": "object",
            "required": ["typical", "high", "label"],
            "properties": {"typical": _nullable(_BYTES), "high": _nullable(_BYTES), "label": {"type": "string"}},
        },
        "host_capacity": {
            "type": "object",
            "required": ["bytes", "basis", "unknown_parts"],
            "properties": {
                "bytes": _nullable(_BYTES),
                "basis": {"type": "array", "items": {"type": "string"}},
                "unknown_parts": {"type": "array", "items": {"type": "string"}},
            },
        },
        "guard_ceiling_bytes": _nullable(_BYTES),
        "options": {"type": "array", "items": {"type": "string"}},
    },
}
_STAGE = {
    "type": "object",
    "required": ["name", "work", "time", "memory", "condition", "success"],
    "properties": {
        "name": {"type": "string"},
        "work": _nullable({
            "type": "object",
            "required": ["units", "label"],
            "properties": {"units": _COUNT, "label": {"enum": ["known", "bound", "forecast"]}},
        }),
        "time": _nullable({"$ref": "#/$defs/interval"}),
        "memory": _nullable({"$ref": "#/$defs/memory"}),
        "condition": _nullable({"type": "string"}),
        "success": _nullable({
            "type": "object",
            "required": ["p_typical", "p_high", "label"],
            "properties": {
                "p_typical": {"type": "number", "minimum": 0, "maximum": 1},
                "p_high": {"type": "number", "minimum": 0, "maximum": 1},
                "label": {"const": "heuristic model"},
            },
        }),
    },
}
_ESTIMATE = {
    "type": "object",
    "required": ["schema", "op", "args_summary", "total_time", "peak_memory", "fits", "stages", "assumptions", "calibration"],
    "properties": {
        "schema": {"const": "sagebrush.estimate/1"},
        "op": {"type": "string"},
        "args_summary": {"type": "string"},
        "total_time": _nullable({"$ref": "#/$defs/interval"}),
        "peak_memory": {"$ref": "#/$defs/memory"},
        "fits": _FIT,
        "stages": {"type": "array", "items": _STAGE},
        "assumptions": {"type": "array", "items": {"type": "string"}},
        "calibration": {
            "type": "object",
            "required": ["runtime", "engine_build", "machine_key", "source", "samples", "age_s"],
            "properties": {
                "runtime": {"type": "string"},
                "engine_build": {"type": "string"},
                "machine_key": {"type": "string"},
                "source": {"type": "string"},
                "samples": {"type": "integer", "minimum": 0},
                "age_s": _nullable(_SECONDS),
            },
        },
        "note": {"type": "string"},
    },
}
_CKPT_REF = {
    "type": "object",
    "required": ["op", "algorithm", "state_version", "engine_build", "input_sha256", "location"],
    "properties": {
        "op": {"type": "string"},
        "algorithm": {"type": "string"},
        "state_version": {"type": "integer", "minimum": 1},
        "engine_build": {"type": "string"},
        "created": {"type": "string"},
        "input_sha256": {"type": "string"},
        "payload_sha256": {"type": "string"},
        "payload_length": {"type": "integer", "minimum": 0},
        "location": {
            "type": "object",
            "required": ["kind"],
            "properties": {
                "kind": {"enum": ["inline", "file", "handle", "deferred"]},
                "path": {"type": "string"},
                "handle": {"type": "string"},
            },
        },
    },
}
_PARTIAL = {
    "type": "object",
    "required": ["schema", "op", "stage", "stage_index", "stopped_by", "found", "guarantees",
                 "work_spent", "lost_work", "elapsed_s", "remaining_estimate", "checkpoint"],
    "properties": {
        "schema": {"const": "sagebrush.partial/1"},
        "op": {"type": "string"},
        "stage": {"type": "string"},
        "stage_index": {"type": "integer", "minimum": 0},
        "stopped_by": {"enum": ["deadline", "work", "cancel", "memory"]},
        "found": {"type": "object"},
        "guarantees": {"type": "array", "items": {"type": "string"}},
        "work_spent": _COUNT,
        "lost_work": _COUNT,
        "elapsed_s": _SECONDS,
        "remaining_estimate": _nullable({"$ref": "#/$defs/estimate"}),
        "checkpoint": _nullable({"$ref": "#/$defs/checkpoint_ref"}),
        "checkpoint_unavailable": {"type": "string"},
    },
}
_STATUS = {"enum": ["complete", "stopped", "error"]}
_REASON = {"enum": ["deadline", "work", "cancel", "memory"]}
_OUTCOME = {
    "type": "object",
    "required": ["schema", "call_id", "op", "status", "elapsed_s", "work_spent", "engine_build", "runtime"],
    "properties": {
        "schema": {"const": "sagebrush.outcome/1"},
        "call_id": _COUNT,
        "op": {"type": "string"},
        "status": _STATUS,
        "reason": _REASON,
        "value": {},
        "partial": _nullable({"$ref": "#/$defs/partial"}),
        "checkpoint": _nullable({"$ref": "#/$defs/checkpoint_ref"}),
        "checkpoint_unavailable": {"type": "string"},
        "error": {
            "type": "object",
            "required": ["type", "message"],
            "properties": {"type": {"type": "string"}, "message": {"type": "string"}},
        },
        "estimate_at_start": _nullable({"$ref": "#/$defs/estimate"}),
        "elapsed_s": _SECONDS,
        "work_spent": _COUNT,
        "lost_work": _COUNT,
        "reconstruction_work": _COUNT,
        "recognition_s": _SECONDS,
        "handback_s": _SECONDS,
        "checkpoint_write_s": _SECONDS,
        "peak_memory_bytes": _BYTES,
        "engine_build": {"type": "string"},
        "runtime": {"type": "string"},
    },
}
_PROGRESS_COMMON = {
    "schema": {"const": "sagebrush.progress/1"},
    "call_id": _COUNT,
    "parent_id": _COUNT,
    "op": {"type": "string"},
}
_PROGRESS_RUNNING = {
    "type": "object",
    "required": ["schema", "call_id", "parent_id", "op", "stage", "stage_index", "count", "elapsed_s", "beyond_forecast"],
    "properties": dict(_PROGRESS_COMMON, **{
        "status": {"const": "running"},
        "stage": {"type": "string"},
        "stage_index": {"type": "integer", "minimum": 0},
        "stage_count": {"type": "integer", "minimum": 0},
        "count": {
            "type": "object",
            "required": ["done", "unit", "label"],
            "properties": {
                "done": _COUNT,
                "total": _COUNT,
                "unit": {"type": "string"},
                "label": {"const": "counted"},
                "saturated": {"type": "boolean"},
            },
        },
        "time_fraction": {
            "type": "object",
            "required": ["value", "label"],
            "properties": {"value": {"type": "number", "minimum": 0, "maximum": 1}, "label": {"const": "estimated fraction"}},
        },
        "elapsed_s": _SECONDS,
        "eta": {"$ref": "#/$defs/interval"},
        "beyond_forecast": {"type": "boolean"},
        "work_spent": _COUNT,
        "memory_now_bytes": _BYTES,
        "memory_peak_bytes": _BYTES,
        "early_part_untracked": {"type": "boolean"},
    }),
}
_PROGRESS_UNTRACKED = {
    "type": "object",
    "required": ["schema", "call_id", "parent_id", "op", "status", "reason"],
    "properties": dict(_PROGRESS_COMMON, **{
        "status": {"const": "untracked"},
        "reason": {"type": "string"},
        "elapsed_s": _SECONDS,
    }),
}
_CHECKPOINT = {
    "type": "object",
    "required": ["schema", "format", "version", "op", "algorithm", "state_version", "engine_build",
                 "created", "input_sha256", "payload_sha256", "payload_length"],
    "properties": {
        "schema": {"const": "sagebrush.checkpoint/1"},
        "format": {"const": "sagebrush-checkpoint"},
        "version": {"const": 1},
        "op": {"type": "string"},
        "algorithm": {"type": "string"},
        "state_version": {"type": "integer", "minimum": 1},
        "engine_build": {"type": "string"},
        "created": {"type": "string"},
        "input_sha256": {"type": "string"},
        "payload_sha256": {"type": "string"},
        "payload_length": {"type": "integer", "minimum": 0},
        "payload": {"type": "string"},
        "payload_file": {"type": "string"},
    },
}

_DEFS = {
    "interval": _INTERVAL,
    "memory": _MEM,
    "estimate": _ESTIMATE,
    "partial": _PARTIAL,
    "checkpoint_ref": _CKPT_REF,
}


def _schema(name, title, body):
    s = {"$schema": "https://json-schema.org/draft/2020-12/schema", "$id": _BASE + name + ".v1.json",
         "title": title}
    s.update(body)
    s["$defs"] = _DEFS
    return s


SCHEMAS = {
    "estimate": _schema("estimate", "sagebrush.estimate/1", _ESTIMATE),
    "progress": _schema("progress", "sagebrush.progress/1",
                        {"anyOf": [_PROGRESS_RUNNING, _PROGRESS_UNTRACKED]}),
    "outcome": _schema("outcome", "sagebrush.outcome/1", _OUTCOME),
    "partial": _schema("partial", "sagebrush.partial/1", _PARTIAL),
    "checkpoint": _schema("checkpoint", "sagebrush.checkpoint/1", _CHECKPOINT),
}
_FORM_NAMES = {id(_PROGRESS_RUNNING): "running", id(_PROGRESS_UNTRACKED): "untracked"}


# ---- the validator (the subset of JSON Schema the schemas above use)

def _typename(v):
    if v is None:
        return "null"
    if v is True or v is False:
        return "boolean"
    if isinstance(v, int):
        return "integer"
    if isinstance(v, float):
        # (as JSON Schema: a number with a zero fractional part, such as 3.0,
        # is an integer; infinities and NaN are not)
        return "integer" if v.is_integer() else "number"
    if isinstance(v, str):
        return "string"
    if isinstance(v, list):
        return "array"
    if isinstance(v, dict):
        return "object"
    return type(v).__name__


def _is(v, t):
    n = _typename(v)
    return n == t or (t == "number" and n == "integer")


def _check(v, s, path):
    """The first failure of v against s, as text, or None."""
    if "$ref" in s:
        return _check(v, _DEFS[s["$ref"].rsplit("/", 1)[1]], path)
    if "anyOf" in s:
        forms = [a for a in s["anyOf"] if id(a) in _FORM_NAMES]
        if forms and isinstance(v, dict):
            # a record's form is chosen by its status ("running" when absent)
            want = v.get("status", "running")
            for a in forms:
                if _FORM_NAMES[id(a)] == want:
                    return _check(v, a, path)
            return "status is %s, not one of %s" % (_json.dumps(want), ", ".join(
                _json.dumps(_FORM_NAMES[id(a)]) for a in forms))
        fails = []
        for alt in s["anyOf"]:
            e = _check(v, alt, path)
            if e is None:
                return None
            fails.append((alt, e))
        # the reason given is the alternative of the value's own type, if any
        for alt, e in fails:
            if "type" in alt and _is(v, alt["type"]):
                return e
        return fails[0][1]
    if "const" in s and not (v == s["const"] and _typename(v) == _typename(s["const"])):
        return "%s is %s, not %s" % (path or "the record", _json.dumps(v), _json.dumps(s["const"]))
    if "enum" in s and v not in s["enum"]:
        return "%s is %s, not one of %s" % (path, _json.dumps(v), ", ".join(_json.dumps(x) for x in s["enum"]))
    t = s.get("type")
    if t is not None and not _is(v, t):
        return "%s is %s, not %s" % (path or "the record", _typename(v), t)
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        if "minimum" in s and v < s["minimum"]:
            return "%s is %s, below %s" % (path, v, s["minimum"])
        if "maximum" in s and v > s["maximum"]:
            return "%s is %s, above %s" % (path, v, s["maximum"])
        if isinstance(v, float) and v != v:
            return "%s is NaN" % path
    if isinstance(v, str) and s.get("pattern") == "^[0-9]+$" and not (v and all("0" <= c <= "9" for c in v)):
        return "%s is %s, not a decimal integer" % (path, _json.dumps(v))
    if isinstance(v, dict):
        for k in s.get("required", ()):
            if k not in v:
                return '"%s" is missing' % ((path + "." if path else "") + k)
        props = s.get("properties", {})
        for k, sub in props.items():
            if k in v:
                e = _check(v[k], sub, (path + "." if path else "") + k)
                if e is not None:
                    return e
    if isinstance(v, list) and "items" in s:
        for i, x in enumerate(v):
            e = _check(x, s["items"], "%s[%d]" % (path, i))
            if e is not None:
                return e
    return None


def validate(record):
    """record itself if it is a valid record of the schema it names, otherwise
    ValueError saying what is wrong."""
    if not isinstance(record, dict):
        raise ValueError("a record is a JSON object, not %s" % _typename(record))
    name = record.get("schema")
    kind = name[len("sagebrush."):-2] if isinstance(name, str) and name.startswith("sagebrush.") and name.endswith("/1") else None
    if kind not in SCHEMAS:
        raise ValueError("not a Sagebrush record: schema is %s" % _json.dumps(name))
    s = SCHEMAS[kind]
    e = _check(record, {k: v for k, v in s.items() if not k.startswith("$") and k != "title"}, "")
    if e is not None:
        raise ValueError("%s: %s" % (name, e))
    return record


def to_json(record):
    """The record as compact JSON text, after validating it."""
    return _json.dumps(validate(record), separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def from_json(text):
    """A record from JSON text, validated."""
    return validate(_json.loads(text))


# ---- constructors used by the hosts

UNTRACKED_REASON = "all 32 progress slots are in use"
CHECKPOINT_UNAVAILABLE = "checkpoints are not available in this build"


def progress_untracked(call_id, parent_id, op, elapsed_s=None):
    """The one progress/1 record of a call that got no slot (E4 §6)."""
    r = {"schema": "sagebrush.progress/1", "call_id": call_id, "parent_id": parent_id, "op": op,
         "status": "untracked", "reason": UNTRACKED_REASON}
    if elapsed_s is not None:
        r["elapsed_s"] = elapsed_s
    return r


# ---- what this build provides (estimates plan r3 §1.1)

# Each later piece of the agent API turns its entry on (and extends
# stop_points) in the change that implements it; until then its options are
# refused before anything runs.
_CAPABILITIES = {
    "records": ["sagebrush.estimate/1", "sagebrush.progress/1", "sagebrush.outcome/1",
                "sagebrush.partial/1", "sagebrush.checkpoint/1"],
    "progress": True,
    "estimate": True,
    "deadline": False,
    "work": False,
    "cancel_with_partial": False,
    "run": False,
    "request_stop": False,
    "checkpoints": False,
    "resume": False,
}
# the call options that later pieces add, refused until then
LATER_OPTIONS = ("deadline", "work", "resume", "checkpoint_every", "checkpoint_path")


def capabilities():
    """What this build of the agent API provides (a new dict each time)."""
    return _json.loads(_json.dumps(_CAPABILITIES))


def stop_points(op):
    """The clean stop points implemented for op (none in this build)."""
    return []


def unavailable(name):
    """TypeError: name is not available in this build."""
    return TypeError("%s is not available in this build" % name)


def refuse_later_options(fn, kwds):
    """Before anything runs: TypeError if kwds has an option of a later piece
    of the agent API (deadline=, work=, resume=, checkpoint_every=,
    checkpoint_path=), naming it."""
    for k in LATER_OPTIONS:
        if k in kwds:
            raise TypeError("%s(): %s= is not available in this build" % (fn, k))


# ---- the schema files

def schema_texts():
    """{file name: text} of docs/schemas, from SCHEMAS."""
    return {"%s.v1.json" % k: _json.dumps(SCHEMAS[k], indent=1, sort_keys=True, ensure_ascii=False) + "\n"
            for k in SCHEMA_IDS}


if __name__ == "__main__":
    import os
    import sys

    root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "docs", "schemas")
    if sys.argv[1:] == ["--write-schemas"]:
        os.makedirs(root, exist_ok=True)
        for f, t in schema_texts().items():
            with open(os.path.join(root, f), "w", encoding="utf-8") as h:
                h.write(t)
    elif sys.argv[1:] == ["--check"]:
        bad = [f for f, t in schema_texts().items()
               if not os.path.exists(os.path.join(root, f)) or open(os.path.join(root, f), encoding="utf-8").read() != t]
        if bad:
            print("out of date: " + ", ".join("docs/schemas/" + f for f in bad)
                  + " (run python3 lib/sagebrush/records.py --write-schemas)")
            sys.exit(1)
    else:
        print("usage: records.py --write-schemas | --check")
        sys.exit(2)
