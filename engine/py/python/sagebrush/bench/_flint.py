"""FLINT as a competitor: flint_harness.c, compiled here against the FLINT
found on this machine (a separate process; Sagebrush never links FLINT).

FLINT is found through pkg-config: $SAGEBRUSH_BENCH_FLINT_PREFIX (a prefix
with lib/pkgconfig/flint.pc), else the system's flint.pc. The compiled
harness is cached in ~/.cache/sagebrush/bench."""

import hashlib
import os
import shutil
import subprocess

from ._proc import LineProcess, ProcError
from ._timing import Timing

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE = os.path.join(HERE, "flint_harness.c")


class FlintError(ProcError):
    pass


def _pkg(env, *args):
    prefix = os.environ.get("SAGEBRUSH_BENCH_FLINT_PREFIX")
    # (a copied prefix: its .pc files may name the directory it was built in)
    define = [f"--define-variable=prefix={prefix}"] if prefix else []
    r = subprocess.run(["pkg-config", *define, *args, "flint"], capture_output=True, text=True,
                       env=env, timeout=30)
    if r.returncode:
        raise FlintError(r.stderr.strip() or "pkg-config failed")
    return r.stdout.split()


class Flint:
    name = "flint"
    short = "flint"
    ours = False
    label = "FLINT fmpz_mat / fmpz_poly (separate process)"

    def __init__(self, cflags=()):
        # cflags: extra compiler flags (test_bench.py's SB_FP_DELAY_US hook)
        self.proc = None
        self.binary = self._version = None
        self.why = None
        self.extra = list(cflags)

    def _env(self):
        env = dict(os.environ)
        prefix = os.environ.get("SAGEBRUSH_BENCH_FLINT_PREFIX")
        if prefix:
            pc = os.path.join(prefix, "lib", "pkgconfig")
            env["PKG_CONFIG_PATH"] = pc + (":" + env["PKG_CONFIG_PATH"] if env.get("PKG_CONFIG_PATH") else "")
        return env

    def _build(self):
        if self.binary or self.why:
            return self.binary
        cc = os.environ.get("CC") or shutil.which("cc") or shutil.which("gcc")
        if not cc or not shutil.which("pkg-config"):
            self.why = "no C compiler or pkg-config"
            return None
        env = self._env()
        try:
            self._version = "FLINT " + _pkg(env, "--modversion")[0]
            cflags = _pkg(env, "--cflags")
            ldirs = [x for x in _pkg(env, "--libs-only-L")]
        except (FlintError, OSError, IndexError):
            self.why = "no flint.pc found by pkg-config"
            return None
        with open(SOURCE, "rb") as f:
            key = hashlib.sha256(f.read() + repr((cc, cflags, ldirs, self._version, self.extra)).encode()).hexdigest()[:16]
        cache = os.path.join(os.path.expanduser("~"), ".cache", "sagebrush", "bench")
        os.makedirs(cache, exist_ok=True)
        binary = os.path.join(cache, f"flint-harness-{key}")
        if not os.access(binary, os.X_OK):
            attempts = [
                cflags + _pkg(env, "--libs"),
                # a static FLINT built with OpenBLAS (as Sage's is)
                cflags + ldirs + ["-Wl,-Bstatic", "-lflint", "-lmpfr", "-lgmp", "-lopenblas",
                                  "-Wl,-Bdynamic", "-lm", "-lpthread"],
            ]
            err = ""
            for flags in attempts:
                tmp = binary + f".tmp{os.getpid()}"
                r = subprocess.run([cc, "-O2", *self.extra, "-o", tmp, SOURCE, *flags], capture_output=True,
                                   text=True, timeout=300)
                if r.returncode == 0:
                    os.replace(tmp, binary)
                    break
                err = r.stderr.strip()[-300:]
            else:
                self.why = "could not compile the FLINT harness: " + err
                return None
        self.binary = binary
        return binary

    def available(self):
        return self._build() is not None

    def version(self):
        return self._version

    def time(self, request, repeat, timeout):
        """Time one harness request ("op args..."): a Timing whose answer
        is the fingerprint "k:f"."""
        if self.proc is None:
            self.proc = LineProcess([self.binary], "END")
        op, rest = request.split(" ", 1)
        out = self.proc.request(f"{op} {int(repeat)} {rest}\n", timeout)
        times = ans = None
        for line in out:
            if line.startswith("E "):
                raise FlintError(line[2:])
            if line.startswith("T "):
                *ts, n = line[2:].split()
                times, calls = [float(t) for t in ts], int(n)
            elif line.startswith("A "):
                ans = line[2:]
        if times is None or ans is None:
            raise FlintError("no result: " + " | ".join(out)[-500:])
        return Timing(times, calls, ans)

    def close(self):
        if self.proc is not None:
            self.proc.close()
