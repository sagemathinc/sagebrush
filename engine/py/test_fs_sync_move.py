#!/usr/bin/env python3
"""fs-sync's moves on this computer (sagebrush/fs_sync/move.py; design/fs-sync.md §2.4, §4.1, §4.3, §4.4): the
no-replace rename and its refusals, folders opened by handle with no link followed, the holding folder, move aside
(checked, moved back), install (a conflict copy beside a taken name), restore (occupied paths left held), names as
spelled on disk, and the temporary files and their sweep."""

import ctypes
import errno
import os
import shutil
import stat
import tempfile
import unicodedata

from sagebrush.fs_sync import move as M
from sagebrush.fs_sync import scan as S


def tmp():
    return os.path.realpath(tempfile.mkdtemp(prefix="sb-fs-move-"))


def tree(root, files):
    for rel, data in files.items():
        p = os.path.join(root, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "wb") as f:
            f.write(data)


def sha(data):
    import hashlib
    return hashlib.sha256(data).hexdigest()


def dfd(path):
    return os.open(path, os.O_RDONLY | os.O_DIRECTORY)


def read(path):
    with open(path, "rb") as f:
        return f.read()


class Env:
    """LOCAL_DIR and a state folder beside it (same filesystem), with a run's holding folder open."""

    def __init__(self, files=None, run_id="20261108-1402"):
        self.base = tmp()
        self.local = os.path.join(self.base, "local")
        self.state = os.path.join(self.base, "state")
        os.mkdir(self.local)
        os.mkdir(self.state, 0o700)
        tree(self.local, files or {})
        self.root = dfd(self.local)
        self.holding = M.Holding(self.state, run_id)
        self.held = os.path.join(self.state, "trash", run_id)

    def close(self):
        self.holding.close()
        os.close(self.root)
        shutil.rmtree(self.base)


def test_rename_noreplace():
    d = tmp()
    try:
        tree(d, {"a": b"a", "b": b"b"})
        os.mkdir(os.path.join(d, "dir"))
        os.symlink("nowhere", os.path.join(d, "link"))
        fd = dfd(d)
        try:
            M.rename_noreplace(fd, "a", fd, "c")                        # onto nothing: done
            assert read(os.path.join(d, "c")) == b"a" and not os.path.exists(os.path.join(d, "a"))
            for taken in ("b", "dir", "link"):                          # onto anything at all: never replaced
                try:
                    M.rename_noreplace(fd, "c", fd, taken)
                    raise AssertionError("replaced %s" % taken)
                except M.Occupied:
                    pass
            assert read(os.path.join(d, "b")) == b"b" and os.path.islink(os.path.join(d, "link"))
            try:
                M.rename_noreplace(fd, "gone", fd, "x")
                raise AssertionError("renamed a missing file")
            except FileNotFoundError:
                pass
            for bad in ("", ".", "..", "a/b"):                          # one component, always
                try:
                    M.rename_noreplace(fd, "c", fd, bad)
                    raise AssertionError("took %r as a name" % bad)
                except ValueError:
                    pass
        finally:
            os.close(fd)
    finally:
        shutil.rmtree(d)


