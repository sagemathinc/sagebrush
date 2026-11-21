"""The Python factor callback of the modular-forms ops (sagebrush.mf: newspace,
newforms; their factor= argument): a KeyboardInterrupt raised in it ends
the engine call as KeyboardInterrupt, not as "the factor callback did not
return an irreducible factorization", and the interpreter stays usable,
on the main thread and on others, with no other call stopped by it; any
other error in it is still that error.  Then Ctrl-C during newforms
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
    # from a thread that isn't the main one (guarded installs no SIGINT
    # guard there): the callback's KeyboardInterrupt sets no global request,
    # so that thread's next call completes
    import threading
    out = {}

    def worker():
        try:
            mf.newspace(37, 2, factor=interrupting)
            out["first"] = "not interrupted"
        except KeyboardInterrupt:
            out["first"] = "interrupted"
        out["next"] = mf.newspace(11, 2)["dim"]

    t = threading.Thread(target=worker)
    t.start()
    t.join()
    assert out == {"first": "interrupted", "next": 1}, out

    # and an unrelated call on another thread, paused in its own callback
    # while this one's raises KeyboardInterrupt, is not stopped by it
    paused, resume = threading.Event(), threading.Event()

    def pausing(f):
        paused.set()
        resume.wait(60)
        return mf._factor(f)

    def unrelated():
        try:
            out["unrelated"] = mf.newspace(37, 2, factor=pausing)["dim"]
        except KeyboardInterrupt:
            out["unrelated"] = "interrupted"

    def interrupted():
        try:
            mf.newspace(11, 2, factor=interrupting)
            out["other"] = "not interrupted"
        except KeyboardInterrupt:
            out["other"] = "interrupted"

    u = threading.Thread(target=unrelated)
    u.start()
    assert paused.wait(60)
    i = threading.Thread(target=interrupted)
    i.start()
    i.join()
    resume.set()
    u.join()
    assert (out["other"], out["unrelated"]) == ("interrupted", 2), out
    print("threads: ok")
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
