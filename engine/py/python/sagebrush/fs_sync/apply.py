"""fs-sync's apply step (design/fs-sync.md §1.2, §2.3–2.5, §3.4, §4.1, §4.3): a plan, made from a scan and a
listing, applied action by action, each checking first that what it was planned from still holds.

- **Inputs:** the plan, and the scan (`ScanResult`) and workspace listing ({path: Entry}) it was made from: sizes, the
  local spelling on disk and the stat key come from them, so every check is against the planned state. The workspace
  is the `Workspace` interface (workspace.py); the base is the pair's `state.Base`.
- **The holding folder, in daybreak3's order:** one `holding.Session` for the run, taken without waiting; its cleanup
  first, every run; then, only if the run moves files aside (deletes here, and downloads that replace a file), its
  run folder, its admission and its journal (`<run id>/journal.json`: LOCAL_DIR and WORKSPACE_PATH, for
  `--restore`; inside the run folder, so the holding folder's bounded walk, admission and cleanup cover it); the
  moves in plan order under it; and the session released after the last move aside. A run with nothing to move
  aside, or whose run folder was refused, releases it right after cleanup.
  If the session is busy, the holding folder is on another filesystem, no run id is left this second, or admission
  refuses, every such action stays pending and the rest of the plan goes ahead. A run folder that took nothing is
  removed, under the lock.
- **Every action checks first** (§4.1): an upload hashes the local file as it sends it, and a mismatch fails the
  write before it commits; a download is read into a temporary file and checked (the entry's kind, fid and hash, and
  the bytes' count and hash) before anything here changes; a delete here asks the workspace that nothing is at the
  path, then moves the file aside and checks it there. A check that fails skips the action, and the next run plans
  again.
- **Snapshots** (§3.4): a notebook, board or chat comes down as its snapshot, from one read capped at DOCUMENT_BYTES
  (+1 to see past it), checked to be the planned fid and kind; its row records the hash of the bytes written and that
  read's fid and revision, marked as a snapshot. It is written only to an absent path (no-replace, and never beside a
  newcomer) or over fs-sync's own last snapshot, moved to `replaced/` as a replacing download is.
- **The base** (§2.5): a delete (either side) or a replacing download is bracketed: its row removed and committed
  first, the new row (or none) committed after, the old row put back if it was skipped or not applied. Other actions
  are recorded in batches.
- **Workspace errors** (the endpoint's): 409 skips the action; 413 leaves it pending; 429, 401 and a network error
  stop the run at once, the actions not yet tried left as they are.
- **Downloads need room** (§1.2, §4.5): each filesystem downloads land on (a mount inside LOCAL_DIR too) keeps
  256 MiB free beyond its downloads, a snapshot counted at DOCUMENT_BYTES; those that don't fit, in plan order, stay
  pending.
- **Seams** (§5): `hooks[name](step)` at "before_check", "after_tmp_written", "after_read" (a snapshot's, after its
  checks) and "after_action", and
  "after_base_commit" (the step, or None for the run's last batch); move.py's "after_move_aside" and "before_install"
  get the step too.

`render(report)` gives the report's lines, in the words of design §1.2 and board's texts."""

import errno
import hashlib
import json
import os
import stat
import time
from dataclasses import dataclass, field

from . import holding as H
from . import move as M
from . import plan as P
from . import scan as S
from .state import Row, _home_short
from .workspace import DOCUMENT_BYTES, Base as WBase, Conflict, RateLimited, TooLarge, Unauthorized

_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
_CLOEXEC = getattr(os, "O_CLOEXEC", 0)
CHUNK = 2**20
DOWNLOAD_HEADROOM = 256 * 2**20     # LOCAL_DIR's filesystem keeps this free beyond the downloads (§1.2)
JOURNAL = "journal.json"            # in the run folder, beside deleted/ and replaced/
_NOT_YOURS = "not a folder of yours in fs-sync's holding folder"     # move.own_dirs' refusal

# outcomes
DONE = "done"
SKIPPED = "skipped"                 # a check failed, or the workspace refused (409): the next run plans again
PENDING = "pending"                 # not applied this run (`why`)
NOT_TRIED = "not-tried"             # the run stopped (429, 401, the network) before this action

# why (per action)
CHANGED_HERE = "changed-here"
CHANGED_THERE = "changed-there"
BESIDE = "beside"                   # a newcomer took the name: the workspace's version is beside it
NO_CONFLICT_NAME = "no-conflict-name"
NO_REPLACE = "no-replace"
HOLD_ERROR = "hold-error"           # an OS error moving it into the holding folder
LOCAL_ERROR = "local-error"         # an OS error here, outside the holding folder
TOO_LARGE = "too-large"
NO_ROOM = "no-room"                 # its filesystem is short of room (Report.space)
HELD_BACK = "held-back"             # a run-level line (Report.run_lines) holds it back


@dataclass
class Outcome:
    step: P.Step
    result: str
    why: str = None
    detail: str = None              # the reason's text (an OS error's), or the other path it names
    beside: str = None              # BESIDE: the path the workspace's version was saved at
    held: str = None                # the local file's place in the holding folder, if it was left there
    row: Row = None                 # the base row to record (a done action)
    copy_row: Row = None            # a conflict's copy's row
    renamed: str = None             # a conflict whose local file was renamed to its copy, not uploaded


