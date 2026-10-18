"""Sage as a competitor: Sage's own Python running sage_driver.py (one
process, so Sage's start-up is not timed), as a black box.

The executable is $SAGEBRUSH_BENCH_SAGE, or sage on the PATH."""

import json
import os
import shutil

from ._proc import LineProcess, ProcError
from ._timing import Timing

DRIVER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sage_driver.py")


class SageError(ProcError):
    pass


class Sage:
    ours = False

    def __init__(self, name="sage", short="sage", label="Sage"):
        self.name, self.short, self.label = name, short, label
        self.path = os.environ.get("SAGEBRUSH_BENCH_SAGE") or shutil.which("sage")
        self.proc = None
        self._version = None

    def available(self):
        return self.path is not None and os.access(self.path, os.X_OK)

    def _request(self, req, timeout):
        if self.proc is None:
            # Sage's own Python: the python3 next to sage (a conda or pip
            # install, whose sage command has no -python), else sage -python;
            # without PYTHONPATH, which would bring this Python's packages
            # into Sage's
            py = os.path.join(os.path.dirname(os.path.realpath(self.path)), "python3")
            ways = ([[py, DRIVER]] if os.access(py, os.X_OK) else []) + [[self.path, "-python", DRIVER]]
            err = None
            for argv in ways:
                self.proc = LineProcess(["env", "-u", "PYTHONPATH", *argv], "END")
                try:
                    self.proc.request(json.dumps({"call": "None", "answer": "1", "repeat": 1}) + "\n", 600)
                    break
                except ProcError as x:
                    self.proc.close()
                    self.proc, err = None, x
            else:
                raise SageError(f"cannot run Sage's Python: {err}")
        out = self.proc.request(json.dumps(req) + "\n", timeout)
        replies = [line for line in out if line.startswith("{")]
        if not replies:
            raise SageError("no reply: " + " | ".join(out)[-500:])
        r = json.loads(replies[-1])
        if "error" in r:
            raise SageError(r["error"])
        return r

    def version(self):
        if self._version is None:
            r = self._request({"call": "None", "repeat": 1,
                               "answer": "__import__('sage.version', fromlist=['version']).version"}, 600)
            self._version = "SageMath " + r["answer"]
        return self._version

    def time(self, setup, call, answer, repeat, timeout):
        r = self._request({"setup": setup, "call": call, "answer": answer, "repeat": repeat}, timeout)
        return Timing(r["times"], r["calls"], r["answer"])

    def close(self):
        if self.proc is not None:
            self.proc.close()
