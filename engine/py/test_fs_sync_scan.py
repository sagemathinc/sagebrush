#!/usr/bin/env python3
"""fs-sync's read-only scan (sagebrush/fs_sync/scan.py; design/fs-sync.md §1, §4.1, §4.4, §4.5): the refusals before
anything, links never followed, special files, ignore rules, the workspace's name rules, NFC clashes, the bounds, the
hashing shortcut and its ctime guard, and that a scan changes nothing."""

import hashlib
import os
import shutil
import tempfile
import unicodedata

from sagebrush.fs_sync import scan as S


def sha(b):
    return hashlib.sha256(b).hexdigest()


def tree(root, files):
    for rel, data in files.items():
        p = os.path.join(root, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "wb") as f:
            f.write(data)


def snapshot(root):
    """Everything about the tree a scan could change: names, kinds, sizes, mtimes, ctimes."""
    out = []
    for d, dirs, files in os.walk(root, followlinks=False):
        for n in sorted(dirs + files):
            st = os.lstat(os.path.join(d, n))
            out.append((os.path.relpath(os.path.join(d, n), root), st.st_mode, st.st_size, st.st_mtime_ns, st.st_ctime_ns))
    st = os.lstat(root)
    return sorted(out), (st.st_mtime_ns, st.st_ctime_ns)


def tmp():
    return tempfile.mkdtemp(prefix="sb-fs-scan-")


def test_refuse_overlap():
    base = tmp()
    try:
        state, config, work = (os.path.join(base, x) for x in ("state/sagebrush/fs-sync", "config/sagebrush/fs-sync", "work"))
        for d in (state, config, work):
            os.makedirs(d)
        assert S.refuse_overlap(work, [config, state]) == os.path.realpath(work)
        for bad, word in ((state, "inside"), (os.path.join(base, "state"), "contains"), (base, "contains"),
                          (config, "inside")):
            try:
                S.refuse_overlap(bad, [config, state])
                raise AssertionError("not refused: %s" % bad)
            except S.Refused as e:
                assert e.code == 2 and ("it is %s fs-sync's own files" % word in e.message or
                                        "it %s fs-sync's own files" % word in e.message), e.message
        os.makedirs(os.path.join(state, "trash"))
        try:
            S.refuse_overlap(os.path.join(state, "trash"), [config, state])
            raise AssertionError("trash not refused")
        except S.Refused as e:
            assert e.message == "%s can't be synced: it is inside fs-sync's own files. Choose a folder outside %s." % (
                S._home_short(os.path.realpath(os.path.join(state, "trash"))), S._home_short(os.path.realpath(state))), e.message
        # a symlink into fs-sync's own folder is resolved first
        link = os.path.join(base, "innocent")
        os.symlink(state, link)
        try:
            S.refuse_overlap(link, [config, state])
            raise AssertionError("a link into the state folder was not refused")
        except S.Refused as e:
            assert e.code == 2
        # fs-sync's own folder named through a symlink is resolved too
        cfg_link = os.path.join(base, "cfg-link")
        os.symlink(config, cfg_link)
        try:
            S.refuse_overlap(config, [cfg_link, state])
            raise AssertionError("the config folder named through a link was not refused")
        except S.Refused as e:
            assert e.code == 2
        # not a folder
        try:
            S.refuse_overlap(os.path.join(base, "missing"), [config, state])
            raise AssertionError("a missing folder was accepted")
        except S.Refused as e:
            assert e.code == 2 and "isn't a folder" in e.message
    finally:
        shutil.rmtree(base)


def test_refuse_platform():
    saved = os.name
    try:
        S.refuse_platform()                         # here: no refusal
        os.name = "nt"
        try:
            S.refuse_platform()
            raise AssertionError("native Windows was not refused")
        except S.Refused as e:
            assert e.code == 2 and e.message == "fs-sync doesn't run on native Windows yet. Use it from WSL (Windows Subsystem for Linux)."
    finally:
        os.name = saved


