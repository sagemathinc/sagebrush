"""The oracles for the bash shell (plan-bash-shell r3, step 0): GNU bash for
redirections, IPython for !cmd, CPython for os.system.  Black-box runs only.

Runs every case of test/bash-oracle-cases.json and writes test/bash-oracle.json:

    python3 test/bash_oracle.py > test/bash-oracle.json

It needs bash and an IPython (the version is recorded).  The redirection and
os.system parts are re-run by test/bash-oracle.test.ts in CI; IPython isn't
installed there, so its part is checked only against this file.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
CASES = json.load(open(os.path.join(HERE, "bash-oracle-cases.json")))


def text(b):
    """bytes as a str when they are UTF-8, else as a list of byte values"""
    try:
        return b.decode("utf-8")
    except UnicodeDecodeError:
        return list(b)


def setup(d):
    for name, content in CASES["setup"].items():
        with open(os.path.join(d, name), "wb") as f:
            f.write(content.encode() if isinstance(content, str) else bytes(content))


def files(d):
    out = {}
    for name in CASES["observe"]:
        p = os.path.join(d, name)
        out[name] = text(open(p, "rb").read()) if os.path.exists(p) else None
    return out


def redirections():
    out = []
    for c in CASES["redirections"]:
        d = tempfile.mkdtemp(prefix="bash-oracle-")
        try:
            setup(d)
            r = subprocess.run(["bash", "-c", c["script"]], cwd=d, capture_output=True, env={"PATH": os.environ["PATH"], "LC_ALL": "C"})
            out.append({"id": c["id"], "exit": r.returncode, "stdout": text(r.stdout), "stderr": text(r.stderr), "files": files(d)})
        finally:
            shutil.rmtree(d)
    return out


# One IPython cell per process: the cell's output is the process's stdout and
# stderr (a child's output goes to the descriptors, not through sys.stdout),
# and what it observes is written to a separate file.
IPYTHON_HARNESS = r"""
import json, sys
from IPython.core.interactiveshell import InteractiveShell
case = json.loads(sys.argv[1])
sh = InteractiveShell.instance()
r = sh.run_cell(case["cell"], store_history=False)
sys.stdout.flush(); sys.stderr.flush()
seen = {}
for e in case["observe"]:
    try:
        seen[e] = sh.ev(e)
    except Exception as x:
        seen[e] = "!" + type(x).__name__
json.dump({"error": None if r.success else repr(r.error_in_exec or r.error_before_exec), "observed": seen}, open(sys.argv[2], "w"), default=repr)
"""


def ipython():
    out = []
    for c in CASES["ipython"]:
        d = tempfile.mkdtemp(prefix="bash-oracle-")
        try:
            res = os.path.join(d, "result.json")
            r = subprocess.run([sys.executable, "-c", IPYTHON_HARNESS, json.dumps(c), res], cwd=d, capture_output=True, env={"PATH": os.environ["PATH"], "LC_ALL": "C", "HOME": d})
            got = json.load(open(res)) if os.path.exists(res) else {"error": "no result", "observed": {}}
            out.append({"id": c["id"], "stdout": text(r.stdout), "stderr": text(r.stderr), **got})
        finally:
            shutil.rmtree(d)
    return out


OS_SYSTEM_HARNESS = r"""
import os, sys
v = os.system(sys.argv[1])
open(sys.argv[2], "w").write(str(v))
"""


def os_system():
    out = []
    for c in CASES["os_system"]:
        d = tempfile.mkdtemp(prefix="bash-oracle-")
        try:
            res = os.path.join(d, "status")
            r = subprocess.run([sys.executable, "-I", "-c", OS_SYSTEM_HARNESS, c["command"], res], cwd=d, capture_output=True, env={"PATH": os.environ["PATH"], "LC_ALL": "C"})
            out.append({"id": c["id"], "status": int(open(res).read()), "stdout": text(r.stdout), "stderr": text(r.stderr)})
        finally:
            shutil.rmtree(d)
    return out


def main():
    import IPython

    bash = subprocess.run(["bash", "--version"], capture_output=True, text=True).stdout.splitlines()[0]
    json.dump(
        {
            "versions": {"bash": bash, "ipython": IPython.__version__, "python": sys.version.split()[0]},
            "redirections": redirections(),
            "ipython": ipython(),
            "os_system": os_system(),
        },
        sys.stdout,
        indent=1,
        ensure_ascii=False,
    )
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
