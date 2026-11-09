#!/usr/bin/env python3
"""fs-sync's apply step for data files (sagebrush/fs_sync/apply.py; design/fs-sync.md §1.2, §2.3–2.5, §4.1, §4.3):
the real scan, planner, base and holding folder against an in-memory workspace with seams (409, 429, 401, 413, the
network), every action's check made to fail by changing a side at a seam, and the report's words as board wrote them."""

import errno
import hashlib
import json
import os
import shutil
import sqlite3
import stat
import tempfile

from sagebrush.fs_sync import apply as A
from sagebrush.fs_sync import holding as H
from sagebrush.fs_sync import move as M
from sagebrush.fs_sync import plan as P
from sagebrush.fs_sync import scan as S
from sagebrush.fs_sync import state as St
from sagebrush.fs_sync import workspace as W

NOW = 1_794_200_000                 # a fixed "now" (November 2026, UTC)
RID = H.run_id_at(NOW)
COMPUTER = "laptop"


def sha(b):
    return hashlib.sha256(b).hexdigest()


# ---- the workspace, in memory

class Fake(W.Workspace):
    """A workspace of data files: {path: (fid, bytes)}, compare-and-swap as the endpoint's. `fail[verb]` is a list of
    exceptions to raise, one per call, before the verb does anything; `on[verb](path)` runs first, as a seam."""

    def __init__(self, files=None):
        self.files, self.trash, self.calls, self.n = {}, [], [], 0
        self.fail, self.on = {}, {}
        self.kinds, self.sent = {}, {}              # (seams: an entry's kind, and bytes sent other than its own)
        for p, b in (files or {}).items():
            self.put(p, b)

    def put(self, path, data):
        """Change the workspace behind fs-sync's back (a new fid if the path is new)."""
        fid = self.files[path][0] if path in self.files else self._fid()
        self.files[path] = (fid, data)

    def _fid(self):
        self.n += 1
        return "f%d" % self.n

    def _seam(self, verb, path):
        self.calls.append((verb, path))
        if verb in self.on:
            self.on[verb](path)
        if self.fail.get(verb):
            raise self.fail[verb].pop(0)

    def entry(self, path):
        fid, b = self.files[path]
        return W.Entry(path, self.kinds.get(path, "file"), fid, sha(b), len(b))

    def listing(self):
        return {p: self.entry(p) for p in self.files}

    def list(self, path, after=None):
        names = sorted(self.files)
        return [self.entry(p) for p in names], None

    def stat(self, path):
        self._seam("stat", path)
        return self.entry(path) if path in self.files else None

    def read(self, path, writer, limit):
        self._seam("read", path)
        if path not in self.files:
            raise W.Conflict()
        b = self.sent.get(path, self.files[path][1])[:limit]
        for i in range(0, len(b), 3):               # (in small chunks, so a writer sees several)
            writer(b[i:i + 3])
        return self.entry(path), len(b)

    def write(self, path, data, base, sha256, size):
        self._seam("write", path)
        buf = b"".join(data)                        # (all of it first: an iteration that raises commits nothing)
        if (sha(buf), len(buf)) != (sha256, size):
            raise W.Conflict()                      # (the blob isn't the one named)
        cur = self.files.get(path)
        if base is None and cur is not None:
            raise W.Conflict()
        if base is not None and (cur is None or (cur[0], sha(cur[1])) != (base.fid, base.sha256)):
            raise W.Conflict()
        self.files[path] = (cur[0] if cur else self._fid(), buf)
        return self.entry(path)

    def remove(self, path, fid, sha256):
        self._seam("remove", path)
        cur = self.files.get(path)
        if cur is None or (cur[0], sha(cur[1])) != (fid, sha256):
            raise W.Conflict()
        self.trash.append((path, self.files.pop(path)))


# ---- a pair: LOCAL_DIR, the state folder, the base

class Pair:
    def __init__(self, files=None, remote=None):
        self.d = os.path.realpath(tempfile.mkdtemp(prefix="sb-fs-apply-"))
        self.local = os.path.join(self.d, "thesis")
        self.state = os.path.join(self.d, "state")
        os.mkdir(self.local)
        os.mkdir(self.state, 0o700)
        for p, b in (files or {}).items():
            self.write(p, b)
        self.ws = Fake(remote)
        self.base = St.Base.open(self.state, "acct", "grant1", self.local, "/Thesis")
        self.trash = os.path.join(self.state, "trash")

    def path(self, p):
        return os.path.join(self.local, p)

    def write(self, p, b):
        os.makedirs(os.path.dirname(self.path(p)), exist_ok=True)
        with open(self.path(p), "wb") as f:
            f.write(b)

    def read(self, p):
        with open(self.path(p), "rb") as f:
            return f.read()

    def plan(self):
        st = os.stat(self.local)
        self.root = S.Root(self.local, st.st_dev, st.st_ino)
        self.scan = S.scan(self.root, "/Thesis", self.base.known())
        self.listing = self.ws.listing()
        local = {p: P.Local(f.sha256) for p, f in self.scan.files.items()}
        remote = {p: P.Remote(e.kind, e.fid, e.sha256) for p, e in self.listing.items()}
        base = {p: P.Base(r.sha256, r.fid, r.snapshot, r.revision) for p, r in self.base.rows().items()}
        return P.plan(local, remote, base, computer=COMPUTER)

    def sync(self, plan=None, hooks=None, now=NOW, free_space=lambda fd: (os.fstat(fd).st_dev, 2**40)):
        plan = plan or self.plan()
        fd = S.open_root(self.root)
        try:
            self.report = A.apply(plan, self.scan, self.listing, fd, self.ws, self.base, self.state, self.local,
                                  "/Thesis", COMPUTER, now=now, hooks=hooks, free_space=free_space)
        finally:
            os.close(fd)
        return self.report

    def lines(self):
        return A.render(self.report)

    def held(self, *parts):
        return os.path.join(self.trash, *parts)

    def runs(self):
        return sorted(os.listdir(self.trash)) if os.path.isdir(self.trash) else []

    def journals(self):
        return [r for r in self.runs() if os.path.exists(self.held(r, A.JOURNAL))]

    def kinds(self):
        return [(o.step.kind, o.step.path, o.result, o.why) for o in self.report.outcomes]

    def close(self):
        self.base.close()
        shutil.rmtree(self.d)


def in_sync(pair):
    """After a run with nothing left over: the next plan has no actions at all."""
    return [s for s in pair.plan().steps if s.kind in P.ACTIONS] == []


# ---- the actions, done

def test_first_sync_both_ways():
    p = Pair({"a.txt": b"here", "same.txt": b"same", "n/m/deep.txt": b"deep"},
             {"b.txt": b"there", "same.txt": b"same", "x/y/z.txt": b"zz"})
    try:
        r = p.sync()
        assert sorted(p.kinds()) == sorted([
            (P.UPLOAD, "a.txt", A.DONE, None), (P.DOWNLOAD, "b.txt", A.DONE, None),
            (P.UPLOAD, "n/m/deep.txt", A.DONE, None), (P.RECORD, "same.txt", A.DONE, None),
            (P.DOWNLOAD, "x/y/z.txt", A.DONE, None)]), p.kinds()
        assert p.ws.files["a.txt"][1] == b"here" and p.ws.files["n/m/deep.txt"][1] == b"deep"
        assert p.read("b.txt") == b"there" and p.read("x/y/z.txt") == b"zz"
        rows = p.base.rows()
        assert sorted(rows) == ["a.txt", "b.txt", "n/m/deep.txt", "same.txt", "x/y/z.txt"]
        assert rows["b.txt"].fid == p.ws.files["b.txt"][0] and rows["b.txt"].sha256 == sha(b"there")
        st = os.stat(p.path("b.txt"))
        assert rows["b.txt"].key == (st.st_size, st.st_mtime_ns, st.st_ctime_ns, st.st_ino, st.st_dev)
        assert p.runs() == [] and p.journals() == []                 # (no move aside: no run folder, no journal)
        assert r.run_id == RID
        assert p.lines() == ["Upload (2 files)", "  + a.txt", "  + n/m/deep.txt",
                             "Download (2 files)", "  + b.txt", "  + x/y/z.txt"]
        assert in_sync(p)
    finally:
        p.close()


