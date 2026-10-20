"""Check sagebrush's Magma front end (src/magma.ts, lib/_magma.py) against Magma.

    python3 magma-tests/run.py              # every magma-tests/test_*.m
    python3 magma-tests/run.py lang -v      # those whose name contains "lang", with diffs
    python3 magma-tests/run.py --regen      # rewrite the expected outputs with Magma
                                            # (MAGMA=/path/to/magma; default ~/bin/magma)

Each test_*.m runs under `sagebrush --magma`; its stdout must equal test_*.out,
the output of the same program under Magma (committed, so that the check
needs no Magma).  A test_stdin_*.m is given on stdin instead, on both sides,
which Magma reads as a session: errors are reported and the input goes on.
A test whose name contains "error" may exit with a nonzero status.
"""
import difflib, os, subprocess, sys, concurrent.futures as cf

HERE = os.path.dirname(os.path.abspath(__file__))
CLI = os.path.join(os.path.dirname(HERE), "dist", "src", "cli.js")
args = [a for a in sys.argv[1:] if not a.startswith("-")]
verbose = "-v" in sys.argv
files = sorted(f for f in os.listdir(HERE) if f.startswith("test_") and f.endswith(".m") and (not args or any(a in f for a in args)))
MAGMA = os.environ.get("MAGMA", os.path.expanduser("~/bin/magma"))
workers = min(4, max(1, int(os.environ.get("SAGEBRUSH_CPUS", "4"))))


def run(cmd, f):
    stdin = open(os.path.join(HERE, f), "rb") if f.startswith("test_stdin_") else None
    if stdin:
        cmd = cmd[:-1]
    p = subprocess.run(cmd, cwd=HERE, stdin=stdin, capture_output=True, timeout=600)
    return p.returncode, p.stdout.decode(errors="replace"), p.stderr.decode(errors="replace")


if "--regen" in sys.argv:
    for f in files:
        code, out, err = run([MAGMA, "-b", f], f)
        if code:
            sys.exit("magma failed on %s:\n%s" % (f, err[-2000:]))
        open(os.path.join(HERE, f[:-2] + ".out"), "w").write(out)
        print("%-24s %d lines" % (f, out.count("\n")))
    sys.exit(0)


def one(f):
    return f, open(os.path.join(HERE, f[:-2] + ".out")).read(), run(["node", CLI, "--magma", f], f)


bad = 0
with cf.ThreadPoolExecutor(workers) as ex:
    for f, ref, got in ex.map(one, files):
        ok = (got[0] == 0 or "error" in f) and ref == got[1]
        print("%-24s %s  (%d lines)" % (f, "ok" if ok else "DIFF", ref.count("\n")))
        if not ok:
            bad += 1
            if verbose or len(files) == 1:
                if got[0]:
                    print("  " + got[2].strip().replace("\n", "\n  ")[-1500:])
                for line in list(difflib.unified_diff(ref.splitlines(), got[1].splitlines(), "magma", "sagebrush", lineterm="", n=0))[:80]:
                    print("  " + line[:300])
print("%d/%d identical" % (len(files) - bad, len(files)))
sys.exit(1 if bad else 0)
