#!/usr/bin/env python3
"""Tests of run.py's process handling that need no engine and no oracle:
python3 bench/core/test_runner.py"""

import hashlib
import json
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


ROW = {
    "id": "poly_fp_mul",
    "item": "poly0",
    "category": "c",
    "label": "l",
    "sizes": {"s": {"n": 10, "timeout": 30}},
    "fresh": False,
    "backends": {"user": "sage", "native": True, "magma": True, "flint": "python"},
}
ARTS = {
    k: "0" * 64
    for k in (
        "python",
        "sagebrush-wheel",
        "sagebrush-installed",
        "native",
        "magma",
        "python-flint-installed",
        "node",
        "native-host",
        "wasm-module",
        "flint-rust",
        "pyjs",
        "engine-wasm",
    )
}


class Points(unittest.TestCase):
    """point() with the drivers replaced (no subprocess): its decisions."""

    def run_point(self, inputs, expected=None, arts=ARTS, steal=0.0, row=ROW, cold=None):
        calls = []

        def fake_invoke(b, row, n, mode, timeout, k=1):
            calls.append((b, mode))
            if mode == "inputs":
                return {"status": "ok", "input_hash": inputs[b]}
            if mode == "once":
                r = {"status": "ok", "signature": "s"}
                if cold:
                    r["seconds_cold"] = cold[b]
                return r
            return {"status": "ok", "seconds": 1.0, "signature": "K:1", "steal": steal}

        with (
            mock.patch.object(run, "invoke", fake_invoke),
            mock.patch.object(run, "command", lambda b, row, n, mode, k=1: ["x"]),
            mock.patch.object(run, "EXPECTED", expected),
        ):
            rec = run.point(row, "s", list(inputs), {"artifacts": arts})
        return rec, calls

    def test_expected_input_mismatch_times_nothing(self):
        rec, calls = self.run_point(
            {"user": "5", "magma": "5"}, expected={"poly_fp_mul:s": {"input_hash": "6"}}
        )
        self.assertEqual(rec["status"], "input mismatch")
        self.assertFalse([c for c in calls if c[1] != "inputs"])

    def test_expected_input_match_is_ok(self):
        rec, _ = self.run_point(
            {"user": "5", "magma": "5"}, expected={"poly_fp_mul:s": {"input_hash": "5"}}
        )
        self.assertEqual(rec["status"], "ok")

    def test_a_backend_without_its_artifacts_is_refused(self):
        arts = dict(ARTS, native=None)
        rec, calls = self.run_point(
            {"user": "5", "native": "5", "magma": "5"}, arts=arts
        )
        self.assertEqual(rec["backends"]["native"]["status"], "refused")
        self.assertNotIn("native", {c[0] for c in calls})

    def test_steal_flags_a_noisy_point(self):
        rec, _ = self.run_point({"user": "5", "magma": "5"}, steal=0.05)
        self.assertTrue(rec["noisy"])
        rec, _ = self.run_point({"user": "5", "magma": "5"}, steal=0.001)
        self.assertFalse(rec["noisy"])

    def test_once_records_the_cold_sample(self):
        def once(line):
            cmd = [PY, "-c", "print(%r)" % line]
            with (
                mock.patch.object(run, "command", lambda b, row, n, mode, k=1: cmd),
                mock.patch.object(run, "CAP", None),
            ):
                return run.invoke("user", ROW, 10, "once", 30)

        r = once("RESULT|0.125000000|7:9")
        self.assertEqual((r["status"], r["signature"], r["seconds_cold"]), ("ok", "7:9", 0.125))
        self.assertEqual(once("RESULT|soon|7:9")["status"], "error")

    def test_a_cold_rows_headline_ratio_is_the_cold_samples(self):
        cold = {"user": 3.0, "magma": 1.5}
        rec, _ = self.run_point({"user": "5", "magma": "5"}, cold=cold)
        self.assertEqual(rec["ratio_user"], 1.0)
        self.assertNotIn("ratio_user_warm", rec)
        rec, _ = self.run_point({"user": "5", "magma": "5"}, row=dict(ROW, cold=True), cold=cold)
        self.assertEqual((rec["ratio_user"], rec["ratio_user_warm"]), (2.0, 1.0))
        self.assertEqual(rec["ratio_user_basis"], "cold")
        # (no cold sample: no headline ratio, the warm one kept apart)
        rec, _ = self.run_point({"user": "5", "magma": "5"}, row=dict(ROW, cold=True))
        self.assertNotIn("ratio_user", rec)
        self.assertEqual(rec["ratio_user_warm"], 1.0)

    def test_a_row_marked_no_ratio_has_none(self):
        rec, _ = self.run_point({"user": "5", "magma": "5"})
        self.assertIn("ratio_user", rec)
        rec, _ = self.run_point({"user": "5", "magma": "5"}, row=dict(ROW, ratio=False))
        self.assertEqual(rec["status"], "ok")
        self.assertFalse([k for k in rec if k.startswith("ratio") or k.startswith("best_")])


