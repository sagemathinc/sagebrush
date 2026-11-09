#!/usr/bin/env python3
"""fs-sync's holding folder (sagebrush/fs_sync/holding.py; design/fs-sync.md §2.4): run ids made unique by an
exclusive mkdir, what is held counted in entries by a streaming bounded walk that fails closed, all-or-nothing
admission counting the run's files and new folders, one run at a time (the trash/ lock), and the cleanup of runs
older than 30 days after a complete count. Every bound is lowered here; no large fixtures."""

import os
import re
import shutil
import stat
import tempfile
import time

from sagebrush.fs_sync import holding as H

NOW = 1_794_200_000                 # a fixed "now" (November 2026, UTC)
DAY = 86400


def tmp():
    return os.path.realpath(tempfile.mkdtemp(prefix="sb-fs-hold-"))


def state():
    d = tmp()
    s = os.path.join(d, "state")
    os.mkdir(s, 0o700)
    os.mkdir(os.path.join(s, "trash"), 0o700)
    return d, s


def put(path, data=b""):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)


class Lowered:
    """Bounds lowered for one test, put back after."""

    def __init__(self, **kw):
        self.kw, self.saved = kw, {k: getattr(H, k) for k in kw}

    def __enter__(self):
        for k, v in self.kw.items():
            setattr(H, k, v)

    def __exit__(self, *a):
        for k, v in self.saved.items():
            setattr(H, k, v)


def cleanup(s, now):
    """A run's cleanup, under its own Session (as a run does it first)."""
    with H.Session.open(s) as session:
        return session.cleanup(now)


def open_fds():
    return len(os.listdir("/dev/fd"))


def test_run_ids():
    rid = H.run_id_at(NOW)
    assert rid == time.strftime("%Y%m%d-%H%M%S", time.gmtime(NOW)) and re.fullmatch(r"[0-9]{8}-[0-9]{6}", rid)
    saved_tz = os.environ.get("TZ")                                    # (grader H6) UTC, whatever the local zone
    os.environ["TZ"] = "Asia/Tokyo"
    time.tzset()
    try:
        assert time.strftime("%H", time.localtime(NOW)) != time.strftime("%H", time.gmtime(NOW))
        assert H.run_id_at(NOW) == rid and H.run_time(rid) == NOW
    finally:
        if saved_tz is None:
            os.environ.pop("TZ", None)
        else:
            os.environ["TZ"] = saved_tz
        time.tzset()
    assert H.run_time(rid) == NOW and H.run_time(rid + "-2") == NOW and H.run_time(rid + "-9") == NOW
    for bad in (rid[:-2], "20261399-000000", rid + "-1", rid + "-10", "x" + rid, rid + "\n", "notes"):
        assert H.run_time(bad) is None, bad
    d, s = state()
    try:
        ids = []
        for _ in range(3):                                   # the same second: unique, by an exclusive mkdir
            h = H.new_run(s, NOW)
            ids.append(h.run_id)
            h.close()
        assert ids == [rid, rid + "-2", rid + "-3"], ids
        assert stat.S_IMODE(os.stat(os.path.join(s, "trash", ids[1])).st_mode) == 0o700
        for n in range(4, 10):
            os.mkdir(os.path.join(s, "trash", "%s-%d" % (rid, n)))
        try:
            H.new_run(s, NOW)
            raise AssertionError("an eleventh run in one second was given an id")
        except FileExistsError:
            pass
        with Lowered(MAX_SAME_SECOND=2):                     # the bound lowered: the third id in a second refused
            a, b = H.new_run(s, NOW + 1), H.new_run(s, NOW + 1)
            assert (a.run_id, b.run_id) == (H.run_id_at(NOW + 1), H.run_id_at(NOW + 1) + "-2")
            a.close()
            b.close()
            try:
                H.new_run(s, NOW + 1)
                raise AssertionError("past the lowered bound")
            except FileExistsError:
                pass
    finally:
        shutil.rmtree(d)


def test_usage_counts_entries():
    d, s = state()
    try:
        trash = os.path.join(s, "trash")
        put(os.path.join(trash, "r1", "a", "b.txt"), b"x" * 10)        # r1, a, b.txt
        put(os.path.join(trash, "r1", "c.txt"), b"y" * 5)              # c.txt
        os.makedirs(os.path.join(trash, "r2", "e1", "e2"))              # empty folders count: r2, e1, e2
        outside = os.path.join(d, "big")
        put(outside, b"q" * 100000)
        os.symlink(outside, os.path.join(trash, "r2", "link"))         # a link: counted as itself, never followed
        link_size = os.lstat(os.path.join(trash, "r2", "link")).st_size
        assert H.usage(s) == (15 + link_size, 8), H.usage(s)
        with Lowered(TOTAL_ENTRIES=8):
            assert H.usage(s)[1] == 8                                  # at the bound: counted
        with Lowered(TOTAL_ENTRIES=7):                                 # one over, counting empty folders: refused
            try:
                H.usage(s)
                raise AssertionError("counted past the bound")
            except H.Uncountable as e:
                assert e.bound and e.detail == "more than 7 entries", e.detail
            a = H.admit(s, [])                                         # (admission: past a bound, not an error)
            assert not a.ok and a.reason == "total-entries" and a.detail == "more than 7 entries", a
    finally:
        shutil.rmtree(d)


