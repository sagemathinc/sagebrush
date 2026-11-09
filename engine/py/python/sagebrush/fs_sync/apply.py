"""fs-sync's apply step for data files (design/fs-sync.md §1.2, §2.3–2.5, §4.1, §4.3): a plan, made from a scan and a
listing, applied action by action, each checking first that what it was planned from still holds. Documents'
snapshots (§3.4) are a later step: their actions are listed as not applied here.

- **Inputs:** the plan, and the scan (`ScanResult`) and workspace listing ({path: Entry}) it was made from: sizes, the
  local spelling on disk and the stat key come from them, so every check is against the planned state. The workspace
  is the `Workspace` interface (workspace.py); the base is the pair's `state.Base`.
- **The holding folder, in daybreak3's order:** one `holding.Session` for the run, taken without waiting; its cleanup
  first, every run; then, only if the run moves files aside (deletes here, and downloads that replace a file), its
  run folder, its journal (`runs/<run id>.json`: LOCAL_DIR and WORKSPACE_PATH, for `--restore`) and its admission;
  the moves in plan order under it; and the session released after the last move aside (and in any case at the end).
  If the session is busy, the holding folder is on another filesystem, no run id is left this second, or admission
  refuses, every such action stays pending and the rest of the plan goes ahead. A run folder that took nothing is
  removed, under the lock.
- **Every action checks first** (§4.1): an upload hashes the local file as it sends it, and a mismatch fails the
  write before it commits; a download is read into a temporary file and checked (the entry's kind, fid and hash, and
  the bytes' count and hash) before anything here changes; a delete here asks the workspace that nothing is at the
  path, then moves the file aside and checks it there. A check that fails skips the action, and the next run plans
  again.
- **The base** (§2.5): a delete (either side) or a replacing download is bracketed: its row removed and committed
  first, the new row (or none) committed after, the old row put back if it was skipped or not applied. Other actions
  are recorded in batches.
- **Workspace errors** (the endpoint's): 409 skips the action; 413 leaves it pending; 429, 401 and a network error
  stop the run at once, the actions not yet tried left as they are.
- **Downloads need room** (§1.2, §4.5): LOCAL_DIR's filesystem keeps 256 MiB free beyond the downloads; those that
  don't fit, in plan order, stay pending.
- **Seams** (§5): `hooks[name](step)` at "before_check", "after_tmp_written" and "after_action", and
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
from .state import Row, _home_short
from .workspace import Base as WBase, Conflict, RateLimited, TooLarge, Unauthorized

_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
_CLOEXEC = getattr(os, "O_CLOEXEC", 0)
CHUNK = 2**20
DOWNLOAD_HEADROOM = 256 * 2**20     # LOCAL_DIR's filesystem keeps this free beyond the downloads (§1.2)
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
SNAPSHOTS_LATER = "snapshots-later"
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


@dataclass
class Report:
    run_id: str
    local: str                      # LOCAL_DIR and the holding folder, as shown (~/thesis)
    trash: str
    outcomes: list = field(default_factory=list)
    run_lines: list = field(default_factory=list)   # run-level "Not applied: …" sentences, in order, each once
    space: tuple = None             # downloads over the free space: (mount point, needed, free)
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
    return step.kind == P.DELETE_HERE or (step.kind == P.DOWNLOAD and step.replaces)


def _part(step):
    return M.DELETED if step.kind == P.DELETE_HERE else M.REPLACED


def _destructive(step):
    return step.kind in (P.DELETE_HERE, P.DELETE_THERE) or (step.kind == P.DOWNLOAD and step.replaces)


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


def _strerror(e):
    return e.strerror or str(e.__class__.__name__)


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
        st = os.fstat(fd)
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


def _row(root_fd, raw, sha256, fid, snapshot=False):
    """The base row for the local file `raw` now: its stat key, the hash it was checked to have, and its fid."""
    folders, name = _split(raw)
    d = M.open_dir(root_fd, folders)
    try:
        st = os.stat(name, dir_fd=d, follow_symlinks=False)
    finally:
        os.close(d)
    return Row(sha256, st.st_size, st.st_mtime_ns, st.st_ctime_ns, st.st_ino, st.st_dev, fid, snapshot)


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


def _download_to_temp(root_fd, ws, step, raw, size, tmp, hooks):
    """The workspace's file at step.path read into the temporary file `tmp` in its folder (`raw`'s, made as needed)
    and checked against the plan: the entry's kind, fid and hash, and the bytes' count and hash. A temp that fails is
    removed."""
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
            entry, n = _ws(ws.read, step.path, writer, size + 1)
            if ((entry.kind, entry.fid, entry.sha256) != (step.rkind or "file", step.fid, step.remote) or n != size
                    or h.hexdigest() != step.remote):
                raise _Skip(SKIPPED, CHANGED_THERE)
            os.fsync(fd)
            ok = True
        finally:
            os.close(fd)
            if not ok:
                try:
                    os.unlink(tmp, dir_fd=d)
                except OSError:
                    pass
    finally:
        os.close(d)
    _hook(hooks, "after_tmp_written", step)


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
        _drop_journals(self.state_dir, now)

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
            a = self.session.admit(moves)
            r.admission = a
            if not a.ok:
                self.session.abandon(h)
                r.run_line(_admission_line(a, r.local, r.trash))
                return
            _journal(self.state_dir, h.run_id, self.local_dir, self.workspace_path)
        except OSError as e:
            self.session.abandon(h)
            r.run_line(self._refusal(e, r.trash + "/" + h.run_id))
            return
        self.holding = h
        r.run_id = h.run_id

    def _refusal(self, e, path):
        r = self.report
        if _not_yours(e):
            return _not_yours_line(r.local, path)
        return "%s %s (%s)" % (_held_back(r.local), _strerror(e), path)

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
            raise _Skip(PENDING, HOLD_ERROR, "%s (%s)" % (_strerror(e), where))

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
                    self.session.abandon(self.holding)
                    _drop_journal(self.state_dir, self.holding.run_id)
                except OSError:
                    pass
                self.holding.close()
        finally:
            self.session.close()
            self.session = None


def _runs_dir(state_dir):
    top = os.open(state_dir, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | _NOFOLLOW | _CLOEXEC)
    try:
        return M.own_dirs(top, ["runs"])
    finally:
        os.close(top)


def _journal(state_dir, run_id, local_dir, workspace_path):
    """The run's journal (§4.3), `runs/<run id>.json`: what --restore needs to put this run's files back, written
    before the first move aside. --restore refuses a run without one."""
    d = _runs_dir(state_dir)
    try:
        fd = os.open(run_id + ".json", os.O_WRONLY | os.O_CREAT | os.O_EXCL | _NOFOLLOW | _CLOEXEC, 0o600, dir_fd=d)
        try:
            data = json.dumps({"run": run_id, "local_dir": local_dir, "workspace_path": workspace_path}).encode()
            while data:
                data = data[os.write(fd, data):]
            os.fsync(fd)
        finally:
            os.close(fd)
        os.fsync(d)
    finally:
        os.close(d)


def _drop_journal(state_dir, run_id):
    d = _runs_dir(state_dir)
    try:
        os.unlink(run_id + ".json", dir_fd=d)
    except FileNotFoundError:
        pass
    finally:
        os.close(d)


def _drop_journals(state_dir, now):
    """The journals of runs more than 30 days old (their folders are cleanup's)."""
    try:
        d = _runs_dir(state_dir)
    except OSError:
        return
    try:
        for name in os.listdir(d):
            t = H.run_time(name[:-5]) if name.endswith(".json") else None
            if t is not None and now - t > H.KEEP_SECONDS:
                try:
                    os.unlink(name, dir_fd=d)
                except OSError:
                    pass
    finally:
        os.close(d)


# ---- the apply loop

def apply(plan, scan, listing, root_fd, ws, base, state_dir, local_dir, workspace_path, computer, now=None,
          hooks=None, free_bytes=None):
    """Apply `plan` (see the module docstring). `free_bytes`: LOCAL_DIR's filesystem's free space (tests); measured if
    None. Returns the Report; a refused action never raises."""
    now = time.time() if now is None else now
    report = Report(run_id=H.run_id_at(now), local=_home_short(local_dir),
                    trash=_home_short(os.path.join(state_dir, "trash")))
    steps = [s for s in plan.steps if s.kind in P.ACTIONS]
    no_room = _over_space(steps, listing, root_fd, local_dir, report, free_bytes)
    aside = [s for s in steps if _moves_aside(s) and id(s) not in no_room]
    hold = _Hold(report, state_dir, local_dir, workspace_path)
    try:
        hold.open(now)
        if aside:
            hold.begin(root_fd, [(_part(s) + "/" + (scan.files[s.path].raw or s.path), scan.files[s.path].size)
                                for s in aside], now)
        last = aside[-1] if aside and hold.ok else None
        M.sweep_temps(root_fd, scan.temps, report.run_id)
        for k, step in enumerate(steps):
            if step.kind == P.SNAPSHOT:
                out = Outcome(step, PENDING, SNAPSHOTS_LATER)
            elif id(step) in no_room:
                out = Outcome(step, PENDING, "no-room")
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


def _over_space(steps, listing, root_fd, local_dir, report, free_bytes):
    """The downloads that don't fit LOCAL_DIR's filesystem with 256 MiB to spare, in plan order (ids of the steps)."""
    downs = [s for s in steps if s.kind in (P.DOWNLOAD, P.CONFLICT)]
    if not downs:
        return set()
    if free_bytes is None:
        st = os.fstatvfs(root_fd)
        free_bytes = st.f_bavail * st.f_frsize
    used, out = 0, set()
    for s in downs:
        n = listing[s.path].size
        if used + n + DOWNLOAD_HEADROOM <= free_bytes:
            used += n
        else:
            out.add(id(s))
    if out:
        need = sum(listing[s.path].size for s in downs) + DOWNLOAD_HEADROOM
        report.space = (_mount_point(local_dir), need, free_bytes)
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
    except _Skip as s:
        out = Outcome(step, **s.out)
    except Conflict:
        out = Outcome(step, SKIPPED, CHANGED_THERE)
    except TooLarge:
        out = Outcome(step, PENDING, TOO_LARGE)
    except RateLimited as e:
        report.stopped, report.retry_after = "rate-limited", e.retry_after
        out = Outcome(step, NOT_TRIED, report.stopped)
    except Unauthorized:
        report.stopped = "unauthorized"
        out = Outcome(step, NOT_TRIED, report.stopped)
    except M.NoReplace as e:
        if e.reason == "it is on another filesystem":
            report.run_line(_other_disk_line(hold.local_dir, hold.state_dir))
            out = Outcome(step, PENDING, HELD_BACK)
        else:
            out = Outcome(step, PENDING, NO_REPLACE)
    except _Local as e:
        out = Outcome(step, SKIPPED, LOCAL_ERROR, _strerror(e.e))
    except OSError as e:
        if getattr(e, "_local", True) and not isinstance(e, ConnectionError):
            out = Outcome(step, SKIPPED, LOCAL_ERROR, _strerror(e))
        else:
            report.stopped = "network"
            out = Outcome(step, NOT_TRIED, report.stopped)
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
        raise _Skip(PENDING, HOLD_ERROR, _strerror(e))
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
        ent = _ws(ws.write, step.path, _read_local(root_fd, raw, loc.size, step.local), wbase)
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
    try:
        M.install(root_fd, raw, tmp, computer, hooks=_step_hooks(hooks, step))
    except M.InstalledBeside as b:
        # (a newcomer took the name: ours is beside it; the path isn't recorded, so the next run plans it)
        return Outcome(step, SKIPPED, BESIDE, beside=b.rel, held=held)
    except M.Occupied as e:
        # (the temp stays: the next run sweeps it)
        return Outcome(step, PENDING, NO_CONFLICT_NAME, _names(e.tried), held=held)
    return Outcome(step, DONE, held=held, row=_row(root_fd, raw, step.remote, step.fid, snapshot))


def _conflict(step, k, loc, raw, listing, root_fd, ws, hold, report, computer, hooks):
    """§2.3: the local file renamed to its conflict name (no replace, the same folder), that copy uploaded as a new
    file (create-only), then the workspace's version downloaded to the path, now free."""
    folders, name = _split(raw)
    copy_name = step.copy.rsplit("/", 1)[-1]
    copy_raw = "/".join(folders + [copy_name])
    try:
        d = M.open_dir(root_fd, folders)
    except OSError:
        raise _Skip(SKIPPED, CHANGED_HERE)
    try:
        try:
            M.rename_noreplace(d, name, d, copy_name)
        except (M.Occupied, FileNotFoundError):
            raise _Skip(SKIPPED, CHANGED_HERE)
    finally:
        os.close(d)
    ent = _ws(ws.write, step.copy, _read_local(root_fd, copy_raw, loc.size, step.local), None)
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
    if report.space:
        where, need, free = report.space
        rows = report.of(PENDING, "no-room")
        lines.append("Not applied: not enough free space on %s (needs %s, %s free)" % (where, _size(need), _size(free)))
        lines += ["  · %s" % o.step.path for o in rows]
    pending = [o for o in report.of(PENDING) if o.why in (NO_REPLACE, HOLD_ERROR, NO_CONFLICT_NAME, TOO_LARGE)]
    if pending:
        lines.append("Not applied (%d)" % len(pending))
        lines += ["  · %s   %s" % (o.step.path, _pending_text(o)) for o in pending]
    skipped = report.of(SKIPPED)
    if skipped:
        lines.append("Skipped (%d)" % len(skipped))
        lines += ["  · %s   %s" % (o.step.path, _skipped_text(o)) for o in skipped]
    if any(o.result != DONE and o.why != SNAPSHOTS_LATER for o in report.outcomes):
        lines.append("Run it again to sync the rest.")
    return lines


def _kept(held):
    return "this computer's previous copy is kept for 30 days in %s" % held


def _done_text(o):
    if o.step.kind == P.DOWNLOAD and o.held:
        return "%s   replaced; %s" % (o.step.path, _kept(o.held))
    return o.step.path


def _pending_text(o):
    if o.why == NO_REPLACE:
        return ("not moved to the holding folder: this computer can't rename a file there without risking replacing "
                "another")
    if o.why == HOLD_ERROR:
        return "not moved to the holding folder: %s" % o.detail
    if o.why == NO_CONFLICT_NAME:
        text = ("all %d conflict names for it are taken (%s); rename or remove some, then run it again" %
                (M.MAX_CONFLICT_TRIES, o.detail))
        return text if not o.held else "%s; %s" % (text, _kept(o.held))
    return "the workspace refused it as too large"     # (413: wording pending from COPY)


def _skipped_text(o):
    if o.why == BESIDE:
        text = ("a file appeared there during the sync; the workspace's version is saved beside it as \"%s\"" %
                o.beside)
    elif o.why == CHANGED_THERE:
        text = "changed in the workspace during the sync"
    elif o.why == LOCAL_ERROR:
        text = o.detail                                 # (strerror only; wording pending from COPY)
    else:
        text = "changed here during the sync"
    return text if not o.held else "%s; %s" % (text, _kept(o.held))