@dataclass
class Report:
    run_id: str
    local: str                      # LOCAL_DIR and the holding folder, as shown (~/thesis)
    trash: str
    outcomes: list = field(default_factory=list)
    run_lines: list = field(default_factory=list)   # run-level "Not applied: …" sentences, in order, each once
    space: list = field(default_factory=list)       # per filesystem short of room: (mount point, needed, free, paths)
    stopped: str = None             # "rate-limited", "unauthorized" or "network": the run stopped there
    retry_after: float = None
    cleaned: list = field(default_factory=list)     # run ids cleanup removed
    admission: H.Admission = None

    def of(self, result, why=None):
        return [o for o in self.outcomes if o.result == result and (why is None or o.why == why)]

    def run_line(self, line):
        if line not in self.run_lines:
            self.run_lines.append(line)


class _Skip(Exception):
    def __init__(self, result, why, detail=None, beside=None, held=None):
        super().__init__(why)
        self.out = dict(result=result, why=why, detail=detail, beside=beside, held=held)


class _Local(Exception):
    """An OS error on this computer, raised through a workspace call (the writer, the data being sent)."""

    def __init__(self, e):
        super().__init__(e)
        self.e = e


def _hook(hooks, name, arg):
    if hooks and name in hooks:
        hooks[name](arg)


def _moves_aside(step):
    return step.kind == P.DELETE_HERE or (step.kind in (P.DOWNLOAD, P.SNAPSHOT) and step.replaces)


def _part(step):
    return M.DELETED if step.kind == P.DELETE_HERE else M.REPLACED


def _destructive(step):
    return step.kind in (P.DELETE_HERE, P.DELETE_THERE) or (step.kind in (P.DOWNLOAD, P.SNAPSHOT) and step.replaces)


def _split(raw):
    parts = raw.split("/")
    return parts[:-1], parts[-1]


