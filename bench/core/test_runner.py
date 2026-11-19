#!/usr/bin/env python3
"""Tests of run.py's process handling that need no engine and no oracle:
python3 bench/core/test_runner.py"""

import os
import re
import shutil
import subprocess
import tempfile
import sys
import time
import unittest
from unittest import mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import run  # noqa: E402

PY = sys.executable


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    # (a zombie no one reaps yet counts as gone)
    try:
        return Path(f"/proc/{pid}/stat").read_text().split()[2] != "Z"
    except OSError:
        return False


class RunChild(unittest.TestCase):
    def test_output_and_exit(self):
        r = run.run_child([PY, "-c", "print('TIME|1|s|1|1|1|5')"], 30)
        self.assertEqual((r["status"], r["exit"]), ("ok", 0))
        self.assertIn("TIME|1|s", r["output"])

    def test_error_exit(self):
        r = run.run_child([PY, "-c", "import sys; sys.exit(3)"], 30)
        self.assertEqual((r["status"], r["exit"]), ("error", 3))

    def test_timeout_kills_the_whole_group(self):
        # a child that ignores TERM and leaves a grandchild (also ignoring
        # TERM) in its process group; both pids are written to a file
        pidfile = (
            Path(os.environ.get("TMPDIR", "/tmp")) / f"bench-core-test-{os.getpid()}"
        )
        code = (
            "import os, signal, subprocess, sys, time\n"
            "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
            "g = subprocess.Popen([sys.executable, '-c', 'import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(600)'])\n"
            f"open({str(pidfile)!r}, 'w').write('%d %d' % (os.getpid(), g.pid))\n"
            "time.sleep(600)\n"
        )
        t0 = time.monotonic()
        r = run.run_child([PY, "-c", code], 1.0)
        self.assertEqual(r["status"], "timeout")
        self.assertLess(time.monotonic() - t0, 1.0 + run.GRACE + 5)
        pids = [int(x) for x in pidfile.read_text().split()]
        pidfile.unlink()
        time.sleep(0.2)
        for pid in pids:
            self.assertFalse(alive(pid), f"pid {pid} survived")

    def test_leftovers_killed_after_a_normal_exit(self):
        pidfile = (
            Path(os.environ.get("TMPDIR", "/tmp")) / f"bench-core-left-{os.getpid()}"
        )
        code = (
            "import subprocess, sys\n"
            "g = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(600)'])\n"
            f"open({str(pidfile)!r}, 'w').write(str(g.pid))\n"
        )
        r = run.run_child([PY, "-c", code], 30)
        self.assertEqual(r["status"], "ok")
        pid = int(pidfile.read_text())
        pidfile.unlink()
        time.sleep(0.2)
        self.assertFalse(alive(pid))

    def test_peak_rss(self):
        r = run.run_child(
            [PY, "-c", "b = bytearray(64 << 20); b[::4096] = b'x' * len(b[::4096])"], 30
        )
        self.assertEqual(r["status"], "ok")
        self.assertGreater(r["peak_rss_kib"], 60 << 10)

    def test_interruption_kills_the_whole_group(self):
        # the runner itself interrupted (KeyboardInterrupt in its wait loop)
        # while a child and its grandchild run: both are killed, the child
        # is reaped, and the next child runs
        pidfile = (
            Path(os.environ.get("TMPDIR", "/tmp")) / f"bench-core-intr-{os.getpid()}"
        )
        code = (
            "import os, subprocess, sys, time\n"
            "g = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(600)'])\n"
            f"open({str(pidfile)!r} + '.tmp', 'w').write('%d %d' % (os.getpid(), g.pid))\n"
            f"os.replace({str(pidfile)!r} + '.tmp', {str(pidfile)!r})\n"
            "time.sleep(600)\n"
        )

        def interrupted(pid, options):
            deadline = time.monotonic() + 30
            while not pidfile.exists() and time.monotonic() < deadline:
                time.sleep(0.01)
            raise KeyboardInterrupt

        with mock.patch.object(run.os, "wait4", interrupted):
            with self.assertRaises(KeyboardInterrupt):
                run.run_child([PY, "-c", code], 600)
        pids = [int(x) for x in pidfile.read_text().split()]
        pidfile.unlink()
        # (the child is reaped: no zombie of it remains for anyone to wait on)
        with self.assertRaises(ChildProcessError):
            os.waitpid(pids[0], os.WNOHANG)
        time.sleep(0.2)
        for pid in pids:
            self.assertFalse(alive(pid), f"pid {pid} survived")
        r = run.run_child([PY, "-c", "print('INPUTS|7')"], 30)
        self.assertEqual(r["status"], "ok")

    def test_next_child_runs_after_a_timeout(self):
        run.run_child([PY, "-c", "import time; time.sleep(60)"], 0.5)
        r = run.run_child([PY, "-c", "print('INPUTS|7')"], 30)
        self.assertEqual(r["status"], "ok")

    def test_threads_reach_the_child(self):
        code = "import os; print(os.environ['RAYON_NUM_THREADS'], os.environ['BENCH_THREADS'], os.environ['OMP_NUM_THREADS'])"
        r = run.run_child([PY, "-c", code], 30, threads=4)
        self.assertEqual((r["status"], r["threads"]), ("ok", 4))
        self.assertIn("4 4 4", r["output"])
        r = run.run_child([PY, "-c", code], 30)
        self.assertIn("1 1 1", r["output"])


