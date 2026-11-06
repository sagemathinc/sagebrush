"""The native kernel: one child process of `sagebrush remote`, holding one
notebook binding's namespace in the box's own CPython (its packages, its
GPUs), with the Sagebrush engine and Sage syntax (design remote-v1 §4).

Started in its own session and process group (start_new_session), so the
runner can end it with everything it started (§4's tree rule).

The protocol: one JSON message per line, in on stdin, out on the original
stdout (fd 1 is moved to stderr, so stray C-level writes don't corrupt it).
In:
    {id, code, mode: "python" | "sage", forget?: [names], mangle?: cell id, seed?: 64 hex}
    {id, complete: code, mode}
Out:
    {ready: true, python: "3.x.y", pid}
    {id, start: true}
    {out: text, stream: "stdout" | "stderr", id}     (session._Capture's chunks, each line <= 64 KiB)
    {id, display: {mime: data}}                     (a value's MIME bundle; each at most DISPLAY_MAX)
    {id, done: true, ms, error?: true, ename?}     (ename: the exception's type name, KeyboardInterrupt for a Stop)
    {id, matches: [...], prefix}                    (completion)
SIGINT interrupts the running code (KeyboardInterrupt, the Rust engines too).
"""

import ast
import base64
import json
import os
import re
import sys
import threading
import time

DISPLAY_MAX = 768 * 1024  # (one display's JSON: a relay frame is at most 1 MiB, with its envelope)
FLUSH_S = 0.05            # (printed output goes out at most every 50 ms while code runs)
_NAME = re.compile(r"^[^\W\d]\w*$")
_SEED = re.compile(r"^[0-9a-fA-F]{64}$")
_CELL = re.compile(r"^[A-Za-z0-9]+$")


def _bundle(v):
    """A value's MIME bundle, as IPython's formatters would make it, or None."""
    b = {}
    f = getattr(v, "_repr_mimebundle_", None)
    if callable(f) and not isinstance(v, type):
        try:
            r = f()
            if isinstance(r, tuple):
                r = r[0]
            if isinstance(r, dict):
                b.update({k: x for k, x in r.items() if isinstance(k, str)})
        except Exception:
            pass
    for mime, attr in (("text/html", "_repr_html_"), ("text/markdown", "_repr_markdown_"), ("image/svg+xml", "_repr_svg_"),
                       ("image/png", "_repr_png_"), ("image/jpeg", "_repr_jpeg_"), ("text/latex", "_repr_latex_"),
                       ("application/json", "_repr_json_")):
        if mime in b:
            continue
        f = getattr(v, attr, None)
        if not callable(f) or isinstance(v, type):
            continue
        try:
            r = f()
        except Exception:
            continue
        if r is None:
            continue
        if isinstance(r, tuple):
            r = r[0]
        if isinstance(r, (bytes, bytearray)):
            r = base64.b64encode(r).decode("ascii")
        b[mime] = r
    return b or None