def _size(n):
    """Bytes as the design shows them: GiB to one decimal from 1 GiB (whole bounds without one), else whole MiB."""
    if n >= 2**30:
        g = n / 2**30
        return "%d GiB" % g if n % 2**30 == 0 else "%.1f GiB" % g
    return "%d MiB" % (n // 2**20)


def _mount_point(path):
    path = os.path.realpath(path)
    dev = os.stat(path).st_dev
    while path != os.sep:
        parent = os.path.dirname(path)
        if os.stat(parent).st_dev != dev:
            break
        path = parent
    return path


# ---- run-level lines (board's texts, word for word)

def _held_back(local):
    return "Not applied: deleting or replacing files in %s." % local


def _admission_line(a, local, trash):
    line = H.not_applied(a, local, trash)
    if line is not None:
        return line
    if a.reason == "run-entries":
        return ("%s This sync would move %s files and folders into fs-sync's holding folder, over the limit of %s for "
                "one sync. Sync its subfolders as separate pairs instead." %
                (_held_back(local), format(a.entries, ","), format(H.RUN_ENTRIES, ",")))
    if a.reason == "run-bytes":
        return ("%s This sync would move %s into fs-sync's holding folder, over the limit of %s for one sync. Sync "
                "its subfolders as separate pairs instead." % (_held_back(local), _size(a.bytes), _size(H.RUN_BYTES)))
    # (the totals: what is held without this run's own folder, which new_run made and abandon removes, and the run's
    # own count, the folder included: together exactly what the check compared)
    if a.reason == "total-entries":
        return ("%s fs-sync's holding folder (%s) holds %s files and folders, and this sync would add %s, over its "
                "limit of %s. Each sync's folder there is removed 30 days after that sync." %
                (_held_back(local), trash, format(a.held_entries - 1, ","), format(a.entries, ","),
                 format(H.TOTAL_ENTRIES, ",")))
    return ("%s fs-sync's holding folder (%s) holds %s, and this sync would add %s, over its limit of %s. Each sync's "
            "folder there is removed 30 days after that sync." %
            (_held_back(local), trash, _size(a.held_bytes), _size(a.bytes), _size(H.TOTAL_BYTES)))


def _other_disk_line(local_dir, state_dir):
    here = _mount_point(local_dir)
    return ("Not applied: deleting or replacing files on %s needs fs-sync's holding folder on the same disk, and it is "
            "on %s. Set XDG_STATE_HOME to a folder on %s outside the synced folder to allow it. The next run is then a "
            "first sync: nothing is deleted until the one after." % (here, _mount_point(state_dir), here))


def _no_run_id_line(local, base_id):
    return ("%s fs-sync's holding folder already has %d folders named for this second (%s to %s-%d). Run it again." %
            (_held_back(local), H.MAX_SAME_SECOND, base_id, base_id, H.MAX_SAME_SECOND))


def _not_yours_line(local, folder):
    return "%s %s isn't a folder of yours, so fs-sync won't move files into it." % (_held_back(local), folder)


def _not_yours(e):
    return isinstance(e, PermissionError) and e.errno == errno.EPERM and e.strerror == _NOT_YOURS


# ---- the local side

def _read_local(root_fd, raw, size, sha256):
    """The local file `raw`'s bytes, in chunks, read through no-follow handles; after the last chunk, if it isn't the
    planned file (its size or hash), _Skip(CHANGED_HERE), raised inside the write, so the write never commits."""
    folders, name = _split(raw)
    try:
        d = M.open_dir(root_fd, folders)
        try:
            fd = os.open(name, os.O_RDONLY | os.O_NONBLOCK | _NOFOLLOW | _CLOEXEC, dir_fd=d)
        finally:
            os.close(d)
    except (FileNotFoundError, NotADirectoryError):
        raise _Skip(SKIPPED, CHANGED_HERE)
    except OSError as e:
        if e.errno == errno.ELOOP:
            raise _Skip(SKIPPED, CHANGED_HERE)
        raise _Local(e)
    try:
        try:
            st = os.fstat(fd)
        except OSError as e:
            raise _Local(e)
        if not stat.S_ISREG(st.st_mode) or st.st_size != size:
            raise _Skip(SKIPPED, CHANGED_HERE)
        h, n = hashlib.sha256(), 0
        while True:
            try:
                b = os.read(fd, min(CHUNK, size + 1 - n))
            except OSError as e:
                raise _Local(e)
            if not b:
                break
            n += len(b)
            h.update(b)
            yield b
        if n != size or h.hexdigest() != sha256:
            raise _Skip(SKIPPED, CHANGED_HERE)
    finally:
        os.close(fd)


def _row(root_fd, raw, sha256, fid, snapshot=False, revision=None):
    """The base row for the file fs-sync just wrote at `raw`: `sha256` (what is in sync on both sides) with the stat key
    of the bytes read back there and found to be exactly those (the scan's bounded reader, its identity checked), so
    the next scan's shortcut never pairs a key with bytes it didn't hash. If they aren't (changed already) or can't be
    read, the row has no key (ino 0 matches no file), and the next scan hashes the file."""
    folders, name = _split(raw)
    try:
        d = M.open_dir(root_fd, folders)
        try:
            st = os.stat(name, dir_fd=d, follow_symlinks=False)
            if stat.S_ISREG(st.st_mode) and st.st_size <= S.MAX_FILE_BYTES and S._hash(d, name, st) == sha256:
                return Row(sha256, st.st_size, st.st_mtime_ns, st.st_ctime_ns, st.st_ino, st.st_dev, fid, snapshot,
                           revision)
        finally:
            os.close(d)
    except OSError:
        pass
    return Row(sha256, 0, 0, 0, 0, 0, fid, snapshot, revision)


def _scan_row(loc, fid):
    return Row(loc.sha256, loc.size, loc.mtime_ns, loc.ctime_ns, loc.ino, loc.dev, fid)


def _unlink(root_fd, folders, name):
    try:
        d = M.open_dir(root_fd, folders)
    except OSError:
        return
    try:
        os.unlink(name, dir_fd=d)
    except OSError:
        pass
    finally:
        os.close(d)


def _to_temp(root_fd, raw, tmp, fetch):
    """The temporary file `tmp` in `raw`'s folder (made as needed), written by `fetch(writer, hash)`, which reads and
    checks; synced to the disk before it is used. A temp that fails is removed. Returns what `fetch` returns."""
    folders, _ = _split(raw)
    try:
        d = M.open_dir(root_fd, folders, make=True, mode=0o777)
    except (FileNotFoundError, NotADirectoryError):
        raise _Skip(SKIPPED, CHANGED_HERE)
    except OSError as e:
        if e.errno == errno.ELOOP:
            raise _Skip(SKIPPED, CHANGED_HERE)
        raise
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | _NOFOLLOW | _CLOEXEC, 0o666, dir_fd=d)
        ok = False
        try:
            h = hashlib.sha256()

            def writer(b):
                h.update(b)
                view = memoryview(b)
                try:
                    while view:
                        view = view[os.write(fd, view):]
                except OSError as e:
                    raise _Local(e)
            result = fetch(writer, h)
            os.fsync(fd)
            ok = True
            return result
        finally:
            os.close(fd)
            if not ok:
                try:
                    os.unlink(tmp, dir_fd=d)
                except OSError:
                    pass
    finally:
        os.close(d)


def _download_to_temp(root_fd, ws, step, raw, size, tmp, hooks):
    """The workspace's file at step.path read into the temporary file `tmp` and checked against the plan: the entry's
    kind, fid and hash, and the bytes' count and hash."""
    def fetch(writer, h):
        entry, n = _ws(ws.read, step.path, writer, size + 1)
        if ((entry.kind, entry.fid, entry.sha256) != (step.rkind or "file", step.fid, step.remote) or n != size
                or h.hexdigest() != step.remote):
            raise _Skip(SKIPPED, CHANGED_THERE)
    _to_temp(root_fd, raw, tmp, fetch)
    _hook(hooks, "after_tmp_written", step)


def _snapshot_to_temp(root_fd, ws, step, raw, tmp):
    """A document's snapshot (§3.4) read into the temporary file `tmp`, by one read capped at DOCUMENT_BYTES + 1:
    checked to be the planned fid and kind, and within DOCUMENT_BYTES. Returns (that read's Entry, the bytes' hash)."""
    def fetch(writer, h):
        entry, n = _ws(ws.read, step.path, writer, DOCUMENT_BYTES + 1)
        if (entry.kind, entry.fid) != (step.rkind, step.fid):
            raise _Skip(SKIPPED, CHANGED_THERE)
        if n > DOCUMENT_BYTES:
            raise _Skip(PENDING, TOO_LARGE)
        return entry, h.hexdigest()
    return _to_temp(root_fd, raw, tmp, fetch)


# ---- the holding folder

