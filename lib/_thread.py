"""_thread for a single-threaded runtime: locks that never contend."""

error = RuntimeError
TIMEOUT_MAX = 2 ** 31


class LockType:
    def __init__(self):
        self._count = 0

    def acquire(self, blocking=True, timeout=-1):
        self._count += 1
        return True

    acquire_lock = acquire

    def release(self):
        if self._count == 0:
            raise RuntimeError("release unlocked lock")
        self._count -= 1

    release_lock = release

    def locked(self):
        return self._count > 0

    def __enter__(self):
        return self.acquire()

    def __exit__(self, *a):
        self.release()


lock = LockType
RLock = LockType


def allocate_lock():
    return LockType()


def get_ident():
    return 1


get_native_id = get_ident


def start_new_thread(function, args, kwargs={}):
    raise RuntimeError("threads are not supported in pyjs")


def _count():
    return 0


def stack_size(size=0):
    return 0