def test_upload_with_base_and_delete_there():
    p = Pair({"a.txt": b"v1", "gone.txt": b"g"})
    try:
        p.sync()
        fid = p.ws.files["a.txt"][0]
        p.write("a.txt", b"v2 here")
        os.unlink(p.path("gone.txt"))
        p.sync()
        assert p.kinds() == [(P.UPLOAD, "a.txt", A.DONE, None), (P.DELETE_THERE, "gone.txt", A.DONE, None)]
        assert p.ws.files["a.txt"] == (fid, b"v2 here")              # (the same entry, replaced by compare-and-swap)
        assert [t[0] for t in p.ws.trash] == ["gone.txt"] and "gone.txt" not in p.base.rows()
        assert p.lines() == ["Upload (1 file)", "  ~ a.txt", "Delete in the workspace, to its Trash (1 file)",
                             "  - gone.txt"]
        assert in_sync(p)
    finally:
        p.close()


def test_delete_here_goes_to_deleted_with_a_journal():
    p = Pair({"keep.txt": b"k", "notes/a.tex": b"aaa"})
    try:
        p.sync()
        del p.ws.files["notes/a.tex"]
        seen = []
        p.sync(hooks={"after_move_aside": lambda step: seen.append(p.base.rows_one(step.path))})
        assert p.kinds() == [(P.DELETE_HERE, "notes/a.tex", A.DONE, None)]
        assert seen == [None]                                       # (its row removed and committed before the move)
        assert not os.path.exists(p.path("notes/a.tex"))
        with open(p.held(RID, "deleted", "notes", "a.tex"), "rb") as f:
            assert f.read() == b"aaa"
        assert stat.S_IMODE(os.stat(p.held(RID, "deleted", "notes")).st_mode) == 0o700
        assert "notes/a.tex" not in p.base.rows()
        assert p.journals() == [RID]
        with open(p.held(RID, "journal.json")) as f:
            assert json.load(f) == {"run": RID, "local_dir": p.local, "workspace_path": "/Thesis"}
        assert p.lines() == [
            "Delete on this computer, to the holding folder (1 file; restore with fs-sync --restore %s for 30 days)"
            % RID, "  - notes/a.tex"]
        assert in_sync(p)
    finally:
        p.close()


def test_replacing_download_goes_to_replaced_and_says_where():
    p = Pair({"refs.bib": b"old"})
    try:
        p.sync()
        p.ws.put("refs.bib", b"new from the workspace")
        p.sync()
        assert p.kinds() == [(P.DOWNLOAD, "refs.bib", A.DONE, None)]
        assert p.read("refs.bib") == b"new from the workspace"
        where = p.held(RID, "replaced", "refs.bib")
        with open(where, "rb") as f:
            assert f.read() == b"old"
        assert p.report.outcomes[0].held == where                   # (the path it was moved to, kept as it was)
        assert p.lines() == ["Download (1 file)",
                             "  ~ refs.bib   replaced; this computer's previous copy is kept for 30 days in %s" % where]
        assert p.base.rows()["refs.bib"].sha256 == sha(b"new from the workspace")
        assert in_sync(p)
    finally:
        p.close()


def test_restore_puts_back_deleted_only():
    # (grader's §5 case) a run that both deletes `a` here and replaces `b` by a download: --restore puts back `a`
    # only; `b`'s old copy stays in the holding folder, and the run's report names its path there
    p = Pair({"a": b"a1", "b": b"b1"})
    try:
        p.sync()
        del p.ws.files["a"]
        p.ws.put("b", b"b2")
        p.sync()
        assert sorted(p.kinds()) == [(P.DELETE_HERE, "a", A.DONE, None), (P.DOWNLOAD, "b", A.DONE, None)]
        os.unlink(p.path("b"))                                      # (even with b's name free, it isn't put back)
        h = M.Holding(p.state, RID)
        for name in ("", ".", "..", "x", "deleted/x"):
            try:
                M.Part(h, name)
                raise AssertionError("a part named %r" % name)
            except ValueError:
                pass
        part = M.Part(h, M.DELETED)
        fd = S.open_root(p.root)
        try:
            assert M.restore(fd, part) == []
        finally:
            os.close(fd)
            part.close()
            h.close()
        assert p.read("a") == b"a1" and not os.path.exists(p.path("b"))
        with open(p.held(RID, "replaced", "b"), "rb") as f:
            assert f.read() == b"b1"
    finally:
        p.close()


def test_conflict_both_kept():
    p = Pair({"main.tex": b"base"})
    try:
        p.sync()
        p.write("main.tex", b"mine")
        p.ws.put("main.tex", b"theirs")
        p.sync()
        copy = "main (conflict, laptop).tex"
        assert p.kinds() == [(P.CONFLICT, "main.tex", A.DONE, None)]
        assert p.read("main.tex") == b"theirs" and p.read(copy) == b"mine"
        assert p.ws.files[copy][1] == b"mine" and p.ws.files["main.tex"][1] == b"theirs"
        rows = p.base.rows()
        assert rows[copy].sha256 == sha(b"mine") and rows[copy].fid == p.ws.files[copy][0]
        assert rows["main.tex"].sha256 == sha(b"theirs")
        assert p.runs() == []                                       # (nothing is moved aside in a conflict)
        assert p.lines() == ["Conflicts, both kept (1 file)", "  ! main.tex"]
        assert in_sync(p)
    finally:
        p.close()


def test_a_notebook_as_a_data_file_is_recorded_as_a_snapshot():
    # (a notebook name with a data file in the workspace comes down as its bytes, under the snapshot rules: §3.4)
    p = Pair({}, {"Notes.ipynb": b"{}"})
    try:
        p.sync()
        assert p.kinds() == [(P.DOWNLOAD, "Notes.ipynb", A.DONE, None)] and p.base.rows()["Notes.ipynb"].snapshot
        assert in_sync(p)
    finally:
        p.close()


def test_rows_committed_by_the_end_of_the_run():
    p = Pair({"a": b"a"})
    try:
        p.sync()
        c = sqlite3.connect("file:%s?mode=ro" % p.base.path, uri=True)
        try:
            assert [r[0] for r in c.execute("SELECT path FROM base")] == ["a"]
        finally:
            c.close()
    finally:
        p.close()


def test_forget():
    p = Pair({"a": b"a"})
    try:
        p.sync()
        os.unlink(p.path("a"))
        del p.ws.files["a"]
        p.sync()
        assert p.kinds() == [(P.FORGET, "a", A.DONE, None)] and p.base.rows() == {} and p.lines() == []
    finally:
        p.close()


# ---- the checks (§4.1): each made to fail at a seam

def test_upload_changed_here_commits_nothing():
    p = Pair({"a.txt": b"v1"})
    try:
        p.sync()
        p.write("a.txt", b"v2")
        before = p.ws.files["a.txt"]
        p.sync(hooks={"before_check": lambda s: p.write("a.txt", b"v3, during")})
        assert p.kinds() == [(P.UPLOAD, "a.txt", A.SKIPPED, A.CHANGED_HERE)]
        assert p.ws.files["a.txt"] == before and p.base.rows()["a.txt"].sha256 == sha(b"v1")
        assert p.lines() == ["Skipped (1)", "  · a.txt   changed here during the sync",
                             "Run it again to sync the rest."]
    finally:
        p.close()


def test_upload_changed_here_same_size_is_hashed():
    p = Pair({"a.txt": b"v1"})
    try:
        p.sync()
        p.write("a.txt", b"v2")
        before = p.ws.files["a.txt"]
        p.sync(hooks={"before_check": lambda s: p.write("a.txt", b"v3")})      # (the same size: only the hash tells)
        assert p.kinds() == [(P.UPLOAD, "a.txt", A.SKIPPED, A.CHANGED_HERE)] and p.ws.files["a.txt"] == before
    finally:
        p.close()


