"""fs-sync's base: one SQLite database per folder pair (design/fs-sync.md §2.5, §4.3, §4.5).

- **Where:** `<state>/pairs/<id>.sqlite`, `<id>` the SHA-256 of (account hash, grant id, absolute LOCAL_DIR,
  WORKSPACE_PATH); its lock beside it (`<id>.lock`). Every folder from `/` down is checked one level at a time:
  above fs-sync's own, real (or a link from a checked folder to a checked real path), ours or root's, and writable by
  no one else (or root's and sticky, as /tmp); fs-sync's own (the state folder and `pairs`) real, ours and 0700. The
  database, lock, -wal, -shm and -journal must be plain files of ours, private. So other local users and links planted
  in the tree can't redirect SQLite's opens by path; a process running as the same user is out of scope (it can already
  change anything of theirs).
- **One run per pair:** an exclusive, non-blocking `flock` on the lock file, held for the run; the OS releases it if
  the run is killed. A second run is refused with `LOCKED`.
- **Damaged or foreign:** a database that fails SQLite's integrity check, has an unknown version, or names another
  account, grant or folder inside it, is moved aside (never used; only the pair's latest set-aside base is kept) and
  the run starts with no base: a first run, with no deletions, and `Base.damaged` says why.
- **Bounds:** the database is capped at 1 GiB (`max_page_count`); its write-ahead log is truncated after every
  commit (`wal_checkpoint(TRUNCATE)`, `journal_size_limit` 64 MiB). A write past the cap fails with SQLITE_FULL,
  raised here as `StateFull`: the run stops at once (§4.5).
- **Commits** (§2.5): rows of non-destructive actions are batched, committed every 1,000 and at the end
  (`record`, `flush`); a destructive action is bracketed: its row is removed and committed before it acts
  (`begin_destructive`), and the new row committed after (`finish_destructive`), or the old row put back if the
  action was skipped (`undo_destructive`). So a run of a actions, d destructive, makes at most 3d + ceil(a/1000) + 1
  commits.
- **Space:** before scanning, the state filesystem needs 2.1 GiB free (`admit_scan`); before each destructive
  action, 64 MiB free and the database 64 MiB under its cap (`reserve_problem`)."""

import errno
import fcntl
import hashlib
import json
import os
import sqlite3
import stat
import time
import urllib.parse
from dataclasses import dataclass

SCHEMA_VERSION = 1
DB_CAP_BYTES = 2**30                    # the database, base and scratch tables together
WAL_LIMIT_BYTES = 64 * 2**20
LOCKED = "Another fs-sync of this folder is running. Wait for it to finish, then run it again."
BATCH = 1000                            # non-destructive rows per commit
SCAN_FREE_BYTES = int(2.1 * 2**30)      # the state filesystem, free before scanning (the database and its log: 2 GiB)
RESERVE_BYTES = 64 * 2**20              # free on the state filesystem, and under the cap, before a destructive action


class Refused(Exception):
    """fs-sync won't go on: `message` word for word (§1.2), `code` the exit code (§1.3)."""

    def __init__(self, message, code=1):
        super().__init__(message)
        self.message, self.code = message, code


class StateFull(Exception):
    """SQLITE_FULL: the database reached its cap, or its filesystem is full. The run stops at once (§4.5)."""


@dataclass(frozen=True)
class Row:
    sha256: str
    size: int = 0
    mtime_ns: int = 0
    ctime_ns: int = 0
    ino: int = 0
    dev: int = 0
    fid: str = None
    snapshot: bool = False
    revision: str = None

    @property
    def key(self):
        return (self.size, self.mtime_ns, self.ctime_ns, self.ino, self.dev)


def _home_short(p):
    home = os.path.expanduser("~")
    return "~" + p[len(home):] if home and (p == home or p.startswith(home + os.sep)) else p


def _state_base(db_path):
    # <base>/sagebrush/fs-sync/pairs/<id>.sqlite -> <base>, the folder §1.2's message names (~/.local/state)
    for _ in range(4):
        db_path = os.path.dirname(db_path)
    return db_path


