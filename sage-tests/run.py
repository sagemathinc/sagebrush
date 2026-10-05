"""Check sagebrush's Sage mode against Sage itself.

    python3 sage-tests/run.py               # every sage-tests/test_*.sage
    python3 sage-tests/run.py modsym -v     # those whose name contains "modsym", with diffs
    python3 sage-tests/run.py --regen       # rewrite the expected outputs with Sage

Each test_*.sage runs under `sagebrush --sage`; its stdout must equal
test_*.out, the output of the same program under Sage (committed, so that
the check needs no Sage).  Programs print results rather than assert.
"""
import difflib, os, subprocess, sys, concurrent.futures as cf

HERE = os.path.dirname(os.path.abspath(__file__))
CLI = os.path.join(os.path.dirname(HERE), "dist", "src", "cli.js")
args = [a for a in sys.argv[1:] if not a.startswith("-")]
verbose = "-v" in sys.argv
files = sorted(f for f in os.listdir(HERE) if f.startswith("test_") and f.endswith(".sage") and (not args or any(a in f for a in args)))


def run(cmd):
    p = subprocess.run(cmd, cwd=HERE, capture_output=True, timeout=600)
    return p.returncode, p.stdout.decode(errors="replace"), p.stderr.decode(errors="replace")


if "--regen" in sys.argv:
    for f in files:
        code, out, err = run(["sage", f])
        if code:
            sys.exit("sage failed on %s:\n%s" % (f, err[-2000:]))
        open(os.path.join(HERE, f[:-5] + ".out"), "w").write(out)
        print("%-24s %d lines" % (f, out.count("\n")))
    sys.exit(0)


def one(f):
    return f, open(os.path.join(HERE, f[:-5] + ".out")).read(), run(["node", CLI, "--sage", f])


bad = 0
with cf.ThreadPoolExecutor(4) as ex:
    for f, ref, got in ex.map(one, files):
        ok = got[0] == 0 and ref == got[1]
        print("%-24s %s  (%d lines)" % (f, "ok" if ok else "DIFF", ref.count("\n")))
        if not ok:
            bad += 1
            if verbose or len(files) == 1:
                if got[0]:
                    print("  " + got[2].strip().replace("\n", "\n  ")[-1500:])
                for line in list(difflib.unified_diff(ref.splitlines(), got[1].splitlines(), "sage", "sagebrush", lineterm="", n=0))[:80]:
                    print("  " + line[:300])
print("%d/%d identical" % (len(files) - bad, len(files)))
sys.exit(1 if bad else 0)
