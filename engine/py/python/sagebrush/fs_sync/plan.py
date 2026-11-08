"""fs-sync's plan: a pure three-way comparison (design/fs-sync.md §2.2-§2.4, §3.4).

`plan(local, remote, base, mode, computer)` takes, for each relative path under the folder pair:
- `local[p]`: the local file now (`Local(sha256)`), or no key if there is none;
- `remote[p]`: the workspace entry now (`Remote(kind, fid, sha256, revision)`), or no key;
- `base[p]`: the base row from the last sync (`Base(sha256, fid, snapshot, revision)`), or no key (always none on
  a first sync, or with a damaged base);
and returns the actions the run would take and what it only lists. It reads no file and calls nothing: the scan, the
listing and the base are gathered before it, and every action is checked again when it is applied (§4.1), so this is
a plan, never an authority.

Paths are relative, `/`-separated, and already normalized (NFC) by the caller; ignored paths are left out by the
caller. `local` has files only. `remote` may include folder entries (kind "folder"): they are never planned as files
or documents, only used to find a file on one side where the other side has a folder (listed as a clash, neither side
touched). Folders themselves aren't planned here: an upload or download makes the folders its path needs when it is
applied. With `case_insensitive` (this computer's filesystem, detected by the scan, §4.4), workspace names that differ
only in case can't both exist here: all of them are listed as a clash and none is downloaded or acted on."""

import unicodedata
from dataclasses import dataclass, field, replace

BOTH, UP, DOWN = "both", "up", "down"
MODES = (BOTH, UP, DOWN)

#: what a file's name says it is: notebooks, boards and chats are documents, synced only as download-only snapshots
#: in this version, and never uploaded or deleted in the workspace, by name, whatever the base says (§3.4)
SNAPSHOT_SUFFIXES = (".ipynb", ".board.json", ".chat")

#: a delete count that needs the number confirmed: more than 50, or more than a quarter of the base (§2.4)
DELETE_CONFIRM_COUNT = 50
DELETE_CONFIRM_SHARE = 0.25

#: the workspace's longest name, in UTF-16 code units, as web/workspace/paths.ts (MAX_NAME)
MAX_NAME = 255
#: and its longest path (web/workspace/paths.ts MAX_PATH); this module's paths are relative, so the workspace folder's
#: own path counts against it too: a conflict copy is checked against what is left (`plan(..., room=...)`)
MAX_PATH = 1024
#: the longest computer label put in a conflict copy's name, in UTF-16 code units
MAX_LABEL = 64

# the actions (what a run does) ...
UPLOAD = "upload"               # write the local file to the workspace: with base (the entry's sha256 and fid), or create-only
DOWNLOAD = "download"           # write the workspace file here: to an absent path, or replacing the local file (moved aside)
CONFLICT = "conflict"           # both changed: the local file becomes the conflict copy on both sides, the workspace's comes down
DELETE_THERE = "delete-there"   # remove the workspace entry (to its Trash)
DELETE_HERE = "delete-here"     # move the local file to the holding folder
SNAPSHOT = "snapshot"           # write a document's snapshot here: to an absent path, or over fs-sync's own last snapshot
RECORD = "record"               # nothing to move: both sides are equal, and the base takes them
FORGET = "forget"               # nothing to move: neither side has the path, and the base forgets it
# ... and what it only lists
PENDING = "pending"                     # an action of the other direction, under --up or --down (§2.2)
CONFLICT_NOT_APPLIED = "conflict-not-applied"   # a conflict under --up or --down: neither side is touched
NOT_UPLOADED_CHANGED = "not-uploaded-changed"   # a snapshot edited here: left as it is (§3.4)
NOT_UPLOADED_NEW = "not-uploaded-new"           # a notebook, board or chat file new here: left as it is
NOT_UPLOADED_OCCUPIED = "not-uploaded-occupied"  # a file at a snapshot's path that fs-sync can't show it wrote
TYPE_CLASH = "type-clash"                       # a file on one side, a folder at that path on the other
CASE_CLASH = "case-clash"                       # workspace names differing only in case, on a case-insensitive filesystem

