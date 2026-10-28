"""Estimates of time and memory (design-estimates-progress r4, cited E4;
estimates plan r3, PR 2a).  Information only: an estimate never runs the
operation, never limits or refuses anything, and never changes a result, a
cache of results or the user's random state.

    sage: from sagebrush import estimate
    sage: e = estimate(factor, 2^200 + 1)
    sage: e["op"], e["total_time"] is None
    ('factor', True)

Every figure carries a label (E4 §2): "known" work counted before its step
runs, a work "bound", or a model's "forecast"; a time is always "estimated"
(work times this machine's calibrated rate, §7); a chance is a "heuristic
model"; and "unknown" is never replaced by a guess.

ECM's figures are milestones (the estimates ruling of Oct 27): for each size
d, one stage per chance q (50% and 95%), "if a factor of at most d digits
exists", whose time is the estimated time until the modelled cumulative
chance reaches q.  The milestones overlap (the 95% one includes the 50% one):
they are never summed, and no total is made of them.

The one intended write is the calibration cache (E4 §7); nothing else is
stored.
"""

import json as _json

from . import records as _records

# ------------------------------------------------------------- the registry

_REGISTRY = {}


def _key(f):
    # (a wrapper names what it wraps: Magma's intrinsics are wrapped by
    # lib/_magma.py's _guarded)
    while not isinstance(f, str) and getattr(f, "__wrapped__", None) is not None:
        f = f.__wrapped__
    if isinstance(f, str):
        mod, _, name = f.rpartition(".")
    else:
        mod, name = getattr(f, "__module__", None), getattr(f, "__qualname__", getattr(f, "__name__", None))
    # (the CPython package loads lib's modules as sagebrush._sagelib.X; the
    # browser and the CLI as X: one key for both)
    if isinstance(mod, str) and mod.startswith("sagebrush._sagelib."):
        mod = mod[len("sagebrush._sagelib."):]
    return (mod, name)


def _name(f):
    return f.rpartition(".")[2] if isinstance(f, str) else getattr(f, "__name__", repr(f))


def estimator(*targets):
    """Registers the decorated function as the estimator of each target (a
    callable, or its "module.qualname"): estimator(*args, **kwds) returns a
    sagebrush.estimate/1 record, from its arguments' sizes and cheap
    structure only, in under 10 ms (E4 §3)."""
    def reg(fn):
        for t in targets:
            _REGISTRY[_key(t)] = fn
        return fn
    return reg


def estimate(f, *args, **kwds):
    """The time and memory estimate of f(*args, **kwds), as a
    sagebrush.estimate/1 record; f is never called.  An operation without an
    estimator gets an estimate whose total is unknown."""
    fn = _REGISTRY.get(_key(f))
    rec = fn(*args, **kwds) if fn is not None else _no_estimator(_name(f))
    return Estimate(rec)


class Estimate(dict):
    """A sagebrush.estimate/1 record (a dict), shown as text."""

    def to_json(self):
        return _records.to_json(dict(self))

    def __repr__(self):
        return format_text(self)


# ------------------------------------------------------------ the records

def _mem_unknown(why):
    return {"typical_bytes": None, "high_bytes": None, "label": "unknown", "assumptions": [why]}


def _no_estimator(name):
    return {
        "schema": "sagebrush.estimate/1", "op": name, "args_summary": "",
        "total_time": None,
        "peak_memory": _mem_unknown("no estimate is available for %s" % name),
        "fits": fits(None, None, "unknown"),
        "stages": [],
        "assumptions": ["no estimate is available for %s" % name],
        "calibration": calibration().record(source="none"),
    }


# -------------------------------------------------------------- the fits

_UNKNOWN_WASM = ("wasm memory growth (not probed)",)
_UNKNOWN_TAB = ("the tab's other memory pressure",)