class _Kernel:
    def __init__(self, sender, capture_cls, hold):
        self.sender = sender
        self.Capture = capture_cls
        self.hold = hold
        self.ns = {"__name__": "__main__"}
        self.rid = None
        self.out = None
        self.seeded = False
        self.sage = False

    # ---- output
    def display_bundle(self, bundle):
        try:
            text = json.dumps(bundle)
        except (TypeError, ValueError):
            bundle = {"text/plain": str(bundle.get("text/plain", "(an output that could not be sent)"))}
            text = json.dumps(bundle)
        if len(text) > DISPLAY_MAX:
            plain = bundle.get("text/plain")
            note = "(an output of %d bytes, over this remote's limit of %d for one output)" % (len(text), DISPLAY_MAX)
            bundle = {"text/plain": (plain[:4096] + "\n" if isinstance(plain, str) else "") + note}
        if self.out is not None:
            self.out.flush()
        self.sender.send({"id": self.rid, "display": bundle})

    def display(self, *objs):
        """builtins.display, as Jupyter's."""
        for v in objs:
            b = _bundle(v)
            if b is None:
                print(repr(v))
            else:
                b.setdefault("text/plain", repr(v))
                self.display_bundle(b)

    def show_value(self, v, mode):
        b = _bundle(v)
        if b is not None:
            b.setdefault("text/plain", repr(v))
            self.display_bundle(b)
        else:
            sys.stdout.write(self.text_of(v, mode) + "\n")

    def text_of(self, v, mode):
        if mode == "python":
            try:
                import pprint
                return pprint.pformat(v)
            except Exception:
                pass
        return repr(v)

    def figures(self):
        """matplotlib's open figures, shown and closed at a run's end (as the inline backend does)."""
        plt = sys.modules.get("matplotlib.pyplot")
        if plt is None:
            return
        try:
            import io
            for num in list(plt.get_fignums()):
                fig = plt.figure(num)
                buf = io.BytesIO()
                fig.savefig(buf, format="png", bbox_inches="tight")
                self.display_bundle({"image/png": base64.b64encode(buf.getvalue()).decode("ascii"), "text/plain": repr(fig)})
            plt.close("all")
        except Exception:
            pass

    # ---- a run
    def prepare(self, req):
        seed = req.get("seed")
        if isinstance(seed, str) and _SEED.match(seed):
            words = [int(seed[8 * i:8 * i + 8], 16) for i in range(8)]
            import builtins
            builtins.__pyjs_seed__ = (int(seed, 16), words, [0])
            import random
            random.seed(int(seed, 16))
            npr = sys.modules.get("numpy.random")
            if npr is not None:
                try:
                    npr.seed(words)
                except Exception:
                    pass
            self.seeded = True
        elif self.seeded:
            import builtins
            builtins.__pyjs_seed__ = None
            self.seeded = False
        forget = req.get("forget")
        if isinstance(forget, list):
            for n in forget:
                if isinstance(n, str) and _NAME.match(n):
                    self.ns.pop(n, None)
        cell = req.get("mangle")
        if isinstance(cell, str) and _CELL.match(cell):
            from sagebrush.remote.mangle import local_prefix
            p = local_prefix(cell)
            for k in [k for k in self.ns if k.startswith(p)]:
                del self.ns[k]
            return cell
        return None

    def run(self, req):
        from sagebrush.session import _format_exception
        mode = req.get("mode", "python")
        code = req.get("code", "")
        self.rid = req.get("id")
        self.sender.send({"id": self.rid, "start": True})
        self.out = self.Capture(self.sender, self.rid)
        stop = threading.Event()

        def flusher(out=self.out):
            while not stop.wait(FLUSH_S):
                out.flush()

        t = threading.Thread(target=flusher, daemon=True)
        t.start()
        error = False
        ename = None  # (the exception's type name: the page marks a KeyboardInterrupt "interrupted")
        t0 = time.perf_counter()
        import contextlib
        try:
            with contextlib.redirect_stdout(self.out.stream("stdout")), contextlib.redirect_stderr(self.out.stream("stderr")):
                try:
                    cell = self.prepare(req)
                    if mode == "sage" and not self.sage:
                        exec("from sagebrush.sage import *", self.ns)  # (the Sage environment, loaded at its first cell)
                        self.sage = True
                    src = code
                    if mode == "sage":
                        from sagebrush.preparse import preparse
                        src = preparse(code)
                    # (the cell's source for its tracebacks' lines: what runs, so Sage mode's preparsed text)
                    import linecache
                    linecache.cache["<cell>"] = (len(src), None, src.splitlines(True), "<cell>")
                    tree = ast.parse(src, "<cell>", "exec")
                    if cell is not None:
                        from sagebrush.remote.mangle import mangle
                        mangle(tree, cell, sage=(mode == "sage"))
                    last = tree.body.pop() if tree.body and isinstance(tree.body[-1], ast.Expr) else None
                    exec(compile(tree, "<cell>", "exec"), self.ns)
                    if last is not None:
                        v = eval(compile(ast.Expression(last.value), "<cell>", "eval"), self.ns)
                        if v is not None:
                            self.ns["_"] = v
                            self.show_value(v, mode)
                    self.figures()
                except KeyboardInterrupt:
                    error, ename = True, "KeyboardInterrupt"
                    sys.stderr.write("KeyboardInterrupt: the computation was interrupted\n")
                except BaseException as e:  # (SystemExit too: the kernel survives)
                    error, ename = True, type(e).__name__
                    text = _format_exception(e, e.__traceback__)
                    sys.stderr.write(re.sub(r"\b_cell_[A-Za-z0-9]+(?=_\w)", "", text) + "\n")
        except KeyboardInterrupt:
            error, ename = True, "KeyboardInterrupt"
        finally:
            stop.set()
        # (the end: what is left of the output drained, once, then done; an interrupt now is for nothing)
        done = []
        while not done:
            try:
                with self.hold, self.sender.lock:
                    self.out._flush()
                    self.out.sealed = True
                    msg = {"id": self.rid, "done": True, "ms": round((time.perf_counter() - t0) * 1000, 3)}
                    if error:
                        msg["error"] = True
                        msg["ename"] = (ename or "Exception")[:64]
                    self.sender.send(msg, lambda: done.append(True))
            except KeyboardInterrupt:
                continue
        self.out = None

    def complete(self, req):
        rid = req.get("id")
        code = req.get("complete", "")
        m = re.search(r"[A-Za-z_][\w.]*$", code if isinstance(code, str) else "")
        prefix = m.group(0) if m else ""
        matches = []
        try:
            import rlcompleter
            c = rlcompleter.Completer(self.ns)
            deadline = time.monotonic() + 0.2
            i = 0
            while time.monotonic() < deadline and i < 200:
                s = c.complete(prefix, i)
                if s is None:
                    break
                matches.append(s)
                i += 1
        except BaseException:
            matches = []
        self.sender.send({"id": rid, "matches": matches, "prefix": prefix})


def main():
    from sagebrush import session as S

    proto = os.fdopen(os.dup(1), "w", encoding="utf-8")
    try:
        os.dup2(2, 1)
    except OSError:
        pass
    sys.stdout = sys.stderr
    os.environ.setdefault("MPLBACKEND", "Agg")
    S._HOLD.install()
    if S._print_borrows_stdout():
        S._strong_print()
    sender = S._Sender(proto)
    k = _Kernel(sender, S._Capture, S._HOLD)
    import builtins
    builtins.display = k.display
    builtins.__pyjs_display__ = lambda v: (k.show_value(v, "sage"), True)[1]
    import random  # (imported now, so a seeded run reseeds it)
    S._send_until_committed(sender, {"ready": True, "python": sys.version.split()[0], "pid": os.getpid()})
    import io
    inp = io.TextIOWrapper(sys.stdin.buffer, encoding="utf-8")
    while True:
        try:
            line = inp.readline()
        except KeyboardInterrupt:
            continue
        if not line:
            return
        try:
            req = json.loads(line)
        except ValueError:
            continue
        if not isinstance(req, dict):
            continue
        try:
            if "complete" in req:
                k.complete(req)
            else:
                k.run(req)
        except KeyboardInterrupt:
            continue  # (an interrupt between runs: for nothing)


if __name__ == "__main__":
    main()
    sys.exit(0)
