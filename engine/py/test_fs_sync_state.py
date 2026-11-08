#!/usr/bin/env python3
"""fs-sync's base (sagebrush/fs_sync/state.py; design/fs-sync.md §2.5, §4.3, §4.5): where it lives and its modes, one
run per pair, damaged or foreign records set aside (a first run), batched and bracketed commits and their bound, a
crash between a destructive action's commits, the cap (SQLITE_FULL), the write-ahead log truncated, and the space
checks with §1.2's words."""

import math
import os
import shutil
import sqlite3
import stat
import tempfile

from sagebrush.fs_sync import state as St
from sagebrush.fs_sync.state import Row

IDENT = ("acct", "grant1", "/home/x/thesis", "/Thesis")


def tmp():
    return tempfile.mkdtemp(prefix="sb-fs-state-")


def row(i, snapshot=False):
    return Row("%064x" % i, i, i, i, i, 1, "f%d" % i, snapshot, "r%d" % i if snapshot else None)


def outside_rows(path):
    """The rows another process would see now (only what was committed)."""
    c = sqlite3.connect("file:%s?mode=ro" % path, uri=True)
    try:
        return {r[0]: r[1] for r in c.execute("SELECT path, sha256 FROM base")}
    finally:
        c.close()


def test_where_and_modes():
    d = tmp()
    try:
        state = os.path.join(d, "state")
        b = St.Base.open(state, *IDENT)
        try:
            pairs = os.path.join(state, "pairs")
            assert stat.S_IMODE(os.stat(state).st_mode) == 0o700 and stat.S_IMODE(os.stat(pairs).st_mode) == 0o700
            assert os.path.basename(b.path) == St.pair_id(*IDENT) + ".sqlite"
            assert stat.S_IMODE(os.stat(b.path).st_mode) == 0o600
            assert b.damaged is None and b.rows() == {}
            # another pair gets another file
            assert St.pair_id(*IDENT) != St.pair_id("acct", "grant1", "/home/x/thesis", "/Other")
            for i in range(4):                                                   # every part of the pair counts
                assert St.pair_id(*(IDENT[:i] + ("other",) + IDENT[i + 1:])) != St.pair_id(*IDENT), i
            pragma = lambda name: b.conn.execute("PRAGMA " + name).fetchone()[0]
            assert pragma("journal_mode") == "wal" and pragma("synchronous") == 2           # 2 = FULL
            assert pragma("journal_size_limit") == St.WAL_LIMIT_BYTES
            b.record("s.ipynb", row(3, snapshot=True))
            b.flush()
            assert b.rows()["s.ipynb"] == row(3, snapshot=True) and b.rows()["s.ipynb"].snapshot is True
        finally:
            b.close()
    finally:
        shutil.rmtree(d)


def test_one_run_per_pair():
    d = tmp()
    try:
        b = St.Base.open(d, *IDENT)
        try:
            St.Base.open(d, *IDENT)
            raise AssertionError("a second run of the same pair was let in")
        except St.Refused as e:
            assert e.code == 1 and e.message == "Another fs-sync of this folder is running. Wait for it to finish, then run it again.", e.message
        other = St.Base.open(d, "acct", "grant1", "/home/x/thesis", "/Other")       # another pair: fine
        other.close()
        b.close()
        St.Base.open(d, *IDENT).close()                                                 # released: fine again
    finally:
        shutil.rmtree(d)


def test_batched_commits():
    d = tmp()
    try:
        b = St.Base.open(d, *IDENT)
        for i in range(St.BATCH - 1):
            b.record("f%d" % i, row(i))
        assert outside_rows(b.path) == {} and b.commits == 0           # nothing committed before 1,000
        b.record("f999", row(999))
        assert len(outside_rows(b.path)) == St.BATCH and b.commits == 1
        b.record("late", row(5000))
        b.record("f0", None)                                           # a forget is a record too
        b.close()                                                      # the end of the run commits the rest
        rows = outside_rows(b.path)
        assert "late" in rows and "f0" not in rows and len(rows) == St.BATCH
        b = St.Base.open(d, *IDENT)
        assert b.rows()["late"] == row(5000) and b.known()["late"] == (row(5000).key, row(5000).sha256)
        b.close()
        # (grader B4) each batch starts afresh: 2,500 rows are 2 commits, and the close makes the third
        b = St.Base.open(d, *IDENT)
        for i in range(2500):
            b.record("g%d" % i, row(i))
        assert b.commits == 2 and b.pending == 500, (b.commits, b.pending)
        b.close()
        assert b.commits == 3
    finally:
        shutil.rmtree(d)


