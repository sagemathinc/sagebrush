"""Exact characteristic polynomials of Hecke operators T_q on weight-2
modular symbols for Gamma0(N), sign +1, against Sage (README.md,
Performance; results/engine-exact.md).

Sagebrush's call (sagebrush.modsym.charpoly_exact on one thread) does all
the work: the modular symbols, T_q and its proven charpoly. Sage's time is
the charpoly alone (of a copy, with no cached result) of a Hecke matrix
built before timing; one column with Sage's default algorithm, one with
LinBox on d T over ZZ, d the denominator (LinBox stops early,
heuristically)."""

from . import _bench_common
from ._sage import Sage
from ._timing import sample
from .suite import Case, Suite

# (N, q, tier); the large ones are those of results/engine-exact.md
LEVELS = [(389, 2, "quick"), (1001, 3, "standard"), (2310, 13, "large"), (5000, 3, "large"),
          (10007, 2, "large")]


class Ours:
    ours = True
    name = "sagebrush"
    short = "sb"
    label = "sagebrush.modsym.charpoly_exact (one thread; everything, proven)"

    def available(self):
        return True

    def version(self):
        return None

    def run(self, case, repeat, timeout):
        from sagebrush import modsym

        n, q = case.params["N"], case.params["q"]
        t = sample(lambda: modsym.charpoly_exact(n, q, threads=1), repeat)
        if t.answer["status"] != "proven":
            raise ValueError(f"charpoly_exact status {t.answer['status']}")
        t.answer = _bench_common.fpq(t.answer["charpoly"])
        return t

    def close(self):
        pass


class SageCharpoly(Sage):
    def __init__(self, linbox):
        self.linbox = linbox
        if linbox:
            super().__init__("sage-linbox", "linbox", "Sage, LinBox: (d T over ZZ).charpoly(algorithm='linbox') (heuristic)")
        else:
            super().__init__("sage", "sage", "Sage, T.charpoly() (default; Hecke matrix built before timing)")

    def run(self, case, repeat, timeout):
        n, q = case.params["N"], case.params["q"]
        setup = f"T = ModularSymbols({n}, 2, sign=1).hecke_matrix({q})"
        if not self.linbox:
            return self.time(setup, "copy(T).charpoly()", "fpq(r.list())", repeat, timeout)
        # T may have denominators: the charpoly of d T over ZZ, scaled back
        setup += "\nd = T.denominator()\nA = (d * T).change_ring(ZZ)"
        return self.time(setup, "copy(A).charpoly(algorithm='linbox')",
                         "fpq([QQ(c) / d**(r.degree() - k) for k, c in enumerate(r.list())])",
                         repeat, timeout)


class CharpolySuite(Suite):
    name = "charpoly"
    title = "exact charpolys of T_q on modular symbols for Gamma0(N) (one thread)"
    claim = ("README.md (Performance: proven exact charpolys 3.9-7.8x faster than Sage's default "
             "path, 1.1-4.7x faster than LinBox); results/engine-exact.md")

    def cases(self):
        return [Case(f"N={n} T_{q}", {"N": n, "q": q}, tier) for n, q, tier in LEVELS]

    def engines(self):
        return [Ours(), SageCharpoly(False), SageCharpoly(True)]


CHARPOLY = CharpolySuite()