def test_depth_is_the_scans_64_below_the_run():
    # HOLD_LEVELS is handle levels: trash/, the run folder, its part, then the mirror's folders (64 in the product)
    assert H.HOLD_LEVELS == 3 + 64
    d, s = state()
    try:
        with Lowered(HOLD_LEVELS=3 + 3):                               # the mirror's bound lowered to 3 folders
            put(os.path.join(s, "trash", "run", "deleted", "f1", "f2", "f3", "x.txt"), b"x")
            assert H.usage(s)[1] == 6                                  # run, deleted, f1-f3, x.txt: 3 deep, counted
            os.mkdir(os.path.join(s, "trash", "run", "deleted", "f1", "f2", "f3", "f4"))
            before = open_fds()
            try:
                H.usage(s)                                             # 4: refused
                raise AssertionError("counted past the depth bound")
            except H.Uncountable as e:
                assert e.bound and e.detail == "more than 3 levels of folders", e.detail
            assert open_fds() == before                                # every level's handle closed, refused or not
    finally:
        shutil.rmtree(d)


def test_walk_holds_handles_by_depth_not_width():
    # (daybreak2) at most 2 descriptors per level, trash/'s own handle the first: exactly 2 x levels at the deepest
    d, s = state()
    try:
        trash = os.path.join(s, "trash")
        for i in range(60):                                            # a wide tree: trash/, run, w00..w59 = 3 levels
            put(os.path.join(trash, "run", "w%02d" % i, "f.txt"), b"f")
        before, peak = open_fds(), [0]
        real_scandir = os.scandir

        def sampling(fd):
            it = real_scandir(fd)                                      # (its copy of the handle is open now)
            peak[0] = max(peak[0], open_fds())                         # (/dev/fd's own handle is in `before` too)
            return it
        os.scandir = sampling
        try:
            assert H.usage(s)[1] == 1 + 60 * 2
        finally:
            os.scandir = real_scandir
        assert peak[0] - before == 2 * 3, (before, peak[0])            # never one per sibling, never one extra
        assert open_fds() == before                                    # and all closed after
    finally:
        shutil.rmtree(d)


def test_uncountable_fails_closed():
    d, s = state()
    try:
        trash = os.path.join(s, "trash")
        put(os.path.join(trash, "run", "ok.txt"), b"x")
        if os.geteuid() != 0:                                          # an unreadable folder
            os.makedirs(os.path.join(trash, "run", "locked"))
            os.chmod(os.path.join(trash, "run", "locked"), 0)
            try:
                a = H.admit(s, [("a.txt", 1)])
                assert not a.ok and a.reason == "holding-unreadable" and a.detail, a
                old = os.path.join(trash, H.run_id_at(NOW - 40 * DAY))
                put(os.path.join(old, "f.txt"), b"f")
                assert cleanup(s, NOW) == [] and os.path.isdir(old)  # nothing removed from a partly counted tree
                shutil.rmtree(old)
            finally:
                os.chmod(os.path.join(trash, "run", "locked"), 0o700)
        real_scandir, calls = os.scandir, [0]                           # an error part way (a seam), any user

        def failing(fd):
            calls[0] += 1
            if calls[0] == 2:
                raise OSError(5, "Input/output error")
            return real_scandir(fd)
        os.makedirs(os.path.join(trash, "run", "sub"), exist_ok=True)
        before = open_fds()
        os.scandir = failing
        try:
            a = H.admit(s, [("a.txt", 1)])
        finally:
            os.scandir = real_scandir
        assert not a.ok and a.reason == "holding-unreadable" and a.detail == "[Errno 5] Input/output error", a
        os.scandir, calls[0] = failing, 0                               # (grader A9) and under a Session too
        try:
            with H.Session.open(s) as session:
                r = session.admit([("a.txt", 1)])
        finally:
            os.scandir = real_scandir
        assert not r.ok and r.reason == "holding-unreadable", r
        assert open_fds() == before
        assert H.not_applied(a, "~/thesis", "~/t") == ("Not applied: deleting or replacing files in ~/thesis. fs-sync "
                                                       "couldn't measure its holding folder (~/t): [Errno 5] "
                                                       "Input/output error.")
        saved = os.getuid                                               # an entry not ours (an owner seam)
        real_trash = H._trash
        H._trash = lambda st: os.open(trash, os.O_RDONLY | os.O_DIRECTORY)
        os.getuid = lambda: saved() + 1
        try:
            a = H.admit(s, [("a.txt", 1)])
            assert not a.ok and a.reason == "holding-unreadable", a
        finally:
            os.getuid, H._trash = saved, real_trash
    finally:
        shutil.rmtree(d)