class _Hold:
    """The run's Session, its run folder and that folder's parts (deleted/, replaced/); `ok` once the run may move
    files aside."""

    def __init__(self, report, state_dir, local_dir, workspace_path):
        self.report, self.state_dir = report, state_dir
        self.local_dir, self.workspace_path = local_dir, workspace_path
        self.session = self.holding = self.problem = None
        self.parts = {}

    @property
    def ok(self):
        return self.holding is not None

    def open(self, now):
        """Every run: the lock, without waiting, and cleanup first under it."""
        r = self.report
        try:
            self.session = H.Session.open(self.state_dir)
        except OSError as e:
            self.problem = self._refusal(e, r.trash)
            return
        if self.session is None:
            self.problem = H.not_applied(H.Admission(False, "busy"), r.local, r.trash)
            return
        try:
            r.cleaned = self.session.cleanup(now)
        except OSError:
            pass                                        # (cleanup is retried every run; it never stops one)

    def begin(self, root_fd, moves, now):
        """Only for a run that moves files aside (`moves`: (part/relative path, size)): its run folder, its admission
        and its journal; or the run-level line that holds those moves back."""
        r = self.report
        if self.session is None:
            r.run_line(self.problem)
            return
        try:
            h = self.session.new_run(now)
        except FileExistsError as e:
            if e.strerror == "no run id left this second":
                r.run_line(_no_run_id_line(r.local, e.filename))
            else:
                r.run_line(self._refusal(e, r.trash))
            return
        except OSError as e:
            # (own_dirs names the folder it refused: trash/ itself, or the run's own)
            r.run_line(self._refusal(e, r.trash if e.filename in (None, "trash") else r.trash + "/" + e.filename))
            return
        try:
            if not h.same_filesystem(root_fd):
                self.session.abandon(h)
                r.run_line(_other_disk_line(self.local_dir, self.state_dir))
                return
            journal = json.dumps({"run": h.run_id, "local_dir": self.local_dir,
                                  "workspace_path": self.workspace_path}).encode()
            a = self.session.admit(moves + [(JOURNAL, len(journal))])
            r.admission = a
            if not a.ok:
                self.session.abandon(h)
                r.run_line(_admission_line(a, r.local, r.trash))
                return
            _journal(h, journal)
        except OSError as e:
            _drop(h, JOURNAL)
            self.session.abandon(h)
            r.run_line(self._refusal(e, r.trash + "/" + h.run_id))
            return
        self.holding = h
        r.run_id = h.run_id

    def _refusal(self, e, path):
        r = self.report
        if _not_yours(e):
            return _not_yours_line(r.local, path)
        return "%s fs-sync couldn't prepare its holding folder (%s): %s." % (_held_back(r.local), path, H.strerror(e))

    def dirs(self, part, folders):
        """The handle on `part`'s mirror of `folders`, checked one level at a time from the run folder; an error
        names the exact folder. The caller closes it."""
        done = [part]
        try:
            if part not in self.parts:
                self.parts[part] = M.Part(self.holding, part)
            fd = os.dup(self.parts[part].fd)
            for name in folders:
                done.append(name)
                try:
                    nxt = M.own_dirs(fd, [name])
                finally:
                    os.close(fd)
                fd = nxt
            return fd
        except OSError as e:
            where = "/".join([self.report.trash, self.holding.run_id] + done)
            if _not_yours(e):
                self.report.run_line(_not_yours_line(self.report.local, where))
                raise _Skip(PENDING, HELD_BACK)
            raise _Skip(PENDING, HOLD_ERROR, "%s (%s)" % (H.strerror(e), where))

    def where(self, part, raw):
        return "%s/%s/%s/%s" % (self.report.trash, self.holding.run_id, part, raw)

    def release(self):
        """After the last move aside: a run folder that took nothing removed (with its journal), then the lock."""
        if self.session is None:
            return
        try:
            if self.holding is not None:
                for part in self.parts.values():
                    part.close()
                # (rmdir removes only empty folders: a run folder holding anything stays, with its journal)
                try:
                    for name in self.parts:
                        os.rmdir(name, dir_fd=self.holding.fd)
                    _drop(self.holding, JOURNAL)
                    self.session.abandon(self.holding)
                except OSError:
                    pass
                self.holding.close()
        finally:
            self.session.close()
            self.session = None


def _journal(holding, data):
    """The run's journal (§4.3), `journal.json` in its run folder: what --restore needs to put this run's files back,
    written before the first move aside. --restore refuses a run without one."""
    fd = os.open(JOURNAL, os.O_WRONLY | os.O_CREAT | os.O_EXCL | _NOFOLLOW | _CLOEXEC, 0o600, dir_fd=holding.fd)
    try:
        while data:
            data = data[os.write(fd, data):]
        os.fsync(fd)
    finally:
        os.close(fd)
    os.fsync(holding.fd)


def _drop(holding, name):
    try:
        os.unlink(name, dir_fd=holding.fd)
    except FileNotFoundError:
        pass


class NotRestorable(Exception):
    """--restore can't use this run: `why` is "no-run" (no such run folder), "no-journal" or "other-folder" (its
    journal names another LOCAL_DIR or WORKSPACE_PATH)."""

    def __init__(self, why):
        super().__init__(why)
        self.why = why