def proc_stat(rows):
    """A /proc/stat text: the aggregate line, then one cpuN line per (steal, other)."""
    lines = [
        "cpu  %d 0 0 0 0 0 0 %d 0 0"
        % (sum(o for _, o in rows), sum(s for s, _ in rows))
    ]
    lines += [
        "cpu%d %d 0 0 0 0 0 0 %d 0 0" % (i, o, s) for i, (s, o) in enumerate(rows)
    ]
    return "\n".join(lines + ["intr 1 2 3", "ctxt 9"]) + "\n"


class Steal(unittest.TestCase):
    def test_one_cpu_stolen_from_is_flagged_though_the_aggregate_is_not(self):
        before = run.cpu_times(proc_stat([(0, 0)] * 16))
        after = run.cpu_times(proc_stat([(10, 90)] + [(0, 100)] * 15))
        self.assertEqual(len(after), 16)
        # the aggregate would be 10/1600 = 0.6%, under the limit
        self.assertLess(10 / 1600, run.STEAL_LIMIT)
        self.assertEqual(run.max_steal(before, after), 0.1)
        self.assertGreater(run.max_steal(before, after), run.STEAL_LIMIT)

    def test_no_steal_and_no_cpu_lines(self):
        before = run.cpu_times(proc_stat([(0, 0)] * 4))
        self.assertEqual(
            run.max_steal(before, run.cpu_times(proc_stat([(0, 50)] * 4))), 0.0
        )
        self.assertEqual(run.max_steal({}, {}), None)
        self.assertEqual(run.cpu_times("intr 1\n"), {})


class Rustflags(unittest.TestCase):
    def test_build_uses_the_flags_the_identity_records(self):
        seen = {}

        def fake_run(cmd, cwd, env):
            name = (
                "wasm"
                if "wasm32-wasip1" in cmd
                else ("native-host" if "target-host" in cmd else Path(cwd).name)
            )
            seen[name] = env.get("RUSTFLAGS", "")
            return subprocess.CompletedProcess(cmd, 0)

        with (
            mock.patch.dict(os.environ, {"RUSTFLAGS": "-C opt-level=0"}),
            mock.patch.object(run.subprocess, "run", fake_run),
            mock.patch.object(run, "toolchain", lambda: "tc"),
        ):
            run.build()
        self.assertEqual(seen, run.RUSTFLAGS)
        self.assertEqual(run.build_env()["rustflags"], run.RUSTFLAGS)
        self.assertEqual(seen["native-host"], "-C target-cpu=native")


