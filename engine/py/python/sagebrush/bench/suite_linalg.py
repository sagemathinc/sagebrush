"""Exact linear algebra over Z and polynomial arithmetic in Z[x] against
FLINT (bench/linalg/README.md).

The inputs are those of the engine's own benchmarks (engine/oracle/examples
matbench.rs and polybench.rs), drawn from Python's random with fixed seeds:
random square matrices with entries in [-100, 100] (7 bits) or [-2^40, 2^40]
(41 bits); for rref an n x (n+5) matrix of rank n/2; random polynomials of
the given length and coefficient bits; gcds of g a and g b with g of half the
length.

Two Sagebrush columns: the public call (sagebrush.linalg / sagebrush.poly,
which returns Python ints and Fractions), and the engine through its wire
interface (sagebrush._engine.call with the encoded inputs, without the
conversion of the answer to Python numbers). FLINT is timed inside its own
process, on inputs it has already parsed."""

import random

from ._bench_common import fingerprint
from ._flint import Flint
from ._timing import sample
from .suite import Case, Suite

def _q(x):
    """(num, den) of an int or Fraction."""
    return (x, 1) if isinstance(x, int) else (x.numerator, x.denominator)


MATRIX_OPS = ("det", "solve", "inverse", "charpoly", "rref")


def matrix_input(n, bits, op):
    rng = random.Random(f"sagebrush-bench linalg {n} {bits} {op}")
    r = 100 if bits == 7 else 2**40
    if op == "rref":
        k = n // 2
        left = [[rng.randint(-10, 10) for _ in range(k)] for _ in range(n)]
        right = [[rng.randint(-r, r) for _ in range(n + 5)] for _ in range(k)]
        return [[sum(left[i][t] * right[t][j] for t in range(k)) for j in range(n + 5)]
                for i in range(n)], None
    a = [[rng.randint(-r, r) for _ in range(n)] for _ in range(n)]
    b = [rng.randint(-r, r) for _ in range(n)] if op == "solve" else None
    return a, b


