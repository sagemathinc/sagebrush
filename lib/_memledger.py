"""The PNG engine's memory ledger (PNG plan r8 section 2.1).

One ledger per runtime, used only by the PNG engine's calls (render and
decode, and savefig and imread through them).  Every figure is in bytes.

The admission figure is D0's, exactly: F0 = effective_guard_bytes(capacity())
(lib/_capacity.py), read fresh at the start of every call; heap_figure() is
never read here.  Where D0 can see no remaining memory, F0 is the figure the
user states in SAGEBRUSH_MEMORY_BYTES, if any, and otherwise every call is
refused (fail closed).

Charges are records, each with its own identity and state:

- active: the running call's host buffers and the engine's grant;
- standing: the warm engine process's limit, less what a fresh observation
  saw of it resident (a domain the observation covers);
- resident: a call's outputs (and the like) in a memory domain; absorbed by
  the next observation that covers its domain, else kept until its own
  release (a finalizer's flag, swept here).

A record's state is "live" (counted in held), "absorbed" or "released"; a
finalizer only sets record.finalized (one attribute store: no lock, no
allocation), and the sweep accounts for each record once, by its own state.
The observation number (gen) decides nothing.

A call:
1. holds the call lock (taken before anything is reserved);
2. re-bases: observes fresh, then, in the same critical section, absorbs the
   resident records the observation covers and recomputes the standing one;
   if what survives is more than F0', a warm engine process is reaped and
   the memory observed once more (the caller does that, without the ledger
   lock), and with nothing left to reap the ledger is overdrawn and refuses;
3. reserves its host buffers exactly, then is granted all that remains;
4. ends: the grant refunded, the engine's standing charge recomputed, the
   outputs made resident records.
"""

import sys as _sys
try:
    import _thread
except ImportError:  # (a runtime without threads: one caller)
    _thread = None
import _capacity

LIVE, ABSORBED, RELEASED = "live", "absorbed", "released"

UNKNOWN = ("Not enough memory for this computation.\n"
           "Sagebrush can't see how much memory is free here, so it doesn't start PNG work.\n"
           "To run it, set SAGEBRUSH_MEMORY_BYTES to the bytes Sagebrush may use for it.")


class Record:
    """A charge: its id, kind ("host", "engine", "standing", "resident"),
    memory domain (_capacity.DOMAINS), bytes and state; `finalized` is the
    only field a finalizer touches."""

    __slots__ = ("id", "kind", "domain", "bytes", "state", "finalized")

    def __init__(self, id, kind, domain, nbytes):
        self.id = id
        self.kind = kind
        self.domain = domain
        self.bytes = int(nbytes)
        self.state = LIVE
        self.finalized = False

    def __repr__(self):
        return "Record(%d, %s, %s, %d, %s)" % (self.id, self.kind, self.domain, self.bytes, self.state)


def _mark(record):
    """The finalizer: the record's flag, nothing more (r8 section 2.1)."""
    record.finalized = True


