"""Lazy imports, as Sage's sage.misc.lazy_import: a name that imports its
module on first use (plan-sage-lazy-chunks r2, section 3).

lazy_import(module, names, namespace) puts a LazyImport stub in namespace
for each name.  Installing a stub, or copying it (``from sage_all import
*``), imports nothing.  The first real use (a call, an attribute, repr, the
docs, a comparison or hash, iteration, isinstance/issubclass with the stub
as the class, subclassing, copy or pickle) imports the module, takes the
attribute, and then rebinds the name to the real object in the namespace it
was installed in and in each session namespace given to bind(), but only
where that slot still holds this stub: a user's own assignment is never
overwritten.  A stub saved under another name before that (P = Partitions)
stays a stub that delegates, so `P is Partitions` is False afterwards.

Before resolution type(stub) is LazyImport, and a stub as the first
argument of issubclass is not a class (TypeError).  A failed import or
attribute raises its own error and caches nothing; the next use tries
again.  bind() keeps the newest _KEEP session namespaces (a dict can't be
weakly referenced); an older session's stubs still work, by delegation."""

import sys as _sys

_UNSET = object()
_KEEP = 16
_SESSIONS = []


def _resolve(module, name):
    # (also what a pickled stub becomes: the real object)
    __import__(module)
    return getattr(_sys.modules[module], name)


class LazyImport:
    """A name whose module is imported on first use (see this module's
    documentation and lazy_import); a stub's __doc__ is its target's.

    EXAMPLES::

        sage: from _sage_lazy import LazyImport
        sage: d = LazyImport("_sage_lazy_fixture", "double", {})
        sage: type(d).__name__, d(21), d.__doc__
        ('LazyImport', 42, 'Twice x.')
    """

    __slots__ = ("_module", "_name", "_home", "_target", "_busy")

    def __init__(self, module, name, home):
        self._module = module
        self._name = name
        self._home = home
        self._target = _UNSET
        self._busy = False

    def _get(self):
        t = self._target
        if t is not _UNSET:
            return t
        if self._busy:
            raise RuntimeError("the lazy import of %s from %s refers to itself" % (self._name, self._module))
        self._busy = True
        try:
            t = _resolve(self._module, self._name)
        finally:
            self._busy = False
        self._target = t
        for ns in [self._home] + _SESSIONS:
            if ns.get(self._name) is self:
                ns[self._name] = t
        return t

    def __getattr__(self, attr):
        return getattr(self._get(), attr)

    def __getattribute__(self, attr):
        # (the class's __doc__ is its own text; a stub's is its target's)
        if attr == "__doc__":
            return object.__getattribute__(self, "_get")().__doc__
        return object.__getattribute__(self, attr)

    def __call__(self, *args, **kw):
        return self._get()(*args, **kw)

    def __repr__(self):
        return repr(self._get())

    def __str__(self):
        return str(self._get())

    def __eq__(self, other):
        return self._get() == other

    def __ne__(self, other):
        return self._get() != other

    def __hash__(self):
        return hash(self._get())

    def __iter__(self):
        return iter(self._get())

    def __len__(self):
        return len(self._get())

    def __contains__(self, v):
        return v in self._get()

    def __getitem__(self, k):
        return self._get()[k]

    def __instancecheck__(self, obj):
        return isinstance(obj, self._get())

    def __subclasscheck__(self, cls):
        return issubclass(cls, self._get())

    def __mro_entries__(self, bases):
        return (self._get(),)

    def __copy__(self):
        return self._get()

    def __deepcopy__(self, memo):
        return self._get()

    def __reduce__(self):
        # (resolves now: a missing target fails at serialization, and the
        # cache and the slots are as after any first use; unpickling then
        # gives the real object)
        self._get()
        return (_resolve, (self._module, self._name))

    def __reduce_ex__(self, protocol):
        return self.__reduce__()


def lazy_import(module, names, namespace):
    """Put a LazyImport stub in namespace for each of names (a name, or a
    list of names) from module.

    EXAMPLES::

        sage: from _sage_lazy import lazy_import
        sage: ns = {}
        sage: lazy_import("_sage_lazy_fixture", ["double"], ns)
        sage: type(ns["double"]).__name__, ns["double"](21), type(ns["double"]).__name__
        ('LazyImport', 42, 'function')
    """
    if isinstance(names, str):
        names = [names]
    for name in names:
        namespace[name] = LazyImport(module, name, namespace)


def bind(ns):
    """Register a session namespace (after ``from sage_all import *``): a
    stub resolved later is rebound there too, and one already resolved is
    rebound now.  The newest _KEEP namespaces are kept."""
    for i, old in enumerate(_SESSIONS):
        if old is ns:
            del _SESSIONS[i]
            break
    _SESSIONS.append(ns)
    del _SESSIONS[:-_KEEP]
    for k, v in list(ns.items()):
        if isinstance(v, LazyImport) and v._target is not _UNSET and v._name == k:
            ns[k] = v._target