def test_upload_changed_there_is_409():
    p = Pair({"a.txt": b"v1"})
    try:
        p.sync()
        p.write("a.txt", b"v2")
        p.sync(hooks={"before_check": lambda s: p.ws.put("a.txt", b"edited there")})
        assert p.kinds() == [(P.UPLOAD, "a.txt", A.SKIPPED, A.CHANGED_THERE)]
        assert p.ws.files["a.txt"][1] == b"edited there"
        assert p.lines() == ["Skipped (1)", "  · a.txt   changed in the workspace during the sync",
                             "Run it again to sync the rest."]
        assert [s.kind for s in p.plan().steps] == [P.CONFLICT]     # (and the next run sees both changes)
    finally:
        p.close()


def test_new_upload_create_only():
    p = Pair({"a.txt": b"mine"})
    try:
        p.sync(hooks={"before_check": lambda s: p.ws.put("a.txt", b"someone else's")})
        assert p.kinds() == [(P.UPLOAD, "a.txt", A.SKIPPED, A.CHANGED_THERE)]
        assert p.ws.files["a.txt"][1] == b"someone else's" and p.base.rows() == {}
    finally:
        p.close()


def test_download_changed_there_leaves_no_temp():
    p = Pair({"r.txt": b"old"})
    try:
        p.sync()
        p.ws.put("r.txt", b"new")
        p.sync(hooks={"before_check": lambda s: p.ws.put("r.txt", b"newer, during")})
        assert p.kinds() == [(P.DOWNLOAD, "r.txt", A.SKIPPED, A.CHANGED_THERE)]
        assert p.read("r.txt") == b"old" and os.listdir(p.local) == ["r.txt"]
        assert p.base.rows()["r.txt"].sha256 == sha(b"old")         # (the old row put back)
        assert p.runs() == [] and p.journals() == []                # (the run folder took nothing: removed)
    finally:
        p.close()


def test_download_wrong_fid_is_changed_there():
    p = Pair({}, {"r.txt": b"same bytes"})
    try:
        plan = p.plan()

        def swap(step):
            fid, b = p.ws.files.pop("r.txt")
            p.ws.files["r.txt"] = ("other", b)                      # (the same bytes, another entry)
        p.sync(plan, hooks={"before_check": swap})
        assert p.kinds() == [(P.DOWNLOAD, "r.txt", A.SKIPPED, A.CHANGED_THERE)]
        assert os.listdir(p.local) == []
    finally:
        p.close()


def test_replacing_download_changed_here():
    p = Pair({"r.txt": b"old"})
    try:
        p.sync()
        p.ws.put("r.txt", b"new")
        p.sync(hooks={"after_tmp_written": lambda s: p.write("r.txt", b"edited here, during")})
        assert p.kinds() == [(P.DOWNLOAD, "r.txt", A.SKIPPED, A.CHANGED_HERE)]
        assert p.read("r.txt") == b"edited here, during" and os.listdir(p.local) == ["r.txt"]   # (temp removed)
        assert p.base.rows()["r.txt"].sha256 == sha(b"old")
        assert p.runs() == [] and p.journals() == []
    finally:
        p.close()


def test_delete_here_rests_on_a_fresh_stat():
    p = Pair({"a": b"a"})
    try:
        p.sync()
        old = p.base.rows()["a"]
        del p.ws.files["a"]
        p.sync(hooks={"before_check": lambda s: p.ws.put("a", b"back again")})
        assert p.kinds() == [(P.DELETE_HERE, "a", A.SKIPPED, A.CHANGED_THERE)]
        assert p.read("a") == b"a" and p.base.rows()["a"] == old
        assert p.runs() == [] and p.journals() == []
    finally:
        p.close()


def test_delete_here_changed_here_moved_back():
    p = Pair({"a": b"a"})
    try:
        p.sync()
        del p.ws.files["a"]
        p.sync(hooks={"before_check": lambda s: p.write("a", b"edited")})
        assert p.kinds() == [(P.DELETE_HERE, "a", A.SKIPPED, A.CHANGED_HERE)]
        assert p.read("a") == b"edited"
        assert p.runs() == [] and p.journals() == []
    finally:
        p.close()


def test_delete_there_409_puts_the_row_back():
    p = Pair({"a": b"a"})
    try:
        p.sync()
        old = p.base.rows()["a"]
        os.unlink(p.path("a"))
        p.sync(hooks={"before_check": lambda s: p.ws.put("a", b"edited there")})
        assert p.kinds() == [(P.DELETE_THERE, "a", A.SKIPPED, A.CHANGED_THERE)]
        assert p.ws.files["a"][1] == b"edited there" and p.base.rows()["a"] == old
    finally:
        p.close()


def test_newcomer_in_a_folder_names_the_path():
    p = Pair({}, {"lit/refs.bib": b"theirs"})
    try:
        p.sync(hooks={"before_install": lambda s: p.write("lit/refs.bib", b"a newcomer")})
        assert p.lines()[1] == ("  · lit/refs.bib   a file appeared there during the sync; the workspace's version is "
                                "saved beside it as \"lit/refs (conflict, laptop).bib\"")
        assert p.read("lit/refs (conflict, laptop).bib") == b"theirs"
    finally:
        p.close()


def test_newcomer_at_a_download():
    p = Pair({}, {"refs.bib": b"theirs"})
    try:
        p.sync(hooks={"before_install": lambda s: p.write("refs.bib", b"a newcomer")})
        o = p.report.outcomes[0]
        assert (o.result, o.why, o.beside) == (A.SKIPPED, A.BESIDE, "refs (conflict, laptop).bib")
        assert p.read("refs.bib") == b"a newcomer" and p.read("refs (conflict, laptop).bib") == b"theirs"
        assert p.base.rows() == {}
        assert p.lines() == ["Skipped (1)", "  · refs.bib   a file appeared there during the sync; the workspace's "
                             "version is saved beside it as \"refs (conflict, laptop).bib\"",
                             "Run it again to sync the rest."]
    finally:
        p.close()


def test_newcomer_at_a_replacing_download_keeps_the_old_copy():
    p = Pair({"refs.bib": b"old"})
    try:
        p.sync()
        p.ws.put("refs.bib", b"new")
        p.sync(hooks={"before_install": lambda s: p.write("refs.bib", b"a newcomer")})
        where = p.held(RID, "replaced", "refs.bib")
        o = p.report.outcomes[0]
        assert (o.result, o.why, o.held) == (A.SKIPPED, A.BESIDE, where)
        assert "refs.bib" not in p.base.rows()                       # (the file left: nothing recorded for the path)
        assert p.journals() == [RID]
        assert p.lines()[1] == ("  · refs.bib   a file appeared there during the sync; the workspace's version is "
                                "saved beside it as \"refs (conflict, laptop).bib\"; this computer's previous copy is "
                                "kept for 30 days in %s" % where)
    finally:
        p.close()


def test_all_conflict_names_taken():
    p = Pair({}, {"main.tex": b"theirs"})
    try:
        real = M.conflict_name

        def racing(path, computer, taken):
            name = real(path, computer, taken)
            p.write(name, b"taken meanwhile")                       # (each name taken just before the rename)
            return name
        M.conflict_name = racing
        try:
            p.sync(hooks={"before_install": lambda s: p.write("main.tex", b"newcomer")})
        finally:
            M.conflict_name = real
        assert p.kinds() == [(P.DOWNLOAD, "main.tex", A.PENDING, A.NO_CONFLICT_NAME)]
        assert any(n.startswith(".sagebrush-tmp-") for n in os.listdir(p.local))     # (the temp: swept next run)
        assert p.lines() == [
            "Not applied (1)",
            "  · main.tex   all 8 conflict names for it are taken (\"main (conflict, laptop).tex\" to "
            "\"main (conflict, laptop) (8).tex\"); rename or remove some, then run it again",
            "Run it again to sync the rest."]
        p.sync(now=NOW + 60)
        assert not any(n.startswith(".sagebrush-tmp-") for n in os.listdir(p.local))
    finally:
        p.close()


def test_conflict_copy_name_taken_meanwhile():
    p = Pair({"main.tex": b"base"})
    try:
        p.sync()
        p.write("main.tex", b"mine")
        p.ws.put("main.tex", b"theirs")
        p.sync(hooks={"before_check": lambda s: p.write("main (conflict, laptop).tex", b"someone's")})
        assert p.kinds() == [(P.CONFLICT, "main.tex", A.SKIPPED, A.CHANGED_HERE)]
        assert p.read("main.tex") == b"mine" and p.read("main (conflict, laptop).tex") == b"someone's"
        assert "main (conflict, laptop).tex" not in p.ws.files
    finally:
        p.close()


