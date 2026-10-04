"""Compare our parser with CPython's on every .py file under a directory:
identical AST (canonical JSON) for valid files, identical SyntaxError
(type, msg, lineno, offset, end_lineno, end_offset) for invalid ones.
    python3 test/compare_stdlib.py [DIR]"""
import hashlib, json, os, subprocess, sys, time, collections
sys.path.insert(0, os.path.dirname(__file__))
import pydump

root = sys.argv[1] if len(sys.argv) > 1 else "/usr/lib/python3.14"
files = []
for d, _, fs in os.walk(root):
    if ("site-packages" in d and "site-packages" not in root) or "__pycache__" in d:
        continue
    files += [os.path.join(d, f) for f in fs if f.endswith(".py")]
files.sort()
ref = {}
t0 = time.time()
for f in files:
    try:
        src = open(f, encoding="utf-8").read()
    except Exception:
        continue
    try:
        ref[f] = ("ok", hashlib.sha1(pydump.dump(src).encode()).hexdigest())
    except SyntaxError:
        ref[f] = ("err", pydump.error(src))
    except Exception as e:
        ref[f] = ("skip", repr(e))
tc = time.time() - t0
here = os.path.dirname(os.path.abspath(__file__))
t0 = time.time()
out = subprocess.run(["node", os.path.join(here, "..", "dist", "test", "dump.js")], input="\n".join(ref), capture_output=True, text=True)
tj = time.time() - t0
stats, bad = collections.Counter(), []
ms = 0.0
for line in out.stdout.splitlines():
    r = json.loads(line)
    kind, val = ref[r["file"]]
    if kind == "skip":
        stats["skipped"] += 1
        continue
    if r.get("ok"):
        ms += r["ms"]
        if kind == "ok" and r["sha"] == val: stats["ast identical"] += 1
        else: stats["ast differs" if kind == "ok" else "accepted invalid file"] += 1; bad.append((r["file"], kind, val, r))
    elif "crash" in r:
        stats["crash"] += 1; bad.append((r["file"], kind, val, r))
    else:
        if kind == "err" and r["error"] == val: stats["error identical"] += 1
        else: stats["error differs" if kind == "err" else "rejected valid file"] += 1; bad.append((r["file"], kind, val, r))
print(f"{len(ref)} files; CPython ast.parse+dump {tc:.1f} s; ours (node, incl. startup and dump) {tj:.1f} s, parse only {ms/1000:.1f} s")
print(dict(stats))
for f, kind, val, r in bad[:25]:
    print("--", f, kind, str(val)[:100], "| ours:", str(r.get("error") or r.get("crash") or r.get("sha"))[:300])
