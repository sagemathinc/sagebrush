#!/usr/bin/env python3
"""fs-sync's pure planner (sagebrush/fs_sync/plan.py; design/fs-sync.md §2.2-§2.4, §3.4): each row of §2.2's table
in each mode, the first sync, conflicts and their copy names, the snapshot rules and the delete guard."""

from sagebrush.fs_sync import plan as P
from sagebrush.fs_sync.plan import Base, Local, Remote

A, B_, C, D = "a" * 64, "b" * 64, "c" * 64, "d" * 64
F1, F2 = "f1" * 8, "f2" * 8


def one(local=None, remote=None, base=None, mode=P.BOTH, path="x.txt", computer="lap"):
    """The plan for one path, with hashes l, r, b (None: absent): its single step, or None."""
    loc = {path: Local(local)} if local else {}
    rem = {path: Remote("file", F1, sha256=remote)} if remote else {}
    row = {path: Base(base, F1)} if base else {}
    # (a base that only has this path still makes it "not a first sync")
    pl = P.plan(loc, rem, row, mode, computer)
    assert len(pl.steps) <= 1, pl.steps
    return pl.steps[0] if pl.steps else None


def kind(step):
    return None if step is None else step.kind


def test_table_rows_both_ways():
    # L = R (any B): nothing, the base takes L
    assert kind(one(A, A, A)) is None
    s = one(A, A, B_)
    assert s.kind == P.RECORD and s.local == A
    assert one(A, A).kind == P.RECORD                     # equal, no base: recorded
    # changed here, unchanged there: upload with base R
    s = one(B_, A, A)
    assert s.kind == P.UPLOAD and s.base == A and s.fid == F1 and s.local == B_
    # unchanged here, changed there: download, replacing the local file
    s = one(A, B_, A)
    assert s.kind == P.DOWNLOAD and s.replaces and s.local == A and s.remote == B_
    # both changed differently: conflict
    s = one(B_, C, A)
    assert s.kind == P.CONFLICT and s.copy == "x (conflict, lap).txt"
    # deleted here, unchanged there: delete there, naming what it planned from
    s = one(None, A, A)
    assert s.kind == P.DELETE_THERE and s.fid == F1 and s.remote == A
    # unchanged here, deleted there: delete here
    s = one(A, None, A)
    assert s.kind == P.DELETE_HERE and s.local == A
    # deleted here, changed there: download (an edit beats a delete), to an absent path
    s = one(None, B_, A)
    assert s.kind == P.DOWNLOAD and not s.replaces
    # changed here, deleted there: upload, create-only
    s = one(B_, None, A)
    assert s.kind == P.UPLOAD and s.base is None
    # deleted on both: the base forgets
    assert one(None, None, A).kind == P.FORGET
    # new here, no base: upload create-only; new there: download
    s = one(A, None, None)
    assert s.kind == P.UPLOAD and s.base is None
    s = one(None, A, None)
    assert s.kind == P.DOWNLOAD and not s.replaces


def test_first_sync_never_deletes():
    loc = {"only-here": Local(A), "both-same": Local(B_), "both-diff": Local(C)}
    rem = {"only-there": Remote("file", F1, A), "both-same": Remote("file", F2, B_), "both-diff": Remote("file", F2, D)}
    pl = P.plan(loc, rem, {}, P.BOTH, "lap")
    assert pl.first
    got = {s.path: s.kind for s in pl.steps}
    assert got == {"only-here": P.UPLOAD, "only-there": P.DOWNLOAD, "both-same": P.RECORD, "both-diff": P.CONFLICT}, got
    assert pl.deletes() == (0, 0)


