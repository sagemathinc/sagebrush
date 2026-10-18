"""Traces of Frobenius a_p of 11a at every prime p <= N (README.md, ap;
results/ap.md). smalljac, the comparison there, is rarely installed and is
not driven by sagebrush bench: its numbers stay in results/ap.md. Where
results/ap.md records the answer (the number of good primes and the sum of
a_p, identical to smalljac's), the run is checked against it."""

from ._timing import sample
from .suite import Case, Suite

CURVE = [0, -1, 1, -10, -20]  # 11a
# (N, tier, recorded (good primes, sum of a_p) or None)
BOUNDS = [(10**6, "quick", None), (10**7, "standard", None), (10**8, "large", (5761454, 5982199))]


class Ours:
    ours = True
    name = "sagebrush"
    short = "sb"
    label = "sagebrush.ap.aplist (one thread; the Python list included)"

    def available(self):
        return True

    def version(self):
        return None

    def run(self, case, repeat, timeout):
        from sagebrush import ap

        n = case.params["N"]
        t = sample(lambda: ap.aplist(CURVE, n, threads=1), repeat)
        good = [a for _, a in t.answer if a is not None]
        t.answer = [len(good), sum(good)]
        return t

    def close(self):
        pass


class Smalljac:
    """Not driven: a placeholder column that always says why."""

    ours = False
    name = "smalljac"
    short = "smalljac"
    label = "smalljac (not driven by sagebrush bench; see results/ap.md)"
    why = "measured once in results/ap.md; not reproducible with sagebrush bench"

    def available(self):
        return False

    def version(self):
        return None

    def close(self):
        pass


class ApSuite(Suite):
    name = "ap"
    title = "a_p of 11a at all primes up to N (one thread)"
    claim = "README.md (ap: on one core 1.2-1.6x slower than smalljac); results/ap.md"

    def cases(self):
        out = []
        for n, tier, recorded in BOUNDS:
            c = Case(f"11a N=10^{len(str(n)) - 1}", {"N": n}, tier)
            if recorded:
                c.expected = list(recorded)
            out.append(c)
        return out

    def engines(self):
        return [Ours(), Smalljac()]


AP = ApSuite()
