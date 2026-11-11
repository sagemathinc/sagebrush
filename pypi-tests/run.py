"""The curated PyPI packages' own tests, under CPython and Sagebrush
(packages/pypi-<name>/, scripts/pypi-import.mjs). For each pypi-tests/<name>/:

- its upstream test files must be the ones SOURCE.json pins (each file's
  SHA-256; with --fetch, also re-derived from the pinned archive);
- CPython, with the committed package sources on its path, must print
  expected.out (pypi-tests/harness.py: one status record per pinned upstream
  test function, plus any stdout that test emits);
- Sagebrush (build/cli/pyjs.cjs, which finds the package through its
  registry) must print exactly the same. An optional excluded.json is applied
  identically by the harness under both interpreters.

A package whose tests do not all agree is not listed: Sagebrush raising an
error where CPython passes is a difference too.

    python3 pypi-tests/run.py [-v] [--fetch] [NAME...]
    python3 pypi-tests/run.py --refresh NAME    write expected.out from CPython
"""
import hashlib
import io
import re
import json
import os
import secrets
import subprocess
import sys
import tarfile
import urllib.request
import zlib

script = os.path.dirname(os.path.abspath(__file__))
root = os.path.dirname(script)
# (where the tests and packages are, and the two interpreters: these, unless
# test/pypi-tests-runner.test.ts gives others, to check this runner's gates)
here = os.environ.get("PYPI_TESTS_DIR") or script
packages = os.environ.get("PYPI_TESTS_PACKAGES") or os.path.join(root, "packages")
CPYTHON = json.loads(os.environ["PYPI_TESTS_CPYTHON"]) if os.environ.get("PYPI_TESTS_CPYTHON") else [sys.executable]
SAGEBRUSH = json.loads(os.environ["PYPI_TESTS_SAGEBRUSH"]) if os.environ.get("PYPI_TESTS_SAGEBRUSH") else ["node", os.path.join(root, "build", "cli", "pyjs.cjs")]
args = [a for a in sys.argv[1:] if not a.startswith("-")]
verbose = "-v" in sys.argv
names = args or sorted(d for d in os.listdir(here) if os.path.exists(os.path.join(here, d, "SOURCE.json")))
sha = lambda b: hashlib.sha256(b).hexdigest()
# (--fetch's ceilings, checked before the work they bound: the archive as
# downloaded, and each pinned member, read only if a regular file)
ARCHIVE_BYTES = 64 << 20
MEMBER_BYTES = 16 << 20
TAR_BYTES = 256 << 20
TAR_MEMBERS = 20000
# (a pinned test file is a plain name in upstream/: no directory, no dot-dot)
FILE_NAME = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]*\.py$")
RECORD_PREFIX = "__SAGEBRUSH_PYPI_RECORD_%s__" % secrets.token_hex(16)


def run(cmd, env=None):
    p = subprocess.run(cmd, cwd=root, env=env, capture_output=True, text=True, timeout=3600)
    return p.stdout, p.stderr, p.returncode


def exited(who, err, rc):
    """Why a child's run does not count, or None: it must exit 0 with nothing
    on stderr (the harness prints only its records, to stdout), so a crash or
    a fatal error after the expected records is never accepted."""
    if rc != 0:
        return "%s exited with %d%s" % (who, rc, ": " + err.strip()[-500:] if err.strip() else "")
    if err:
        return "%s wrote to stderr: %s" % (who, err.strip()[-500:])
    return None


def records(out, modules):
    """Decode the harness-owned channel and require one record per name."""
    got, declared, inventories = {}, set(), set()
    for line in out.splitlines():
        if not line.startswith(RECORD_PREFIX):
            continue
        row = json.loads(line[len(RECORD_PREFIX):])
        if isinstance(row, dict) and sorted(row) == ["module", "tests"] and isinstance(row["module"], str) and isinstance(row["tests"], list) and all(isinstance(x, str) for x in row["tests"]):
            if row["module"] in inventories:
                raise ValueError("duplicate harness inventory for %s" % row["module"])
            inventories.add(row["module"])
            for name in row["tests"]:
                if name in declared:
                    raise ValueError("duplicate discovered test %s" % name)
                declared.add(name)
            continue
        if not isinstance(row, list) or len(row) != 2 or not all(isinstance(x, str) for x in row):
            raise ValueError("malformed harness record")
        name, status = row
        if name in got:
            raise ValueError("duplicate harness record for %s" % name)
        if status not in ("ok", "skipped", "excluded") and not status.startswith("FAIL "):
            raise ValueError("unknown harness status for %s" % name)
        got[name] = status
    missing_modules, extra_modules = sorted(set(modules) - inventories), sorted(inventories - set(modules))
    if missing_modules:
        raise ValueError("missing harness inventories for %s" % ", ".join(missing_modules))
    if extra_modules:
        raise ValueError("inventories for unpinned modules %s" % ", ".join(extra_modules))
    missing, extra = sorted(declared - set(got)), sorted(set(got) - declared)
    if missing:
        raise ValueError("missing harness records for %s" % ", ".join(missing))
    if extra:
        raise ValueError("records for undiscovered tests %s" % ", ".join(extra))
    return got


