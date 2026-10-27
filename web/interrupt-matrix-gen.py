"""Generates web/interrupt-matrix.json: one entry per census name (web/interrupt-census.mjs),
each a case (with a fixture), a planned case (family and owner, fixture still to write), or a
cheap candidate (excluded only once its evidence, an enforced input bound or a measured poll
gap at the supported maximum, is recorded; plan-interrupt-harness r4 §5).  Rerun after a
census change:  node web/interrupt-census.mjs --names > /tmp/c.json && python3 web/interrupt-matrix-gen.py /tmp/c.json"""
import json, sys

census = json.load(open(sys.argv[1]))
T = census["transports"]

# the pilot's CI cases, with their fixtures (web/test-interrupt-matrix.mjs reads these)
CASES = [
    dict(id="P1", transport="pyloop:while", owner="python", mode="python", calibration="nonterminating",
         setup="k = 0", target="while True:\n    k += 1", probe="assert sum(range(10)) == 45"),
    dict(id="P2a", transport="runtime:sorted-key", owner="python", mode="python", s0=3_000_000, smin=100_000, smax=25_000_000, leak_s=3_000_000, leak_measure="heap+external",
         grow=dict(kind="scale", p=1), setup="", target="_r = sorted(range(S), key=lambda v: -v)",
         probe="assert sorted([3, 1, 2]) == [1, 2, 3]"),
    dict(id="E2", transport="engineCall:factor_integer", owner="number theory", mode="sage", s0=22, smin=12, smax=44,
         grow=dict(kind="log", c=0.18), setup="n = next_prime(10**S) * next_prime(3 * 10**S)", target="_r = factor(n)",
         probe="assert len(factor(2**64 + 1)) == 2"),
    dict(id="E3a", transport="engineCall:mat_rank", owner="linear algebra (ff matrices)", mode="sage", s0=600, smin=200, smax=1024,
         grow=dict(kind="scale", p=3), setup="M = random_matrix(GF(32003), S)", target="_r = M.rank()",
         probe="assert matrix(GF(32003), [[1, 2], [2, 4]]).rank() == 1"),
    dict(id="E6a", transport="mpCall:groebner", owner="multivariate (sage)", mode="sage", s0=6, smin=4, smax=9,
         grow=dict(kind="step", step=1), retained=True,
         setup="R = PolynomialRing(GF(32003), 'x', S)\nX = R.gens()\nI = R.ideal([sum(prod(X[(j + t) % S] for t in range(d)) for j in range(S)) for d in range(1, S)] + [prod(X) - 1])",
         target="_r = I.groebner_basis()",
         probe="assert (X[0] + X[1])**2 - X[0]**2 - X[1]**2 == 2 * X[0] * X[1]\nassert len(I.gens()) == len(X) and I.gens()[0] in R\nR2 = PolynomialRing(GF(32003), 'y', 2)\nassert len(R2.ideal([R2.gen(0)**2 - 1, R2.gen(1) - 1]).groebner_basis()) == 2"),
    # rank-13 PR 1 (plan-matlab-nocliffs r6 section 3): the ordering and the sparse LU, Stop after their PHASE
    dict(id="M1o", transport="pyloop:matlab-colamd", owner="MATLAB sparse linear algebra", mode="python", s0=250, smin=40, smax=600,
         grow=dict(kind="scale", p=2), phase="ordering", leak_measure="heap+external", hosts=["cli"],
         setup='import numpy as np\nimport _matlab_sparse as _sp, _matlab_colamd as _C, _matlab_lu as _L\n_L._phase_hook = lambda name: _p("PHASE", _i, name)\nk = S\nn = k * k\n_pm = [(i * 1999) % n for i in range(n)]\n_r, _c, _v = [], [], []\nfor _x in range(k):\n    for _y in range(k):\n        _t = _x * k + _y\n        for _dx, _dy, _w in ((0, 0, 4.0), (1, 0, -1.0), (-1, 0, -1.0), (0, 1, -1.0), (0, -1, -1.0)):\n            _a, _b = _x + _dx, _y + _dy\n            if 0 <= _a < k and 0 <= _b < k:\n                _r.append(_pm[_a * k + _b]); _c.append(_pm[_t]); _v.append(_w)\nA = _sp.make(n, n, np.array(_r), np.array(_c), np.array(_v))',
         target='_L._phase("ordering")\n_q = _C.order_columns(A.m, A.n, A.jc, A.ir)',
         probe='assert _L.factor(_sp.make(2, 2, np.array([0, 1]), np.array([0, 1]), np.array([2.0, 4.0])), "p").solve(np.ones((2, 1)))[1, 0] == 0.25'),
    dict(id="M1l", transport="pyloop:matlab-lu", owner="MATLAB sparse linear algebra", mode="python", s0=70, smin=20, smax=160,
         grow=dict(kind="scale", p=3), phase="lu", leak_measure="heap+external", hosts=["cli"],
         setup='import numpy as np\nimport _matlab_sparse as _sp, _matlab_colamd as _C, _matlab_lu as _L\n_L._phase_hook = lambda name: _p("PHASE", _i, name)\nk = S\nn = k * k\n_pm = [(i * 1999) % n for i in range(n)]\n_r, _c, _v = [], [], []\nfor _x in range(k):\n    for _y in range(k):\n        _t = _x * k + _y\n        for _dx, _dy, _w in ((0, 0, 4.0), (1, 0, -1.0), (-1, 0, -1.0), (0, 1, -1.0), (0, -1, -1.0)):\n            _a, _b = _x + _dx, _y + _dy\n            if 0 <= _a < k and 0 <= _b < k:\n                _r.append(_pm[_a * k + _b]); _c.append(_pm[_t]); _v.append(_w)\nA = _sp.make(n, n, np.array(_r), np.array(_c), np.array(_v))\n_q = _C.order_columns(A.m, A.n, A.jc, A.ir)',
         target='_F = _L.factor(A, "m1l", q=_q)',
         probe='assert _L.factor(_sp.make(2, 2, np.array([0, 1]), np.array([0, 1]), np.array([2.0, 4.0])), "p").solve(np.ones((2, 1)))[1, 0] == 0.25'),
    # rank-13 PR 2 (plan-matlab-nocliffs r6 section 3): the chunked band path, Stop after its PHASE
    dict(id="M2b", transport="pyloop:matlab-band", owner="MATLAB sparse linear algebra", mode="python", s0=15000, smin=2000, smax=2000000,
         grow=dict(kind="scale", p=1), phase="band", leak_measure="heap+external", hosts=["cli"],
         setup='import numpy as np\nimport _matlab_sparse as _sp, _matlab_lu as _L\n_L._phase_hook = lambda name: _p("PHASE", _i, name)\nn = S\n_kl = _ku = 20\n_rs, _cs = [], []\nfor _d in range(-_kl, _ku + 1):\n    _ii = np.arange(max(0, -_d), min(n, n - _d), dtype=np.int64)\n    _rs.append(_ii); _cs.append(_ii + _d)\n_r = np.concatenate(_rs); _c = np.concatenate(_cs)\n_v = np.where(_r == _c, 50.0, 1.0 / (1.0 + np.abs(_r - _c)))\nA = _sp.make(n, n, _r, _c, _v)\n_B = np.ones((n, 1))',
         target='_X, _sg = _L.band_solve(A, _B, _kl, _ku, _L.Ledger("m2b"), _L.Work("m2b"))',
         probe='_T = _sp.make(3, 3, np.array([0, 1, 1, 2]), np.array([0, 0, 1, 2]), np.array([2.0, 1.0, 4.0, 8.0]))\n_Y, _s = _L.band_solve(_T, np.ones((3, 1)), 1, 0, _L.Ledger("p"), _L.Work("p"))\nassert _Y[0, 0] == 0.5 and _Y[1, 0] == 0.125 and _Y[2, 0] == 0.125'),
    # r5 §6.2: XK with the window signature; s_max at lib/_png.py's pixel cap (4000 x 4000 < 2^24)
    dict(id="E13g", transport="wasm:raster.ts", owner="board/plot", mode="sage", s0=40, smin=4, smax=4000,
         grow=dict(kind="scale", p=1), exception="XK", xk=dict(kind="window", wrap="_sbraster.render"), hosts=["cli"],
         setup="import tempfile, os\n_d = tempfile.mkdtemp()\nP = sum(polygon([(0, 0), (1, 0.1 * (j % 10)), (1, 1), (0.1 * (j % 7), 1)], alpha=0.02) for j in range(S))",
         target="P.save(os.path.join(_d, 'big.png'), figsize=40, dpi=100)",
         probe="line([(0, 0), (1, 1)]).save(os.path.join(_d, 'small.png'), figsize=1, dpi=100)\nassert os.path.getsize(os.path.join(_d, 'small.png')) > 0"),
]
for c in CASES:
    c.setdefault("hosts", ["cli", "prompt", "browser"] if c["id"] in ("P1", "E2") else ["cli", "prompt"])
    c["status"] = "case"
