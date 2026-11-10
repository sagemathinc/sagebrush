"""threading for a single-threaded runtime (Sagebrush's own, on lib/_thread.py).

A program's Python runs on one thread here, the main thread, so a lock never
contends and a thread-local value is the one thread's.  Thread objects can be
made, and their run() called, but start() refuses, as CPython's does where
_thread can't start a thread.  A wait that only another thread could end (an
unset Event or a Condition waited on without a timeout, an RLock or Semaphore
that would block) is a RuntimeError, never a hang.
"""

import _thread
import sys as _sys

__all__ = ['get_ident', 'active_count', 'Condition', 'current_thread',
           'enumerate', 'main_thread', 'TIMEOUT_MAX',
           'Event', 'Lock', 'RLock', 'Semaphore', 'BoundedSemaphore', 'Thread',
           'Barrier', 'BrokenBarrierError', 'Timer', 'ThreadError',
           'setprofile', 'settrace', 'local', 'stack_size',
           'excepthook', 'ExceptHookArgs', 'gettrace', 'getprofile',
           'setprofile_all_threads', 'settrace_all_threads', 'get_native_id']

get_ident = _thread.get_ident
get_native_id = _thread.get_native_id
ThreadError = _thread.error
TIMEOUT_MAX = _thread.TIMEOUT_MAX
stack_size = _thread.stack_size
Lock = _thread.allocate_lock

_trace_hook = None
_profile_hook = None


def _one_thread(what):
    return RuntimeError(f"{what}: only one thread runs here, so nothing else could end the wait")


def settrace(func):
    global _trace_hook
    _trace_hook = func


def settrace_all_threads(func):
    settrace(func)


def gettrace():
    return _trace_hook


def setprofile(func):
    global _profile_hook
    _profile_hook = func


def setprofile_all_threads(func):
    setprofile(func)


def getprofile():
    return _profile_hook


class _RLock:
    """A reentrant lock: held by the one thread any number of times."""

    def __init__(self):
        self._count = 0

    def __repr__(self):
        return "<%s %s.%s object owner=%r count=%d at %s>" % (
            "locked" if self._count else "unlocked", self.__class__.__module__,
            self.__class__.__qualname__, get_ident() if self._count else None,
            self._count, hex(id(self)))

    def acquire(self, blocking=True, timeout=-1):
        self._count += 1
        return True

    __enter__ = acquire

    def release(self):
        if not self._count:
            raise RuntimeError("cannot release un-acquired lock")
        self._count -= 1

    def __exit__(self, t, v, tb):
        self.release()

    def locked(self):
        return self._count > 0

    def _is_owned(self):
        return self._count > 0

    def _release_save(self):
        count, self._count = self._count, 0
        return count

    def _acquire_restore(self, count):
        self._count = count


def RLock(*args, **kwargs):
    return _RLock(*args, **kwargs)


class Condition:

    def __init__(self, lock=None):
        if lock is None:
            lock = RLock()
        self._lock = lock
        self.acquire = lock.acquire
        self.release = lock.release

    def __enter__(self):
        return self._lock.__enter__()

    def __exit__(self, *args):
        return self._lock.__exit__(*args)

    def __repr__(self):
        return "<Condition(%s, 0)>" % (self._lock,)

    def _is_owned(self):
        if hasattr(self._lock, '_is_owned'):
            return self._lock._is_owned()
        return self._lock.locked()

    def wait(self, timeout=None):
        if not self._is_owned():
            raise RuntimeError("cannot wait on un-acquired lock")
        if timeout is None:
            raise _one_thread("Condition.wait()")
        return False

    def wait_for(self, predicate, timeout=None):
        result = predicate()
        if result:
            return result
        if timeout is None:
            raise _one_thread("Condition.wait_for()")
        return result

    def notify(self, n=1):
        if not self._is_owned():
            raise RuntimeError("cannot notify on un-acquired lock")

    def notify_all(self):
        self.notify()


class Semaphore:

    def __init__(self, value=1):
        if value < 0:
            raise ValueError("semaphore initial value must be >= 0")
        self._value = value

    def __repr__(self):
        return f"<{self.__class__.__module__}.{self.__class__.__qualname__} at {id(self):#x}: value={self._value}>"

    def acquire(self, blocking=True, timeout=None):
        if not blocking and timeout is not None:
            raise ValueError("can't specify timeout for non-blocking acquire")
        if self._value > 0:
            self._value -= 1
            return True
        if not blocking or timeout is not None:
            return False
        raise _one_thread("Semaphore.acquire()")

    __enter__ = acquire

    def release(self, n=1):
        if n < 1:
            raise ValueError('n must be one or more')
        self._value += n

    def __exit__(self, t, v, tb):
        self.release()


class BoundedSemaphore(Semaphore):

    def __init__(self, value=1):
        super().__init__(value)
        self._initial_value = value

    def release(self, n=1):
        if n < 1:
            raise ValueError('n must be one or more')
        if self._value + n > self._initial_value:
            raise ValueError("Semaphore released too many times")
        self._value += n


