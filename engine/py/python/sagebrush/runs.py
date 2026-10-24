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
import secrets
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
    import stat
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


def _write_atomic(path, data, durable=False):
    """data (bytes) to path: a temporary file created exclusively (never
    following a link), then renamed over it; fsynced, file and directory,
    when durable."""
    tmp = "%s.%s.tmp" % (path, secrets.token_hex(6))
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
    fd = os.open(tmp, flags, 0o600)
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
    if durable and os.name == "posix":
        d = os.open(os.path.dirname(path), os.O_RDONLY)
        try:
            os.fsync(d)
        finally:
            os.close(d)


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
        own size, with its target file not charged."""
        reserved_targets = set()
        total = 0
        rdir = os.path.join(self.root, "reservations")
        for name in os.listdir(rdir):
            p = os.path.join(rdir, name)
            r = _read_json(p)
            if not isinstance(r, dict) or not isinstance(r.get("bytes"), int):
                total += _charge(p)
                continue
            total += r["bytes"] + _charge(p)
            reserved_targets.add(os.path.realpath(r.get("target", "")))
        for dirpath, dirnames, filenames in os.walk(self.root):
            if os.path.abspath(dirpath) == os.path.abspath(rdir):
                continue
            for name in filenames:
                p = os.path.join(dirpath, name)
                if os.path.realpath(p) in reserved_targets:
                    continue
                total += _charge(p)
        return total

    def _total(self):
        s = _read_json(os.path.join(self.root, "store.json"), {})
        return s.get("total") if isinstance(s.get("total"), int) else None

    def _set_total(self, total):
        _write_atomic(os.path.join(self.root, "store.json"), json.dumps({"total": total}).encode(), durable=True)

    def used(self):
        with self.lock:
            t = self._total()
            if t is None:
                t = self.walk_total()
                self._set_total(t)
            return t

    def reserve(self, handle, target, nbytes):
        """Admit a write of nbytes to target (a value or checkpoint of the
        run), under the store lock, with a durable reservation; a
        StorageError if it doesn't fit.  Returns the reservation's path."""
        with self.lock:
            used = self.used()
            budget = self.cfg["SAGEBRUSH_RUNS_STORE_BYTES"]
            free, _ = self._free()
            if used + nbytes > budget:
                raise StorageError("the run store is full (%d of %d bytes used)" % (used, budget))
            if free - nbytes < self.reserve_floor():
                raise StorageError("too little free disk space (the store keeps %d bytes free)" % self.reserve_floor())
            p = os.path.join(self.root, "reservations", "%s-%s.json" % (handle, secrets.token_hex(4)))
            rec = json.dumps({"bytes": nbytes, "target": target, "owner": self.owner}).encode()
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
        with self.lock:
            r = _read_json(reservation, {})
            target = r.get("target")
            used = self.used() - int(r.get("bytes", 0)) - _charge(reservation)
            if target and os.path.exists(target):
                os.unlink(target)
            self._set_total(max(0, used))
            os.unlink(reservation)

    def write_file(self, handle, name, data, durable=False):
        """A small file of a run (record, output), charged by its change."""
        p = os.path.join(self.run_dir(handle), name)
        with self.lock:
            before = _charge(p)
            _write_atomic(p, data, durable)
            t = self._total()
            if t is not None:
                self._set_total(max(0, t - before + _charge(p)))

    def write_value(self, handle, data):
        """A value file (value.json), admitted first: (path, None) or
        (None, reason)."""
        d = self.run_dir(handle)
        target = os.path.join(d, "value.json")
        try:
            res = self.reserve(handle, target, len(data) + 4096)
        except StorageError as e:
            return None, str(e)
        try:
            _write_atomic(target, data, durable=True)
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
        _write_atomic(self._index_path(), json.dumps(idx, separators=(",", ":")).encode())

    def mine(self, entry):
        o = entry.get("owner") or {}
        return o.get("pid") == self.owner["pid"] and o.get("nonce") == self.owner["nonce"]

    def summary(self, now=None):
        """The `runs` summary of every MCP result (§9): from the index alone."""
        now = time.time() if now is None else now
        idx = self.index()
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
            for name in os.listdir(self.root):
                if name.endswith(".tmp"):
                    try:
                        os.unlink(os.path.join(self.root, name))
                    except OSError:
                        pass
            done = []
            for name in os.listdir(self.root):
                if not name.startswith("run_"):
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
            self._set_total(self.walk_total())
            return sorted(removed)

    def _remove(self, record, reason, now):
        h = record["handle"]
        d = os.path.join(self.root, h)
        tomb = {"handle": h, "state": "gone", "ended_at": record.get("ended_at"), "removed_at": now, "reason": reason}
        _write_atomic(os.path.join(self.root, "gone", h + ".json"), json.dumps(tomb).encode())
        for name in os.listdir(d):
            os.unlink(os.path.join(d, name))
        os.rmdir(d)

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
        b = text.encode("utf-8", "replace")
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
        "covers": "worker_and_tracked_helpers" if os.name != "nt" else "worker",
        "output": {"stdout_bytes": 0, "stderr_bytes": 0, "retained_bytes": 0, "truncated_bytes": 0, "tail": "", "path": None},
        "resources": {"store_bytes": 0}, "files": [], "retained": [],
        "notes": [SHARED_NOTE, DETACHED_NOTE],
    }


def big(n):
    """An integer as A3 §7 encodes it: a JSON integer up to 2^53, else its
    decimal string."""
    return n if -(1 << 53) <= n <= (1 << 53) else str(n)