def test_conflict_download_changed_there_keeps_the_copy_recorded():
    p = Pair({"main.tex": b"base"})
    try:
        p.sync()
        p.write("main.tex", b"mine")
        p.ws.put("main.tex", b"theirs")
        p.ws.on["read"] = lambda path: p.ws.put("main.tex", b"theirs, again")
        p.sync()
        copy = "main (conflict, laptop).tex"
        assert p.kinds() == [(P.CONFLICT, "main.tex", A.SKIPPED, A.CHANGED_THERE)]
        assert p.read(copy) == b"mine" and p.ws.files[copy][1] == b"mine" and p.base.rows()[copy].sha256 == sha(b"mine")
        assert not os.path.exists(p.path("main.tex"))
        del p.ws.on["read"]
        p.sync(now=NOW + 60)                                        # (the next run brings the workspace's down)
        assert p.read("main.tex") == b"theirs, again" and in_sync(p)
    finally:
        p.close()


def test_download_bytes_checked_not_only_the_entry():
    p = Pair({}, {"r.txt": b"right"})
    try:
        p.ws.sent["r.txt"] = b"wrong"                               # (the entry says one hash, the bytes are others)
        p.sync()
        assert p.kinds() == [(P.DOWNLOAD, "r.txt", A.SKIPPED, A.CHANGED_THERE)] and os.listdir(p.local) == []
    finally:
        p.close()


def test_download_entry_kind_checked():
    p = Pair({}, {"r.txt": b"bytes"})
    try:
        plan = p.plan()
        p.ws.kinds["r.txt"] = "notebook"                            # (the same fid and hash, now a document)
        p.sync(plan)
        assert p.kinds() == [(P.DOWNLOAD, "r.txt", A.SKIPPED, A.CHANGED_THERE)] and os.listdir(p.local) == []
    finally:
        p.close()


def test_delete_here_held_when_its_name_is_taken_meanwhile():
    p = Pair({"a": b"a"})
    try:
        p.sync()
        del p.ws.files["a"]
        where = p.held(RID, "deleted", "a")

        def swap(step):
            with open(where, "wb") as f:
                f.write(b"not the planned file")                    # (what was moved isn't what was planned)
            p.write("a", b"a newcomer")                              # (and its name is taken: it can't go back)
        p.sync(hooks={"after_move_aside": swap})
        o = p.report.outcomes[0]
        assert (o.result, o.why, o.held) == (A.SKIPPED, A.CHANGED_HERE, where)
        assert p.read("a") == b"a newcomer" and "a" not in p.base.rows() and p.runs() == [RID]
        assert p.journals() == [RID]                      # (held: its run folder and journal kept)
        assert p.lines() == ["Skipped (1)", "  · a   changed here during the sync; this computer's previous copy is "
                             "kept for 30 days in %s" % where, "Run it again to sync the rest."]
    finally:
        p.close()


def test_no_room_for_the_base_holds_destructive_actions_back():
    p = Pair({"a": b"a", "b": b"b1"})
    try:
        p.sync()
        del p.ws.files["a"]
        p.write("b", b"b2")
        msg = ("Not applied: fs-sync's record for this folder pair is nearly full (1 GiB). Sync its subfolders as "
               "separate pairs instead.")
        p.base.reserve_problem = lambda: msg
        p.sync()
        assert p.kinds() == [(P.DELETE_HERE, "a", A.PENDING, A.HELD_BACK), (P.UPLOAD, "b", A.DONE, None)]
        assert p.report.run_lines == [msg] and p.read("a") == b"a" and p.base.rows_one("a") is not None
    finally:
        p.close()


# ---- workspace errors

def test_429_stops_the_run():
    p = Pair({"a": b"a", "b": b"b", "c": b"c"})
    try:
        p.ws.fail["write"] = [W.RateLimited(30)]
        calls = []
        p.ws.on["write"] = calls.append
        p.sync()
        assert p.kinds() == [(P.UPLOAD, "a", A.NOT_TRIED, "rate-limited"), (P.UPLOAD, "b", A.NOT_TRIED, "rate-limited"),
                             (P.UPLOAD, "c", A.NOT_TRIED, "rate-limited")]
        assert calls == ["a"] and p.report.stopped == "rate-limited" and p.report.retry_after == 30
        assert p.ws.files == {} and p.base.rows() == {}
    finally:
        p.close()


def test_401_stops_and_records_what_was_done():
    p = Pair({"a": b"a", "b": b"b"})
    try:
        p.ws.on["write"] = lambda path: path == "b" and p.ws.fail.setdefault("write", []).append(W.Unauthorized())
        p.sync()
        assert p.kinds() == [(P.UPLOAD, "a", A.DONE, None), (P.UPLOAD, "b", A.NOT_TRIED, "unauthorized")]
        assert sorted(p.base.rows()) == ["a"]                       # (the batch is committed when the run stops)
    finally:
        p.close()


def test_413_leaves_one_pending():
    p = Pair({"a": b"a", "b": b"b"})
    try:
        p.ws.fail["write"] = [W.TooLarge()]
        p.sync()
        assert p.kinds() == [(P.UPLOAD, "a", A.PENDING, A.TOO_LARGE), (P.UPLOAD, "b", A.DONE, None)]
    finally:
        p.close()


def test_network_error_stops_but_a_local_one_skips():
    p = Pair({"a": b"a", "b": b"b"})
    try:
        p.ws.fail["write"] = [ConnectionResetError(errno.ECONNRESET, "Connection reset by peer")]
        p.sync()
        assert p.kinds() == [(P.UPLOAD, "a", A.NOT_TRIED, "network"), (P.UPLOAD, "b", A.NOT_TRIED, "network")]
        p.ws.fail["write"] = [TimeoutError(errno.ETIMEDOUT, "Connection timed out")]
        p.sync(now=NOW + 30)
        assert p.report.stopped == "network"
        p.ws.fail["write"] = [OSError(errno.EHOSTUNREACH, "No route to host")]
        p.sync(now=NOW + 40)
        assert p.report.stopped == "network"
        if os.geteuid() != 0:
            p.sync(now=NOW + 60, hooks={"before_check": lambda s: s.path == "a" and os.chmod(p.path("a"), 0)})
            assert p.kinds() == [(P.UPLOAD, "a", A.SKIPPED, A.LOCAL_ERROR), (P.UPLOAD, "b", A.DONE, None)]
            assert p.lines()[:2] == ["Upload (1 file)", "  + b"]
            assert p.lines()[3] == "  · a   an error on this computer: Permission denied"
    finally:
        p.close()


def test_local_fstat_error_is_local_not_the_network():
    # (daybreak3 E3) an OS error reading the file being uploaded skips that upload; the run goes on
    p = Pair({"a": b"a", "b": b"b"})
    try:
        real = os.fstat

        def fstat(fd):
            if os.readlink("/proc/self/fd/%d" % fd).endswith("/thesis/a"):
                raise OSError(errno.EIO, "Input/output error")
            return real(fd)
        plan = p.plan()
        os.fstat = fstat
        try:
            p.sync(plan)
        finally:
            os.fstat = real
        assert p.kinds() == [(P.UPLOAD, "a", A.SKIPPED, A.LOCAL_ERROR), (P.UPLOAD, "b", A.DONE, None)]
        assert p.report.stopped is None and p.lines()[3] == "  · a   an error on this computer: Input/output error"
    finally:
        p.close()


# ---- the holding folder: busy, refused, other disk, run ids, not yours, errors

def test_busy_holds_back_moves_only():
    p = Pair({"a": b"a", "up": b"u"})
    try:
        p.sync()
        del p.ws.files["a"]
        p.write("up", b"u2")
        other = H.Session.open(p.state)
        try:
            p.sync()
        finally:
            other.close()
        assert p.kinds() == [(P.DELETE_HERE, "a", A.PENDING, A.HELD_BACK), (P.UPLOAD, "up", A.DONE, None)]
        assert p.read("a") == b"a" and p.runs() == [] and p.journals() == []
        assert p.lines() == [
            "Not applied: deleting or replacing files in %s, while another fs-sync moves files into the holding "
            "folder. Run it again when that one finishes." % p.local,
            "Upload (1 file)", "  ~ up", "Run it again to sync the rest."]
    finally:
        p.close()