def test_bracketed_destructive_and_bound():
    d = tmp()
    try:
        b = St.Base.open(d, *IDENT)
        for i in range(5):
            b.record("p%d" % i, row(i))
        b.flush()
        c0 = b.commits
        # a delete that succeeds: the row is gone, committed, before acting
        old = b.begin_destructive("p0")
        assert old == row(0) and "p0" not in outside_rows(b.path)
        b.finish_destructive("p0", None)
        # a replacing download: cleared before, the new row after
        b.begin_destructive("p1")
        assert "p1" not in outside_rows(b.path)
        b.finish_destructive("p1", row(101))
        assert outside_rows(b.path)["p1"] == row(101).sha256
        # skipped at its check: the old row back
        old = b.begin_destructive("p2")
        b.undo_destructive("p2", old)
        assert outside_rows(b.path)["p2"] == row(2).sha256
        # the bound: 3 destructive actions, 3 non-destructive (a = 6): at most 3d + ceil(a/1000) + 1 commits
        for i in range(3):
            b.record("n%d" % i, row(200 + i))
        b.close()
        d_, a = 3, 6
        assert b.commits - c0 <= 3 * d_ + math.ceil(a / 1000) + 1, b.commits - c0
        # a pending batch rides the destructive action's first commit (nothing waits behind it)
        b = St.Base.open(d, *IDENT)
        b.record("x", row(7))
        b.begin_destructive("p3")
        assert "x" in outside_rows(b.path) and b.pending == 0
        b.close()
    finally:
        shutil.rmtree(d)


def test_crash_between_commits_leaves_no_base():
    # the run dies after the pre-action commit: the next run finds no row there, so nothing is deleted on its strength
    d = tmp()
    try:
        b = St.Base.open(d, *IDENT)
        b.record("victim", row(1))
        b.flush()
        b.begin_destructive("victim")
        b.conn.close()                          # (a crash: no finish, no close)
        b.conn = None
        b.lock.release()
        b2 = St.Base.open(d, *IDENT)
        assert "victim" not in b2.rows()
        b2.close()
    finally:
        shutil.rmtree(d)


def test_damaged_or_foreign_is_set_aside():
    reasons = {"garbage": "its record can't be read", "integrity": "its record failed SQLite's integrity check",
               "version": "its record has an unknown version", "foreign": "its record belongs to another account or folder",
               "sidecars": None}
    for kind in reasons:
        d = tmp()
        try:
            b = St.Base.open(d, *IDENT)
            b.record("a", row(1))
            for i in range(3000):
                b.record("p%05d" % i, row(i))
            b.record("zz-last-row", row(7))
            path = b.path
            b.close()
            if kind == "integrity":
                # one key byte changed inside its page: the table and its index disagree, the file still opens
                with open(path, "r+b") as f:
                    data = f.read()
                    f.seek(data.rindex(b"zz-last-row") + 10)
                    f.write(b"x")
            elif kind == "sidecars":
                c = sqlite3.connect(path)
                c.execute("UPDATE meta SET v = '999' WHERE k = 'version'")
                c.commit()
                c.close()
                for suffix in ("-wal", "-shm"):
                    with open(path + suffix, "wb") as f:
                        f.write(b"stale")
            elif kind == "garbage":
                with open(path, "r+b") as f:
                    f.seek(100)
                    f.write(b"\xff" * 4000)
            elif kind == "version":
                c = sqlite3.connect(path)
                c.execute("UPDATE meta SET v = '999' WHERE k = 'version'")
                c.commit()
                c.close()
            else:
                other = os.path.join(os.path.dirname(path), St.pair_id(*IDENT[:3], "/Other") + ".sqlite")
                shutil.copyfile(path, other)
                os.chmod(other, 0o600)                                  # (private, as fs-sync makes its records)
                path = other
            ident = IDENT if kind != "foreign" else IDENT[:3] + ("/Other",)
            b = St.Base.open(d, *ident)
            try:
                assert b.damaged and b.rows() == {}, (kind, b.damaged)
                assert reasons[kind] in (None, b.damaged), (kind, b.damaged)
                aside = [n for n in os.listdir(os.path.dirname(path)) if ".damaged-" in n]
                assert aside, os.listdir(os.path.dirname(path))
                if kind == "sidecars":                                   # its log and index go with it
                    assert any(n.endswith("-wal") for n in aside) and any(n.endswith("-shm") for n in aside), aside
            finally:
                b.close()
        finally:
            shutil.rmtree(d)


