"""The PNG engine's memory ledger (PNG plan r8 section 2.1; #157 simpler
path r10: its state as one immutable image).

One ledger per runtime, used only by the PNG engine's calls (render and
decode, and savefig and imread through them).  Every figure is in bytes.

The admission figure is D0's, exactly: F0 = effective_guard_bytes(capacity())
(lib/_capacity.py), read fresh at the start of every call; heap_figure() is
never read here.  Where D0 can see no remaining memory, F0 is the figure the
user states in SAGEBRUSH_MEMORY_BYTES, if any, and otherwise every call is
refused (fail closed).

Charges are records, each with its own identity:

- active: the running call's host buffers ("host") and the engine's grant
  ("engine");
- standing: the warm engine process's limit, less what a fresh observation
  saw of it resident (a domain the observation covers);
- resident: a call's outputs (and the like) in a memory domain; absorbed by
  an observation that covers its domain, else kept until its owner is
  released (the release log, swept here).

The ledger's whole state is ONE immutable image (_State): the records as a
persistent AVL tree keyed (kind, domain, id), each node carrying its
subtree's charge sum (so held() is the root's sum), the standing record's
key, F0, overdrawn, the applied transaction ids of the calls in flight, the
observation being absorbed (its remaining snapshot) and the release log's
committed cursor.  A transaction builds a new image from the current one
(pure: nothing is changed while it builds, so an exception anywhere in it
leaves the current image whole), checks it, and commits it with one store
(self._state = new) under the ledger lock.  Every change of a call costs
O(k log n) for the k records it changes; nothing copies the whole record
set.

A call (lib's _sbraster through the native call frame, #157):
1. holds the call lock;
2. re-bases: finishes any absorption left by an earlier call, sweeps the
   release log, takes the current records as the snapshot S, observes,
   publishes the observation (S as its remaining set) in one commit, absorbs
   from S in chunks (each a commit: a record is absorbed only if it is a
   resident of a domain the observation covers and the same object as in
   S), then concludes: the standing charge, and F0 or the refusal;
3. is admitted (host reservation and engine grant, one commit);
4. ends in one commit (the grant replaced by the standing charge, outputs
   made resident out of the host reservation, the rest refunded) or rolls
   back (host and grant dropped).

The invariant, held <= F0 while admitting (and no active charge without
F0), is checked on every image before it is committed (_check).

A resident record with an owner (an object CPython can reference weakly)
is released through the release log when its owner is collected: the log
records (seq, key); a sweep reads a batch from the image's cursor, removes
the keys still present (credited once), commits with the cursor advanced,
and only then acknowledges the batch.
"""

import sys as _sys
try:
    import _thread
except ImportError:  # (a runtime without threads: one caller)
    _thread = None
import _capacity
try:
    import itertools as _itertools
except ImportError:  # (a runtime without it: one caller, no threads)
    _itertools = None

LIVE, ABSORBED, RELEASED = "live", "absorbed", "released"
ACTIVE = ("host", "engine")
# (the batch an absorption chunk or a sweep handles per commit: a performance
# figure only; any work is interruptible between bytecodes, the current image
# staying whole)
CHUNK = 1024

UNKNOWN = ("Not enough memory for this computation.\n"
           "Sagebrush can't see how much memory is free here, so it doesn't start PNG work.\n"
           "To run it, set SAGEBRUSH_MEMORY_BYTES to the bytes Sagebrush may use for it.")


class Record:
    """A charge: its id, kind ("host", "engine", "standing", "resident"),
    memory domain (_capacity.DOMAINS) and bytes, all immutable.  Whether it
    is charged is the image's (present or not); `state` is a diagnostic set
    once when the record leaves the ledger."""

    __slots__ = ("id", "kind", "domain", "bytes", "_fate")

    def __init__(self, id, kind, domain, nbytes):
        object.__setattr__(self, "id", id)
        object.__setattr__(self, "kind", kind)
        object.__setattr__(self, "domain", domain)
        object.__setattr__(self, "bytes", int(nbytes))
        object.__setattr__(self, "_fate", None)

    def __setattr__(self, name, value):
        raise AttributeError("a ledger record is immutable")

    @property
    def key(self):
        return (self.kind, self.domain, self.id)

    @property
    def state(self):
        return self._fate or LIVE

    def _left(self, fate):
        # (diagnostic, after the commit that removed it)
        if self._fate is None:
            object.__setattr__(self, "_fate", fate)

    def __repr__(self):
        return "Record(%d, %s, %s, %d, %s)" % (self.id, self.kind, self.domain, self.bytes, self.state)