def test_no_fallback_when_the_filesystem_cant():
    # (@sagebrush) another filesystem, or a refused flag: refused, never a plain rename or a copy (a seam on the call)
    d = tmp()
    real = M._rename
    try:
        tree(d, {"a": b"a"})
        fd = dfd(d)
        try:
            for err, reason in ((errno.EXDEV, "it is on another filesystem"),
                                (errno.EINVAL, "this filesystem can't rename without replacing"),
                                (errno.ENOSYS, "this filesystem can't rename without replacing")):
                def failing(sd, s, dd, dst, err=err):
                    ctypes.set_errno(err)
                    return -1
                M._rename = failing
                try:
                    M.rename_noreplace(fd, "a", fd, "b")
                    raise AssertionError("no refusal for %s" % errno.errorcode[err])
                except M.NoReplace as e:
                    assert e.reason == reason, e.reason
                assert read(os.path.join(d, "a")) == b"a" and not os.path.exists(os.path.join(d, "b"))
            M._rename = None                                            # (a system with no such call)
            try:
                M.rename_noreplace(fd, "a", fd, "b")
                raise AssertionError("renamed without a no-replace call")
            except M.NoReplace:
                pass
        finally:
            M._rename = real
            os.close(fd)
    finally:
        M._rename = real
        shutil.rmtree(d)
    # and for real, when this machine has two filesystems to write in
    places = [p for p in (tempfile.gettempdir(), "/dev/shm", os.path.expanduser("~"), "/scratch")
              if os.path.isdir(p) and os.access(p, os.W_OK)]
    pair = next(((a, b) for a in places for b in places if os.stat(a).st_dev != os.stat(b).st_dev), None)
    if pair:
        a, b = (tempfile.mkdtemp(prefix="sb-fs-move-", dir=p) for p in pair)
        try:
            tree(a, {"f": b"f"})
            fa, fb = dfd(a), dfd(b)
            try:
                M.rename_noreplace(fa, "f", fb, "f")
                raise AssertionError("moved across filesystems")
            except M.NoReplace as e:
                assert e.reason == "it is on another filesystem"
            finally:
                os.close(fa)
                os.close(fb)
            assert read(os.path.join(a, "f")) == b"f" and not os.path.exists(os.path.join(b, "f"))
        finally:
            shutil.rmtree(a)
            shutil.rmtree(b)


def test_folders_by_handle():
    d = tmp()
    try:
        tree(d, {"a/b/f": b"f", "file": b"x"})
        os.makedirs(os.path.join(d, "real"))
        os.symlink(os.path.join(d, "real"), os.path.join(d, "a", "link"))
        fd = dfd(d)
        try:
            sub = M.open_dir(fd, ["a", "b"])
            assert os.listdir(sub) == ["f"]
            os.close(sub)
            for parts, err in ((["a", "link"], errno.ELOOP), (["file", "x"], errno.ENOTDIR), (["a", "missing"], errno.ENOENT)):
                try:
                    os.close(M.open_dir(fd, parts))
                    raise AssertionError("opened %s" % parts)
                except OSError as e:
                    assert e.errno in (err, errno.ENOTDIR) if err == errno.ELOOP else e.errno == err, (parts, e)
            new = M.open_dir(fd, ["n1", "n2"], make=True)               # made one level at a time, 0700
            os.close(new)
            for p in ("n1", "n1/n2"):
                assert stat.S_IMODE(os.stat(os.path.join(d, p)).st_mode) == 0o700, p
            try:                                                        # a link on the way, even with make
                os.close(M.open_dir(fd, ["a", "link", "x"], make=True))
                raise AssertionError("made a folder through a link")
            except OSError:
                pass
            assert os.listdir(os.path.join(d, "real")) == []
        finally:
            os.close(fd)
    finally:
        shutil.rmtree(d)


def test_holding_folder():
    e = Env()
    try:
        assert stat.S_IMODE(os.stat(os.path.join(e.state, "trash")).st_mode) == 0o700
        assert stat.S_IMODE(os.stat(e.held).st_mode) == 0o700
        assert e.holding.same_filesystem(e.root)
        # (astra 1) trash/ itself, already there with a looser mode: set to 0700 through its handle
        os.chmod(os.path.join(e.state, "trash"), 0o755)
        M.Holding(e.state, "20261108-1501").close()
        assert stat.S_IMODE(os.stat(os.path.join(e.state, "trash")).st_mode) == 0o700
        # a holding folder that isn't ours (a seam on the owner check): refused before anything enters it
        saved_uid = os.getuid
        os.getuid = lambda: saved_uid() + 1
        try:
            M.Holding(e.state, "20261108-1502")
            raise AssertionError("used a holding folder that isn't ours")
        except PermissionError:
            pass
        finally:
            os.getuid = saved_uid
        # a run folder already there with a looser mode: set to 0700 through its handle
        loose = os.path.join(e.state, "trash", "20261108-1500")
        os.mkdir(loose, 0o755)
        os.chmod(loose, 0o755)
        M.Holding(e.state, "20261108-1500").close()
        assert stat.S_IMODE(os.stat(loose).st_mode) == 0o700
        for bad in ("", "..", "a/b", ".x", "x" * 65, "20261108-1402\n", "20261108-1402\r", " 20261108"):
            try:
                M.Holding(e.state, bad)
                raise AssertionError("took %r as a run id" % bad)
            except ValueError:
                pass
        # a holding folder on another filesystem than LOCAL_DIR is seen as one (a seam on the device number)
        real_fstat = os.fstat
        os.fstat = lambda fd: (lambda st: os.stat_result(st[:2] + (st.st_dev + (fd == e.root),) + st[3:]))(real_fstat(fd))
        try:
            assert not e.holding.same_filesystem(e.root)
        finally:
            os.fstat = real_fstat
    finally:
        e.close()