CAP_PROBLEMS = run.Cap.problems(run.CGROUP_ROOT)


class Caps(unittest.TestCase):
    def test_problems_without_a_cgroup(self):
        self.assertTrue(run.Cap.problems(Path("/nonexistent/bench-core")))

    def test_auto_leaves_a_reserve(self):
        total = os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
        self.assertLessEqual(run.Cap.auto(), total - (2 << 30) + (64 << 20))

    def cap(self, limit=256 << 20):
        return run.Cap(run.CGROUP_ROOT, limit)

    def dirs(self):
        return sorted(p.name for p in run.CGROUP_ROOT.glob(f"p-{os.getpid()}-*"))

    @unittest.skipIf(CAP_PROBLEMS, "no delegated cgroup: " + "; ".join(CAP_PROBLEMS))
    def test_peak_under_the_cap(self):
        r = run.run_child(
            [PY, "-c", "b = bytearray(96 << 20); b[::4096] = b'x' * len(b[::4096])"],
            60,
            cap=self.cap(),
        )
        self.assertEqual(r["status"], "ok")
        self.assertEqual(r["cgroup"]["limit"], 256 << 20)
        self.assertGreater(r["cgroup"]["peak"], 96 << 20)
        self.assertEqual((r["cgroup"]["oom_kill"], r["cgroup"]["left"]), (0, 0))
        self.assertEqual(self.dirs(), [])

    @unittest.skipIf(CAP_PROBLEMS, "no delegated cgroup: " + "; ".join(CAP_PROBLEMS))
    def test_over_the_cap_is_oom(self):
        r = run.run_child(
            [PY, "-c", "b = bytearray(512 << 20); b[::4096] = b'x' * len(b[::4096])"],
            60,
            cap=self.cap(),
        )
        self.assertEqual(r["status"], "oom")
        self.assertGreater(r["cgroup"]["oom_kill"], 0)
        self.assertEqual(self.dirs(), [])
        r = run.run_child([PY, "-c", "print('INPUTS|7')"], 30, cap=self.cap())
        self.assertEqual(r["status"], "ok")

    @unittest.skipIf(CAP_PROBLEMS, "no delegated cgroup: " + "; ".join(CAP_PROBLEMS))
    def test_a_descendant_that_left_the_group_is_killed(self):
        # a grandchild in a new session (out of reach of the group kill)
        # still dies with the cgroup
        pidfile = (
            Path(os.environ.get("TMPDIR", "/tmp")) / f"bench-core-esc-{os.getpid()}"
        )
        code = (
            "import subprocess, sys\n"
            "g = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(600)'], start_new_session=True)\n"
            f"open({str(pidfile)!r}, 'w').write(str(g.pid))\n"
        )
        r = run.run_child([PY, "-c", code], 30, cap=self.cap())
        self.assertEqual(r["status"], "ok")
        pid = int(pidfile.read_text())
        pidfile.unlink()
        time.sleep(0.2)
        self.assertFalse(alive(pid))
        self.assertEqual(self.dirs(), [])

    @unittest.skipIf(CAP_PROBLEMS, "no delegated cgroup: " + "; ".join(CAP_PROBLEMS))
    def test_interruption_under_a_cap_leaves_nothing(self):
        started = (
            Path(os.environ.get("TMPDIR", "/tmp")) / f"bench-core-ic-{os.getpid()}"
        )
        code = f"import time; open({str(started)!r}, 'w').write('1'); time.sleep(600)"

        def interrupted(pid, options):
            deadline = time.monotonic() + 30
            while not started.exists() and time.monotonic() < deadline:
                time.sleep(0.01)
            raise KeyboardInterrupt

        with mock.patch.object(run.os, "wait4", interrupted):
            with self.assertRaises(KeyboardInterrupt):
                run.run_child([PY, "-c", code], 600, cap=self.cap())
        started.unlink()
        self.assertEqual(self.dirs(), [])