class FreshWasm(unittest.TestCase):
    """vm-setup.sh's pin check, run on its own with a stub node whose
    check reports a stale pin (exit 1 when strict), or, with status2, a
    check that couldn't run (a malformed pins.json or a missing module:
    exit 2 under either policy)."""

    def run_check(self, policy, status2=False):
        text = (run.HERE / "vm-setup.sh").read_text()
        i = text.index("if [ ! -f .bench-pin-policy ]")
        j = text.index("esac", i) + 4
        d = Path(tempfile.mkdtemp(prefix="bench-core-pin-"))
        (d / "node").write_text(
            "#!/bin/sh\n"
            'if [ -n "$NODE_STATUS2" ]; then echo "::error::wasm/pins.json: bad"; exit 2; fi\n'
            'echo "stale: fresh e.. pinned f.."\n'
            'case "$*" in *push*) exit 1;; esac\nexit 0\n'
        )
        (d / "node").chmod(0o755)
        if policy is not None:
            (d / ".bench-pin-policy").write_text(policy + "\n")
        env = dict(os.environ, PATH=f"{d}:{os.environ['PATH']}")
        if status2:
            env["NODE_STATUS2"] = "1"
        r = subprocess.run(
            ["bash", "-c", "set -euo pipefail\n" + text[i:j]],
            cwd=d,
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
        )
        shutil.rmtree(d)
        return r

    def test_strict_stops_on_a_stale_pin(self):
        r = self.run_check("strict")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("stale: fresh", r.stdout)
        self.assertIn("differs from wasm/pins.json", r.stderr)

    def test_a_payload_without_its_policy_stops(self):
        r = self.run_check(None)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("no .bench-pin-policy", r.stderr)
        self.assertNotIn("stale", r.stdout)

    def test_a_track_tip_records_and_goes_on(self):
        r = self.run_check("track")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("stale: fresh", r.stdout)
        self.assertIn("recorded by its sha256", r.stdout)

    def test_a_check_that_could_not_run_stops_under_either_policy(self):
        for policy in ("strict", "track"):
            with self.subTest(policy=policy):
                r = self.run_check(policy, status2=True)
                self.assertNotEqual(r.returncode, 0)
                self.assertIn("::error::", r.stdout)
                self.assertNotIn("recorded by its sha256", r.stdout)

    def test_an_unknown_policy_stops(self):
        r = self.run_check("loose")
        self.assertNotEqual(r.returncode, 0)

    def test_engine_pin_reports_its_policy(self):
        d = Path(tempfile.mkdtemp(prefix="bench-core-pin-"))
        (d / "wasm").mkdir()
        (d / "wasm/sagebrush-engine.wasm").write_bytes(b"fresh")
        (d / "wasm/pins.json").write_text(
            json.dumps({"modules": {"sagebrush-engine.wasm": {"sha256": "f" * 64}}})
        )
        try:
            with mock.patch.object(run, "ROOT", d):
                self.assertEqual(run.engine_pin()["policy"], "strict")
                (d / ".bench-pin-policy").write_text("track\n")
                pin = run.engine_pin()
                self.assertEqual(pin["policy"], "track")
                self.assertFalse(pin["ok"])
                self.assertEqual(pin["sha256"], hashlib.sha256(b"fresh").hexdigest())
                (d / ".bench-pin-policy").write_text("loose\n")
                self.assertEqual(run.engine_pin()["policy"], "invalid")
        finally:
            shutil.rmtree(d)


class EngineLabel(unittest.TestCase):
    def test_tables_name_their_engine(self):
        rec = {"commit": "c" * 40}
        pinned = dict(
            rec, engine_pin={"ok": True, "policy": "strict", "sha256": "a" * 64}
        )
        self.assertEqual(run.engine_label(pinned), "pinned " + "a" * 12)
        fresh = dict(
            rec, engine_pin={"ok": False, "policy": "track", "sha256": "b" * 64}
        )
        self.assertEqual(run.engine_label(fresh), f"fresh {'b' * 12} @ {'c' * 12}")
        # (a track run whose build happens to equal the pin is still fresh)
        same = dict(rec, engine_pin={"ok": True, "policy": "track", "sha256": "a" * 64})
        self.assertTrue(run.engine_label(same).startswith("fresh "))
        stale = dict(
            rec, engine_pin={"ok": False, "policy": "strict", "sha256": "d" * 64}
        )
        self.assertTrue(run.engine_label(stale).startswith("UNPINNED"))

    def test_the_summary_header_carries_it(self):
        d = Path(tempfile.mkdtemp(prefix="bench-core-sum-"))
        (d / "rows").mkdir()
        rec = {
            "item": "poly0",
            "row": "poly_fp_mul",
            "size": "s",
            "n": 10,
            "commit": "c" * 40,
            "machine": {
                "label": "x86",
                "cpu": "Xeon",
                "arch": "x86_64",
                "nproc": 16,
                "flags": [],
            },
            "engine_pin": {"ok": False, "policy": "track", "sha256": "b" * 64},
            "backends": {},
            "status": "ok",
        }
        (d / "rows/poly_fp_mul-s.json").write_text(json.dumps(rec))
        try:
            run.summary(d, {})
            self.assertIn(
                f"Engine: fresh {'b' * 12} @ {'c' * 12}.",
                (d / "summary.md").read_text(),
            )
        finally:
            shutil.rmtree(d)


