"""Run Maxima on corpus/limits.txt; write corpus/limits.json:
[{"in", "at", "dir", "maxima"}] with Maxima's answer in Sage syntax
(null when Maxima returns the limit unevaluated)."""
import json, os, re, subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
out = []
for line in open(os.path.join(HERE, "limits.txt")):
    line = line.strip()
    if not line or line.startswith("#"):
        continue
    parts = [p.strip() for p in line.split(";")]
    f, at, d = parts[0], parts[1], parts[2] if len(parts) > 2 else None
    mf = f.replace("arctan", "atan")
    mat = {"oo": "inf", "-oo": "minf"}.get(at, at)
    prog = "display2d:false$ r: limit(%s, x, %s%s)$ print(\"@@\", r)$" % (mf, mat, ", " + d if d else "")
    p = subprocess.run(["maxima", "--very-quiet", "--batch-string=" + prog], capture_output=True, text=True, timeout=60)
    m = re.search(r"@@ (.*)", p.stdout)
    r = m.group(1).strip() if m else None
    if r is not None and ("limit" in r):
        r = None
    if r is not None:
        r = {"inf": "+Infinity", "minf": "-Infinity", "infinity": "Infinity", "und": "und", "ind": "ind"}.get(r, r)
        r = r.replace("%e", "e").replace("%pi", "pi")
    out.append({"in": f, "at": at, "dir": d, "maxima": r})
    print(f, at, d, "->", r)
json.dump(out, open(os.path.join(HERE, "limits.json"), "w"), indent=0)