def test_busy_without_moves_says_nothing():
    p = Pair({"up": b"u"})
    try:
        other = H.Session.open(p.state)
        try:
            p.sync()
        finally:
            other.close()
        assert p.report.run_lines == [] and p.kinds() == [(P.UPLOAD, "up", A.DONE, None)]
    finally:
        p.close()


def test_cleanup_first_every_run():
    p = Pair({"up": b"u"})
    try:
        old = H.run_id_at(NOW - 31 * 86400)
        os.makedirs(p.held(old, "deleted"), 0o700)
        open(p.held(old, "journal.json"), "w").close()
        p.sync()
        assert p.report.cleaned == [old] and p.runs() == [] and p.journals() == []
    finally:
        p.close()


def test_admission_refused_removes_the_run_folder():
    p = Pair({"n/a": b"a", "n/b": b"b"})
    try:
        p.sync()
        p.ws.files.clear()
        saved = H.RUN_ENTRIES
        H.RUN_ENTRIES = 5                       # (deleted, n, a, b, the journal and the run folder: 6)
        try:
            p.sync()
        finally:
            H.RUN_ENTRIES = saved
        assert p.kinds() == [(P.DELETE_HERE, "n/a", A.PENDING, A.HELD_BACK),
                             (P.DELETE_HERE, "n/b", A.PENDING, A.HELD_BACK)]
        assert p.runs() == [] and p.journals() == [] and sorted(p.base.rows()) == ["n/a", "n/b"]
        assert p.report.admission.entries == 6
        assert p.lines() == [
            "Not applied: deleting or replacing files in %s. This sync would move 6 files and folders into fs-sync's "
            "holding folder, over the limit of 5 for one sync. Sync its subfolders as separate pairs instead."
            % p.local, "Run it again to sync the rest."]
    finally:
        p.close()


def test_journal_counted_once_at_the_bounds():
    # (daybreak2 L1) the run's entries are deleted/, n, n/a, n/b, the journal and the run folder: 6. The total is what
    # is held (the run folder, made by new_run, is already among it) plus the other 5. Exact and one past, each bound.
    for name, bound, ok in (("RUN_ENTRIES", 6, True), ("RUN_ENTRIES", 5, False),
                            ("TOTAL_ENTRIES", 6, True), ("TOTAL_ENTRIES", 5, False)):
        p = Pair({"n/a": b"a", "n/b": b"b"})
        try:
            p.sync()
            p.ws.files.clear()
            saved = getattr(H, name)
            setattr(H, name, bound)
            try:
                p.sync()
            finally:
                setattr(H, name, saved)
            a = p.report.admission
            assert (a.ok, a.entries, a.held_entries) == (ok, 6, 1), (name, bound, a)
            assert [o.result for o in p.report.outcomes] == ([A.DONE] * 2 if ok else [A.PENDING] * 2), (name, bound)
        finally:
            p.close()


def test_admission_lines_word_for_word():
    local, trash = "~/thesis", "~/.local/state/sagebrush/fs-sync/trash"
    a = H.Admission(False, "run-entries", entries=120_000)
    assert A._admission_line(a, local, trash) == (
        "Not applied: deleting or replacing files in ~/thesis. This sync would move 120,000 files and folders into "
        "fs-sync's holding folder, over the limit of 100,000 for one sync. Sync its subfolders as separate pairs "
        "instead.")
    a = H.Admission(False, "run-bytes", bytes=int(12.4 * 2**30))
    assert A._admission_line(a, local, trash) == (
        "Not applied: deleting or replacing files in ~/thesis. This sync would move 12.4 GiB into fs-sync's holding "
        "folder, over the limit of 10 GiB for one sync. Sync its subfolders as separate pairs instead.")
    a = H.Admission(False, "total-entries", entries=15_000, held_entries=190_001)
    assert A._admission_line(a, local, trash) == (
        "Not applied: deleting or replacing files in ~/thesis. fs-sync's holding folder "
        "(~/.local/state/sagebrush/fs-sync/trash) holds 190,000 files and folders, and this sync would add 15,000, "
        "over its limit of 200,000. Each sync's folder there is removed 30 days after that sync.")
    a = H.Admission(False, "total-bytes", bytes=int(3.1 * 2**30), held_bytes=int(18.2 * 2**30))
    assert A._admission_line(a, local, trash) == (
        "Not applied: deleting or replacing files in ~/thesis. fs-sync's holding folder "
        "(~/.local/state/sagebrush/fs-sync/trash) holds 18.2 GiB, and this sync would add 3.1 GiB, over its limit of "
        "20 GiB. Each sync's folder there is removed 30 days after that sync.")
    a = H.Admission(False, "holding-unreadable", detail="Permission denied (%s/20261108-1402)" % trash)
    assert A._admission_line(a, local, trash) == (
        "Not applied: deleting or replacing files in ~/thesis. fs-sync couldn't measure its holding folder "
        "(~/.local/state/sagebrush/fs-sync/trash): Permission denied "
        "(~/.local/state/sagebrush/fs-sync/trash/20261108-1402).")


def test_other_disk():
    p = Pair({"a": b"a"})
    try:
        p.sync()
        del p.ws.files["a"]
        saved = M.Holding.same_filesystem
        M.Holding.same_filesystem = lambda self, fd: False
        try:
            p.sync()
        finally:
            M.Holding.same_filesystem = saved
        assert p.kinds() == [(P.DELETE_HERE, "a", A.PENDING, A.HELD_BACK)] and p.runs() == []
        here, there = A._mount_point(p.local), A._mount_point(p.state)
        assert p.report.run_lines == [
            "Not applied: deleting or replacing files on %s needs fs-sync's holding folder on the same disk, and it is "
            "on %s. Set XDG_STATE_HOME to a folder on %s outside the synced folder to allow it. The next run is then "
            "a first sync: nothing is deleted until the one after." % (here, there, here)]
    finally:
        p.close()


def test_no_run_id_left_this_second():
    p = Pair({"a": b"a"})
    try:
        p.sync(now=NOW - 60)
        del p.ws.files["a"]
        for n in range(1, H.MAX_SAME_SECOND + 1):
            os.makedirs(p.held(RID if n == 1 else "%s-%d" % (RID, n)), 0o700)
        p.sync()
        assert p.kinds() == [(P.DELETE_HERE, "a", A.PENDING, A.HELD_BACK)]
        assert p.report.run_lines == [
            "Not applied: deleting or replacing files in %s. fs-sync's holding folder already has 9 folders named for "
            "this second (%s to %s-9). Run it again." % (p.local, RID, RID)]
    finally:
        p.close()


def test_holding_folder_not_yours():
    p = Pair({"a": b"a"})
    try:
        p.sync()
        del p.ws.files["a"]
        real = M.os.getuid
        M.os.getuid = lambda: real() + 1                            # (every folder there now looks like another's)
        try:
            p.sync()
        finally:
            M.os.getuid = real
        assert p.kinds() == [(P.DELETE_HERE, "a", A.PENDING, A.HELD_BACK)]
        assert p.report.run_lines == [
            "Not applied: deleting or replacing files in %s. %s isn't a folder of yours, so fs-sync won't move files "
            "into it." % (p.local, p.trash)]
    finally:
        p.close()


def test_a_folder_in_the_run_not_yours_names_it():
    p = Pair({"n/a": b"a", "n/c": b"c", "b": b"b"})
    try:
        p.sync()
        p.ws.files.clear()
        real = M.own_dirs

        def own_dirs(fd, parts):
            if parts == ["n"]:
                raise PermissionError(errno.EPERM, A._NOT_YOURS, "n")
            return real(fd, parts)
        M.own_dirs = own_dirs
        try:
            p.sync()
        finally:
            M.own_dirs = real
        assert sorted(p.kinds()) == [(P.DELETE_HERE, "b", A.DONE, None), (P.DELETE_HERE, "n/a", A.PENDING, A.HELD_BACK),
                                     (P.DELETE_HERE, "n/c", A.PENDING, A.HELD_BACK)]
        assert p.report.run_lines == [                              # (once, for both)
            "Not applied: deleting or replacing files in %s. %s isn't a folder of yours, so fs-sync won't move files "
            "into it." % (p.local, p.held(RID, "deleted", "n"))]
        assert p.read("n/a") == b"a" and p.base.rows_one("n/a") is not None
    finally:
        p.close()