def test_one_direction():
    # --up: only upload and delete-there; download and delete-here are pending; a conflict touches neither side
    assert one(B_, A, A, P.UP).kind == P.UPLOAD
    assert one(None, A, A, P.UP).kind == P.DELETE_THERE
    s = one(A, B_, A, P.UP)
    assert s.kind == P.PENDING and s.action == P.DOWNLOAD
    s = one(A, None, A, P.UP)
    assert s.kind == P.PENDING and s.action == P.DELETE_HERE
    s = one(B_, C, A, P.UP)
    assert s.kind == P.CONFLICT_NOT_APPLIED and s.copy is None
    # --down: the reverse
    assert one(A, B_, A, P.DOWN).kind == P.DOWNLOAD
    assert one(A, None, A, P.DOWN).kind == P.DELETE_HERE
    s = one(B_, A, A, P.DOWN)
    assert s.kind == P.PENDING and s.action == P.UPLOAD
    s = one(None, A, A, P.DOWN)
    assert s.kind == P.PENDING and s.action == P.DELETE_THERE
    assert one(B_, C, A, P.DOWN).kind == P.CONFLICT_NOT_APPLIED
    # equal sides and both-deleted need no direction
    assert one(A, A, B_, P.UP).kind == P.RECORD and one(None, None, A, P.DOWN).kind == P.FORGET
    try:
        P.plan({}, {}, {}, "sideways")
        raise AssertionError("an unknown mode was accepted")
    except ValueError:
        pass


def test_conflict_names():
    t = lambda *names: (lambda p: p.casefold() in {n.casefold() for n in names})
    assert P.conflict_name("d/notes.tex", "lap", t()) == "d/notes (conflict, lap).tex"
    assert P.conflict_name("Makefile", "lap", t()) == "Makefile (conflict, lap)"                 # no extension
    assert P.conflict_name(".bashrc", "lap", t()) == ".bashrc (conflict, lap)"                   # a dotfile
    assert P.conflict_name("a.tar.gz", "lap", t()) == "a.tar (conflict, lap).gz"                 # several dots
    assert P.conflict_name("p.board.json", "lap", t()) == "p (conflict, lap).board.json"         # the board suffix whole
    taken = t("x (conflict, lap).txt", "X (CONFLICT, LAP) (2).TXT")
    assert P.conflict_name("x.txt", "lap", taken) == "x (conflict, lap) (3).txt"                 # taken, without regard to case
    long = "é" * 300 + ".txt"
    n = P.conflict_name(long, "lap", t())
    assert P._units(n) == P.MAX_NAME and n.endswith(" (conflict, lap).txt")
    emoji = "😀" * 200 + ".txt"                                                                    # never cut through a surrogate pair
    n = P.conflict_name(emoji, "lap", t())
    assert P._units(n) <= P.MAX_NAME and n.endswith(" (conflict, lap).txt") and "�" not in n
    # two conflicts in one plan get different copy names, and none takes a name either side has
    loc = {"x.txt": Local(B_), "x (conflict, lap).txt": Local(D)}
    rem = {"x.txt": Remote("file", F1, C), "x (conflict, lap).txt": Remote("file", F2, D)}
    pl = P.plan(loc, rem, {"x.txt": Base(A, F1), "x (conflict, lap).txt": Base(D, F2)}, P.BOTH, "lap")
    assert [s.copy for s in pl.of(P.CONFLICT)] == ["x (conflict, lap) (2).txt"], pl.steps
    # a name either side has in another case is taken too (a case-insensitive filesystem, or the workspace)
    pl = P.plan({"Notes.txt": Local(B_)}, {"Notes.txt": Remote("file", F1, C), "notes (conflict, lap).txt": Remote("file", F2, D)},
                {"Notes.txt": Base(A, F1)}, P.BOTH, "lap")
    assert [s.copy for s in pl.of(P.CONFLICT)] == ["Notes (conflict, lap) (2).txt"], pl.steps


def snap(local=None, remote_rev=None, base=None, mode=P.BOTH, path="Notes.ipynb", fid=F1):
    loc = {path: Local(local)} if local else {}
    rem = {path: Remote("notebook", fid, revision=remote_rev)} if remote_rev else {}
    row = {path: base} if base else {}
    pl = P.plan(loc, rem, row, mode, "lap")
    assert len(pl.steps) <= 1, pl.steps
    return pl.steps[0] if pl.steps else None


