#!/usr/bin/env python3
"""The core-algorithm harness: for each row of items.json and each size,
check that every backend builds the same input and gets the same answer,
then time each one, and write one JSON file per (row, size) and a summary.

One subprocess at a time; each in its own process group, killed as a group
at its timeout and after it exits; its peak resident memory from wait4; and,
under a memory cap (the default), each in its own cgroup with memory.max,
whose peak is recorded and which is killed whole after the child.  See
README.md for the protocol, the backends and the output.
"""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import math
import operator
import os
import platform
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
PROTOCOL = 5
# Input variants per point (items.json may lower it for a row or a size)
DEFAULT_VARIANTS = 8
VENV_PY = ROOT / "engine/.venv/bin/python"
PYJS = ROOT / "build/cli/pyjs.cjs"
MAGMA = Path("/usr/local/bin/magma")
NATIVE = HERE / "native/target/release/bench-core-native"
# (the same driver built with -C target-cpu=native: headroom only)
NATIVE_HOST = HERE / "native/target-host/release/bench-core-native"
# (the same driver built for wasm32-wasip1 with the product's target
# features, the defaults, run under Node's WASI by drivers/wasi_run.mjs)
WASM = HERE / "native/target/wasm32-wasip1/release/bench-core-native.wasm"
WASI_RUN = HERE / "drivers/wasi_run.mjs"
FLINT_RUST = HERE / "flint-rust/target/release/bench-core-flint"
# Every backend; a name ending in "-n" is its base run on N threads
BACKENDS = "user,user-n,native,native-host,native-n,wasm,magma,flint,flint-n"
# The delegated cgroup v2 directory the memory caps live under (README)
CGROUP_ROOT = Path(os.environ.get("BENCH_CGROUP", "/sys/fs/cgroup/bench-core"))
# The threads of the "-n" backends (main sets it: --threads, else nproc)
THREADS = os.cpu_count() or 1
# The thread sweep's columns, [(label, cpus)] (main sets it with --sweep)
SWEEP = None
# The memory cap of every subprocess (main sets it: a Cap, or None for an
# explicitly uncapped run)
CAP = None
# The expected input hashes ("<row>:<size>" -> {input_hash, ...}), if given
EXPECTED = None
# the CPU flags worth recording (SIMD and the arithmetic extensions)
FLAGS = re.compile(r"^(avx|avx2|avx512\w*|fma|bmi2|adx|sse4_2|asimd|sve\w*|neon)$")
LINE = re.compile(r"^(RESULT|TIME|INPUTS)\|(.*)$", re.MULTILINE)
# (protocol 5: a time mode's samples, JSON, before its TIME line)
UNITS_LINE = re.compile(
    r"^UNITS\|(\d{1,6})\|(\d{1,20}(?:,\d{1,20}){9})\|(\d{1,20})$", re.MULTILINE
)
UNITS_NONE = re.compile(r"^UNITS\|unmetered$", re.MULTILINE)
TIMING_LINE = re.compile(r"^TIMING\|(\{.*\})$", re.MULTILINE)
TIMING_LIMIT = 1 << 16


def parse_timing(text: str) -> dict | None:
    """A driver's TIMING record, checked (bounded, the fields typed, the
    sample counts consistent), or None when absent or malformed."""
    found = TIMING_LINE.findall(text)
    if not found or len(found[-1]) > TIMING_LIMIT:
        return None
    try:
        t = json.loads(found[-1])
    except ValueError:
        return None

    def num(x):
        return (
            isinstance(x, (int, float))
            and not isinstance(x, bool)
            and x == x
            and 0 <= x < 1e9
        )

    if not isinstance(t, dict) or not all(
        num(t.get(f)) for f in ("granularity", "threshold", "seed", "k")
    ):
        return None
    k = t["k"]
    if t.get("mode") == "per-op":
        s = t.get("samples")
        ok = (
            isinstance(s, list)
            and len(s) == k
            and all(isinstance(v, list) and v and all(num(x) for x in v) for v in s)
            and len({len(v) for v in s}) == 1
        )
    elif t.get("mode") == "batched":
        b, o = t.get("batches"), t.get("offsets")
        ok = (
            isinstance(b, list)
            and b
            and all(num(x) for x in b)
            and isinstance(o, list)
            and len(o) == len(b)
            and all(isinstance(x, int) and 0 <= x < k for x in o)
            and num(t.get("reps"))
        )
    else:
        ok = False
    # (the per-variant pass, when asked for: one entry per variant, in order)
    if ok and "vtime" in t:
        vt = t["vtime"]
        ok = (
            isinstance(vt, list)
            and len(vt) == k
            and all(
                isinstance(e, dict)
                and e.get("v") == i
                and all(num(e.get(f)) for f in ("seconds", "min", "max"))
                and e["min"] <= e["seconds"] <= e["max"]
                and all(
                    isinstance(e.get(f), int)
                    and not isinstance(e.get(f), bool)
                    and e[f] >= 1
                    for f in ("reps", "samples")
                )
                for i, e in enumerate(vt)
            )
        )
    return t if ok else None


SINGLE_THREAD = {
    "SAGEBRUSH_THREADS": "1",
    "RAYON_NUM_THREADS": "1",
    "OMP_NUM_THREADS": "1",
    "OPENBLAS_NUM_THREADS": "1",
    "MKL_NUM_THREADS": "1",
}
GRACE = 5.0


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--sizes",
        default="s,m,l",
        help="comma-separated size keys (s, m, l; c0 .. c4, the calibration sizes, on the rows that have them)",
    )
    p.add_argument(
        "--only",
        action="append",
        default=[],
        metavar="ROW",
        help="a row id (repeatable)",
    )
    p.add_argument(
        "--backends",
        default=BACKENDS,
        help="comma-separated backends to run",
    )
    p.add_argument(
        "--threads",
        type=int,
        default=os.cpu_count() or 1,
        help="the threads of the -n backends (default: the CPU count)",
    )
    p.add_argument(
        "--sweep",
        action="store_true",
        help="the thread sweep: the -n backends of the rows marked \"sweep\" "
        "also timed on 1, 2, 4, 8, ... physical cores, then with the SMT "
        "siblings, each pinned (core_columns)",
    )
    p.add_argument(
        "--mem-cap",
        default="auto",
        help="each subprocess's memory cap: auto (the machine's memory less a "
        "reserve, see Cap.auto), a number of bytes, or none (an uncapped run, "
        "recorded as such)",
    )
    p.add_argument(
        "--out",
        type=Path,
        help="the output directory (default results/<date>/<host label>)",
    )
    p.add_argument(
        "--host-label",
        default=socket.gethostname(),
        help="the machine's name in the output, e.g. its GCP type",
    )
    p.add_argument(
        "--build",
        action="store_true",
        help="build the native driver and the Rust FLINT oracle first",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="list the points and the backends found, run nothing",
    )
    p.add_argument(
        "--expected-inputs",
        type=Path,
        help="a JSON file of expected input hashes (expected_inputs.py's output): a backend whose input hash differs is an input mismatch",
    )
    p.add_argument(
        "--summary-only",
        action="store_true",
        help="rewrite summary.md from the row files",
    )
    return p.parse_args()


def git(*args: str) -> str:
    r = subprocess.run(["git", *args], cwd=ROOT, text=True, capture_output=True)
    return r.stdout.strip() if r.returncode == 0 else ""


