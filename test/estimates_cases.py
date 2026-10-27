# Estimates (lib/sagebrush/_estimates.py; estimates plan r3 PR 2a), the parts
# that need no engine: the fit outcomes at their thresholds, calibration
# (probes, throttling, a stale cache, censored samples, the few-samples
# rule), and the record of a factorization estimate from a fixed engine
# reply (the ECM milestones, never summed).  test/estimates_cases.out is
# written by CPython (python3 -I test/estimates_cases.py >
# test/estimates_cases.out), and the engine must print the same
# (test/estimates.test.ts).
import json
import os
import random
import sys
import tempfile
import types

try:
    import sagebrush._estimates as E
    import sagebrush.records as R
except ImportError:  # CPython, outside the package: the two modules alone
    import importlib.util
    here = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib", "sagebrush")
    pkg = types.ModuleType("sbtest")
    pkg.__path__ = [here]
    sys.modules["sbtest"] = pkg

    def load(name):
        spec = importlib.util.spec_from_file_location("sbtest." + name, os.path.join(here, name + ".py"))
        m = importlib.util.module_from_spec(spec)
        sys.modules["sbtest." + name] = m
        spec.loader.exec_module(m)
        return m
    R = load("records")
    E = load("_estimates")

# ---- the fit outcomes (E4 §4): exactly one branch for every case
print("fits")
C = 1000
for T, H, unk in [(None, None, False), (5, 6, False), (1001, 2000, False), (1000, 1001, False), (1000, 1000, False),
                  (1000, None, False), (1000, None, True), (10, 20, True), (10, 20, False)]:
    print(" ", T, H, "capacity", C, "unknown parts" if unk else "all observed", "->", E.fit_outcome(T, H, C, unk))
print(" ", 5, 6, "capacity", None, "->", E.fit_outcome(5, 6, None, False))
f = E.fits(10, 20, "bound", {"bytes": 1000, "basis": ["MemAvailable"], "unknown_parts": []}, 500)
print("  options when it fits:", f["options"], "| guard kept apart:", f["guard_ceiling_bytes"])

# ---- calibration, on a fake clock
print("calibration")
now = [1000000.0]
cal = E.Calibration("wasm", "node", clock=lambda: now[0], path=None)
print("  prior ns/unit: rho k=1 %.3f, rho k=8 %.3f, ecm k=4 %.3f, prp 1279 bits %.3f"
      % (cal.rate("rho", 1), cal.rate("rho", 8), cal.rate("ecm", 4), cal.rate("prp", 20, 1279)))
# a probe that measures everything twice as slow as the prior
def runner(kind, limbs):
    bits = {"rho": 61 if limbs == 1 else 255, "ecm": 255, "prp": 1279}[kind]
    units = 10 ** 6
    return units, units * 2 * E.prior_rate("wasm", kind, limbs, bits if kind == "prp" else None) * 1e-9, bits
cal.probe(runner)
print("  after a probe at half speed: rho k=1 x%.2f, ecm k=4 x%.2f, prp x%.2f, source %s"
      % (cal.rate("rho", 1) / E.prior_rate("wasm", "rho", 1), cal.rate("ecm", 4) / E.prior_rate("wasm", "ecm", 4),
         cal.rate("prp", 20, 1279) / E.prior_rate("wasm", "prp", 20, 1279), cal.source))
# simulated throttling: 30 samples at the calibrated speed, then samples
# at half that speed; the median follows within 8 samples
base = cal.rate("ecm", 4)
for i in range(30):
    now[0] += 1
    cal.add_sample("ecm", 4, 10 ** 6, 10 ** 6 * base * 1e-9)
print("  after 30 samples at speed: x%.2f" % (cal.rate("ecm", 4) / base))
seen = []
for i in range(10):
    now[0] += 1
    cal.add_sample("ecm", 4, 10 ** 6, 10 ** 6 * base * 2 * 1e-9)
    seen.append(round(cal.rate("ecm", 4) / base, 2))
print("  throttled to half speed, the factor after each sample:", seen)
print("  adapted within 8 samples:", seen[7] == 2.0)
# a censored sample (a stage cut short) counts
cal2 = E.Calibration("native", "cpython", clock=lambda: now[0])
cal2.add_sample("rho", 4, 10 ** 6, 10 ** 6 * cal2.rate("rho", 4) * 3e-9, censored=True)
print("  a censored sample counts: x%.1f, samples %d" % (cal2.rate("rho", 4) / E.prior_rate("native", "rho", 4),
                                                         cal2.record()["samples"]))
# the few-samples rule: no high figure below 20 samples
cal3 = E.Calibration("native", "cpython", clock=lambda: now[0])
for i in range(25):
    if i in (0, 19):
        iv = cal3.interval("rho", 4, 10 ** 9)
        print("  with %d samples: high_s %s" % (iv["samples"], "null" if iv["high_s"] is None else "set"))
    cal3.add_sample("rho", 4, 10 ** 6, 10 ** 6 * E.prior_rate("native", "rho", 4) * (1 + (i % 5) / 10) * 1e-9)
