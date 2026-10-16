"""End-to-end test of the Sagebrush Jupyter kernel with Jupyter's own client
(jupyter_client, over pyzmq): signed messages, execution and results,
streams, SVG display, errors, completion, is_complete, interrupts of Python
loops and of the engines, Magma, MATLAB and Python modes, and shutdown.

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
assert out.count("installed the Jupyter kernel") == 4, out

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
# a big 3D scene goes to a page in .sagebrush/, shown in an iframe: the output
# stays far under the front ends' output limits (CoCalc's is 1 MB per cell)
big = tempfile.mkdtemp(prefix="sagebrush-k3d-")
r, m = run(kc, "import os, k3d, numpy as np\nos.chdir(%r)\nk3d.points(np.random.rand(150000, 3).astype(np.float32))" % big, timeout=120)
d = of(m, "display_data") + of(m, "execute_result")
sizes = [sum(len(v) for v in c["data"].values()) for c in d]
# (in CoCalc an iframe of the page; elsewhere a link to it)
shown = "<iframe" if os.environ.get("COCALC_PROJECT_ID") else ".sagebrush/plot3d-"
check("big 3D scene: an iframe on a saved page", d and max(sizes) < 5000 and shown in d[-1]["data"]["text/html"]
      and not any("application/vnd.sagebrush.scene3d+json" in c["data"] for c in d)
      and len(os.listdir(os.path.join(big, ".sagebrush"))) == 1, (sizes, of(m, "error"), of(m, "stream")))
shutil.rmtree(big, ignore_errors=True)
r, m = run(kc, "show(factor(x^4 - 1))")
check("show() typesets a factorization", any("\\left(x - 1\\right)" in c["data"].get("text/latex", "") for c in of(m, "display_data")), m)
r, m = run(kc, "1/0")
e = of(m, "error")
check("error", r["status"] == "error" and e and e[0]["ename"] == "ZeroDivisionError", (r, e))
check("an error is one error message", len(e) == 1, e)
r, m = run(kc, "import sys\nclass Bad:\n    def __str__(self):\n        raise RuntimeError('no')\nsys.exit(Bad())")
check("an exit status that can't be text: an error reply all the same", r["status"] == "error" and r["ename"] == "SystemExit" and "could not be written" in r["evalue"], r)
r, m = run(kc, "import sys\nsys.exit('x' * 1000000)")
check("a long exit status: bounded", r["status"] == "error" and r["evalue"].endswith("(995904 more characters)") and len(r["evalue"]) < 4200, len(r.get("evalue", "")))
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
t0 = time.time()
r, m = run(kc, "import re\nre.match('(a+)+$', 'a' * 40 + 'b')", interrupt_after=1.5, km=km)
e = of(m, "error")
check("interrupt a call that never checks (a catastrophic re.match): the worker restarted",
      r["status"] == "error" and e and "did not stop when interrupted" in e[0]["evalue"] and time.time() - t0 < 6, (r, e, time.time() - t0))
r, m = run(kc, "factor(2026)")
check("works after interrupts", of(m, "execute_result")[0]["data"]["text/plain"] == "2 * 1013", m)
r, m = run(kc, "K.<a> = NumberField(x^3 - 11)\nK.class_number()")
check("number field (engine)", of(m, "execute_result")[0]["data"]["text/plain"] == "2", m)
# IPython's magics: %time runs Sage's code in the cell, its value the result; a
# function's locals; shell commands are refused
r, m = run(kc, "def g():\n    z = 11\n    %time print(z)\ng()\n%time 2^10")
out = "".join(c["text"] for c in of(m, "stream"))
check("%time (Sage)", of(m, "execute_result")[0]["data"]["text/plain"] == "1024" and out.startswith("11\nWall time: ") and out.count("Wall time") == 2, m)
r, m = run(kc, "!ls")
check("!ls is refused", r["status"] == "error" and "shell commands are not available" in r["evalue"], r)
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
# (an error: Magma says it, and Jupyter is told the cell failed; quit is no error)
r, m = run(kc, "y := NotAnIntrinsic(2);")
e = of(m, "error")
check("magma error: an error reply", r["status"] == "error" and r["ename"] == "MagmaError" and "has not been declared" in r["evalue"] and r["traceback"] == [] and len(e) == 1, (len(e), e))
r, m = run(kc, "z := 1 div 0;")
check("magma runtime error: an error reply", r["status"] == "error" and r["evalue"].startswith("Runtime error"), r)
r, m = run(kc, 'error "' + "X" * 5000 + '";')
check("magma error longer than a line's bound: still MagmaError", r["status"] == "error" and r["ename"] == "MagmaError" and r["evalue"].startswith("Runtime error: XXX") and len(r["evalue"]) <= 1001, (r["ename"], r["evalue"][:60], len(r["evalue"])))
r, m = run(kc, "print x + 1;\nquit;")
s = "".join(c["text"] for c in of(m, "stream"))
check("magma quit: no error", r["status"] == "ok" and s == "1025\n" and not of(m, "error"), (r, s))
km.shutdown_kernel(now=True)

# ---- MATLAB mode
km, kc = kernel("sagebrush-matlab")
info = kc.kernel_info(reply=True)["content"]
check("matlab kernel_info", info["language_info"]["name"] == "matlab" and info["language_info"]["file_extension"] == ".m", info)
r, m = run(kc, "x = 2^10\nA = magic(3);")
s = "".join(c["text"] for c in of(m, "stream"))
check("matlab mode", r["status"] == "ok" and s == "\nx =\n\n        1024\n\n", repr(s))
r, m = run(kc, "function y = twice(v)\n  y = 2 * v;\nend")
r, m = run(kc, "twice(A(2, :))")
s = "".join(c["text"] for c in of(m, "stream"))
check("matlab state and functions persist", "ans =" in s and "6    10    14" in s, repr(s))
r, m = run(kc, "y = undefined_thing + 1")
e = of(m, "error")
check("matlab error", r["status"] == "error" and e and e[0]["traceback"] == ["Unrecognized function or variable 'undefined_thing'."], (r, e))
r, m = run(kc, "plot(1:3)")
check("matlab figure", any("image/svg+xml" in c["data"] for c in of(m, "display_data")), [list(c["data"]) for c in of(m, "display_data")])
r, m = run(kc, "x = [1 2")
e = of(m, "error")
check("matlab syntax error", r["status"] == "error" and e and e[0]["ename"] == "MATLAB:syntax", (r, e))
kc.is_complete("if true")
c = kc.get_shell_msg(timeout=10)["content"]
check("matlab is_complete (an open if: incomplete)", c["status"] == "incomplete", c)
kc.is_complete("if true\n  x = 1;\nend")
c = kc.get_shell_msg(timeout=10)["content"]
check("matlab is_complete (complete)", c["status"] == "complete", c)
kc.is_complete("x = 1 ...")
c = kc.get_shell_msg(timeout=10)["content"]
check("matlab is_complete (a line ending in ...: incomplete)", c["status"] == "incomplete", c)
km.shutdown_kernel(now=True)

out = subprocess.run(cmd + ["--uninstall-jupyter-kernel", "--mode", "all"], capture_output=True, text=True).stdout
check("uninstall", out.count("removed the Jupyter kernel") == 4, out)
shutil.rmtree(data, ignore_errors=True)
print("%d failures" % len(failures))
sys.exit(1 if failures else 0)