def _mib(n):
    return "%d MiB" % (n // 2**20)


def pair_id(account_hash, grant_id, local_dir, workspace_path):
    return hashlib.sha256(json.dumps([account_hash, grant_id, local_dir, workspace_path]).encode("utf-8")).hexdigest()


# The state folders (§2.5): who may change them. Other local users and links planted in the tree are kept out; a process
# running as the same user can already change anything of theirs, so it is out of scope. With every folder from the root
# down unchangeable by anyone else, SQLite's opens by path (the database, its -wal, -shm and -journal) open what was
# checked.

def _not_yours(p):
    return Refused("%s isn't a folder of yours: fs-sync keeps its records there." % _home_short(p), 1)


def _unchangeable(st):
    """A folder above fs-sync's own: real, ours or root's, and writable by no one else, or root's and sticky (as /tmp:
    others can't rename or remove what is ours in it)."""
    if not stat.S_ISDIR(st.st_mode) or st.st_uid not in (0, os.getuid()):
        return False
    if st.st_mode & 0o002:
        return st.st_uid == 0 and bool(st.st_mode & stat.S_ISVTX)
    return not st.st_mode & 0o020 or _private_group(st.st_gid)


def _private_group(gid):
    """A group no one but us is in (a user-private group, as umask 002 systems make folders 775 with): no other member,
    and no other account's primary group. Unknown: not private."""
    import grp
    import pwd
    try:
        me = pwd.getpwuid(os.getuid()).pw_name
        if set(grp.getgrgid(gid).gr_mem) - {me}:
            return False
        return not [p for p in pwd.getpwall() if p.pw_gid == gid and p.pw_uid != os.getuid()]
    except (KeyError, OSError):
        return False


def _check_real(real):
    """Every folder of a real (link-free) path, from the root down, unchangeable by others."""
    p = os.sep
    for part in [""] + [c for c in real.split(os.sep) if c]:
        p = os.path.join(p, part)
        try:
            st = os.lstat(p)
        except OSError:                     # (a link to nothing)
            raise _not_yours(p)
        if not _unchangeable(st):
            raise _not_yours(p)


def _ancestors(path):
    """The folders down to `path` checked one level at a time, the missing ones made 0700. A link among them is followed
    only from a folder that passed, and its real path is checked the same way."""
    p = os.sep
    _check_real(p)
    for part in [c for c in os.path.abspath(path).split(os.sep) if c]:
        nxt = os.path.join(p, part)
        try:
            st = os.lstat(nxt)
        except FileNotFoundError:
            try:
                os.mkdir(nxt, 0o700)
            except FileExistsError:
                pass
            st = os.lstat(nxt)
        if stat.S_ISLNK(st.st_mode):
            nxt = os.path.realpath(nxt)
            _check_real(nxt)
        elif not _unchangeable(st):
            raise _not_yours(nxt)
        p = nxt
    return p


def _own_dir(path):
    """One of fs-sync's own folders: made 0700, opened no-follow, ours, and its mode set to 0700 through that handle."""
    try:
        os.mkdir(path, 0o700)
    except FileExistsError:
        pass
    try:
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0))
    except OSError:
        raise _not_yours(path)
    try:
        st = os.fstat(fd)
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid():
            raise _not_yours(path)
        if stat.S_IMODE(st.st_mode) != 0o700:
            os.fchmod(fd, 0o700)
    finally:
        os.close(fd)
    return path


def _state_dirs(state_dir):
    """The checked chain down to `state_dir`, and its `pairs` folder: (state_dir, pairs)."""
    state_dir = os.path.join(_ancestors(os.path.dirname(os.path.abspath(state_dir))), os.path.basename(state_dir))
    _own_dir(state_dir)
    return state_dir, _own_dir(os.path.join(state_dir, "pairs"))


SIDECARS = ("-wal", "-shm", "-journal")     # the files SQLite opens by name beside a database


def _private_file(st):
    return stat.S_ISREG(st.st_mode) and st.st_uid == os.getuid() and not st.st_mode & 0o077


def admit_scan(state_dir, free_bytes=None):
    """§1.2: the state filesystem needs 2.1 GiB free before scanning; else Refused (exit 1) having read nothing."""
    free = free_bytes if free_bytes is not None else _free(state_dir)
    if free < SCAN_FREE_BYTES:
        raise Refused("Not enough free space for fs-sync's records: it needs 2.1 GiB free in %s, and %s is free. "
                      "Free some space and run it again." % (_home_short(_existing(state_dir)), _mib(free)), 1)


def _existing(path):
    while not os.path.exists(path) and os.path.dirname(path) != path:
        path = os.path.dirname(path)
    return path


def _free(path):
    st = os.statvfs(_existing(path))
    return st.f_bavail * st.f_frsize


