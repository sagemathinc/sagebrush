"""Class groups of quadratic fields against PARI's quadclassunit (the
tables of engine/classgroup/README.md)."""

import ast
import os
from decimal import Decimal

from ._gp import Gp
from ._timing import sample
from .suite import Case, Suite

DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")


def read_discriminants(name):
    """[(k, D, tier)] from data/NAME (lines "k D tier", # comments)."""
    out = []
    with open(os.path.join(DATA, name)) as f:
        for line in f:
            line = line.split("#", 1)[0].split()
            if line:
                out.append((int(line[0]), int(line[1]), line[2]))
    return out


class Ours:
    """sagebrush.nf.quadratic_class_group_data: the default call (with the
    analytic certificate), or with certify=False (conditional on GRH and
    the stopping rule's estimate, like PARI's quadclassunit)."""

    ours = True

    def __init__(self, certify):
        self.certify = certify
        self.name = "sagebrush" if certify else "sagebrush-uncert"
        self.short = "sb" if certify else "sbu"
        self.label = "certified (default)" if certify else "uncertified, conditional on GRH (like PARI)"

    def available(self):
        return True

    def version(self):
        return None

    def run(self, case, repeat, timeout):
        from sagebrush import nf

        nf.quadratic_class_group_data(-7)  # the small-prime table, built once
        d, certify = case.params["D"], self.certify
        t = sample(lambda: nf.quadratic_class_group_data(d, certify=certify), repeat)
        r = t.answer
        t.answer = {"h": r["h"], "cyc": r["cyc"], "certified": r["certified"]}
        if d > 0:
            t.answer["reg"] = r["regulator"]
        return t

    def close(self):
        pass


class Pari(Gp):
    label = "PARI quadclassunit (not certified)"

    def run(self, case, repeat, timeout):
        d = case.params["D"]
        ans = "[r.no,r.cyc]" if d < 0 else "[r.no,r.cyc,Str(r.reg)]"
        t = self.time([], f"quadclassunit({d})", ans, repeat, timeout)
        a = ast.literal_eval(t.answer)
        t.answer = {"h": a[0], "cyc": a[1]} if d < 0 else {"h": a[0], "cyc": a[1], "reg": a[2]}
        return t


class QuadSuite(Suite):
    def __init__(self, name, data, title, claim):
        self.name, self.data, self.title, self.claim = name, data, title, claim

    def cases(self):
        out, seen = [], {}
        for k, d, tier in read_discriminants(self.data):
            seen[k] = seen.get(k, 0) + 1
            out.append(Case(f"10^{k} #{seen[k]}", {"k": k, "D": d}, tier))
        return out

    def engines(self):
        return [Ours(True), Ours(False), Pari()]

    def same(self, a, b):
        """The class group exactly; the regulator to 15 significant digits."""
        if a["h"] != b["h"] or list(a["cyc"]) != list(b["cyc"]):
            return False
        if "reg" in a or "reg" in b:
            x, y = Decimal(a["reg"]), Decimal(b["reg"])
            return abs(x - y) <= abs(y) * Decimal("1e-15")
        return True


IMAG = QuadSuite(
    "imagquad", "imagquad.txt",
    "class groups of imaginary quadratic fields, D = -p (one core)",
    "README.md (Imaginary quadratic fields: up to 44x faster than PARI's quadclassunit); "
    "engine/classgroup/README.md, Timing against PARI")
REAL = QuadSuite(
    "realquad", "realquad.txt",
    "class groups and regulators of real quadratic fields, D = p (one core)",
    "README.md (Real quadratic fields: faster than PARI from about 10^29); "
    "engine/classgroup/README.md, the real quadratic table")