class FakeCap(run.Cap):
    """A Cap over a plain temporary directory, with injected faults:
    "write" (memory.max can't be written), "kill" (cgroup.kill fails),
    "left" (processes stay after cgroup.kill), "unreadable" (cgroup.procs
    can't be read), "busy" (rmdir fails).  As in cgroup v2, a directory
    with processes in it can't be removed."""

    KILL_WAIT = 0.2

    def __init__(self, root, faults=()):
        super().__init__(root, 256 << 20)
        self.faults = set(faults)

    def _write(self, p, value):
        if p.name == "memory.max" and "write" in self.faults:
            raise OSError(5, "injected: memory.max")
        if p.name == "cgroup.kill" and "kill" in self.faults:
            raise OSError(5, "injected: cgroup.kill")
        p.write_text(value)

    def _read(self, p):
        if p.name == "cgroup.procs":
            if "unreadable" in self.faults:
                raise OSError(5, "injected: cgroup.procs")
            return "4242\n" if "left" in self.faults else ""
        return p.read_text()

    def _rmdir(self, d):
        if "busy" in self.faults or "left" in self.faults:
            raise OSError(16, "injected: busy")
        shutil.rmtree(d)


class Teardown(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="bench-core-fake-"))

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def left(self):
        return sorted(p.name for p in self.root.iterdir())

    def fatal(self, faults):
        with self.assertRaises(run.TeardownError) as e:
            run.run_child(
                [PY, "-c", "print('INPUTS|7')"], 30, cap=FakeCap(self.root, faults)
            )
        return e.exception.args[1]

    def test_clean_teardown_is_ok(self):
        r = run.run_child([PY, "-c", "print('INPUTS|7')"], 30, cap=FakeCap(self.root))
        self.assertEqual(r["status"], "ok")
        self.assertEqual((r["cgroup"]["left"], r["cgroup"]["removed"]), (0, True))
        self.assertEqual(self.left(), [])

    def test_processes_left_are_fatal(self):
        report = self.fatal({"left"})
        self.assertEqual((report["left"], report["removed"]), (1, False))

    def test_a_failed_kill_with_survivors_is_fatal(self):
        report = self.fatal({"kill", "left"})
        self.assertFalse(report["removed"])
        self.assertTrue(any("cgroup.kill" in p for p in report["problems"]))

    def test_unreadable_membership_is_not_empty(self):
        report = self.fatal({"unreadable", "busy"})
        self.assertEqual((report["left"], report["removed"]), (None, False))

    def test_a_failed_removal_is_fatal(self):
        report = self.fatal({"busy"})
        self.assertEqual((report["left"], report["removed"]), (0, False))

    def test_unreadable_but_removed_is_ok(self):
        # (the removal is the proof: cgroup v2 refuses to remove a populated cgroup)
        r = run.run_child(
            [PY, "-c", "print('INPUTS|7')"], 30, cap=FakeCap(self.root, {"unreadable"})
        )
        self.assertEqual(r["status"], "ok")
        self.assertTrue(r["cgroup"]["problems"])

    def test_a_failed_setup_leaves_no_cgroup(self):
        cap = FakeCap(self.root, {"write"})
        with self.assertRaises(OSError):
            cap.new()
        self.assertEqual(self.left(), [])
        with self.assertRaises(OSError):
            run.run_child([PY, "-c", "print('INPUTS|7')"], 30, cap=cap)
        self.assertEqual(self.left(), [])

    def test_the_runner_stops_at_a_teardown_failure(self):
        calls = []

        def failing(row, key, backends, ident):
            calls.append((row["id"], key))
            raise run.TeardownError("injected", {})

        argv = [
            "run.py",
            "--only",
            "poly_fp_mul",
            "--only",
            "poly_fp_gcd",
            "--sizes",
            "s,m",
            "--mem-cap",
            "none",
            "--out",
            str(self.root / "out"),
        ]
        with (
            mock.patch.object(run, "point", failing),
            mock.patch.object(sys, "argv", argv),
        ):
            self.assertEqual(run.main(), 3)
        self.assertEqual(len(calls), 1)
        self.assertFalse((self.root / "out" / "rows").exists())


