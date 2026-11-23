#!/usr/bin/env python3
r"""Mutants for a meter review: break one charge or poll site at a time, run the
tests, and report each mutant as KILLED (the tests fail), SURVIVED (they pass:
nothing pins that site) or BUILD-ERROR.  The file is restored after every
mutant, and at the end byte for byte, even on an error or an interrupt.  A hard
kill (SIGKILL, a restart) leaves the mutant in place: `git checkout -- FILE`, or
the copy whose path it printed first.

A site is a line matching --site, a whole statement ending in ';'.  The mutant:
  - with --to-after PAT: the site moves up to just after the nearest line above
    it matching PAT (charge before the work: the count moves ahead of the step).
    {var} in PAT stands for what --site's first group matched, so a count pairs
    with its own charge; a site with no such line above it is listed as skipped;
  - without: the site is deleted (a dropped charge, flush or poll).

The standard ones (a reviewer runs every one that applies, at EVERY site):
  charge before the work   --site '(\w+)\.done\(\);' --to-after 'let {var} = spend\('
  a dropped count          --site '\.done\(\);'
  a dropped poll (Stop)    --site 'poll_host(_now)?\('
  a dropped preflight      --site '\.debit\('

  python3 scripts/meter-mutants.py engine/poly/src/binomial.rs \
      --site '(\w+)\.done\(\);' --to-after 'let {var} = spend\(' \
      --test 'cargo test -q --release -p sagebrush-poly --test binomial_units' --cwd engine
  python3 scripts/meter-mutants.py FILE --site PAT --list     the mutants, run nothing
  ... --only 292,521                                           only the sites on those lines
A moved count is observable only when a poll or an early exit lies inside the
step (--inside): a survivor whose step shows neither is labelled equivalent,
which still holds only if nothing it calls polls.
Exit status: 0 when every mutant is killed, 1 when one survives or doesn't build.
"""
import argparse
import os
import re
import signal
import subprocess
import sys
import tempfile


def sites(lines, site, to_after, skipped=None):
    """(index of the site, index it moves after or None) for each mutant."""
    out = []
    for i, line in enumerate(lines):
        m = re.search(site, line)
        if not m:
            continue
        if not line.rstrip().endswith(";"):
            raise SystemExit("meter-mutants: line %d matches --site but isn't a one-line statement: %s" % (i + 1, line.strip()))
        if to_after is None:
            out.append((i, None))
            continue
        anchor = to_after.replace("{var}", re.escape(m.group(1))) if "{var}" in to_after else to_after
        j = i - 1
        while j >= 0 and not re.search(anchor, lines[j]):
            j -= 1
        if j < 0:
            if skipped is not None:
                skipped.append(i)
            continue
        if j == i - 1:
            continue  # (already right after it: the mutant would be the original)
        out.append((i, j))
    return out


def mutate(lines, i, j):
    m = list(lines)
    line = m.pop(i)
    if j is not None:
        m.insert(j + 1, line)
    return m


def classify(code, output):
    if code == 0:
        return "SURVIVED"
    if re.search(r"error\[E\d+\]|could not compile", output) and "test result:" not in output:
        return "BUILD-ERROR"
    return "KILLED"