def machine(label: str) -> dict:
    model, flags = "", set()
    try:
        for line in Path("/proc/cpuinfo").read_text().splitlines():
            key, _, value = line.partition(":")
            key = key.strip()
            if key in ("model name", "Model name") and not model:
                model = value.strip()
            if key in ("flags", "Features") and not flags:
                flags = {f for f in value.split() if FLAGS.match(f)}
    except OSError:
        pass
    return {
        "label": label,
        "cpu": model or platform.processor(),
        "arch": platform.machine(),
        "flags": sorted(flags),
        "nproc": os.cpu_count(),
        "kernel": platform.release(),
    }


def _read(path: str) -> str | None:
    try:
        return Path(path).read_text().strip()
    except OSError:
        return None


def cpu_list(text: str) -> list[int]:
    """A sysfs CPU list ("0-3,8,10-11") as its CPUs."""
    out = []
    for part in text.strip().split(","):
        if part:
            lo, _, hi = part.partition("-")
            out += range(int(lo), int(hi or lo) + 1)
    return out


def core_columns(sysfs: Path = Path("/sys/devices/system/cpu"), allowed=None) -> list:
    """The thread sweep's columns, [(label, cpus)]: the first c physical
    cores for c = 1, 2, 4, 8, ... (and all of them), one logical CPU each
    (the first of its thread_siblings_list), then, with SMT, every logical
    CPU (label "<count>-smt").  Only the CPUs this process may run on."""
    allowed = set(os.sched_getaffinity(0) if allowed is None else allowed)
    groups = set()
    for f in sysfs.glob("cpu[0-9]*/topology/thread_siblings_list"):
        cpu = int(f.parent.parent.name[3:])
        if cpu in allowed:
            groups.add(tuple(sorted(c for c in cpu_list(f.read_text()) if c in allowed)))
    firsts = sorted(g[0] for g in groups)
    cols, c = [], 1
    while c <= len(firsts):
        cols.append((str(c), firsts[:c]))
        c *= 2
    if cols and len(cols[-1][1]) != len(firsts):
        cols.append((str(len(firsts)), firsts))
    every = sorted(x for g in groups for x in g)
    if len(every) > len(firsts):
        cols.append((f"{len(every)}-smt", every))
    return cols


def host() -> dict:
    """What this machine is, in detail, for the cost fits: recorded with
    every point and never compared (two VMs of one type may differ in
    microcode, boost or cache sizes without being a different type; the
    type's identity is `machine`)."""
    info: dict = {}
    try:
        for line in Path("/proc/cpuinfo").read_text().splitlines():
            key, _, value = line.partition(":")
            key = key.strip()
            for want, name in (
                ("cpu family", "family"),
                ("model", "model"),
                ("stepping", "stepping"),
                ("microcode", "microcode"),
                ("CPU implementer", "implementer"),
                ("CPU part", "part"),
                ("CPU variant", "variant"),
                ("CPU revision", "revision"),
            ):
                if key == want and name not in info:
                    info[name] = value.strip()
    except OSError:
        pass
    cores = set()
    for d in Path("/sys/devices/system/cpu").glob("cpu[0-9]*/topology"):
        core, pkg = _read(f"{d}/core_id"), _read(f"{d}/physical_package_id")
        if core is not None:
            cores.add((pkg, core))
    caches = []
    for d in sorted(Path("/sys/devices/system/cpu/cpu0/cache").glob("index[0-9]*")):
        level, kind, size = _read(f"{d}/level"), _read(f"{d}/type"), _read(f"{d}/size")
        if level and kind and size:
            caches.append({"level": int(level), "type": kind, "size": size})
    mem = None
    for line in (_read("/proc/meminfo") or "").splitlines():
        if line.startswith("MemTotal:"):
            mem = int(line.split()[1]) * 1024
    node = shutil.which("node")
    js = None
    if node:
        try:
            js = subprocess.run(
                [
                    node,
                    "-e",
                    "console.log(process.versions.node + ' ' + process.versions.v8)",
                ],
                capture_output=True,
                text=True,
                timeout=30,
            ).stdout.split()
        except (OSError, subprocess.TimeoutExpired):
            js = None
    return {
        "cpu": info,
        "physical_cores": len(cores) or None,
        "logical_cpus": os.cpu_count(),
        "smt_active": _read("/sys/devices/system/cpu/smt/active"),
        "numa_nodes": len(list(Path("/sys/devices/system/node").glob("node[0-9]*")))
        or None,
        "caches": caches,
        "memory_bytes": mem,
        "governor": _read("/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor"),
        "boost": _read("/sys/devices/system/cpu/cpufreq/boost"),
        "kernel": platform.release(),
        "node": js[0] if js and len(js) == 2 else None,
        "v8": js[1] if js and len(js) == 2 else None,
    }


HOST: dict | None = None


def toolchain() -> str:
    m = re.search(
        r'^channel = "(.+)"',
        (ROOT / "engine/rust-toolchain.toml").read_text(),
        re.MULTILINE,
    )
    return m.group(1) if m else ""


# Each Rust driver's RUSTFLAGS: what build() uses and what the identity
# records (one constant, so they can't differ)
RUSTFLAGS = {
    "native": "",
    "native-host": "-C target-cpu=native",
    "wasm": "",
    "flint-rust": "",
}


def build() -> None:
    # (the engine's pinned toolchain and its default flags: the native column
    # measures the code we ship; native-host adds -C target-cpu=native, in
    # its own target directory; the wasm column is the same crate for
    # wasm32-wasip1 with the default target features, as the product's
    # wasm32-unknown-unknown build has, and without the parallel feature)
    env = dict(os.environ, RUSTUP_TOOLCHAIN=toolchain())
    env.pop("RUSTFLAGS", None)
    steps = [
        ("native", "native", []),
        ("native-host", "native", ["--target-dir", "target-host"]),
        ("wasm", "native", ["--target", "wasm32-wasip1"]),
        ("flint-rust", "flint-rust", []),
    ]
    for name, crate, extra in steps:
        e = dict(env, RUSTFLAGS=RUSTFLAGS[name]) if RUSTFLAGS[name] else env
        r = subprocess.run(
            ["cargo", "build", "--quiet", "--release", *extra], cwd=HERE / crate, env=e
        )
        print(f"build {name}: exit {r.returncode}", flush=True)


class TeardownError(RuntimeError):
    """A subprocess's cgroup could not be confirmed empty and removed, so
    something it started may still run: the point is not ok, and the runner
    stops (no next point starts).  args: (message, the teardown report)."""


