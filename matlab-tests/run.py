"""Check sagebrush's MATLAB front end (src/matlab.ts, lib/_matlab.py) against GNU Octave.

    python3 matlab-tests/run.py              # every matlab-tests/test_*.m
    python3 matlab-tests/run.py index -v     # those whose name contains "index", with diffs
    python3 matlab-tests/run.py --regen      # rewrite the expected outputs with Octave
                                             # (OCTAVE=/path/to/octave-cli; see design/matlab.md)

Each test_*.m runs under `sagebrush --matlab`; its stdout must equal the
expected output, which is committed (so that the check needs no Octave):

- test_NAME.out: the output of the same program under Octave.  These tests
  print values with show.m (class, size, mat2str(x, 17)) or fprintf, whose
  output MATLAB and Octave agree on, since their displays (x = 5) differ.
- test_NAME.matlab.out: MATLAB's own output, written by hand from MATLAB's
  documented behaviour (its display format, and the places where Octave
  differs from MATLAB).  --regen never touches these.
"""
import difflib, os, subprocess, sys, concurrent.futures as cf

HERE = os.path.dirname(os.path.abspath(__file__))
CLI = os.path.join(os.path.dirname(HERE), "dist", "src", "cli.js")
args = [a for a in sys.argv[1:] if not a.startswith("-")]
verbose = "-v" in sys.argv
files = sorted(f for f in os.listdir(HERE) if f.startswith("test_") and f.endswith(".m") and (not args or any(a in f for a in args)))
OCTAVE = os.environ.get("OCTAVE", "/scratch/octave-root/octave-cli")


def run(cmd):
    p = subprocess.run(cmd, cwd=HERE, capture_output=True, timeout=600)
    return p.returncode, p.stdout.decode(errors="replace"), p.stderr.decode(errors="replace")


def expected(f):
    base = f[:-2]
    m = os.path.join(HERE, base + ".matlab.out")
    if os.path.exists(m):
        return "matlab", m
    return "octave", os.path.join(HERE, base + ".out")


def octave_copy(f):
    """f as Octave runs it: MATLAB puts a script's functions at its end,
    Octave needs them defined before they are called (and a script that
    does not start with `function`, hence the `1;`)"""
    lines = open(os.path.join(HERE, f)).read().split("\n")
    k = next((i for i, l in enumerate(lines) if l.startswith("function ")), len(lines))
    name = "octave_" + f
    open(os.path.join(HERE, name), "w").write("\n".join(["1;"] + lines[k:] + lines[:k]) + "\n")
    return name


if "--regen" in sys.argv:
    for f in files:
        kind, path = expected(f)
        if kind == "matlab":
            print("%-28s (MATLAB's output, kept)" % f)
            continue
        code, out, err = run([OCTAVE, "--norc", "--quiet", "--no-history", "--no-window-system", octave_copy(f)])
        os.unlink(os.path.join(HERE, octave_copy(f)))
        if code:
            sys.exit("octave failed on %s:\n%s" % (f, err[-2000:]))
        open(path, "w").write(out)
        print("%-28s %d lines" % (f, out.count("\n")))
    sys.exit(0)


def one(f):
    kind, path = expected(f)
    return f, kind, open(path).read(), run(["node", CLI, "--matlab", f])


bad = 0
total = 0
with cf.ThreadPoolExecutor(4) as ex:
    for f, kind, ref, got in ex.map(one, files):
        ok = got[0] == 0 and ref == got[1]
        n = ref.count("\n")
        total += n
        print("%-28s %s  (%d lines, %s)" % (f, "ok" if ok else "DIFF", n, kind))
        if not ok:
            bad += 1
            if verbose or len(files) == 1:
                if got[0]:
                    print("  " + got[2].strip().replace("\n", "\n  ")[-1500:])
                for line in list(difflib.unified_diff(ref.splitlines(), got[1].splitlines(), kind, "sagebrush", lineterm="", n=0))[:80]:
                    print("  " + line[:300])
print("%d/%d identical (%d lines)" % (len(files) - bad, len(files), total))
sys.exit(1 if bad else 0)
