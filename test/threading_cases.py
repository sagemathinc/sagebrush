# threading (lib/threading.py) on the one thread a program has: what CPython prints for the same calls, line for
# line (test/inspect-threading.test.ts).  Starting a thread is Sagebrush's own row, in the test itself.
import threading


def show(label, f):
    try:
        print(label, "->", f())
    except Exception as e:
        print(label, "->", type(e).__name__ + ":", e)


lock = threading.Lock()
show("Lock acquire", lambda: (lock.acquire(), lock.locked()))
show("Lock release", lambda: (lock.release(), lock.locked()))
show("Lock non-blocking", lambda: (lock.acquire(blocking=False), lock.locked(), lock.release()))
with lock:
    show("Lock with", lambda: lock.locked())
show("Lock release unlocked", lambda: lock.release())

r = threading.RLock()
show("RLock twice", lambda: (r.acquire(), r.acquire(), r.release(), r.release()))
show("RLock release unlocked", lambda: r.release())
with r:
    with r:
        show("RLock nested with", lambda: True)

loc = threading.local()
loc.x = 5
show("local", lambda: (loc.x, hasattr(loc, "y"), getattr(loc, "y", "none")))


class MyLocal(threading.local):
    def __init__(self, v):
        self.v = v


show("local subclass", lambda: MyLocal(3).v)
show("local args", lambda: threading.local(1))

ev = threading.Event()
show("Event", lambda: (ev.is_set(), ev.wait(0), ev.set(), ev.is_set(), ev.wait(), ev.wait(0.01)))
ev.clear()
show("Event clear", lambda: ev.is_set())

cond = threading.Condition()
show("Condition notify unacquired", lambda: cond.notify())
with cond:
    show("Condition wait(0)", lambda: cond.wait(0))
    show("Condition wait_for", lambda: cond.wait_for(lambda: 42, 0))
    show("Condition notify_all", lambda: cond.notify_all())

sem = threading.Semaphore(2)
show("Semaphore", lambda: (sem.acquire(), sem.acquire(), sem.acquire(blocking=False), sem.acquire(timeout=0), sem.release(2)))
show("Semaphore(-1)", lambda: threading.Semaphore(-1))
bs = threading.BoundedSemaphore(1)
show("BoundedSemaphore", lambda: (bs.acquire(), bs.release()))
show("BoundedSemaphore over", lambda: bs.release())

main = threading.main_thread()
show("main_thread", lambda: (main is threading.current_thread(), main.name, main.daemon, main.is_alive()))
show("ident", lambda: (main.ident == threading.get_ident(), isinstance(threading.get_native_id(), int)))
show("active_count", lambda: threading.active_count())
show("enumerate", lambda: [t.name for t in threading.enumerate()])

out = []
t = threading.Thread(target=out.append, args=(7,), name="worker")
show("Thread", lambda: (t.name, t.daemon, t.is_alive(), t.ident))
show("Thread join unstarted", lambda: t.join())
t.run()
show("Thread run", lambda: out)
show("Thread daemon", lambda: threading.Thread(daemon=True).daemon)
show("Thread name", lambda: threading.Thread(name=12).name)
show("TIMEOUT_MAX", lambda: threading.TIMEOUT_MAX > 0)
tm = threading.Timer(1, out.append, ["timer"])
tm.cancel()
tm.run()
show("Timer cancelled", lambda: out)
show("Barrier(1)", lambda: threading.Barrier(1).wait())
show("ThreadError", lambda: threading.ThreadError is RuntimeError)
# (the main thread's refusals, each in CPython's words)
show("main_thread().start()", lambda: threading.main_thread().start())
show("current_thread().join()", lambda: threading.current_thread().join())
def set_daemon():
    threading.main_thread().daemon = True
show("main_thread().daemon = True", set_daemon)