def _host():
    """(runtime, host): ("wasm" or "native", "browser", "node" or "cpython")."""
    try:
        import _sbengine
    except ImportError:
        return "native", "cpython"
    js_host = getattr(_sbengine, "js_host", None)
    if js_host is None:
        return "native", "cpython"
    h = str(js_host())
    return "wasm", ("browser" if "browser" in h.lower() else "node")


def host_capacity():
    """E4 §4's host_capacity: {bytes, basis, unknown_parts}, from item D's
    capacity() (the least remaining memory over every observed ceiling),
    with the parts a wasm host can't observe listed as unknown; and the
    memory guard's ceiling (an admission figure, not a capacity)."""
    import _capacity
    cap = _capacity.capacity()
    unknown = list(cap.get("unknown_parts", ()))
    runtime, host = _host()
    if runtime == "wasm":
        unknown += [u for u in _UNKNOWN_WASM if u not in unknown]
        if host == "browser":
            unknown += [u for u in _UNKNOWN_TAB if u not in unknown]
    basis = [b["source"] for b in cap.get("basis", ())]
    return ({"bytes": cap["bytes"], "basis": basis, "unknown_parts": unknown},
            _capacity.effective_guard_bytes(cap))


def _options():
    """Item D's routes to more memory, in its words (lib/_memguard.py)."""
    try:
        import _memguard
        text = _memguard._TEXT[_memguard.where()]
    except Exception:
        return []
    out, cur = [], None
    for line in text.split("\n"):
        if line.startswith("- "):
            if cur:
                out.append(cur)
            cur = line[2:]
        elif cur is not None and line.startswith("  "):
            cur += " " + line.strip()
    if cur:
        out.append(cur)
    return out


def fit_outcome(T, H, C, capacity_unknown_parts):
    """E4 §4's disjoint branches, in order: T and H the estimate's typical
    and high bytes (None: unknown), C the observed capacity (None: unknown)."""
    if T is None or C is None:
        return "unknown"
    if T > C:
        return "estimated to exceed the observed capacity"
    if H is not None and H > C:
        return "uncertain"
    if H is None:
        return ("estimated to fit, high unavailable (observed capacity)" if capacity_unknown_parts
                else "estimated to fit, high unavailable")
    if capacity_unknown_parts:
        return "estimated to fit the observed capacity"
    return "estimated to fit"


def fits(typical, high, label, capacity=None, guard=None):
    """The fits record of an estimate of `typical`/`high` bytes (label as
    peak_memory's) against `capacity` (host_capacity()'s first value; None:
    unknown)."""
    if capacity is None:
        capacity = {"bytes": None, "basis": [], "unknown_parts": ["not observed"]}
    out = fit_outcome(typical, high, capacity["bytes"], bool(capacity["unknown_parts"]))
    return {
        "outcome": out,
        "estimate_bytes": {"typical": typical, "high": high, "label": label},
        "host_capacity": capacity,
        "guard_ceiling_bytes": guard,
        "options": [] if out == "estimated to fit" else _options(),
    }


# ------------------------------------------------------------ calibration

# The priors: ns per charged unit, measured on VM2 (an AMD EPYC 7B13, one
# core, node v26.12.0 WASI for wasm) on Oct 24 (plan-factor-budget r13 §8),
# against the same closed forms (nf/cost.rs).  The ECM figure was measured
# at k = 4 and is scaled by the Montgomery product's rate at other k.
PRIORS = {
    "native": {
        "mont": {1: 0.45, 2: 0.64, 4: 0.54, 8: 0.62, 16: 0.69},
        "ecm4": 0.73,
        "prp": {1279: 0.034, 4423: 0.021, 9689: 0.020},
        "trial": 0.35, "sieve": 0.77, "roots": 0.25,
    },
    "wasm": {
        "mont": {1: 1.95, 2: 2.31, 4: 2.76, 8: 3.15, 16: 3.09},
        "ecm4": 2.08,
        "prp": {1279: 0.47, 4423: 0.095, 9689: 0.077},
        "trial": 0.66, "sieve": 0.68, "roots": 1.23,
    },
}
PRIOR_SOURCE = "VM2 priors (plan-factor-budget r13 §8, Oct 24)"
# the cost model's version: part of the cache key until the engine exposes
# its build id
MODEL = "factor-cost/1"
TTL_S = 7 * 86400
PROBE_BUDGET_S = 0.05
HALF_LIFE_SAMPLES = 8
HALF_LIFE_S = 3600.0
FEW_SAMPLES = 20
# the probes, in order, until PROBE_BUDGET_S is spent: (kind, limbs)
PROBES = (("rho", 1), ("rho", 4), ("ecm", 4), ("prp", 20))


