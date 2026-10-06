"""Run Maxima's ode2 (with ic1/ic2) on corpus/odes.txt; write
corpus/odes.json: [{"in", "ics", "maxima"}] with Maxima's solution in
Sage syntax as Sage's desolve returns it (the right side of y = ..., or
the implicit equation with y(x)); null when ode2 fails."""
import json, os, re, subprocess

HERE = os.path.dirname(os.path.abspath(__file__))


def to_maxima(s):
    s = re.sub(r"diff\(y\(x\), x, 2\)", "'diff(y,x,2)", s)
    s = re.sub(r"diff\(y\(x\), x\)", "'diff(y,x)", s)
    return s.replace("y(x)", "y").replace("==", "=")


def from_maxima(s):
    s = s.replace("%e", "e").replace("%pi", "pi").replace("%c", "_C").replace("%k1", "_K1").replace("%k2", "_K2")
    s = re.sub(r"\by\b", "y(x)", s)
    return s


out = []
for line in open(os.path.join(HERE, "odes.txt")):
    line = line.strip()
    if not line or line.startswith("#"):
        continue
    de, _, ics = line.partition(";")
    ics = [t.strip() for t in ics.split(",")] if ics.strip() else []
    prog = "display2d:false$ linel:100000$ s: ode2(%s, y, x)$ " % to_maxima(de.strip())
    if len(ics) == 2:
        prog += "s: ic1(s, x=%s, y=%s)$ " % tuple(ics)
    elif len(ics) == 3:
        prog += "s: ic2(s, x=%s, y=%s, 'diff(y,x)=%s)$ " % tuple(ics)
    prog += 'print("@@", s)$'
    p = subprocess.run(["maxima", "--very-quiet", "--batch-string=" + prog], capture_output=True, text=True, timeout=60)
    m = re.search(r"@@ (.*)", p.stdout)
    r = m.group(1).strip() if m else None
    if r in (None, "false"):
        r = None
    else:
        # y = expr: Sage returns expr
        mm = re.match(r"^y = (.*)$", r)
        r = from_maxima(mm.group(1)) if mm else from_maxima(r.replace(" = ", " == "))
    out.append({"in": de.strip(), "ics": ics, "maxima": r})
    print(de.strip(), ics, "->", r)
json.dump(out, open(os.path.join(HERE, "odes.json"), "w"), indent=0)