# ---------------------------------------------------------------- the tree
# A persistent AVL tree: nodes are never changed once made; an insert or a
# delete makes new nodes along one path (and its rotations), sharing the rest.

class _Node:
    __slots__ = ("k", "r", "l", "g", "h", "s")


def _h(n):
    return n.h if n is not None else 0


def _s(n):
    return n.s if n is not None else 0


def _mk(k, r, l, g):
    n = _Node()
    n.k, n.r, n.l, n.g = k, r, l, g
    hl, hg = _h(l), _h(g)
    n.h = (hl if hl > hg else hg) + 1
    n.s = r.bytes + _s(l) + _s(g)
    return n


def _bal(k, r, l, g):
    hl, hg = _h(l), _h(g)
    if hl > hg + 1:
        if _h(l.l) >= _h(l.g):
            return _mk(l.k, l.r, l.l, _mk(k, r, l.g, g))
        m = l.g
        return _mk(m.k, m.r, _mk(l.k, l.r, l.l, m.l), _mk(k, r, m.g, g))
    if hg > hl + 1:
        if _h(g.g) >= _h(g.l):
            return _mk(g.k, g.r, _mk(k, r, l, g.l), g.g)
        m = g.l
        return _mk(m.k, m.r, _mk(k, r, l, m.l), _mk(g.k, g.r, m.g, g.g))
    return _mk(k, r, l, g)


def _ins(n, k, r):
    if n is None:
        return _mk(k, r, None, None)
    if k < n.k:
        return _bal(n.k, n.r, _ins(n.l, k, r), n.g)
    if n.k < k:
        return _bal(n.k, n.r, n.l, _ins(n.g, k, r))
    return _mk(k, r, n.l, n.g)


def _del(n, k):
    if n is None:
        return None
    if k < n.k:
        return _bal(n.k, n.r, _del(n.l, k), n.g)
    if n.k < k:
        return _bal(n.k, n.r, n.l, _del(n.g, k))
    if n.l is None:
        return n.g
    if n.g is None:
        return n.l
    m = n.g
    while m.l is not None:
        m = m.l
    return _bal(m.k, m.r, n.l, _del(n.g, m.k))


def _get(n, k):
    while n is not None:
        if k < n.k:
            n = n.l
        elif n.k < k:
            n = n.g
        else:
            return n.r
    return None


def _first(n, count):
    """The first `count` (key, record) pairs, in key order."""
    out, stack = [], []
    while (stack or n is not None) and len(out) < count:
        while n is not None:
            stack.append(n)
            n = n.l
        n = stack.pop()
        out.append((n.k, n.r))
        n = n.g
    return out


def _ge_sum(n, lo):
    t = 0
    while n is not None:
        if lo <= n.k:
            t += n.r.bytes + _s(n.g)
            n = n.l
        else:
            n = n.g
    return t


def _lt_sum(n, hi):
    t = 0
    while n is not None:
        if n.k < hi:
            t += n.r.bytes + _s(n.l)
            n = n.g
        else:
            n = n.l
    return t


def _range_sum(n, lo, hi):
    """The charges of the keys k with lo <= k < hi."""
    while n is not None:
        if n.k < lo:
            n = n.g
        elif hi <= n.k:
            n = n.l
        else:
            return n.r.bytes + _ge_sum(n.l, lo) + _lt_sum(n.g, hi)
    return 0


def _domain_range(kind, domain):
    return (kind, domain), (kind, domain + "\x00")


