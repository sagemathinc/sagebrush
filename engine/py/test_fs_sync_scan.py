#!/usr/bin/env python3
"""fs-sync's read-only scan (sagebrush/fs_sync/scan.py; design/fs-sync.md §1, §4.1, §4.4, §4.5): the refusals before
anything, links never followed, special files, ignore rules, the workspace's name rules, NFC clashes, the bounds, the
hashing shortcut and its ctime guard, and that a scan changes nothing."""

import hashlib
import os
import resource
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
        assert S.refuse_overlap(work, [config, state]).path == os.path.realpath(work)
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
        r = S.scan(S.refuse_overlap(root, []))
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
        r = S.scan(S.refuse_overlap(root, []))
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
        r = S.scan(S.refuse_overlap(root, []))
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
        tree(root, {"a/b/c/d.txt": b"deep", "big.bin": b"x" * 2000, "f1.txt": b"1", "f2.txt": b"2"})
        # depth, path length and size: skipped and listed (§4.5), not a stop
        r = S.scan(S.refuse_overlap(root, []), limits={"depth": 2, "file_bytes": 1000})
        why = dict(r.skipped)
        assert why.get("a/b/c/") == S.TOO_DEEP and why.get("big.bin") == S.TOO_BIG, r.skipped
        assert "a/b/c/d.txt" not in r.files and "big.bin" not in r.files
        assert "a/b/c/d.txt" in S.scan(S.refuse_overlap(root, []), limits={"depth": 3}).files     # at the bound
        r = S.scan(S.refuse_overlap(root, []), limits={"path_bytes": 5})
        assert dict(r.skipped).get("big.bin") == S.TOO_LONG, r.skipped
        assert "a/b/c/d.txt" not in S.scan(S.refuse_overlap(root, []), limits={"path_bytes": len("a/b/c/d.txt") - 1}).files
        assert "a/b/c/d.txt" in S.scan(S.refuse_overlap(root, []), limits={"path_bytes": len("a/b/c/d.txt")}).files
        # entries and files: stop before planning (exit 1), the number written as §1.2 does
        for lim, word in (({"entries": 3}, "more than 3 entries"), ({"files": 2}, "more than 2 files"),
                          ({"entries": 6}, "more than 6 entries"), ({"files": 3}, "more than 3 files")):
            try:
                S.scan(S.refuse_overlap(root, []), limits=lim)
                raise AssertionError("no stop at %s" % lim)
            except S.TooMany as e:
                assert e.code == 1 and e.message == "Stopped before planning: %s has %s (the limit for one sync)." % (
                    S._home_short(os.path.realpath(root)), word), e.message
        # at the bounds exactly: no stop (4 files, 7 entries)
        S.scan(S.refuse_overlap(root, []), limits={"files": 4, "entries": 7})
        # thousands separators (board S1): "1,000", as §1.2 writes "200,000"
        many = tmp()
        try:
            tree(many, {"m/f%04d" % i: b"" for i in range(1001)})
            for lim, word in (({"files": 1000}, "more than 1,000 files"), ({"entries": 1000}, "more than 1,000 entries")):
                try:
                    S.scan(S.refuse_overlap(many, []), limits=lim)
                    raise AssertionError("no stop at %s" % lim)
                except S.TooMany as e:
                    assert word in e.message, e.message
        finally:
            shutil.rmtree(many)
    finally:
        shutil.rmtree(root)