def restore_run(state_dir, run_id, root_fd, local_dir, workspace_path):
    """`--restore <run id>` (§2.4): the files that run deleted here put back into LOCAL_DIR (`root_fd`), from its
    `deleted/` only: never `replaced/` (the report named where each replaced file is kept) nor the journal. Refused
    (NotRestorable) for a run with no journal, or whose journal names another pair. Returns the relative paths left
    held because something occupies them now (move.restore)."""
    top = os.open(state_dir, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | _NOFOLLOW | _CLOEXEC)
    try:
        try:
            os.close(M.open_dir(top, ["trash", run_id]))       # (looked up, never made)
        except (FileNotFoundError, NotADirectoryError, ValueError):
            raise NotRestorable("no-run")
    finally:
        os.close(top)
    h = M.Holding(state_dir, run_id)
    try:
        try:
            fd = os.open(JOURNAL, os.O_RDONLY | os.O_NONBLOCK | _NOFOLLOW | _CLOEXEC, dir_fd=h.fd)
        except (FileNotFoundError, OSError):
            raise NotRestorable("no-journal")
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                raise NotRestorable("no-journal")
            data = os.read(fd, 65536)
        finally:
            os.close(fd)
        try:
            journal = json.loads(data)
        except ValueError:
            raise NotRestorable("no-journal")
        if not isinstance(journal, dict) or (journal.get("local_dir"), journal.get("workspace_path")) != (
                local_dir, workspace_path):
            raise NotRestorable("other-folder")
        try:
            os.close(M.open_dir(h.fd, [M.DELETED]))
        except FileNotFoundError:
            return []                                   # (a run that only replaced files: nothing to put back)
        part = M.Part(h, M.DELETED)
        try:
            return M.restore(root_fd, part)
        finally:
            part.close()
    finally:
        h.close()


# ---- the apply loop

def apply(plan, scan, listing, root_fd, ws, base, state_dir, local_dir, workspace_path, computer, now=None,
          hooks=None, free_space=None):
    """Apply `plan` (see the module docstring). `free_space(folder fd)` -> (filesystem key, free bytes): a seam for
    tests; fstat/fstatvfs if None. Returns the Report; a refused action never raises."""
    now = time.time() if now is None else now
    report = Report(run_id=H.run_id_at(now), local=_home_short(local_dir),
                    trash=_home_short(os.path.join(state_dir, "trash")))
    steps = [s for s in plan.steps if s.kind in P.ACTIONS]
    no_room = _over_space(steps, scan, listing, root_fd, local_dir, report, free_space)
    aside = [s for s in steps if _moves_aside(s) and id(s) not in no_room]
    hold = _Hold(report, state_dir, local_dir, workspace_path)
    try:
        hold.open(now)
        if aside:
            hold.begin(root_fd, [(_part(s) + "/" + (scan.files[s.path].raw or s.path), scan.files[s.path].size)
                                for s in aside], now)
        if not hold.ok:
            hold.release()                              # (no moves aside, or refused: the lock only for cleanup)
        last = aside[-1] if aside and hold.ok else None
        M.sweep_temps(root_fd, scan.temps, report.run_id)
        for k, step in enumerate(steps):
            if id(step) in no_room:
                out = Outcome(step, *no_room[id(step)])
            elif _moves_aside(step) and not hold.ok:
                out = Outcome(step, PENDING, HELD_BACK)
            elif report.stopped:
                out = Outcome(step, NOT_TRIED, report.stopped)
            else:
                out = _one(step, k, scan, listing, root_fd, ws, base, hold, report, computer, hooks)
            report.outcomes.append(out)
            if step is last:
                hold.release()
        base.flush()
        _hook(hooks, "after_base_commit", None)
    finally:
        hold.release()
    return report


def _filesystem(fd):
    """(the filesystem's identity, its free bytes) for an open folder."""
    st = os.fstatvfs(fd)
    return os.fstat(fd).st_dev, st.f_bavail * st.f_frsize


def _over_space(steps, scan, listing, root_fd, local_dir, report, free_space):
    """§4.5, for each filesystem downloads land on (daybreak2): each target's nearest existing folder under LOCAL_DIR,
    opened without following links, and its filesystem measured there; per filesystem, in plan order, the downloads
    that fit with 256 MiB to spare (charged once). Returns {id(step): (result, why[, detail])} for those that don't,
    and for targets that can't be measured (failed closed, before anything changes)."""
    measure = free_space or _filesystem
    out, fs = {}, {}
    for s in steps:
        if s.kind not in (P.DOWNLOAD, P.CONFLICT, P.SNAPSHOT):
            continue
        loc = scan.files.get(s.path)
        folders = ((loc.raw or s.path) if loc else s.path).split("/")[:-1]
        fd, depth = os.dup(root_fd), 0
        try:
            for part in folders:
                try:
                    nxt = M.open_dir(fd, [part])
                except FileNotFoundError:
                    break                               # (a folder still to make: on its parent's filesystem)
                os.close(fd)
                fd, depth = nxt, depth + 1
            key, free = measure(fd)
        except (OSError, ValueError) as e:
            if isinstance(e, OSError) and e.errno not in (errno.ELOOP, errno.ENOTDIR):
                out[id(s)] = (SKIPPED, LOCAL_ERROR, H.strerror(e))
            else:
                out[id(s)] = (SKIPPED, CHANGED_HERE)    # (a link or a file where a folder was)
            continue
        finally:
            os.close(fd)
        f = fs.get(key)
        if f is None:
            f = fs[key] = dict(where=_mount_point(os.path.join(local_dir, *folders[:depth])), free=free, used=0,
                               need=DOWNLOAD_HEADROOM, paths=[])
        n = DOCUMENT_BYTES if s.kind == P.SNAPSHOT else listing[s.path].size     # (a snapshot: its largest answer)
        f["need"] += n
        if f["used"] + n + DOWNLOAD_HEADROOM <= f["free"]:
            f["used"] += n
        else:
            f["paths"].append(s.path)
            out[id(s)] = (PENDING, NO_ROOM)
    report.space = [(f["where"], f["need"], f["free"], f["paths"]) for f in fs.values() if f["paths"]]
    return out


