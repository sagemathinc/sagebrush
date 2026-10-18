"""Class groups and regulators of general number fields against PARI's
bnfinit(f, 1) (engine/classgroup/README.md, General number fields)."""

import ast
import os
from decimal import Decimal

from ._gp import Gp
from ._timing import sample
from .suite import Case, Suite

DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
DEGREE = {3: "cubic", 4: "quartic", 5: "quintic", 6: "sextic"}


def read_fields():
    """[(degree, e, tier, f)] from data/nf-fields.txt."""
    out = []
    with open(os.path.join(DATA, "nf-fields.txt")) as fh:
        for line in fh:
            line = line.split("#", 1)[0].split()
            if line:
                out.append((int(line[0]), int(line[1]), line[2], [int(c) for c in line[3].split(",")]))
    return out


class Ours:
    """sagebrush.nf.bnf, the default call: GRH, with the analytic
    certificate where it holds (an answer without it is marked *)."""

    ours = True
    name = "sagebrush"
    short = "sb"
    label = "sagebrush.nf.bnf (default; GRH)"

    def available(self):
        return True

    def version(self):
        return None

    def run(self, case, repeat, timeout):
        from sagebrush import nf

        f = case.params["f"]
        t = sample(lambda: nf.bnf(f), repeat)
        r = t.answer
        t.answer = {"disc": r["disc"], "cyc": r["cyc"], "reg": r["regulator"],
                    "certified": r["certified"]}
        return t

    def close(self):
        pass


class Pari(Gp):
    label = "PARI bnfinit(f, 1) (GRH, not certified)"

    def run(self, case, repeat, timeout):
        f = ",".join(map(str, case.params["f"]))
        t = self.time([], f"bnfinit(Pol(Vecrev([{f}])),1)", "[r.disc,r.cyc,Str(r.reg)]",
                      repeat, timeout)
        a = ast.literal_eval(t.answer)
        t.answer = {"disc": a[0], "cyc": a[1], "reg": a[2]}
        return t


def _digits(s):
    """The significant digits of a decimal string."""
    return len(s.replace("-", "").replace(".", "").lstrip("0")) or 1


class NfSuite(Suite):
    name = "nf"
    title = "class groups and regulators of random fields of degree 3-6 (one core)"
    claim = ("README.md (General number fields: agrees with PARI; about 10x slower at small d, "
             "close to even at 10^35); engine/classgroup/README.md, General number fields")

    def cases(self):
        return [Case(f"{DEGREE[n]} 10^{e} #{i}", {"degree": n, "e": e, "f": f}, tier)
                for i, (n, e, tier, f) in enumerate(read_fields(), 1)]

    def engines(self):
        return [Ours(), Pari()]

    def same(self, a, b):
        """d and the class group exactly; the regulator to the digits both
        give (at most 15 significant)."""
        if a["disc"] != b["disc"] or list(a["cyc"]) != list(b["cyc"]):
            return False
        x, y = Decimal(a["reg"]), Decimal(b["reg"])
        digits = min(15, _digits(a["reg"]), _digits(b["reg"]))
        return abs(x - y) <= abs(y) * Decimal(10) ** (1 - digits)


NF = NfSuite()