def test_one_handle_per_level():
    # (sync-client F1) a folder with many subfolders: open handles stay one per level of the current path, so a low
    # descriptor limit doesn't make subfolders unreadable
    root = tmp()
    soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
    try:
        tree(root, {"wide/d%03d/f.txt" % i: b"%d" % i for i in range(120)})
        tree(root, {"deep/" + "/".join("l%d" % i for i in range(30)) + "/end.txt": b"end"})
        # (two descriptors per level: the folder's handle and the copy os.scandir(fd) makes of it; 30 levels plus the
        # root fit in 2 * 31 + a margin, while 120 sibling folders opened at once would not)
        resource.setrlimit(resource.RLIMIT_NOFILE, (2 * 31 + 16, hard))
        r = S.scan(S.refuse_overlap(root, []))
        resource.setrlimit(resource.RLIMIT_NOFILE, (soft, hard))
        assert not [p for p, why in r.skipped if why == S.UNREADABLE], r.skipped[:5]
        assert len([p for p in r.files if p.startswith("wide/")]) == 120 and any(p.endswith("end.txt") for p in r.files)
    finally:
        resource.setrlimit(resource.RLIMIT_NOFILE, (soft, hard))
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


def test_open_root_checks_identity():
    # (astra 1) LOCAL_DIR is opened component by component without following links, and must be the folder accepted
    base = tmp()
    try:
        a, other = os.path.join(base, "a"), os.path.join(base, "other")
        tree(base, {"a/sub/f.txt": b"x", "other/sub/g.txt": b"y"})
        accepted = S.refuse_overlap(os.path.join(a, "sub"), [])
        assert "f.txt" in S.scan(accepted).files
        # an ancestor replaced by a link after the refusal: not followed
        os.rename(a, a + ".moved")
        os.symlink(other, a)
        for fn in (lambda: S.scan(accepted), lambda: S.open_root(accepted)):
            try:
                fn()
                raise AssertionError("an ancestor link was followed")
            except S.Refused as e:
                assert e.code == 2 and "changed while fs-sync was starting" in e.message, e.message
        # the folder itself replaced by another of the same name: its identity differs
        os.unlink(a)
        os.rename(a + ".moved", a)
        shutil.rmtree(os.path.join(a, "sub"))
        os.makedirs(os.path.join(a, "sub"))
        try:
            S.scan(accepted)
            raise AssertionError("a replaced folder was scanned")
        except S.Refused as e:
            assert e.code == 2
        # an ancestor swapped for a link to the very same folder: the identity matches, but no link is followed
        shutil.rmtree(a)
        tree(base, {"a/sub/f.txt": b"x"})
        accepted = S.refuse_overlap(os.path.join(a, "sub"), [])
        os.rename(a, a + ".moved")
        os.symlink(a + ".moved", a)
        try:
            S.scan(accepted)
            raise AssertionError("an ancestor link to the same folder was followed")
        except S.Refused as e:
            assert e.code == 2
    finally:
        shutil.rmtree(base)


NOT_PLAIN = ("Stopped before planning: .sagebrushignore isn't a plain file (a link, folder or special file has that name). "
             "Replace it with a plain file, or remove it.")


def test_ignore_file_read_safely():
    # (astra 2, daybreak3 E3; §4.4's words) absent is no rules; anything else that isn't a plain readable file within
    # the limits stops before planning (exit 1)
    cases = {"link": NOT_PLAIN, "dir": NOT_PLAIN, "fifo": NOT_PLAIN,
             "huge": "Stopped before planning: .sagebrushignore is over 1 MiB (the limit).",
             "lines": "Stopped before planning: .sagebrushignore has more than 10,000 lines (the limit)."}
    if os.geteuid() != 0:
        cases["unreadable"] = "Stopped before planning: .sagebrushignore couldn't be read (Permission denied)."
    for kind, want in cases.items():
        root = tmp()
        try:
            tree(root, {"keep.txt": b"k", "target": b"*.txt\n"})
            p = os.path.join(root, S.IGNORE_FILE)
            if kind == "link":
                os.symlink(os.path.join(root, "target"), p)
            elif kind == "dir":
                os.mkdir(p)
            elif kind == "fifo":
                os.mkfifo(p)
            elif kind == "huge":
                with open(p, "wb") as f:
                    f.write(b"#" * (S.MAX_IGNORE_BYTES + 1))
            elif kind == "lines":
                with open(p, "wb") as f:
                    f.write(b"x\n" * (S.MAX_IGNORE_LINES + 1))
            else:
                with open(p, "wb") as f:
                    f.write(b"*.txt\n")
                os.chmod(p, 0)
            try:
                S.scan(S.refuse_overlap(root, []))
                raise AssertionError("a %s ignore file was taken as no rules" % kind)
            except S.Refused as e:
                assert e.code == 1 and e.message == want, (kind, e.message)
        finally:
            shutil.rmtree(root)
    root = tmp()
    try:
        tree(root, {"keep.txt": b"k", S.IGNORE_FILE: b"#" * S.MAX_IGNORE_BYTES})       # exactly 1 MiB: read
        assert "keep.txt" in S.scan(S.refuse_overlap(root, [])).files
        tree(root, {S.IGNORE_FILE: b"#\n" * S.MAX_IGNORE_LINES})                       # exactly 10,000 lines: read
        assert "keep.txt" in S.scan(S.refuse_overlap(root, [])).files
    finally:
        shutil.rmtree(root)