def test_snapshots():
    row = Base(A, F1, snapshot=True, revision="r1")
    # new in the workspace, nothing here: written
    s = snap(remote_rev="r1")
    assert s.kind == P.SNAPSHOT and s.why == "new" and not s.replaces
    # unchanged on both: nothing
    assert snap(A, "r1", row) is None
    # the document changed, the snapshot here as written: replaced (through the holding folder)
    s = snap(A, "r2", row)
    assert s.kind == P.SNAPSHOT and s.replaces and s.why == "changed" and s.local == A
    # another fid at that path counts as changed too
    assert snap(A, "r1", row, fid=F2).kind == P.SNAPSHOT
    # edited here: listed, never written over, deleted or uploaded, whatever the workspace did
    for rev in ("r1", "r2", None):
        s = snap(B_, rev, row)
        assert s.kind == P.NOT_UPLOADED_CHANGED, (rev, s)
    # occupied with no proof fs-sync wrote it (first sync, lost base, a cleared row, a data-file row)
    assert snap(B_, "r1").kind == P.NOT_UPLOADED_OCCUPIED
    assert snap(A, "r1", Base(A, F1)).kind == P.NOT_UPLOADED_OCCUPIED      # a data-file row is no snapshot proof
    # deleted here: written again, saying so
    s = snap(None, "r1", row)
    assert s.kind == P.SNAPSHOT and s.why == "again" and not s.replaces
    # deleted in the workspace, the snapshot unedited: delete here (to the holding folder)
    assert snap(A, None, row).kind == P.DELETE_HERE
    # new here, no document: listed, never uploaded; gone on both: forgotten
    assert snap(B_).kind == P.NOT_UPLOADED_NEW
    assert snap(None, None, row).kind == P.FORGET
    # --up: neither written nor checked; --down: as both ways
    assert snap(remote_rev="r1", mode=P.UP) is None and snap(B_, mode=P.UP) is None
    assert snap(remote_rev="r1", mode=P.DOWN).kind == P.SNAPSHOT


def test_snapshot_name_on_a_data_file():
    # (daybreak3) a workspace data file with a document's name: still download-only and never uploaded, but it comes
    # down as a file's bytes (DOWNLOAD), not through the document snapshot read, under the same proof rules
    rem = lambda sha: {"x.ipynb": Remote("file", F1, sha256=sha)}
    row = {"x.ipynb": Base(A, F1, snapshot=True, revision=None)}
    s = P.plan({}, rem(A), {}, P.BOTH, "lap").steps[0]
    assert s.kind == P.DOWNLOAD and not s.replaces and s.rkind == "file" and s.why == "new", s
    assert P.plan({"x.ipynb": Local(B_)}, rem(A), {}, P.BOTH, "lap").steps[0].kind == P.NOT_UPLOADED_OCCUPIED
    s = P.plan({"x.ipynb": Local(A)}, rem(C), row, P.BOTH, "lap").steps[0]                  # unedited, changed there
    assert s.kind == P.DOWNLOAD and s.replaces and s.remote == C, s
    assert P.plan({"x.ipynb": Local(A)}, rem(A), row, P.BOTH, "lap").steps == []              # unchanged
    assert P.plan({"x.ipynb": Local(B_)}, rem(C), row, P.BOTH, "lap").steps[0].kind == P.NOT_UPLOADED_CHANGED
    # and a document becomes a SNAPSHOT step
    assert P.plan({}, {"x.ipynb": Remote("notebook", F1, revision="r")}, {}, P.BOTH, "lap").steps[0].kind == P.SNAPSHOT


def test_snapshot_names_never_upload():
    for name in ("a.ipynb", "A.IPYNB", "b.board.json", "B.Board.JSON", "c.chat", "d/e/C.CHAT"):
        assert P.is_snapshot_name(name), name
        # whatever the base says: a changed local file, a data-file row, a deleted workspace entry
        for base in (None, Base(A, F1), Base(A, F1, snapshot=True, revision="r")):
            for remote in (None, Remote("file", F1, sha256=A)):
                pl = P.plan({name: Local(B_)}, {name: remote} if remote else {}, {name: base} if base else {}, P.BOTH, "lap")
                assert not pl.of(P.UPLOAD, P.DELETE_THERE, P.CONFLICT), (name, base, remote, pl.steps)
                pl = P.plan({}, {name: remote} if remote else {}, {name: base} if base else {}, P.BOTH, "lap")
                assert not pl.of(P.UPLOAD, P.DELETE_THERE, P.CONFLICT), (name, base, remote, pl.steps)
    for name in (".ipynb", "x.ipynb.txt", "board.json", "chat", "x.chats"):
        assert not P.is_snapshot_name(name), name


