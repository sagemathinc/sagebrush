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


class _Session:
    """A Sage-mode session namespace's names that aren't loaded yet.  The
    runtime asks it when a global load misses in that namespace (_miss) and
    tells it of ``del name`` there (_delete); only a session's namespace has
    one (session()), never a library module's."""

    __slots__ = ("_ns", "_names", "_dead")

    def __init__(self, ns, names, dead=()):
        self._ns = ns
        self._names = names
        self._dead = set(dead)

    def _has(self, name):
        # (a name a use would load: one of sage_all's, not deleted; bound or not)
        return name in self._names and name not in self._dead

    def _miss(self, name):
        # (a name the session deleted, or none of sage_all's: no such name, the NameError, said by returning the
        # session itself, never by an exception, which a domain's import could raise too; a domain that fails to
        # import raises its own error, whatever it is, and nothing is bound, so the next use tries again)
        if name in self._dead or name not in self._names:
            return self
        import sage_all
        value = getattr(sage_all, name)
        self._ns[name] = value
        return value

    def _unloaded(self):
        # (dir() at the session's top level lists these too: a use would load them)
        return [n for n in self._names if n not in self._ns and n not in self._dead]

    def _delete(self, name):
        # (`del name`: deleted for good, a later use a NameError, not loaded again; True when the name is one of
        # sage_all's the session hasn't used yet, which deletes as a bound one does)
        if name not in self._names:
            return False
        unloaded = name not in self._dead and name not in self._ns
        self._dead.add(name)
        return unloaded


def session(ns):
    """Make ns a Sage-mode session namespace: sage_all's names (its
    ``__all__``, what ``from sage_all import *`` binds).  In pyjs the names
    sage_all's own start loaded are bound now and every other one is loaded
    the first time it's used, with its domain (lib/_sage_names.py); elsewhere,
    all of them now.

    EXAMPLES::

        sage: from _sage_lazy import session
        sage: ns = {}
        sage: session(ns)
        sage: ns["ZZ"]
        Integer Ring
    """
    import builtins
    import sage_all
    # (the index, which a first use reads: loaded with the session, not fetched then)
    import _sage_names  # noqa: F401
    hook = getattr(builtins, "__pyjs_lazy_namespace__", None)
    names = tuple(sage_all.__all__)
    loaded = sage_all.__dict__
    for name in names:
        if hook is None:
            ns[name] = getattr(sage_all, name)
        elif name in loaded:
            ns[name] = loaded[name]
    if hook is not None:
        hook(ns, _Session(ns, frozenset(names)))
    # (and a session for LazyImport's stubs, a user's lazy_import's: one resolved is rebound here too)
    bind(ns)


def _session_of(ns):
    import builtins
    hook = getattr(builtins, "__pyjs_lazy_namespace__", None)
    return None if hook is None else hook(ns)


def session_copy(src, dst=None, skip=()):
    """Copy namespace src's names into dst (a new dict if None), except
    those in skip, and return dst.  A copy of a session's namespace is a
    session too: a Sage name src hasn't loaded yet loads in the copy at its
    first use there, and one deleted in src stays deleted.  The library's
    copies of the session (an interact input box's, a board check's) use it.

    EXAMPLES::

        sage: from _sage_lazy import session, session_copy
        sage: ns = {}
        sage: session(ns)
        sage: c = session_copy(ns)
        sage: eval("ZZ", c)
        Integer Ring
    """
    if dst is None:
        dst = {}
    for k, v in list(src.items()):
        if k not in skip:
            dst[k] = v
    s = _session_of(src)
    if s is not None:
        import builtins
        builtins.__pyjs_lazy_namespace__(dst, _Session(dst, s._names, s._dead))
    return dst


def lazy_has(ns, name):
    """Whether a use of name in namespace ns would load it: one of the Sage
    names its session hasn't loaded yet (or has).  False for a namespace
    that isn't a session's."""
    s = _session_of(ns)
    return s is not None and s._has(name)