def test_ignore_lines_at_a_read_boundary():
    # the 10,000th newline as the last byte of one 64 KiB read: a 10,001st line starting in the next read still stops
    body = b"a" * 5541 + b"\n" + b"aaaaa\n" * 9999
    assert len(body) == 64 * 1024 and body.count(b"\n") == 10_000
    for extra, stops in ((b"", False), (b"x\n", True), (b"x", True)):
        root = tmp()
        try:
            tree(root, {"keep.txt": b"k", S.IGNORE_FILE: body + extra})
            try:
                S.scan(S.refuse_overlap(root, []))
                assert not stops, "no stop with %r after 10,000 lines" % extra
            except S.Refused as e:
                assert stops and e.message == "Stopped before planning: .sagebrushignore has more than 10,000 lines (the limit).", e.message
        finally:
            shutil.rmtree(root)


def test_ignore_file_lines_and_stability():
    # (astra a) lines are LF-separated, for the limit and for the rules alike: CRLF reads as LF, a lone CR is in its line
    root = tmp()
    try:
        tree(root, {"keep.txt": b"k", "a.log": b"x", "b.tmp": b"x", S.IGNORE_FILE: b"*.log\r\n*.tmp\r\n"})
        r = S.scan(S.refuse_overlap(root, []))
        assert "a.log" not in r.files and "b.tmp" not in r.files and "keep.txt" in r.files, sorted(r.files)
        tree(root, {S.IGNORE_FILE: b"#c\r" * (S.MAX_IGNORE_LINES + 5)})       # CR only: one line, not 10,005
        assert "keep.txt" in S.scan(S.refuse_overlap(root, [])).files
        assert S.Ignore(["a\rb"]).ignored("a\rb", False)
        tree(root, {S.IGNORE_FILE: b"a.log\rb.tmp\n"})                       # a lone CR: one rule
        r = S.scan(S.refuse_overlap(root, []))
        assert "a.log" in r.files and "b.tmp" in r.files, sorted(r.files)
        # (astra b) a change while it is read: refused before any rule is used
        tree(root, {S.IGNORE_FILE: b"#" * 200000 + b"\n*.txt\n"})
        real_read, calls = os.read, [0]

        def changing_read(fd, n):
            calls[0] += 1
            b = real_read(fd, n)
            if calls[0] == 1:
                with open(os.path.join(root, S.IGNORE_FILE), "ab") as f:
                    f.write(b"more\n")
            return b
        os.read = changing_read
        try:
            S.scan(S.refuse_overlap(root, []))
            raise AssertionError("an ignore file changed while read was used")
        except S.Refused as e:
            assert e.code == 1 and e.message == "Stopped before planning: .sagebrushignore couldn't be read (it changed while being read).", e.message
        finally:
            os.read = real_read
        # (grader G11) a same-size rewrite between reads: only its times show it, and it still stops
        p = os.path.join(root, S.IGNORE_FILE)
        tree(root, {S.IGNORE_FILE: b"#" * 200000 + b"\n*.txt\n"})
        calls[0] = 0

        def rewriting_read(fd, n):
            calls[0] += 1
            b = real_read(fd, n)
            if calls[0] == 1:
                st = os.stat(p)
                with open(p, "r+b") as f:
                    f.write(b"!")
                os.utime(p, ns=(st.st_atime_ns, st.st_mtime_ns - 10**10))   # (a time apart, whatever the clock's grain)
                assert os.stat(p).st_size == st.st_size
            return b
        os.read = rewriting_read
        try:
            S.scan(S.refuse_overlap(root, []))
            raise AssertionError("a same-size rewrite while read was used")
        except S.Refused as e:
            assert e.code == 1 and e.message.endswith("(it changed while being read)."), e.message
        finally:
            os.read = real_read
        # (grader G1) an ignore file far over the limit: never more than 1 MiB + 1 byte read
        tree(root, {S.IGNORE_FILE: b"#" * (S.MAX_IGNORE_BYTES + 300000)})
        got = [0]

        def counting_read(fd, n):
            b = real_read(fd, n)
            got[0] += len(b)
            return b
        os.read = counting_read
        try:
            S.scan(S.refuse_overlap(root, []))
            raise AssertionError("an ignore file over 1 MiB was used")
        except S.Refused as e:
            assert e.message.endswith("is over 1 MiB (the limit)."), e.message
        finally:
            os.read = real_read
        assert got[0] <= S.MAX_IGNORE_BYTES + 1, got[0]
    finally:
        shutil.rmtree(root)


