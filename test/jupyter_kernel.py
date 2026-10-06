"""End-to-end test of the Sagebrush Jupyter kernel with Jupyter's own client
(jupyter_client, over pyzmq): signed messages, execution and results,
streams, SVG display, errors, completion, is_complete, interrupts of Python
loops and of the engines, Magma and Python modes, and shutdown.

    pip install jupyter_client
    python test/jupyter_kernel.py [path to the sagebrush bundle or executable]

The kernelspecs are installed into a temporary Jupyter data directory.
"""
import os
import shutil
import subprocess
import sys
import tempfile
import time

from jupyter_client import KernelManager

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
target = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "build", "cli", "pyjs.cjs")
cmd = ["node", target] if target.endswith((".cjs", ".js")) else [target]

data = tempfile.mkdtemp(prefix="sagebrush-jupyter-")
os.environ["JUPYTER_DATA_DIR"] = data
os.environ["JUPYTER_PATH"] = data
out = subprocess.run(cmd + ["--install-jupyter-kernel", "--mode", "all"], capture_output=True, text=True, check=True).stdout
assert out.count("installed the Jupyter kernel") == 3, out

failures = []


def check(name, cond, detail=""):
    print(("ok   " if cond else "FAIL ") + name + ("" if cond else ": " + str(detail)[:500]))
    if not cond:
        failures.append(name)


def run(kc, code, timeout=60, interrupt_after=None, km=None):
    """Execute; collect (reply content, [iopub messages])."""
    msg_id = kc.execute(code)
    msgs = []
    t0 = time.time()
    interrupted = False
    while True:
        if interrupt_after is not None and not interrupted and time.time() - t0 > interrupt_after:
            km.interrupt_kernel()
            interrupted = True
        try:
            m = kc.get_iopub_msg(timeout=0.5)
        except Exception:
            if time.time() - t0 > timeout:
                raise TimeoutError(code)
            continue
        if m["parent_header"].get("msg_id") != msg_id:
            continue
        msgs.append(m)
        if m["msg_type"] == "status" and m["content"]["execution_state"] == "idle":
            break
    reply = kc.get_shell_msg(timeout=timeout)
    return reply["content"], msgs


def of(msgs, t):
    return [m["content"] for m in msgs if m["msg_type"] == t]


def kernel(name):
    km = KernelManager(kernel_name=name)
    km.start_kernel()
    kc = km.client()
    kc.start_channels()
    kc.wait_for_ready(timeout=60)
    return km, kc


# ---- Sage mode
km, kc = kernel("sagebrush")
info = kc.kernel_info(reply=True)["content"]
check("kernel_info", info["implementation"] == "sagebrush" and info["language_info"]["name"] == "sage", info)
r, m = run(kc, "2^10")
check("execute_result", r["status"] == "ok" and of(m, "execute_result")[0]["data"]["text/plain"] == "1024", m)
check("execute_input + execution_count", of(m, "execute_input")[0]["code"] == "2^10" and r["execution_count"] == 1, r)
r, m = run(kc, "R.<x> = QQ[]\nf = x^4 - 1\nprint('factored:', f.factor())")
check("stream", "".join(c["text"] for c in of(m, "stream")) == "factored: (x - 1) * (x + 1) * (x^2 + 1)\n", m)
r, m = run(kc, "f.degree()")
check("state persists", of(m, "execute_result")[0]["data"]["text/plain"] == "4", m)
r, m = run(kc, "x = var('x'); plot(sin(x), (x, 0, 3))")
d = of(m, "display_data") + of(m, "execute_result")
check("SVG display", any("image/svg+xml" in c["data"] for c in d), [list(c["data"]) for c in d])
r, m = run(kc, "1/0")
e = of(m, "error")
check("error", r["status"] == "error" and e and e[0]["ename"] == "ZeroDivisionError", (r, e))
c = kc.complete("fact", 4, reply=True)["content"]
check("complete", "factor" in c["matches"] and c["cursor_start"] == 0, c)
kc.is_complete("for i in range(3):")
c = kc.get_shell_msg(timeout=10)["content"]
check("is_complete (incomplete)", c["status"] == "incomplete", c)
kc.is_complete("1 + 1")
c = kc.get_shell_msg(timeout=10)["content"]
check("is_complete (complete)", c["status"] == "complete", c)
t0 = time.time()
r, m = run(kc, "while True:\n    pass", interrupt_after=1.5, km=km)
e = of(m, "error")
check("interrupt a Python loop", r["status"] == "error" and e and e[0]["ename"] == "KeyboardInterrupt" and time.time() - t0 < 10, (r, e))
t0 = time.time()
r, m = run(kc, "factor(2^512 + 1)", interrupt_after=1.5, km=km)
e = of(m, "error")
check("interrupt the engine (ECM)", r["status"] == "error" and e and e[0]["ename"] == "KeyboardInterrupt" and time.time() - t0 < 10, (r, e))
r, m = run(kc, "factor(2026)")
check("works after interrupts", of(m, "execute_result")[0]["data"]["text/plain"] == "2 * 1013", m)
r, m = run(kc, "K.<a> = NumberField(x^3 - 11)\nK.class_number()")
check("number field (engine)", of(m, "execute_result")[0]["data"]["text/plain"] == "2", m)
km.shutdown_kernel(now=False)
check("shutdown", not km.is_alive())

# ---- Python mode
km, kc = kernel("sagebrush-python")
r, m = run(kc, "2^10, 7/2")
check("python mode", of(m, "execute_result")[0]["data"]["text/plain"] == "(8, 3.5)", m)
km.shutdown_kernel(now=True)

# ---- Magma mode
km, kc = kernel("sagebrush-magma")
r, m = run(kc, "x := 2^10;\nx;\nFactorization(2026);")
s = "".join(c["text"] for c in of(m, "stream"))
check("magma mode", "1024" in s and "<2, 1>" in s and "<1013, 1>" in s, s)
km.shutdown_kernel(now=True)

out = subprocess.run(cmd + ["--uninstall-jupyter-kernel", "--mode", "all"], capture_output=True, text=True).stdout
check("uninstall", out.count("removed the Jupyter kernel") == 3, out)
shutil.rmtree(data, ignore_errors=True)
print("%d failures" % len(failures))
sys.exit(1 if failures else 0)