def _one(step, k, scan, listing, root_fd, ws, base, hold, report, computer, hooks):
    _hook(hooks, "before_check", step)
    destructive = _destructive(step)
    old = None
    if destructive:
        problem = base.reserve_problem()
        if problem:
            report.run_line(problem)
            return Outcome(step, PENDING, HELD_BACK)
        old = base.begin_destructive(step.path)
        _hook(hooks, "after_base_commit", step)
    try:
        out = _act(step, k, scan, listing, root_fd, ws, hold, report, computer, hooks)
    except Exception as e:
        out = _failed(step, e, hold, report)
        out.renamed = getattr(e, "renamed", None)
    if destructive:
        if out.result == DONE:
            base.finish_destructive(step.path, out.row)
        elif out.held:
            base.finish_destructive(step.path, None)    # (the file left this computer: held, the path not recorded)
        else:
            base.undo_destructive(step.path, old)
        _hook(hooks, "after_base_commit", step)
    else:
        if out.result == DONE:
            base.record(step.path, out.row)
        if out.copy_row is not None:
            base.record(step.copy, out.copy_row)        # (a conflict's copy, uploaded, whatever became of the rest)
    _hook(hooks, "after_action", step)
    return out


def _failed(step, e, hold, report):
    """The outcome of an action that raised `e`."""
    if isinstance(e, _Skip):
        return Outcome(step, **e.out)
    if isinstance(e, Conflict):
        return Outcome(step, SKIPPED, CHANGED_THERE)
    if isinstance(e, TooLarge):
        return Outcome(step, PENDING, TOO_LARGE)
    if isinstance(e, RateLimited):
        report.stopped, report.retry_after = "rate-limited", e.retry_after
        return Outcome(step, NOT_TRIED, report.stopped)
    if isinstance(e, Unauthorized):
        report.stopped = "unauthorized"
        return Outcome(step, NOT_TRIED, report.stopped)
    if isinstance(e, M.NoReplace):
        if e.reason == "it is on another filesystem":
            report.run_line(_other_disk_line(hold.local_dir, hold.state_dir))
            return Outcome(step, PENDING, HELD_BACK)
        return Outcome(step, PENDING, NO_REPLACE)
    if isinstance(e, _Local):
        return Outcome(step, SKIPPED, LOCAL_ERROR, H.strerror(e.e))
    if isinstance(e, OSError):
        if getattr(e, "_local", True) and not isinstance(e, ConnectionError):
            return Outcome(step, SKIPPED, LOCAL_ERROR, H.strerror(e))
        report.stopped = "network"
        return Outcome(step, NOT_TRIED, report.stopped)
    raise e


def _move_aside(root_fd, raw, loc, hold, part, step, hooks):
    """`raw` moved into the run's `part` of the holding folder and checked there; its place there, or _Skip."""
    folders, _ = _split(raw)
    try:
        os.close(M.open_dir(root_fd, folders))
    except OSError:
        raise _Skip(SKIPPED, CHANGED_HERE)
    os.close(hold.dirs(part, folders))
    try:
        M.move_aside(root_fd, raw, hold.parts[part], loc.sha256, loc.size, hooks=_step_hooks(hooks, step))
    except M.Changed as c:
        raise _Skip(SKIPPED, CHANGED_HERE, held=hold.where(part, raw) if c.held else None)
    except (M.Occupied, FileNotFoundError):
        raise _Skip(SKIPPED, CHANGED_HERE)          # (gone, or something at its place there that isn't this run's)
    except M.NoReplace:
        raise
    except OSError as e:
        raise _Skip(PENDING, HOLD_ERROR, H.strerror(e))
    return hold.where(part, raw)


def _act(step, k, scan, listing, root_fd, ws, hold, report, computer, hooks):
    loc = scan.files.get(step.path)
    raw = (loc.raw or step.path) if loc else step.path
    snapshot = P.is_snapshot_name(step.path)
    if step.kind == P.RECORD:
        return Outcome(step, DONE, row=_scan_row(loc, listing[step.path].fid))
    if step.kind == P.FORGET:
        return Outcome(step, DONE)
    if step.kind == P.UPLOAD:
        wbase = WBase(step.fid, step.base) if step.base is not None else None
        ent = _ws(ws.write, step.path, _read_local(root_fd, raw, loc.size, step.local), wbase, step.local, loc.size)
        return Outcome(step, DONE, row=_scan_row(loc, ent.fid))
    if step.kind == P.DELETE_THERE:
        _ws(ws.remove, step.path, step.fid, step.remote)
        return Outcome(step, DONE)
    if step.kind == P.DELETE_HERE:
        if _ws(ws.stat, step.path) is not None:
            raise _Skip(SKIPPED, CHANGED_THERE)         # (anything there now: the next run plans again)
        held = _move_aside(root_fd, raw, loc, hold, M.DELETED, step, hooks)
        return Outcome(step, DONE, held=held)
    if step.kind == P.DOWNLOAD:
        return _download(step, k, loc, raw, listing, root_fd, ws, hold, report, computer, hooks, snapshot)
    if step.kind == P.CONFLICT:
        return _conflict(step, k, loc, raw, listing, root_fd, ws, hold, report, computer, hooks)
    if step.kind == P.SNAPSHOT:
        return _snapshot(step, k, loc, raw, root_fd, ws, hold, report, hooks)
    raise AssertionError(step.kind)