def test_holding_os_error_names_the_other_path():
    p = Pair({"n/a": b"a"})
    try:
        p.sync()
        p.ws.files.clear()
        real = M.own_dirs

        def own_dirs(fd, parts):
            if parts == ["n"]:
                raise PermissionError(errno.EACCES, "Permission denied", "n")
            return real(fd, parts)
        M.own_dirs = own_dirs
        try:
            p.sync()
        finally:
            M.own_dirs = real
        assert p.kinds() == [(P.DELETE_HERE, "n/a", A.PENDING, A.HOLD_ERROR)]
        assert p.lines() == ["Not applied (1)", "  · n/a   not moved to the holding folder: Permission denied (%s)"
                             % p.held(RID, "deleted", "n"), "Run it again to sync the rest."]
        assert p.read("n/a") == b"a"
    finally:
        p.close()


def test_no_replace_rename():
    p = Pair({"a": b"a"})
    try:
        p.sync()
        del p.ws.files["a"]
        real = M.rename_noreplace

        def refuse(*args):
            raise M.NoReplace("this filesystem can't rename without replacing")
        M.rename_noreplace = refuse
        try:
            p.sync()
        finally:
            M.rename_noreplace = real
        assert p.kinds() == [(P.DELETE_HERE, "a", A.PENDING, A.NO_REPLACE)]
        assert p.lines() == ["Not applied (1)", "  · a   not moved to the holding folder: this computer can't rename a "
                             "file there without risking replacing another",
                             "Run it again to sync the rest."]
        assert p.read("a") == b"a" and p.base.rows_one("a") is not None
    finally:
        p.close()


def test_released_after_the_last_move_aside():
    p = Pair({"a": b"a", "z": b"z1"})
    try:
        p.sync()
        del p.ws.files["a"]
        p.write("z", b"z2")
        free = []

        def probe(step):
            s = H.Session.open(p.state)
            free.append(s is not None)
            if s:
                s.close()
        p.sync(hooks={"after_action": probe})
        assert free == [False, True]                                # (held through the delete, free for the upload)
    finally:
        p.close()


# ---- the rest of the run

def test_downloads_need_room():
    p = Pair({}, {"a": b"a" * 10, "b": b"b" * 10})
    try:
        p.sync(free_space=lambda fd: (os.fstat(fd).st_dev, A.DOWNLOAD_HEADROOM + 15))
        assert p.kinds() == [(P.DOWNLOAD, "a", A.DONE, None), (P.DOWNLOAD, "b", A.PENDING, "no-room")]
        where = A._mount_point(p.local)
        assert p.lines() == ["Download (1 file)", "  + a",
                             "Not applied: not enough free space on %s (needs 256 MiB, 256 MiB free)" % where,
                             "  · b", "Run it again to sync the rest."]
    finally:
        p.close()


def test_snapshots_are_left_for_later():
    p = Pair({"a": b"a"})
    try:
        plan = p.plan()
        plan.steps.append(P.Step(P.SNAPSHOT, "Notes.ipynb", fid="d1", remote="r1", rkind="notebook"))
        p.sync(plan)
        assert p.kinds() == [(P.UPLOAD, "a", A.DONE, None), (P.SNAPSHOT, "Notes.ipynb", A.PENDING, A.SNAPSHOTS_LATER)]
        assert p.lines() == ["Upload (1 file)", "  + a"]
    finally:
        p.close()


def test_rows_batched_destructive_committed():
    p = Pair({"a": b"a", "b": b"b"})
    try:
        commits = []
        p.sync(hooks={"after_base_commit": commits.append})
        assert commits == [None]                                    # (no destructive action: one batch at the end)
    finally:
        p.close()


# ---- r2: rows bound to checked bytes, held kept, the journal, restore_run, a conflict's renamed copy

def test_row_key_only_for_bytes_read_back():
    # (astra S1) an edit right after the install: the row keeps the planned hash but no stat key, so the next scan
    # hashes the file and sees the edit
    p = Pair({}, {"r.txt": b"theirs"})
    try:
        real = M.install

        def install_then_edit(root_fd, rel, tmp, computer, hooks=None):
            real(root_fd, rel, tmp, computer, hooks)
            p.write("r.txt", b"edited at once")
        M.install = install_then_edit
        try:
            p.sync()
        finally:
            M.install = real
        row = p.base.rows()["r.txt"]
        assert row.sha256 == sha(b"theirs") and (row.ino, row.size) == (0, 0), row
        assert [(s.kind, s.path) for s in p.plan().steps] == [(P.UPLOAD, "r.txt")]
        p.sync(now=NOW + 60)
        assert p.ws.files["r.txt"][1] == b"edited at once" and in_sync(p)
        real = M.install

        def install_then_remove(root_fd, rel, tmp, computer, hooks=None):
            real(root_fd, rel, tmp, computer, hooks)
            os.unlink(p.path("gone.txt"))
        p.ws.put("gone.txt", b"g")
        M.install = install_then_remove
        try:
            p.sync(now=NOW + 90)
        finally:
            M.install = real
        assert p.kinds() == [(P.DOWNLOAD, "gone.txt", A.DONE, None)]          # (done: it can't be read back, no key)
        assert p.base.rows()["gone.txt"].ino == 0
        p.ws.put("s.txt", b"plain")                                 # (and an untouched download keeps its key)
        p.sync(now=NOW + 120)
        st = os.stat(p.path("s.txt"))
        assert p.base.rows()["s.txt"].key == (st.st_size, st.st_mtime_ns, st.st_ctime_ns, st.st_ino, st.st_dev)
    finally:
        p.close()


def test_install_failure_after_the_move_keeps_held():
    # (astra S2, sync-client D3) the old file is in replaced/: the outcome says so, and its row isn't put back
    for exc in (OSError(errno.EIO, "Input/output error"), M.NoReplace("this filesystem can't rename without replacing")):
        p = Pair({"refs.bib": b"old"})
        try:
            p.sync()
            p.ws.put("refs.bib", b"new")
            real = M.install

            def failing(*args, **kw):
                raise exc
            M.install = failing
            try:
                p.sync()
            finally:
                M.install = real
            where = p.held(RID, "replaced", "refs.bib")
            o = p.report.outcomes[0]
            assert (o.result, o.why, o.held) == (A.SKIPPED, A.LOCAL_ERROR, where), o
            assert "refs.bib" not in p.base.rows() and os.listdir(p.local) == []     # (and the temp is gone)
            reason = "Input/output error" if isinstance(exc, OSError) else exc.reason
            assert p.lines()[1] == ("  · refs.bib   an error on this computer: %s; this computer's previous copy is kept "
                                    "for 30 days in %s" % (reason, where))
            p.sync(now=NOW + 60)                                    # (the next run downloads it again)
            assert p.read("refs.bib") == b"new"
        finally:
            p.close()


def test_holding_folder_not_prepared():
    # (board S3) any other error setting up the run folder: worded, the run folder removed
    p = Pair({"a": b"a"})
    try:
        p.sync()
        del p.ws.files["a"]
        real = A._journal

        def full(h, data):
            fd = os.open(A.JOURNAL, os.O_WRONLY | os.O_CREAT, 0o600, dir_fd=h.fd)
            os.close(fd)
            raise OSError(errno.ENOSPC, "No space left on device")
        A._journal = full
        try:
            p.sync()
        finally:
            A._journal = real
        assert p.kinds() == [(P.DELETE_HERE, "a", A.PENDING, A.HELD_BACK)] and p.runs() == []
        assert p.report.run_lines == [
            "Not applied: deleting or replacing files in %s. fs-sync couldn't prepare its holding folder (%s): No "
            "space left on device." % (p.local, p.held(RID))]
    finally:
        p.close()