def _interp_loglog(table, x):
    """Piecewise linear in (log x, log y) over table {x: y}, flat outside."""
    import math
    xs = sorted(table)
    if x <= xs[0]:
        return table[xs[0]]
    if x >= xs[-1]:
        return table[xs[-1]]
    for a, b in zip(xs, xs[1:]):
        if a <= x <= b:
            t = (math.log(x) - math.log(a)) / (math.log(b) - math.log(a))
            return math.exp(math.log(table[a]) + t * (math.log(table[b]) - math.log(table[a])))
    return table[xs[-1]]


def _c_mont(k):
    return 2 * k * k + k + 8


def prior_rate(runtime, phase, limbs, bits=None):
    """The prior ns per unit of `phase` at `limbs` limbs (E4 §7's buckets)."""
    P = PRIORS[runtime]
    if phase == "rho":
        return _interp_loglog(P["mont"], limbs)
    if phase == "ecm":
        return P["ecm4"] * _interp_loglog(P["mont"], limbs) / _interp_loglog(P["mont"], 4)
    if phase == "prp":
        return _interp_loglog(P["prp"], bits if bits else 64 * limbs)
    return P[phase]


def bucket(runtime, phase, limbs):
    """A calibration bucket: (runtime, phase, size class), the size class
    the limb count's power of two (1, 2, 4, ..., 64, >= 128)."""
    k = 1
    while k < limbs and k < 128:
        k *= 2
    return "%s/%s/%d" % (runtime, phase, k)


# which bucket families a probe rescales
_FAMILIES = {"rho": ("rho", "ecm", "trial", "roots"), "ecm": ("ecm",), "prp": ("prp", "roots")}