# ---------------------------------------------------------------- the image

class _Obs:
    """An observation being absorbed: its id, F0, the domains it certifies,
    what is left of its snapshot, and the standing figure it computed."""

    __slots__ = ("id", "f0", "domains", "remaining", "standing")

    def __init__(self, id, f0, domains, remaining, standing):
        self.id, self.f0, self.domains, self.remaining, self.standing = id, f0, domains, remaining, standing


class _State:
    __slots__ = ("records", "standing", "f0", "overdrawn", "applied", "obs", "rel", "active")

    def __init__(self, records, standing, f0, overdrawn, applied, obs, rel, active):
        self.records, self.standing, self.f0, self.overdrawn = records, standing, f0, overdrawn
        self.applied, self.obs, self.rel, self.active = applied, obs, rel, active

    def but(self, **kw):
        s = _State(self.records, self.standing, self.f0, self.overdrawn, self.applied, self.obs, self.rel, self.active)
        for k, v in kw.items():
            setattr(s, k, v)
        return s


def _check(st):
    """The invariant (r8 section 2.1) on an image, before it is committed:
    while admitting, held <= F0; without F0, no active charge."""
    held = _s(st.records)
    if st.f0 is not None:
        if held > st.f0:
            raise RuntimeError("the PNG ledger holds %d bytes, more than F0 = %d (a Sagebrush bug)" % (held, st.f0))
    elif st.active:
        raise RuntimeError("the PNG ledger has an active charge without an admission figure (a Sagebrush bug)")


def _overdraw(st):
    # (a charge past F0 outside an admission: nothing more admitted until an
    # observation covers it)
    if st.f0 is not None and _s(st.records) > st.f0:
        return st.but(f0=None, overdrawn=True)
    return st


def _add(st, r):
    return st.but(records=_ins(st.records, r.key, r), active=st.active + (r.kind in ACTIVE))


def _drop(st, key, rec=None):
    """st without key (only if it holds rec, when given); (image, removed)."""
    r = _get(st.records, key)
    if r is None or (rec is not None and r is not rec):
        return st, None
    return st.but(records=_del(st.records, key), active=st.active - (r.kind in ACTIVE)), r


# ---------------------------------------------------------------- release log

class _PyReleaseLog:
    """The release log where the native one (_raster.ReleaseLog) isn't
    available (pyjs, whose Ctrl-C is raised only at loop polls).  track()
    registers a weak reference whose callback stores the key under the next
    sequence number (one dict store); peek() reads from a sequence number;
    ack() pops what an image has committed, one entry at a time, so a retry
    after an interruption pops the rest (idempotent) and nothing committed
    stays, nothing uncommitted goes."""

    def __init__(self):
        self._q = {}
        self._acked = 0
        self._seq = _itertools.count(0) if _itertools else None
        self._n = 0
        self._tracked = {}

    def _next(self):
        if self._seq is not None:
            return next(self._seq)
        self._n += 1
        return self._n - 1

    def track(self, owner, key):
        import weakref
        wr = self._tracked.get(key)
        if wr is not None and wr() is not None:
            return
        q, tracked, nxt = self._q, self._tracked, self._next

        def gone(_wr, key=key):
            q[nxt()] = key
            tracked.pop(key, None)
        self._tracked[key] = weakref.ref(owner, gone)

    def peek(self, frm, count):
        out, q = [], self._q
        s = max(frm, self._acked)
        while len(out) < count and s in q:
            out.append((s, q[s]))
            s += 1
        return out

    def ack(self, upto):
        q = self._q
        s = self._acked
        while s < upto:
            q.pop(s, None)
            s += 1
        if upto > self._acked:
            self._acked = upto

    def tracked(self):
        return len(self._tracked)

    def pending(self):
        return len(self._q)


def _release_log():
    try:
        from sagebrush._native import raster as _r
        return _r.ReleaseLog()
    except (ImportError, AttributeError):
        return _PyReleaseLog()