def test_local_dir_a_file():
    # (grader S6) a plain file given as LOCAL_DIR: §1's words, exit 2
    root = tmp()
    try:
        p = os.path.join(root, "notes.txt")
        tree(root, {"notes.txt": b"x"})
        try:
            S.refuse_overlap(p, [])
            raise AssertionError("a file was taken as LOCAL_DIR")
        except S.Refused as e:
            assert e.code == 2 and e.message == "%s isn't a folder on this computer." % S._home_short(p), e.message
    finally:
        shutil.rmtree(root)


def test_ignore_file_must_be_utf8():
    # (@sagebrush's ruling; astra, sync-client) a malformed byte: refused, never a rule silently changed by decoding
    root = tmp()
    try:
        tree(root, {"keep.txt": b"k", "secret\xe9.txt": b"s", S.IGNORE_FILE: b"*.log\nsecret\xe9.txt\n"})
        try:
            S.scan(S.refuse_overlap(root, []))
            raise AssertionError("an ignore file that isn't UTF-8 was used")
        except S.Refused as e:
            assert e.code == 1 and e.message == "Stopped before planning: .sagebrushignore couldn't be read (it isn't UTF-8 text).", e.message
        tree(root, {S.IGNORE_FILE: "café.tmp\n".encode("utf-8")})                # valid UTF-8: read
        assert "keep.txt" in S.scan(S.refuse_overlap(root, [])).files
    finally:
        shutil.rmtree(root)


def test_ignore_cr_exactly_as_designed():
    # (@sagebrush's ruling, sync-client) one CR just before an LF is dropped; any other CR stays in its line (§4.4)
    root = tmp()
    try:
        tree(root, {"x": b""})
        cases = ((b"a\r\n", ["a"]), (b"a\r\r\n", ["a\r"]), (b"a\r", ["a\r"]),
                 (b"a\nb", ["a", "b"]), (b"a\n\n", ["a", ""]), (b"", []))
        for data, want in cases:
            tree(root, {S.IGNORE_FILE: data})
            fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
            try:
                got = S.read_ignore_file(fd)
            finally:
                os.close(fd)
            assert got == want, (data, got, want)
        # and a CR the reader kept is part of its rule: "a\r" matches only a name ending in a CR
        ig = S.Ignore(["a\r"])
        assert ig.ignored("a\r", False) and not ig.ignored("a", False)
    finally:
        shutil.rmtree(root)