class Protocol5(unittest.TestCase):
    """drivers/common.py's TIMING record, and run.py's parse of it."""

    def run_driver(self, ms, k=4, env=None):
        # (a stand-in driver: variant v takes ms milliseconds of sleep, or,
        # with ms None, does nothing: a fast operation even on a loaded
        # machine, where a short sleep wakes milliseconds late)
        body = (
            "lambda: None" if ms is None else "lambda: time.sleep(%r)" % (ms / 1000.0)
        )
        code = (
            "import sys, time; sys.path.insert(0, %r); import common\n"
            "def prepare(v):\n"
            "    return %s\n"
            "common.main(['x', 'case', '1', 'time', '%d'], prepare, lambda a: 's', lambda: 0)\n"
        ) % (str(run.HERE / "drivers"), body, k)
        r = subprocess.run(
            [sys.executable, "-c", code],
            capture_output=True,
            text=True,
            timeout=120,
            env=dict(os.environ, **(env or {})),
        )
        self.assertEqual(r.returncode, 0, r.stderr)
        return run.parse_timing(r.stdout), r.stdout

    def test_a_slow_operation_is_timed_per_op(self):
        t, out = self.run_driver(5)
        self.assertEqual(t["mode"], "per-op")
        self.assertEqual(len(t["samples"]), 4)
        self.assertTrue(all(len(v) == len(t["samples"][0]) for v in t["samples"]))
        self.assertTrue(all(x >= 0.004 for v in t["samples"] for x in v))
        self.assertGreaterEqual(t["threshold"], 1e-3)
        self.assertIn("TIME|", out)

    def test_a_fast_operation_is_batched_from_seeded_offsets(self):
        t, _ = self.run_driver(None, env={"BENCH_SEED": "3"})
        self.assertEqual(t["mode"], "batched")
        sys.path.insert(0, str(run.HERE / "drivers"))
        import common as c

        self.assertEqual(
            t["offsets"], [c.offset(3, j, 4) for j in range(len(t["batches"]))]
        )
        self.assertEqual(t["seed"], 3)

    def test_the_mode_can_be_forced(self):
        t, _ = self.run_driver(0.01, env={"BENCH_TIMING": "per-op"})
        self.assertEqual(t["mode"], "per-op")

    def test_malformed_records_are_dropped(self):
        good = {
            "granularity": 1e-7,
            "threshold": 1e-3,
            "seed": 0,
            "k": 2,
            "mode": "per-op",
            "samples": [[1.0], [2.0]],
        }
        line = lambda d: "TIMING|" + json.dumps(d)  # noqa: E731
        self.assertEqual(run.parse_timing(line(good)), good)
        for bad in (
            dict(good, mode="other"),
            dict(good, samples=[[1.0]]),
            dict(good, samples=[[1.0], [2.0, 3.0]]),
            dict(good, samples=[[1.0], ["x"]]),
            dict(good, k=-1),
            dict(good, granularity=float("nan")),
            {
                "granularity": 1e-7,
                "threshold": 1e-3,
                "seed": 0,
                "k": 2,
                "mode": "batched",
                "batches": [1.0],
                "offsets": [5],
                "reps": 3,
            },
        ):
            with self.subTest(bad=bad):
                self.assertIsNone(run.parse_timing(line(bad)))
        self.assertIsNone(
            run.parse_timing("TIMING|{" + "x" * (run.TIMING_LIMIT + 1) + "}")
        )
        self.assertIsNone(run.parse_timing("TIME|1|s|1|1|1|1"))

    def test_without_the_flag_there_is_no_per_variant_pass(self):
        t, _ = self.run_driver(0.01)
        self.assertNotIn("vtime", t)

    def test_each_variant_is_timed_on_its_own(self):
        # (variant v sleeps 5 (v + 1) ms: the per-variant medians keep that
        # order, which the cycled sample cannot show; sleeps this long keep
        # the ratio clear of a loaded machine's wake-up latency)
        code = (
            "import sys, time; sys.path.insert(0, %r); import common\n"
            "common.TARGET = 0.02\n"
            "def prepare(v):\n"
            "    return lambda: time.sleep(5 * (v + 1) / 1000.0)\n"
            "common.main(['x', 'case', '1', 'time', '3'], prepare, lambda a: 's', lambda: 0)\n"
        ) % str(run.HERE / "drivers")
        for mode in ("batched", "per-op"):
            with self.subTest(mode=mode):
                r = subprocess.run(
                    [sys.executable, "-c", code],
                    capture_output=True,
                    text=True,
                    timeout=120,
                    env=dict(os.environ, BENCH_VTIME="1", BENCH_TIMING=mode),
                )
                self.assertEqual(r.returncode, 0, r.stderr)
                t = run.parse_timing(r.stdout)
                vt = t["vtime"]
                self.assertEqual([e["v"] for e in vt], [0, 1, 2])
                # (the fastest sample: a sleep never ends early, so variant
                # 2's is at least 15 ms; medians can swap on a loaded machine)
                lows = [e["min"] for e in vt]
                self.assertGreaterEqual(lows[2], 0.015)
                self.assertGreater(lows[2], lows[0])
                for e in vt:
                    # (a sample lasts TARGET, unless one operation's warm-up
                    # alone took that long: then one repetition per sample)
                    self.assertTrue(
                        e["reps"] == 1 or e["reps"] * e["seconds"] >= 0.015, e
                    )
                    self.assertEqual(e["samples"], 3)

    def test_a_slow_variant_reuses_its_per_op_samples(self):
        sys.path.insert(0, str(run.HERE / "drivers"))
        import common as c

        calls = []

        def prepare(v):
            calls.append(v)
            return lambda: None

        vt = c.vtimes(prepare, 2, True, None, [[0.5, 0.3, 0.4], [0.6, 0.7, 0.9]])
        self.assertEqual(calls, [])
        self.assertEqual(
            [(e["seconds"], e["min"], e["max"], e["reps"]) for e in vt],
            [(0.4, 0.3, 0.5, 1), (0.7, 0.6, 0.9, 1)],
        )

    def test_malformed_per_variant_records_are_dropped(self):
        e = lambda v, s=1.0: {  # noqa: E731
            "v": v,
            "seconds": s,
            "min": s,
            "max": s,
            "reps": 2,
            "samples": 3,
        }
        good = {
            "granularity": 1e-7,
            "threshold": 1e-3,
            "seed": 0,
            "k": 2,
            "mode": "per-op",
            "samples": [[1.0], [2.0]],
            "vtime": [e(0), e(1, 2.0)],
        }
        line = lambda d: "TIMING|" + json.dumps(d)  # noqa: E731
        self.assertEqual(run.parse_timing(line(good)), good)
        for bad in (
            [e(0)],
            [e(1), e(0)],
            [e(0), dict(e(1), min=3.0)],
            [e(0), dict(e(1), reps=True)],
            [e(0), dict(e(1), samples=0)],
            [e(0), dict(e(1), seconds="x")],
            "x",
        ):
            with self.subTest(bad=bad):
                self.assertIsNone(run.parse_timing(line(dict(good, vtime=bad))))

    def test_only_calibrated_targets_get_the_per_variant_pass(self):
        row = {"id": "r"}
        self.assertTrue(
            all(
                run.wants_vtime(b, row)
                for b in ("user", "native", "native-host", "wasm")
            )
        )
        self.assertFalse(
            any(
                run.wants_vtime(b, row)
                for b in ("magma", "flint", "flint-n", "native-n")
            )
        )
        self.assertFalse(run.wants_vtime("native", {"id": "r", "calibration": False}))