class Lock:
    """The pair's lock: an exclusive non-blocking flock, held until `release` (or the process ends)."""

    def __init__(self, path):
        bad = Refused("%s isn't a plain file of yours: fs-sync keeps this folder pair's lock there. Remove it, then run "
                      "it again." % _home_short(path), 1)
        try:
            self.fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NONBLOCK | getattr(os, "O_NOFOLLOW", 0)
                              | getattr(os, "O_CLOEXEC", 0), 0o600)
        except OSError as e:
            if e.errno in (errno.ELOOP, errno.EISDIR, errno.ENXIO, errno.EMLINK):
                raise bad
            raise
        if not _private_file(os.fstat(self.fd)):     # (a link was refused by the open; a folder or FIFO, or not ours)
            os.close(self.fd)
            self.fd = None
            raise bad
        try:
            fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as e:
            os.close(self.fd)
            self.fd = None
            if e.errno in (errno.EWOULDBLOCK, errno.EAGAIN, errno.EACCES):
                raise Refused(LOCKED, 1)
            raise

    def release(self):
        if self.fd is not None:
            fcntl.flock(self.fd, fcntl.LOCK_UN)
            os.close(self.fd)
            self.fd = None


def _full(e):
    return isinstance(e, sqlite3.OperationalError) and ("full" in str(e).lower() or getattr(e, "sqlite_errorcode", 0) == 13)