def self_test():
    src = ["fn f() {", "  let o = spend(b, Family::A, 3);", "  step();", "  o.done();", "  poll_host();", "}"]
    s = sites(src, r"\.done\(\);", r"= spend\(")
    assert s == [(3, 1)], s
    two = ["let last = spend(b);", "let o = spend(b);", "work();", "o.done();", "more();", "last.done();", "w.done();"]
    skipped = []
    assert sites(two, r"(\w+)\.done\(\);", r"let {var} = spend\(", skipped) == [(3, 1), (5, 0)]
    assert skipped == [6]
    assert sites(two, r"(\w+)\.done\(\);", r"let {var} = spend\(", [])[1] == (5, 0)
    assert mutate(src, 3, 1)[2] == "  o.done();" and mutate(src, 3, 1)[3] == "  step();"
    assert sites(src, r"poll_host\(", None) == [(4, None)]
    assert "poll_host();" not in "".join(mutate(src, 4, None))
    assert sites(["let o = spend(x);", "o.done();"], r"\.done\(\);", r"= spend\(") == []
    assert classify(0, "") == "SURVIVED"
    assert classify(101, "test result: FAILED") == "KILLED"
    assert classify(101, "error[E0425]: cannot find value") == "BUILD-ERROR"
    assert classify(101, "test result: FAILED. 0 passed; 1 failed\nerror: test failed, to rerun pass") == "KILLED"
    try:
        sites(["foo(", "  x) ;", "o.done()"], r"\.done\(\)", None)
        raise AssertionError("a site that isn't a statement must be refused")
    except SystemExit:
        pass
    print("meter-mutants: self-test ok")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("file", nargs="?")
    ap.add_argument("--site")
    ap.add_argument("--to-after")
    ap.add_argument("--test", help="the test command (a shell line)")
    ap.add_argument("--cwd", default=".")
    ap.add_argument("--timeout", type=int, default=1800, help="seconds per mutant")
    ap.add_argument("--inside", default=r"check\(|poll|\?[;)]|return Err",
                    help="what makes a moved count observable: a poll or an early exit inside the step")
    ap.add_argument("--only", help="only the sites on these lines (comma-separated), e.g. a run's survivors")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--self-test", action="store_true")
    a = ap.parse_args()
    if a.self_test:
        return self_test()
    if not a.file or not a.site or not (a.list or a.test):
        ap.error("FILE, --site and --test (or --list) are needed")
    with open(a.file, "rb") as f:
        original = f.read()
    lines = original.decode("utf-8").split("\n")
    skipped = []
    todo = sites(lines, a.site, a.to_after, skipped)
    if a.only:
        keep = {int(n) - 1 for n in a.only.split(",")}
        todo = [(i, j) for i, j in todo if i in keep]
    for i in skipped:
        print("skipped     line %d (no line above it matches --to-after): %s" % (i + 1, lines[i].strip()))
    if not todo:
        raise SystemExit("meter-mutants: no site matches")
    if a.list:
        for i, j in todo:
            print("line %d%s: %s" % (i + 1, " -> after line %d" % (j + 1) if j is not None else " deleted", lines[i].strip()))
        return 0
    backup = tempfile.NamedTemporaryFile(prefix="meter-mutants-", suffix=".orig", delete=False)
    backup.write(original)
    backup.close()
    # (a hard kill or a restart can't run the restore: say where the original is first)
    print("meter-mutants: the original of %s is kept in %s until the end (after a crash: git checkout -- FILE)" % (a.file, backup.name), flush=True)

    def restore():
        with open(a.file, "wb") as f:
            f.write(original)

    def interrupted(sig, _frame):
        restore()
        raise SystemExit(128 + sig)

    signal.signal(signal.SIGINT, interrupted)
    signal.signal(signal.SIGTERM, interrupted)
    results = []
    try:
        for i, j in todo:
            with open(a.file, "w") as f:
                f.write("\n".join(mutate(lines, i, j)))
            try:
                r = subprocess.run(a.test, shell=True, cwd=a.cwd, capture_output=True, text=True, timeout=a.timeout)
                status = classify(r.returncode, r.stdout + r.stderr)
            except subprocess.TimeoutExpired:
                status, r = "TIMEOUT", None
            what = "moved after line %d" % (j + 1) if j is not None else "deleted"
            results.append(status)
            note = ""
            if status == "SURVIVED" and j is not None and not any(re.search(a.inside, l) for l in lines[j + 1:i]):
                note = "  (no poll or early exit visible inside the step: equivalent, unless a callee polls)"
            print("%-11s line %d %s: %s%s" % (status, i + 1, what, lines[i].strip(), note), flush=True)
            if status == "BUILD-ERROR":
                errs = [l for l in (r.stdout + r.stderr).split("\n") if re.search(r"^error", l)]
                print("\n".join("            " + l for l in errs[:6]), flush=True)
    finally:
        restore()
    with open(a.file, "rb") as f:
        if f.read() != original:
            print("meter-mutants: COULD NOT RESTORE %s; the original is %s" % (a.file, backup.name), file=sys.stderr)
            return 3
    os.remove(backup.name)
    killed = results.count("KILLED")
    print("meter-mutants: %d of %d killed" % (killed, len(results)))
    return 0 if killed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
