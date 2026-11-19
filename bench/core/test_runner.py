#!/usr/bin/env python3
"""Tests of run.py's process handling that need no engine and no oracle:
python3 bench/core/test_runner.py"""

import os
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
