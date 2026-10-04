"""weakref on top of _weakref (JS WeakRef).  Callbacks and finalizers run
some time after the referent is collected by the JS engine."""

from _weakref import ref, ReferenceType, getweakrefcount

__all__ = ["ref", "ReferenceType", "finalize", "WeakValueDictionary", "WeakKeyDictionary", "WeakSet", "proxy"]


class finalize:
    def __init__(self, obj, func, /, *args, **kwargs):
        self._info = (func, args, kwargs)
        self._obj = ref(obj, self._collected)
        self.atexit = True

    def _collected(self, _r):
        self()

    def __call__(self, _=None):
        info = self._info
        if info is None:
            return None
        self._info = None
        func, args, kwargs = info
        return func(*args, **kwargs)

    def detach(self):
        info = self._info
        obj = self._obj()
        if info is None or obj is None:
            return None
        self._info = None
        return (obj, info[0], info[1], info[2])

    def peek(self):
        info = self._info
        obj = self._obj()
        if info is None or obj is None:
            return None
        return (obj, info[0], info[1], info[2])

    @property
    def alive(self):
        return self._info is not None

    def __repr__(self):
        return "<finalize object at %#x>" % id(self)


def proxy(obj, callback=None):
    return obj


class WeakValueDictionary(dict):
    pass


class WeakKeyDictionary(dict):
    pass


class WeakSet(set):
    pass