def poly_input(length, bits, op):
    rng = random.Random(f"sagebrush-bench poly {length} {bits} {op}")

    def rnd(m):
        return [rng.choice((-1, 1)) * rng.getrandbits(bits) for _ in range(m)]

    if op == "mul":
        return rnd(length), rnd(length)
    from sagebrush import poly

    g, a, b = rnd(length // 2), rnd(length // 2), rnd(length // 2 + 1)
    return poly.mul(g, a), poly.mul(g, b)


def _tier(n_or_len, bits, kind):
    if kind == "matrix":
        if n_or_len <= 30 and bits == 7:
            return "quick"
        return "standard"
    if n_or_len <= 1000 and bits <= 10:
        return "quick"
    return "standard"


def _flatten(m):
    return [x for row in m for x in row]


class Public:
    """sagebrush.linalg and sagebrush.poly, the default calls."""

    ours = True
    name = "sagebrush"
    short = "sb"
    label = "sagebrush.linalg / sagebrush.poly (public call, Python numbers)"

    def available(self):
        return True

    def version(self):
        return None

    def run(self, case, repeat, timeout):
        from sagebrush import linalg, poly

        op, x, y = case.params["op"], case.input[0], case.input[1]
        if op == "det":
            t = sample(lambda: linalg.det(x), repeat)
            t.answer = fingerprint([_q(t.answer)])
        elif op == "solve":
            col = [[v] for v in y]
            t = sample(lambda: linalg.solve(x, col), repeat)
            t.answer = fingerprint(_q(v) for v in _flatten(t.answer))
        elif op == "inverse":
            t = sample(lambda: linalg.inverse(x), repeat)
            t.answer = fingerprint(_q(v) for v in _flatten(t.answer))
        elif op == "charpoly":
            t = sample(lambda: linalg.charpoly(x), repeat)
            t.answer = fingerprint(_q(v) for v in t.answer)
        elif op == "rref":
            t = sample(lambda: linalg.rref(x), repeat)
            t.answer = fingerprint(_q(v) for v in _flatten(t.answer[0]))
        else:
            f = poly.mul if op == "mul" else poly.gcd
            t = sample(lambda: f(x, y), repeat)
            t.answer = fingerprint((c, 1) for c in t.answer)
        return t

    def close(self):
        pass


class Engine:
    """The engine through its wire interface: the requests already encoded,
    the replies left as text."""

    ours = True
    name = "sagebrush-engine"
    short = "eng"
    label = "the engine through sagebrush._engine.call (no conversion of the answer)"

    def available(self):
        return True

    def version(self):
        return None

    def run(self, case, repeat, timeout):
        from sagebrush._engine import call

        op, x, y = case.params["op"], case.input[0], case.input[1]
        enc = lambda rows: ";".join(",".join(map(str, r)) for r in rows)  # noqa: E731
        ints = lambda s: list(map(int, s.split(","))) if s else []  # noqa: E731
        if op in MATRIX_OPS:
            m = enc(x)
            if op == "det":
                t = sample(lambda: call("mat_det", m=m), repeat)
                t.answer = fingerprint([(int(t.answer), 1)])
            elif op == "solve":
                b = enc([v] for v in y)
                t = sample(lambda: call("mat_solve", a=m, b=b, wire="csv"), repeat)
                den = int(t.answer["den"])
                t.answer = fingerprint((v, den) for row in t.answer["rows"].split(";") for v in ints(row))
            elif op == "inverse":
                t = sample(lambda: call("mat_inverse", m=m, wire="csv"), repeat)
                den = int(t.answer["den"])
                t.answer = fingerprint((v, den) for row in t.answer["rows"].split(";") for v in ints(row))
            elif op == "charpoly":
                t = sample(lambda: call("mat_charpoly", m=m, wire="csv"), repeat)
                t.answer = fingerprint((v, 1) for v in ints(t.answer))
            else:
                t = sample(lambda: call("mat_rref", m=m, wire="csv"), repeat)
                den = int(t.answer["den"])
                rows = [ints(r) for r in t.answer["rows"].split(";")] if t.answer["rows"] else []
                rows += [[0] * len(x[0])] * (len(x) - len(rows))
                t.answer = fingerprint((v, den) for v in _flatten(rows))
        else:
            a, b = ",".join(map(str, x)), ",".join(map(str, y))
            fn = "poly_mul" if op == "mul" else "poly_gcd"
            t = sample(lambda: call(fn, a=a, b=b, wire="csv"), repeat)
            t.answer = fingerprint((v, 1) for v in ints(t.answer))
        return t

    def close(self):
        pass


class FlintEngine(Flint):
    def run(self, case, repeat, timeout):
        op, x, y = case.params["op"], case.input[0], case.input[1]
        if op in MATRIX_OPS:
            if op == "rref":
                head = f"rref {len(x)} {len(x[0])}"
            else:
                head = f"{op} {len(x)}"
            body = " ".join(map(str, _flatten(x)))
            if op == "solve":
                body += " " + " ".join(map(str, y))
        else:
            head = op
            body = f"{len(x)} {' '.join(map(str, x))} {len(y)} {' '.join(map(str, y))}"
        return self.time(f"{head} {body}", repeat, timeout)


class LazyCase(Case):
    """A case whose input is drawn only when it runs."""

    def __init__(self, label, params, tier, make):
        super().__init__(label, params, tier)
        self._make, self._input = make, None

    @property
    def input(self):
        if self._input is None:
            self._input = self._make()
        return self._input


class LinalgSuite(Suite):
    name = "linalg"
    title = "exact matrices over Z and polynomials in Z[x] (one core)"
    claim = ("README.md (Speed against FLINT: inverses 4-6x faster for n = 30 and 100, ...); "
             "bench/linalg/README.md")

    def cases(self):
        out = []
        for n in (10, 30, 100):
            for bits in (7, 41):
                for op in MATRIX_OPS:
                    out.append(LazyCase(f"{op} n={n} {bits}-bit", {"op": op, "n": n, "bits": bits},
                                        _tier(n, bits, "matrix"),
                                        lambda n=n, bits=bits, op=op: matrix_input(n, bits, op)))
        for length, bits in ((10, 10), (100, 10), (1000, 10), (10000, 10), (100, 1000),
                             (1000, 1000), (100000, 20)):
            for op in ("mul", "gcd"):
                if op == "gcd" and length > 10000:
                    continue
                out.append(LazyCase(f"poly {op} len={length} {bits}-bit",
                                    {"op": op, "length": length, "bits": bits},
                                    _tier(length, bits, "poly"),
                                    lambda length=length, bits=bits, op=op: poly_input(length, bits, op)))
        return out

    def engines(self):
        return [Public(), Engine(), FlintEngine()]


LINALG = LinalgSuite()
