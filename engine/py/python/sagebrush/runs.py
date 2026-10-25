"""The run store of the agent API's host side (H′1a; design-hprime-host-r5).

A run is one computation an agent started: code in a session (a `sage` or
`python` tool call).  It has a handle and a record, `sagebrush.run/1`, kept
under the store, `~/.cache/sagebrush/runs/` (or $SAGEBRUSH_RUNS_DIR), so an
agent can come back for it after its call returned (a ticket).

The store is bounded on disk (§5): captured output is rotated (its head and
tail kept, exact counters), a value is admitted before it is written, under
the store lock, with a reservation; finished runs are removed oldest first
by bytes, age and count; a removed run leaves a small tombstone.  The
accounting has one formula, for the running total and for the walk alike.

The store's directory is 0700 and its files 0600: that protects runs from
other users, not from collaborators who share this Unix user (a cocalc.ai
project).  Every listing says so.

H′1a covers a run inside one server's life.  A run owned by another
process (an earlier server, now gone, or another one running) is shown with
`liveness: "unknown"`: its owner isn't verified until H′1b's reconciler.
"""

import json
import os
import re
import secrets
import stat
import sys
import time

SHARED_NOTE = ("Runs are visible to every process of this Unix user, including collaborators "
               "in a shared cocalc.ai project, who can list, read and cancel them.")
DETACHED_NOTE = ("Processes your code detaches (for example with setsid) are not tracked and may "
                 "keep running after the run ends.")

MiB, GiB = 1 << 20, 1 << 30
HEAD_KEEP = 1 * MiB          # (of captured output: the first MiB is kept)
TAIL_SHOWN = 4096            # (the tail in a record)
INLINE_VALUE = 64 * 1024     # (a value up to this is inline in the record)
TOMBSTONES_MAX = 10000
TOMBSTONE_DAYS = 30
RUN_META_BYTES = 64 * 1024   # (a new run is admitted only with this much room for its records)
DATA_HEADROOM_MAX = 16 * MiB  # (values and output stop short of the budget by this, at most an eighth of it: the records' room)


# ------------------------------------------------------------------ settings

_RANGES = {
    # name: (default, low, high, unit)
    "SAGEBRUSH_RUNS_KEEP_DAYS": (7, 1, 365, "days"),
    "SAGEBRUSH_RUNS_KEEP_COUNT": (200, 10, 10000, "runs"),
    "SAGEBRUSH_RUNS_OUTPUT_BYTES": (64 * MiB, 1 * MiB, 1 * GiB, "bytes"),
    "SAGEBRUSH_RUNS_SESSIONS": (4, 1, 256, "sessions"),
}


def settings(env=None):
    """The store's settings from the environment, each validated: an
    invalid value is a ValueError naming the variable and its range."""
    env = os.environ if env is None else env
    out = {}
    for name, (default, lo, hi, unit) in _RANGES.items():
        text = env.get(name)
        if text is None or text == "":
            out[name] = default
            continue
        try:
            v = int(text)
        except ValueError:
            raise ValueError("%s=%r: an integer number of %s from %d to %d is needed" % (name, text, unit, lo, hi))
        if not lo <= v <= hi:
            raise ValueError("%s=%d: out of range (%d to %d %s)" % (name, v, lo, hi, unit))
        out[name] = v
    text = env.get("SAGEBRUSH_RUNS_STORE_BYTES")
    out["SAGEBRUSH_RUNS_STORE_BYTES"] = 2 * GiB
    if text:
        try:
            v = int(text)
        except ValueError:
            raise ValueError("SAGEBRUSH_RUNS_STORE_BYTES=%r: an integer number of bytes is needed" % (text,))
        if v < 64 * MiB:
            raise ValueError("SAGEBRUSH_RUNS_STORE_BYTES=%d: at least %d bytes" % (v, 64 * MiB))
        out["SAGEBRUSH_RUNS_STORE_BYTES"] = v  # (and at most half the filesystem: checked at open)
    return out


