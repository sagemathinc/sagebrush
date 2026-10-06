"""Check `sagebrush.sage` (the Sage layer under plain CPython) against Sage.

    python sage-tests/run_cpython.py           # needs `pip install sagebrush` (or a dev build)
    python sage-tests/run_cpython.py -v        # with diffs
    python sage-tests/run_cpython.py --regen   # re-preparse; needs a Python with Sage

Each test_*.sage is turned into plain Python by Sage's own preparser
(sage-tests/preparsed/test_*.py, committed: Integer(...) literals, ** for
^), the dialect a CPython user writes.  Run after `from sagebrush.sage
import *`, its stdout must equal test_*.out, the output of the .sage file
under Sage.
"""
import difflib, os, subprocess, sys, concurrent.futures as cf

HERE = os.path.dirname(os.path.abspath(__file__))
PRE = os.path.join(HERE, "preparsed")
verbose = "-v" in sys.argv

if "--regen" in sys.argv:
    from sage.repl.preparse import preparse_file

    os.makedirs(PRE, exist_ok=True)
    for f in sorted(os.listdir(HERE)):
        if f.startswith("test_") and f.endswith(".sage"):
            py = preparse_file(open(os.path.join(HERE, f)).read())
            open(os.path.join(PRE, f[:-5] + ".py"), "w").write("# Generated from ../%s by Sage's preparser (run_cpython.py --regen).\n%s" % (f, py))
            print(f)
    sys.exit(0)

files = sorted(f for f in os.listdir(PRE) if f.startswith("test_") and f.endswith(".py"))


def one(f):
    # (the file is read by a short driver: Windows limits command lines)
    path = os.path.join(PRE, f)
    code = "from sagebrush.sage import *\nexec(compile(open(%r, encoding='utf-8').read(), %r, 'exec'))" % (path, path)
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
    p = subprocess.run([sys.executable, "-c", code], cwd=HERE, capture_output=True, timeout=900, env=env)
    out = p.stdout.decode("utf-8", errors="replace").replace("\r\n", "\n")
    ref = open(os.path.join(HERE, f[:-3] + ".out"), encoding="utf-8").read()
    return f, ref, p.returncode, out, p.stderr.decode("utf-8", errors="replace")


bad = 0
with cf.ThreadPoolExecutor(4) as ex:
    for f, ref, code, out, err in ex.map(one, files):
        ok = code == 0 and out == ref
        print("%-24s %s  (%d lines)" % (f, "ok" if ok else "DIFF", ref.count("\n")))
        if not ok:
            bad += 1
            if verbose:
                if code:
                    print("  " + err.strip().replace("\n", "\n  ")[-1500:])
                for line in list(difflib.unified_diff(ref.splitlines(), out.splitlines(), "sage", "sagebrush.sage", lineterm="", n=0))[:60]:
                    print("  " + line[:300])
print("%d/%d identical" % (len(files) - bad, len(files)))
sys.exit(1 if bad else 0)
