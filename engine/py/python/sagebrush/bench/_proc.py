"""A competitor's long-running process, spoken to in lines: requests on
stdin, replies on stdout up to an end marker, under a deadline."""

import os
import select
import subprocess
import time

from .suite import EngineTimeout


class ProcError(Exception):
    pass


class LineProcess:
    def __init__(self, argv, end, env=None):
        self.argv, self.end, self.env = argv, end, env
        self.proc = None

    def request(self, text, timeout):
        """Write text; return the lines before the end marker. A process
        that overruns `timeout` seconds is killed (the next request starts
        a new one)."""
        if self.proc is None:
            env = dict(os.environ, OMP_NUM_THREADS="1", OPENBLAS_NUM_THREADS="1", **(self.env or {}))
            self.proc = subprocess.Popen(self.argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                         stderr=subprocess.STDOUT, env=env)
            self.buf = b""
        try:
            self.proc.stdin.write(text.encode())
            self.proc.stdin.flush()
        except OSError as x:
            self.close()
            raise ProcError(f"{self.argv[0]} exited ({x})")
        deadline = time.monotonic() + timeout
        fd = self.proc.stdout.fileno()  # raw reads: select must see every byte
        out = []
        while True:
            while b"\n" in self.buf:
                line, self.buf = self.buf.split(b"\n", 1)
                line = line.decode("utf-8", "replace")
                if line == self.end:
                    return out
                out.append(line)
            left = deadline - time.monotonic()
            if left <= 0 or not select.select([fd], [], [], left)[0]:
                self.close()
                raise EngineTimeout(f"over {timeout:g} s")
            chunk = os.read(fd, 1 << 16)
            if not chunk:
                self.close()
                raise ProcError(f"{self.argv[0]} exited: " + " ".join(out)[-500:])
            self.buf += chunk

    def close(self):
        if self.proc is not None:
            try:
                self.proc.kill()
                self.proc.wait(10)
            except Exception:
                pass
            self.proc = None