def normal(out, name):
    """A run's output with what is presentation, not behaviour, made the
    same: a traceback a test prints names the package's files by where they
    are (the repository's packages/, or the CLI bundle's /$pyjs/packages/),
    so that prefix becomes <package>/; and CPython's caret lines under a
    traceback's source line (^^^, ~~~), which Sagebrush does not print, are
    left out."""
    pre = re.compile(r'"[^"]*/packages/pypi-' + re.escape(name.lower()) + r'/py/')
    lines = []
    for line in out.splitlines(True):
        if line.startswith(RECORD_PREFIX):
            row = json.loads(line[len(RECORD_PREFIX):])
            if isinstance(row, dict):
                continue
            test, status = row
            line = "%s: %s\n" % (test, status)
        if not re.match(r"^\s+[~^]+\s*$", line):
            lines.append(pre.sub('"<package>/', line))
    return "".join(lines)


def record_counts(got):
    counts = {"ok": 0, "skipped": 0, "excluded": 0, "FAIL": 0}
    for status in got.values():
        counts["FAIL" if status.startswith("FAIL") else status] += 1
    return counts


def summary(got):
    counts = record_counts(got)
    total = sum(counts.values())
    return "%d tests (%d passed, %d skipped, %d excluded)" % (
        total, counts["ok"], counts["skipped"], counts["excluded"]
    )