def test_move_aside():
    e = Env({"notes/a.tex": b"mine", "b.txt": b"bee"})
    try:
        os.chmod(os.path.join(e.local, "notes"), 0o755)
        M.move_aside(e.root, "notes/a.tex", e.holding, sha(b"mine"), len(b"mine"))
        assert not os.path.exists(os.path.join(e.local, "notes", "a.tex"))
        assert read(os.path.join(e.held, "notes", "a.tex")) == b"mine"
        assert stat.S_IMODE(os.stat(os.path.join(e.held, "notes")).st_mode) == 0o700
        assert stat.S_IMODE(os.stat(os.path.join(e.local, "notes")).st_mode) == 0o755    # LOCAL_DIR's folders: unchanged
        # (astra 1) a folder inside the holding folder already there and looser, or not ours: fixed, or refused
        tree(e.local, {"loose/x.txt": b"x", "theirs/y.txt": b"y"})
        os.makedirs(os.path.join(e.held, "loose"), mode=0o755)
        os.chmod(os.path.join(e.held, "loose"), 0o755)
        M.move_aside(e.root, "loose/x.txt", e.holding, sha(b"x"), 1)
        assert stat.S_IMODE(os.stat(os.path.join(e.held, "loose")).st_mode) == 0o700
        saved_uid = os.getuid
        os.getuid = lambda: saved_uid() + 1
        try:
            M.move_aside(e.root, "theirs/y.txt", e.holding, sha(b"y"), 1)
            raise AssertionError("moved a file into a holding folder that isn't ours")
        except PermissionError:
            pass
        finally:
            os.getuid = saved_uid
        assert read(os.path.join(e.local, "theirs", "y.txt")) == b"y"
        # (astra 2) the planned size is checked before a byte is read: a file that grew is moved back unread
        tree(e.local, {"grew.bin": b"z" * 4096})
        hashed, real_hash = [], M._hash
        M._hash = lambda *a: hashed.append(a) or real_hash(*a)
        try:
            M.move_aside(e.root, "grew.bin", e.holding, sha(b"z" * 10), 10)
            raise AssertionError("moved aside a file of another size")
        except M.Changed:
            pass
            # and a planned size over the scan's file cap is never read, even when the file has that size (the cap
            # lowered, as every bound can be in tests)
        saved_cap = M.MAX_FILE_BYTES
        M.MAX_FILE_BYTES = 4095
        try:
            M.move_aside(e.root, "grew.bin", e.holding, sha(b"z" * 4096), 4096)
            raise AssertionError("read a file over the cap")
        except M.Changed:
            pass
        finally:
            M._hash, M.MAX_FILE_BYTES = real_hash, saved_cap
        assert hashed == [] and read(os.path.join(e.local, "grew.bin")) == b"z" * 4096
        # (grader Z3) exactly at the (lowered) cap: hashed and moved aside
        M.MAX_FILE_BYTES = 4096
        try:
            M.move_aside(e.root, "grew.bin", e.holding, sha(b"z" * 4096), 4096)
        finally:
            M.MAX_FILE_BYTES = saved_cap
        assert read(os.path.join(e.held, "grew.bin")) == b"z" * 4096 and not os.path.exists(os.path.join(e.local, "grew.bin"))
        # not the planned file: moved back, Changed
        try:
            M.move_aside(e.root, "b.txt", e.holding, sha(b"other"), len(b"other"))
            raise AssertionError("moved aside a file that wasn't the planned one")
        except M.Changed as c:
            assert c.rel == "b.txt" and not c.held
        assert read(os.path.join(e.local, "b.txt")) == b"bee" and not os.path.exists(os.path.join(e.held, "b.txt"))
        # not planned, and its name taken meanwhile (the seam): it stays held, and the newcomer is untouched
        def newcomer(rel):
            tree(e.local, {rel: b"new"})
        try:
            M.move_aside(e.root, "b.txt", e.holding, sha(b"other"), len(b"other"), hooks={"after_move_aside": newcomer})
            raise AssertionError("no Changed")
        except M.Changed as c:
            assert c.held
        assert read(os.path.join(e.local, "b.txt")) == b"new" and read(os.path.join(e.held, "b.txt")) == b"bee"
        # a link at the name is moved aside as a link, not followed, then moved back (it is never the planned file)
        tree(e.local, {"target": b"mine"})
        os.symlink("target", os.path.join(e.local, "l.txt"))
        try:
            M.move_aside(e.root, "l.txt", e.holding, sha(b"mine"), len(b"mine"))
            raise AssertionError("a link counted as the planned file")
        except M.Changed:
            pass
        assert os.path.islink(os.path.join(e.local, "l.txt")) and read(os.path.join(e.local, "target")) == b"mine"
    finally:
        e.close()


