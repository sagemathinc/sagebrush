"""Run the sage: examples of Sage's English documentation (not the reference
manual) through Sagebrush (CPython package, Sage preparser), one session per
file, and classify each example: ok (output matches), random-ok, wrong
(ran, output differs), error, timeout, skipped.  Writes JSON per file.

  python3 rundocs.py FILE.rst OUT.json
"""
import sys, io, re, json, signal, traceback, contextlib, time
src_file, out_file = sys.argv[1], sys.argv[2]

def examples(text):
    lines = text.split("\n")
    i = 0
    out = []
    while i < len(lines):
        m = re.match(r"^(\s*)sage: ?(.*)$", lines[i])
        if not m:
            i += 1
            continue
        ind = m.group(1)
        code = [m.group(2)]
        i += 1
        while i < len(lines) and re.match(r"^\s*\.\.\.\.: ?", lines[i]):
            code.append(re.sub(r"^\s*\.\.\.\.: ?", "", lines[i]))
            i += 1
        want = []
        while i < len(lines) and lines[i].strip() and not re.match(r"^\s*sage: ", lines[i]):
            l = lines[i]
            want.append(l[len(ind):] if l.startswith(ind) else l.strip())
            i += 1
        out.append(("\n".join(code), "\n".join(want)))
    return out

def norm(s):
    return " ".join(s.split())

def match(want, got):
    w, g = norm(want), norm(got)
    if w == g:
        return True
    if "..." in w:
        pat = ".*".join(re.escape(p) for p in w.split("..."))
        return re.fullmatch(pat, g, re.S) is not None
    return False

class Timeout(Exception):
    pass

def on_alarm(*a):
    raise Timeout()

# real Sage is installed in this Python: keep it out (imports of sage.*
# must fail as they would without it)
import importlib.abc
class _NoSage(importlib.abc.MetaPathFinder):
    def find_spec(self, name, path, target=None):
        if name == "sage" or name.startswith("sage.") or name in ("sage_setup", "cypari2", "sage_conf"):
            raise ImportError("real Sage is blocked in this measurement: " + name)
        return None
sys.meta_path.insert(0, _NoSage())

res = {"file": src_file, "examples": []}
t0 = time.time()
try:
    import sagebrush.sage as S
    from sagebrush.preparse import preparse
    import types
    main = types.ModuleType("__main__")
    sys.modules["__main__"] = main
    ns = main.__dict__
    exec("from sagebrush.sage import *", ns)
except Exception as e:
    res["import_error"] = repr(e)
    json.dump(res, open(out_file, "w"))
    sys.exit(0)

signal.signal(signal.SIGALRM, on_alarm)
text = open(src_file).read()
for code, want in examples(text):
    flags = code.split("#", 1)[1].lower() if "#" in code else ""
    rec = {"code": code[:300], "want": want[:300]}
    if "not tested" in flags or "optional" in flags or "needs " in flags and "internet" in flags:
        rec["status"] = "skipped"
        res["examples"].append(rec)
        continue
    buf = io.StringIO()
    try:
        py = preparse(code)
        signal.alarm(10)
        with contextlib.redirect_stdout(buf):
            try:
                c = compile(py, "<doc>", "single")
            except SyntaxError:
                c = compile(py, "<doc>", "exec")
            exec(c, ns)
        signal.alarm(0)
        got = buf.getvalue()
        if "random" in flags or not want.strip():
            rec["status"] = "ok" if not want.strip() or "random" not in flags else "random-ok"
        else:
            rec["status"] = "ok" if match(want, got) else "wrong"
            if rec["status"] == "wrong":
                rec["got"] = got[:300]
    except Timeout:
        rec["status"] = "timeout"
    except BaseException as e:
        signal.alarm(0)
        tb = "".join(traceback.format_exception_only(type(e), e)).strip()
        # an expected exception counts as ok when the traceback is wanted
        if "Traceback" in want and type(e).__name__ in want:
            rec["status"] = "ok"
        else:
            rec["status"] = "error"
            rec["error"] = tb[:200]
    res["examples"].append(rec)
res["seconds"] = time.time() - t0
json.dump(res, open(out_file, "w"))