ACTIONS = (UPLOAD, DOWNLOAD, CONFLICT, DELETE_THERE, DELETE_HERE, SNAPSHOT, RECORD, FORGET)
LISTINGS = (PENDING, CONFLICT_NOT_APPLIED, NOT_UPLOADED_CHANGED, NOT_UPLOADED_NEW, NOT_UPLOADED_OCCUPIED, TYPE_CLASH,
            CASE_CLASH)

#: which actions change which side: the direction flags apply only their own (§1, §2.2)
_CHANGES_WORKSPACE = (UPLOAD, DELETE_THERE)
_CHANGES_HERE = (DOWNLOAD, DELETE_HERE, SNAPSHOT)


@dataclass(frozen=True)
class Local:
    sha256: str


@dataclass(frozen=True)
class Remote:
    kind: str                   # "file", or a document's kind ("notebook", "board", "chat")
    fid: str
    sha256: str = None          # a data file's content hash
    revision: str = None        # a document's opaque revision (§3.4)


@dataclass(frozen=True)
class Base:
    sha256: str
    fid: str = None
    snapshot: bool = False      # a document's snapshot, as written here (§3.4)
    revision: str = None


@dataclass(frozen=True)
class Step:
    kind: str
    path: str
    #: what the step was planned from, for the check at apply time (§4.1): the local hash (None: no local file), and
    #: the workspace entry's fid and hash or revision (None: no entry)
    local: str = None
    fid: str = None
    remote: str = None
    #: the workspace entry's kind as planned ("file", "notebook", …), checked with its fid at apply time (§3.4)
    rkind: str = None
    #: a download or snapshot that replaces a local file (so it goes through the holding folder, §4.1, §2.4)
    replaces: bool = False
    #: an upload's base: the workspace hash it replaces, or None for create-only (§3.2)
    base: str = None
    #: a conflict's copy name (§2.3); a pending step's action; why a snapshot is written
    copy: str = None
    action: str = None
    why: str = None


@dataclass
class Plan:
    mode: str
    first: bool                         # no base at all: a first sync, which deletes nothing
    steps: list = field(default_factory=list)

    def of(self, *kinds):
        return [s for s in self.steps if s.kind in kinds]

    def deletes(self):
        """(here, there): the deletes this run would apply."""
        return len(self.of(DELETE_HERE)), len(self.of(DELETE_THERE))


def is_snapshot_name(path):
    """A notebook, board or chat by its name, without regard to case (`NOTES.IPYNB` too): never uploaded (§3.4)."""
    n = path.rsplit("/", 1)[-1].lower()
    return any(n.endswith(s) and len(n) > len(s) for s in SNAPSHOT_SUFFIXES)


def split_ext(name):
    """`(base, ext)` as web/workspace/paths.ts's splitExt: `.board.json` whole, else the last dot not first."""
    if name.lower().endswith(".board.json") and len(name) > 11:
        return name[:-11], name[-11:]
    i = name.rfind(".")
    return (name[:i], name[i:]) if i > 0 else (name, "")


def _units(s):
    return len(s.encode("utf-16-le")) // 2


def _fit(base, tail):
    """`base + tail`, `base` cut so that the name fits the workspace (never through a surrogate pair), as the reducer's `fit`."""
    if _units(base) + _units(tail) <= MAX_NAME:
        return base + tail
    room = max(0, MAX_NAME - _units(tail))
    out, used = [], 0
    for ch in base:
        w = 2 if ord(ch) > 0xFFFF else 1
        if used + w > room:
            break
        out.append(ch)
        used += w
    return "".join(out) + tail