def test_admission_counts_files_and_new_folders():
    assert H.run_entries(["a.txt", "n/b.txt", "n/c.txt", "n/m/d.txt"]) == 4 + 2     # files, and folders n, n/m
    d, s = state()
    try:
        put(os.path.join(s, "trash", "held", "h.txt"), b"h" * 40)      # 40 bytes, 2 entries held
        with Lowered(RUN_BYTES=50, RUN_ENTRIES=5, TOTAL_BYTES=100, TOTAL_ENTRIES=10):
            # (sync-client) the run's bound counts its run folder: 3 files + folder a + the run folder = 5, at the bound
            ok = H.admit(s, [("a/x.txt", 20), ("a/y.txt", 20), ("z.txt", 10)])
            assert ok.ok and (ok.bytes, ok.entries, ok.held_bytes, ok.held_entries) == (50, 5, 40, 2), ok
            assert H.admit(s, [("a/x.txt", 20), ("a/y.txt", 20), ("z.txt", 11)]).reason == "run-bytes"
            # one more folder makes one entry too many, with no more files (astra)
            assert H.admit(s, [("a/x.txt", 1), ("b/y.txt", 1), ("z.txt", 1)]).reason == "run-entries"
        with Lowered(RUN_BYTES=100, RUN_ENTRIES=100, TOTAL_BYTES=100, TOTAL_ENTRIES=10):
            assert H.admit(s, [("x", 60)]).ok                           # the total at its bound (40 + 60)
            assert H.admit(s, [("x", 61)]).reason == "total-bytes"      # one byte over
            assert H.admit(s, [("f/a", 1), ("f/b", 1), ("f/c", 1), ("f/d", 1), ("f/e", 1), ("f/g", 1),
                               ("f/h", 1)]).ok                          # 2 held + 7 files + folder f = 10
            assert H.admit(s, [("f/a", 1), ("f/b", 1), ("f/c", 1), ("f/d", 1), ("f/e", 1), ("f/g", 1),
                               ("f/h", 1), ("f/i", 1)]).reason == "total-entries"
        assert H.admit(s, []).ok
    finally:
        shutil.rmtree(d)


def test_the_words():
    # (board, design §2.4) word for word, with the product's numbers
    local, trash = "~/thesis", "~/.local/state/sagebrush/fs-sync/trash"
    assert H.not_applied(H.Admission(False, "busy"), local, trash) == (
        "Not applied: deleting or replacing files in ~/thesis, while another fs-sync moves files into the holding "
        "folder. Run it again when that one finishes.")
    assert H.not_applied(H.Admission(False, "total-entries", detail="more than 200,000 entries"), local, trash) == (
        "Not applied: deleting or replacing files in ~/thesis. fs-sync's holding folder "
        "(~/.local/state/sagebrush/fs-sync/trash) has more than 200,000 entries or 64 levels of folders, too many to "
        "measure. Each sync's folder there is removed 30 days after that sync.")
    assert H.not_applied(H.Admission(False, "holding-unreadable", detail="Permission denied"), local, trash) == (
        "Not applied: deleting or replacing files in ~/thesis. fs-sync couldn't measure its holding folder "
        "(~/.local/state/sagebrush/fs-sync/trash): Permission denied.")
    # an admission over the bounds once counted, and the run's own bounds, are worded by the apply step
    for reason in ("total-entries", "total-bytes", "run-entries", "run-bytes"):
        assert H.not_applied(H.Admission(False, reason), local, trash) is None
    assert H.not_applied(H.Admission(True), local, trash) is None


def test_the_run_folder_counts_in_the_runs_own_bound():
    # (astra, sync-client, @sagebrush) with a real new_run: its folder is one of the run's own entries, and the total
    # counts it once (as held)
    d, s = state()
    try:
        h = H.new_run(s, NOW)
        h.close()
        with Lowered(RUN_ENTRIES=4, TOTAL_ENTRIES=4):
            at = H.admit(s, [("x/a", 1), ("x/b", 1)])                  # 2 files + folder x + the run folder = 4
            assert at.ok and at.entries == 4 and at.held_entries == 1, at
            over = H.admit(s, [("x/a", 1), ("x/b", 1), ("x/c", 1)])    # one more: 5
            assert over.reason == "run-entries" and over.entries == 5, over
    finally:
        shutil.rmtree(d)