class Event:

    def __init__(self):
        self._flag = False

    def __repr__(self):
        status = 'set' if self._flag else 'unset'
        return f"<{type(self).__module__}.{type(self).__qualname__} at {id(self):#x}: {status}>"

    def is_set(self):
        return self._flag

    def set(self):
        self._flag = True

    def clear(self):
        self._flag = False

    def wait(self, timeout=None):
        if self._flag:
            return True
        if timeout is None:
            raise _one_thread("Event.wait()")
        return False


class BrokenBarrierError(RuntimeError):
    pass


class Barrier:

    def __init__(self, parties, action=None, timeout=None):
        if parties < 1:
            raise ValueError("parties must be >= 1")
        self._parties = parties
        self._action = action
        self._timeout = timeout
        self._broken = False

    def wait(self, timeout=None):
        if self._broken:
            raise BrokenBarrierError
        if self._parties == 1:
            if self._action:
                self._action()
            return 0
        raise _one_thread("Barrier.wait()")

    def reset(self):
        self._broken = False

    def abort(self):
        self._broken = True

    @property
    def parties(self):
        return self._parties

    @property
    def n_waiting(self):
        return 0

    @property
    def broken(self):
        return self._broken


_counter = 0


def _newname(name_template):
    global _counter
    _counter += 1
    return name_template % _counter


class Thread:

    _initialized = False

    def __init__(self, group=None, target=None, name=None,
                 args=(), kwargs=None, *, daemon=None, context=None):
        assert group is None, "group argument must be None for now"
        if kwargs is None:
            kwargs = {}
        if name:
            name = str(name)
        else:
            name = _newname("Thread-%d")
            if target is not None:
                try:
                    name += f" ({target.__name__})"
                except AttributeError:
                    pass
        self._target = target
        self._name = name
        self._args = args
        self._kwargs = kwargs
        self._daemonic = bool(daemon) if daemon is not None else current_thread().daemon
        self._ident = None
        self._native_id = None
        self._started = False
        self._initialized = True

    def __repr__(self):
        status = "started" if self._started else "initial"
        if self._daemonic:
            status += " daemon"
        if self._ident is not None:
            status += " %s" % self._ident
        return "<%s(%s, %s)>" % (self.__class__.__name__, self._name, status)

    def start(self):
        if not self._initialized:
            raise RuntimeError("thread.__init__() not called")
        if self._started:
            raise RuntimeError("threads can only be started once")
        raise RuntimeError("can't start new thread")

    def run(self):
        try:
            if self._target is not None:
                self._target(*self._args, **self._kwargs)
        finally:
            del self._target, self._args, self._kwargs

    def join(self, timeout=None):
        if not self._initialized:
            raise RuntimeError("Thread.__init__() not called")
        if not self._started:
            raise RuntimeError("cannot join thread before it is started")
        if self is current_thread():
            raise RuntimeError("cannot join current thread")

    @property
    def name(self):
        return self._name

    @name.setter
    def name(self, name):
        self._name = str(name)

    @property
    def ident(self):
        return self._ident

    @property
    def native_id(self):
        return self._native_id

    def is_alive(self):
        return self._started

    @property
    def daemon(self):
        return self._daemonic

    @daemon.setter
    def daemon(self, daemonic):
        if self._started:
            raise RuntimeError("cannot set daemon status of active thread")
        self._daemonic = daemonic

    def isDaemon(self):
        return self.daemon

    def setDaemon(self, daemonic):
        self.daemon = daemonic

    def getName(self):
        return self.name

    def setName(self, name):
        self.name = name


class Timer(Thread):

    def __init__(self, interval, function, args=None, kwargs=None):
        Thread.__init__(self)
        self.interval = interval
        self.function = function
        self.args = args if args is not None else []
        self.kwargs = kwargs if kwargs is not None else {}
        self.finished = Event()

    def cancel(self):
        self.finished.set()

    def run(self):
        if not self.finished.is_set():
            self.function(*self.args, **self.kwargs)
        self.finished.set()


class _MainThread(Thread):

    def __init__(self):
        Thread.__init__(self, name="MainThread", daemon=False)
        self._started = True
        self._ident = get_ident()
        self._native_id = get_native_id()


_main_thread = None


def current_thread():
    return _main_thread


def main_thread():
    return _main_thread


def active_count():
    return 1


def enumerate():
    return [_main_thread]


_main_thread = _MainThread()


class ExceptHookArgs:
    __slots__ = ('exc_type', 'exc_value', 'exc_traceback', 'thread')

    def __init__(self, exc_type, exc_value, exc_traceback, thread):
        self.exc_type = exc_type
        self.exc_value = exc_value
        self.exc_traceback = exc_traceback
        self.thread = thread


def excepthook(args, /):
    if args.exc_type == SystemExit:
        return
    name = args.thread.name if args.thread is not None else get_ident()
    print(f"Exception in thread {name}:", file=_sys.stderr)
    _sys.excepthook(args.exc_type, args.exc_value, args.exc_traceback)


__excepthook__ = excepthook


class local:
    """Thread-local data: with one thread, an object's own attributes."""

    def __new__(cls, /, *args, **kw):
        if (args or kw) and (cls.__init__ is object.__init__):
            raise TypeError("Initialization arguments are not supported")
        return object.__new__(cls)