def test_snapshot_row_keeps_snapshot_rules():
    # (astra) a path whose base row is a snapshot stays under the snapshot rules even if its name or the workspace
    # entry's kind no longer says document: it never uploads or deletes in the workspace
    row = {"plain.txt": Base(A, F1, snapshot=True, revision="r1")}
    for loc in ({"plain.txt": Local(A)}, {"plain.txt": Local(B_)}, {}):
        for rem in ({}, {"plain.txt": Remote("file", F1, sha256=A)}, {"plain.txt": Remote("file", F2, sha256=C)}):
            pl = P.plan(loc, rem, row, P.BOTH, "lap")
            assert not pl.of(P.UPLOAD, P.DELETE_THERE, P.CONFLICT), (loc, rem, pl.steps)
    # the workspace entry gone and the local copy unedited: a delete here, as for any snapshot
    pl = P.plan({"plain.txt": Local(A)}, {}, row, P.BOTH, "lap")
    assert [s.kind for s in pl.steps] == [P.DELETE_HERE], pl.steps


def test_computer_label():
    t = lambda p: False
    assert P.computer_label("lap/../x") == "lap-..-x"
    assert P.computer_label("a\\b\nc\x00d") == "a-b-c-d"
    assert P.computer_label("  ") == "computer" and P.computer_label(None) == "computer"
    assert P._units(P.computer_label("é" * 500)) == P.MAX_LABEL
    pl = P.plan({"a.txt": Local(B_)}, {"a.txt": Remote("file", F1, C)}, {"a.txt": Base(A, F1)})    # no name given
    assert pl.steps[0].copy == "a (conflict, computer).txt", pl.steps
    assert P._units(P.computer_label("😀" * 100)) <= P.MAX_LABEL
    # the conflict copy stays one name in the same folder, at most 255 units, whatever the label
    for label in ("../../etc", "a/b", "x" * 1000, "😀" * 300, "‮ evil"):
        n = P.conflict_name("d/notes.tex", label, t)
        assert n.startswith("d/") and "/" not in n[2:] and P._units(n[2:]) <= P.MAX_NAME, (label, n)
        assert n.endswith(").tex"), n


def test_conflict_path_room():
    # the copy's path must fit what the workspace has left under the synced folder: else the conflict is listed
    p = "d/" + "n" * 240 + ".txt"
    pl = P.plan({p: Local(B_)}, {p: Remote("file", F1, C)}, {p: Base(A, F1)}, P.BOTH, "lap", room=260)
    s = pl.steps[0]
    assert s.kind == P.CONFLICT and P._units(s.copy) <= 260 and s.copy.startswith("d/"), s
    pl = P.plan({p: Local(B_)}, {p: Remote("file", F1, C)}, {p: Base(A, F1)}, P.BOTH, "lap", room=250)
    s = pl.steps[0]
    assert s.kind == P.CONFLICT_NOT_APPLIED and s.why == "no-name", s
    # (nothing is changed on either side for it)
    assert not pl.of(P.UPLOAD, P.DOWNLOAD, P.CONFLICT)


def test_steps_keep_remote_kind():
    # (astra) the planned workspace kind travels with its fid, for the read check at apply time
    pl = P.plan({}, {"n.ipynb": Remote("notebook", F1, revision="r"), "a.txt": Remote("file", F2, A)}, {}, P.BOTH, "lap")
    assert {(s.path, s.rkind, s.fid) for s in pl.steps} == {("n.ipynb", "notebook", F1), ("a.txt", "file", F2)}, pl.steps
    s = one(A, B_, A, P.UP)
    assert s.kind == P.PENDING and s.rkind == "file" and s.replaces          # a pending step keeps what it planned
    s = one(B_, C, A, P.UP)
    assert s.kind == P.CONFLICT_NOT_APPLIED and s.rkind == "file"
    assert one(B_, C, A).rkind == "file" and one(A, None, None).rkind is None


