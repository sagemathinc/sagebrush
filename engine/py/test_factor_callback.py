"""The Python factor callback of the modular-forms ops (sagebrush.mf: newspace,
newforms; their factor= argument): a KeyboardInterrupt raised in it ends
the engine call as KeyboardInterrupt, not as "the factor callback did not
return an irreducible factorization", and the interpreter stays usable;
any other error in it is still that error.  Then Ctrl-C during newforms
with the default callback (a child process, SIGINT at several moments):
KeyboardInterrupt or a finished call, never the callback error.

    python engine/py/test_factor_callback.py
"""
import signal
import subprocess
import sys
import time

from sagebrush import mf


def interrupting(f):
    raise KeyboardInterrupt


def failing(f):
    raise RuntimeError("no")


def main():
    for op in (mf.newspace, lambda n, k, factor: mf.newforms(n, k, bound=10, factor=factor)):
        try:
            op(37, 2, factor=interrupting)
            raise AssertionError("not interrupted")
        except KeyboardInterrupt:
            pass
        # (the next call is not stopped by the request)
        assert op(37, 2, factor=None)["dim"] == 2
        try:
            op(37, 2, factor=failing)
            raise AssertionError("no error")
        except ValueError as e:
            assert "did not return an irreducible factorization" in str(e), e
    print("the callback's KeyboardInterrupt: ok")
    if sys.platform == "win32":
        print("Ctrl-C during the callback: skipped on Windows")
        return
    child = r'''
import sys, time
from sagebrush import mf
print("ready", flush=True)
try:
    mf.newforms(389, 4, bound=50)
    print("finished", flush=True)
except KeyboardInterrupt:
    print("interrupted", flush=True)
except ValueError as e:
    print("error: %s" % e, flush=True)
print("then:", mf.newspace(11, 2)["dim"], flush=True)
'''
    for delay in (0.2, 0.5, 1.0, 2.0):
        c = subprocess.Popen([sys.executable, "-c", child], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        assert c.stdout.readline().strip() == "ready"
        time.sleep(delay)
        c.send_signal(signal.SIGINT)
        out, err = c.communicate(timeout=120)
        lines = out.split("\n")
        assert lines[0] in ("interrupted", "finished"), (delay, out, err)
        assert lines[1] == "then: 1", (delay, out, err)
    print("Ctrl-C during newforms: ok")


if __name__ == "__main__":
    main()
