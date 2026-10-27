"""Timing and the host description, shared by every suite.

Every engine times its own calls the same way, inside its own process, so
that no pipe or start-up time is counted:

1. one call (it warms up caches and gives a first time t);
2. a call of 10 s or more is timed once: t is the only sample;
3. otherwise the number of calls per sample, n, is raised until n calls take
   at least 0.1 s (these calls warm up too, and are not counted);
4. then `repeat` samples of n calls each; a sample's time is its total over n.

The gp side is the same procedure written in GP (_gp.py)."""

import math
import os
import platform
import subprocess
import sys
import time

TARGET = 0.1  # seconds per sample, at least
ONCE = 10.0  # calls this long are timed once


class Timing:
    """Seconds per call of each sample, the calls per sample, the answer,
    and (from sample()) the total of the calibration run that chose the calls
    per sample: only that run is promised to reach TARGET; the samples reuse
    its n and can be a little faster."""

    def __init__(self, times, calls, answer, calibrated=None):
        self.times, self.calls, self.answer = list(times), calls, answer
        self.calibrated = calibrated

    @property
    def median(self):
        s = sorted(self.times)
        m = len(s) // 2
        return s[m] if len(s) % 2 else (s[m - 1] + s[m]) / 2


def sample(f, repeat):
    """Time f() as described above: a Timing whose answer is f()'s."""
    clock = time.perf_counter
    t0 = clock()
    answer = f()
    t = clock() - t0
    if t >= ONCE:
        return Timing([t], 1, answer, calibrated=t)
    n = 1
    while t < TARGET:
        n = n * 10 if t <= 0 else max(n + 1, math.ceil(n * 1.2 * TARGET / t))
        t0 = clock()
        for _ in range(n):
            answer = f()
        t = clock() - t0
    times = []
    for _ in range(repeat):
        t0 = clock()
        for _ in range(n):
            answer = f()
        times.append((clock() - t0) / n)
    return Timing(times, n, answer, calibrated=t)


def _first_line(cmd):
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
        return out.stdout.strip().splitlines()[0]
    except Exception:
        return None


def _cpu():
    try:
        with open("/proc/cpuinfo") as f:
            for line in f:
                if line.startswith("model name"):
                    return line.split(":", 1)[1].strip()
    except OSError:
        pass
    if sys.platform == "darwin":
        return _first_line(["sysctl", "-n", "machdep.cpu.brand_string"]) or platform.machine()
    return platform.processor() or platform.machine()


def _memory():
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemTotal:"):
                    return f"{int(line.split()[1]) / 2**20:.1f} GiB"
    except OSError:
        pass
    return None


def _sagebrush():
    """The package version and, when it runs from a git checkout, the commit."""
    try:
        from importlib.metadata import version

        v = version("sagebrush")
    except Exception:
        v = None
    here = os.path.dirname(os.path.abspath(__file__))
    sha = _first_line(["git", "-C", here, "rev-parse", "HEAD"])
    if sha:
        dirty = _first_line(["git", "-C", here, "status", "--porcelain", "--untracked-files=no"])
        sha += " (with uncommitted changes)" if dirty else ""
    return {"version": v, "git": sha}


def host():
    """The machine and software the timings come from."""
    try:
        usable = len(os.sched_getaffinity(0))
    except AttributeError:
        usable = os.cpu_count()
    return {
        "cpu": _cpu(),
        "cores": os.cpu_count(),
        "usable_cores": usable,
        "memory": _memory(),
        "os": platform.platform(),
        "python": f"{platform.python_implementation()} {platform.python_version()}",
        "sagebrush": _sagebrush(),
        "date": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "load_start": load(),
    }


def load():
    """The 1, 5 and 15 minute load averages (None where unknown): timings
    mean little on a busy machine."""
    try:
        return [round(x, 2) for x in os.getloadavg()]
    except (AttributeError, OSError):
        return None
