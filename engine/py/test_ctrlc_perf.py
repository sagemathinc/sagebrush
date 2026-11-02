"""ctrlc_perf.py's own harness checks (PR B r5f, daybreak2's r5e REVISE), with a
stub child in place of the timing child, so no wheel is needed:

- interpreters given on the command line as RELATIVE paths still run after
  sample() moves each child into its fresh directory: main() resolves them
  once, first, and the JSON records the resolved, absolute paths (the
  Windows job passes venv-A/Scripts/python.exe);
- the same relative path, unresolved, names nothing from the child's fresh
  cwd (POSIX), which is the trap the resolution closes;
- the handshake: a child that reports another cwd, or another interpreter,
  fails the sample.

    python engine/py/test_ctrlc_perf.py
"""
import json
import os
import sys
import tempfile

import ctrlc_perf as P

STUB = "import json, os, sys\nprint(json.dumps({\"cwd\": %s, \"executable\": %s, \"noop\": 1.0}))\n"
GOOD = STUB % ("os.getcwd()", "sys.executable")


def check(cond, what):
    if not cond:
        raise AssertionError(what)


def raises(f, *args):
    try:
        f(*args)
    except (RuntimeError, OSError):
        return True
    return False


def interpreter_below(w):
    """A relative path that points DOWN to this interpreter (like the Windows job's venv-A/Scripts/python.exe): w/bin/py,
    a symlink.  From any other directory it names nothing (a "../.." path could still reach it from a sibling)."""
    os.mkdir(os.path.join(w, "bin"))
    os.symlink(sys.executable, os.path.join(w, "bin", "py"))
    return os.path.join("bin", "py")


def test_relative_interpreters_across_the_cwd_switch():
    if os.name != "posix":
        print("skip test_relative_interpreters_across_the_cwd_switch (not POSIX: the Windows workflow is that check)")
        return
    P.CHILD = GOOD
    old = os.getcwd()
    with tempfile.TemporaryDirectory(prefix="test-ctrlc-perf-") as w:
        os.chdir(w)
        try:
            rel = interpreter_below(w)
            sys.argv = ["ctrlc_perf.py", rel, rel, "out.json", "1"]
            try:
                P.main()
            except SystemExit as e:
                check(e.code in (0, None), "main exited %r" % e.code)
            d = json.load(open(os.path.join(w, "out.json")))
        finally:
            os.chdir(old)
    for k in ("py_a", "py_b"):
        check(os.path.isabs(d[k]) and d[k].endswith(os.path.join("bin", "py")), (k, d[k]))
    check(d["ok"] is True and d["rows"]["noop"]["median"] == 1.0, d["rows"])
    print("ok test_relative_interpreters_across_the_cwd_switch")


def test_an_unresolved_relative_interpreter_fails():
    if os.name != "posix":  # (symlinks and CreateProcess's search differ there; the resolution covers both)
        print("skip test_an_unresolved_relative_interpreter_fails (not POSIX)")
        return
    P.CHILD = GOOD
    old = os.getcwd()
    with tempfile.TemporaryDirectory(prefix="test-ctrlc-perf-") as w:
        os.chdir(w)
        try:
            rel = interpreter_below(w)
            check(raises(P.sample, rel), "an unresolved relative interpreter ran from the fresh cwd")
        finally:
            os.chdir(old)
    print("ok test_an_unresolved_relative_interpreter_fails")


def test_the_handshake():
    py = P.resolve(sys.executable)
    P.CHILD = GOOD
    check(P.sample(py) == {"noop": 1.0}, "the stub's sample")
    P.CHILD = STUB % (repr(os.getcwd()), "sys.executable")
    check(raises(P.sample, py), "a child in another cwd passed")
    P.CHILD = STUB % ("os.getcwd()", repr(os.path.abspath(__file__)))
    check(raises(P.sample, py), "a child reporting another interpreter passed")
    P.CHILD = STUB % ("os.getcwd()", "''")
    check(raises(P.sample, py), "a child reporting no interpreter passed")
    print("ok test_the_handshake")


if __name__ == "__main__":
    test_relative_interpreters_across_the_cwd_switch()
    test_an_unresolved_relative_interpreter_fails()
    test_the_handshake()
    print("all ctrlc_perf harness tests passed")
