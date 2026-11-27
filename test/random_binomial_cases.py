# numpy.random's binomial (test/stats_oracle_gen.py records NumPy's draws into test/stats-oracle.json):
# the legacy RandomState's and the Generator's: exact draws across its two algorithms (inversion for n min(p,1-p) <= 30,
# BTPE above), the reflection p > 0.5, the edge cases, arrays of parameters, and the stream left after.
DATA = ""
PRELUDE = "import numpy as np\n"
CASES = [
    ("inv-small", "rs = np.random.RandomState(12345); out = rs.binomial(10, 0.3, size=40).tolist() + [rs.randint(0, 10**9)]"),
    ("inv-p-small", "rs = np.random.RandomState(1); out = rs.binomial(1000, 0.001, size=40).tolist() + [rs.randint(0, 10**9)]"),
    ("inv-edge-29", "rs = np.random.RandomState(2); out = rs.binomial(100, 0.29, size=40).tolist() + [rs.randint(0, 10**9)]"),
    ("btpe-30", "rs = np.random.RandomState(3); out = rs.binomial(100, 0.3, size=40).tolist() + [rs.randint(0, 10**9)]"),
    ("btpe-large", "rs = np.random.RandomState(4); out = rs.binomial(10**6, 0.4, size=40).tolist() + [rs.randint(0, 10**9)]"),
    ("btpe-huge-n", "rs = np.random.RandomState(5); out = rs.binomial(2**40, 0.25, size=20).tolist() + [rs.randint(0, 10**9)]"),
    ("reflect-p-gt-half", "rs = np.random.RandomState(6); out = rs.binomial(50, 0.8, size=40).tolist() + [rs.randint(0, 10**9)]"),
    ("reflect-btpe", "rs = np.random.RandomState(7); out = rs.binomial(500, 0.9, size=40).tolist() + [rs.randint(0, 10**9)]"),
    ("p-near-1", "rs = np.random.RandomState(8); out = rs.binomial(20, 0.999999, size=40).tolist() + [rs.randint(0, 10**9)]"),
    ("p-near-0", "rs = np.random.RandomState(9); out = rs.binomial(20, 1e-9, size=40).tolist() + [rs.randint(0, 10**9)]"),
    ("p-half", "rs = np.random.RandomState(10); out = rs.binomial(1000, 0.5, size=40).tolist() + [rs.randint(0, 10**9)]"),
    ("p-0-and-1", "rs = np.random.RandomState(11); out = [rs.binomial(7, 0.0), rs.binomial(7, 1.0)] + rs.binomial(7, 0.5, size=5).tolist() + [rs.randint(0, 10**9)]"),
    ("n-0", "rs = np.random.RandomState(12); out = [int(rs.binomial(0, 0.3))] + rs.binomial(0, 0.7, size=3).tolist() + [rs.randint(0, 10**9)]"),
    ("scalar", "rs = np.random.RandomState(13); x = rs.binomial(30, 0.6); out = [type(x).__name__, int(x), rs.randint(0, 10**9)]"),
    ("array-params", "rs = np.random.RandomState(14); out = rs.binomial([5, 50, 500, 5000], [0.1, 0.5, 0.9, 0.02]).tolist() + [rs.randint(0, 10**9)]"),
    ("broadcast-size", "rs = np.random.RandomState(15); a = rs.binomial([10, 100], 0.3, size=(3, 2)); out = [list(a.shape), str(a.dtype)] + a.ravel().tolist() + [rs.randint(0, 10**9)]"),
    ("module-seed", "np.random.seed(16); out = np.random.binomial(40, 0.45, size=30).tolist() + [np.random.randint(0, 10**9)]"),
    ("mixed-calls", "rs = np.random.RandomState(17); out = [rs.binomial(10, 0.3), rs.binomial(1000, 0.3), rs.binomial(10, 0.3), rs.binomial(1000, 0.7), rs.random_sample(), rs.binomial(1000, 0.3)]"),
    ("err-p", "rs = np.random.RandomState(0); rs.binomial(5, 1.5); out = 0"),
    ("err-p-neg", "rs = np.random.RandomState(0); rs.binomial(5, -0.1); out = 0"),
    ("err-n", "rs = np.random.RandomState(0); rs.binomial(-1, 0.5); out = 0"),
    ("err-p-nan", "rs = np.random.RandomState(0); rs.binomial(5, float('nan')); out = 0"),
    ("n-float", "rs = np.random.RandomState(18); out = rs.binomial(10.7, 0.3, size=5).tolist() + [rs.randint(0, 10**9)]"),
]
CASES += [
    ("gen-inv", "g = np.random.default_rng(21); out = g.binomial(10, 0.3, size=30).tolist() + [int(g.integers(0, 10**9))]"),
    ("gen-btpe", "g = np.random.default_rng(22); out = g.binomial(1000, 0.35, size=30).tolist() + [int(g.integers(0, 10**9))]"),
    ("gen-reflect", "g = np.random.default_rng(23); out = g.binomial(200, 0.75, size=30).tolist() + [int(g.integers(0, 10**9))]"),
]
CASES += [
    ("gen-edges", "g = np.random.default_rng(24); out = [int(g.binomial(0, 0.3)), int(g.binomial(7, 0.0)), int(g.binomial(7, 1.0))] + g.binomial(9, 0.4, size=6).tolist() + [int(g.integers(0, 10**9))]"),
    ("legacy-edges-size", "rs = np.random.RandomState(25); out = rs.binomial(0, 0.3, size=3).tolist() + rs.binomial(7, 1.0, size=3).tolist() + rs.binomial(7, 0.0, size=2).tolist() + [rs.randint(0, 10**9)]"),
]
# (rows from the numeric review: the n p = 30 boundary, huge n, broadcasting, the Generator's edges)
CASES += [
    ("np-exactly-30-inv", "rs = np.random.RandomState(31); out = rs.binomial(60, 0.5, size=30).tolist() + [rs.randint(0, 10**9)]"),
    ("np-30-product", "rs = np.random.RandomState(32); out = [repr(300 * 0.1)] + rs.binomial(300, 0.1, size=30).tolist() + [rs.randint(0, 10**9)]"),
    ("huge-n-tiny-p", "rs = np.random.RandomState(33); out = rs.binomial(10**12, 1e-11, size=30).tolist() + [rs.randint(0, 10**9)]"),
    ("n-2pow53-plus", "rs = np.random.RandomState(34); out = rs.binomial(2**53 + 1, 0.5, size=3).tolist() + [rs.randint(0, 10**9)]"),
    ("n-2pow53-reflect", "rs = np.random.RandomState(48); out = rs.binomial(2**53 + 1, 0.7, size=3).tolist() + [str(rs.binomial(2**53 + 3, 1.0)) for _ in range(2)] + [rs.randint(0, 10**9)]"),
    ("n-2pow60", "rs = np.random.RandomState(35); out = rs.binomial(2**60, 1e-15, size=3).tolist() + [rs.randint(0, 10**9)]"),
    ("broadcast-2d", "rs = np.random.RandomState(36); a = rs.binomial(np.array([[5], [500]]), np.array([0.2, 0.7, 0.99])); out = [list(a.shape), str(a.dtype)] + a.ravel().tolist() + [rs.randint(0, 10**9)]"),
    ("size-mismatch", "rs = np.random.RandomState(37); rs.binomial([1, 2, 3], 0.5, size=2); out = 0"),
    ("gen-array-edges", "g = np.random.default_rng(38); a = g.binomial([0, 7, 7, 9], [0.3, 0.0, 1.0, 0.4], size=(2, 4)); out = [str(a.dtype)] + a.ravel().tolist() + [int(g.integers(0, 10**9))]"),
    ("gen-dtype-scalar", "g = np.random.default_rng(39); x = g.binomial(30, 0.6); out = [type(x).__name__, int(x), int(g.integers(0, 10**9))]"),
    ("gen-huge-n", "g = np.random.default_rng(40); out = g.binomial(2**40, 0.25, size=5).tolist() + [int(g.integers(0, 10**9))]"),
    # (n past 2**53: the scalar draws exact, a Python int, as strings here (JSON's numbers are doubles); an array
    # holds a draw only below 2**53, Sagebrush's int64 arrays being doubles; n past int64 refused, as NumPy's)
    ("n-2pow53-scalar", "rs = np.random.RandomState(48); a = rs.binomial(2**53 + 3, 1.0); b = rs.binomial(2**53 + 1, 0.7); out = [type(a).__name__, str(a), str(b), rs.randint(0, 10**9)]"),
    ("gen-n-2pow62-reflect", "g = np.random.default_rng(49); out = [str(g.binomial(2**62 + 7, 0.75)), str(g.binomial(2**60 + 1, 0.999999)), str(g.binomial(2**53 + 5, 1 - 2.0**-40)), int(g.integers(0, 10**9))]"),
    ("n-2pow63", "rs = np.random.RandomState(50); rs.binomial(2**63, 0.5); out = 0"),
    # (BTPE's squeeze: the legacy RandomState's Stirling terms (13680, all four added) against the Generator's; and
    # -k * k wrapped in int64, as NumPy's, when n is near 2**63)
    ("legacy-btpe-terms", "rs = np.random.RandomState(0); a = rs.binomial(1000, 0.3, size=3000); out = [int(a.sum())] + a[-3:].tolist() + [rs.randint(0, 10**9)]"),
    ("gen-btpe-2pow63", "g = np.random.default_rng(0); out = [str(g.binomial(2**63 - 1, 0.4)) for _ in range(12)] + [int(g.integers(0, 10**9))]"),
    ("legacy-btpe-2pow63", "rs = np.random.RandomState(0); out = [str(rs.binomial(2**63 - 1, 0.4)) for _ in range(12)] + [rs.randint(0, 10**9)]"),
    # (the Generator's corrected Stirling terms deciding a draw: two cases where the legacy terms would not)
    ("gen-btpe-terms", "import hashlib\nout = []\nfor s, n, p in ((9, 939333, 0.04826546769231007), (23, 29687, 0.36930816936525596)):\n    g = np.random.default_rng(s); a = g.binomial(n, p, size=3000)\n    out += [int(a.sum()), hashlib.sha256(a.astype(np.int64).tobytes()).hexdigest()[:16], int(g.integers(0, 10**9))]"),
]
