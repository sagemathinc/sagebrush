"""Sweep the elementary functions of Sagebrush's Python runtime against CPython's.

    python3 scripts/libm-sweep.py [-n N] [--seed S] [--only f,g] [--json out.json]
                                  [--cli dist/src/cli.js]

Run under CPython 3.14 with mpmath (on a test VM: Sagebrush's CLI must be built). For
each function, N inputs (random bit patterns, log-uniform magnitudes, a typical range,
neighbours of the special points, and edge cases, all in the function's domain) are
evaluated by Sagebrush's math module and its numpy ufunc (in one CLI process), and by
CPython's math (the C library's: glibc on Linux) and NumPy, as bits. For every input
where Sagebrush's math differs from CPython's, mpmath (at 120 bits and more) gives the
correctly rounded value, so each difference is attributed:

    sb-wrong     Sagebrush is not correctly rounded and the C library is
    libc-wrong   the C library is not correctly rounded and Sagebrush is
    both-wrong   neither is
    error        one raised (ValueError, OverflowError) where the other did not

The report is a table per function: inputs, differences (math, numpy ufunc), their
attribution, and the largest error in ULPs on each side. Re-run it when Node (V8) or the
runtime's libm ports (src/runtime/fdlibm.ts, libm.ts) change.
"""
import argparse
import json
import math
import os
import random
import struct
import subprocess
import sys
import tempfile
import time

import mpmath

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# name: (domain, typical range, numpy ufunc, mpmath function)
UNARY = {
    "exp": ("all", (-50, 50), "exp", mpmath.exp),
    "expm1": ("all", (-5, 5), "expm1", mpmath.expm1),
    "exp2": ("all", (-60, 60), "exp2", lambda x: mpmath.power(2, x)),
    "log": ("pos", (0, 10), "log", mpmath.log),
    "log1p": ("gtm1", (-0.9, 5), "log1p", mpmath.log1p),
    "log2": ("pos", (0, 10), "log2", lambda x: mpmath.log(x, 2)),
    "log10": ("pos", (0, 10), "log10", mpmath.log10),
    "sqrt": ("pos", (0, 10), "sqrt", mpmath.sqrt),
    "cbrt": ("all", (-10, 10), "cbrt", lambda x: mpmath.sign(x) * mpmath.cbrt(abs(x))),  # (the real root: mpmath.cbrt of a negative is complex)
    "sin": ("all", (-10, 10), "sin", mpmath.sin),
    "cos": ("all", (-10, 10), "cos", mpmath.cos),
    "tan": ("all", (-10, 10), "tan", mpmath.tan),
    "asin": ("unit", (-1, 1), "arcsin", mpmath.asin),
    "acos": ("unit", (-1, 1), "arccos", mpmath.acos),
    "atan": ("all", (-10, 10), "arctan", mpmath.atan),
    "sinh": ("all", (-10, 10), "sinh", mpmath.sinh),
    "cosh": ("all", (-10, 10), "cosh", mpmath.cosh),
    "tanh": ("all", (-5, 5), "tanh", mpmath.tanh),
    "asinh": ("all", (-10, 10), "arcsinh", mpmath.asinh),
    "acosh": ("ge1", (1, 10), "arccosh", mpmath.acosh),
    "atanh": ("open_unit", (-1, 1), "arctanh", mpmath.atanh),
}
# name: (numpy ufunc, mpmath function); the inputs are pairs
BINARY = {
    "pow": ("power", mpmath.power),
    "atan2": ("arctan2", mpmath.atan2),
    "hypot": ("hypot", mpmath.hypot),
}

TINY = 5e-324
EDGES = [0.0, -0.0, 1.0, -1.0, 0.5, -0.5, 2.0, -2.0, 3.0, 10.0, 100.0, 1e-300, TINY, -TINY,
         2.2250738585072014e-308, 1.7976931348623157e308, -1.7976931348623157e308,
         math.inf, -math.inf, math.nan, math.pi, math.pi / 2, math.pi / 4, math.e,
         709.782712893384, -745.1332191019411, 1e-8, 1e8, 0.75, 1.5, 7.25]


