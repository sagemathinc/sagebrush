"""The remote runner's kernel child (sagebrush/remote/child.py; design
remote-v1 §4), driven over its pipe protocol as the gateway will drive it:

- ready, then runs: the last expression's value, printed output streamed,
  stderr, an error with its traceback, SystemExit survived;
- Sage mode (the preparser: 2^10, 1/3 exact), Python mode untouched (2^10 is xor);
- a value with a MIME bundle sent as a display; matplotlib figures as PNG;
- forget (the reactive engine's invalidation) and a cell's `_` names (mangle);
- a seed: the same seed, the same random numbers;
- SIGINT: interrupts a busy loop, the kernel survives and runs again;
- completion;
- its own session and process group (start_new_session), so the gateway's
  tree kill reaches what it started.

    python engine/py/test_remote_child.py
"""
import json
import os
import signal
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))


class Child:
    def __init__(self):
        env = dict(os.environ)  # (the installed sagebrush, as CI's engine-cpython job installs the wheel; locally PYTHONPATH)
        self.p = subprocess.Popen([sys.executable, "-m", "sagebrush.remote.child"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.DEVNULL, env=env, start_new_session=True)
        self.msgs = []
        self.cv = threading.Condition()
        threading.Thread(target=self._read, daemon=True).start()
        self.ready = self.wait(lambda m: m.get("ready"), 60)
        self.n = 0

    def _read(self):
        for line in self.p.stdout:
            with self.cv:
                self.msgs.append(json.loads(line))
                self.cv.notify_all()

    def wait(self, pred, timeout=60):
        end = time.monotonic() + timeout
        with self.cv:
            while True:
                for m in self.msgs:
                    if pred(m):
                        return m
                left = end - time.monotonic()
                assert left > 0, ("timed out", self.msgs[-5:])
                self.cv.wait(left)

    def send(self, req):
        self.p.stdin.write((json.dumps(req) + "\n").encode())
        self.p.stdin.flush()

    def run(self, code, mode="python", timeout=120, **kw):
        self.n += 1
        rid = "r%d" % self.n
        self.send({"id": rid, "code": code, "mode": mode, **kw})
        done = self.wait(lambda m: m.get("id") == rid and m.get("done"), timeout)
        with self.cv:
            mine = [m for m in self.msgs if m.get("id") == rid]
        out = "".join(m["out"] for m in mine if m.get("stream") == "stdout")
        err = "".join(m["out"] for m in mine if m.get("stream") == "stderr")
        displays = [m["display"] for m in mine if "display" in m]
        return out, err, displays, done

    def close(self):
        try:
            os.killpg(self.p.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        self.p.wait()


K = None


def kernel():
    global K
    if K is None:
        K = Child()
    return K


def test_ready():
    k = kernel()
    assert k.ready["pid"] == k.p.pid and k.ready["python"].startswith("3."), k.ready


def test_values_output_errors():
    k = kernel()
    out, err, _, done = k.run("x = 2 + 3\nprint('hi')\nx")
    assert out == "hi\n5\n" and err == "" and "error" not in done, (out, err, done)
    out, err, _, done = k.run("import sys\nprint('e', file=sys.stderr)")
    assert err == "e\n" and "error" not in done
    out, err, _, done = k.run("def f():\n    return 1/0\nf()")
    assert done.get("error") and "ZeroDivisionError" in err and "f()" in err, err
    assert done.get("ename") == "ZeroDivisionError", done
    out, err, _, done = k.run("raise SystemExit(3)")
    assert done.get("error")
    out, _, _, done = k.run("x * 2")  # (the kernel survived, its namespace kept)
    assert out == "10\n", out


def test_sage_mode():
    k = kernel()
    out, err, _, done = k.run("2^10", mode="sage")
    assert out.strip() == "1024", (out, err)
    out, err, displays, _ = k.run("1/3", mode="sage")  # (a Rational: its MIME bundle, LaTeX and text)
    assert out == "" and displays == [{"text/latex": "$\\frac{1}{3}$", "text/plain": "1/3"}], (out, err, displays)
    out, _, _, _ = k.run("2^10")
    assert out.strip() == "8", out  # (Python mode: xor)


def test_display():
    k = kernel()
    out, err, displays, _ = k.run("class H:\n    def _repr_html_(self):\n        return '<b>h</b>'\nH()")
    assert displays and displays[0]["text/html"] == "<b>h</b>" and "text/plain" in displays[0], (displays, err)
    out, err, displays, _ = k.run("display(H(), 7)")
    assert displays[0]["text/html"] == "<b>h</b>" and out == "7\n", (out, displays)


def test_matplotlib_figure():
    try:
        import matplotlib  # noqa: F401
    except ImportError:
        print("  (matplotlib not installed here: skipped)")
        return
    k = kernel()
    _, err, displays, _ = k.run("import matplotlib.pyplot as plt\nplt.plot([1, 2, 3])\nNone")
    assert any("image/png" in d for d in displays), (displays, err)


def test_forget_and_mangle():
    k = kernel()
    k.run("y = 1")
    out, err, _, done = k.run("y", forget=["y"])
    assert done.get("error") and "NameError" in err, err
    out, err, _, _ = k.run("_t = 41\n_t + 1", mangle="c1")
    assert out == "42\n", (out, err)
    out, err, _, done = k.run("_t")  # (another cell, unmangled, doesn't see c1's _t)
    assert done.get("error") and "NameError" in err, err
    out, _, _, _ = k.run("sorted(k for k in globals() if k.startswith('_cell_c1_'))")
    assert "_cell_c1_t" in out, out
    k.run("_u = 1", mangle="c1")  # (c1 runs again: its old names are dropped first)
    out, _, _, _ = k.run("sorted(k for k in globals() if k.startswith('_cell_c1_'))")
    assert "_cell_c1_t" not in out and "_cell_c1_u" in out, out


def test_seed():
    k = kernel()
    seed = "ab" * 32
    a, _, _, _ = k.run("import random\nrandom.random()", seed=seed)
    b, _, _, _ = k.run("random.random()", seed=seed)
    c, _, _, _ = k.run("random.random()", seed="cd" * 32)
    assert a == b != c, (a, b, c)


def test_python_semantics():
    """grader's #762 group E, each against CPython's own behaviour: `_` is the last value (C8); a traceback names a
    cell's private name as written, not mangled (C9); a run without a seed after a seeded one isn't deterministic
    (C7); a method doesn't see its class body's names (M2)."""
    k = kernel()
    out, _, _, _ = k.run("1 + 1")
    out, err, _, _ = k.run("_ * 10")
    assert out == "20\n", (out, err)
    _, err, _, done = k.run("_nope_q + 1", mangle="c9")
    assert done.get("error") and "NameError" in err and "_nope_q" in err and "_cell_" not in err, err
    # (a seed holds for its run only: the engine's seed hook is set for it, and cleared for the next unseeded run)
    out, _, _, _ = k.run("__import__('builtins').__pyjs_seed__ is not None", seed="12" * 32)
    assert out == "True\n", out
    out, _, _, _ = k.run("__import__('builtins').__pyjs_seed__ is None")
    assert out == "True\n", out
    code = "_a = 1\nclass K:\n    _a = 2\n    def f(self):\n        return _a\nK().f()"
    want = {}
    exec(compile(code.rsplit("\n", 1)[0], "x", "exec"), want)
    out, err, _, _ = k.run(code, mangle="m2")
    assert out == "%r\n" % want["K"]().f() == "1\n", (out, err)


def test_interrupt():
    k = kernel()
    k.n += 1
    rid = "r%d" % k.n
    k.send({"id": rid, "code": "import time\nwhile True:\n    time.sleep(0.01)", "mode": "python"})
    k.wait(lambda m: m.get("id") == rid and m.get("start"))
    time.sleep(0.3)
    os.kill(k.p.pid, signal.SIGINT)
    done = k.wait(lambda m: m.get("id") == rid and m.get("done"), 30)
    assert done.get("error")
    err = "".join(m["out"] for m in k.msgs if m.get("id") == rid and m.get("stream") == "stderr")
    assert "KeyboardInterrupt" in err, err
    assert done.get("ename") == "KeyboardInterrupt", done
    out, _, _, _ = k.run("1 + 1")
    assert out == "2\n", out


def test_complete():
    k = kernel()
    k.run("import math")
    k.send({"id": "c1", "complete": "math.sq", "mode": "python"})
    m = k.wait(lambda m: m.get("id") == "c1" and "matches" in m)
    assert m["prefix"] == "math.sq" and "math.sqrt(" in m["matches"], m


def test_process_group():
    k = kernel()
    assert os.getpgid(k.p.pid) == k.p.pid and os.getsid(k.p.pid) == k.p.pid
    out, _, _, _ = k.run("import subprocess\np = subprocess.Popen(['sleep', '300'])\np.pid")
    grandchild = int(out)
    assert os.getpgid(grandchild) == k.p.pid
    k.close()
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        try:
            os.kill(grandchild, 0)
        except ProcessLookupError:
            break
        try:  # (reaped by init once orphaned; a zombie still answers kill 0)
            with open("/proc/%d/stat" % grandchild) as f:
                if f.read().split(")")[-1].split()[0] == "Z":
                    break
        except OSError:
            break
        time.sleep(0.05)
    else:
        raise AssertionError("the grandchild outlived its process group's kill")


if __name__ == "__main__":
    try:
        for name, f in list(globals().items()):
            if name.startswith("test_") and callable(f):
                f()
                print("ok", name)
    finally:
        if K is not None and K.p.poll() is None:
            K.close()
    print("all remote child tests passed")