def computer_label(name):
    """`name` as it may appear in a conflict copy's name: no path separators or control characters, trimmed, at most
    MAX_LABEL UTF-16 units (never cut through a surrogate pair); "computer" if nothing is left."""
    out = "".join("-" if ch in "/\\" or unicodedata.category(ch)[0] == "C" else ch for ch in str(name or "")).strip()
    while _units(out) > MAX_LABEL:
        out = out[:-1]
    return out.strip() or "computer"


def conflict_name(path, computer, taken, room=MAX_PATH):
    """The conflict copy's path beside `path`: `name (conflict, <computer>).ext`, then `… (2)`, … while taken, as the
    reducer names a conflict copy (web/workspace/sync-reduce.ts). `taken(path)` says whether a path is in use on
    either side (or by an earlier conflict copy of this plan)."""
    folder, _, name = path.rpartition("/")
    base, ext = split_ext(name)
    tag = " (conflict, %s)" % computer_label(computer)
    for i in range(1, 10001):
        n = _fit(base, tag + ("" if i == 1 else " (%d)" % i) + ext)
        if "/" in n or _units(n) > MAX_NAME:
            raise ValueError("a conflict name must be one name in the same folder: %r" % n)   # (never, given the label)
        p = folder + "/" + n if folder else n
        if _units(p) > room:
            raise ValueError("no conflict name beside %s fits the workspace's path limit" % path)
        if not taken(p):
            return p
    raise ValueError("no free conflict name beside %s" % path)


def _data_step(p, l, r, b, rem):
    """§2.2's table for a data file: l, r, b are the local, workspace and base hashes (None: absent)."""
    fid = rem.fid if rem else None
    if l is not None and l == r:
        return Step(RECORD, p, local=l, fid=fid, remote=r) if b != l else None
    if b is None:
        # (no base, no deletes: a first sync, or a path new on both sides)
        if l is not None and r is None:
            return Step(UPLOAD, p, local=l)
        if r is not None and l is None:
            return Step(DOWNLOAD, p, fid=fid, remote=r)
        if l is not None and r is not None:
            return Step(CONFLICT, p, local=l, fid=fid, remote=r)
        return None
    here_changed, there_changed = l != b, r != b
    if not here_changed and not there_changed:
        return None
    if here_changed and not there_changed:
        if l is not None:
            return Step(UPLOAD, p, local=l, fid=fid, remote=r, base=r)
        return Step(DELETE_THERE, p, fid=fid, remote=r)
    if there_changed and not here_changed:
        if r is not None:
            return Step(DOWNLOAD, p, local=l, fid=fid, remote=r, replaces=True)
        return Step(DELETE_HERE, p, local=l)
    # both changed (l != r: the equal case is above)
    if l is None and r is None:
        return Step(FORGET, p)
    if l is None:
        return Step(DOWNLOAD, p, fid=fid, remote=r)                 # an edit beats a delete
    if r is None:
        return Step(UPLOAD, p, local=l)                             # the same rule, the other way: create-only
    return Step(CONFLICT, p, local=l, fid=fid, remote=r)


def _doc_version(rem):
    return (rem.fid, rem.revision if rem.revision is not None else rem.sha256)


def _snapshot_step(p, loc, rem, row):
    """§3.4 for a notebook, board or chat path: download-only, and never replacing or deleting a file whose hash isn't
    fs-sync's own last snapshot's."""
    l = loc.sha256 if loc else None
    snap = row if row is not None and row.snapshot else None
    if rem is not None:
        if l is None:
            # (an absent path: written, new or again)
            return Step(SNAPSHOT, p, fid=rem.fid, remote=_doc_version(rem)[1], why="again" if snap else "new")
        if snap is None:
            return Step(NOT_UPLOADED_OCCUPIED, p, local=l)
        if l != snap.sha256:
            return Step(NOT_UPLOADED_CHANGED, p, local=l)
        if (snap.fid, snap.revision) != _doc_version(rem):
            return Step(SNAPSHOT, p, local=l, fid=rem.fid, remote=_doc_version(rem)[1], replaces=True, why="changed")
        return None
    if l is None:
        return Step(FORGET, p) if row is not None else None
    if snap is None:
        return Step(NOT_UPLOADED_NEW, p, local=l)
    if l != snap.sha256:
        return Step(NOT_UPLOADED_CHANGED, p, local=l)
    return Step(DELETE_HERE, p, local=l)                            # the document was deleted, the snapshot unedited