def to_domain(x, dom):
    """x mapped into the domain (finite x; the edges are kept as they are)"""
    if dom == "all":
        return x
    if dom == "pos":
        return abs(x)
    if dom == "ge1":
        a = abs(x)
        return a if a >= 1 else (1 / a if a > 0 else 1.0)
    if dom == "unit":
        return x if abs(x) <= 1 else 1 / x
    if dom == "open_unit":
        y = x if abs(x) < 1 else 1 / x
        return y if abs(y) < 1 else 0.5
    if dom == "gtm1":
        return x if x > -1 else -1 / x - 1 + 1e-300 if x != -1 else -0.5
    raise ValueError(dom)


def finite_from_bits(rng):
    while True:
        x = struct.unpack("<d", rng.getrandbits(64).to_bytes(8, "little"))[0]
        if math.isfinite(x):
            return x


def unary_inputs(name, n, rng):
    dom, (lo, hi), _, _ = UNARY[name]
    xs = list(EDGES)
    # (neighbours of the special points: 0, 1, -1, the typical range's ends, a few ulps away)
    for c in (0.0, 1.0, -1.0, 2.0, 0.5, lo, hi):
        y = c
        for _ in range(50):
            y = math.nextafter(y, math.inf)
            xs.append(y)
        y = c
        for _ in range(50):
            y = math.nextafter(y, -math.inf)
            xs.append(y)
    if name in ("sin", "cos", "tan"):
        # (the doubles nearest multiples of pi/2, and neighbours: the reduced argument is tiny there)
        for m in [1, 2, 3, 4, 5, 6, 7, 10, 100, 1000, 12345, 2 ** 19, 2 ** 20 - 1, 2 ** 25 + 1, 2 ** 40 + 3]:
            y = m * math.pi / 2
            for _ in range(4):
                y = math.nextafter(y, -math.inf)
            for _ in range(9):
                xs.append(y)
                xs.append(-y)
                y = math.nextafter(y, math.inf)
    k = (n - len(xs)) // 3
    for _ in range(k):
        xs.append(finite_from_bits(rng))
    for _ in range(k):
        xs.append(rng.choice((1, -1)) * 2.0 ** rng.uniform(-1074, 1023.99))
    while len(xs) < n:
        xs.append(rng.uniform(lo, hi))
    return [x if not math.isfinite(x) else to_domain(x, dom) for x in xs]


def binary_inputs(name, n, rng):
    pairs = [(a, b) for a in EDGES[:20] for b in EDGES[:20]]
    k = (n - len(pairs)) // 3
    for _ in range(k):
        pairs.append((finite_from_bits(rng), finite_from_bits(rng)))
    for _ in range(k):
        a = rng.choice((1, -1)) * 2.0 ** rng.uniform(-60, 60)
        b = rng.uniform(-60, 60) if rng.random() < 0.5 else float(rng.randint(-60, 60))
        pairs.append((abs(a) if name == "pow" and rng.random() < 0.7 else a, b))
    while len(pairs) < n:
        pairs.append((rng.uniform(-10, 10), rng.uniform(-10, 10)))
    return pairs


def pack(xs):
    return struct.pack("<%dd" % len(xs), *xs)


