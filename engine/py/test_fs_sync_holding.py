#!/usr/bin/env python3
"""fs-sync's holding folder (sagebrush/fs_sync/holding.py; design/fs-sync.md §2.4): run ids made unique by an
exclusive mkdir, what is held counted by handle, all-or-nothing admission under the bounds, one run at a time moving
files aside (the trash/ lock), and the cleanup of runs older than 30 days. Every bound is lowered here."""

import os
import re
import shutil
import stat
import tempfile
import time

from sagebrush.fs_sync import holding as H

NOW = 1_794_200_000                 # 2026-11-09 (UTC), a fixed "now"
DAY = 86400


def tmp():
    return os.path.realpath(tempfile.mkdtemp(prefix="sb-fs-hold-"))


def state():
    d = tmp()
    s = os.path.join(d, "state")
    os.mkdir(s, 0o700)
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


def test_run_ids():
    rid = H.run_id_at(NOW)
    assert rid == time.strftime("%Y%m%d-%H%M%S", time.gmtime(NOW)) and re.fullmatch(r"[0-9]{8}-[0-9]{6}", rid)
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
            a = H.new_run(s, NOW + 1)
            b = H.new_run(s, NOW + 1)
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


def test_usage_by_handle():
    d, s = state()
    try:
        trash = os.path.join(s, "trash")
        put(os.path.join(trash, "20261101-000000", "a", "b.txt"), b"x" * 10)
        put(os.path.join(trash, "20261101-000000", "c.txt"), b"y" * 5)
        put(os.path.join(trash, "odd", "d.txt"), b"z" * 7)            # (not a run id: counted all the same)
        outside = os.path.join(d, "big")
        put(outside, b"q" * 100000)
        os.symlink(outside, os.path.join(trash, "odd", "link"))       # a link: counted as itself, never followed
        os.symlink(d, os.path.join(trash, "odd", "dirlink"))
        size_links = sum(os.lstat(os.path.join(trash, "odd", n)).st_size for n in ("link", "dirlink"))
        assert H.usage(s) == (22 + size_links, 5), H.usage(s)
        assert H.usage(s, stop_files=2)[1] == 2                       # counting stops past the bound
    finally:
        shutil.rmtree(d)


def test_admission_all_or_nothing():
    d, s = state()
    try:
        put(os.path.join(s, "trash", "20261101-000000", "held.txt"), b"h" * 40)       # 40 bytes, 1 file held
        with Lowered(RUN_BYTES=50, RUN_FILES=3, TOTAL_BYTES=100, TOTAL_FILES=4):
            ok = H.admit(s, [20, 20, 10])                              # the run at its bounds, the total under
            assert ok.ok and (ok.bytes, ok.files, ok.held_bytes, ok.held_files) == (50, 3, 40, 1), ok
            assert H.admit(s, [20, 20, 11]).reason == "run-bytes"      # one byte over the run's bound
            assert H.admit(s, [1, 1, 1, 1]).reason == "run-files"      # one file over
        with Lowered(RUN_BYTES=100, RUN_FILES=10, TOTAL_BYTES=100, TOTAL_FILES=4):
            assert H.admit(s, [60]).ok                                 # the total at its bound (40 + 60)
            assert H.admit(s, [61]).reason == "total-bytes"            # one byte over
            assert H.admit(s, [1, 1, 1]).ok                            # 1 + 3 files
            assert H.admit(s, [1, 1, 1, 1]).reason == "total-files"    # one file over
        assert H.admit(s, []).ok                                       # a run moving nothing aside
    finally:
        shutil.rmtree(d)


def test_one_run_at_a_time_moves_files_aside():
    d, s = state()
    try:
        first = H.reserve(s, [10])
        assert first.admission.ok and first.fd is not None
        second = H.reserve(s, [10])                                    # another pair's run, meanwhile: pending
        assert not second.admission.ok and second.admission.reason == "busy" and second.fd is None
        first.release()
        third = H.reserve(s, [10])
        assert third.admission.ok
        third.release()
        with Lowered(RUN_BYTES=5):                                     # not admitted: the lock isn't kept
            refused = H.reserve(s, [10])
            assert refused.admission.reason == "run-bytes" and refused.fd is None
        after = H.reserve(s, [1])
        assert after.admission.ok
        after.release()
        after.release()                                                # (twice: harmless)
        # admission failing outright (a seam): the lock is released, and the next run gets it
        saved = H.usage
        H.usage = lambda st, **k: (_ for _ in ()).throw(OSError(5, "Input/output error"))
        try:
            H.reserve(s, [1])
            raise AssertionError("no failure")
        except OSError:
            pass
        finally:
            H.usage = saved
        again = H.reserve(s, [1])
        assert again.admission.ok
        again.release()
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
        for rid in (old2, old1, young, edge, "odd"):
            put(os.path.join(trash, rid, "f.txt"), b"f")
        outside = os.path.join(d, "outside")
        put(os.path.join(outside, "keep.txt"), b"keep")
        os.symlink(outside, os.path.join(trash, old2, "link"))         # a link inside an old run: removed, not followed
        os.symlink(outside, os.path.join(trash, H.run_id_at(NOW - 50 * DAY)))   # a run "folder" that is a link
        removed = H.cleanup(s, NOW)
        assert removed == [old2, old1], removed                        # oldest first
        assert sorted(os.listdir(trash)) == sorted([young, edge, "odd", H.run_id_at(NOW - 50 * DAY)])
        assert os.listdir(outside) == ["keep.txt"]
        # one not ours (an owner seam): left
        put(os.path.join(trash, old2, "f.txt"), b"f")
        saved, saved_trash = os.getuid, H._trash
        H._trash = lambda st: os.open(trash, os.O_RDONLY | os.O_DIRECTORY)    # (past trash/'s own check)
        os.getuid = lambda: saved() + 1
        try:
            assert H.cleanup(s, NOW) == []
        finally:
            os.getuid, H._trash = saved, saved_trash
        assert os.path.isdir(os.path.join(trash, old2))
        # where removal could follow a link, nothing is removed
        real = shutil.rmtree.avoids_symlink_attacks
        try:
            H.shutil = type("S", (), {"rmtree": type("R", (), {"avoids_symlink_attacks": False})()})()
            assert H.cleanup(s, NOW) == []
        finally:
            H.shutil = shutil
        assert real and os.path.isdir(os.path.join(trash, old2))
    finally:
        shutil.rmtree(d)


if __name__ == "__main__":
    for name, f in list(globals().items()):
        if name.startswith("test_") and callable(f):
            f()
            print("ok", name)
    print("all fs-sync holding tests passed")