class Calibration:
    """This machine's rates: the priors, rescaled per family by the probes
    (at most PROBE_BUDGET_S at first use) and per bucket by the samples
    (E4 §7: normalized residuals, an exponentially weighted median with a
    half-life of 8 samples or 1 hour, whichever is shorter).  Private state:
    it draws no random numbers and touches no computation cache."""

    def __init__(self, runtime, host, clock=None, path=None):
        import time
        self.runtime, self.host = runtime, host
        self.clock = clock or time.time
        self.path = path
        self.family = {}      # family -> residual from the probes
        self.samples = {}     # bucket -> [(t, residual, censored)]
        self.probed_at = None
        self.source = "prior"

    # ---- the key and the cache
    def key(self):
        import os
        import sys
        js = ""
        if self.runtime == "wasm":
            try:
                import _sbengine
                js = str(_sbengine.js_engine())
            except Exception:
                js = "?"
        try:
            arch = os.uname().machine
        except Exception:
            arch = "wasm32" if self.runtime == "wasm" else "?"
        return "|".join([MODEL, self.runtime, self.host, js, sys.version.split()[0], arch, "threads=1"])

    def load(self):
        if not self.path:
            return False
        try:
            with open(self.path) as f:
                d = _json.load(f)
        except Exception:
            return False
        e = d.get(self.key()) if isinstance(d, dict) else None
        if not e or self.clock() - e.get("probed_at", 0) > TTL_S:
            return False
        self.family = dict(e.get("family", {}))
        self.samples = {b: [tuple(s) for s in v] for b, v in e.get("samples", {}).items()}
        self.probed_at = e["probed_at"]
        self.source = "cache"
        return True

    def save(self):
        if not self.path:
            return
        import os
        try:
            try:
                with open(self.path) as f:
                    d = _json.load(f)
                if not isinstance(d, dict):
                    d = {}
            except Exception:
                d = {}
            d[self.key()] = {"probed_at": self.probed_at, "family": self.family,
                             "samples": {b: [list(s) for s in v[-64:]] for b, v in self.samples.items()}}
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            tmp = self.path + ".tmp"
            with open(tmp, "w") as f:
                _json.dump(d, f)
            os.replace(tmp, self.path)
        except Exception:
            pass

    # ---- probes
    def ensure(self):
        """Probes once (at most PROBE_BUDGET_S) unless a fresh cache entry
        exists; returns the seconds spent probing (0 if none)."""
        if self.probed_at is not None and self.clock() - self.probed_at <= TTL_S:
            return 0.0
        if self.load():
            return 0.0
        return self.probe()

    def probe(self, runner=None):
        import time
        runner = runner or _engine_probe
        t0 = time.perf_counter()
        found = {}
        for kind, limbs in PROBES:
            if time.perf_counter() - t0 > PROBE_BUDGET_S:
                break
            r = runner(kind, limbs)
            if not r:
                continue
            units, seconds, bits = r
            if units > 0 and seconds > 0:
                measured = seconds * 1e9 / units
                found.setdefault(kind, []).append(measured / prior_rate(self.runtime, kind, limbs, bits))
        # one residual per family: the median of its probes
        self.family = {k: _median(v) for k, v in found.items()}
        self.probed_at = self.clock()
        self.source = "probe"
        self.save()
        return time.perf_counter() - t0

    # ---- samples (from progress deltas: PR 3; here through the test hook)
    def add_sample(self, phase, limbs, units, seconds, censored=False, bits=None):
        """One sample: `units` done in `seconds` (a progress delta of at least
        0.5 s, or a stage cut short: censored), as a normalized residual."""
        if units <= 0 or seconds <= 0:
            return
        res = (seconds * 1e9 / units) / self.rate(phase, limbs, bits, samples=False)
        self.samples.setdefault(bucket(self.runtime, phase, limbs), []).append((self.clock(), res, bool(censored)))

    def _sample_factor(self, b):
        """(the weighted median residual, the sample count) of bucket b."""
        s = self.samples.get(b)
        if not s:
            return 1.0, 0
        now = self.clock()
        n = len(s)
        ws = []
        for i, (t, r, _c) in enumerate(s):
            age_n = n - 1 - i
            w = min(0.5 ** (age_n / HALF_LIFE_SAMPLES), 0.5 ** (max(0.0, now - t) / HALF_LIFE_S))
            ws.append((r, w))
        return _wmedian(ws), n

    def rate(self, phase, limbs, bits=None, samples=True):
        """ns per unit of `phase` at `limbs` limbs on this machine."""
        fam = None
        for f, members in _FAMILIES.items():
            if phase in members and f in self.family:
                fam = self.family[f] if fam is None else fam
        r = prior_rate(self.runtime, phase, limbs, bits) * (fam if fam is not None else 1.0)
        if samples:
            r *= self._sample_factor(bucket(self.runtime, phase, limbs))[0]
        return r

    def interval(self, phase, limbs, units, bits=None):
        """E4's Interval for `units` of `phase`: typical = units x rate;
        high only from 20 samples or the validation corpus's spread, which
        this build doesn't have yet (PR 2b): null, never a made-up range."""
        n = self._sample_factor(bucket(self.runtime, phase, limbs))[1]
        typical = units * self.rate(phase, limbs, bits) * 1e-9
        high = None
        if n >= FEW_SAMPLES:
            s = self.samples[bucket(self.runtime, phase, limbs)]
            r90 = _quantile([r for _t, r, _c in s], 0.9)
            r50 = _wmedian([(r, 1.0) for _t, r, _c in s])
            high = typical * max(1.0, r90 / r50)
        return {"typical_s": typical, "high_s": high, "samples": n, "label": "estimated time"}

    def record(self, source=None):
        import time
        return {"runtime": self.runtime, "engine_build": MODEL, "machine_key": self.key(),
                "source": source or self.source, "samples": sum(len(v) for v in self.samples.values()),
                "age_s": 0.0 if self.probed_at is None else max(0.0, self.clock() - self.probed_at)}