def test_only_the_latest_set_aside_base_is_kept():
    # (@sagebrush's ruling on sync-client's D1) a version flip-flop sets a base aside every run: only the latest stays
    d = tmp()
    try:
        pairs = os.path.join(d, "pairs")
        os.makedirs(pairs, mode=0o700)
        bystander = os.path.join(pairs, St.pair_id(*IDENT[:3], "/Other") + ".sqlite.damaged-1")
        with open(bystander, "wb") as f:
            f.write(b"another pair's")
        for i in range(3):
            b = St.Base.open(d, *IDENT)
            b.record("a%d" % i, row(i))
            path = b.path
            b.close()
            with open(path + "-wal", "wb") as f:              # (its log goes aside with it, under the same name)
                f.write(b"stale")
            c = sqlite3.connect(path)
            c.execute("UPDATE meta SET v = '999' WHERE k = 'version'")
            c.commit()
            c.close()
            St.Base.open(d, *IDENT).close()
            aside = sorted(n for n in os.listdir(pairs) if n.startswith(os.path.basename(path) + ".damaged-"))
            assert len([n for n in aside if n[-1].isdigit()]) == 1, aside             # one base (the -wal beside it)
            stamp = aside[0].split(".damaged-")[1].split("-")[0]
            assert all(n.split(".damaged-")[1].split("-")[0] == stamp for n in aside), aside   # one name for all its files
        assert os.path.exists(bystander)
    finally:
        shutil.rmtree(d)