iv = cal3.interval("rho", 4, 10 ** 9)
print("  with %d samples: high_s %s, at least typical: %s" % (iv["samples"], "set" if iv["high_s"] else "null",
                                                              iv["high_s"] >= iv["typical_s"]))
# the cache: a fresh entry is used, a stale one or another key re-probes
d = tempfile.mkdtemp()
path = os.path.join(d, "calibration.json")
c1 = E.Calibration("native", "cpython", clock=lambda: now[0], path=path)
c1.probe(runner=lambda k, l: (10 ** 6, 10 ** 6 * 1.5 * E.prior_rate("native", k, l, 1279 if k == "prp" else None) * 1e-9, 1279))
c2 = E.Calibration("native", "cpython", clock=lambda: now[0] + 3600, path=path)
print("  a fresh cache entry is used:", c2.load(), c2.source)
c3 = E.Calibration("native", "cpython", clock=lambda: now[0] + E.TTL_S + 1, path=path)
print("  past the 7-day TTL it is not:", c3.load())
c4 = E.Calibration("wasm", "node", clock=lambda: now[0], path=path)
print("  nor under another key:", c4.load())

# ---- a factorization estimate from a fixed engine reply
print("factor")
REPLY = {
    "bits": 300, "total_known": False, "notes": [],
    "stages": [
        {"name": "trial division below 2^16", "phase": "trial", "limbs": 5, "units": "1000000", "label": "bound",
         "memory": 70000, "memory_label": "bound", "condition": None},
        {"name": "probable-prime test (Baillie-PSW) of the cofactor", "phase": "prp", "limbs": 5, "units": "2000000",
         "label": "bound", "memory": 640, "memory_label": "bound", "condition": "if a cofactor remains after trial division"},
        {"name": "ECM level B1 = 2000, B2 = 100000: 25 curves", "phase": "ecm", "limbs": 5, "units": "90000000",
         "label": "known", "memory": 200000, "memory_label": "bound", "condition": "if rho found no factor, and no earlier level did"},
    ],
    "levels": [{"b1": 2000, "b2": 100000, "curves": 25, "fixed": True}],
    "ecm": [
        {"digits": 15, "cumulative": [0.97], "milestones": [[0.5, "20000000"], [0.95, "80000000"]],
         "end_chance": 0.97, "units_total": "90000000"},
        {"digits": 20, "cumulative": [0.6], "milestones": [[0.5, "70000000"], [0.95, None]],
         "end_chance": 0.6, "units_total": "90000000"},
    ],
    "rho_chances": [[10, 1.0], [12, 0.42], [14, 0.0055]],
}
E.calibration = lambda: E.Calibration("native", "cpython", clock=lambda: now[0])
E._call = lambda fn, **kw: REPLY
E.host_capacity = lambda: ({"bytes": 10 ** 9, "basis": ["MemAvailable"], "unknown_parts": []}, None)
random.seed(12345)
expected = [random.random() for _ in range(3)]
random.seed(12345)
rec = E._factor_record(2 ** 299 + 1, "factor_integer")
print("  the user's random stream unchanged:", [random.random() for _ in range(3)] == expected)
print("  valid estimate/1:", R.validate(rec) is rec)
print("  total time:", rec["total_time"], "| peak memory:", rec["peak_memory"]["high_bytes"], rec["peak_memory"]["label"],
      "|", rec["fits"]["outcome"])
for s in rec["stages"]:
    t = s["time"]
    print("  %s | work %s %s | %s | success %s" % (
        s["name"], s["work"]["units"], s["work"]["label"], s["condition"],
        None if s["success"] is None else (s["success"]["p_typical"], s["success"]["p_high"])))
# the invariant (daybreak2): milestone intervals overlap and are never summed:
# each milestone's time is that of its own work, not the sum of the earlier
# ones, and the total is unknown, not a sum
ms = [s for s in rec["stages"] if s["success"]]
a, b = ms[0]["time"]["typical_s"], ms[1]["time"]["typical_s"]
print("  15 digits: 95%% time / 50%% time = %.1f (the work's ratio 4.0, not 1 + 4)" % (b / a))
print("  no total made of the milestones:", rec["total_time"] is None)
print("  the model stated:", any("no credit for the curves' torsion" in x for x in rec["assumptions"]),
      "| never added:", any("never add them" in x for x in rec["assumptions"]))

# ---- an operation without an estimator
print("unknown operation")
u = E.estimate(len, [1, 2, 3])
print(" ", u["op"], u["total_time"], u["stages"], u["assumptions"], R.validate(dict(u)) == dict(u))
