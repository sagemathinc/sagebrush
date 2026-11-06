"""One reactive wave's in-run decisions: a transcription of src/wave-policy.ts
(the waves design r3, §4), which the page replays on the results the gateway
returns, so any difference is a protocol error.  Kept line for line with the
TypeScript; test_remote_gateway.py checks the two against each other on the
same decisions.

Decisions are dicts as in TypeScript: {"kind": "run"}, {"kind": "gone"},
{"kind": "stale", "why": ..., "note"?}, {"kind": "cancelled", "by": ..., "why": ...}.
"""

import math

WAVE_CAPS = {"entries": 256}
_WHYS = ("exception", "error", "interrupted")


class WaveState:
    def __init__(self):
        self.stopped = False
        self.auto_ms = 0
        self.stale = set()
        self.blocked_by = {}


def _stale_parent(st, p):
    return st.stale.__contains__(p["in"]) if "in" in p else "stale" in p


def wave_decide(policy, st, k, e):
    """Entry k's decision, given every decision before it."""
    if st.stopped:
        return {"kind": "stale", "why": "interrupted"}
    budget = policy["budget"]
    if e["auto"] and not policy["all"] and budget is not None and (budget <= 0 or st.auto_ms + e["est"] > budget) \
            and not any(_stale_parent(st, p) for p in e["parents"]):
        return {"kind": "stale", "why": "budget"}
    block = st.blocked_by.get(k)
    if not block:
        for p in e["parents"]:
            if "block" in p:
                block = p["block"]
                break
            if _stale_parent(st, p):
                return {"kind": "stale", "why": "ancestor"}
    if block:
        return {"kind": "cancelled", "by": block["by"], "why": block["why"]}
    place = e.get("place")
    if place == "gone":
        return {"kind": "gone"}
    if place == "approval":
        return {"kind": "stale", "why": "approval", **({"note": e["note"]} if e.get("note") else {})}
    if place == "never":
        return {"kind": "stale", "why": "ancestor"}
    return {"kind": "run"}


def wave_stop(st):
    """A Stop latched while no entry was running: every undecided entry is stale, "interrupted"."""
    st.stopped = True


def wave_record(st, k, e, d, result=None):
    """Record entry k's decision (and, for a run, its result): what the entries after it see."""
    def cancel(block):
        for x in e["desc"]:
            if x not in st.blocked_by:
                st.blocked_by[x] = block
    if d["kind"] == "stale":
        st.stale.add(k)
    elif d["kind"] == "cancelled":
        cancel({"by": d["by"], "why": d["why"]})
    elif d["kind"] == "run":
        r = result or {"ok": False, "ms": 0}
        if e["auto"]:
            st.auto_ms += r["ms"]
        if r.get("stopped"):
            st.stopped = True
            if not r.get("interrupted"):
                st.stale.add(k)
        elif not r["ok"]:
            cancel({"by": k, "why": "exception"})


def wave_run_result(o):
    """A run entry's terminal outcome as the scheduler's result."""
    o = o or {}
    ms = o.get("ms")
    ms = ms if isinstance(ms, (int, float)) and not isinstance(ms, bool) and math.isfinite(ms) else 0
    if o.get("status") == "ok":
        return {"ok": True, "ms": ms}
    if o.get("status") == "error":
        return {"ok": False, "ms": ms, "stopped": True, "interrupted": True} if o.get("ename") == "KeyboardInterrupt" else {"ok": False, "ms": ms}
    return {"ok": False, "ms": 0, "stopped": True}


def _is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def _is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def wave_invalid(entries):
    n = len(entries)
    if n > WAVE_CAPS["entries"]:
        return "too many entries"
    cells = set()
    for k, e in enumerate(entries):
        if not isinstance(e, dict) or not isinstance(e.get("cell"), str) or e["cell"] in cells:
            return "a cell missing or twice"
        cells.add(e["cell"])
        if not isinstance(e.get("auto"), bool) or not _is_num(e.get("est")) or e["est"] < 0:
            return "an entry's policy"
        if ("place" in e and e["place"] not in ("gone", "approval", "never")) if "place" in e else not isinstance(e.get("code"), str):
            return "an entry's code"
        if "place" in e and "code" in e:
            return "a placeholder with code"
        if not isinstance(e.get("parents"), list) or not isinstance(e.get("desc"), list):
            return "an entry's edges"
        for p in e["parents"]:
            if not isinstance(p, dict):
                return "a parent"
            if "in" in p:
                if not _is_int(p["in"]) or p["in"] < 0 or p["in"] >= k:
                    return "a parent not before its entry"
            elif "block" in p:
                b = p["block"]
                if not isinstance(b, dict) or not isinstance(b.get("by"), str) or b.get("why") not in _WHYS:
                    return "a parent's block"
            elif p.get("stale") is not True:
                return "a parent"
        for d in e["desc"]:
            if not _is_int(d) or d <= k or d >= n:
                return "a descendant not after its entry"
    return None


def _is_names(v):
    return isinstance(v, list) and all(isinstance(x, str) and x for x in v)


def wave_envelope_invalid(w):
    """A whole wave as sent, validated before anything is admitted, forgotten or run; None if valid."""
    if not isinstance(w, dict):
        return "the wave's shape"
    if not isinstance(w.get("mode"), str):
        return "the wave's mode"
    p = w.get("policy")
    if not isinstance(p, dict) or not isinstance(p.get("all"), bool) or not (p.get("budget", 0) is None or _is_num(p.get("budget"))) or "budget" not in p:
        return "the wave's policy"
    if not _is_names(w.get("forget")):
        return "the wave's forget"
    if not isinstance(w.get("entries"), list):
        return "the wave's entries"
    for e in w["entries"]:
        if not isinstance(e, dict):
            return "an entry's shape"
        if not _is_names(e.get("defs")):
            return "an entry's defs"
        if "note" in e and not isinstance(e["note"], str):
            return "an entry's note"
        if "place" in e:
            continue
        if not isinstance(e.get("mode"), str):
            return "an entry's mode"
        if "forget" in e and not _is_names(e["forget"]):
            return "an entry's forget"
        if "seed" in e and not isinstance(e["seed"], str):
            return "an entry's seed"
        if "mangle" in e and e["mangle"] is not True and not isinstance(e["mangle"], str):
            return "an entry's mangle"
        if "scoped" in e and not (isinstance(e["scoped"], dict) and all(isinstance(x, str) for x in e["scoped"].values())):
            return "an entry's scoped"
    return wave_invalid(w["entries"])