class Installed(unittest.TestCase):
    """dist_files against a real venv with a hand-installed distribution."""

    def setUp(self):
        self.d = Path(tempfile.mkdtemp(prefix="bench-core-venv-"))
        subprocess.run(
            [sys.executable, "-m", "venv", "--without-pip", str(self.d / "v")],
            check=True,
        )
        self.py = self.d / "v/bin/python"
        site = Path(
            subprocess.run(
                [
                    str(self.py),
                    "-I",
                    "-c",
                    "import sysconfig; print(sysconfig.get_path('purelib'))",
                ],
                capture_output=True,
                text=True,
                check=True,
            ).stdout.strip()
        )
        self.site, info = site, site / "fakepkg-1.0.dist-info"
        info.mkdir()
        (site / "fakepkg.py").write_text("X = 1\n")
        (info / "METADATA").write_text(
            "Metadata-Version: 2.1\nName: fakepkg\nVersion: 1.0\n"
        )
        self.record(["fakepkg.py", "fakepkg-1.0.dist-info/METADATA"])

    def tearDown(self):
        shutil.rmtree(self.d)

    def record(self, names, extra=""):
        import base64
        import hashlib

        lines = []
        for n in names:
            data = (self.site / n).read_bytes()
            h = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=")
            lines.append(f"{n},sha256={h.decode()},{len(data)}")
        lines.append("fakepkg-1.0.dist-info/RECORD,,")
        (self.site / "fakepkg-1.0.dist-info/RECORD").write_text(
            "\n".join(lines) + "\n" + extra
        )

    def test_a_same_version_file_change_changes_or_refuses_the_digest(self):
        h = run.dist_files("fakepkg", self.py)
        self.assertRegex(h or "", "^[0-9a-f]{64}$")
        self.assertEqual(run.dist_files("fakepkg", self.py), h)
        # RECORD untouched, the module's bytes changed: refused
        (self.site / "fakepkg.py").write_text("X = 2\n")
        self.assertIsNone(run.dist_files("fakepkg", self.py))
        # RECORD rewritten to match the change: a different digest
        self.record(["fakepkg.py", "fakepkg-1.0.dist-info/METADATA"])
        self.assertNotIn(run.dist_files("fakepkg", self.py), (None, h))

    def test_missing_unhashed_and_escaping_entries_are_refused(self):
        for extra in (
            "gone.py,sha256=AAAA,1\n",
            "fakepkg.py,,\n",
            "../../../../../../etc/hostname,sha256=AAAA,1\n",
            # (only fakepkg's own RECORD is exempt, not another dist-info's)
            "other-1.0.dist-info/RECORD,,\n",
        ):
            with self.subTest(extra=extra):
                self.record(["fakepkg.py", "fakepkg-1.0.dist-info/METADATA"], extra)
                self.assertIsNone(run.dist_files("fakepkg", self.py))

    def test_no_such_distribution(self):
        self.assertIsNone(run.dist_files("nosuchdist", self.py))