def test_links_on_the_way_are_never_followed():
    e = Env({"d/f.txt": b"f"})
    try:
        outside = os.path.join(e.base, "outside")
        os.mkdir(outside)
        tree(outside, {"f.txt": b"theirs"})
        # a folder of LOCAL_DIR replaced by a link: the move fails, nothing outside is touched
        os.rename(os.path.join(e.local, "d"), os.path.join(e.local, "d.real"))
        os.symlink(outside, os.path.join(e.local, "d"))
        try:
            M.move_aside(e.root, "d/f.txt", e.holding, sha(b"theirs"), len(b"theirs"))
            raise AssertionError("followed a link in LOCAL_DIR")
        except OSError:
            pass
        assert read(os.path.join(outside, "f.txt")) == b"theirs" and not os.path.exists(os.path.join(e.held, "d"))
        os.unlink(os.path.join(e.local, "d"))
        os.rename(os.path.join(e.local, "d.real"), os.path.join(e.local, "d"))
        # (sync-client) a link planted inside trash/<run id>/: refused, never followed
        os.symlink(outside, os.path.join(e.held, "d"))
        try:
            M.move_aside(e.root, "d/f.txt", e.holding, sha(b"f"), len(b"f"))
            raise AssertionError("followed a link in the holding folder")
        except OSError:
            pass
        assert read(os.path.join(e.local, "d", "f.txt")) == b"f" and os.listdir(outside) == ["f.txt"]
    finally:
        e.close()


def test_names_as_spelled_on_disk():
    # (sync-client, §4.4) an NFD name is moved aside and restored under its NFD bytes, never its NFC form
    nfd = unicodedata.normalize("NFD", "café.txt")
    assert nfd != unicodedata.normalize("NFC", nfd)
    e = Env({nfd: b"crema"})
    try:
        M.move_aside(e.root, nfd, e.holding, sha(b"crema"), len(b"crema"))
        assert os.listdir(e.held) == [nfd] and os.listdir(e.local) == []
        assert M.restore(e.root, e.holding) == []
        assert os.listdir(e.local) == [nfd] and read(os.path.join(e.local, nfd)) == b"crema"
        assert os.listdir(e.local)[0].encode("utf-8") == nfd.encode("utf-8")
    finally:
        e.close()