def test_scan_files_links_specials():
    root, outside = tmp(), tmp()
    try:
        tree(root, {"a.txt": b"one", "d/b.bin": b"\x00two", "d/e/c.md": b"three"})
        tree(outside, {"secret.txt": b"not yours"})
        os.symlink(os.path.join(outside, "secret.txt"), os.path.join(root, "link.txt"))
        os.symlink(outside, os.path.join(root, "linkdir"))
        os.mkfifo(os.path.join(root, "pipe"))
        before = snapshot(root)
        r = S.scan(os.path.realpath(root))
        assert snapshot(root) == before                         # read-only
        assert {p: f.sha256 for p, f in r.files.items()} == {"a.txt": sha(b"one"), "d/b.bin": sha(b"\x00two"), "d/e/c.md": sha(b"three")}, r.files
        skipped = dict(r.skipped)
        assert skipped == {"link.txt": S.SYMLINK, "linkdir": S.SYMLINK, "pipe": S.SPECIAL}, r.skipped
        assert not any("secret" in p for p in r.files) and r.hashed == 3
        f = r.files["a.txt"]
        st = os.lstat(os.path.join(root, "a.txt"))
        assert f.key == (st.st_size, st.st_mtime_ns, st.st_ctime_ns, st.st_ino, st.st_dev)
        assert r.case_insensitive is False                       # (Linux's filesystems tell case apart)
    finally:
        shutil.rmtree(root)
        shutil.rmtree(outside)


def test_ignore_rules():
    root = tmp()
    try:
        tree(root, {".git/config": b"x", "node_modules/m/i.js": b"x", "src/__pycache__/a.pyc": b"x", "x.swp": b"x",
                    "notes.txt~": b"x", "~$doc.docx": b"x", ".DS_Store": b"x", "keep.txt": b"k",
                    "build/out.o": b"x", "src/build/keep.c": b"k", "logs/a.log": b"x", "logs/important.log": b"k",
                    "deep/x/y.tmp": b"x", "top.tmp": b"x", "docs/only/here.md": b"x", "other/docs/only/here.md": b"k",
                    S.IGNORE_FILE: b"# comment\n/build/\n*.log\n!important.log\n**/*.tmp\ndocs/only/\n\n"})
        r = S.scan(os.path.realpath(root))
        assert sorted(r.files) == sorted(["keep.txt", "src/build/keep.c", "logs/important.log", "other/docs/only/here.md",
                                          S.IGNORE_FILE]), sorted(r.files)
        ign = sorted(p for p, why in r.skipped if why == S.IGNORED)
        assert ".git/" in ign and "node_modules/" in ign and "src/__pycache__/" in ign and "build/" in ign, ign
        assert "docs/only/" in ign and "top.tmp" in ign and "deep/x/y.tmp" in ign and "logs/a.log" in ign, ign
        # the parser on its own
        ig = S.Ignore(["a/**/b", "[!x]y", "\\#lit", "dir/"])
        assert ig.ignored("a/b", False) and ig.ignored("a/q/r/b", False) and not ig.ignored("z/a/b", False)
        assert ig.ignored("zy", False) and not ig.ignored("xy", False)
        assert ig.ignored("dir", True) and not ig.ignored("dir", False)
    finally:
        shutil.rmtree(root)


def test_workspace_name_rules_and_nfc():
    root = tmp()
    try:
        tree(root, {"bad\x01name.txt": b"x"})
        nfd, nfc = unicodedata.normalize("NFD", "é.txt"), unicodedata.normalize("NFC", "é.txt")
        tree(root, {nfd: b"1", nfc: b"2", "ok.txt": b"ok"})
        r = S.scan(os.path.realpath(root))
        why = dict(r.skipped)
        assert why.get("bad\x01name.txt") == S.NAME_REFUSED, r.skipped
        assert [w for p, w in r.skipped if p == nfc] == [S.NFC_CLASH, S.NFC_CLASH], r.skipped
        assert nfc not in r.files and "ok.txt" in r.files
        # depth: a workspace folder 31 deep leaves room for one level
        assert S.workspace_refuses("a.txt", "/" + "/".join(["d"] * 31)) is None
        assert S.workspace_refuses("x/a.txt", "/" + "/".join(["d"] * 31))
        assert S.workspace_refuses("a" * 256, "/") and S.workspace_refuses("a" * 255, "/") is None
        assert S.workspace_refuses("x" * 1020, "/abc") and not S.workspace_refuses("x" * 250, "/abc")
        # the whole path's limit on its own (names short, depth small): 1,024 characters fit, 1,025 don't
        rel = "/".join(["y" * 250] * 4) + "/"
        assert S.workspace_refuses(rel + "z" * 15, "/abc") is None and len("/abc/" + rel + "z" * 15) == 1024
        assert S.workspace_refuses(rel + "z" * 16, "/abc")
    finally:
        shutil.rmtree(root)