class Files(unittest.TestCase):
    def test_row_and_sidecar(self):
        d = Path(tempfile.mkdtemp(prefix="bench-core-row-"))
        p = d / "rows" / "x-s.json"
        run.write_row(p, {"a": 1})
        side = (d / "rows" / "x-s.json.sha256").read_bytes()
        self.assertRegex(side.decode(), r"^[0-9a-f]{64}\n$")
        self.assertEqual(
            side.decode().strip(), run.hashlib.sha256(p.read_bytes()).hexdigest()
        )
        shutil.rmtree(d)

    def test_cpu_times(self):
        cpus = run.cpu_times()
        self.assertTrue(cpus)
        for steal, total in cpus.values():
            self.assertGreaterEqual(total, steal)

    def test_changed_artifacts_stop_the_run(self):
        seq = iter([dict(ARTS), dict(ARTS, native="1" * 64)])
        argv = [
            "run.py",
            "--only",
            "poly_fp_mul",
            "--sizes",
            "s",
            "--mem-cap",
            "none",
            "--out",
            tempfile.mkdtemp(prefix="bench-core-art-"),
        ]
        with (
            mock.patch.object(run, "artifacts", lambda: next(seq)),
            mock.patch.object(run, "point", lambda *a: self.fail("a point ran")),
            mock.patch.object(sys, "argv", argv),
        ):
            self.assertEqual(run.main(), 4)

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
            # (s, m and l; and either all five calibration sizes or none)
            cal = sorted(k for k in r["sizes"] if k not in ("s", "m", "l"))
            self.assertEqual(sorted(set(r["sizes"]) - set(cal)), ["l", "m", "s"])
            self.assertIn(cal, ([], ["c0", "c1", "c2", "c3", "c4"]))
        self.assertEqual(len(m["rows"]), 47)