bad = 0
for name in names:
    d = os.path.join(here, name)
    src = json.load(open(os.path.join(d, "SOURCE.json")))
    # (the test files are the pinned ones, and only those)
    up = os.path.join(d, "upstream")
    have = sorted(f for f in os.listdir(up) if f != "__pycache__")
    test_modules = sorted(f[:-3] for f in src["files"] if f.startswith("test_") and f.endswith(".py"))
    problems = ["SOURCE.json pins %r, not a plain .py name" % f for f in src["files"] if not FILE_NAME.match(f)]
    if problems:
        print("%s: FAILED\n  %s" % (name, "\n  ".join(problems)))
        bad = 1
        continue
    if have != sorted(src["files"]):
        problems.append("upstream/ has %s, SOURCE.json pins %s" % (have, sorted(src["files"])))
    for f, h in src["files"].items():
        p = os.path.join(up, f)
        if os.path.exists(p) and sha(open(p, "rb").read()) != h:
            problems.append("upstream/%s is not the pinned file" % f)
    if "--fetch" in sys.argv:
        a = src["archive"]
        data = urllib.request.urlopen(a["url"], timeout=60).read(ARCHIVE_BYTES + 1)
        if len(data) > ARCHIVE_BYTES:
            problems.append("%s: past the %d bytes allowed" % (a["url"], ARCHIVE_BYTES))
        elif sha(data) != a["sha256"]:
            problems.append("%s: SHA-256 %s, not the pinned %s" % (a["url"], sha(data), a["sha256"]))
        else:
            # (gunzipped here, to at most TAR_BYTES, then read as a plain tar)
            z = zlib.decompressobj(16 + zlib.MAX_WBITS)
            tar = z.decompress(data, TAR_BYTES + 1)
            if len(tar) > TAR_BYTES or z.unconsumed_tail:
                problems.append("%s: past the %d bytes allowed uncompressed" % (a["url"], TAR_BYTES))
                tar = None
            # (one pass, as a stream: counted as it goes, refused past
            # TAR_MEMBERS, each header dropped once read, and only the pinned
            # members hashed, as they pass)
            got, n = {}, 0
            if tar is not None:
                t = tarfile.open(fileobj=io.BytesIO(tar), mode="r|")
                want = {a["root"] + "/" + f: f for f in src["files"]}
                while True:
                    i = t.next()
                    if i is None:
                        break
                    n += 1
                    if n > TAR_MEMBERS:
                        problems.append("%s: more than %d members" % (a["url"], TAR_MEMBERS))
                        break
                    f = want.get(i.name)
                    if f is not None:
                        # (a link is not followed: only a regular file of its own)
                        if f in got or not i.isfile() or i.size > MEMBER_BYTES:
                            got[f] = None
                        else:
                            got[f] = sha(t.extractfile(i).read(MEMBER_BYTES + 1))
                    t.members = []
                for f, h in src["files"].items() if n <= TAR_MEMBERS else ():
                    if got.get(f) is None:
                        problems.append("%s/%s: not one regular file of at most %d bytes in the archive" % (a["root"], f, MEMBER_BYTES))
                    elif got[f] != h:
                        problems.append("upstream/%s is not the archive's %s/%s" % (f, a["root"], f))
    # (a package whose suite another per-PR runner already runs, SOURCE.json's "gate" (README.md, "One
    # exception"): its pinned files are checked as above, and its suite runs here only when it is named)
    gate = src.get("gate")
    if gate is not None and (not isinstance(gate, dict) or sorted(gate) != ["reason", "runner"] or not all(isinstance(v, str) and v for v in gate.values())):
        problems.append('SOURCE.json "gate" must be {"runner": ..., "reason": ...}')
    if gate is not None and name not in args:
        if problems:
            bad += 1
            print("%s %s: FAIL" % (name, src["version"]))
            for p in problems:
                print("  " + p)
        else:
            print("%s %s: pinned files checked; its suite runs per PR in %s (python3 pypi-tests/run.py %s runs it here)" % (name, src["version"], gate["runner"], name))
        continue
    pkgdir = os.path.join(packages, "pypi-" + name.lower(), "py")
    env = dict(os.environ, PYTHONPATH=pkgdir, PYTHONHASHSEED="0", PYPI_TEST_RECORD_PREFIX=RECORD_PREFIX)
    # (CPython, the reference, runs a package's own Python: the overlaid mpmath's default backend is Sagebrush's
    # core, which only Sagebrush has, so CPython takes the rollback, mpmath's python backend; other packages ignore it)
    cp, cerr, crc = run(CPYTHON + [os.path.join(script, "harness.py"), d], dict(env, SAGEBRUSH_MPMATH_BACKEND="python"))
    why = exited("CPython", cerr, crc)
    if why is not None:
        print("%s %s: FAIL\n  %s" % (name, src["version"], why))
        bad += 1
        continue
    cp_records = records(cp, test_modules)
    cp = normal(cp, name)
    if "--refresh" in sys.argv:
        open(os.path.join(d, "expected.out"), "w").write(cp)
        print("%s: expected.out written (%s, %d failed under CPython)" % (name, summary(cp_records), record_counts(cp_records)["FAIL"]))
        continue
    want = open(os.path.join(d, "expected.out")).read()
    # (its known differences, packages/pypi-<name>/known.json: each test may
    # fail here only with exactly that error, its type and message, where
    # CPython passes; README.md)
    kp = os.path.join(packages, "pypi-" + name.lower(), "known.json")
    known = {t["test"]: t for t in json.load(open(kp))["tests"]} if os.path.exists(kp) else {}
    if cp != want:
        problems.append("CPython does not print expected.out:\n" + "".join("    " + l + "\n" for l in sorted(set(cp.splitlines()) ^ set(want.splitlines()))[:20]) + (cerr[-1000:] if verbose else ""))
    sp, serr, sbrc = run(SAGEBRUSH + [os.path.join(script, "harness.py"), d], dict(os.environ, PYTHONHASHSEED="0", PYPI_TEST_RECORD_PREFIX=RECORD_PREFIX))
    why = exited("Sagebrush", serr, sbrc)
    if why is not None:
        problems.append(why)
        sp_records = {}
    else:
        sp_records = records(sp, test_modules)
    sp = normal(sp, name)
    # (a known test's line: CPython's "ok", Sagebrush's that FAIL; then the
    # same line on both sides for the comparison)
    sl = sp.splitlines(True)
    for t in known.values():
        okline = t["test"] + ": ok\n"
        if okline not in want.splitlines(True):
            problems.append("known.json lists %s, which does not pass under CPython (or is not a test)" % t["test"])
            continue
        hits = [i for i, l in enumerate(sl) if l.startswith(t["test"] + ": ")]
        if len(hits) != 1:
            problems.append("known.json lists %s, which Sagebrush ran %d times" % (t["test"], len(hits)))
            continue
        line = sl[hits[0]]
        if line == okline:
            problems.append("known.json lists %s, which now passes here: remove it" % t["test"])
        elif line != ("%s: FAIL %s: %s" % (t["test"], t["error"], t["message"])).rstrip() + "\n":
            problems.append("known.json lists %s as failing with %s: %s, but here: %s" % (t["test"], t["error"], t["message"], line.strip()))
        else:
            sl[hits[0]] = okline
    sp = "".join(sl)
    if sp != want:
        w, s = want.splitlines(), sp.splitlines()
        diff = [l for l in w if l not in s]
        problems.append("Sagebrush differs from expected.out in %d of %d lines:\n" % (len(diff) + abs(len(w) - len(s)) * 0, len(w)) + "".join("    expected %s\n" % l for l in diff[:30]) + "".join("    got      %s\n" % l for l in s if l not in w)[:4000] + (serr[-2000:] if verbose else ""))
    if problems:
        bad += 1
        print("%s %s: FAIL" % (name, src["version"]))
        for p in problems:
            print("  " + p)
    else:
        print("%s %s: %s, CPython and Sagebrush identical%s" % (name, src["version"], summary(cp_records), "".join("; %s fails here as known (%s)" % (k, t["error"]) for k, t in known.items())))
sys.exit(1 if bad else 0)