def session_ceiling(cpus=None, total=None):
    """The immutable ceiling on concurrent sessions: min(2 x CPUs,
    floor(T / 512 MiB)), at least 1, where T is the effective memory total
    (D0's heap_figure() where the package has it); 1 when T is unknown."""
    cpus = cpus if cpus is not None else (os.cpu_count() or 1)
    if total is None:
        try:
            from sagebrush import _capacity_module  # (item D0)
            total = _capacity_module().heap_figure()
            if total == 1 << 30 and _capacity_module()._machine_total()[1] == ["nominal"]:
                total = None
        except Exception:
            total = None
    if total is None:
        return 1
    return max(1, min(2 * cpus, total // (512 * MiB)))


# ------------------------------------------------------------------ files

def _root(env=None):
    env = os.environ if env is None else env
    d = env.get("SAGEBRUSH_RUNS_DIR")
    if d:
        return os.path.abspath(d)
    base = env.get("XDG_CACHE_HOME") or os.path.join(os.path.expanduser("~"), ".cache")
    return os.path.join(base, "sagebrush", "runs")


def _mkdir_private(path):
    """A directory of ours: created 0700, or an existing one that is a real
    directory (not a link) of this user."""
    try:
        os.makedirs(path, mode=0o700)
    except FileExistsError:
        pass
    st = os.lstat(path)
    if not stat.S_ISDIR(st.st_mode):
        raise OSError("%s is not a directory" % path)
    if hasattr(os, "getuid") and st.st_uid != os.getuid():
        raise OSError("%s belongs to another user" % path)
    if os.name == "posix" and st.st_mode & 0o077:
        os.chmod(path, 0o700)


def _charge(path):
    """A committed file's charge: its physical size."""
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return 0
    blocks = getattr(st, "st_blocks", None)
    return blocks * 512 if blocks is not None else st.st_size


def _key(path):
    """A path's identity in the store: absolute and normalized, lexically
    (never resolving a link: a link is an entry of its own)."""
    return os.path.normpath(os.path.abspath(path))


def _real_dir(path):
    """path is a directory itself, not a link to one."""
    try:
        return stat.S_ISDIR(os.lstat(path).st_mode)
    except OSError:
        return False


def _unlink_in(d, name):
    """The file name removed from directory d, never through a link
    (daybreak2 PR136-RECOVERY-1): d opened without following a link, and
    name removed relative to it; where the platform can't, d checked by
    lstat first.  False, removing nothing, when d is a link or not a
    directory; a missing name or d is no error."""
    assert name and os.sep not in name and name not in (".", "..")
    nofollow, odir = getattr(os, "O_NOFOLLOW", 0), getattr(os, "O_DIRECTORY", 0)
    if nofollow and odir and os.unlink in os.supports_dir_fd:
        try:
            fd = os.open(d, os.O_RDONLY | odir | nofollow)
        except FileNotFoundError:
            return True
        except OSError:
            return False  # (ELOOP, ENOTDIR: a link, or not a directory)
        try:
            os.unlink(name, dir_fd=fd)
        except FileNotFoundError:
            pass
        finally:
            os.close(fd)
        return True
    if not _real_dir(d):
        return not os.path.lexists(d)
    try:
        os.unlink(os.path.join(d, name))
    except FileNotFoundError:
        pass
    return True


def _temp_name(path):
    """A writer's own temporary for path: path.<12 hex>.tmp (_TEMP_RE)."""
    return "%s.%s.tmp" % (path, secrets.token_hex(6))


# (a temporary _write_atomic made: its target, then the writer's token)
_TEMP_RE = re.compile(r"^(?P<target>.+)\.[0-9a-f]{12}\.tmp$")
# (a reservation's file name: the run's handle, then a token)
_RESERVATION_RE = re.compile(r"^(?P<handle>run_[a-z2-7]{26})-[0-9a-f]{8}\.json$")


def _write_atomic(path, data, durable=False, tmp=None):
    """data (bytes) to path: a temporary file created exclusively (never
    following a link), then renamed over it; fsynced, file and directory,
    when durable.  tmp: the temporary's name, when the writer has recorded
    it (a value write's reservation names it, so a cleanup keeps it)."""
    tmp = tmp or _temp_name(path)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
    fd = os.open(tmp, flags, 0o600)
    try:
        try:
            view = memoryview(data)
            while view:
                n = os.write(fd, view)
                view = view[n:]
            if durable:
                os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(tmp, path)
    except BaseException:
        # (a failed write, fsync or replace leaves no temporary behind, daybreak2 PR120-FIX-1)
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    if durable and os.name == "posix":
        d = os.open(os.path.dirname(path), os.O_RDONLY)
        try:
            os.fsync(d)
        finally:
            os.close(d)


def _bytes_ok(b):
    """A reservation's declared bytes: a non-negative int, not a bool."""
    return isinstance(b, int) and not isinstance(b, bool) and b >= 0


def _read_json(path, default=None):
    try:
        with open(path, "rb") as f:
            return json.loads(f.read().decode("utf-8"))
    except (FileNotFoundError, ValueError):
        return default


class _Lock:
    """The store lock: an exclusive lock on runs/.lock (flock on POSIX,
    msvcrt on Windows), and a thread lock inside this process."""

    def __init__(self, path):
        import threading
        self.path = path
        self.thread = threading.RLock()
        self.depth = 0
        self.fd = None

    def __enter__(self):
        self.thread.acquire()
        if self.depth == 0:
            self.fd = os.open(self.path, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
            if os.name == "nt":
                import msvcrt
                while True:
                    try:
                        msvcrt.locking(self.fd, msvcrt.LK_LOCK, 1)
                        break
                    except OSError:
                        time.sleep(0.05)
            else:
                import fcntl
                fcntl.flock(self.fd, fcntl.LOCK_EX)
        self.depth += 1
        return self

    def __exit__(self, *a):
        self.depth -= 1
        if self.depth == 0:
            try:
                if os.name == "nt":
                    import msvcrt
                    os.lseek(self.fd, 0, 0)
                    msvcrt.locking(self.fd, msvcrt.LK_UNLCK, 1)
            finally:
                os.close(self.fd)
                self.fd = None
        self.thread.release()


# ------------------------------------------------------------------ the store

class StorageError(Exception):
    """A write the store couldn't admit (its budget, the free-space reserve)."""


class SlotRefused(Exception):
    """No session slot left: (used, ceiling, slots, unknown runs)."""

    def __init__(self, used, ceiling, slots, unknown):
        super().__init__("%d of %d session slots are held" % (used, ceiling))
        self.used, self.ceiling, self.slots, self.unknown = used, ceiling, slots, unknown


_HOST = __import__("socket").gethostname()
_LIVE_NONCES = set()  # (the owners alive in this process: its stores')


class Store:
    """The run store.  One per server; several processes may share it."""

    def __init__(self, root=None, env=None, owner=None):
        self.env = os.environ if env is None else env
        self.cfg = settings(self.env)
        self.root = root or _root(self.env)
        _mkdir_private(self.root)
        _mkdir_private(os.path.join(self.root, "gone"))
        _mkdir_private(os.path.join(self.root, "reservations"))
        self.lock = _Lock(os.path.join(self.root, ".lock"))
        # (this process's identity, for "is this run mine": H′1a has no
        # leases; a run owned by another process is liveness unknown)
        self.owner = owner or {"pid": os.getpid(), "nonce": secrets.token_hex(16)}
        _LIVE_NONCES.add(self.owner["nonce"])
        fs = self._fs_size()
        if fs and self.cfg["SAGEBRUSH_RUNS_STORE_BYTES"] > fs // 2:
            raise ValueError("SAGEBRUSH_RUNS_STORE_BYTES=%d: more than half the filesystem (%d bytes)" % (self.cfg["SAGEBRUSH_RUNS_STORE_BYTES"], fs // 2))
        with self.lock:
            self._rebuild_index()
            self.cleanup()

    # ---- paths
    def run_dir(self, handle):
        if not (isinstance(handle, str) and handle.startswith("run_") and len(handle) == 30 and handle[4:].isalnum() and handle[4:].islower()):
            raise KeyError(handle)
        return os.path.join(self.root, handle)

    def _fs_size(self):
        try:
            st = os.statvfs(self.root)
            return st.f_frsize * st.f_blocks
        except (AttributeError, OSError):
            return None

    def _free(self):
        try:
            st = os.statvfs(self.root)
            return st.f_frsize * st.f_bavail, st.f_frsize * st.f_blocks
        except (AttributeError, OSError):
            import shutil
            u = shutil.disk_usage(self.root)
            return u.free, u.total

    def reserve_floor(self):
        """The free space never written into: max(1 GiB, 5% of the filesystem)."""
        _, total = self._free()
        return max(GiB, total // 20)

    # ---- the one accounting formula (daybreak2 HPR-RES-R3-1)
    def walk_total(self):
        """The store's charge, walked: every committed file at its physical
        size; a live reservation at its declared bytes plus its record's
        own size, with its target and its recorded temporary not charged
        (a reserved write is charged once, at its declared bytes, for its
        whole life: plan-runs-tmp-sweep r4).  Each record is validated
        first: only a valid one's paths are excluded (a legacy one, without
        a recorded temporary: its target's temporaries too); an invalid one
        is charged at its record plus its declared bytes when those are a
        non-negative int, never less, and excludes nothing."""
        excluded, legacy_targets, records = set(), set(), set()
        total = 0
        for p, r, kind in self._reservations():
            total += _charge(p)
            records.add(_key(p))
            if kind in ("valid", "legacy", "invalid") and _bytes_ok(r.get("bytes")):
                total += r["bytes"]
            if kind == "valid":
                excluded.add(_key(r["target"]))
                excluded.add(_key(r["temp"]))
            elif kind == "legacy":
                excluded.add(_key(r["target"]))
                legacy_targets.add(_key(r["target"]))
        # (every entry at its own physical size, lstat: a link is charged as
        # the link, never its target, and never descended into, daybreak2
        # PR136-ACCOUNT-1; reservations/ too, its records once, above, and
        # any other file in it at its size, astra2 RESOURCE-PR136-1)
        for dirpath, dirnames, filenames in os.walk(self.root):
            for name in dirnames:
                if os.path.islink(os.path.join(dirpath, name)):
                    total += _charge(os.path.join(dirpath, name))
            for name in filenames:
                k = _key(os.path.join(dirpath, name))
                if k in records or k in excluded:
                    continue
                m = _TEMP_RE.match(name)
                if m and _key(os.path.join(dirpath, m.group("target"))) in legacy_targets:
                    continue
                total += _charge(k)
        return total

    def _reservations(self):
        """[(path, record, kind)] for every file in reservations/, each
        validated before any use: "valid" (a value write's: its file name
        <handle>-<8 hex>.json, its target exactly that run's value.json, the
        run's directory a directory, not a link, or absent, its temporary
        exactly target.<12 hex>.tmp, its bytes a non-negative int and not a
        bool), "legacy" (the same, without a temporary: written before r4),
        "invalid" (readable, but not those), "unreadable" (also anything not
        a regular file).  A record's own temporaries (*.tmp, being written
        under the lock) aren't records: walk_total charges them as files."""
        rdir = os.path.join(self.root, "reservations")
        out = []
        for name in sorted(os.listdir(rdir)):
            p = os.path.join(rdir, name)
            if name.endswith(".tmp"):
                continue  # (a reservation being written: its writer holds the lock)
            try:
                regular = stat.S_ISREG(os.lstat(p).st_mode)
            except OSError:
                regular = False
            r = _read_json(p) if regular else None
            if not isinstance(r, dict):
                out.append((p, r, "unreadable"))
                continue
            out.append((p, r, self._reservation_kind(name, r)))
        return out

    def _reservation_kind(self, name, r):
        m = _RESERVATION_RE.match(name)
        if not m or not _bytes_ok(r.get("bytes")) or not isinstance(r.get("target"), str):
            return "invalid"
        try:
            want = os.path.join(self.run_dir(m.group("handle")), "value.json")
        except KeyError:
            return "invalid"
        if _key(r["target"]) != _key(want):
            return "invalid"
        # (the run's directory itself, not a link out of the store: its
        # paths are then the store's, daybreak2 PR136-RECOVERY-1)
        d = os.path.dirname(want)
        if os.path.lexists(d) and not _real_dir(d):
            return "invalid"
        if "temp" not in r:
            return "legacy"
        t = r["temp"]
        if not isinstance(t, str) or os.path.dirname(_key(t)) != _key(d):
            return "invalid"
        tm = _TEMP_RE.match(os.path.basename(t))
        if not tm or tm.group("target") != "value.json":
            return "invalid"
        return "valid"

    def _total(self):
        s = _read_json(os.path.join(self.root, "store.json"), {})
        return s.get("total") if isinstance(s.get("total"), int) else None

    def _set_total(self, total):
        """The running total, written in place in a fixed 64 bytes (no
        temporary file, so it needs no room of its own; a torn write reads as
        no total, and the walk recomputes it)."""
        data = json.dumps({"total": total}).encode().ljust(64)
        fd = os.open(os.path.join(self.root, "store.json"), os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0), 0o600)
        try:
            os.write(fd, data) if os.lseek(fd, 0, 0) == 0 else None
            os.ftruncate(fd, 64)
            os.fsync(fd)
        finally:
            os.close(fd)

    def used(self):
        with self.lock:
            t = self._total()
            if t is None:
                t = self.walk_total()
                self._set_total(t)
            return t

    def reserve(self, handle, target, nbytes, temp):
        """Admit a write of nbytes to target (the run's value) through the
        temporary `temp`, under the store lock, with a durable reservation
        naming both (a cleanup keeps that temporary while the reservation
        lives, plan-runs-tmp-sweep r4); a StorageError if it doesn't fit, or
        if target already has a reservation (one per target).  Returns the
        reservation's path."""
        with self.lock:
            want = _key(target)
            for _, r, kind in self._reservations():
                if kind in ("valid", "legacy") and _key(r["target"]) == want:
                    raise StorageError("a value of this run is already being written")
            p = os.path.join(self.root, "reservations", "%s-%s.json" % (handle, secrets.token_hex(4)))
            # (the owner with its host: a dead one's reservation can then be
            # recovered, _owner_gone)
            rec = json.dumps({"bytes": nbytes, "target": target, "temp": temp, "owner": dict(self.owner, host=_HOST)}).encode()
            # (the formula's whole charge: the declared bytes and the
            # reservation record's own physical size, daybreak2 PR120-1)
            self.admit(nbytes + self.physical(len(rec)), "data")
            used = self.used()
            _write_atomic(p, rec, durable=True)
            self._set_total(used + nbytes + _charge(p))
            return p

    def commit(self, reservation, target):
        """The reservation replaced by the final file's physical charge, then
        removed (a crash between leaves the total too high, never low)."""
        with self.lock:
            r = _read_json(reservation, {})
            used = self.used() - int(r.get("bytes", 0)) - _charge(reservation) + _charge(target)
            self._set_total(max(0, used))
            os.unlink(reservation)

    def release(self, reservation):
        """The reservation given back: its target and its temporary, which
        were never charged, removed with it (used: less its bytes and its
        record).  Only for a valid record: a writer's own, or a recovered one.
        Both are unlinked in the run's directory, never through a link (one
        put there since: nothing outside the store is removed)."""
        with self.lock:
            r = _read_json(reservation, {})
            target = r.get("target")
            used = self.used() - int(r.get("bytes", 0)) - _charge(reservation)
            if isinstance(target, str):
                d = os.path.dirname(_key(target))
                for f in (target, r.get("temp")):
                    if isinstance(f, str) and os.path.dirname(_key(f)) == d:
                        _unlink_in(d, os.path.basename(_key(f)))
            self._set_total(max(0, used))
            os.unlink(reservation)

    def physical(self, n):
        """A conservative physical charge for n bytes: whole blocks, at least one."""
        try:
            b = os.statvfs(self.root).f_frsize or 4096
        except (AttributeError, OSError):
            b = 4096
        return max(1, -(-n // b)) * b

    def admit(self, nbytes, kind):
        """Under the lock: room for nbytes more, or a StorageError.  "meta"
        (records, the index) may use the whole budget; "data" (output,
        values) stops short of it by the records' headroom.  Both keep the
        free-space floor."""
        with self.lock:
            budget = self.cfg["SAGEBRUSH_RUNS_STORE_BYTES"]
            limit = budget if kind == "meta" else budget - min(DATA_HEADROOM_MAX, budget // 8)
            used = self.used()
            if used + nbytes > limit:
                raise StorageError("the run store is full (%d of %d bytes used)" % (used, limit))
            free, _ = self._free()
            if free - nbytes < self.reserve_floor():
                raise StorageError("too little free disk space (the store keeps %d bytes free)" % self.reserve_floor())

    def write_file(self, handle, name, data, durable=False, kind="meta"):
        """A file of a run (record, output), admitted for its growth before
        it replaces the old one, then charged by its change."""
        p = os.path.join(self.run_dir(handle), name)
        with self.lock:
            before = _charge(p)
            # (the whole new file: it exists beside the old one until the
            # replace, daybreak2 PR120-FIX-1)
            self.admit(self.physical(len(data)), kind)
            _write_atomic(p, data, durable)
            t = self._total()
            if t is not None:
                self._set_total(max(0, t - before + _charge(p)))

    def discard(self, handle):
        """A run that was never admitted after all: its directory removed."""
        with self.lock:
            d = self.run_dir(handle)
            if _real_dir(d):
                try:
                    for n in os.listdir(d):
                        _unlink_in(d, n)
                    os.rmdir(d)
                except FileNotFoundError:
                    pass
            self._set_total(self.walk_total())

    def write_value(self, handle, data):
        """A value file (value.json), admitted first: (path, None) or
        (None, reason)."""
        d = self.run_dir(handle)
        target = os.path.join(d, "value.json")
        # (the temporary named first, and recorded in the reservation: it is
        # this write's while the reservation lives, whatever its age)
        temp = _temp_name(target)
        try:
            res = self.reserve(handle, target, self.physical(len(data)), temp)
        except (StorageError, OSError) as e:
            return None, str(e)
        try:
            _write_atomic(target, data, durable=True, tmp=temp)
        except OSError as e:
            self.release(res)
            return None, "the value couldn't be written: %s" % e
        self.commit(res, target)
        return target, None

    # ---- records
    def new_handle(self):
        while True:
            h = "run_" + "".join(secrets.choice("abcdefghijklmnopqrstuvwxyz234567") for _ in range(26))
            try:
                os.mkdir(os.path.join(self.root, h), 0o700)
                return h
            except FileExistsError:
                continue

    def save(self, record, durable=False):
        self.write_file(record["handle"], "run.json", json.dumps(record, separators=(",", ":")).encode(), durable)

    def exists(self, handle):
        """Whether the run's directory is still in the store."""
        try:
            return os.path.isdir(self.run_dir(handle))
        except KeyError:
            return False

    def load(self, handle):
        """The record of handle, or a tombstone ({"state": "gone", ...}), or
        None when nothing is known of it."""
        try:
            d = self.run_dir(handle)
        except KeyError:
            return None
        r = _read_json(os.path.join(d, "run.json"))
        if r is not None:
            return r
        return _read_json(os.path.join(self.root, "gone", handle + ".json"))

    # ---- the active index (daybreak2 HPR-RES-R3-2)
    def _index_path(self):
        return os.path.join(self.root, "active.json")

    def index_set(self, handle, entry):
        """entry (None: removed) for handle in the active index, under the lock."""
        with self.lock:
            idx = _read_json(self._index_path(), {})
            if entry is None:
                idx.pop(handle, None)
            else:
                idx[handle] = entry
            data = json.dumps(idx, separators=(",", ":")).encode()
            before = _charge(self._index_path())
            self.admit(self.physical(len(data)), "meta")
            _write_atomic(self._index_path(), data)
            t = self._total()
            if t is not None:
                self._set_total(max(0, t - before + _charge(self._index_path())))

    def index(self):
        """The active index: one bounded read (no scan, no lock)."""
        return _read_json(self._index_path(), {})

    def _rebuild_index(self):
        """At store open: the index rebuilt from the run directories (crash
        repair), under the lock."""
        idx = {}
        for name in os.listdir(self.root):
            if not name.startswith("run_"):
                continue
            r = _read_json(os.path.join(self.root, name, "run.json"))
            if isinstance(r, dict) and r.get("state") == "running":
                idx[name] = {"started_at": r.get("started_at"), "started_by": r.get("started_by"), "owner": r.get("owner"),
                             "label": r.get("label")}
        data = json.dumps(idx, separators=(",", ":")).encode()
        try:
            self.admit(self.physical(len(data)), "meta")
        except StorageError:
            return  # (no room even for the index: the old one stays, repaired at a later cleanup)
        _write_atomic(self._index_path(), data)

    # ---- session slots (daybreak2 PR120-FIX-2)
    def _slots_path(self):
        return os.path.join(self.root, "slots.json")

    def slots(self):
        return _read_json(self._slots_path(), {})

    def _owner_gone(self, owner):
        """Whether a slot's owning server has certainly exited: a process of
        this host that no longer exists (or this very pid, with another
        nonce).  Anything else, Windows included, is not proof."""
        if not isinstance(owner, dict) or owner.get("host") != _HOST or os.name != "posix":
            return False
        if owner.get("nonce") == self.owner["nonce"]:
            return False  # (never this store's own)
        pid = owner.get("pid")
        if pid == os.getpid():
            return owner.get("nonce") not in _LIVE_NONCES
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return True
        except (OSError, TypeError, ValueError):
            return False
        return False

    def slot_take(self, slot, ceiling):
        """Under the store lock: the session slot `slot` of this server
        (taken now: True; already held: False), or a SlotRefused.  Every live session
        of every server sharing the store holds one, idle or not; a run of
        another owner in the active index without a slot (an unknown run)
        holds one too.  An idle slot is reclaimed only when its owner has
        certainly exited: its worker then reads EOF on its pipe and ends;
        a slot whose owner left a run in the index is kept (liveness
        unknown, design §6)."""
        with self.lock:
            slots, idx = self.slots(), self.index()
            before = dict(slots)
            busy = {(e.get("owner") or {}).get("nonce") for e in idx.values()}
            for k, e in list(slots.items()):
                o = e.get("owner") or {}
                if o.get("nonce") not in busy and self._owner_gone(o):
                    del slots[k]
            new = slot not in slots
            if new:
                holders = {(e.get("owner") or {}).get("nonce") for e in slots.values()}
                unslotted = sorted(h for h, e in idx.items() if (e.get("owner") or {}).get("nonce") not in holders and not self.mine(e))
                used = len(slots) + len(unslotted)
                if used >= ceiling:
                    raise SlotRefused(used, ceiling, sorted(slots), unslotted)
                slots[slot] = {"owner": dict(self.owner, host=_HOST), "since": time.time()}
            if slots != before:
                self._write_slots(slots)
            return new

    def _write_slots(self, slots):
        """slots.json replaced, admitted for its whole temporary file and
        charged by its change, as every other file (daybreak2
        PR120-FIX3-1)."""
        data = json.dumps(slots, separators=(",", ":")).encode()
        p = self._slots_path()
        self.admit(self.physical(len(data)), "meta")
        before = _charge(p)
        _write_atomic(p, data)
        t = self._total()
        if t is not None:
            self._set_total(max(0, t - before + _charge(p)))

    def slot_release(self, slot):
        with self.lock:
            slots = self.slots()
            if slots.pop(slot, None) is not None:
                try:
                    self._write_slots(slots)
                except (OSError, StorageError):
                    pass  # (left: reclaimed once this server has exited)

    def mine(self, entry):
        o = entry.get("owner") or {}
        return o.get("pid") == self.owner["pid"] and o.get("nonce") == self.owner["nonce"]

    def summary(self, now=None, exclude=()):
        """The `runs` summary of every MCP result (§9): from the index alone
        (less exclude: runs that have ended whose entry is still there)."""
        now = time.time() if now is None else now
        idx = {h: e for h, e in self.index().items() if h not in exclude}
        running = [h for h, e in idx.items() if self.mine(e)]
        unknown = [h for h, e in idx.items() if not self.mine(e)]
        ages = [now - e.get("started_at", now) for e in idx.values() if isinstance(e.get("started_at"), (int, float))]
        handles = sorted(idx, key=lambda h: idx[h].get("started_at") or 0)[:5]
        return {"running": len(running), "unknown": len(unknown), "oldest_age_s": round(max(ages), 1) if ages else None, "handles": handles}

    # ---- listing
    def listing(self, limit=50, cursor=None, now=None):
        """run_list: newest first, running and unknown runs first; at most
        limit (1 to 500); an opaque cursor for the next page."""
        now = time.time() if now is None else now
        limit = max(1, min(int(limit), 500))
        idx = self.index()
        recs = []
        for name in os.listdir(self.root):
            if name.startswith("run_"):
                r = _read_json(os.path.join(self.root, name, "run.json"))
                if isinstance(r, dict):
                    recs.append(self.view(r, idx))
        live = {"running": 0, "unknown": 1}
        recs.sort(key=lambda r: (0 if r.get("liveness") in ("unknown",) or r.get("state") == "running" else 1, -(r.get("started_at") or 0)))
        start = int(cursor) if isinstance(cursor, str) and cursor.isdigit() else 0
        page = recs[start:start + limit]
        nxt = str(start + limit) if start + limit < len(recs) else None
        entries = [{k: r.get(k) for k in ("handle", "state", "liveness", "started_by", "host", "session", "label", "keep", "covers")}
                   | {"age_s": round(now - (r.get("started_at") or now), 1), "resources": r.get("resources")} for r in page]
        used = self.used()
        return {"runs": entries, "cursor": nxt, "store": {"used": used, "budget": self.cfg["SAGEBRUSH_RUNS_STORE_BYTES"], "full": used >= self.cfg["SAGEBRUSH_RUNS_STORE_BYTES"]},
                "note": SHARED_NOTE + " " + DETACHED_NOTE}

    def view(self, record, idx=None):
        """A record as a reader sees it: a running run of another owner is
        liveness unknown (H′1a has no reconciler to verify its owner)."""
        r = dict(record)
        if r.get("state") == "running":
            o = r.get("owner") or {}
            if not (o.get("pid") == self.owner["pid"] and o.get("nonce") == self.owner["nonce"]):
                r["liveness"] = "unknown"
                r["liveness_reason"] = "its owner (process %s) isn't this server, and isn't verified" % o.get("pid")
        return r

    # ---- cleanup, tombstones
    def cleanup(self, now=None):
        """Finished runs removed, oldest first: past the age, past the count,
        then by bytes until the store is under its budget.  Running runs and
        runs whose owner isn't this server are never removed; kept runs are
        exempt from age and count, not from the byte guard.  The total is
        recomputed by the walk, under the lock."""
        now = time.time() if now is None else now
        with self.lock:
            # (a crashed value write's reservation, its owner proved dead
            # and its record valid: given back, its target and temporary
            # with it, plan-runs-tmp-sweep r4)
            for p, r, kind in self._reservations():
                if kind == "valid" and self._owner_gone(r.get("owner")):
                    self.release(p)
            # (temporaries a crash left, in the store and in its runs: under
            # the lock no lock-held write is in progress, and a value write's
            # own temporary, named by its live reservation, is kept however
            # old; a legacy reservation keeps its target's temporaries)
            live, legacy_targets = set(), set()
            for p, r, kind in self._reservations():
                if kind == "valid":
                    live.add(_key(r["temp"]))
                elif kind == "legacy":
                    legacy_targets.add(_key(r["target"]))
            # (the store's own directories only: never one a link leads to)
            for d in [self.root, os.path.join(self.root, "gone"), os.path.join(self.root, "reservations")] + [os.path.join(self.root, n) for n in os.listdir(self.root) if n.startswith("run_")]:
                if not _real_dir(d):
                    continue
                try:
                    names = os.listdir(d)
                except OSError:
                    continue
                for name in names:
                    m = _TEMP_RE.match(name)
                    if not m:
                        continue
                    p = os.path.join(d, name)
                    if _key(p) in live or _key(os.path.join(d, m.group("target"))) in legacy_targets:
                        continue
                    try:
                        _unlink_in(d, name)
                    except OSError:
                        pass
            done = []
            for name in os.listdir(self.root):
                if not name.startswith("run_") or not _real_dir(os.path.join(self.root, name)):
                    continue
                r = _read_json(os.path.join(self.root, name, "run.json"))
                if isinstance(r, dict) and r.get("state") in ("finished", "killed", "lost"):
                    done.append(r)
            done.sort(key=lambda r: r.get("ended_at") or 0)
            days = self.cfg["SAGEBRUSH_RUNS_KEEP_DAYS"] * 86400
            count = self.cfg["SAGEBRUSH_RUNS_KEEP_COUNT"]
            removed = set()
            unkept = [r for r in done if not r.get("keep")]
            for r in unkept:
                if now - (r.get("ended_at") or now) > days:
                    self._remove(r, "age", now)
                    removed.add(r["handle"])
            unkept = [r for r in unkept if r["handle"] not in removed]
            for r in unkept[: max(0, len(unkept) - count)]:
                self._remove(r, "count", now)
                removed.add(r["handle"])
            total = self.walk_total()
            self._set_total(total)
            for r in done:
                if total <= self.cfg["SAGEBRUSH_RUNS_STORE_BYTES"]:
                    break
                if r["handle"] in removed or r.get("keep"):
                    continue
                self._remove(r, "bytes", now)
                removed.add(r["handle"])
                total = self.walk_total()
            self._prune_tombstones(now)
            # (the index repaired here too: an entry left by a crash between a
            # terminal record and its index update, daybreak2 PR120-2)
            self._rebuild_index()
            self._set_total(self.walk_total())
            return sorted(removed)

    def _remove(self, record, reason, now):
        """A finished run removed, leaving a tombstone.  Under the store lock
        (cleanup's): a cleanup sweeping temporaries at the same time could
        otherwise take the tombstone's (plan-runs-tmp-sweep r4)."""
        h = record["handle"]
        d = os.path.join(self.root, h)
        if not _real_dir(d):
            return  # (a link, or gone: nothing of the store's to remove)
        tomb = {"handle": h, "state": "gone", "ended_at": record.get("ended_at"), "removed_at": now, "reason": reason}
        # (the run's files go first, so the tombstone, one block, is written
        # into room they freed; a crash between leaves no tombstone: not_found)
        for name in os.listdir(d):
            _unlink_in(d, name)
        os.rmdir(d)
        try:
            _write_atomic(os.path.join(self.root, "gone", h + ".json"), json.dumps(tomb).encode())
        except OSError:
            pass

    def _prune_tombstones(self, now):
        g = os.path.join(self.root, "gone")
        names = sorted(os.listdir(g))
        tombs = []
        for n in names:
            t = _read_json(os.path.join(g, n), {})
            tombs.append((t.get("removed_at") or 0, n))
        tombs.sort()
        for i, (at, n) in enumerate(tombs):
            if now - at > TOMBSTONE_DAYS * 86400 or len(tombs) - i > TOMBSTONES_MAX:
                os.unlink(os.path.join(g, n))


# ------------------------------------------------------------------ output

class Output:
    """Captured output, rotated: the first HEAD_KEEP bytes and a rolling tail,
    together at most `cap` bytes; exact counters.  The computation is never
    slowed or stopped by it."""

    def __init__(self, cap):
        self.cap = cap
        self.head = bytearray()
        self.tail = bytearray()
        self.total = {"stdout": 0, "stderr": 0}
        self.truncated = 0

    def add(self, text, stream="stdout"):
        b = text.encode("utf-8", "surrogatepass")  # (the bytes the worker counted)
        self.total[stream] += len(b)
        room = HEAD_KEEP - len(self.head)
        if room > 0:
            self.head += b[:room]
            b = b[room:]
        self.tail += b
        over = len(self.head) + len(self.tail) - self.cap
        if over > 0:
            del self.tail[:over]
            self.truncated += over

    def bytes(self):
        if self.truncated:
            return bytes(self.head) + ("\n[... %d bytes dropped ...]\n" % self.truncated).encode() + bytes(self.tail)
        return bytes(self.head) + bytes(self.tail)

    def info(self, path):
        whole = bytes(self.head) + bytes(self.tail)
        return {"stdout_bytes": self.total["stdout"], "stderr_bytes": self.total["stderr"], "retained_bytes": len(whole),
                "truncated_bytes": self.truncated, "tail": whole[-TAIL_SHOWN:].decode("utf-8", "replace"), "path": path}


# ------------------------------------------------------------------ records

def new_record(store, handle, kind, mode, session, run_seq, started_by, label=None, now=None):
    now = time.time() if now is None else now
    return {
        "schema": "sagebrush.run/1", "handle": handle, "kind": kind, "host": "mcp", "mode": mode,
        "session": session, "run_seq": run_seq, "started_by": started_by, "label": label,
        "started_at": now, "elapsed_s": 0.0, "last_seen_at": now, "state": "running",
        "owner": store.owner, "requests": [], "restarted": False, "keep": False, "ticketed": False,
        # (H′1a observes and stops only the session's worker process: no
        # process group or job yet (H′1b), so it never claims more)
        "covers": "worker",
        "output": {"stdout_bytes": 0, "stderr_bytes": 0, "retained_bytes": 0, "truncated_bytes": 0, "tail": "", "path": None},
        "resources": {"store_bytes": 0}, "files": [], "retained": [],
        "notes": [SHARED_NOTE, DETACHED_NOTE],
    }


def big(n):
    """An integer as A3 §7 encodes it: a JSON integer up to 2^53, else its
    decimal string."""
    return n if -(1 << 53) <= n <= (1 << 53) else str(n)