class Units(unittest.TestCase):
    """The units mode: parse_units, and units()'s three checks."""

    def test_parse(self):
        line = lambda v, f, u: "UNITS|%d|%s|%d" % (v, ",".join(map(str, f)), u)  # noqa: E731
        f0, f1 = [1, 2, 0, 0, 0, 3, 0, 0, 0, 0], [0] * 9 + [4]
        good = "\n".join([line(0, f0, 6), line(1, f1, 4)])
        self.assertEqual(
            run.parse_units(good, 2),
            [{"v": 0, "families": f0, "used": 6}, {"v": 1, "families": f1, "used": 4}],
        )
        self.assertEqual(run.parse_units("UNITS|unmetered\n", 2), "unmetered")
        for bad in (
            line(0, f0, 6),  # (one variant missing)
            "\n".join([line(0, f0, 7), line(1, f1, 4)]),  # (does not sum)
            "\n".join([line(1, f1, 4), line(0, f0, 6)]),  # (out of order)
            "\n".join([line(0, f0[:9], 6), line(1, f1, 4)]),  # (9 families)
            "",
        ):
            with self.subTest(bad=bad):
                self.assertIsNone(run.parse_units(bad, 2))

    def fake(self, body):
        # (a stand-in native driver: prints what body says, from BENCH_THREADS
        # and a run counter in a file)
        d = Path(tempfile.mkdtemp(prefix="units-"))
        self.addCleanup(shutil.rmtree, d)
        script = d / "drv.py"
        script.write_text(
            "import os, sys\n"
            "c = %r\n"
            "n = int(open(c).read()) if os.path.exists(c) else 0\n"
            "open(c, 'w').write(str(n + 1))\n"
            "t = int(os.environ['BENCH_THREADS'])\n" % str(d / "count") + body
        )
        old_cmd, old_cap = run.command, run.CAP
        run.command = lambda b, row, n, mode, k=1: [sys.executable, str(script)]
        run.CAP = None
        self.addCleanup(setattr, run, "command", old_cmd)
        self.addCleanup(setattr, run, "CAP", old_cap)

    def test_consistent_units_are_accepted(self):
        self.fake("print('UNITS|0|1,0,0,0,0,0,0,0,0,2|3')\n")
        got, why = run.units({"id": "r"}, 1, 30, 1)
        self.assertEqual(
            (got, why), ([{"v": 0, "families": [1] + [0] * 8 + [2], "used": 3}], "")
        )

    def test_nondeterministic_units_are_refused(self):
        self.fake("print('UNITS|0|%d,0,0,0,0,0,0,0,0,0|%d' % (n + 1, n + 1))\n")
        self.assertEqual(
            run.units({"id": "r"}, 1, 30, 1),
            (None, "units differ between two 1-thread runs"),
        )

    def test_units_lost_to_other_threads_are_refused(self):
        self.fake(
            "u = 5 if t == 1 else 3\nprint('UNITS|0|%d,0,0,0,0,0,0,0,0,0|%d' % (u, u))\n"
        )
        got, why = run.units({"id": "r"}, 1, 30, 1)
        self.assertIsNone(got)
        self.assertIn("between 1 and", why)

    def test_unmetered_is_recorded_as_such(self):
        self.fake("print('UNITS|unmetered')\n")
        self.assertEqual(run.units({"id": "r"}, 1, 30, 1), ("unmetered", ""))


class CalibrationSizes(unittest.TestCase):
    def test_names(self):
        self.assertTrue(all(run.is_calibration_size(f"c{i}") for i in range(5)))
        for k in ("s", "m", "l", "c5", "c", "cc0", "c0x"):
            self.assertFalse(run.is_calibration_size(k), k)

    def test_the_shard_driver_accepts_them_and_nothing_else(self):
        import shard

        for k in ("s", "m", "l", "c0", "c4"):
            self.assertTrue(shard.SIZE_RE.match(k), k)
        for k in ("c5", "x", "c0/../l", "s "):
            self.assertFalse(shard.SIZE_RE.match(k), k)


class Host(unittest.TestCase):
    def test_the_host_record(self):
        h = run.host()
        json.dumps(h)
        self.assertEqual(
            sorted(h),
            sorted(
                [
                    "cpu",
                    "physical_cores",
                    "logical_cpus",
                    "smt_active",
                    "numa_nodes",
                    "caches",
                    "memory_bytes",
                    "governor",
                    "boost",
                    "kernel",
                    "node",
                    "v8",
                ]
            ),
        )
        self.assertEqual(h["logical_cpus"], os.cpu_count())
        for c in h["caches"]:
            self.assertEqual(sorted(c), ["level", "size", "type"])


if __name__ == "__main__":
    unittest.main()