def _ws(f, *args):
    """A workspace call: an OSError from it is the network's (the run stops); this computer's come as _Local."""
    try:
        return f(*args)
    except (_Local, _Skip):
        raise
    except OSError as e:
        e._local = False
        raise


def _download(step, k, loc, raw, listing, root_fd, ws, hold, report, computer, hooks, snapshot):
    size = listing[step.path].size
    tmp = M.temp_name(report.run_id, k)
    folders, _ = _split(raw)
    _download_to_temp(root_fd, ws, step, raw, size, tmp, hooks)
    held = None
    if step.replaces:
        try:
            held = _move_aside(root_fd, raw, loc, hold, M.REPLACED, step, hooks)
        except _Skip:
            _unlink(root_fd, folders, tmp)
            raise
    # (from here on the local file may be held: every outcome says where)
    try:
        M.install(root_fd, raw, tmp, computer, hooks=_step_hooks(hooks, step))
    except M.InstalledBeside as b:
        # (a newcomer took the name: ours is beside it; the path isn't recorded, so the next run plans it)
        return Outcome(step, SKIPPED, BESIDE, beside=b.rel, held=held)
    except M.Occupied as e:
        # (the temp stays: the next run sweeps it)
        return Outcome(step, PENDING, NO_CONFLICT_NAME, _names(e.tried), held=held)
    except M.NoReplace as e:
        _unlink(root_fd, folders, tmp)
        return Outcome(step, SKIPPED, LOCAL_ERROR, e.reason, held=held)
    except OSError as e:
        _unlink(root_fd, folders, tmp)
        return Outcome(step, SKIPPED, LOCAL_ERROR, H.strerror(e), held=held)
    return Outcome(step, DONE, held=held, row=_row(root_fd, raw, step.remote, step.fid, snapshot))


def _snapshot(step, k, loc, raw, root_fd, ws, hold, report, hooks):
    """§3.4: the document's snapshot written to its path, only if absent (a no-replace rename: a newcomer there keeps
    the path, and the snapshot is skipped, never put beside it), or over fs-sync's own last snapshot, which goes to
    replaced/ first (the plan made it a replacing step only if the file's hash is that snapshot row's, and the move
    aside checks it again)."""
    folders, name = _split(raw)
    tmp = M.temp_name(report.run_id, k)
    entry, sha = _snapshot_to_temp(root_fd, ws, step, raw, tmp)
    _hook(hooks, "after_read", step)
    held = None
    if step.replaces:
        try:
            held = _move_aside(root_fd, raw, loc, hold, M.REPLACED, step, hooks)
        except _Skip:
            _unlink(root_fd, folders, tmp)
            raise
    # (from here on the local file may be held: every outcome says where)
    try:
        d = M.open_dir(root_fd, folders)
        try:
            _hook(hooks, "before_install", step)
            M.rename_noreplace(d, tmp, d, name)
        finally:
            os.close(d)
    except M.Occupied:
        _unlink(root_fd, folders, tmp)
        return Outcome(step, SKIPPED, CHANGED_HERE, held=held)
    except M.NoReplace as e:
        _unlink(root_fd, folders, tmp)
        return Outcome(step, SKIPPED, LOCAL_ERROR, e.reason, held=held)
    except OSError as e:
        _unlink(root_fd, folders, tmp)
        return Outcome(step, SKIPPED, LOCAL_ERROR, H.strerror(e), held=held)
    return Outcome(step, DONE, held=held, row=_row(root_fd, raw, sha, entry.fid, True, entry.revision))


def _conflict(step, k, loc, raw, listing, root_fd, ws, hold, report, computer, hooks):
    """§2.3: the local file renamed to its conflict name (no replace, the same folder), that copy uploaded as a new
    file (create-only), then the workspace's version downloaded to the path, now free."""
    folders, name = _split(raw)
    copy_name = step.copy.rsplit("/", 1)[-1]
    copy_raw = "/".join(folders + [copy_name])
    for _ in _read_local(root_fd, raw, loc.size, step.local):
        pass                                            # (checked before anything changes: still the planned file)
    try:
        d = M.open_dir(root_fd, folders)
    except OSError:
        raise _Skip(SKIPPED, CHANGED_HERE)
    try:
        try:
            M.rename_noreplace(d, name, d, copy_name)
        except (M.Occupied, FileNotFoundError):
            raise _Skip(SKIPPED, CHANGED_HERE)
        try:
            ent = _ws(ws.write, step.copy, _read_local(root_fd, copy_raw, loc.size, step.local), None, step.local,
                      loc.size)
        except Exception as e:
            # (not uploaded: the rename undone, without replacing; if it can't be (a newcomer took the name
            # meanwhile), the report names the copy, but only if it is there: it may have gone meanwhile too)
            try:
                M.rename_noreplace(d, copy_name, d, name)
            except Exception:
                try:
                    os.stat(copy_name, dir_fd=d, follow_symlinks=False)
                    e.renamed = step.copy
                except OSError:
                    pass
            raise
    finally:
        os.close(d)
    copy_row = _row(root_fd, copy_raw, step.local, ent.fid)
    size = listing[step.path].size
    tmp = M.temp_name(report.run_id, k)
    try:
        _download_to_temp(root_fd, ws, step, raw, size, tmp, hooks)
        M.install(root_fd, raw, tmp, computer, hooks=_step_hooks(hooks, step))
    except M.InstalledBeside as b:
        return Outcome(step, SKIPPED, BESIDE, beside=b.rel, row=None, copy_row=copy_row)
    except M.Occupied as e:
        return Outcome(step, PENDING, NO_CONFLICT_NAME, _names(e.tried), copy_row=copy_row)
    except _Skip as s:
        out = Outcome(step, **s.out)
        out.copy_row = copy_row
        return out
    return Outcome(step, DONE, row=_row(root_fd, raw, step.remote, step.fid), copy_row=copy_row)


