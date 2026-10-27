# The record validator (lib/sagebrush/records.py), case by case: a valid
# record of every kind, then one change at a time, each with the validator's
# answer.  test/records_cases.out is written by CPython
# (python3 -I test/records_cases.py > test/records_cases.out), and the
# engine must print the same (test/records.test.ts).
import json

try:
    from sagebrush import records as R
except ImportError:  # CPython, outside the package
    import importlib.util
    import os
    spec = importlib.util.spec_from_file_location(
        "records", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib", "sagebrush", "records.py"))
    R = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(R)

interval = {"typical_s": 0.4, "high_s": 0.6, "samples": 14, "label": "estimated time"}
mem = {"typical_bytes": 6000000, "high_bytes": None, "label": "bound", "assumptions": []}
estimate = {
    "schema": "sagebrush.estimate/1", "op": "factor", "args_summary": "2^1061 - 1",
    "total_time": None, "peak_memory": mem,
    "fits": {"outcome": "estimated to fit, high unavailable (observed capacity)",
             "estimate_bytes": {"typical": 6000000, "high": None, "label": "bound"},
             "host_capacity": {"bytes": 1900000000, "basis": ["wasm memory"], "unknown_parts": ["the tab's other memory pressure"]},
             "guard_ceiling_bytes": None, "options": ["the Python package"]},
    "stages": [{"name": "trial division", "work": {"units": 210000000, "label": "known"}, "time": interval,
                "memory": None, "condition": None, "success": None},
               # (a validator fixture only, with its time null: not an example
               # of the fields' meaning.  Estimates give one stage per chance
               # milestone q, with p_typical = p_high = q and the time to reach
               # it: test/estimates_cases.py, the estimates ruling of Oct 27)
               {"name": "ECM 30 digits", "work": None, "time": None, "memory": mem,
                "condition": "if a factor of at most 30 digits exists",
                "success": {"p_typical": 0.5, "p_high": 0.95, "label": "heuristic model"}}],
    "assumptions": ["the chances are modelled, not measured on this input"],
    "calibration": {"runtime": "wasm", "engine_build": "abc", "machine_key": "k", "source": "probe", "samples": 14, "age_s": 120},
}
running = {"schema": "sagebrush.progress/1", "call_id": 3, "parent_id": 0, "op": "factor", "stage": "ECM",
           "stage_index": 2, "stage_count": 4, "count": {"done": 410, "total": 1800, "unit": "curves", "label": "counted"},
           "time_fraction": {"value": 0.25, "label": "estimated fraction"}, "elapsed_s": 41.0, "eta": interval,
           "beyond_forecast": False, "memory_now_bytes": 1 << 20, "memory_peak_bytes": 2 << 20}
untracked = R.progress_untracked("18446744073709551615", 3, "factor")
ckref = {"op": "factor", "algorithm": "ecm", "state_version": 1, "engine_build": "abc", "input_sha256": "00",
         "location": {"kind": "deferred"}}
partial = {"schema": "sagebrush.partial/1", "op": "factor", "stage": "ECM", "stage_index": 2, "stopped_by": "deadline",
           "found": {"found": [[3, 1]], "unfactored": [["9007199254740993", "composite"]], "sign": 1},
           "guarantees": ["n = sign * prod p^e * prod m"], "work_spent": "9007199254740993", "lost_work": 0,
           "elapsed_s": 60.2, "remaining_estimate": estimate, "checkpoint": None,
           "checkpoint_unavailable": R.CHECKPOINT_UNAVAILABLE}
outcome = {"schema": "sagebrush.outcome/1", "call_id": 3, "op": "factor", "status": "stopped", "reason": "deadline",
           "partial": partial, "checkpoint": None, "checkpoint_unavailable": R.CHECKPOINT_UNAVAILABLE,
           "elapsed_s": 60.2, "work_spent": 5, "engine_build": "abc", "runtime": "wasm"}
complete = {"schema": "sagebrush.outcome/1", "call_id": 4, "op": "factor", "status": "complete", "value": [[2, 3]],
            "elapsed_s": 0.1, "work_spent": 1, "engine_build": "abc", "runtime": "native"}
error = {"schema": "sagebrush.outcome/1", "call_id": 5, "op": "factor", "status": "error",
         "error": {"type": "ValueError", "message": "factorization of 0 is not defined"},
         "elapsed_s": 0.0, "work_spent": 0, "engine_build": "abc", "runtime": "native"}
checkpoint = {"schema": "sagebrush.checkpoint/1", "format": "sagebrush-checkpoint", "version": 1, "op": "factor",
              "algorithm": "ecm", "state_version": 1, "engine_build": "abc", "created": "2026-10-24T21:00:00Z",
              "input_sha256": "00", "payload_sha256": "11", "payload_length": 3, "payload": "AAAA"}


def show(label, r):
    try:
        R.validate(r)
        print(label + ": ok")
    except ValueError as e:
        print(label + ": " + str(e))


def change(r, path, value):
    """A deep copy of r with r[path...] = value (or deleted, for value DEL)."""
    r = json.loads(json.dumps(r))
    *head, last = path
    d = r
    for k in head:
        d = d[k]
    if value is DEL:
        del d[last]
    else:
        d[last] = value
    return r


DEL = object()
for name, r in [("estimate", estimate), ("running", running), ("untracked", untracked), ("partial", partial),
                ("outcome stopped", outcome), ("outcome complete", complete), ("outcome error", error),
                ("checkpoint", checkpoint)]:
    show(name, r)
    assert R.from_json(R.to_json(r)) == r

cases = [
    ("estimate without stages", estimate, ["stages"], DEL),
    ("estimate, a work label", estimate, ["stages", 0, "work", "label"], "exact"),
    ("estimate, a chance above 1", estimate, ["stages", 1, "success", "p_high"], 1.5),
    ("estimate, a fits outcome", estimate, ["fits", "outcome"], "fits"),
    ("estimate, capacity bytes negative", estimate, ["fits", "host_capacity", "bytes"], -1),
    ("estimate, high_s a string", estimate, ["stages", 0, "time", "high_s"], "1"),
    ("estimate, an unknown field", estimate, ["future"], {"any": 1}),
    ("running, done negative", running, ["count", "done"], -1),
    ("running, done a decimal string", running, ["count", "done"], "9007199254740993"),
    ("running, done a non-decimal string", running, ["count", "done"], "1e9"),
    ("running, fraction above 1", running, ["time_fraction", "value"], 1.0000001),
    ("running, fraction exactly 1", running, ["time_fraction", "value"], 1),
    ("running, count label", running, ["count", "label"], "estimated"),
    ("running, beyond_forecast 0", running, ["beyond_forecast"], 0),
    ("running, stage_index a bool", running, ["stage_index"], True),
    ("running, early part untracked", running, ["early_part_untracked"], True),
    ("untracked, no reason", untracked, ["reason"], DEL),
    ("untracked, status running", untracked, ["status"], "running"),
    ("partial, stopped_by", partial, ["stopped_by"], "timeout"),
    ("partial, no found", partial, ["found"], DEL),
    ("partial, checkpoint kind", partial, ["checkpoint"], dict(ckref, location={"kind": "pickle"})),
    ("partial, checkpoint ref", partial, ["checkpoint"], ckref),
    ("outcome, status", outcome, ["status"], "done"),
    ("outcome, reason", outcome, ["reason"], "allowance"),
    ("outcome, no engine_build", outcome, ["engine_build"], DEL),
    ("outcome, error without message", error, ["error", "message"], DEL),
    ("outcome, peak memory a float", complete, ["peak_memory_bytes"], 1.5),
    ("checkpoint, format", checkpoint, ["format"], "pickle"),
    ("checkpoint, version 2", checkpoint, ["version"], 2),
    ("checkpoint, version True", checkpoint, ["version"], True),
    ("checkpoint, no payload_length", checkpoint, ["payload_length"], DEL),
    # integral JSON numbers are integers (JSON Schema 2020-12); others are not
    ("running, call_id 3.0", running, ["call_id"], 3.0),
    ("running, done 410.0", running, ["count", "done"], 410.0),
    ("running, stage_index 2.0", running, ["stage_index"], 2.0),
    ("running, stage_index 2.5", running, ["stage_index"], 2.5),
    ("running, done 410.5", running, ["count", "done"], 410.5),
    ("running, done inf", running, ["count", "done"], float("inf")),
    ("checkpoint, version 1.0", checkpoint, ["version"], 1.0),
    ("checkpoint, version 1.5", checkpoint, ["version"], 1.5),
    ("checkpoint, state_version 1.0", checkpoint, ["state_version"], 1.0),
    ("checkpoint, state_version 0.5", checkpoint, ["state_version"], 0.5),
    ("outcome, peak memory 1024.0", complete, ["peak_memory_bytes"], 1024.0),
]
for label, r, path, value in cases:
    show(label, change(r, path, value))
for label, r in [("not an object", [1]), ("no schema", {}), ("estimate/2", {"schema": "sagebrush.estimate/2"}),
                 ("an unknown kind", {"schema": "sagebrush.limits/1"})]:
    show(label, r)
print(sorted(R.schema_texts()))
