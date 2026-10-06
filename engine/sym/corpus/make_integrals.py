"""Run Maxima (what Sage's integrate uses) on corpus/integrals.txt and
write corpus/integrals.json: [{"in": f, "maxima": F or null}], F in Sage
syntax (null when Maxima leaves the integral unevaluated or fails).

    python3 make_integrals.py        (needs maxima on the PATH)
"""
import json, os, re, subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
lines = [l.strip() for l in open(os.path.join(HERE, "integrals.txt")) if l.strip() and not l.startswith("#")]


def to_maxima(s):
    s = s.replace("arctan", "atan").replace("arcsin", "asin").replace("arccos", "acos")
    return s


def from_maxima(s):
    s = s.replace("%e", "e").replace("%pi", "pi").replace("%i", "I")
    for a, b in (("atan", "arctan"), ("asin", "arcsin"), ("acos", "arccos"), ("asinh", "arcsinh"),
                 ("acosh", "arccosh"), ("atanh", "arctanh")):
        s = re.sub(r"\b%s\(" % a, b + "(", s)
    s = s.replace("arcarctan", "arctan")
    return s


out = []
for f in lines:
    prog = "display2d:false$ linel:100000$ r: integrate(%s, x)$ print(\"@@\", r)$" % to_maxima(f)
    try:
        p = subprocess.run(["maxima", "--very-quiet", "--batch-string=" + prog], capture_output=True, text=True, timeout=60)
        m = re.search(r"@@ (.*)", p.stdout)
        r = m.group(1).strip() if m else None
    except subprocess.TimeoutExpired:
        r = None
    if r is not None and ("integrate" in r or "?" in r):
        r = None
    out.append({"in": f, "maxima": from_maxima(r) if r else None})
    print(f, "->", out[-1]["maxima"])
json.dump(out, open(os.path.join(HERE, "integrals.json"), "w"), indent=0)