def _python_locked_call(lock, fn):
    # (pyjs: Ctrl-C is raised only at loop polls, so `with` has no seam)
    with lock:
        return fn()


def _native_locked_call():
    """The native frame that takes a C lock, runs fn and releases it in a
    Rust guard (#157: on CPython 3.9 and 3.14 `with lock:` itself can leave
    the lock held when a KeyboardInterrupt lands between the acquire and the
    statement's cleanup range).  None where the package's native module
    isn't there (pyjs)."""
    try:
        from sagebrush._native import raster as _r
        return _r.locked_call
    except (ImportError, AttributeError):
        return None


class _NoLock:
    def acquire(self, blocking=True, timeout=-1):
        return True

    def release(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class NeedReap(Exception):
    """Raised by rebase(): what survives doesn't fit, and a warm engine
    process holds memory: the caller ends it (without the ledger lock) and
    re-bases once."""


def _memguard():
    import _memguard
    return _memguard


class Ledger:
    """The ledger.  capacity, for tests: a function returning a D0 record
    (default _capacity.capacity); environ: where SAGEBRUSH_MEMORY_BYTES is
    read (default os.environ); log: the release log (default the native
    one, else _PyReleaseLog)."""

    KEEP = object()

    def __init__(self, capacity=None, environ=None, log=None, locked_call=None):
        self._capacity = capacity or _capacity.capacity
        self._environ = environ
        self._lock = _thread.allocate_lock() if _thread else _NoLock()
        self.call_lock = _thread.allocate_lock() if _thread else _NoLock()
        self._locked_call = locked_call or _native_locked_call() or _python_locked_call
        # (ids: one C-level call each, no lock)
        self._ids = _itertools.count(1) if _itertools else None
        self._n = 0
        self._state = _State(None, None, None, False, frozenset(), None, 0, 0)
        self._log = log if log is not None else _release_log()
        self.last = None         # the last observation (metadata only)
        self.gen = 0             # observations made (metadata only)
        self.child_rss = 0       # the engine process's resident bytes, as the last re-base read them

    # ------------------------------------------------------------ the image

    def new_id(self):
        """A fresh record or transaction id."""
        if self._ids is not None:
            return next(self._ids)
        self._n += 1
        return self._n

    def _commit(self, build):
        """build(current image) -> (new image, result); the new image checked
        and committed with one store, under the ledger lock (taken and
        released by the native frame)."""
        def txn():
            cur = self._state
            new, out = build(cur)
            if new is not cur:
                _check(new)
                self._state = new
            return out
        return self._locked_call(self._lock, txn)

    def _read(self, fn):
        """fn(current image), under the ledger lock; nothing of the image
        may escape fn but plain values (astra2's r10 note)."""
        return self._locked_call(self._lock, lambda: fn(self._state))

    def held(self):
        return _s(self._state.records)

    @property
    def f0(self):
        return self._state.f0

    @property
    def overdrawn(self):
        return self._state.overdrawn

    @property
    def records(self):
        """Every charged record, in key order (a list: a copy)."""
        st = self._state
        return [r for _, r in _first(st.records, 1 << 62)]

    @property
    def standing(self):
        st = self._state
        return _get(st.records, st.standing) if st.standing is not None else None

    def room(self):
        st = self._state
        return 0 if st.f0 is None else max(0, st.f0 - _s(st.records))

    def applied(self, txn):
        return txn in self._state.applied

    def pending_releases(self):
        return self._log.pending()

    # ------------------------------------------------------------ records

    def reserve(self, kind, domain, nbytes, rid=None, txn=None):
        """An active charge of exactly nbytes, or the memory refusal."""
        rid = rid if rid is not None else self.new_id()
        r = Record(rid, kind, domain, nbytes)

        def build(st):
            if txn is not None and txn in st.applied:
                return st, _get(st.records, r.key)
            room = 0 if st.f0 is None else max(0, st.f0 - _s(st.records))
            if r.bytes > room:
                raise _memguard().memory_guard("A PNG", r.bytes, room, "PNG work")
            st = _add(st, r)
            if txn is not None:
                st = st.but(applied=st.applied | {txn})
            return st, r
        return self._commit(build)

    def grant(self, domain, rid=None):
        """The engine's grant: everything that remains, exclusively."""
        rid = rid if rid is not None else self.new_id()

        def build(st):
            room = 0 if st.f0 is None else max(0, st.f0 - _s(st.records))
            r = Record(rid, "engine", domain, room)
            return _add(st, r), r
        return self._commit(build)

    def admit(self, txn, host_id, host_bytes, engine_id, engine_domain, host_domain="cpython-heap"):
        """A call's admission in one commit: the host reservation (exactly
        host_bytes, or the memory refusal) and the engine's grant (all the
        rest).  Already applied (a retry): the records as committed."""
        hkey = ("host", host_domain, host_id)
        ekey = ("engine", engine_domain, engine_id)

        def build(st):
            if txn in st.applied:
                return st, (_get(st.records, hkey), _get(st.records, ekey))
            room = 0 if st.f0 is None else max(0, st.f0 - _s(st.records))
            if host_bytes > room:
                raise _memguard().memory_guard("A PNG", int(host_bytes), room, "PNG work")
            h = Record(host_id, "host", host_domain, host_bytes)
            e = Record(engine_id, "engine", engine_domain, room - h.bytes)
            st = _add(_add(st, h), e)
            return st.but(applied=st.applied | {txn}), (h, e)
        return self._commit(build)

    def release(self, record):
        def build(st):
            return _drop(st, record.key, record)
        r = self._commit(build)
        if r is not None:
            r._left(RELEASED)

    def set_standing(self, nbytes, domain="child"):
        """The engine process's standing charge (its whole limit, until an
        observation sees some of it resident), or none (nbytes None: it has
        been reaped)."""
        rid = self.new_id()

        def build(st):
            old = None
            if st.standing is not None:
                st, old = _drop(st, st.standing)
                st = st.but(standing=None)
            if nbytes is not None:
                r = Record(rid, "standing", domain, nbytes)
                st = _add(st, r).but(standing=r.key)
            return _overdraw(st), old
        old = self._commit(build)
        if old is not None:
            old._left(RELEASED)

    def resident(self, nbytes, domain, owner=None):
        """A resident charge (an output), absorbed by the next observation
        covering its domain; with owner, released when owner is collected
        (an owner that can't be referenced weakly is the caller's error:
        TypeError, before anything is charged)."""
        if owner is not None:
            import weakref
            weakref.ref(owner)
        r = Record(self.new_id(), "resident", domain, nbytes)
        # (tracked BEFORE the commit: an interruption between leaves a tracked
        # owner without a record, whose release is then skipped, never a
        # record whose owner nobody tracks; the caller holds owner meanwhile,
        # so its release can't come before the record)
        if owner is not None:
            self._log.track(owner, r.key)

        def build(st):
            return _overdraw(_add(st, r)), r
        self._commit(build)
        return r

    def end_call(self, host, engine, standing=KEEP, outputs=(), txn=None, out_ids=None):
        """A call's end, in one commit (r8 section 2.1, step 6): the engine's
        grant (engine, or None) replaced by its standing charge (bytes; None:
        the process was reaped; KEEP: unchanged), at most the standing record
        it had plus the grant; each output, (bytes, domain, owner), made a
        resident record out of the host reservation; the host reservation's
        rest refunded.  Outputs past what was reserved leave the ledger
        overdrawn.  txn: the transaction id (a retry after it was applied
        changes nothing); out_ids: the outputs' record ids, chosen before.
        Returns the resident records (their owners then tracked)."""
        if out_ids is None:
            out_ids = [self.new_id() for _ in outputs]
        srid = self.new_id() if standing is not Ledger.KEEP and standing is not None else None
        outs = [Record(i, "resident", d, n) for i, (n, d, o) in zip(out_ids, outputs)]
        # (each owner tracked BEFORE the commit, as in resident(); a retry
        # tracks again, a no-op while the owner is tracked)
        for r, (n, d, o) in zip(outs, outputs):
            if o is not None:
                self._log.track(o, r.key)

        def build(st):
            if txn is not None and txn in st.applied:
                return st, ([_get(st.records, r.key) for r in outs], [])
            gone = []
            old_standing = _get(st.records, st.standing) if st.standing is not None else None
            if engine is not None:
                st, e = _drop(st, engine.key, engine)
                gone.append(e)
            if standing is not Ledger.KEEP:
                new = None
                if standing is not None:
                    cap = (old_standing.bytes if old_standing is not None else 0) + (engine.bytes if engine is not None else 0)
                    new = max(0, min(int(standing), cap))
                if old_standing is not None:
                    st, s = _drop(st, old_standing.key, old_standing)
                    gone.append(s)
                st = st.but(standing=None)
                if new is not None:
                    r = Record(srid, "standing", "child", new)
                    st = _add(st, r).but(standing=r.key)
            if host is not None:
                st, hh = _drop(st, host.key, host)
                gone.append(hh)
            for r in outs:
                st = _add(st, r)
            st = _overdraw(st)
            if txn is not None:
                st = st.but(applied=st.applied | {txn})
            return st, (outs, gone)
        recs, gone = self._commit(build)
        for g in gone:
            if g is not None:
                g._left(RELEASED)
        return recs

    def rollback(self, txn, host, engine, reaped):
        """A failed call's records dropped in one commit (after its engine
        process, if reaped, was reaped): the host reservation and the grant;
        the standing charge too when the process was reaped."""
        def build(st):
            if txn in st.applied:
                return st, []
            gone = []
            for r in (host, engine):
                if r is not None:
                    st, x = _drop(st, r.key, r)
                    gone.append(x)
            if reaped and st.standing is not None:
                st, x = _drop(st, st.standing)
                gone.append(x)
                st = st.but(standing=None)
            return st.but(applied=st.applied | {txn}), gone
        for g in self._commit(build):
            if g is not None:
                g._left(RELEASED)

    def close(self, txns):
        """A call's transaction ids removed once it is settled (idempotent)."""
        txns = frozenset(txns)

        def build(st):
            if not (st.applied & txns):
                return st, None
            return st.but(applied=st.applied - txns), None
        self._commit(build)

    # ------------------------------------------------------------ the release log

    def sweep(self):
        """Every released owner's record removed, once: batches from the
        image's cursor, each committed with the cursor advanced, then
        acknowledged."""
        log = self._log
        while True:
            def build(st):
                batch = log.peek(st.rel, CHUNK)
                if not batch:
                    return st, (None, st.rel)
                gone = []
                for seq, key in batch:
                    if key[0] == "resident":
                        st, r = _drop(st, key)
                        if r is not None:
                            gone.append(r)
                return st.but(rel=batch[-1][0] + 1), (gone, batch[-1][0] + 1)
            gone, upto = self._commit(build)
            log.ack(upto)
            if gone is None:
                return
            for r in gone:
                r._left(RELEASED)

    def _sweep(self):
        # (the old name, for tests)
        self.sweep()

    # ------------------------------------------------------------ F0

    def _figure(self, rec):
        f = _capacity.effective_guard_bytes(rec)
        if f is not None:
            return f
        env = self._environ
        if env is None:
            try:
                import os
                env = os.environ
            except ImportError:
                env = {}
        v = env.get("SAGEBRUSH_MEMORY_BYTES")
        if v is not None:
            try:
                n = int(v)
            except ValueError:
                n = -1
            if n >= 0:
                return n
        return None

    def _absorb(self):
        """The observation's remaining snapshot absorbed, chunk by chunk
        (each a commit), to its end.  Returns the observation (now without
        a remaining set), or None if there was none."""
        while True:
            def build(st):
                o = st.obs
                if o is None:
                    return st, (None, None)
                if st.active:
                    raise RuntimeError("the PNG ledger absorbs with a call active (a Sagebrush bug)")
                if o.remaining is None:
                    return st, (o, None)
                recs, rem, gone = st.records, o.remaining, []
                for k, r in _first(rem, CHUNK):
                    if k[0] == "resident" and k[1] in o.domains and _get(recs, k) is r:
                        recs = _del(recs, k)
                        gone.append(r)
                    rem = _del(rem, k)
                return st.but(records=recs, obs=_Obs(o.id, o.f0, o.domains, rem, o.standing)), (o, gone)
            o, gone = self._commit(build)
            if gone is None:
                return o
            for r in gone:
                r._left(ABSORBED)

    def rebase(self, child=None):
        """Step 2 of a call (no active charge: the call lock is held).
        child: None, or a function returning the engine process's
        (limit, rss) in bytes now.  Returns the headroom F0' - held after
        the transition; raises NeedReap, or the memory refusal (unknown
        memory, or overdrawn)."""
        # (an earlier observation's absorption, interrupted: finished first)
        if self._absorb() is not None:
            self._commit(lambda st: (st.but(obs=None), None))
        self.sweep()
        def snap(st):
            if st.active:
                raise RuntimeError("the PNG ledger re-based with a call active")
            return st.records, (_get(st.records, st.standing) if st.standing is not None else None)
        S, old_standing = self._read(snap)
        rec = self._capacity()
        self.last = rec
        self.gen += 1
        f = self._figure(rec)
        if f is None:
            # (nothing cleared: every record and the prior state stay)
            S = None
            mg = _memguard()
            raise mg.SagebrushMemoryError(UNKNOWN, "A PNG", 0, 0, "PNG work")
        domains = frozenset(rec.get("domains") or ())
        standing = None
        self.child_rss = 0
        if old_standing is not None:
            if child is not None:
                limit, rss = child()
                self.child_rss = rss if "child" in domains else 0
                standing = limit - self.child_rss
            else:
                standing = old_standing.bytes
        oid = self.new_id()
        obs = _Obs(oid, f, domains, S, standing)
        S = None
        # (published in one commit: no admission while it is absorbed)
        self._commit(lambda st: (st.but(obs=obs, f0=None), None))
        obs = None
        self._absorb()
        srid = self.new_id()

        def conclude(st):
            o = st.obs
            if o is None or o.id != oid:
                raise RuntimeError("the PNG ledger's observation was replaced (a Sagebrush bug)")
            sr = _get(st.records, st.standing) if st.standing is not None else None
            survivors = _s(st.records) - (sr.bytes if sr is not None else 0) + (o.standing if o.standing is not None else 0)
            if survivors <= o.f0:
                gone = None
                if sr is not None and o.standing is not None:
                    st, gone = _drop(st, sr.key, sr)
                    r = Record(srid, "standing", sr.domain, max(0, o.standing))
                    st = _add(st, r).but(standing=r.key)
                st = st.but(obs=None, f0=o.f0, overdrawn=False)
                return st, ("ok", o.f0 - _s(st.records), gone)
            if sr is not None:
                return st.but(obs=None, f0=None), ("reap", survivors, None)
            return st.but(obs=None, f0=None, overdrawn=True), ("overdrawn", survivors, None)
        what, n, gone = self._commit(conclude)
        if gone is not None:
            gone._left(RELEASED)
        if what == "ok":
            return n
        if what == "reap":
            raise NeedReap()
        raise _memguard().memory_guard(
            "Memory from an earlier PNG engine instance not yet released by the runtime", n, f, "PNG work")

    # ------------------------------------------------------------ tests only

    def _inject_for_test(self, record):
        """A record put straight into the image, unchecked (tests of _check)."""
        def put():
            self._state = _add(self._state, record)
        self._locked_call(self._lock, put)

    def _remove_for_test(self, record):
        def take():
            self._state = _drop(self._state, record.key, record)[0]
        self._locked_call(self._lock, take)


_ledger = None


def ledger():
    """This runtime's ledger."""
    global _ledger
    if _ledger is None:
        _ledger = Ledger()
    return _ledger