class Cap:
    """A cgroup v2 memory cap per subprocess.  The root (CGROUP_ROOT) is
    delegated to this user with the memory controller enabled for its
    children, and the runner itself runs in root/runner (cgroup-setup.sh does
    both).  Each child moves itself into a fresh root/p-<pid>-<k> with
    memory.max = limit, memory.swap.max = 0 and memory.oom.group = 1 before
    it executes.  After it: the cgroup's memory.peak and OOM kills are read,
    cgroup.kill ends whatever is left in it (descendants that left the
    process group included), and the directory is removed.  The removal is
    the proof of emptiness (cgroup v2 refuses to remove a cgroup with a
    process in it): if it can't be removed, finish raises TeardownError."""

    # How long teardown waits for cgroup.kill to empty the cgroup
    KILL_WAIT = 10.0

    def __init__(self, root: Path, limit: int):
        self.root, self.limit, self.k = root, limit, 0

    # (every file operation in one place each, so the tests can inject faults)
    def _mkdir(self, d: Path) -> None:
        d.mkdir()

    def _write(self, p: Path, value: str) -> None:
        p.write_text(value)

    def _read(self, p: Path) -> str:
        return p.read_text()

    def _rmdir(self, d: Path) -> None:
        d.rmdir()

    @staticmethod
    def auto() -> int:
        """The machine's memory less a reserve for the runner and the
        system: max(2 GiB, 10%)."""
        total = 0
        for line in Path("/proc/meminfo").read_text().splitlines():
            if line.startswith("MemTotal:"):
                total = int(line.split()[1]) * 1024
        return max(total - max(2 << 30, total // 10), 256 << 20)

    @staticmethod
    def problems(root: Path, cpuset: bool = False) -> list[str]:
        """Why caps (and, for the thread sweep, cpusets) can't be made under
        root (none: they can)."""
        out = []
        if not root.is_dir():
            return [f"{root} does not exist"]
        if not os.access(root, os.W_OK):
            out.append(f"{root} is not writable by this user")
        try:
            enabled = (root / "cgroup.subtree_control").read_text().split()
            for c in ("memory", "cpuset") if cpuset else ("memory",):
                if c not in enabled:
                    out.append(
                        f"the {c} controller is not enabled in {root}/cgroup.subtree_control"
                    )
        except OSError as e:
            out.append(f"{root}/cgroup.subtree_control: {e}")
        # (the interfaces teardown needs: cgroup.kill, Linux 5.14; memory.peak, 5.19)
        for name in ("cgroup.kill", "memory.peak"):
            if not (root / name).exists():
                out.append(f"{root}/{name} is missing (a kernel too old for the caps)")
        mine = ""
        try:
            for line in Path("/proc/self/cgroup").read_text().splitlines():
                if line.startswith("0::"):
                    mine = line[3:]
        except OSError:
            pass
        here = Path("/sys/fs/cgroup" + mine) if mine else None
        if here is None or root not in here.parents:
            out.append(
                f"this runner's cgroup ({mine or 'unknown'}) is not under {root} (start it with cgroup-setup.sh)"
            )
        return out

    def new(self, cpus: list[int] | None = None) -> Path:
        """A fresh capped cgroup (pinned to cpus, if given, by cpuset.cpus);
        if any step fails, the directory is removed before the error
        propagates."""
        self.k += 1
        d = self.root / f"p-{os.getpid()}-{self.k}"
        self._mkdir(d)
        try:
            self._write(d / "memory.max", str(self.limit))
            if cpus:
                self._write(d / "cpuset.cpus", ",".join(map(str, cpus)))
            for name, value in (("memory.swap.max", "0"), ("memory.oom.group", "1")):
                if (d / name).exists():
                    self._write(d / name, value)
        except BaseException:
            try:
                self._rmdir(d)
            except OSError:
                pass
            raise
        return d

    def finish(self, d: Path) -> dict:
        """The cgroup's peak and OOM kills; then everything in it killed and
        the directory removed.  Raises TeardownError (after every cleanup
        step has been tried) unless the removal succeeds."""
        problems = []

        def optional(name):
            try:
                return self._read(d / name)
            except OSError:
                return ""

        peak = optional("memory.peak").strip()
        events = dict(
            line.split()
            for line in optional("memory.events").splitlines()
            if line.strip()
        )
        try:
            self._write(d / "cgroup.kill", "1")
        except OSError as e:
            problems.append(f"cgroup.kill failed: {e}")
        left = None
        deadline = time.monotonic() + self.KILL_WAIT
        while True:
            try:
                left = len(self._read(d / "cgroup.procs").split())
            except OSError as e:
                # (an unreadable membership is not an empty one)
                problems.append(f"cgroup.procs unreadable: {e}")
                left = None
                break
            if not left or time.monotonic() > deadline:
                break
            time.sleep(0.01)
        if left:
            problems.append(f"{left} process(es) still in the cgroup after cgroup.kill")
        removed, why = False, None
        for _ in range(100):
            try:
                self._rmdir(d)
                removed = True
                break
            except FileNotFoundError:
                # (already gone: nothing can run in it)
                removed = True
                break
            except OSError as e:
                why = e
                time.sleep(0.01)
        report = {
            "limit": self.limit,
            "peak": int(peak) if peak.isdigit() else None,
            "oom_kill": int(events.get("oom_kill", 0)),
            "left": left,
            "removed": removed,
            "problems": problems,
        }
        if not removed:
            problems.append(f"the cgroup was not removed: {why}")
            raise TeardownError(
                f"{d}: "
                + "; ".join(problems)
                + " (the runner stops: nothing more starts)",
                report,
            )
        return report


def run_child(
    cmd: list[str],
    timeout: float,
    threads: int = 1,
    cap: Cap | None = None,
    extra_env: dict | None = None,
    cpus: list[int] | None = None,
) -> dict:
    """Run cmd in its own process group with `threads`-thread settings (and,
    with a cap, in its own capped cgroup); its output, exit status, wall
    time, CPU time and peak RSS (wait4), and the cgroup's peak.  At the
    timeout the group gets TERM, then KILL after GRACE seconds; after the
    child exits, KILL again for anything it left behind in the group (and
    cgroup.kill for anything in its cgroup), and on any other way out (an
    interruption, an error) KILL and a reap of the child before the
    exception propagates.  With cpus, the child is pinned to them: its
    cgroup's cpuset.cpus (with a cap) and its affinity, so
    sched_getaffinity, and so available_parallelism, see len(cpus)."""
    env = dict(os.environ, **{k: str(threads) for k in SINGLE_THREAD})
    env["BENCH_THREADS"] = str(threads)
    env.update(extra_env or {})
    memory = None
    with tempfile.TemporaryFile() as out:
        # (the output file first, then the cgroup: from here on every way
        # out goes through the finally below, which tears the cgroup down)
        cg = cap.new(cpus) if cap else None
        enter = None
        procs = str(cg / "cgroup.procs") if cg else None
        if cg or cpus:

            def enter():
                # (in the child, before it executes: into its own cgroup,
                # then onto its cpus)
                if procs:
                    with open(procs, "w") as f:
                        f.write(str(os.getpid()))
                if cpus:
                    os.sched_setaffinity(0, cpus)

        pgid, status, rusage, timed_out, termed, proc = (
            None,
            None,
            None,
            False,
            None,
            None,
        )
        t0 = time.monotonic()
        try:
            proc = subprocess.Popen(
                cmd,
                cwd=ROOT,
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=out,
                stderr=subprocess.STDOUT,
                start_new_session=True,
                preexec_fn=enter,
            )
            pgid = proc.pid
            while status is None:
                pid, st, ru = os.wait4(proc.pid, os.WNOHANG)
                if pid:
                    status, rusage = st, ru
                    # (reaped: Popen must not think it still runs)
                    proc.returncode = os.waitstatus_to_exitcode(st)
                    break
                now = time.monotonic()
                if now - t0 > timeout and termed is None:
                    timed_out, termed = True, now
                    _killpg(pgid, signal.SIGTERM)
                elif termed is not None and now - termed > GRACE:
                    _killpg(pgid, signal.SIGKILL)
                    termed = float("inf")
                time.sleep(0.01)
        finally:
            # on every exit, an interruption or an error included: the whole
            # group killed (whatever the child left behind, after a normal
            # exit); on an abnormal exit the direct child reaped too; then
            # the cgroup torn down, which raises TeardownError unless it is
            # confirmed empty and removed
            if pgid is not None:
                _killpg(pgid, signal.SIGKILL)
                if status is None:
                    try:
                        os.waitpid(proc.pid, 0)
                    except ChildProcessError:
                        pass
                    proc.returncode = -signal.SIGKILL
            if cg:
                memory = cap.finish(cg)
        proc.returncode = os.waitstatus_to_exitcode(status)
        wall = time.monotonic() - t0
        out.seek(0)
        text = out.read().decode(errors="replace")
    oom = bool(memory and memory["oom_kill"])
    return {
        "status": "timeout"
        if timed_out
        else ("oom" if oom else ("ok" if proc.returncode == 0 else "error")),
        "exit": proc.returncode,
        "wall": round(wall, 3),
        "cpu": round(rusage.ru_utime + rusage.ru_stime, 3),
        "peak_rss_kib": rusage.ru_maxrss,
        "threads": threads,
        "cgroup": memory,
        "output": text,
    }


def _killpg(pgid: int, sig: int) -> None:
    try:
        os.killpg(pgid, sig)
    except (ProcessLookupError, PermissionError):
        pass


# The base of each derived backend (its driver, and whether the row has one)
BASE = {
    "user-n": "user",
    "native-host": "native",
    "native-n": "native",
    "wasm": "native",
    "flint-n": "flint",
}


def versions() -> dict:
    """The versions a point's times depend on, beyond the commit."""

    def out(cmd):
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
            return (
                (r.stdout or r.stderr).strip().splitlines()[0]
                if r.returncode == 0
                else None
            )
        except (OSError, subprocess.SubprocessError, IndexError):
            return None

    return {
        "rust": toolchain(),
        "node": out(["node", "--version"]),
        "python": out([str(VENV_PY), "--version"]) if VENV_PY.exists() else None,
        "python-flint": out(
            [str(VENV_PY), "-c", "import flint; print(flint.__version__)"]
        )
        if VENV_PY.exists()
        else None,
        "magma": "V2.18-5" if MAGMA.exists() else None,
    }


def cpu_times(text: str | None = None) -> dict[str, tuple[int, int]]:
    """Per CPU (the cpuN lines of /proc/stat): (steal, total) jiffies. Per
    CPU, not the aggregate line: a 1-thread point's steal on its own vCPU
    would be diluted by the CPU count there."""
    try:
        text = Path("/proc/stat").read_text() if text is None else text
    except OSError:
        return {}
    out = {}
    for line in text.splitlines():
        f = line.split()
        if f and f[0].startswith("cpu") and f[0] != "cpu":
            try:
                v = [int(x) for x in f[1:]]
            except ValueError:
                continue
            out[f[0]] = (v[7] if len(v) > 7 else 0, sum(v))
    return out


def max_steal(before: dict, after: dict) -> float | None:
    """The largest steal fraction any one CPU saw between two snapshots."""
    fr = [
        (after[c][0] - before[c][0]) / (after[c][1] - before[c][1])
        for c in after
        if c in before and after[c][1] > before[c][1]
    ]
    return round(max(fr), 5) if fr else None


# A point whose timed runs saw more CPU steal than this (a fraction of the
# machine's CPU time) is flagged noisy: kept, but left out of medians
STEAL_LIMIT = 0.02


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# Run by engine/.venv's Python: one installed distribution's files, each
# hashed as it is on disk now (not as RECORD claims), digested in a
# canonical order.  Fails (exit 1, the reason on stderr) on an entry that
# is missing, escapes the environment, has no RECORD hash (RECORD itself
# excepted), or whose bytes differ from its RECORD hash.
DIST_FILES = r"""
import base64, csv, hashlib, os, sys, importlib.metadata as m
d = m.distribution(sys.argv[1])
root = os.path.realpath(sys.prefix) + os.sep
base = d.locate_file("")
# (only this distribution's own RECORD is exempt from hashing; without its
# metadata directory nothing is exempt, so the digest fails closed)
meta = getattr(d, "_path", None)
own = os.path.realpath(os.path.join(meta, "RECORD")) if meta else None
lines = []
# (RECORD read directly: Distribution.files drops entries whose file is gone)
for row in csv.reader((d.read_text("RECORD") or "").splitlines()):
    if not row:
        continue
    f, h = row[0], (row[1] if len(row) > 1 else "")
    p = os.path.realpath(os.path.join(base, f))
    if not p.startswith(root):
        sys.exit(f"{f}: outside the environment")
    if own is not None and p == own:
        continue
    if not h.startswith("sha256="):
        sys.exit(f"{f}: no sha256 in RECORD")
    try:
        data = open(p, "rb").read()
    except OSError as e:
        sys.exit(f"{f}: {e}")
    got = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
    if got != h[len("sha256="):]:
        sys.exit(f"{f}: its bytes differ from RECORD")
    lines.append(f"{f}\0{hashlib.sha256(data).hexdigest()}\n")
if not lines:
    sys.exit("no files")
print(hashlib.sha256("".join(sorted(lines)).encode()).hexdigest())
"""


def dist_files(dist: str, python: Path | None = None) -> str | None:
    """A digest of the bytes of every file an installed distribution in
    engine/.venv has on disk (DIST_FILES), or None if any is missing,
    unhashed, outside the environment or changed since installation."""
    python = python or VENV_PY
    if not python.exists():
        return None
    r = subprocess.run(
        [str(python), "-I", "-c", DIST_FILES, dist],
        capture_output=True,
        text=True,
        timeout=300,
    )
    out = r.stdout.strip()
    return out if r.returncode == 0 and re.fullmatch(r"[0-9a-f]{64}", out) else None


def wheel_sha() -> str | None:
    """The sha256 of the Sagebrush wheel vm-setup.sh built (exactly one)."""
    wheels = sorted((ROOT / "engine/py/dist").glob("*.whl"))
    return sha256_file(wheels[0]) if len(wheels) == 1 else None


# The files each backend executes (or loads), hashed before the first point
# and again before every point: a backend present without them is refused,
# and a change stops the run
def artifacts() -> dict:
    node = shutil.which("node")
    files = {
        "python": os.path.realpath(VENV_PY) if VENV_PY.exists() else None,
        "node": os.path.realpath(node) if node else None,
        "pyjs": PYJS,
        "native": NATIVE,
        "native-host": NATIVE_HOST,
        "wasm-module": WASM,
        "flint-rust": FLINT_RUST,
        "magma": os.path.realpath(MAGMA) if MAGMA.exists() else None,
        "engine-wasm": ROOT / "wasm/sagebrush-engine.wasm",
    }
    out = {
        k: (sha256_file(Path(v)) if v and Path(v).exists() else None)
        for k, v in files.items()
    }
    out["sagebrush-wheel"] = wheel_sha()
    out["sagebrush-installed"] = dist_files("sagebrush")
    out["python-flint-installed"] = dist_files("python-flint")
    return out


# The artifacts each backend needs (by its base)
NEEDS = {
    "user": ("python", "sagebrush-wheel", "sagebrush-installed"),
    "user-pyjs": ("node", "pyjs", "engine-wasm"),
    "native": ("native",),
    "native-host": ("native-host",),
    "wasm": ("node", "wasm-module"),
    "magma": ("magma",),
    "flint-rust": ("flint-rust",),
    "flint-python": ("python", "python-flint-installed"),
}


def needs(backend: str, row: dict) -> tuple:
    """The artifacts a backend executes for this row."""
    base = backend[:-2] if backend.endswith("-n") else backend
    if base == "user":
        return NEEDS["user-pyjs" if row["backends"]["user"] == "pyjs" else "user"]
    if base == "flint":
        return NEEDS[
            "flint-rust" if adapter("flint", row) == "flint-rust" else "flint-python"
        ]
    return NEEDS[base]


def pin_policy() -> str:
    """The run's pin policy (.bench-pin-policy, written into the shard
    driver's payload): "strict" (the default, and for local runs) or
    "track" (a track tip: the fresh build is recorded, not refused)."""
    try:
        p = (ROOT / ".bench-pin-policy").read_text().strip()
    except OSError:
        return "strict"
    return p if p in ("strict", "track") else "invalid"


def engine_pin() -> dict:
    """Whether wasm/sagebrush-engine.wasm (what the CLI embeds, the user
    column's engine) is the one wasm/pins.json pins, its sha256 either way,
    and the policy it was checked under (on a track tip the pin lags the
    source, and the sha256 is the fresh build's)."""
    policy = pin_policy()
    try:
        pins = json.loads((ROOT / "wasm/pins.json").read_text())["modules"][
            "sagebrush-engine.wasm"
        ]
        got = sha256_file(ROOT / "wasm/sagebrush-engine.wasm")
        return {
            "sha256": got,
            "pinned": pins["sha256"],
            "ok": got == pins["sha256"],
            "policy": policy,
        }
    except (OSError, KeyError, ValueError):
        return {"sha256": None, "pinned": None, "ok": False, "policy": policy}


def build_env() -> dict:
    """How the Rust drivers were built (the identity's build half)."""
    try:
        rustc = subprocess.run(
            ["rustc", "-vV"],
            capture_output=True,
            text=True,
            timeout=60,
            env=dict(os.environ, RUSTUP_TOOLCHAIN=toolchain()),
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        rustc = None
    return {
        "rustc": rustc,
        "rustflags": dict(RUSTFLAGS),
        "profile": "release: opt-level 3, lto, codegen-units 1",
        "wasm_postprocess": "none",
    }


class ArtifactChanged(RuntimeError):
    """An executed file changed between points: the run stops."""


def variants(row: dict, key: str) -> int:
    """K, the number of input variants a point cycles through: the size's
    "variants", else the row's, else DEFAULT_VARIANTS (1 for a row with one
    named input, such as x^n - 1)."""
    return int(row["sizes"][key].get("variants", row.get("variants", DEFAULT_VARIANTS)))


def command(backend: str, row: dict, n: int, mode: str, k: int = 1) -> list[str] | None:
    """The command of one backend for one row, or None when it doesn't apply
    or isn't on this host.  A "-n" backend is its base's command (run on
    THREADS threads by invoke)."""
    if backend.endswith("-n"):
        # (user-n only on the rows whose code runs in parallel)
        if backend == "user-n" and not row.get("parallel"):
            return None
        return command(backend[:-2], row, n, mode, k)
    cid, kinds = row["id"], row["backends"]
    if backend == "native-host":
        return (
            [str(NATIVE_HOST), cid, str(n), mode, str(k)]
            if kinds["native"] and NATIVE_HOST.exists()
            else None
        )
    if backend == "wasm":
        node = shutil.which("node")
        return (
            [node, str(WASI_RUN), str(WASM), cid, str(n), mode, str(k)]
            if kinds["native"] and WASM.exists() and node
            else None
        )
    if backend == "user":
        if kinds["user"] == "pyjs":
            return (
                [
                    "node",
                    str(PYJS),
                    str(HERE / "drivers/sagebrush_bigint.py"),
                    cid,
                    str(n),
                    mode,
                    str(k),
                ]
                if PYJS.exists()
                else None
            )
        return (
            [
                str(VENV_PY),
                str(HERE / "drivers/sagebrush_case.py"),
                cid,
                str(n),
                mode,
                str(k),
            ]
            if VENV_PY.exists()
            else None
        )
    if backend == "native":
        return (
            [str(NATIVE), cid, str(n), mode, str(k)]
            if kinds["native"] and NATIVE.exists()
            else None
        )
    if backend == "magma":
        return (
            [
                str(MAGMA),
                "-b",
                f"case_id:={cid}",
                f"n:={n}",
                f"mode:={mode}",
                f"variants:={k}",
                str(HERE / "drivers/magma_case.m"),
            ]
            if MAGMA.exists()
            else None
        )
    if backend == "flint":
        if kinds["flint"] == "rust" and FLINT_RUST.exists():
            return [str(FLINT_RUST), cid, str(n), mode, str(k)]
        if kinds["flint"] and VENV_PY.exists():
            return [
                str(VENV_PY),
                str(HERE / "drivers/flint_case.py"),
                cid,
                str(n),
                mode,
                str(k),
            ]
    return None


def adapter(backend: str, row: dict) -> str:
    if backend.endswith("-n"):
        return adapter(backend[:-2], row) + f", {THREADS} threads"
    if backend == "flint":
        return (
            "flint-rust"
            if row["backends"]["flint"] == "rust" and FLINT_RUST.exists()
            else "python-flint"
        )
    if backend == "user":
        return (
            "pyjs (WebAssembly)"
            if row["backends"]["user"] == "pyjs"
            else "Sage mode (engine/.venv)"
        )
    return {
        "native": "bench-core-native",
        "native-host": "bench-core-native (target-cpu=native)",
        "wasm": "bench-core-native (wasm32-wasip1, Node WASI)",
        "magma": "Magma V2.18-5",
    }[backend]


# The targets the engine's cost estimates are calibrated on: their timed
# runs also time each variant on its own (protocol 5's per-variant pass).
# The references (Magma, FLINT) need no calibration and skip it.
VTIME_TARGETS = ("user", "native", "native-host", "wasm")


def is_calibration_size(key: str) -> bool:
    return re.fullmatch(r"c[0-4]", key) is not None


def wants_vtime(backend: str, row: dict) -> bool:
    return backend in VTIME_TARGETS and row.get("calibration", True) is not False


def invoke(
    backend: str,
    row: dict,
    n: int,
    mode: str,
    timeout: float,
    k: int = 1,
    cpus: list[int] | None = None,
) -> dict:
    """One driver run, its output parsed; with cpus (the thread sweep),
    pinned to them, on len(cpus) threads."""
    cmd = command(backend, row, n, mode, k)
    s0 = cpu_times()
    extra = (
        {"BENCH_VTIME": "1"}
        if mode in ("time", "time-fresh") and wants_vtime(backend, row)
        else None
    )
    threads = len(cpus) if cpus else (THREADS if backend.endswith("-n") else 1)
    r = run_child(cmd, timeout, threads, CAP, extra, cpus)
    r["steal"] = max_steal(s0, cpu_times())
    # (Magma 2.18 wraps long lines with backslash-newline)
    text = r.pop("output").replace("\\\n", "")
    found = LINE.findall(text)
    if r["status"] == "ok" and not found:
        r["status"] = "error"
    if r["status"] != "ok":
        r["detail"] = text[-600:]
        return r
    kind, fields = found[-1]
    parts = fields.split("|")
    if kind == "INPUTS":
        r["input_hash"] = parts[0]
    elif kind == "RESULT":
        # (the first op in a fresh process: the cold sample, recorded apart
        # from the timed samples and never in a fit)
        r["signature"] = parts[1]
        try:
            r["seconds_cold"] = float(parts[0])
        except ValueError:
            r["status"], r["detail"] = "error", "bad RESULT seconds: " + text[-600:]
    else:
        med, sig, lo, hi, k, count = parts
        r.update(
            seconds=float(med),
            min=float(lo),
            max=float(hi),
            reps=int(k),
            samples=int(count),
            signature=sig,
        )
        # (protocol 5's samples; a driver without them yet has none)
        timing = parse_timing(text)
        if timing is not None:
            r["timing"] = timing
            if "vtime" in timing:
                r["vtime"] = timing["vtime"]
    return r


def parse_units(text: str, k: int) -> list | str | None:
    """A units run's report: "unmetered", or one {v, families, used} per
    variant, in order, each family vector summing to used; None when
    malformed."""
    if UNITS_NONE.search(text) and not UNITS_LINE.search(text):
        return "unmetered"
    found = UNITS_LINE.findall(text)
    if len(found) != k:
        return None
    out = []
    for i, (v, fams, used) in enumerate(found):
        f = [int(x) for x in fams.split(",")]
        if int(v) != i or sum(f) != int(used):
            return None
        out.append({"v": i, "families": f, "used": int(used)})
    return out


def units(row: dict, n: int, timeout: float, k: int) -> tuple[list | str | None, str]:
    """The native driver's meter units for the K variants, checked: the
    families sum to the total, two 1-thread runs agree (determinism), and
    an N-thread run agrees with them (the tally is per thread: work moved
    to other threads would go uncounted).  (units, "") or (None, why)."""
    cmd = command("native", row, n, "units", k)
    if cmd is None:
        return None, "no native driver"
    runs = []
    for threads in (1, 1, THREADS):
        r = run_child(cmd, timeout, threads, CAP)
        if r["status"] != "ok":
            return None, f"units run {r['status']}"
        got = parse_units(r.get("output", ""), k)
        if got is None:
            return None, "units malformed (families must sum to the total)"
        runs.append(got)
    if runs[0] != runs[1]:
        return None, "units differ between two 1-thread runs"
    if runs[0] != runs[2]:
        return None, f"units differ between 1 and {THREADS} threads"
    return runs[0], ""


def working_set(row: dict, n: int) -> int | None:
    """The row's working_set formula (items.json) at n, in bytes; None
    without one.  The formula is an expression in n with numbers, + - * /
    // ** and log2, nothing else (it is data, so it is never eval'd)."""
    expr = row.get("working_set")
    if expr is None:
        return None
    ops = {
        ast.Add: operator.add,
        ast.Sub: operator.sub,
        ast.Mult: operator.mul,
        ast.Div: operator.truediv,
        ast.FloorDiv: operator.floordiv,
        ast.Pow: operator.pow,
    }

    def ev(node):
        if isinstance(node, ast.Expression):
            return ev(node.body)
        if isinstance(node, ast.Constant) and type(node.value) in (int, float):
            return node.value
        if isinstance(node, ast.Name) and node.id == "n":
            return n
        if isinstance(node, ast.BinOp) and type(node.op) in ops:
            return ops[type(node.op)](ev(node.left), ev(node.right))
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == "log2"
            and len(node.args) == 1
            and not node.keywords
        ):
            return math.log2(ev(node.args[0]))
        raise ValueError(f"working_set of {row['id']}: {ast.dump(node)[:80]} is not allowed")

    value = ev(ast.parse(expr, mode="eval"))
    if not value > 0:
        raise ValueError(f"working_set of {row['id']} at n={n} is {value}")
    return round(value)


# wasm32's address space: a calibration size whose working set exceeds it
# is skipped on wasm, and recorded as skipped
WASM_BYTES = 4 << 30


def selected(row: dict, key: str, backends: list[str]) -> tuple[list[str], dict]:
    """The backends a point runs (present on this host and applicable), and
    those skipped by rule, with why: at a calibration size only the
    calibrated targets (the references need no calibration, and some sizes
    would take them far past the point's timeout), and wasm only while the
    row's working set fits its 4 GiB."""
    n = row["sizes"][key]["n"]
    present = [b for b in backends if command(b, row, n, "once")]
    skipped = {}
    if is_calibration_size(key):
        present = [b for b in present if b in VTIME_TARGETS]
        ws = working_set(row, n)
        if "wasm" in present and ws is not None and ws > WASM_BYTES:
            present.remove("wasm")
            skipped["wasm"] = f"working set {ws} bytes exceeds wasm32's 4 GiB"
    return present, skipped


def point(row: dict, key: str, backends: list[str], ident: dict) -> dict:
    size = row["sizes"][key]
    n, timeout = size["n"], float(size["timeout"])
    k = variants(row, key)
    global HOST
    if HOST is None:
        HOST = host()
    rec = dict(
        ident,
        host=HOST,
        row=row["id"],
        item=row["item"],
        category=row["category"],
        label=row["label"],
        size=key,
        n=n,
        working_set_bytes=working_set(row, n),
        fresh=row["fresh"],
        variants=k,
        backends={},
    )
    present, skipped = selected(row, key, backends)
    for b, why in skipped.items():
        rec["backends"][b] = {"status": "skipped", "detail": why}
    arts = ident.get("artifacts") or {}
    for b in list(present):
        missing = [a for a in needs(b, row) if not arts.get(a)]
        if missing:
            # (a backend present without its hashed artifacts is refused)
            present.remove(b)
            rec["backends"][b] = {
                "status": "refused",
                "detail": "no hash for " + ", ".join(missing),
            }
    for b in backends:
        if b not in present and b not in rec["backends"]:
            rec["backends"][b] = {
                "status": "not applicable"
                if (
                    BASE.get(b, b) in ("native", "flint")
                    and not (row["backends"][BASE.get(b, b)])
                )
                or (b == "user-n" and not row.get("parallel"))
                else "not on host"
            }
    # 1. the inputs each backend builds
    for b in present:
        r = invoke(b, row, n, "inputs", timeout, k)
        rec["backends"][b] = {"adapter": adapter(b, row), "input": r}
    hashes = {b: rec["backends"][b]["input"].get("input_hash") for b in present}
    known = {h for h in hashes.values() if h}
    want = (EXPECTED or {}).get(f"{row['id']}:{key}")
    if want is not None:
        rec["expected_input_hash"] = want["input_hash"]
    # 2. the answers
    if len(known) > 1 or (want is not None and known and known != {want["input_hash"]}):
        rec["status"] = "input mismatch"
    else:
        for b in present:
            rec["backends"][b]["check"] = invoke(b, row, n, "once", timeout, k)
        sigs = {b: rec["backends"][b]["check"].get("signature") for b in present}
        got = {s for s in sigs.values() if s}
        rec["input_hash"] = known.pop() if known else None
        rec["status"] = "mismatch" if len(got) > 1 else ("ok" if got else "no answer")
    # 3. the times, only when everything agreed: each backend cycles through
    # the K variants, and their combined signatures must agree too (the
    # check above covers variant 0; this covers all K)
    if rec["status"] == "ok":
        mode = "time-fresh" if row["fresh"] else "time"
        for b in present:
            if rec["backends"][b]["check"]["status"] != "ok":
                continue
            rec["backends"][b]["time"] = invoke(b, row, n, mode, timeout, k)
        timed = {
            b: rec["backends"][b]["time"]
            for b in present
            if "time" in rec["backends"][b]
        }
        combined = {t["signature"] for t in timed.values() if t["status"] == "ok"}
        if len(combined) > 1:
            rec["status"] = "mismatch"
            for t in timed.values():
                if t["status"] == "ok":
                    t["status"] = "mismatch"
        # the thread sweep (--sweep, rows marked "sweep"): each -n backend
        # again on each column's cpus, pinned; "ends" only the first and
        # the last column (a flat baseline); a combined signature that
        # differs from the timed one is a mismatch
        if SWEEP and row.get("sweep") and rec["status"] == "ok":
            cols = SWEEP if row["sweep"] == "cores" else [SWEEP[0], SWEEP[-1]]
            for b in present:
                if not b.endswith("-n") or "time" not in rec["backends"][b]:
                    continue
                sweep = {}
                for label, cpus in cols:
                    t = invoke(b, row, n, mode, timeout, k, cpus)
                    t["cpus"] = cpus
                    if t["status"] == "ok" and t["signature"] not in combined:
                        t["status"] = "mismatch"
                    sweep[label] = t
                rec.setdefault("sweep", {})[b] = sweep

    # 4. the meter's units (calibration rows with a native driver): refused,
    # as an error, when they are not deterministic or not thread-independent
    if rec["status"] == "ok" and "native" in present and wants_vtime("native", row):
        got, why = units(row, n, timeout, k)
        if got is None:
            rec["status"], rec["units_error"] = "error", why
        else:
            rec["units"] = got

    steals = [
        t["steal"]
        for t in (rec["backends"].get(b, {}).get("time") for b in present)
        if t and t.get("steal") is not None
    ]
    rec["steal_max"] = max(steals) if steals else None
    rec["noisy"] = bool(steals) and max(steals) > STEAL_LIMIT

    def sec(b):
        return rec["backends"].get(b, {}).get("time", {}).get("seconds")

    # 1-thread ratios against the best 1-thread reference; then our best
    # against theirs over 1 and N threads (the 2x rule's ratio; native-host
    # never counts toward it: headroom only).  A row marked "ratio": false
    # times different work on each side (hecke_space): no ratio.
    refs = {b: sec(b) for b in ("magma", "flint") if sec(b)}
    if rec["status"] == "ok" and refs and row.get("ratio", True) is not False:
        best = min(refs, key=refs.get)
        rec["best_ref"] = {
            "backend": best,
            "adapter": rec["backends"][best]["adapter"],
            "seconds": refs[best],
        }
        for b in ("user", "native", "native-host", "wasm"):
            if sec(b):
                rec["ratio_" + b.replace("-", "_")] = round(sec(b) / refs[best], 4)
        ours = {b: sec(b) for b in ("native", "native-n") if sec(b)}
        theirs = {b: sec(b) for b in ("magma", "flint", "flint-n") if sec(b)}
        if ours and theirs:
            bo, bt = min(ours, key=ours.get), min(theirs, key=theirs.get)
            rec["best_ours"] = {"backend": bo, "seconds": ours[bo]}
            rec["best_theirs"] = {
                "backend": bt,
                "adapter": rec["backends"][bt]["adapter"],
                "seconds": theirs[bt],
            }
            rec["ratio_best"] = round(ours[bo] / theirs[bt], 4)
        if row.get("cold"):
            # (a row whose reference reuses internal state across repetitions
            # in one process, hecke_matrix: the headline user ratio is the
            # cold first samples', like for like; the warm one is kept as
            # ratio_user_warm; no cold sample, no headline)
            def cold(b):
                return rec["backends"].get(b, {}).get("check", {}).get("seconds_cold")

            warm = rec.pop("ratio_user", None)
            if warm is not None:
                rec["ratio_user_warm"] = warm
            if cold("user") and cold(best):
                rec["ratio_user"] = round(cold("user") / cold(best), 4)
            rec["ratio_user_basis"] = "cold"
    rec["complete"] = True
    return rec


def write_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp-")
    with os.fdopen(fd, "w") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def write_row(path: Path, rec: dict) -> None:
    """The point's file, then its checksum sidecar (exactly one 64-hex digest
    and a newline): the driver fetches both."""
    text = json.dumps(rec, indent=1) + "\n"
    write_atomic(path, text)
    write_atomic(
        path.with_name(path.name + ".sha256"),
        hashlib.sha256(text.encode()).hexdigest() + "\n",
    )


def secs(x) -> str:
    if x is None:
        return "—"
    return f"{x:.3g}" if x < 1 else f"{x:.3f}"


def engine_label(rec: dict) -> str:
    """How a table names the user column's engine: "pinned <sha>" only when
    it was checked strictly and is the pinned one; on a track tip (pin
    policy track) "fresh <sha> @ <commit>", so its numbers are never quoted
    as the pinned release's."""
    pin = rec.get("engine_pin") or {}
    sha = str(pin.get("sha256") or "")[:12] or "unknown"
    commit = str(rec.get("commit") or "")[:12] or "unknown"
    if pin.get("policy", "strict") == "strict" and pin.get("ok"):
        return f"pinned {sha}"
    if pin.get("policy") == "track":
        return f"fresh {sha} @ {commit}"
    return f"UNPINNED {sha} @ {commit} (not an official run)"


def calibration(out: Path) -> None:
    """calibration.json, for the fits: every point at a calibration size
    measured under this protocol, with what the fits use (n, the working
    set, the host, the units, and per calibrated target its times and
    per-variant vtime).  A point of another protocol is never mixed in:
    it is only counted."""
    points, other = [], 0
    for path in sorted((out / "rows").glob("*.json")):
        r = json.loads(path.read_text())
        if not is_calibration_size(r.get("size", "")):
            continue
        if r.get("protocol") != PROTOCOL:
            other += 1
            continue
        keep = ("row", "size", "n", "variants", "status", "working_set_bytes", "units")
        keep += ("host", "machine", "commit", "engine_pin")
        pt = {k: r.get(k) for k in keep}
        pt["backends"] = {}
        for b, v in r.get("backends", {}).items():
            if b not in VTIME_TARGETS:
                continue
            t = v.get("time") or {}
            pt["backends"][b] = {"status": (t or v.get("check") or v).get("status")}
            pt["backends"][b].update(
                {x: t.get(x) for x in ("seconds", "min", "max", "reps", "samples", "vtime") if x in t}
            )
        points.append(pt)
    doc = {"protocol": PROTOCOL, "points": points, "other_protocols_skipped": other}
    write_atomic(out / "calibration.json", json.dumps(doc, indent=1, sort_keys=True) + "\n")


def summary(out: Path, items: dict) -> None:
    recs = sorted(
        (
            r
            for r in (json.loads(p.read_text()) for p in (out / "rows").glob("*.json"))
            # (the calibration sizes are for the cost fits, not this table:
            # calibration.json)
            if not is_calibration_size(r["size"])
        ),
        key=lambda r: (r["item"], r["row"], "sml".index(r["size"])),
    )
    if not recs:
        calibration(out)
        return
    m = recs[0]["machine"]
    lines = [
        f"# Core-algorithm harness: {m['label']}",
        "",
        f"Engine: {engine_label(recs[0])}.",
        "",
        f"Commit `{recs[0]['commit']}`; {m['cpu']} ({m['arch']}, {m['nproc']} CPUs; flags {' '.join(m['flags']) or 'none recorded'}). "
        f"Memory cap per subprocess: {recs[0].get('mem_cap') or 'none (an uncapped run)'} bytes. "
        f"Times are medians of the samples, seconds per operation, on one thread except the N columns ({recs[0].get('threads')} threads). "
        "The 1-thread ratios are against the best 1-thread reference on this machine; the best/best ratio (the 2x rule's) is our best of native and native-N against the best of every reference, on 1 or N threads. native-host (target-cpu=native) is headroom only and never counts.",
        "",
        "## Gaps above 2x (our best against the best reference)",
        "",
    ]
    gaps = [r for r in recs if (r.get("ratio_best") or 0) > 2]
    gaps.sort(key=lambda r: -r["ratio_best"])
    lines += [
        f"- **{r['row']}** {r['size']} (n={r['n']}): best/best {r['ratio_best']:.2f}x ({r['best_ours']['backend']} against {r['best_theirs']['adapter']}); native 1-thread {r.get('ratio_native', 0):.2f}x, user {r.get('ratio_user', 0):.2f}x, wasm {r.get('ratio_wasm', 0):.2f}x"
        for r in gaps
    ] or ["None among the rows with a native driver."]
    lines += [
        "",
        "## Every point",
        "",
        "| item | row | size | n | user | native | native-host | native-N | wasm | Magma | FLINT | FLINT-N | best 1-thread ref | user ratio | native ratio | wasm ratio | best/best | peak MiB | status |",
        "|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|---|",
    ]
    for r in recs:

        def t(b, r=r):
            return secs(r["backends"].get(b, {}).get("time", {}).get("seconds"))

        peaks = [
            (b.get("time", {}).get("cgroup") or {}).get("peak")
            for b in r["backends"].values()
        ]
        peaks = [x for x in peaks if x]
        peak = f"{max(peaks) / (1 << 20):.0f}" if peaks else "—"
        # (a cold row's user ratio is the first calls', marked; its warm one
        # beside it)
        user_ratio = str(r.get("ratio_user", "—"))
        if r.get("ratio_user_basis") == "cold":
            user_ratio += f" cold (warm {r.get('ratio_user_warm', '—')})"
        lines.append(
            f"| {r['item']} | {r['row']} | {r['size']} | {r['n']} | {t('user')} | {t('native')} | {t('native-host')} | {t('native-n')} | {t('wasm')} | {t('magma')} | {t('flint')} | {t('flint-n')} | {r.get('best_ref', {}).get('adapter', '—')} | {user_ratio} | {r.get('ratio_native', '—')} | {r.get('ratio_wasm', '—')} | {r.get('ratio_best', '—')} | {peak} | {r['status']} |"
        )
    # the thread sweep: per row and -n backend, each column's median and
    # its speedup over the 1-core column
    swept = [r for r in recs if r.get("sweep")]
    if swept:
        lines += ["", "## Thread sweep", "", "Medians in seconds, pinned to the column's CPUs (c physical cores, then every logical CPU: -smt); in brackets the speedup over 1 core.", ""]
        for r in swept:
            for b, cols in r["sweep"].items():
                one = (cols.get("1") or {}).get("seconds")
                cells = []
                for label, t in cols.items():
                    sec = t.get("seconds") if t.get("status") == "ok" else None
                    if sec is None:
                        cells.append(f"{label}: {t.get('status')}")
                    else:
                        up = f" ({one / sec:.2f}x)" if one else ""
                        cells.append(f"{label}: {secs(sec)}{up}")
                lines.append(f"- **{r['row']}** {r['size']} (n={r['n']}) {b}: " + "; ".join(cells))
    uncovered = [i for i in items.values() if i["status"] != "rows"]
    lines += ["", "## Items without rows", ""] + [
        f"- {i['id']} ({i['title']}): {i['status']}" for i in uncovered
    ]
    write_atomic(out / "summary.md", "\n".join(lines) + "\n")
    calibration(out)


def main() -> int:
    args = parse_args()
    manifest = json.loads((HERE / "items.json").read_text())
    rows = [r for r in manifest["rows"] if not args.only or r["id"] in args.only]
    unknown = set(args.only) - {r["id"] for r in manifest["rows"]}
    if unknown:
        raise SystemExit("unknown row(s): " + ", ".join(sorted(unknown)))
    sizes = args.sizes.split(",")
    backends = args.backends.split(",")
    out = args.out or HERE / "results" / time.strftime("%Y-%m-%d") / args.host_label
    items = {i["id"]: i for i in manifest["items"]}
    if args.summary_only:
        summary(out, items)
        return 0
    if args.build:
        build()
    global THREADS, CAP, EXPECTED, SWEEP
    THREADS = max(1, args.threads)
    if args.expected_inputs:
        EXPECTED = json.loads(args.expected_inputs.read_text())
    SWEEP = core_columns() if args.sweep else None
    if args.dry_run:
        print(json.dumps(machine(args.host_label)))
        if SWEEP:
            print("sweep", json.dumps(SWEEP))
        for row in rows:
            for key in (k for k in sizes if k in row["sizes"]):
                found, skipped = selected(row, key, backends)
                cols = list(found)
                cols += [f"{b}:skipped" for b in skipped]
                cols += [f"vtime:{b}" for b in found if wants_vtime(b, row)]
                if "native" in found and wants_vtime("native", row):
                    cols.append("units")
                if SWEEP and row.get("sweep"):
                    labels = [c[0] for c in (SWEEP if row["sweep"] == "cores" else [SWEEP[0], SWEEP[-1]])]
                    cols += [f"{b}@{x}" for b in found if b.endswith("-n") for x in labels]
                n = row["sizes"][key]["n"]
                print(row["id"], key, n, f"ws={working_set(row, n)}", " ".join(cols))
        return 0
    if args.mem_cap != "none":
        problems = Cap.problems(CGROUP_ROOT, cpuset=bool(SWEEP))
        if problems:
            raise SystemExit(
                "a memory cap needs a delegated cgroup (README, 'Memory caps'):\n- "
                + "\n- ".join(problems)
                + "\nStart the runner with bench/core/cgroup-setup.sh, or pass --mem-cap none for an uncapped run."
            )
        CAP = Cap(
            CGROUP_ROOT, Cap.auto() if args.mem_cap == "auto" else int(args.mem_cap)
        )
    # (what a complete point must match to be skipped on a rerun: the code,
    # uncommitted edits included, the machine, the toolchain and reference
    # versions, the build flags, the threads, the cap and the backends; and
    # per point its n and K)
    diff = (
        git("diff", "HEAD", "--", "engine", "bench/core")
        + "\n"
        + git(
            "ls-files", "--others", "--exclude-standard", "--", "engine", "bench/core"
        )
    )
    # (a driver's payload is a git archive of a clean commit, without .git:
    # it names its commit in .bench-commit)
    stamp = ROOT / ".bench-commit"
    commit = git("rev-parse", "HEAD") or (
        stamp.read_text().strip() if stamp.exists() else ""
    )
    ident = {
        "protocol": PROTOCOL,
        "commit": commit,
        "dirty": bool(git("status", "--porcelain", "--", "engine", "bench/core")),
        "tree_diff": hashlib.sha256(diff.encode()).hexdigest(),
        "artifacts": artifacts(),
        "engine_pin": engine_pin(),
        "build": build_env(),
        "machine": machine(args.host_label),
        "versions": versions(),
        "flags": {
            "native": "default",
            "native-host": "-C target-cpu=native",
            "wasm": "wasm32-wasip1, default target features",
        },
        "threads": THREADS,
        "sweep": [[label, cpus] for label, cpus in SWEEP] if SWEEP else None,
        "mem_cap": CAP.limit if CAP else None,
        "backends": backends,
    }
    for row in rows:
        for key in (k for k in sizes if k in row["sizes"]):
            path = out / "rows" / f"{row['id']}-{key}.json"
            if path.exists():
                old = json.loads(path.read_text())
                same = all(old.get(k) == ident[k] for k in ident) and (
                    old.get("n"),
                    old.get("variants"),
                ) == (row["sizes"][key]["n"], variants(row, key))
                if same and old.get("complete"):
                    print(f"skip {row['id']} {key}: done", flush=True)
                    continue
            print(f"{row['id']} {key} n={row['sizes'][key]['n']}", flush=True)
            now = artifacts()
            if now != ident["artifacts"]:
                changed = sorted(k for k in now if now[k] != ident["artifacts"].get(k))
                print(
                    f"STOPPED: executed files changed since the run started: {', '.join(changed)}",
                    file=sys.stderr,
                    flush=True,
                )
                summary(out, items)
                return 4
            try:
                rec = point(row, key, backends, ident)
            except TeardownError as e:
                # (no file for this point, and no next point: something it
                # started may still run)
                print(f"STOPPED: {e.args[0]}", file=sys.stderr, flush=True)
                summary(out, items)
                return 3
            write_row(path, rec)
            print(
                f"  {rec['status']} user {rec.get('ratio_user')} native {rec.get('ratio_native')}",
                flush=True,
            )
    summary(out, items)
    return 0


if __name__ == "__main__":
    sys.exit(main())