def _median(xs):
    xs = sorted(xs)
    n = len(xs)
    return xs[n // 2] if n % 2 else (xs[n // 2 - 1] + xs[n // 2]) / 2


def _wmedian(pairs):
    pairs = sorted(pairs)
    tot = sum(w for _r, w in pairs)
    acc = 0.0
    for r, w in pairs:
        acc += w
        if acc >= tot / 2:
            return r
    return pairs[-1][0]


def _quantile(xs, q):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(q * len(xs)))]


_CAL = None


def calibration():
    """This session's Calibration (made on first use)."""
    global _CAL
    if _CAL is None:
        runtime, host = _host()
        import os
        # (SAGEBRUSH_CALIBRATION_CACHE: another file, or "" for none, as the
        # tests use; the browser keeps its rates for the session only)
        path = os.environ.get("SAGEBRUSH_CALIBRATION_CACHE")
        if path is None and host != "browser":
            try:
                path = os.path.join(os.path.expanduser("~"), ".cache", "sagebrush", "calibration.json")
            except Exception:
                path = None
        path = path or None
        _CAL = Calibration(runtime, host, path=path)
    return _CAL


def _call(fn, **args):
    """One engine call (a hook for the tests)."""
    from ._engine import call
    return call(fn, **args)


def _engine_probe(kind, limbs):
    """One probe through the engine: (units, seconds, bits) or None."""
    import time
    t = time.perf_counter()
    try:
        r = _call("cost_probe", kind=kind, limbs=int(limbs))
        s = time.perf_counter() - t
        return int(r["units"]), s, r.get("bits")
    except Exception:
        return None


# -------------------------------------------------- integer factorization

_TRIAL_BITS_SMALL = 40   # sage_all.factor: below 2^40 the Python path runs


def _factor_record(n, op):
    """The estimate of factor(n) for a nonzero integer n (sage_all.factor,
    sagebrush.nf.factor_integer): E4 §5.1."""
    return _factor_record_bits(abs(int(n)).bit_length(), op)