def test_install():
    e = Env({"notes/.sagebrush-tmp-20261108-1402-1": b"theirs"})
    try:
        tmp_name = M.temp_name("20261108-1402", 1)
        M.install(e.root, "notes/a.tex", tmp_name, "laptop")
        assert read(os.path.join(e.local, "notes", "a.tex")) == b"theirs"
        assert os.listdir(os.path.join(e.local, "notes")) == ["a.tex"]
        # the name taken meanwhile (the seam): installed beside it under the conflict name, the newcomer untouched
        tree(e.local, {"notes/" + tmp_name: b"theirs 2"})
        os.unlink(os.path.join(e.local, "notes", "a.tex"))
        def newcomer(rel):
            tree(e.local, {rel: b"mine"})
        try:
            M.install(e.root, "notes/a.tex", tmp_name, "laptop", hooks={"before_install": newcomer})
            raise AssertionError("no InstalledBeside")
        except M.InstalledBeside as b:
            assert b.rel == "notes/a (conflict, laptop).tex", b.rel
        assert read(os.path.join(e.local, "notes", "a.tex")) == b"mine"
        assert read(os.path.join(e.local, "notes", "a (conflict, laptop).tex")) == b"theirs 2"
        # and that conflict name taken too: the next one, " (2)"
        tree(e.local, {"notes/" + tmp_name: b"theirs 3"})
        try:
            M.install(e.root, "notes/a.tex", tmp_name, "laptop")
            raise AssertionError("no InstalledBeside")
        except M.InstalledBeside as b:
            assert b.rel == "notes/a (conflict, laptop) (2).tex", b.rel
        assert read(os.path.join(e.local, "notes", "a (conflict, laptop) (2).tex")) == b"theirs 3"
        # (grader I3) every conflict name taken as it is tried (a seam): MAX_CONFLICT_TRIES names, then Occupied, with
        # the target, the temp and every racer's file intact
        tree(e.local, {"notes/" + tmp_name: b"theirs 4"})
        real_conflict, racers = M.conflict_name, []

        def racing(rel, computer, taken):
            name = real_conflict(rel, computer, taken)
            tree(e.local, {name: b"racer %d" % len(racers)})
            racers.append(name)
            return name
        M.conflict_name = racing
        try:
            M.install(e.root, "notes/a.tex", tmp_name, "laptop")
            raise AssertionError("installed though every name was taken")
        except M.Occupied:
            pass
        finally:
            M.conflict_name = real_conflict
        assert len(racers) == M.MAX_CONFLICT_TRIES == 8 and len(set(racers)) == 8, racers
        assert read(os.path.join(e.local, "notes", "a.tex")) == b"mine"
        assert read(os.path.join(e.local, "notes", tmp_name)) == b"theirs 4"
        for i, name in enumerate(racers):
            assert read(os.path.join(e.local, name)) == b"racer %d" % i, name
    finally:
        e.close()


def test_restore():
    e = Env({"a.txt": b"a", "sub/b.txt": b"b", "c.txt": b"c", "gone/d.txt": b"d"})
    try:
        for rel, data in (("a.txt", b"a"), ("sub/b.txt", b"b"), ("c.txt", b"c"), ("gone/d.txt", b"d")):
            M.move_aside(e.root, rel, e.holding, sha(data), len(data))
        tree(e.local, {"c.txt": b"newer"})                              # occupied now
        os.rmdir(os.path.join(e.local, "gone"))
        tree(e.local, {"gone": b"a file where the folder was"})         # a file where a folder should be
        os.chmod(os.path.join(e.held, "sub"), 0o755)                    # (grader R3) a held folder gone looser
        left = sorted(M.restore(e.root, e.holding))
        assert left == ["c.txt", "gone/d.txt"], left
        assert stat.S_IMODE(os.stat(os.path.join(e.held, "sub")).st_mode) == 0o700
        saved_uid = os.getuid                                           # and one not ours: refused, nothing moved
        os.getuid = lambda: saved_uid() + 1
        try:
            M.restore(e.root, e.holding)
            raise AssertionError("restored through a holding folder that isn't ours")
        except PermissionError:
            pass
        finally:
            os.getuid = saved_uid
        assert read(os.path.join(e.held, "gone", "d.txt")) == b"d"
        assert read(os.path.join(e.local, "a.txt")) == b"a" and read(os.path.join(e.local, "sub", "b.txt")) == b"b"
        assert read(os.path.join(e.local, "c.txt")) == b"newer"         # never overwritten
        assert read(os.path.join(e.held, "c.txt")) == b"c" and read(os.path.join(e.held, "gone", "d.txt")) == b"d"
    finally:
        e.close()