def test_ignore_syntax_edges():
    ig = S.Ignore(["[z-a]x", "\\#lit", "\\!bang", "a\\*b", "[unclosed", "#comment", "a*c", "a?d", "sp.txt   ", "esc\\ "])
    assert not ig.ignored("#comment", False)                                    # (grader I1) a comment is no rule
    assert ig.ignored("abc", False) and not ig.ignored("a/x/c", False)          # (I6) * stays within a name
    assert ig.ignored("axd", False) and not ig.ignored("a/d", False)            # (I7) ? too
    assert ig.ignored("sp.txt", False) and not ig.ignored("sp.txt   ", False)  # (I9) trailing spaces dropped
    assert ig.ignored("esc ", False)                                            # unless escaped
    assert ig.ignored("[z-a]x", False) and not ig.ignored("zx", False)          # a malformed class: literal, no error
    assert ig.ignored("#lit", False) and ig.ignored("!bang", False)
    assert ig.ignored("a*b", False) and not ig.ignored("axb", False)
    assert ig.ignored("[unclosed", False)
    # (grader G9) an escaped trailing slash names a "/" within a name: it matches nothing, file or folder
    ig = S.Ignore(["foo\\/"])
    assert not [n for n in ("foo", "foo\\") for d in (False, True) if ig.ignored(n, d)]
    # the defaults can't be un-ignored
    root = tmp()
    try:
        tree(root, {".git/config": b"x", "keep.txt": b"k", S.IGNORE_FILE: b"!.git/\n!*.swp\n", "a.swp": b"x"})
        r = S.scan(S.refuse_overlap(root, []))
        assert ".git/config" not in r.files and "a.swp" not in r.files and "keep.txt" in r.files, sorted(r.files)
    finally:
        shutil.rmtree(root)


def test_bounded_work():
    # (astra 3) entries are counted as they are read, so a huge folder stops near the bound, not after listing it all
    root = tmp()
    real_scandir, real_read = os.scandir, os.read
    try:
        tree(root, {"f%03d" % i: b"" for i in range(300)})
        consumed = [0]

        class Counting:
            def __init__(self, it):
                self.it = it

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return self.it.__exit__(*a)

            def __iter__(self):
                return self

            def __next__(self):
                e = next(self.it)
                consumed[0] += 1
                return e

        os.scandir = lambda fd: Counting(real_scandir(fd))
        try:
            S.scan(S.refuse_overlap(root, []), limits={"entries": 10})
            raise AssertionError("no stop")
        except S.TooMany:
            pass
        finally:
            os.scandir = real_scandir
        assert consumed[0] <= 11, consumed[0]
        # a file that grows while it is hashed is refused after reading at most its stated size + 1 byte
        p = os.path.join(root, "grow")
        with open(p, "wb") as f:
            f.write(b"a" * 1000)
        st = os.stat(p)
        with open(p, "ab") as f:
            f.write(b"b" * (3 * S.HASH_CHUNK))
        read = [0]

        def counting_read(fd, n):
            b = real_read(fd, n)
            read[0] += len(b)
            return b
        os.read = counting_read
        fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
        try:
            S._hash(fd, "grow", st)
            raise AssertionError("a grown file was hashed")
        except OSError:
            pass
        finally:
            os.read = real_read
            os.close(fd)
        assert read[0] <= 1001, read[0]
    finally:
        os.scandir, os.read = real_scandir, real_read
        shutil.rmtree(root)


def test_raw_spelling_kept():
    root = tmp()
    try:
        nfd = unicodedata.normalize("NFD", "café.txt")
        tree(root, {nfd: b"x"})
        r = S.scan(S.refuse_overlap(root, []))
        f = r.files[unicodedata.normalize("NFC", "café.txt")]
        assert f.raw == nfd and f.raw != unicodedata.normalize("NFC", "café.txt")
    finally:
        shutil.rmtree(root)