def test_journal_counts_in_admission():
    p = Pair({"a": b"a"})
    try:
        p.sync()
        del p.ws.files["a"]
        p.sync()
        assert p.report.admission.entries == 4                      # (deleted, a, the journal, the run folder)
        assert sorted(os.listdir(p.held(RID))) == ["deleted", "journal.json"]
    finally:
        p.close()


def restore(p, run_id=RID, local=None, workspace="/Thesis"):
    fd = S.open_root(p.root)
    try:
        return A.restore_run(p.state, run_id, fd, local or p.local, workspace)
    finally:
        os.close(fd)


def test_restore_run_deleted_only():
    # (sync-client D4, grader's §5 case through the real entry point) deletes `a`, replaces `b`: --restore puts back
    # `a` only, even with `b`'s name free; the journal and replaced/ stay as they are
    p = Pair({"a": b"a1", "n/b": b"b1"})
    try:
        p.sync()
        del p.ws.files["a"]
        p.ws.put("n/b", b"b2")
        p.sync()
        os.unlink(p.path("n/b"))
        assert restore(p) == []
        assert p.read("a") == b"a1" and not os.path.exists(p.path("n/b"))
        with open(p.held(RID, "replaced", "n", "b"), "rb") as f:
            assert f.read() == b"b1"
        assert os.path.exists(p.held(RID, "journal.json"))
        p.write("a", b"in the way")                                 # (an occupied path: left, and listed)
        os.rename(p.path("a"), p.path("a2"))
        os.makedirs(p.held(RID, "deleted"), exist_ok=True)
        with open(p.held(RID, "deleted", "a"), "wb") as f:
            f.write(b"held again")
        p.write("a", b"occupied")
        assert restore(p) == ["a"] and p.read("a") == b"occupied"
    finally:
        p.close()


def test_restore_run_refusals():
    p = Pair({"a": b"a"})
    try:
        p.sync()
        del p.ws.files["a"]
        p.sync()
        for args, why in (((RID + "-2",), "no-run"), ((RID, "/elsewhere"), "other-folder"),
                          ((RID, None, "/Other"), "other-folder")):
            try:
                restore(p, *args)
                raise AssertionError("restored %r" % (args,))
            except A.NotRestorable as e:
                assert e.why == why, (args, e.why)
        assert not os.path.exists(p.held(RID + "-2"))               # (looked up, never made)
        os.unlink(p.held(RID, "journal.json"))
        try:
            restore(p)
            raise AssertionError("restored without a journal")
        except A.NotRestorable as e:
            assert e.why == "no-journal"
        assert not os.path.exists(p.path("a"))                      # (nothing put back)
    finally:
        p.close()


def conflicted():
    p = Pair({"main.tex": b"base"})
    p.sync()
    p.write("main.tex", b"mine")
    p.ws.put("main.tex", b"theirs")
    return p


def test_conflict_checks_before_the_rename():
    # (daybreak3 E1) an edit before the check: nothing is renamed, nothing changes
    p = conflicted()
    try:
        old = p.base.rows()["main.tex"]
        p.ws.on["write"] = lambda path: p.write("main.tex", b"a newcomer")    # (it would block an undo)
        p.sync(hooks={"before_check": lambda s: p.write("main.tex", b"mine, edited")})
        assert p.kinds() == [(P.CONFLICT, "main.tex", A.SKIPPED, A.CHANGED_HERE)]
        assert ("write", "main (conflict, laptop).tex") not in p.ws.calls     # (checked before any upload)
        assert os.listdir(p.local) == ["main.tex"] and p.read("main.tex") == b"mine, edited"
        assert p.base.rows()["main.tex"] == old and p.lines()[1] == "  · main.tex   changed here during the sync"
    finally:
        p.close()


def test_conflict_upload_refused_undoes_the_rename():
    # (daybreak3 E1) 409, a stop, or an edit found while uploading: the rename is undone
    copy = "main (conflict, laptop).tex"
    for why in ("409", "429", "edited"):
        p = conflicted()
        try:
            if why == "409":
                p.ws.on["write"] = lambda path: p.ws.put(copy, b"someone's, meanwhile")
            elif why == "429":
                p.ws.fail["write"] = [W.RateLimited(5)]
            else:
                p.ws.on["write"] = lambda path: p.write(copy, b"mine, edited")
            p.sync()
            assert p.read("main.tex") == (b"mine, edited" if why == "edited" else b"mine"), why
            assert not os.path.exists(p.path(copy)) and p.report.outcomes[0].renamed is None
            assert not any("isn't in the workspace yet" in line for line in p.lines())
        finally:
            p.close()


def test_conflict_copy_kept_when_its_name_is_taken():
    # (sync-client N1, board's words) the rename can't be undone: a newcomer took the name meanwhile
    copy = "main (conflict, laptop).tex"
    p = conflicted()
    try:
        def both(path):
            p.write("main.tex", b"a newcomer")
            p.ws.put(copy, b"someone's, meanwhile")
        p.ws.on["write"] = both
        p.sync()
        assert p.kinds() == [(P.CONFLICT, "main.tex", A.SKIPPED, A.CHANGED_THERE)]
        assert p.read(copy) == b"mine" and p.read("main.tex") == b"a newcomer" and p.report.outcomes[0].renamed == copy
        assert p.lines() == ["Skipped (1)", "  · main.tex   changed in the workspace during the sync; this computer's copy "
                             "is now \"%s\" here and isn't in the workspace yet" % copy,
                             "Run it again to sync the rest."]
    finally:
        p.close()
    p = conflicted()
    try:
        p.ws.on["write"] = lambda path: p.write("main.tex", b"a newcomer")
        p.ws.fail["write"] = [W.RateLimited(5)]
        p.sync()
        assert p.kinds() == [(P.CONFLICT, "main.tex", A.NOT_TRIED, "rate-limited")]
        assert p.lines() == ["Not applied (1)", "  · main.tex   this computer's copy is now \"%s\" here and isn't in "
                             "the workspace yet" % copy, "Run it again to sync the rest."]
    finally:
        p.close()


def test_conflict_copy_gone_is_not_named():
    # (daybreak3 E4) the copy itself vanished during the upload: the undo fails, and the report claims no copy
    copy = "main (conflict, laptop).tex"
    p = conflicted()
    try:
        def gone(path):
            os.unlink(p.path(copy))
            p.ws.put(copy, b"someone's, meanwhile")
        p.ws.on["write"] = gone
        p.sync()
        o = p.report.outcomes[0]
        assert (o.result, o.why, o.renamed) == (A.SKIPPED, A.CHANGED_HERE, None), o
        assert os.listdir(p.local) == []
        assert p.lines() == ["Skipped (1)", "  · main.tex   changed here during the sync", "Run it again to sync the rest."]
    finally:
        p.close()


def test_lock_released_after_cleanup_without_moves():
    # (daybreak3 E2) no move aside, or a refused one: the lock only for cleanup
    p = Pair({"a": b"a", "b": b"b"})
    try:
        free = []

        def probe(step):
            s = H.Session.open(p.state)
            free.append(s is not None)
            if s:
                s.close()
        p.sync(hooks={"before_check": probe})
        assert free == [True, True]
        p.write("b", b"b2")
        del p.ws.files["a"]
        saved, free[:] = H.RUN_ENTRIES, []
        H.RUN_ENTRIES = 1
        try:
            p.sync(hooks={"before_check": probe}, now=NOW + 60)
        finally:
            H.RUN_ENTRIES = saved
        assert p.kinds()[0][2:] == (A.PENDING, A.HELD_BACK) and free == [True]
    finally:
        p.close()