def test_bounds():
    root = tmp()
    try:
        tree(root, {"a/b/c/d.txt": b"deep", "big.bin": b"x" * 2000, "f%d.txt" % 1: b"1", "f2.txt": b"2"})
        r = S.scan(os.path.realpath(root), limits={"depth": 2, "file_bytes": 1000})
        why = dict(r.skipped)
        assert why.get("a/b/c/") == S.TOO_DEEP and why.get("big.bin") == S.TOO_BIG, r.skipped
        assert "a/b/c/d.txt" not in r.files and "big.bin" not in r.files
        r = S.scan(os.path.realpath(root), limits={"path_bytes": 5})
        assert dict(r.skipped).get("big.bin") == S.TOO_LONG, r.skipped
        for lim, word in (({"entries": 3}, "entries"), ({"files": 2}, "files")):
            try:
                S.scan(os.path.realpath(root), limits=lim)
                raise AssertionError("no stop at %s" % lim)
            except S.TooMany as e:
                assert e.code == 1 and e.message.startswith("Stopped before planning:") and word in e.message, e.message
        # at the bound exactly: no stop (4 files, 7 entries); one under it: stop
        S.scan(os.path.realpath(root), limits={"files": 4, "entries": 7})
        for lim in ({"files": 3}, {"entries": 6}):
            try:
                S.scan(os.path.realpath(root), limits=lim)
                raise AssertionError("no stop one under the bound: %s" % lim)
            except S.TooMany:
                pass
    finally:
        shutil.rmtree(root)


def test_hash_never_blocks():
    # a file swapped for a FIFO between its stat and its open: the open doesn't wait for a writer, and the hash refuses
    root = tmp()
    try:
        p = os.path.join(root, "f")
        tree(root, {"f": b"data"})
        st = os.stat(p)
        os.unlink(p)
        os.mkfifo(p)
        fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
        try:
            S._hash(fd, "f", st)
            raise AssertionError("a FIFO was hashed")
        except OSError:
            pass
        finally:
            os.close(fd)
    finally:
        shutil.rmtree(root)


def test_hash_shortcut_and_ctime_guard():
    root = tmp()
    try:
        tree(root, {"a.txt": b"aaaa", "b.txt": b"bbbb"})
        r1 = S.scan(os.path.realpath(root))
        known = {p: (f.key, f.sha256) for p, f in r1.files.items()}
        r2 = S.scan(os.path.realpath(root), known=known)
        assert r2.hashed == 0 and r2.files == r1.files          # a second run of an unchanged folder reads no contents
        # a same-size edit with its mtime put back (touch -r): ctime still moves, so it is hashed again
        p = os.path.join(root, "a.txt")
        st = os.stat(p)
        with open(p, "r+b") as f:
            f.write(b"AAAA")
        os.utime(p, ns=(st.st_atime_ns, st.st_mtime_ns))
        r3 = S.scan(os.path.realpath(root), known=known)
        assert r3.files["a.txt"].sha256 == sha(b"AAAA") and r3.hashed == 1, (r3.files, r3.hashed)
        # a known hash with a stale key is never trusted
        known["b.txt"] = ((0, 0, 0, 0, 0), "f" * 64)
        assert S.scan(os.path.realpath(root), known=known).files["b.txt"].sha256 == sha(b"bbbb")
    finally:
        shutil.rmtree(root)


if __name__ == "__main__":
    for name, f in list(globals().items()):
        if name.startswith("test_") and callable(f):
            f()
            print("ok", name)
    print("all fs-sync scan tests passed")