def test_one_run_at_a_time():
    # (daybreak3's order) one Session per run: cleanup first, then its run folder and admission, held to the end
    d, s = state()
    try:
        old = os.path.join(s, "trash", H.run_id_at(NOW - 40 * DAY))
        put(os.path.join(old, "f.txt"), b"f")
        first = H.Session.open(s)
        assert first is not None
        assert H.Session.open(s) is None                               # another pair's run, meanwhile: busy
        assert first.cleanup(NOW) == [os.path.basename(old)]           # cleanup first, under the lock
        h = first.new_run(NOW)
        assert first.admit([("a", 10)]).ok
        h.close()
        first.close()
        first.close()                                                  # (twice: harmless)
        with H.Session.open(s) as again:                               # released: the next run gets it
            # admission refused before any move: the run's empty folder is removed, under the lock
            h = again.new_run(NOW + 1)
            with Lowered(RUN_BYTES=5):
                refused = again.admit([("a", 10)])
            assert refused.reason == "run-bytes"
            again.abandon(h)
            assert not os.path.exists(os.path.join(s, "trash", h.run_id))
        try:                                                           # an error inside: the lock is released
            with H.Session.open(s):
                raise RuntimeError("boom")
        except RuntimeError:
            pass
        later = H.Session.open(s)
        assert later is not None
        later.close()
    finally:
        shutil.rmtree(d)


def test_cleanup():
    d, s = state()
    try:
        trash = os.path.join(s, "trash")
        old2 = H.run_id_at(NOW - 40 * DAY)
        old1 = H.run_id_at(NOW - 31 * DAY) + "-2"
        young = H.run_id_at(NOW - 29 * DAY)
        edge = H.run_id_at(NOW - 30 * DAY)                             # exactly 30 days: kept
        past = H.run_id_at(NOW - 30 * DAY - 1)                         # one second more: removed
        for rid in (old2, old1, young, edge, past, "odd"):
            put(os.path.join(trash, rid, "f.txt"), b"f")
        outside = os.path.join(d, "outside")
        put(os.path.join(outside, "keep.txt"), b"keep")
        os.symlink(outside, os.path.join(trash, old2, "link"))         # a link inside an old run: removed, not followed
        os.symlink(outside, os.path.join(trash, H.run_id_at(NOW - 50 * DAY)))   # a run "folder" that is a link
        order = []
        real_rmtree = shutil.rmtree

        def recording(name, dir_fd=None):
            order.append(name)
            return real_rmtree(name, dir_fd=dir_fd)
        recording.avoids_symlink_attacks = True
        H.shutil = type("S", (), {"rmtree": staticmethod(recording)})
        try:
            removed = cleanup(s, NOW)
        finally:
            H.shutil = shutil
        assert removed == order == [old2, old1, past], (removed, order)  # oldest first, whole folders
        assert sorted(os.listdir(trash)) == sorted([young, edge, "odd", H.run_id_at(NOW - 50 * DAY)])
        assert os.listdir(outside) == ["keep.txt"]
        assert H.usage(s)[1] == 7                                      # "odd" kept, and counted (with the link)
        # (board S2) a removal stopped part way: the run folder keeps its name (rmtree removes it last), the lock is
        # released, and the next cleanup removes the rest
        stopped = H.run_id_at(NOW - 45 * DAY)
        put(os.path.join(trash, stopped, "a.txt"), b"a")
        put(os.path.join(trash, stopped, "b.txt"), b"b")

        def stopping(name, dir_fd=None):
            os.unlink(os.path.join(trash, name, "a.txt"))
            raise KeyboardInterrupt
        stopping.avoids_symlink_attacks = True
        H.shutil = type("S", (), {"rmtree": staticmethod(stopping)})
        try:
            cleanup(s, NOW)
            raise AssertionError("not stopped")
        except KeyboardInterrupt:
            pass
        finally:
            H.shutil = shutil
        assert os.listdir(os.path.join(trash, stopped)) == ["b.txt"]
        assert cleanup(s, NOW) == [stopped] and not os.path.exists(os.path.join(trash, stopped))
        # over the entry bound: the count can't complete, so nothing is removed at all
        put(os.path.join(trash, old2, "f.txt"), b"f")
        with Lowered(TOTAL_ENTRIES=3):
            assert cleanup(s, NOW) == [] and os.path.isdir(os.path.join(trash, old2))
        # where removal could follow a link, nothing is removed
        H.shutil = type("S", (), {"rmtree": type("R", (), {"avoids_symlink_attacks": False})()})
        try:
            assert cleanup(s, NOW) == []
        finally:
            H.shutil = shutil
        assert os.path.isdir(os.path.join(trash, old2))
    finally:
        shutil.rmtree(d)


if __name__ == "__main__":
    for name, f in list(globals().items()):
        if name.startswith("test_") and callable(f):
            f()
            print("ok", name)
    print("all fs-sync holding tests passed")
