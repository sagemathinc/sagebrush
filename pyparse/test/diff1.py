"""Show the first AST difference for one file: python3 test/diff1.py FILE"""
import json, os, subprocess, sys
sys.path.insert(0, os.path.dirname(__file__))
import pydump
f = sys.argv[1]
r = json.loads(subprocess.run(["node", os.path.join(os.path.dirname(__file__), "..", "dist", "test", "dump.js"), "--full", f], capture_output=True, text=True).stdout)
if not r.get("ok"):
    print("ours:", r.get("error") or r.get("crash")); print("cpython:", pydump.error(open(f).read())); sys.exit()
mine = json.loads(r["json"]); ref = json.loads(pydump.dump(open(f).read()))
def diff(a, b, path=""):
    if type(a) != type(b): print(path, "ours", repr(a)[:200], "| cpython", repr(b)[:200]); return True
    if isinstance(a, dict):
        for k in sorted(set(a) | set(b)):
            if diff(a.get(k), b.get(k), path + "." + k): return True
    elif isinstance(a, list):
        if len(a) != len(b): print(path, "len", len(a), len(b)); return True
        for i, (x, y) in enumerate(zip(a, b)):
            if diff(x, y, path + "[%d]" % i): return True
    elif a != b: print(path, "ours", repr(a)[:200], "| cpython", repr(b)[:200]); return True
    return False
print("identical" if not diff(mine, ref) else "")
