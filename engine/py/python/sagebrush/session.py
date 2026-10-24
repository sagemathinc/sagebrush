"""A persistent Sagebrush session in a child process: run Sage (or Python)
code with variables kept between calls, the printed output and the value of
the last expression returned, plots captured as SVG, and a time limit
enforced by interrupting the computation (Ctrl-C reaches the Rust engines
too) or, if that fails, by restarting the process.

    from sagebrush.session import Session
    s = Session()
    s.run("R.<x> = QQ[]; f = x^4 - 1")
    s.run("f.factor()")["result"]       # '(x - 1) * (x + 1) * (x^2 + 1)'
    s.close()

Used by the MCP server (sagebrush.mcp_server); usable on its own.
"""

import os
import signal
import sys
import time

__all__ = ["Session"]


def _format_exception(e, tb):
    import traceback

    # only the frames of the user's code, as a notebook shows them
    frames = [f for f in traceback.extract_tb(tb) if f.filename == "<cell>"]
    lines = []
    if frames:
        lines.append("Traceback (most recent call last):\n")
        lines += traceback.format_list(frames)
    lines += traceback.format_exception_only(type(e), e)
    return "".join(lines).rstrip()


def _error_info(e, tb):
    """The error as data: type (stable: "unimplemented" for
    NotImplementedError, Sagebrush's refusal; "syntax"; "interrupted";
    "exception" for anything else raised), exception (the class name),
    message and traceback."""
    if isinstance(e, KeyboardInterrupt):
        kind = "interrupted"
    elif isinstance(e, NotImplementedError):
        kind = "unimplemented"
    elif isinstance(e, SyntaxError):
        kind = "syntax"
    elif isinstance(e, MemoryError):
        kind = "memory"
    else:
        kind = "exception"
    info = {"type": kind, "exception": type(e).__name__, "message": str(e), "traceback": _format_exception(e, tb), "at": time.time()}
    # (a memory guard's refusal: item D's fields, as the error carries them;
    # D1's record is None until PR 5b / GB-6, its partial and checkpoint too)
    if kind == "memory" or hasattr(e, "limit_bytes"):
        def big(n):
            return n if not isinstance(n, int) or -(1 << 53) <= n <= (1 << 53) else str(n)
        cap = getattr(e, "capacity", None)
        info["memory"] = {"what": str(e), "need_bytes": big(getattr(e, "need_bytes", None)), "limit_bytes": big(getattr(e, "limit_bytes", None)),
                          "record": getattr(e, "record", None), "partial": None, "checkpoint": None,
                          "capacity": cap if isinstance(cap, dict) else None}
    return info


def _failure(kind, message):
    # an error of the session itself (a time limit, a process that died)
    return {"type": kind, "exception": None, "message": message, "traceback": ""}


def _worker():
    """The child: JSON requests on stdin, JSON replies on the original
    stdout; everything else written to stdout goes to stderr."""
    import ast
    import builtins
    import contextlib
    import io
    import json

    proto = os.fdopen(os.dup(1), "w", encoding="utf-8")
    try:
        os.dup2(2, 1)
    except OSError:
        pass
    sys.stdout = sys.stderr
    displays = []

    def display(obj):
        f = getattr(obj, "_repr_svg_", None)
        if f is None:
            return False
        displays.append(("image/svg+xml", f()))
        return True

    builtins.__pyjs_display__ = display
    from sagebrush.preparse import preparse

    shared = {"__name__": "__main__"}
    exec("from sagebrush.sage import *", shared)
    proto.write(json.dumps({"ready": True}) + "\n")
    proto.flush()
    inp = io.TextIOWrapper(sys.stdin.buffer, encoding="utf-8")
    while True:
        try:
            line = inp.readline()
        except KeyboardInterrupt:
            continue  # an interrupt that arrived after the computation ended
        if not line:
            return
        req = json.loads(line)
        code, mode, isolated = req["code"], req.get("mode", "sage"), req.get("isolated", False)
        want_data = req.get("data", False)
        ns = shared
        if isolated:
            ns = {"__name__": "__main__"}
            exec("from sagebrush.sage import *", ns)
        out = io.StringIO()
        del displays[:]
        result = error = info = data = None
        t0 = time.perf_counter()
        try:
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
                src = preparse(code) if mode == "sage" else code
                tree = ast.parse(src, "<cell>", "exec")
                last = tree.body.pop() if tree.body and isinstance(tree.body[-1], ast.Expr) else None
                exec(compile(tree, "<cell>", "exec"), ns)
                if last is not None:
                    v = eval(compile(ast.Expression(last.value), "<cell>", "eval"), ns)
                    if v is not None:
                        ns["_"] = v
                        if not (hasattr(v, "_repr_svg_") and display(v)):
                            result = repr(v)
                if want_data:
                    data = ns.get("__sagebrush_data__")
                    json.dumps(data)  # (JSON, or the TypeError says why not)
        except KeyboardInterrupt as e:
            error = "KeyboardInterrupt: the computation was interrupted"
            info = _error_info(e, None)
            info["message"], info["traceback"] = "the computation was interrupted", error
        except BaseException as e:  # SystemExit too: the session survives
            error = _format_exception(e, e.__traceback__)
            info = _error_info(e, e.__traceback__)
        reply = {"stdout": out.getvalue(), "result": result, "error": error, "error_info": info, "data": data if info is None else None,
                 "displays": list(displays), "seconds": time.perf_counter() - t0}
        while True:
            try:
                proto.write(json.dumps(reply) + "\n")
                proto.flush()
                break
            except KeyboardInterrupt:
                continue