def _step_hooks(hooks, step):
    if not hooks:
        return None
    return {name: (lambda rel, f=f: f(step)) for name, f in hooks.items()
            if name in ("after_move_aside", "before_install")}


# ---- the report

def _names(tried):
    """The first and last conflict paths install tried, as the line quotes them."""
    return "\"%s\" to \"%s\"" % (tried[0], tried[-1])


def _files(n):
    return "1 file" if n == 1 else "%s files" % format(n, ",")


def render(report):
    """The report's lines (§1.2; board's texts, word for word)."""
    lines = list(report.run_lines)
    done = report.of(DONE)

    def section(head, kind, mark, extra=None):
        steps = [o for o in done if o.step.kind == kind]
        if steps:
            lines.append(head % _files(len(steps)) if extra is None else head % (_files(len(steps)), extra))
            for o in steps:
                lines.append("  %s %s" % (mark(o) if callable(mark) else mark, _done_text(o)))
    section("Upload (%s)", P.UPLOAD, lambda o: "~" if o.step.base is not None else "+")
    section("Download (%s)", P.DOWNLOAD, lambda o: "~" if o.step.replaces else "+")
    section("Delete in the workspace, to its Trash (%s)", P.DELETE_THERE, "-")
    section("Delete on this computer, to the holding folder (%s; restore with fs-sync --restore %s for 30 days)",
            P.DELETE_HERE, "-", report.run_id)
    section("Conflicts, both kept (%s)", P.CONFLICT, "!")
    section("Download only: notebooks, boards and chats as files (%s)", P.SNAPSHOT, "↓")
    for where, need, free, paths in report.space:
        lines.append("Not applied: not enough free space on %s (needs %s, %s free)" % (where, _size(need), _size(free)))
        lines += ["  · %s" % path for path in paths]
    pending = [o for o in report.outcomes
               if (o.result == PENDING and o.why in (NO_REPLACE, HOLD_ERROR, NO_CONFLICT_NAME, TOO_LARGE))
               or (o.result == NOT_TRIED and o.renamed)]
    if pending:
        lines.append("Not applied (%d)" % len(pending))
        lines += ["  · %s   %s" % (o.step.path, _pending_text(o)) for o in pending]
    skipped = report.of(SKIPPED)
    if skipped:
        lines.append("Skipped (%d)" % len(skipped))
        lines += ["  · %s   %s" % (o.step.path, _skipped_text(o)) for o in skipped]
    # (when any action wasn't done, §1.5)
    if any(o.result != DONE for o in report.outcomes):
        lines.append("Run it again to sync the rest.")
    return lines


def _kept(held):
    return "this computer's previous copy is kept for 30 days in %s" % held


def _done_text(o):
    if o.step.kind in (P.DOWNLOAD, P.SNAPSHOT) and o.held:
        return "%s   replaced; %s" % (o.step.path, _kept(o.held))
    return o.step.path


def _also(o, text):
    """`text` with what else the person must know, each after "; ": where a held file is kept, where a conflict's
    renamed copy is."""
    parts = [text] if text else []
    if o.held:
        parts.append(_kept(o.held))
    if o.renamed:
        parts.append("this computer's copy is now \"%s\" here and isn't in the workspace yet" % o.renamed)
    return "; ".join(parts)


def _pending_text(o):
    if o.result == NOT_TRIED:
        return _also(o, None)                           # (the run stopped: only where the copy is)
    if o.why == NO_REPLACE:
        text = ("not moved to the holding folder: this computer can't rename a file there without risking replacing "
                "another")
    elif o.why == HOLD_ERROR:
        text = "not moved to the holding folder: %s" % o.detail
    elif o.why == NO_CONFLICT_NAME:
        text = ("all %d conflict names for it are taken (%s); rename or remove some, then run it again" %
                (M.MAX_CONFLICT_TRIES, o.detail))
    else:
        text = "the workspace refused it as too large"  # (413)
    return _also(o, text)


def _skipped_text(o):
    if o.why == BESIDE:
        text = ("a file appeared there during the sync; the workspace's version is saved beside it as \"%s\"" %
                o.beside)
    elif o.why == CHANGED_THERE:
        text = "changed in the workspace during the sync"
    elif o.why == LOCAL_ERROR:
        text = "an error on this computer: %s" % o.detail
    else:
        text = "changed here during the sync"
    return _also(o, text)