def unpack(b):
    return list(struct.unpack("<%dd" % (len(b) // 8), b))


# Sagebrush's side: one CLI process; each result as a double and a flag (0 value, 1 error)
SB_PROGRAM = r'''
import math, struct, sys
import numpy as np
d = sys.argv[1] if len(sys.argv) > 1 else DIR
def rd(p):
    b = open(p, "rb").read()
    return list(struct.unpack("<%dd" % (len(b) // 8), b))
def wr(p, xs):
    # (in chunks: a call with 300000 arguments exceeds the runtime's recursion limit)
    open(p, "wb").write(b"".join(struct.pack("<%dd" % len(xs[i:i + 10000]), *xs[i:i + 10000]) for i in range(0, len(xs), 10000)))
for name, uf, arity in JOBS:
    f = getattr(math, name)
    if arity == 1:
        xs = rd(d + "/" + name + ".x")
        out, err = [], bytearray(len(xs))
        for i, x in enumerate(xs):
            try:
                out.append(f(x))
            except (ValueError, OverflowError):
                out.append(0.0)
                err[i] = 1
        npo = getattr(np, uf)(np.array(xs, dtype=float)).tolist()
    else:
        a = rd(d + "/" + name + ".x")
        b = rd(d + "/" + name + ".y")
        out, err = [], bytearray(len(a))
        for i in range(len(a)):
            try:
                out.append(f(a[i], b[i]))
            except (ValueError, OverflowError, ZeroDivisionError):
                out.append(0.0)
                err[i] = 1
        npo = getattr(np, uf)(np.array(a, dtype=float), np.array(b, dtype=float)).tolist()
    wr(d + "/" + name + ".sb", out)
    open(d + "/" + name + ".sbe", "wb").write(bytes(err))
    wr(d + "/" + name + ".np", npo)
    print("done", name, flush=True)
'''


def bits(x):
    return struct.unpack("<Q", struct.pack("<d", x))[0]


def same(a, b):
    return (a != a and b != b) or bits(a) == bits(b)


def correctly_rounded(fn, args):
    """the correctly rounded double of fn(args), or None where it is not a real number"""
    e = max([0] + [math.frexp(a)[1] for a in args if math.isfinite(a) and a != 0])
    with mpmath.workprec(140 + e):
        try:
            r = fn(*[mpmath.mpf(a) for a in args])
        except (ValueError, ZeroDivisionError):
            return None
        if isinstance(r, mpmath.mpc):
            return None
    return float(r)


def ulps(x, ref):
    """|x - ref| in units of ref's last place"""
    if not (math.isfinite(x) and math.isfinite(ref)):
        return 0.0 if same(x, ref) else math.inf
    return abs(x - ref) / math.ulp(ref) if ref != 0 else (0.0 if x == 0 else math.inf)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("-n", type=int, default=300000)
    ap.add_argument("--seed", type=int, default=20261016)
    ap.add_argument("--only", default="")
    ap.add_argument("--json", default="")
    ap.add_argument("--cli", default=os.path.join(ROOT, "dist", "src", "cli.js"))
    ap.add_argument("--max-referee", type=int, default=20000, help="mpmath checks per function at most")
    a = ap.parse_args()
    names = [s for s in a.only.split(",") if s] or list(UNARY) + list(BINARY)
    try:
        import numpy as np
    except ImportError:
        np = None
    tmp = tempfile.mkdtemp(prefix="libm-sweep-")
    inputs = {}
    for name in names:
        rng = random.Random("%s:%d" % (name, a.seed))
        if name in UNARY:
            xs = unary_inputs(name, a.n, rng)
            inputs[name] = (xs,)
            open(os.path.join(tmp, name + ".x"), "wb").write(pack(xs))
        else:
            ps = binary_inputs(name, a.n, rng)
            inputs[name] = ([p[0] for p in ps], [p[1] for p in ps])
            open(os.path.join(tmp, name + ".x"), "wb").write(pack(inputs[name][0]))
            open(os.path.join(tmp, name + ".y"), "wb").write(pack(inputs[name][1]))
    jobs = [(nm, UNARY[nm][2] if nm in UNARY else BINARY[nm][0], 1 if nm in UNARY else 2) for nm in names]
    prog = "JOBS = %r\nDIR = %r\n" % (jobs, tmp) + SB_PROGRAM
    t0 = time.time()
    subprocess.run(["node", a.cli, "-c", prog], check=True, cwd=tmp)
    report = {"node": subprocess.run(["node", "--version"], capture_output=True, text=True).stdout.strip(),
              "python": sys.version.split()[0], "numpy": np.__version__ if np else None, "n": a.n,
              "seed": a.seed, "sagebrush_seconds": round(time.time() - t0, 1), "functions": {}}
    print("%-6s %8s %8s %8s | %8s %8s %8s %6s | %9s %9s | %8s" % (
        "func", "inputs", "differ", "np-diff", "sb-wrong", "libc-wr", "both", "error", "sb maxULP", "libc max", "np-vs-np"))
    for name in names:
        args = inputs[name]
        sb = unpack(open(os.path.join(tmp, name + ".sb"), "rb").read())
        sbe = open(os.path.join(tmp, name + ".sbe"), "rb").read()
        sbn = unpack(open(os.path.join(tmp, name + ".np"), "rb").read())
        f = getattr(math, name)
        mfn = UNARY[name][3] if name in UNARY else BINARY[name][1]
        n = len(args[0])
        cp, cpe = [], []
        for i in range(n):
            try:
                cp.append(f(*[x[i] for x in args]))
                cpe.append(0)
            except (ValueError, OverflowError, ZeroDivisionError):
                cp.append(0.0)
                cpe.append(1)
        if np is not None:
            uf = getattr(np, UNARY[name][2] if name in UNARY else BINARY[name][0])
            with np.errstate(all="ignore"):
                cpn = uf(*[np.array(x, dtype=float) for x in args]).tolist()
        else:
            cpn = None
        st = {"inputs": n, "differ": 0, "numpy_differ": 0, "sb-wrong": 0, "libc-wrong": 0, "both-wrong": 0,
              "error": 0, "sb_max_ulp": 0.0, "libc_max_ulp": 0.0, "numpy_vs_numpy": 0, "examples": []}
        refereed = 0
        for i in range(n):
            if cpn is not None and not same(sbn[i], cpn[i]):
                st["numpy_vs_numpy"] += 1
            if not cpe[i] and not same(sbn[i], cp[i]):
                st["numpy_differ"] += 1
            if sbe[i] != cpe[i]:
                st["differ"] += 1
                st["error"] += 1
                if len(st["examples"]) < 8:
                    st["examples"].append({"args": [x[i] for x in args], "sagebrush": "error" if sbe[i] else sb[i], "cpython": "error" if cpe[i] else cp[i]})
                continue
            if sbe[i] or same(sb[i], cp[i]):
                continue
            st["differ"] += 1
            if refereed >= a.max_referee:
                continue
            refereed += 1
            ref = correctly_rounded(mfn, [x[i] for x in args])
            if ref is None:
                continue
            us, uc = ulps(sb[i], ref), ulps(cp[i], ref)
            st["sb_max_ulp"] = max(st["sb_max_ulp"], us)
            st["libc_max_ulp"] = max(st["libc_max_ulp"], uc)
            okc, oks = same(cp[i], ref), same(sb[i], ref)
            st["sb-wrong" if okc else "libc-wrong" if oks else "both-wrong"] += 1
            if len(st["examples"]) < 8:
                st["examples"].append({"args": [x[i] for x in args], "sagebrush": sb[i], "cpython": cp[i], "correct": ref})
        st["refereed"] = refereed
        report["functions"][name] = st
        print("%-6s %8d %8d %8d | %8d %8d %8d %6d | %9.3g %9.3g | %8s" % (
            name, n, st["differ"], st["numpy_differ"], st["sb-wrong"], st["libc-wrong"], st["both-wrong"], st["error"],
            st["sb_max_ulp"], st["libc_max_ulp"], st["numpy_vs_numpy"] if cpn is not None else "-"), flush=True)
    if a.json:
        json.dump(report, open(a.json, "w"), indent=1)


if __name__ == "__main__":
    main()
