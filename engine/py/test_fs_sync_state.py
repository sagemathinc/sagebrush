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
            assert e.code == 1 and e.message == "another fs-sync of this folder is running", e.message
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
            assert b.damaged == "its record isn't a plain file" and b.rows() == {}, b.damaged
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
            except OSError:
                pass
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