def _parents(paths):
    out = set()
    for p in paths:
        while "/" in p:
            p = p.rsplit("/", 1)[0]
            out.add(p)
    return out


def plan(local, remote, base, mode=BOTH, computer="this computer", case_insensitive=False, room=MAX_PATH):
    """`room`: the longest relative path the workspace takes under the synced folder (MAX_PATH less the folder's own
    path and its slash). A conflict whose copy can't be named within it is listed as not applied (why="no-name")."""
    if mode not in MODES:
        raise ValueError("mode is one of %s" % (MODES,))
    out = Plan(mode=mode, first=not base)
    taken_keys = {p.casefold() for p in list(local) + list(remote)}
    folders = {p for p, r in remote.items() if r.kind == "folder"}
    remote = {p: r for p, r in remote.items() if r.kind != "folder"}
    local_dirs, remote_dirs = _parents(local), _parents(remote) | folders
    case_clash = set()
    if case_insensitive:
        groups = {}
        for p in remote:
            groups.setdefault(p.casefold(), []).append(p)
        case_clash = {p for g in groups.values() if len(g) > 1 for p in g}
    for p in sorted(set(local) | set(remote) | set(base) | (folders & set(local))):
        loc, rem, row = local.get(p), remote.get(p), base.get(p)
        if p in case_clash:
            out.steps.append(Step(CASE_CLASH, p, local=loc.sha256 if loc else None, fid=rem.fid if rem else None))
            continue
        if (loc is not None and p in remote_dirs) or (rem is not None and p in local_dirs):
            out.steps.append(Step(TYPE_CLASH, p, local=loc.sha256 if loc else None, fid=rem.fid if rem else None))
            continue
        # (a snapshot row keeps a path under the snapshot rules even if its name or kind changed since: it never uploads)
        if is_snapshot_name(p) or (rem is not None and rem.kind != "file") or (row is not None and row.snapshot):
            if mode == UP:
                continue                        # snapshots are neither written nor checked under --up (§3.4)
            step = _snapshot_step(p, loc, rem, row)
        else:
            step = _data_step(p, loc.sha256 if loc else None, rem.sha256 if rem else None,
                              row.sha256 if row else None, rem)
        if step is None:
            continue
        if rem is not None:
            step = replace(step, rkind=rem.kind)
        if step.kind == CONFLICT:
            if mode != BOTH:
                step = Step(CONFLICT_NOT_APPLIED, p, local=step.local, fid=step.fid, remote=step.remote, rkind=step.rkind)
            else:
                try:
                    copy = conflict_name(p, computer, lambda q: q.casefold() in taken_keys, room)
                except ValueError:
                    out.steps.append(Step(CONFLICT_NOT_APPLIED, p, local=step.local, fid=step.fid, remote=step.remote,
                                          rkind=step.rkind, why="no-name"))
                    continue
                taken_keys.add(copy.casefold())
                step = Step(CONFLICT, p, local=step.local, fid=step.fid, remote=step.remote, rkind=step.rkind, copy=copy)
        elif (mode == UP and step.kind in _CHANGES_HERE) or (mode == DOWN and step.kind in _CHANGES_WORKSPACE):
            step = replace(step, kind=PENDING, action=step.kind)
        out.steps.append(step)
    return out


def needs_delete_confirmation(p, base_files):
    """True when the plan's deletes on either side are more than 50, or more than a quarter of the base's files
    (§2.4): the number must then be confirmed (typed, or `--allow-deletes N`)."""
    for n in p.deletes():
        if n > DELETE_CONFIRM_COUNT or (base_files and n > DELETE_CONFIRM_SHARE * base_files):
            return True
    return False