def _factor_record_bits(bits, op):
    """_factor_record's estimate for an integer of `bits` bits (the record
    reads only the size)."""
    cal = calibration()
    probe_s = cal.ensure()
    stages, assumptions = [], []
    cap, guard = host_capacity()
    if bits <= _TRIAL_BITS_SMALL and op in ("factor", "Factorization"):
        assumptions.append("below 2^40, factor() runs in Python (trial division and rho), "
                           "which this build has no model for")
        rec = {"schema": "sagebrush.estimate/1", "op": op, "args_summary": "an integer of %d bits" % bits,
               "total_time": None, "peak_memory": _mem_unknown("the Python path is not modelled"),
               "fits": fits(None, None, "unknown", cap, guard), "stages": [], "assumptions": assumptions,
               "calibration": cal.record()}
        return rec
    e = _call("factor_estimate", bits=bits)
    k_of = {}
    for s in e["stages"]:
        # (exact decimal counts; null is beyond the engine's model: unknown,
        # with no time derived)
        units = None if s["units"] is None else int(s["units"])
        mem = None if s["memory"] is None else int(s["memory"])
        bb = bits if s["phase"] == "prp" else None
        stages.append({
            "name": s["name"],
            "work": None if units is None else {"units": units, "label": s["label"]},
            "time": None if units is None else cal.interval(s["phase"], s["limbs"], units, bb),
            "memory": {"typical_bytes": None, "high_bytes": mem, "label": s["memory_label"],
                       "assumptions": ["total live bytes above the input while this stage runs"]},
            "condition": s["condition"],
            "success": None,
        })
        k_of[s["phase"]] = s["limbs"]
        if s["phase"] == "prp" and op in ("factor", "Factorization"):
            # sage_all.factor then tests every prime factor found: at most
            # one test of n's size in all (the test's cost grows faster
            # than the size)
            stages.append(dict(stages[-1], name="the final test of every factor found (Baillie-PSW)",
                               condition=None))
    # ECM's milestones: per size d, the work until the modelled cumulative
    # chance reaches 50% and 95% (or the chance by the schedule's end)
    k = k_of.get("ecm", 1)
    ecm_mems = [s["memory"] for s in e["stages"] if s["phase"] == "ecm"]
    ecm_mem = None if None in ecm_mems else max([int(m) for m in ecm_mems] or [0])
    ecm_label = "unknown" if ecm_mem is None else "bound"
    for t in e["ecm"]:
        d = t["digits"]
        for q, u in t["milestones"]:
            if u is None:
                continue
            units = int(u)
            stages.append({
                "name": "ECM: a factor of at most %d digits, a modelled %d%% chance" % (d, round(q * 100)),
                "work": {"units": units, "label": "known"},
                "time": cal.interval("ecm", k, units),
                "memory": {"typical_bytes": None, "high_bytes": ecm_mem, "label": ecm_label,
                           "assumptions": ["the largest prime table and stage 2's buffers up to that level"]},
                "condition": "if a factor of at most %d digits exists" % d,
                "success": {"p_typical": q, "p_high": q, "label": "heuristic model"},
            })
        if t["end_chance"] < 0.95:
            units = int(t["units_total"])
            stages.append({
                "name": "ECM: a factor of at most %d digits, by the end of the modelled schedule" % d,
                "work": {"units": units, "label": "known"},
                "time": cal.interval("ecm", k, units),
                "memory": {"typical_bytes": None, "high_bytes": ecm_mem, "label": ecm_label, "assumptions": []},
                "condition": "if a factor of at most %d digits exists" % d,
                "success": {"p_typical": float(t["end_chance"]), "p_high": float(t["end_chance"]),
                            "label": "heuristic model"},
            })
    if e["ecm"]:
        assumptions.append(
            "ECM's chances are a heuristic model: each curve's group order is taken as a random integer "
            "near the factor, smooth up to B1 but for at most one prime up to B2 (Dickman's rho), with no "
            "credit for the curves' torsion, and the curves are independent; they are modelled, not "
            "measured on this input, and are not confidence limits")
        assumptions.append(
            "the milestones overlap (the 95% work includes the 50% work): never add them; each is the "
            "time from ECM's start until that chance, if a factor of at most that size exists")
        assumptions.append("the time to find one factor is not the whole factorization: further factors "
                           "can need further work")
    if e["rho_chances"]:
        assumptions.append("rho's one attempt finds a factor of 10 / 12 / 14 digits with a modelled chance of "
                           + " / ".join("%d%%" % round(100 * p) for _d, p in e["rho_chances"])
                           + " (the random-map model)")
    assumptions += list(e["notes"])
    if probe_s:
        assumptions.append("this machine's rates were probed now (%.0f ms, once per build and machine)"
                           % (probe_s * 1000))
    if any(s["time"] is not None and s["time"]["high_s"] is None for s in stages):
        assumptions.append("a stage's high time needs 20 timed samples of its kind and size on this machine or the "
                           "validation corpus (a later change): unknown where none is shown")
    if any(s["work"] is None for s in stages):
        assumptions.append("a stage's work shown as unknown is beyond the model: no time is derived from it")
    # the total: known only when trial division alone factors n
    total = None
    if e["total_known"]:
        s0 = stages[0]
        total = dict(s0["time"])
    # peak memory: the largest stage figure, with the weakest label of those
    # reaching it (every figure here is a bound)
    mems = [s["memory"] for s in e["stages"]]
    if None in mems:
        peak = None
        peak_mem = _mem_unknown("a stage's memory is beyond the model")
    else:
        peak = max([int(m) for m in mems] or [0])
        peak_mem = {"typical_bytes": None, "high_bytes": peak, "label": "bound",
                    "assumptions": ["the largest live allocation above the input, over the stages modelled",
                                    "the fit compares this bound with the capacity"]}
    rec = {
        "schema": "sagebrush.estimate/1", "op": op, "args_summary": "an integer of %d bits" % bits,
        "total_time": total, "peak_memory": peak_mem,
        # (a bound covers the typical figure too: E4 §1's "at most 6 MB
        # (counted bound); estimated to fit")
        "fits": fits(peak, peak, peak_mem["label"], cap, guard),
        "stages": stages, "assumptions": assumptions, "calibration": cal.record(),
    }
    return rec