class Session:
    """A child process holding one namespace (`from sagebrush.sage import *`).
    generation counts its processes: it changes at each (re)start."""

    def __init__(self):
        self.proc = None
        self.generation = 0
        self._start()

    def _start(self):
        import queue
        import subprocess
        import threading

        flags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) if os.name == "nt" else 0
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "sagebrush.session", "--worker"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            creationflags=flags,
        )
        self.generation += 1
        self.replies = queue.Queue()

        def reader(proc, q):
            import json

            for line in proc.stdout:
                try:
                    q.put(json.loads(line))
                except ValueError:
                    pass
            q.put(None)  # the process ended

        threading.Thread(target=reader, args=(self.proc, self.replies), daemon=True).start()
        first = self.replies.get(timeout=120)
        if not first or not first.get("ready"):
            raise RuntimeError("the Sagebrush session did not start")

    def alive(self):
        return self.proc is not None and self.proc.poll() is None

    def restart(self):
        self._kill()
        self._start()

    def _kill(self):
        if self.alive():
            self.proc.kill()
            self.proc.wait(5)

    def interrupt(self):
        """Interrupt the running computation (KeyboardInterrupt in the
        session, which also stops the Rust engines)."""
        if self.alive():
            if os.name == "nt":
                self.proc.send_signal(signal.CTRL_BREAK_EVENT)
            else:
                self.proc.send_signal(signal.SIGINT)

    def submit(self, code, mode="sage", isolated=False, data=False):
        """Start code and return at once: (generation, queue), the queue
        giving the reply, or None if the process ended first.  The caller
        waits as long as it likes; nothing here stops the computation."""
        import json

        if not self.alive():
            self._start()
        self.proc.stdin.write((json.dumps({"code": code, "mode": mode, "isolated": isolated, "data": data}) + "\n").encode("utf-8"))
        self.proc.stdin.flush()
        return self.generation, self.replies

    def _get(self, timeout):
        import queue

        try:
            return self.replies.get(timeout=timeout)
        except queue.Empty:
            return False

    def run(self, code, mode="sage", timeout=60.0, isolated=False, data=False):
        """Run code ("sage" syntax or plain "python"); a dict with stdout,
        result (repr of the last expression, or None), error (a traceback,
        or None), error_info (the error as a dict: type, exception, message,
        traceback; see _error_info, plus "timeout" and "session" for a time
        limit and a process that died), displays [(mime, data)], seconds,
        restarted (True if the session had to be restarted, losing its
        variables) and data: with data=True, the JSON value the code left in
        __sagebrush_data__ (None after an error)."""
        import json

        restarted = False
        if not self.alive():
            self._start()
            restarted = True
        self.proc.stdin.write((json.dumps({"code": code, "mode": mode, "isolated": isolated, "data": data}) + "\n").encode("utf-8"))
        self.proc.stdin.flush()
        r = self._get(timeout)
        if r:
            r["restarted"] = restarted
            return r
        if r is None:  # the process died (e.g. out of memory)
            self._start()
            msg = "The session process died during the computation and was restarted (its variables were lost)."
            return {"stdout": "", "result": None, "error": msg, "error_info": _failure("session", msg), "data": None, "displays": [], "seconds": 0.0, "restarted": True}
        # over time: interrupt, then give it a few seconds to stop cleanly
        self.interrupt()
        r = self._get(5)
        if r:
            r["error"] = "Interrupted: the time limit of %g s was reached (the session and its variables are kept)." % timeout
            r["error_info"], r["data"] = _failure("timeout", r["error"]), None
            r["restarted"] = restarted
            return r
        self.restart()
        msg = "The time limit of %g s was reached and the computation did not stop when interrupted; the session was restarted (its variables were lost)." % timeout
        return {
            "stdout": "",
            "result": None,
            "error": msg,
            "error_info": _failure("timeout", msg),
            "data": None,
            "displays": [],
            "seconds": timeout,
            "restarted": True,
        }

    def close(self):
        if self.alive():
            try:
                self.proc.stdin.close()
                self.proc.wait(2)
            except Exception:
                pass
        self._kill()

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()


if __name__ == "__main__":
    if sys.argv[1:] == ["--worker"]:
        if os.name == "nt":
            # Ctrl-Break (sent by interrupt()) as KeyboardInterrupt
            signal.signal(signal.SIGBREAK, signal.default_int_handler)
        _worker()
        sys.exit(0)
    with Session() as s:  # a tiny smoke test
        for c in ["2^10", "R.<x> = QQ[]; f = x^4 - 1", "f.factor()", "print(1/3)", "1/0"]:
            print(c, "->", s.run(c))
    sys.exit(0)