def test_cap_and_wal():
    d = tmp()
    try:
        b = St.Base.open(d, *IDENT)
        b.record("a", row(1))
        b.flush()
        assert os.path.getsize(b.path + "-wal") == 0          # truncated after each commit
        page = b.conn.execute("PRAGMA page_size").fetchone()[0]
        cap = b.conn.execute("PRAGMA max_page_count").fetchone()[0]
        assert cap * page == St.DB_CAP_BYTES
        b.conn.execute("PRAGMA max_page_count=%d" % (b.size_bytes() // page + 2))
        try:
            for i in range(100000):
                b.record("big%d" % i, Row("x" * 64, fid="y" * 500))
            b.flush()
            raise AssertionError("no SQLITE_FULL")
        except St.StateFull:
            pass
        b.conn.rollback() if b.conn.in_transaction else None
        b.close()
        # (grader C2) a full filesystem at COMMIT (a log that can't grow) stops the run the same way (a seam)
        b = St.Base.open(d, *IDENT)
        real = b.conn

        class FullAtCommit:
            in_transaction = property(lambda self: real.in_transaction)

            def execute(self, sql, *args):
                if sql == "COMMIT":
                    raise sqlite3.OperationalError("database or disk is full")
                return real.execute(sql, *args)
        b.conn = FullAtCommit()
        b.record("x", row(1))
        try:
            b.flush()
            raise AssertionError("a full disk at COMMIT wasn't StateFull")
        except St.StateFull:
            pass
        finally:
            b.conn = real
        real.rollback()
        b.close()
    finally:
        shutil.rmtree(d)


def test_state_folder_refusals():
    d = tmp()
    try:
        state = os.path.join(d, "state")
        os.makedirs(state, mode=0o755)
        os.chmod(state, 0o755)
        St.Base.open(state, *IDENT).close()
        assert stat.S_IMODE(os.stat(state).st_mode) == 0o700                     # tightened, not trusted
        real = os.path.join(d, "real")
        os.mkdir(real, 0o700)
        link = os.path.join(d, "link")
        os.symlink(real, link)
        try:
            St.Base.open(link, *IDENT)
            raise AssertionError("a linked state folder was used")
        except St.Refused as e:
            assert e.code == 1 and e.message.endswith("isn't a folder of yours: fs-sync keeps its records there."), e.message
        assert os.listdir(real) == []
        saved = os.getuid
        os.getuid = lambda: saved() + 1                                           # (a folder someone else owns)
        try:
            St.Base.open(state, *IDENT)
            raise AssertionError("another user's state folder was used")
        except St.Refused as e:
            assert "isn't a folder of yours" in e.message
        finally:
            os.getuid = saved
    finally:
        shutil.rmtree(d)


def test_links_and_a_failed_open():
    d = tmp()
    try:
        b = St.Base.open(d, *IDENT)
        b.record("a", row(1))
        path = b.path
        b.close()
        pairs = os.path.dirname(path)
        # a record that is a link: set aside (the link itself), never read through, its target untouched
        elsewhere = os.path.join(d, "elsewhere.sqlite")
        os.rename(path, elsewhere)
        os.symlink(elsewhere, path)
        b = St.Base.open(d, *IDENT)
        try:
            assert b.damaged == "its record isn't a plain file of yours" and b.rows() == {}, b.damaged
            assert not os.path.islink(path)
        finally:
            b.close()
        assert outside_rows(elsewhere) == {"a": row(1).sha256}
        # the database and the lock are opened no-follow
        link = os.path.join(d, "db-link")
        os.symlink(os.path.join(d, "target"), link)
        for opener in (St.Base._connect, St.Lock):
            try:
                opener(link)
                raise AssertionError("followed a link: %r" % opener)
            except (OSError, St.Refused) as e:
                assert not isinstance(e, St.Refused) or "isn't a plain file of yours" in e.message, e.message
            assert not os.path.exists(os.path.join(d, "target"))
        # an open that fails after taking the lock releases it
        saved = St.Base._init
        St.Base._init = staticmethod(lambda conn, ident: (_ for _ in ()).throw(RuntimeError("boom")))
        try:
            St.Base.open(d, *IDENT)
            raise AssertionError("no failure")
        except RuntimeError:
            pass
        finally:
            St.Base._init = saved
        St.Base.open(d, *IDENT).close()                                             # not left locked
        # (astra S3) a connection half set up is closed before the lock goes: in _connect's setup and after _init's BEGIN
        real_connect, made = sqlite3.connect, []

        def tracking(*a, **k):
            made.append(real_connect(*a, **k))
            return made[-1]
        saved_cap = St.DB_CAP_BYTES
        for fail in ("connect", "init"):
            made.clear()
            St.sqlite3.connect = tracking
            if fail == "connect":
                St.DB_CAP_BYTES = None                       # (the last PRAGMA's arithmetic fails, after the others)
            else:
                St.Base._init = staticmethod(lambda conn, ident: (conn.execute("BEGIN IMMEDIATE"),
                                                                  (_ for _ in ()).throw(RuntimeError("boom"))))
            try:
                St.Base.open(d, *IDENT)
                raise AssertionError("no failure")
            except (TypeError, RuntimeError):
                pass
            finally:
                St.sqlite3.connect, St.DB_CAP_BYTES, St.Base._init = real_connect, saved_cap, saved
            opened = made[-1]
            try:
                opened.execute("SELECT 1")
                raise AssertionError("left open after a failed %s" % fail)
            except sqlite3.ProgrammingError:
                pass
            St.Lock(os.path.join(pairs, St.pair_id(*IDENT) + ".lock")).release()   # and the lock is free
    finally:
        shutil.rmtree(d)


def test_folder_chain_policy():
    # (astra, @sagebrush) who may change a folder above fs-sync's own: decided on the folder's owner, mode and group
    import grp
    import pwd
    from types import SimpleNamespace as NS
    me, uid = pwd.getpwuid(os.getuid()).pw_name, os.getuid()
    real_getgrgid, real_getpwall = grp.getgrgid, pwd.getpwall
    groups = {500: ["someone"], 501: [], 502: [me]}
    others = [NS(pw_name="other", pw_uid=uid + 1, pw_gid=501)]
    grp.getgrgid = lambda g: NS(gr_mem=groups[g])                       # (KeyError for an unknown group)
    pwd.getpwall = lambda: [NS(pw_name=me, pw_uid=uid, pw_gid=502)] + others
    try:
        ok = lambda mode, owner=uid, gid=502: St._unchangeable(NS(st_mode=stat.S_IFDIR | mode, st_uid=owner, st_gid=gid))
        assert ok(0o755) and ok(0o755, owner=0)                         # ours or root's, writable by no one else
        assert ok(0o775, gid=502)                                       # group write, a group private to us
        assert not ok(0o775, gid=500)                                   # a group with another member
        assert not ok(0o775, gid=501)                                   # another account's primary group
        assert not ok(0o775, gid=503)                                   # a group that can't be looked up
        assert ok(0o1777, owner=0) and not ok(0o777, owner=0)           # other write: only root's and sticky (/tmp)
        assert not ok(0o1777)                                           # sticky but ours: not trusted for others' write
        assert not ok(0o755, owner=uid + 1)                             # someone else's
        assert not St._unchangeable(NS(st_mode=stat.S_IFLNK | 0o755, st_uid=uid, st_gid=502))   # not a folder
        # the records: plain files of ours, private
        f = lambda mode, owner=uid: St._private_file(NS(st_mode=mode, st_uid=owner))
        assert f(stat.S_IFREG | 0o600) and not f(stat.S_IFREG | 0o640) and not f(stat.S_IFREG | 0o600, owner=uid + 1)
        assert not f(stat.S_IFLNK | 0o600) and not f(stat.S_IFIFO | 0o600)
    finally:
        grp.getgrgid, pwd.getpwall = real_getgrgid, real_getpwall


def test_folder_chain_on_disk():
    d = tmp()
    try:
        # missing folders are made one level at a time, 0700
        state = os.path.join(d, "x", "y", "state")
        St.Base.open(state, *IDENT).close()
        for p in (os.path.join(d, "x"), os.path.join(d, "x", "y"), state, os.path.join(state, "pairs")):
            assert stat.S_IMODE(os.stat(p).st_mode) == 0o700, p
        # an ancestor others can write to (not sticky): refused, naming it
        open_dir = os.path.join(d, "open")
        os.mkdir(open_dir)
        os.chmod(open_dir, 0o757)
        try:
            St.Base.open(os.path.join(open_dir, "state"), *IDENT)
            raise AssertionError("an ancestor others can write to was trusted")
        except St.Refused as e:
            assert e.message == "%s isn't a folder of yours: fs-sync keeps its records there." % St._home_short(open_dir), e.message
        assert not os.path.exists(os.path.join(open_dir, "state"))
        # a link among the ancestors, from a checked folder: its real path is checked too
        good, link = os.path.join(d, "good"), os.path.join(d, "via")
        os.mkdir(good, 0o700)
        os.symlink(good, link)
        St.Base.open(os.path.join(link, "state"), *IDENT).close()
        assert os.path.isdir(os.path.join(good, "state", "pairs"))
        os.unlink(link)
        os.symlink(open_dir, link)                                   # to a folder others can write to: refused
        try:
            St.Base.open(os.path.join(link, "state"), *IDENT)
            raise AssertionError("a link to a folder others can write to was trusted")
        except St.Refused as e:
            assert "isn't a folder of yours" in e.message
        os.unlink(link)
        os.symlink(os.path.join(d, "nowhere"), link)                 # a link to nothing: refused, not a crash
        try:
            St.Base.open(os.path.join(link, "state"), *IDENT)
            raise AssertionError("a dangling link was trusted")
        except St.Refused as e:
            assert "isn't a folder of yours" in e.message
        assert not os.path.exists(os.path.join(d, "nowhere"))
        # fs-sync's own folders are exactly 0700, whatever they were (looser, or tighter)
        for mode in (0o711, 0o500):
            os.chmod(state, mode)
            St.Base.open(state, *IDENT).close()
            assert stat.S_IMODE(os.stat(state).st_mode) == 0o700, oct(mode)
        # "/" is checked like every other folder (a seam: "/" taken as changeable by others)
        saved, root_ino = St._unchangeable, os.lstat("/").st_ino
        St._unchangeable = lambda st: st.st_ino != root_ino and saved(st)
        try:
            St.Base.open(state, *IDENT)
            raise AssertionError("/ wasn't checked")
        except St.Refused as e:
            assert e.message.startswith("/ isn't a folder of yours"), e.message
        finally:
            St._unchangeable = saved
        # one of fs-sync's own folders someone else owns (a seam past the chain): refused by its own check
        saved_anc, saved_uid = St._ancestors, os.getuid
        St._ancestors = lambda p: os.path.abspath(p)
        os.getuid = lambda: saved_uid() + 1
        try:
            St.Base.open(state, *IDENT)
            raise AssertionError("someone else's state folder was used")
        except St.Refused as e:
            assert e.message == "%s isn't a folder of yours: fs-sync keeps its records there." % St._home_short(state), e.message
        finally:
            St._ancestors, os.getuid = saved_anc, saved_uid
    finally:
        os.chmod(os.path.join(d, "open"), 0o700) if os.path.isdir(os.path.join(d, "open")) else None
        shutil.rmtree(d)


def test_records_must_be_private_plain_files():
    d = tmp()
    try:
        b = St.Base.open(d, *IDENT)
        b.record("a", row(1))
        path = b.path
        b.close()
        pairs = os.path.dirname(path)
        target = os.path.join(d, "target")
        # a sidecar that is a link (each of -wal, -shm, -journal): the base is set aside, the link never followed
        for suffix in ("-wal", "-shm", "-journal"):
            with open(target, "wb") as f:
                f.write(b"keep")
            os.symlink(target, path + suffix)
            b = St.Base.open(d, *IDENT)
            try:
                assert b.damaged == "its record isn't a plain file of yours", (suffix, b.damaged)
            finally:
                b.close()
            with open(target, "rb") as f:
                assert f.read() == b"keep"
            for n in os.listdir(pairs):                              # (start the next case clean)
                if ".damaged-" in n:
                    os.unlink(os.path.join(pairs, n))
        # a record readable by others: not private, set aside
        os.chmod(path, 0o644)
        b = St.Base.open(d, *IDENT)
        assert b.damaged == "its record isn't a plain file of yours", b.damaged
        b.close()
        # sidecars left without their database: removed (fs-sync's own), a link among them not followed
        os.unlink(path)
        for suffix in ("-wal", "-shm"):
            if os.path.lexists(path + suffix):
                os.unlink(path + suffix)
        for suffix in ("-wal", "-shm", "-journal"):
            os.symlink(target, path + suffix)
        St.Base.open(d, *IDENT).close()
        for suffix in ("-wal", "-shm"):                              # (SQLite would open these through the link)
            assert not os.path.islink(path + suffix), suffix
        assert not os.path.lexists(path + "-journal")
        with open(target, "rb") as f:
            assert f.read() == b'keep'
        # the lock: a folder there is refused, saying what to do
        lock = path[:-len(".sqlite")] + ".lock"
        os.unlink(lock)
        os.mkdir(lock)
        try:
            St.Base.open(d, *IDENT)
            raise AssertionError("a folder was taken as the lock")
        except St.Refused as e:
            assert e.code == 1 and e.message == ("%s isn't a plain file of yours: fs-sync keeps this folder pair's lock "
                                                 "there. Remove it, then run it again." % St._home_short(lock)), e.message
        os.rmdir(lock)
        # a lock readable by others, or a FIFO there: refused the same way (checked through the open handle)
        for make in (lambda: (open(lock, "wb").close(), os.chmod(lock, 0o644)), lambda: os.mkfifo(lock, 0o600)):
            make()
            try:
                St.Base.open(d, *IDENT)
                raise AssertionError("a lock that isn't a private plain file was used")
            except St.Refused as e:
                assert "isn't a plain file of yours" in e.message, e.message
            os.unlink(lock)
        # (astra) metadata that isn't JSON: can't be read, so a first run
        St.Base.open(d, *IDENT).close()
        c = sqlite3.connect(path)
        c.execute("UPDATE meta SET v = '{not json' WHERE k = 'ident'")
        c.commit()
        c.close()
        b = St.Base.open(d, *IDENT)
        assert b.damaged == "its record can't be read", b.damaged
        b.close()
    finally:
        shutil.rmtree(d)


def test_state_path_with_uri_characters():
    # (astra) the read-only check's URI is quoted: a state folder named with ? # % is the folder used
    d = tmp()
    try:
        state = os.path.join(d, "a?b#c%41")
        b = St.Base.open(state, *IDENT)
        b.record("a", row(1))
        b.close()
        b = St.Base.open(state, *IDENT)
        try:
            assert b.damaged is None and "a" in b.rows(), b.damaged
        finally:
            b.close()
    finally:
        shutil.rmtree(d)


def test_space_checks():
    d = tmp()
    saved = os.environ.get("HOME")
    try:
        os.environ["HOME"] = os.path.realpath(d)
        state = os.path.join(os.path.realpath(d), ".local", "state", "sagebrush", "fs-sync")
        try:
            St.admit_scan(state, free_bytes=300 * 2**20)
            raise AssertionError("admitted with 300 MiB free")
        except St.Refused as e:
            assert e.code == 1 and e.message == ("Not enough free space for fs-sync's records: it needs 2.1 GiB free in "
                                                 "~, and 300 MiB is free. Free some space and run it again."), e.message
        St.admit_scan(state, free_bytes=St.SCAN_FREE_BYTES)                          # exactly enough
        try:
            St.admit_scan(state, free_bytes=St.SCAN_FREE_BYTES - 1)                  # (grader S1) a byte short
            raise AssertionError("admitted a byte short")
        except St.Refused:
            pass
        b = St.Base.open(state, *IDENT)
        try:
            assert b.reserve_problem(free_bytes=St.RESERVE_BYTES) is None
            assert b.reserve_problem(free_bytes=St.RESERVE_BYTES - 1).endswith("only 63 MiB is free.")
            assert b.reserve_problem(free_bytes=20 * 2**20) == ("Not applied: fs-sync needs 64 MiB free in ~/.local/state "
                                                               "to record each deletion before making it, and only 20 MiB is free.")
            saved_cap = St.DB_CAP_BYTES
            St.DB_CAP_BYTES = b.size_bytes() + St.RESERVE_BYTES - 1
            try:
                assert b.reserve_problem(free_bytes=10**12) == ("Not applied: fs-sync's record for this folder pair is "
                                                               "nearly full (1 GiB). Sync its subfolders as separate pairs instead.")
            finally:
                St.DB_CAP_BYTES = saved_cap
        finally:
            b.close()
    finally:
        if saved is None:
            os.environ.pop("HOME", None)
        else:
            os.environ["HOME"] = saved
        shutil.rmtree(d)


if __name__ == "__main__":
    for name, f in list(globals().items()):
        if name.startswith("test_") and callable(f):
            f()
            print("ok", name)
    print("all fs-sync state tests passed")
