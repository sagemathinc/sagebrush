"""Fit the cost model of `newforms` (engine/modsym/src/estimate.rs) to
measurements of the WebAssembly engine, and check it on spaces it was not
fitted on.

    python3 web/atlas/fit-cost.py DIR [--write]

DIR holds, for each set (stored, valid, bounds):
  est-SET.jsonl    the estimator's terms (ATLAS_ESTIMATE=1 ... examples/atlas)
  wasm-SET.jsonl   measured seconds and peak bytes (wasm-measure.mjs: a
                   fresh engine instance per space)
It prints the coefficients for estimate.rs and writes DIR/cost-model.json
(predicted against measured, for the About page).
"""
import json, sys
import numpy as np
from scipy.optimize import nnls

d = sys.argv[1]

def load(name):
    est = {}
    for l in open(f"{d}/est-{name}.jsonl"):
        x = json.loads(l)["ok"]
        est[(x["n"], x["k"], x["bound"])] = x
    rows = []
    for l in open(f"{d}/wasm-{name}.jsonl"):
        m = json.loads(l)
        if m["error"]:
            continue
        e = est.get((m["n"], m["k"], m["bound"]))
        if e:
            rows.append((e, m))
    return rows

def mem_terms(e):
    on = 1.0 if e["dim_new"] else 0.0
    # the order of NEWFORMS_BYTES: base, heilbronn, D_top^2, symbols, B d
    return [1.0, on * e["terms"][1], on * e["dim_top"] ** 2, on * e["symbols"], on * e["bound"] * e["dim_new"]]

def fit(rows, f, y, floor):
    A = np.array([f(e) for e, _ in rows], float)
    Y = np.array([y(m) for _, m in rows], float)
    w = 1 / (Y + floor)  # relative error, with a floor
    c, _ = nnls(A * w[:, None], Y * w)
    return c

def check(rows, c, f, y, name, unit, floor):
    P = np.array([float(np.dot(f(e), c)) for e, _ in rows])
    Y = np.array([y(m) for _, m in rows])
    keep = Y >= floor
    r = P[keep] / Y[keep]
    a = np.maximum(r, 1 / r)
    print(f"  {name:8s} {keep.sum():5d} spaces >= {floor}{unit}: median predicted/actual {np.median(r):.2f}; "
          f"within x1.25 {np.mean(a <= 1.25):.0%}, x1.5 {np.mean(a <= 1.5):.0%}, x2 {np.mean(a <= 2):.0%}; worst x{a.max():.2f}")
    return P, Y

sets = {name: load(name) for name in ["stored", "valid", "bounds"]}
# the larger spaces: half (alternate, by level) join the fit, so that it
# covers their range; the other half are held out and only checked
big = sorted(sets.pop("valid"), key=lambda r: (r[0]["k"], r[0]["n"]))
sets["larger"], sets["valid"] = big[0::2], big[1::2]
train = sets["stored"] + sets["bounds"] + sets["larger"]
tf = lambda e: e["terms"]
secs = fit(train, tf, lambda m: m["seconds"], 0.05)
# centre it: the median of actual / predicted over the fitted spaces is 1
ratio = [m["seconds"] / float(np.dot(tf(e), secs)) for e, m in train if m["seconds"] >= 0.1 and np.dot(tf(e), secs) > 0]
secs = secs * float(np.median(ratio))
mem = fit(train, mem_terms, lambda m: m["bytes"], 1e6)
print("time (seconds, WebAssembly, one thread):")
out = {}
for name, rows in sets.items():
    P, Y = check(rows, secs, tf, lambda m: m["seconds"], name, " s", 0.1)
    out[name] = [[round(p, 3), round(y, 3), f"{e['n']}.{e['k']}.a", e["bound"]] for p, y, (e, _) in zip(P, Y, rows)]
print("peak memory:")
for name, rows in sets.items():
    check(rows, mem, mem_terms, lambda m: m["bytes"], name, " B", 1e6)
# the likely range: actual / predicted at 10% and 90%, over everything
allr = []
for rows in sets.values():
    for e, m in rows:
        p = float(np.dot(tf(e), secs))
        if m["seconds"] >= 0.1 and p > 0:
            allr.append(m["seconds"] / p)
lo, hi = np.quantile(allr, [0.1, 0.9])
print(f"\nconst NEWFORMS_RANGE: [f64; 2] = [{lo:.2f}, {hi:.2f}];")
# a_p (Sato-Tate): seconds and bytes as c X^e
try:
    ap = [json.loads(l) for l in open(f"{d}/ap.jsonl")]
    X = np.log([a["X"] for a in ap])
    for key in ["seconds", "bytes"]:
        Y = np.log([a[key] + (a["parse"] if key == "seconds" else 0) for a in ap])
        e, c = np.polyfit(X, Y, 1)
        r = np.exp(Y - (c + e * X))
        print(f"aplist {key}: {np.exp(c):.4g} * X^{e:.3f}  (actual/predicted {r.min():.2f}..{r.max():.2f})")
except FileNotFoundError:
    pass
names = sets["stored"][0][0]["term_names"]
print("\nconst NEWFORMS_SECONDS: [f64; %d] = [%s];" % (len(secs), ", ".join(f"{c:.4e}" for c in secs)))
print("const NEWFORMS_BYTES: [f64; %d] = [%s];" % (len(mem), ", ".join(f"{c:.4e}" for c in mem)))
for n, c in zip(names, secs):
    print(f"   {n:22s} {c:.4g}")
json.dump(out, open(f"{d}/cost-model.json", "w"))
# --write: put the constants into the estimator
if "--write" in sys.argv:
    import re, os
    rs = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "engine", "modsym", "src", "estimate.rs")
    src = open(rs).read()
    for name, vals, fmt in [("NEWFORMS_SECONDS", secs, "{:.4e}"), ("NEWFORMS_BYTES", mem, "{:.4e}"), ("NEWFORMS_RANGE", [lo, hi], "{:.2f}")]:
        src, n = re.subn(r"const %s: \[f64; (\d+)\] = \[[^\]]*\];" % name, lambda m: "const %s: [f64; %s] = [%s];" % (name, m.group(1), ", ".join(fmt.format(v) for v in vals)), src)
        assert n == 1, name
    open(rs, "w").write(src)
    print("wrote", rs)