class Base:
    """The pair's base, opened under its lock. Use `Base.open(...)`, then `close()`."""

    def __init__(self, conn, path, lock, damaged):
        self.conn, self.path, self.lock, self.damaged = conn, path, lock, damaged
        self.pending = 0            # non-destructive rows not yet committed
        self.commits = 0

    # ---- opening

    @classmethod
    def open(cls, state_dir, account_hash, grant_id, local_dir, workspace_path):
        state_dir, pairs = _state_dirs(state_dir)
        pid = pair_id(account_hash, grant_id, local_dir, workspace_path)
        path = os.path.join(pairs, pid + ".sqlite")
        lock = Lock(os.path.join(pairs, pid + ".lock"))
        conn = None
        try:
            ident = {"account": account_hash, "grant": grant_id, "local": local_dir, "workspace": workspace_path}
            damaged = None
            if not os.path.lexists(path):
                for suffix in SIDECARS:                  # (left without their database: fs-sync's own, removed)
                    if os.path.lexists(path + suffix):
                        os.unlink(path + suffix)
            else:
                damaged = cls._check(path, ident)
                if damaged:
                    # (only the latest set-aside base is kept per pair: fs-sync's own records, never the person's files)
                    old = os.path.basename(path) + ".damaged-"
                    for name in os.listdir(pairs):
                        if name.startswith(old):
                            os.unlink(os.path.join(pairs, name))
                    ns = time.time_ns()
                    for suffix in ("",) + SIDECARS:
                        if os.path.lexists(path + suffix):
                            os.rename(path + suffix, "%s.damaged-%d%s" % (path, ns, suffix))
            conn = cls._connect(path)
            cls._init(conn, ident)
            return cls(conn, path, lock, damaged)
        except BaseException:
            try:
                if conn is not None:
                    conn.close()            # (before the lock goes: no half-open connection outlives it)
            finally:
                lock.release()
            raise

    @staticmethod
    def _connect(path):
        fd = os.open(path, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0), 0o600)
        os.close(fd)
        conn = sqlite3.connect(path, isolation_level=None)
        try:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=FULL")
            conn.execute("PRAGMA journal_size_limit=%d" % WAL_LIMIT_BYTES)
            page = conn.execute("PRAGMA page_size").fetchone()[0]
            conn.execute("PRAGMA max_page_count=%d" % (DB_CAP_BYTES // page))
        except BaseException:
            conn.close()
            raise
        return conn

    @staticmethod
    def _check(path, ident):
        """Why the existing database can't be used (damaged, another version, another pair), or None."""
        for suffix in ("",) + SIDECARS:
            try:
                if not _private_file(os.lstat(path + suffix)):
                    return "its record isn't a plain file of yours"     # (a link is set aside, never read through)
            except FileNotFoundError:
                pass
        try:
            # (read-only, so checking never changes it; the path quoted, as a URI's ? # % aren't a file name's)
            conn = sqlite3.connect("file:%s?mode=ro" % urllib.parse.quote(path), uri=True)
            try:
                if conn.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                    return "its record failed SQLite's integrity check"
                meta = dict(conn.execute("SELECT k, v FROM meta").fetchall())
            finally:
                conn.close()
        except sqlite3.DatabaseError:
            return "its record can't be read"
        if meta.get("version") != str(SCHEMA_VERSION):
            return "its record has an unknown version"
        try:
            theirs = json.loads(meta.get("ident", "null"))
        except (TypeError, ValueError):
            return "its record can't be read"
        if theirs != ident:
            return "its record belongs to another account or folder"
        return None

    @staticmethod
    def _init(conn, ident):
        conn.execute("BEGIN IMMEDIATE")
        conn.execute("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)")
        conn.execute("CREATE TABLE IF NOT EXISTS base (path TEXT PRIMARY KEY, sha256 TEXT NOT NULL, size INTEGER, "
                     "mtime_ns INTEGER, ctime_ns INTEGER, ino INTEGER, dev INTEGER, fid TEXT, snapshot INTEGER, "
                     "revision TEXT)")
        conn.execute("INSERT OR IGNORE INTO meta VALUES ('version', ?)", (str(SCHEMA_VERSION),))
        conn.execute("INSERT OR IGNORE INTO meta VALUES ('ident', ?)", (json.dumps(ident),))
        conn.execute("COMMIT")

    # ---- reading

    def rows(self):
        """{path: Row} of the whole base (the planner's B)."""
        out = {}
        for r in self.conn.execute("SELECT path, sha256, size, mtime_ns, ctime_ns, ino, dev, fid, snapshot, revision "
                                   "FROM base"):
            out[r[0]] = Row(r[1], r[2], r[3], r[4], r[5], r[6], r[7], bool(r[8]), r[9])
        return out

    def known(self):
        """{path: (stat key, sha256)} for the scan's hashing shortcut."""
        return {p: (r.key, r.sha256) for p, r in self.rows().items()}

    # ---- writing

    def _exec(self, sql, args=()):
        try:
            return self.conn.execute(sql, args)
        except sqlite3.OperationalError as e:
            if _full(e):
                raise StateFull(str(e))
            raise

    def _commit(self):
        try:
            self.conn.execute("COMMIT")
        except sqlite3.OperationalError as e:
            if _full(e):
                raise StateFull(str(e))
            raise
        self.commits += 1
        self.conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")

    def _begin(self):
        if not self.conn.in_transaction:
            self._exec("BEGIN IMMEDIATE")

    def _put(self, path, row):
        self._exec("INSERT OR REPLACE INTO base VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                   (path, row.sha256, row.size, row.mtime_ns, row.ctime_ns, row.ino, row.dev, row.fid,
                    int(row.snapshot), row.revision))

    def record(self, path, row):
        """A non-destructive action's row (row None: forget the path), committed with the next batch of 1,000."""
        self._begin()
        if row is None:
            self._exec("DELETE FROM base WHERE path = ?", (path,))
        else:
            self._put(path, row)
        self.pending += 1
        if self.pending >= BATCH:
            self.flush()

    def flush(self):
        """Commit the pending batch (at the end of a run, or when it stops)."""
        if self.conn.in_transaction:
            self._commit()
        self.pending = 0

    def begin_destructive(self, path):
        """Before a destructive action: the path's row is removed and committed (with any pending batch). Returns
        the old row, to put back with `undo_destructive` if the action is skipped."""
        old = self.rows_one(path)
        self._begin()
        self._exec("DELETE FROM base WHERE path = ?", (path,))
        self._commit()
        self.pending = 0
        return old

    def finish_destructive(self, path, row):
        """After a destructive action succeeded: its new row (None for a delete), committed."""
        self._begin()
        if row is not None:
            self._put(path, row)
        self._commit()

    def undo_destructive(self, path, old):
        """The action was skipped at its check: its old row back, committed."""
        self._begin()
        if old is not None:
            self._put(path, old)
        self._commit()

    def rows_one(self, path):
        r = self.conn.execute("SELECT sha256, size, mtime_ns, ctime_ns, ino, dev, fid, snapshot, revision FROM base "
                              "WHERE path = ?", (path,)).fetchone()
        return None if r is None else Row(r[0], r[1], r[2], r[3], r[4], r[5], r[6], bool(r[7]), r[8])

    def size_bytes(self):
        page = self.conn.execute("PRAGMA page_size").fetchone()[0]
        return page * self.conn.execute("PRAGMA page_count").fetchone()[0]

    def reserve_problem(self, free_bytes=None):
        """Before a destructive action (§2.5): None if the state filesystem has 64 MiB free and the database is 64 MiB
        under its cap; else the §1.2 message that leaves the action pending."""
        if self.size_bytes() > DB_CAP_BYTES - RESERVE_BYTES:
            return ("Not applied: fs-sync's record for this folder pair is nearly full (1 GiB). "
                    "Sync its subfolders as separate pairs instead.")
        free = free_bytes if free_bytes is not None else _free(self.path)
        if free < RESERVE_BYTES:
            return ("Not applied: fs-sync needs 64 MiB free in %s to record each deletion before making it, and only "
                    "%s is free." % (_home_short(_state_base(self.path)), _mib(free)))
        return None

    def close(self):
        try:
            if self.conn is not None:
                try:
                    self.flush()
                finally:
                    self.conn.close()
                    self.conn = None
        finally:
            self.lock.release()