@estimator("sage_all.factor")
def _estimate_factor(n, proof=None, **kwds):
    if isinstance(n, int) and n != 0:
        rec = _factor_record(n, "factor")
        if proof:
            rec["assumptions"].append("proof=True also proves each prime factor: not estimated")
            rec["total_time"] = None
        return rec
    return _no_estimator("factor")


@estimator("_magma._factorization")
def _estimate_magma_factorization(n):
    if isinstance(n, int) and not isinstance(n, bool) and n != 0:
        return _factor_record(n, "Factorization")
    return _no_estimator("Factorization")


@estimator("sagebrush.nf.factor_integer")
def _estimate_factor_integer(n):
    return _factor_record(int(n), "factor_integer")


# ------------------------------------------------------------------- text

def _t(s):
    if s is None:
        return "unknown"
    if s < 1:
        return "%.2g s" % s
    if s < 120:
        return "%.0f s" % s
    if s < 7200:
        return "%.0f min" % (s / 60)
    return "%.1f h" % (s / 3600)


def _b(n):
    if n is None:
        return "unknown"
    for u, d in (("GB", 1 << 30), ("MB", 1 << 20), ("kB", 1 << 10)):
        if n >= d:
            return "%.1f %s" % (n / d, u)
    return "%d B" % n


def format_text(rec):
    """The record as the text E4 §1 shows."""
    c = rec["calibration"]
    lines = ["Estimate for %s(%s), %s on this machine (%s, %d samples)"
             % (rec["op"], rec["args_summary"], c["runtime"], c["source"], c["samples"])]
    tt = rec["total_time"]
    lines.append("  total time: " + ("estimated %s" % _t(tt["typical_s"]) if tt else "unknown"))
    pm = rec["peak_memory"]
    lines.append("  peak memory: " + ("at most %s (%s)" % (_b(pm["high_bytes"]), pm["label"])
                                       if pm["high_bytes"] is not None else "unknown")
                 + "; " + rec["fits"]["outcome"])
    for s in rec["stages"]:
        t = s["time"]
        w = s["work"]
        bits = ["  " + s["name"]]
        if w:
            bits.append("%s work %s units" % (w["label"], w["units"]))
        else:
            bits.append("work unknown")
        if t:
            bits.append("estimated %s" % _t(t["typical_s"])
                        + (" (up to %s)" % _t(t["high_s"]) if t["high_s"] is not None else ""))
        else:
            bits.append("time unknown")
        if s["condition"]:
            bits.append(s["condition"])
        lines.append(": ".join(bits[:1]) + (": " + "; ".join(bits[1:]) if len(bits) > 1 else ""))
    for a in rec["assumptions"]:
        lines.append("  (%s)" % a)
    return "\n".join(lines)