covered = {c["transport"] for c in CASES}

# names that may be excluded as cheap once evidence is recorded (r4 §5); everything else is a case
CHEAP = {
    "engineCall": "ntt_cache_stats dims level_data commute estimate estimate_newforms is_prime factor_estimate cost_probe".split(),
    "symCall": ("add sub mul div neg const complex e euler_gamma float int pi rat str sym uinf fun rel latex variables operator "
                "number pysrc numerator denominator degree coefficient coefficients is_zero special_calls enclose").split(),
    "mpCall": "new newp text eq len neg scale add sub".split(),
}
FAMILY = [  # (name test, family, owner)
    (lambda n: n.startswith("mat_") or n in ("hermite_form", "elementary_divisors", "lll", "charpoly", "charpoly_exact", "charpoly_mod", "nmod_charpoly"), "E3 dense linear algebra", "linear algebra"),
    (lambda n: n.startswith("poly_") or n in ("factor", "factor_mod", "nf_factor", "nf_gcd", "complex_roots"), "E5 polynomials", "polynomial factorization"),
    (lambda n: n.startswith("bnf") or n in ("nf_data", "primes_above", "quadratic_class_group"), "E7 number fields", "number fields"),
    (lambda n: n.startswith("ec_") or n in ("ap", "aplist", "aplist_many", "quartic_search", "moments", "ball_log"), "E12 elliptic curves / analytic", "analytic"),
    (lambda n: n in ("hecke_charpoly", "batch_exact", "newforms", "newspace", "rational_newforms", "weight2"), "E9 modular symbols", "modular symbols"),
    (lambda n: n in ("galois_group", "transitive_group"), "E10 Galois", "groups/Galois"),
]
entries = list(CASES)
def add(transport, name):
    key = f"{transport}:{name}"
    if key in covered:
        return
    if name in CHEAP.get(transport, ()):
        entries.append(dict(id=key, transport=key, status="cheap-candidate", evidence=None,
                            note="needs an enforced input bound or a measured poll gap at the supported maximum"))
        return
    fam, owner = "E10 permutation groups", "groups/Galois"
    if transport == "symCall":
        fam, owner = "E11 symbolics", "symbolic engine"
    elif transport == "mpCall":
        fam, owner = "E6 multivariate", "multivariate (sage)"
    else:
        for test, f, o in FAMILY:
            if test(name):
                fam, owner = f, o
                break
    entries.append(dict(id=key, transport=key, status="planned", family=fam, owner=owner))
for tr in ("engineCall", "symCall", "mpCall"):
    for n in T[tr]:
        add(tr, n)
for m in T["wasmModules"]:
    if not m["reads_interrupt"] and f"wasm:{m['module']}" not in covered:
        entries.append(dict(id=f"wasm:{m['module']}", transport=f"wasm:{m['module']}", status="planned", exception="XK",
                            family="P3f NumPy kernels" if m["module"] == "kernels.ts" else "E13g raster",
                            owner="numerics (python)" if m["module"] == "kernels.ts" else "board/plot"))
out = dict(
    comment="plan-interrupt-harness r5: one entry per census name; regenerate with web/interrupt-matrix-gen.py",
    fingerprints=census["fingerprints"],
    entries=entries,
)
json.dump(out, open("web/interrupt-matrix.json", "w"), indent=1)
from collections import Counter
print(Counter(e["status"] for e in entries), len(entries))