def test_temps_and_their_sweep():
    assert M.temp_name("20261108-1402", 7) == ".sagebrush-tmp-20261108-1402-7"
    for bad in (("", 1), ("a/b", 1), ("r", -1), ("r", "1"), ("r\n", 1), ("r", True)):
        try:
            M.temp_name(*bad)
            raise AssertionError("made a temp name from %r" % (bad,))
        except ValueError:
            pass
    e = Env({"keep.txt": b"k", "sub/.sagebrush-tmp-20261101-0900-3": b"old", ".sagebrush-tmp-20261101-0900-12": b"old",
             ".sagebrush-tmp-20261108-1402-1": b"mine, this run", ".sagebrush-tmp-notes.txt": b"not ours",
             ".sagebrush-tmp-20261101-0900-x": b"not ours", ".sagebrush-tmp-20261101-0900-7\n": b"near miss",
             ".sagebrush-tmp-20261101-0900-8 ": b"near miss", ".sagebrush-tmp-a.b-3": b"not a run id",
             ".sagebrush-tmp--3": b"no run id", ".sagebrush-tmp-x y-3": b"not a run id"}, run_id="20261108-1402")
    try:
        nfd_dir = unicodedata.normalize("NFD", "café")                  # (reached only by its on-disk spelling)
        tree(e.local, {nfd_dir + "/.sagebrush-tmp-20261101-0900-9": b"old"})
        os.symlink("keep.txt", os.path.join(e.local, ".sagebrush-tmp-20261101-0900-4"))
        os.mkdir(os.path.join(e.local, ".sagebrush-tmp-20261101-0900-5"))
        r = S.scan(S.refuse_overlap(e.local, []))
        # the scan ignores them all, and lists the plain files among them for the sweep, as spelled on disk
        assert not [p for p in r.files if "sagebrush-tmp" in p], sorted(r.files)
        assert sorted(r.temps) == sorted([".sagebrush-tmp-20261101-0900-12", ".sagebrush-tmp-20261101-0900-x",
                                          ".sagebrush-tmp-20261101-0900-7\n", ".sagebrush-tmp-20261101-0900-8 ",
                                          ".sagebrush-tmp-a.b-3", ".sagebrush-tmp--3", ".sagebrush-tmp-x y-3",
                                          ".sagebrush-tmp-20261108-1402-1", ".sagebrush-tmp-notes.txt",
                                          "sub/.sagebrush-tmp-20261101-0900-3",
                                          nfd_dir + "/.sagebrush-tmp-20261101-0900-9"]), r.temps
        assert M.sweep_temps(e.root, r.temps, "20261108-1402") == 3
        assert os.listdir(os.path.join(e.local, nfd_dir)) == []
        left = sorted(os.listdir(e.local)) + sorted("sub/" + n for n in os.listdir(os.path.join(e.local, "sub")))
        assert left == sorted([".sagebrush-tmp-20261101-0900-4", ".sagebrush-tmp-20261101-0900-5",
                               ".sagebrush-tmp-20261101-0900-x", ".sagebrush-tmp-20261108-1402-1",
                               ".sagebrush-tmp-notes.txt", "keep.txt", "sub", nfd_dir,
                               ".sagebrush-tmp-20261101-0900-7\n", ".sagebrush-tmp-20261101-0900-8 ",
                               ".sagebrush-tmp-a.b-3", ".sagebrush-tmp--3", ".sagebrush-tmp-x y-3"]), left
        # a temp that turned into a link or folder since the scan is left as it is
        assert M.sweep_temps(e.root, [".sagebrush-tmp-20261101-0900-4", ".sagebrush-tmp-20261101-0900-5"],
                             "20261108-1402") == 0
    finally:
        e.close()


if __name__ == "__main__":
    for name, f in list(globals().items()):
        if name.startswith("test_") and callable(f):
            f()
            print("ok", name)
    print("all fs-sync move tests passed")