def test_grader_gaps():
    base = tmp()
    saved_home, saved_platform = os.environ.get("HOME"), S.sys.platform
    try:
        # (S2) a sibling whose name starts with the state folder's is no overlap
        state, sib = os.path.join(base, "state"), os.path.join(base, "state2")
        os.makedirs(state)
        os.makedirs(sib)
        assert S.refuse_overlap(sib, [state]).path == os.path.realpath(sib)
        # LOCAL_DIR given as a link into the state folder: refused as inside, the link resolved first
        link = os.path.join(base, "lnk")
        os.symlink(state, link)
        try:
            S.refuse_overlap(link, [state])
            raise AssertionError("not refused")
        except S.Refused as e:
            assert "can't be synced: it is inside fs-sync's own files" in e.message, e.message
        # (S8) messages shorten the home folder to ~
        os.environ["HOME"] = os.path.realpath(base)
        try:
            S.refuse_overlap(state, [state])
            raise AssertionError("not refused")
        except S.Refused as e:
            assert e.message.startswith("~/state can't be synced"), e.message
        # (C3) a filesystem holding both Notes and nOTES tells case apart
        cs = os.path.join(base, "cs")
        tree(cs, {"Notes": b"1", "nOTES": b"2"})
        assert S.scan(S.refuse_overlap(cs, [])).case_insensitive is False
        # (C2) no name with letters: the platform's default
        nl = os.path.join(base, "nl")
        tree(nl, {"123": b"1"})
        S.sys.platform = "darwin"
        assert S.scan(S.refuse_overlap(nl, [])).case_insensitive is True
        S.sys.platform = "linux"
        assert S.scan(S.refuse_overlap(nl, [])).case_insensitive is False
        S.sys.platform = saved_platform
        # (SC7) the size limit exactly: kept; one byte over: skipped
        sz = os.path.join(base, "sz")
        tree(sz, {"b.bin": b"x" * 2000})
        assert "b.bin" in S.scan(S.refuse_overlap(sz, []), limits={"file_bytes": 2000}).files
        assert dict(S.scan(S.refuse_overlap(sz, []), limits={"file_bytes": 1999}).skipped).get("b.bin") == S.TOO_BIG
        # (SC13) an ignored symlink is listed as ignored
        ln = os.path.join(base, "ln")
        tree(ln, {"t.txt": b"t"})
        os.symlink(os.path.join(ln, "t.txt"), os.path.join(ln, "x.swp"))
        assert dict(S.scan(S.refuse_overlap(ln, [])).skipped).get("x.swp") == S.IGNORED
        # (H4) a file changed while it is hashed is listed as changed, not hashed
        ch = os.path.join(base, "ch")
        tree(ch, {"c.bin": b"z" * (3 * S.HASH_CHUNK)})
        real_read, calls = os.read, [0]

        def changing_read(fd, n):
            calls[0] += 1
            if calls[0] == 2:
                with open(os.path.join(ch, "c.bin"), "r+b") as f:
                    f.write(b"CHANGED")
            return real_read(fd, n)
        os.read = changing_read
        try:
            r = S.scan(S.refuse_overlap(ch, []))
        finally:
            os.read = real_read
        assert dict(r.skipped).get("c.bin") == S.CHANGED and "c.bin" not in r.files, r.skipped
    finally:
        S.sys.platform = saved_platform
        if saved_home is None:
            os.environ.pop("HOME", None)
        else:
            os.environ["HOME"] = saved_home
        shutil.rmtree(base)


def test_nfc_clash_folders():
    # two folders that are one name in NFC: nothing under either is synced, both are listed, siblings still scanned
    root = tmp()
    try:
        nfd, nfc = unicodedata.normalize("NFD", "résumé"), unicodedata.normalize("NFC", "résumé")
        tree(root, {nfd + "/a.txt": b"1", nfc + "/b.txt": b"2", "z-after.txt": b"z", "a-before.txt": b"a"})
        r = S.scan(S.refuse_overlap(root, []))
        assert sorted(r.files) == ["a-before.txt", "z-after.txt"], sorted(r.files)
        assert [w for p, w in r.skipped if p == nfc] == [S.NFC_CLASH, S.NFC_CLASH], r.skipped
    finally:
        shutil.rmtree(root)