class Setup(unittest.TestCase):
    SCRIPT = run.HERE / "cgroup-setup.sh"

    def test_privileged_lines_take_no_path_from_the_environment(self):
        text = self.SCRIPT.read_text()
        self.assertIn("\nROOT=/sys/fs/cgroup/bench-core\n", text)
        self.assertEqual(text.count("\nROOT="), 1)
        self.assertNotIn("BENCH_CGROUP", text)
        for line in text.splitlines():
            if "sudo" in line and not line.lstrip().startswith("#"):
                self.assertIn(" -- ", line, line)
                names = re.findall(r"\$\{?([A-Za-z_][A-Za-z0-9_]*)", line)
                self.assertTrue(set(names) <= {"ROOT"}, line)

    def test_a_hostile_bench_cgroup_has_no_effect_on_sudo(self):
        # sudo stubbed to log its arguments (and do nothing): with
        # BENCH_CGROUP=/etc nothing privileged names anything outside the
        # fixed root
        stub = Path(tempfile.mkdtemp(prefix="bench-core-sudo-"))
        log = stub / "log"
        (stub / "sudo").write_text(
            f'#!/bin/sh\necho "$*" >> {log}\ncat >/dev/null 2>&1 || true\n'
        )
        (stub / "sudo").chmod(0o755)
        env = dict(os.environ, BENCH_CGROUP="/etc", PATH=f"{stub}:{os.environ['PATH']}")
        subprocess.run(
            ["bash", str(self.SCRIPT), "true"], env=env, capture_output=True, timeout=60
        )
        logged = log.read_text() if log.exists() else ""
        shutil.rmtree(stub)
        self.assertNotIn("/etc", logged)
        for line in logged.splitlines():
            self.assertTrue(
                all(
                    not a.startswith("/") or a.startswith("/sys/fs/cgroup")
                    for a in line.split()
                ),
                line,
            )


class Files(unittest.TestCase):
    def test_write_atomic_leaves_no_temporary(self):
        d = Path(os.environ.get("TMPDIR", "/tmp")) / f"bench-core-atomic-{os.getpid()}"
        p = d / "rows" / "x.json"
        run.write_atomic(p, "{}\n")
        run.write_atomic(p, '{"a": 1}\n')
        self.assertEqual(p.read_text(), '{"a": 1}\n')
        self.assertEqual([q.name for q in p.parent.iterdir()], ["x.json"])
        p.unlink()
        p.parent.rmdir()
        d.rmdir()

    def test_items_cover_the_list(self):
        import json

        m = json.loads((Path(run.HERE) / "items.json").read_text())
        ids = [i["id"] for i in m["items"]]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(len([i for i in ids if i != "int"]), 37)
        for r in m["rows"]:
            self.assertIn(r["item"], ids)
            self.assertEqual(sorted(r["sizes"]), ["l", "m", "s"])
        self.assertEqual(len(m["rows"]), 29)


if __name__ == "__main__":
    unittest.main()