class _NoLock:
    def acquire(self, blocking=True, timeout=-1):
        return True

    def release(self):
        pass


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
    read (default os.environ)."""

    def __init__(self, capacity=None, environ=None):
        self._capacity = capacity or _capacity.capacity
        self._environ = environ
        self._lock = _thread.allocate_lock() if _thread else _NoLock()
        self.call_lock = _thread.allocate_lock() if _thread else _NoLock()
        self._ids = 0
        self.records = []        # every live record
        self._watched = []       # records with a finalizer, until swept
        self.f0 = None           # the published admission figure, or None
        self.overdrawn = False
        self.last = None         # the last observation (metadata only)
        self.gen = 0             # observations made (metadata only)
        self.standing = None     # the engine process's record, if any

    # ------------------------------------------------------------ records

    def _new(self, kind, domain, nbytes):
        self._ids += 1
        r = Record(self._ids, kind, domain, nbytes)
        self.records.append(r)
        return r

    def held(self):
        return sum(r.bytes for r in self.records if r.state == LIVE)

    def _drop(self, r, state):
        if r.state == LIVE:
            r.state = state
            self.records.remove(r)

    def _sweep(self):
        """Each finalized record accounted once, by its own state: a live
        one's charge released; an absorbed or released one, nothing."""
        keep = []
        for r in self._watched:
            if r.finalized:
                self._drop(r, RELEASED)
            else:
                keep.append(r)
        self._watched = keep

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

    def rebase(self, child=None):
        """Step 2 of a call (no active charge: the call lock is held).
        child: None, or a function returning the engine process's
        (limit, rss) in bytes now.  Returns the headroom F0' - held after
        the transition; raises NeedReap, or the memory refusal (unknown
        memory, or overdrawn)."""
        lock = self._lock
        lock.acquire()
        try:
            self._sweep()
            if any(r.kind in ("host", "engine") for r in self.records):
                raise RuntimeError("the PNG ledger re-based with a call active")
            rec = self._capacity()
            self.last = rec
            self.gen += 1
            f = self._figure(rec)
            if f is None:
                # (nothing cleared: every record and the prior state stay)
                mg = _memguard()
                raise mg.SagebrushMemoryError(UNKNOWN, "A PNG", 0, 0, "PNG work")
            domains = set(rec.get("domains") or ())
            standing = None
            if self.standing is not None:
                if child is not None:
                    limit, rss = child()
                    standing = limit - (rss if "child" in domains else 0)
                else:
                    standing = self.standing.bytes
            survivors = (standing if standing is not None else 0) + sum(
                r.bytes for r in self.records if r.kind == "resident" and r.domain not in domains)
            if survivors <= f:
                for r in [r for r in self.records if r.kind == "resident" and r.domain in domains]:
                    self._drop(r, ABSORBED)
                if standing is not None:
                    self.standing.bytes = max(0, standing)
                self.f0 = f
                self.overdrawn = False
                return f - self.held()
            if self.standing is not None:
                self.f0 = None
                raise NeedReap()
            self.f0 = None
            self.overdrawn = True
            raise _memguard().memory_guard(
                "Memory from an earlier PNG engine instance not yet released by the runtime", survivors, f, "PNG work")
        finally:
            lock.release()

    # ------------------------------------------------------------ a call

    def reserve(self, kind, domain, nbytes):
        """An active charge of exactly nbytes, or the memory refusal."""
        lock = self._lock
        lock.acquire()
        try:
            room = self.room()
            if nbytes > room:
                raise _memguard().memory_guard("A PNG", nbytes, max(0, room), "PNG work")
            return self._new(kind, domain, nbytes)
        finally:
            lock.release()

    def room(self):
        return 0 if self.f0 is None else max(0, self.f0 - self.held())

    def grant(self, domain):
        """The engine's grant: everything that remains, exclusively."""
        lock = self._lock
        lock.acquire()
        try:
            return self._new("engine", domain, self.room())
        finally:
            lock.release()

    def release(self, record):
        lock = self._lock
        lock.acquire()
        try:
            self._drop(record, RELEASED)
        finally:
            lock.release()

    def set_standing(self, nbytes, domain="child"):
        """The engine process's standing charge (its whole limit, until an
        observation sees some of it resident), or none (nbytes None: it has
        been reaped)."""
        lock = self._lock
        lock.acquire()
        try:
            if self.standing is not None:
                self._drop(self.standing, RELEASED)
                self.standing = None
            if nbytes is not None:
                self.standing = self._new("standing", domain, nbytes)
        finally:
            lock.release()

    def resident(self, nbytes, domain, owner=None):
        """A resident charge (an output), absorbed by the next observation
        covering its domain; with owner, released when owner is collected
        (its finalizer only flags the record, which never references it)."""
        lock = self._lock
        lock.acquire()
        try:
            r = self._new("resident", domain, nbytes)
        finally:
            lock.release()
        if owner is not None:
            try:
                import weakref
                weakref.finalize(owner, _mark, r)
                self._watched.append(r)
            except (ImportError, TypeError):
                pass  # (no weak references: the observation absorbs it)
        return r


_ledger = None


def ledger():
    """This runtime's ledger."""
    global _ledger
    if _ledger is None:
        _ledger = Ledger()
    return _ledger