def test_folders_and_clashes():
    folder = Remote("folder", F2)
    # a workspace folder is never planned as a file or a document
    pl = P.plan({}, {"d": folder, "d/a.txt": Remote("file", F1, A)}, {}, P.BOTH, "lap")
    assert [(s.kind, s.path) for s in pl.steps] == [(P.DOWNLOAD, "d/a.txt")], pl.steps
    assert P.plan({}, {"nb": Remote("folder", F2)}, {}, P.BOTH, "lap").steps == []
    # a local file where the workspace has a folder (named, or implied by a path under it): listed, not acted on
    for rem in ({"d": folder}, {"d/x.txt": Remote("file", F1, A)}):
        pl = P.plan({"d": Local(A)}, rem, {"d": Base(A, F1)}, P.BOTH, "lap")
        assert [s.kind for s in pl.steps if s.path == "d"] == [P.TYPE_CLASH], pl.steps
        assert not pl.of(P.DELETE_THERE, P.UPLOAD, P.DELETE_HERE), pl.steps
    # a workspace file where this computer has a folder: the same
    pl = P.plan({"d/x.txt": Local(A)}, {"d": Remote("file", F1, B_)}, {}, P.BOTH, "lap")
    assert [(s.kind, s.path) for s in pl.steps] == [(P.TYPE_CLASH, "d"), (P.UPLOAD, "d/x.txt")], pl.steps
    # a workspace document where this computer has a folder
    pl = P.plan({"n.ipynb/x": Local(A)}, {"n.ipynb": Remote("notebook", F1, revision="r")}, {}, P.BOTH, "lap")
    assert [s.kind for s in pl.steps if s.path == "n.ipynb"] == [P.TYPE_CLASH], pl.steps


def test_case_clash():
    rem = {"A.txt": Remote("file", F1, A), "a.txt": Remote("file", F2, B_), "b.txt": Remote("file", F1, C)}
    # a case-insensitive filesystem: both names listed, neither downloaded; others as usual
    pl = P.plan({}, rem, {}, P.BOTH, "lap", case_insensitive=True)
    assert [(s.kind, s.path) for s in pl.steps] == [(P.CASE_CLASH, "A.txt"), (P.CASE_CLASH, "a.txt"), (P.DOWNLOAD, "b.txt")], pl.steps
    # even with a base and a local file at one of them: nothing is replaced or deleted there
    pl = P.plan({"a.txt": Local(D)}, rem, {"a.txt": Base(D, F2)}, P.BOTH, "lap", case_insensitive=True)
    assert [s.kind for s in pl.steps if s.path in ("a.txt", "A.txt")] == [P.CASE_CLASH, P.CASE_CLASH], pl.steps
    # a case-sensitive filesystem: two ordinary downloads
    pl = P.plan({}, rem, {}, P.BOTH, "lap")
    assert [s.kind for s in pl.steps] == [P.DOWNLOAD] * 3


def test_delete_guard():
    def guard(n_here, n_there, base_files):
        loc, rem, base = {}, {}, {}
        for i in range(base_files):
            p = "f%d" % i
            base[p] = Base(A, F1)
            if i < n_here:                       # deleted there, unchanged here: a delete here
                loc[p] = Local(A)
            elif i < n_here + n_there:           # deleted here, unchanged there: a delete there
                rem[p] = Remote("file", F1, A)
            else:
                loc[p], rem[p] = Local(A), Remote("file", F1, A)
        pl = P.plan(loc, rem, base, P.BOTH, "lap")
        assert pl.deletes() == (n_here, n_there), pl.deletes()
        return P.needs_delete_confirmation(pl, base_files)
    assert not guard(50, 0, 1000) and guard(51, 0, 1000)        # the count, here
    assert not guard(0, 50, 1000) and guard(0, 51, 1000)        # and there
    assert not guard(25, 25, 1000)                              # per side, not summed
    assert not guard(1, 0, 4) and guard(2, 0, 4)                # the share: 25% of 4 is 1
    assert guard(1, 0, 3)                                       # 33% of a small base
    assert not guard(0, 0, 0)


if __name__ == "__main__":
    for name, f in list(globals().items()):
        if name.startswith("test_") and callable(f):
            f()
            print("ok", name)
    print("all fs-sync plan tests passed")