def test_listing_fails_partway():
    # (sync-client S-a) a folder whose listing fails after some entries is skipped whole: nothing under it in files,
    # listed once as "folder/"; the root's listing failing stops the run
    root = tmp()
    real = os.scandir
    try:
        tree(root, {"sub/a.txt": b"a", "sub/b.txt": b"b", "sub/boom": b"x", "sub/z.txt": b"z", "sub/deeper/c.txt": b"c",
                    "sub/a.swp": b"s", "sub/deeper/x.swp": b"s", "other.txt": b"o", "sub2/x.txt": b"x"})
        os.symlink("x.txt", os.path.join(root, "sub2", "link"))    # (grader U4/U7) a sibling sharing the prefix, walked first

        class Failing:
            def __init__(self, it):
                self.real = it
                self.it = iter(sorted(it, key=lambda e: e.name, reverse=True))   # (sub2 before sub, every time)

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return self.real.__exit__(*a)

            def __iter__(self):
                return self

            def __next__(self):
                # (sub's listing fails at its end, after every entry, skipped ones included, has been handled)
                try:
                    e = next(self.it)
                except StopIteration:
                    if self.boom:
                        raise OSError(5, "Input/output error")
                    raise
                if e.name == "boom":
                    self.boom = True
                return e

            boom = False

        os.scandir = lambda fd: Failing(real(fd))
        try:
            r = S.scan(S.refuse_overlap(root, []))
        finally:
            os.scandir = real
        assert not [p for p in r.files if p.startswith("sub/")], sorted(r.files)
        assert [p for p, w in r.skipped if p.startswith("sub/")] == ["sub/"], r.skipped   # (daybreak3) nothing else under it
        assert "other.txt" in r.files
        assert "sub2/x.txt" in r.files and [p for p, w in r.skipped if p.startswith("sub2")] == ["sub2/link"], r.skipped
        # the root unlistable: stop before planning
        os.scandir = lambda fd: (_ for _ in ()).throw(OSError(13, "Permission denied"))
        try:
            S.scan(S.refuse_overlap(root, []))
            raise AssertionError("an unlistable root was scanned")
        except S.Refused as e:
            assert e.code == 1 and e.message.endswith("couldn't be listed (Permission denied)."), e.message
        finally:
            os.scandir = real
    finally:
        os.scandir = real
        shutil.rmtree(root)


def test_hash_shortcut_and_ctime_guard():
    root = tmp()
    try:
        tree(root, {"a.txt": b"aaaa", "b.txt": b"bbbb"})
        r1 = S.scan(S.refuse_overlap(root, []))
        known = {p: (f.key, f.sha256) for p, f in r1.files.items()}
        r2 = S.scan(S.refuse_overlap(root, []), known=known)
        assert r2.hashed == 0 and r2.files == r1.files          # a second run of an unchanged folder reads no contents
        # a same-size edit with its mtime put back (touch -r): ctime still moves, so it is hashed again
        p = os.path.join(root, "a.txt")
        st = os.stat(p)
        with open(p, "r+b") as f:
            f.write(b"AAAA")
        os.utime(p, ns=(st.st_atime_ns, st.st_mtime_ns))
        r3 = S.scan(S.refuse_overlap(root, []), known=known)
        assert r3.files["a.txt"].sha256 == sha(b"AAAA") and r3.hashed == 1, (r3.files, r3.hashed)
        # a known hash with a stale key is never trusted
        known["b.txt"] = ((0, 0, 0, 0, 0), "f" * 64)
        assert S.scan(S.refuse_overlap(root, []), known=known).files["b.txt"].sha256 == sha(b"bbbb")
    finally:
        shutil.rmtree(root)


if __name__ == "__main__":
    for name, f in list(globals().items()):
        if name.startswith("test_") and callable(f):
            f()
            print("ok", name)
    print("all fs-sync scan tests passed")