def test_room_per_filesystem():
    # (daybreak2 D5) two filesystems: the root's and a mount at mnt/ (a seam keyed by the folder's inode); each
    # charged its own downloads and its own 256 MiB, at its boundary and one byte past it
    for spare_root, spare_mnt, want in ((10, 20, ["a", "mnt/b", "mnt/c", "new/d"]),
                                        (9, 20, ["a", "mnt/b", "mnt/c"]), (10, 19, ["a", "mnt/b", "new/d"])):
        p = Pair({"mnt/keep": b"k"}, {"a": b"a" * 5, "new/d": b"d" * 5, "mnt/b": b"b" * 10, "mnt/c": b"c" * 10})
        try:
            mnt = os.stat(p.path("mnt")).st_ino

            def space(fd):
                if os.fstat(fd).st_ino == mnt:
                    return "mnt", A.DOWNLOAD_HEADROOM + spare_mnt
                return "root", A.DOWNLOAD_HEADROOM + spare_root
            p.sync(free_space=space)
            assert sorted(o.step.path for o in p.report.of(A.DONE) if o.step.kind == P.DOWNLOAD) == want, (
                spare_root, spare_mnt, p.kinds())
            pending = sorted(o.step.path for o in p.report.of(A.PENDING, A.NO_ROOM))
            assert pending == sorted({"a", "new/d", "mnt/b", "mnt/c"} - set(want))
        finally:
            p.close()


def test_room_unmeasurable_fails_closed():
    p = Pair({}, {"x/a": b"a", "y/b": b"b"})
    try:
        os.symlink("/tmp", p.path("x"))                             # (a link where a folder will be)

        def space(fd):
            if os.fstat(fd).st_ino == os.stat(p.local).st_ino:
                return "root", 2**40
            raise OSError(errno.EIO, "Input/output error")
        os.mkdir(p.path("y"))
        p.sync(free_space=space)
        assert sorted(p.kinds()) == [(P.DOWNLOAD, "x/a", A.SKIPPED, A.CHANGED_HERE),
                                     (P.DOWNLOAD, "y/b", A.SKIPPED, A.LOCAL_ERROR)]
        assert os.listdir(p.path("y")) == []
    finally:
        p.close()


# ---- r4: grader's gaps (B5, E8, R6, P6, C3, C6, H9/H10, C7)

def test_all_names_taken_after_a_move_aside_keeps_held():
    # (B5) a replacing download whose install finds every conflict name taken: the old copy is in replaced/, said so
    p = Pair({"main.tex": b"old"})
    try:
        p.sync()
        p.ws.put("main.tex", b"new")
        real = M.conflict_name

        def racing(path, computer, taken):
            name = real(path, computer, taken)
            p.write(name, b"taken meanwhile")
            return name
        M.conflict_name = racing
        try:
            p.sync(hooks={"before_install": lambda s: p.write("main.tex", b"newcomer")})
        finally:
            M.conflict_name = real
        where = p.held(RID, "replaced", "main.tex")
        o = p.report.outcomes[0]
        assert (o.result, o.why, o.held) == (A.PENDING, A.NO_CONFLICT_NAME, where), o
        assert "main.tex" not in p.base.rows()
        assert p.lines()[1].endswith("rename or remove some, then run it again; this computer's previous copy is kept "
                                     "for 30 days in %s" % where), p.lines()
    finally:
        p.close()


def test_other_filesystem_met_while_moving():
    # (E8) EXDEV from the move aside itself: held back, with §1.2's other-disk line
    p = Pair({"a": b"a"})
    try:
        p.sync()
        del p.ws.files["a"]
        real = M.rename_noreplace

        def exdev(*args):
            raise M.NoReplace("it is on another filesystem")
        M.rename_noreplace = exdev
        try:
            p.sync()
        finally:
            M.rename_noreplace = real
        assert p.kinds() == [(P.DELETE_HERE, "a", A.PENDING, A.HELD_BACK)]
        assert p.report.run_lines == [A._other_disk_line(p.local, p.state)]
        assert p.read("a") == b"a" and p.base.rows_one("a") is not None
    finally:
        p.close()


def test_restore_journal_not_json():
    # (R6) a journal that isn't JSON (or isn't UTF-8) refuses, never crashes
    for data in (b"{not json", b"\xff\xfe", b"[1, 2]"):
        p = Pair({"a": b"a"})
        try:
            p.sync()
            del p.ws.files["a"]
            p.sync()
            os.chmod(p.held(RID, "journal.json"), 0o600)
            with open(p.held(RID, "journal.json"), "wb") as f:
                f.write(data)
            try:
                restore(p)
                raise AssertionError("restored with journal %r" % data)
            except A.NotRestorable as e:
                assert e.why in ("no-journal", "other-folder"), (data, e.why)
            assert not os.path.exists(p.path("a"))
        finally:
            p.close()


def test_conflict_counted_in_room():
    # (P6) a conflict downloads too: if it doesn't fit, nothing is renamed or uploaded
    p = conflicted()
    try:
        p.sync(free_space=lambda fd: (os.fstat(fd).st_dev, A.DOWNLOAD_HEADROOM + 1))
        assert p.kinds() == [(P.CONFLICT, "main.tex", A.PENDING, A.NO_ROOM)]
        assert os.listdir(p.local) == ["main.tex"] and p.read("main.tex") == b"mine"
        assert ("write", "main (conflict, laptop).tex") not in p.ws.calls
    finally:
        p.close()


def test_upload_read_capped():
    # (C3) a file that grows while it is read: never more than its planned size + 1 bytes read
    p = Pair({"a": b"x" * 10})
    try:
        plan = p.plan()
        real, got = os.read, [0]

        def read(fd, n):
            if os.readlink("/proc/self/fd/%d" % fd).endswith("/thesis/a"):
                if got[0] == 0:
                    with open(p.path("a"), "ab") as f:
                        f.write(b"y" * 100000)
                b = real(fd, n)
                got[0] += len(b)
                return b
            return real(fd, n)
        os.read = read
        try:
            p.sync(plan)
        finally:
            os.read = real
        assert p.kinds() == [(P.UPLOAD, "a", A.SKIPPED, A.CHANGED_HERE)] and got[0] <= 11, got
        assert p.ws.files == {}
    finally:
        p.close()


def test_download_read_capped():
    # (C6) a workspace file larger than planned: the read asks for at most size + 1 bytes, and it is skipped
    p = Pair({}, {"r.txt": b"x" * 10})
    try:
        plan = p.plan()
        p.ws.sent["r.txt"] = b"y" * 100000
        real, delivered = p.ws.read, []

        def read(path, writer, limit):
            got = []
            entry, n = real(path, lambda b: (got.append(len(b)), writer(b)), limit)
            delivered.append((limit, sum(got)))
            return entry, n
        p.ws.read = read
        p.sync(plan)
        assert delivered == [(11, 11)], delivered
        assert p.kinds() == [(P.DOWNLOAD, "r.txt", A.SKIPPED, A.CHANGED_THERE)] and os.listdir(p.local) == []
    finally:
        p.close()


def test_admission_counts_both_parts():
    # (H9, H10) a delete here and a replacing download: deleted/, a, replaced/, b, the journal and the run folder: 6
    for bound, ok in ((6, True), (5, False)):
        p = Pair({"a": b"a", "b": b"b1"})
        try:
            p.sync()
            del p.ws.files["a"]
            p.ws.put("b", b"b2")
            saved = H.RUN_ENTRIES
            H.RUN_ENTRIES = bound
            try:
                p.sync()
            finally:
                H.RUN_ENTRIES = saved
            assert (p.report.admission.ok, p.report.admission.entries) == (ok, 6), (bound, p.report.admission)
        finally:
            p.close()


def test_temp_synced_before_install():
    # (C7) the downloaded bytes reach the disk before the rename that makes them the file
    p = Pair({}, {"r.txt": b"theirs"})
    try:
        real, synced, at_install = os.fsync, [], []

        def fsync(fd):
            try:
                synced.append(os.readlink("/proc/self/fd/%d" % fd))
            except OSError:
                pass
            return real(fd)
        os.fsync = fsync
        try:
            p.sync(hooks={"before_install": lambda s: at_install.append(list(synced))})
        finally:
            os.fsync = real
        assert any(".sagebrush-tmp-" in path for path in at_install[0]), at_install
    finally:
        p.close()


def test_fake_refuses_bytes_other_than_named():
    ws = Fake()
    try:
        ws.write("a", [b"abc"], None, sha(b"abd"), 3)
        raise AssertionError("took bytes other than named")
    except W.Conflict:
        pass
    assert ws.files == {}


if __name__ == "__main__":
    for name, f in list(globals().items()):
        if name.startswith("test_") and callable(f):
            f()
            print("ok", name)
    print("all fs-sync apply tests passed")
