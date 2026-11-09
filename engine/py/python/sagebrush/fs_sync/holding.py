"""fs-sync's holding folder: its bounds, admission and cleanup (design/fs-sync.md §2.4). The moves themselves are in
move.py; this decides whether a run may move anything there, and removes old runs.

- **Run ids:** the run's start in UTC, `YYYYMMDD-HHMMSS`, its folder `trash/<run id>/` made exclusively (one mkdir),
  so two runs, of any pairs, never share one; a second in the same second gets `-2` … `-9`.
- **Bounds, in entries** (files and folders alike): at most 20 GiB and 200,000 entries in the holding folder in all,
  and 10 GiB and 100,000 entries from one run. Every bound is a constant here, so tests can lower it.
- **Counting** (`usage`): a streaming depth-first walk of trash/, a handle and its listing's copy per level, trash/'s
  own handle being the first (so at most 2 x HOLD_LEVELS open, exactly), no link followed, every entry counted. HOLD_LEVELS = 67 is the handle-level form of the
  product bound: trash/, the run folder, its part (deleted/ or replaced/), and its mirror of at most the scan's 64
  LOCAL_DIR folders. A walk that can't
  finish within the bounds (too many entries, too deep, an entry not ours, or any error) raises Uncountable: never a
  partial total.
- **Admission** (before applying): the run's entries (each file it would move there, deletes here and files a download
  replaces, at their planned sizes, and each distinct folder it would make for them) must fit the run's bound and,
  with what is held already, the total. If they don't, or the holding folder can't be counted, all of those actions
  stay pending (`Admission.reason` says why); the run's other actions go ahead.
- **One run at a time** (@sagebrush; the order is daybreak3's): a `Session` holds a non-blocking flock on trash/
  from the run's start until after its last move aside: cleanup first, then (only for a run that moves files aside)
  its run folder and its admission, so runs of different pairs can't each pass against the same total. If another
  run holds it, this run makes no folder, skips cleanup and keeps its moves aside pending ("busy").
- **Cleanup** (at the start of every run): first the whole holding folder is counted (as above), and only if that
  completes are the runs whose id is more than 30 days old removed, oldest first, with the standard library's
  link-safe `shutil.rmtree(..., dir_fd=...)` (and nothing on a platform where it isn't link-safe), so its work is
  within the counted 200,000 entries. Nothing younger is ever removed to make room, and a folder whose name isn't a
  run id is never removed (it still counts toward the bounds)."""

import calendar
import errno
import fcntl
import os
import re
import shutil
import stat
import time
from dataclasses import dataclass

from .move import _DIR_FLAGS, Holding, own_dirs
from .scan import MAX_DEPTH, _home_short

TOTAL_BYTES = 20 * 2**30
TOTAL_ENTRIES = 200_000
RUN_BYTES = 10 * 2**30
RUN_ENTRIES = 100_000
KEEP_SECONDS = 30 * 86400
MAX_SAME_SECOND = 9                 # run ids tried within one second (the first, then -2 … -9)
HOLD_LEVELS = 3 + MAX_DEPTH         # handle levels: trash/, the run folder, its part (deleted/ or replaced/),
#                                     then at most the scan's 64 folders
_ID = re.compile(r"([0-9]{8}-[0-9]{6})(?:-[2-9])?")     # (fullmatch only)


def run_id_at(t):
    """The run id for a run starting at `t` (seconds since the epoch), before any `-2` suffix."""
    return time.strftime("%Y%m%d-%H%M%S", time.gmtime(t))


def run_time(name):
    """The start (seconds since the epoch, UTC) a run id names, or None if `name` isn't a run id."""
    m = _ID.fullmatch(name)
    if not m:
        return None
    try:
        return calendar.timegm(time.strptime(m.group(1), "%Y%m%d-%H%M%S"))
    except ValueError:
        return None


def _trash(state_dir):
    top = os.open(state_dir, _DIR_FLAGS)
    try:
        return own_dirs(top, ["trash"])
    finally:
        os.close(top)


def new_run(state_dir, now=None):
    """A new run's Holding: its id the UTC time `now`, made unique by an exclusive mkdir (then `-2` … `-9`)."""
    base = run_id_at(time.time() if now is None else now)
    trash = _trash(state_dir)
    try:
        for n in range(1, MAX_SAME_SECOND + 1):
            rid = base if n == 1 else "%s-%d" % (base, n)
            try:
                os.mkdir(rid, 0o700, dir_fd=trash)
            except FileExistsError:
                continue
            return Holding(state_dir, rid)
        raise FileExistsError(errno.EEXIST, "no run id left this second", base)
    finally:
        os.close(trash)


class Uncountable(Exception):
    """The holding folder couldn't be counted: past a bound (`bound` True: too many entries, or too deep) or an error
    (an entry not ours, or any failure part way). `detail` says which, for the caller's message."""

    def __init__(self, detail, bound=False):
        super().__init__(detail)
        self.detail, self.bound = detail, bound


def strerror(e):
    """An OSError as a person reads it: its message, never "[Errno N]" or an internal name."""
    return e.strerror or (os.strerror(e.errno) if e.errno else "an unexpected error")


def usage(state_dir):
    """(bytes, entries) held in all: every entry under trash/, folders included, files at their lstat size, by a
    streaming depth-first walk with no link followed (see the module docstring). Raises Uncountable if the walk can't
    finish within TOTAL_ENTRIES and HOLD_LEVELS, meets an entry not ours, or fails part way."""
    total, entries = 0, 0
    names = []                                              # (the folders below trash/ down to the deepest level)
    where = os.path.join(state_dir, "trash")                # (what the walk is reading, for an error's message)
    try:
        trash = _trash(state_dir)                           # (level 1: a handle just opened, so it lists afresh)
    except OSError as e:
        raise Uncountable(_failed(e, where))
    try:
        listing = os.scandir(trash)
    except OSError as e:
        os.close(trash)
        raise Uncountable(_failed(e, where))
    except BaseException:
        os.close(trash)
        raise
    stack = [(trash, listing)]                              # (each level: its handle and its listing's copy)
    try:
        while stack:
            fd, it = stack[-1]
            where = os.path.join(state_dir, "trash", *names[:len(stack) - 1])
            e = next(it, None)
            if e is None:
                it.close()
                os.close(fd)
                stack.pop()
                del names[len(stack) - 1:]
                continue
            where = os.path.join(where, e.name)
            st = e.stat(follow_symlinks=False)
            entries += 1
            if entries > TOTAL_ENTRIES:
                raise Uncountable("more than %s entries" % format(TOTAL_ENTRIES, ","), bound=True)
            if st.st_uid != os.getuid():
                raise Uncountable("an entry that isn't yours: %s" % e.name)
            if stat.S_ISDIR(st.st_mode):
                if len(stack) >= HOLD_LEVELS:
                    raise Uncountable("more than %d levels of folders" % (HOLD_LEVELS - 3), bound=True)
                sub = os.open(e.name, _DIR_FLAGS, dir_fd=fd)
                try:
                    listing = os.scandir(sub)
                except BaseException:
                    os.close(sub)                          # (not on the stack yet: closed here)
                    raise
                stack.append((sub, listing))
                names.append(e.name)
            else:
                total += st.st_size
    except OSError as e:
        raise Uncountable(_failed(e, where))
    finally:
        for fd, it in stack:
            it.close()
            os.close(fd)
    return total, entries


def _failed(e, where):
    return "%s (%s)" % (strerror(e), _home_short(where))


def run_entries(rels):
    """The entries a run makes in its holding folder for these relative paths: each file, and each distinct folder on
    their way (the run folder itself already exists, made by new_run, and is counted as held)."""
    folders = set()
    for rel in rels:
        parts = rel.split("/")[:-1]
        for i in range(1, len(parts) + 1):
            folders.add("/".join(parts[:i]))
    return len(rels) + len(folders)


@dataclass(frozen=True)
class Admission:
    ok: bool
    reason: str = None              # "run-bytes", "run-entries", "total-bytes", "total-entries" (also when the held
    #                                 entries are past a bound, uncounted), "holding-unreadable" or "busy" when not ok
    detail: str = None              # what stopped the count, when it didn't finish
    bytes: int = 0                  # what the run would move there
    entries: int = 0                # its own: files, the folders it would make for them, and its run folder
    held_bytes: int = 0             # what is held already
    held_entries: int = 0


def admit(state_dir, moves):
    """Whether a run may move these files into the holding folder (`moves`: (relative path, planned size) pairs):
    all of them, or none (§2.4)."""
    moves = list(moves)
    run_bytes, new = sum(size for _, size in moves), run_entries([rel for rel, _ in moves])
    # (the run's own entries include its run folder, §2.4; it already exists, made by new_run, so the total counts it
    # among the held entries, and only the run's own count adds it)
    a = dict(bytes=run_bytes, entries=new + 1)
    try:
        held_bytes, held_entries = usage(state_dir)
    except Uncountable as e:
        return Admission(False, "total-entries" if e.bound else "holding-unreadable", detail=e.detail, **a)
    a.update(held_bytes=held_bytes, held_entries=held_entries)
    for reason, over in (("run-entries", new + 1 > RUN_ENTRIES), ("run-bytes", run_bytes > RUN_BYTES),
                         ("total-entries", held_entries + new > TOTAL_ENTRIES),
                         ("total-bytes", held_bytes + run_bytes > TOTAL_BYTES)):
        if over:
            return Admission(False, reason, **a)
    return Admission(True, **a)


def not_applied(admission, local, trash):
    """Design §2.4's words for an admission refused because another run holds the lock, or because the
    holding folder couldn't be measured; `local` and `trash` as shown to the person (~/thesis,
    ~/.local/state/sagebrush/fs-sync/trash). None for the other reasons, which the apply step words."""
    if admission.reason == "busy":
        return ("Not applied: deleting or replacing files in %s, while another fs-sync moves files into the holding "
                "folder. Run it again when that one finishes." % local)
    if admission.reason == "total-entries" and admission.detail:
        return ("Not applied: deleting or replacing files in %s. fs-sync's holding folder (%s) has more than %s "
                "entries or %d levels of folders, too many to measure. Each sync's folder there is removed 30 days "
                "after that sync." % (local, trash, format(TOTAL_ENTRIES, ","), HOLD_LEVELS - 3))
    if admission.reason == "holding-unreadable":
        return ("Not applied: deleting or replacing files in %s. fs-sync couldn't measure its holding folder (%s): "
                "%s." % (local, trash, admission.detail))
    return None


class Session:
    """One run's hold on the holding folder (daybreak3's order, design §2.4): trash/'s lock, taken once and without
    waiting, held from the run's start until after its last move aside. Under it, in this order:

    1. `cleanup()`, every run, first: before anything is added, so a holding folder at its bound can still be cleaned;
    2. only if the run moves files aside: `new_run()`, then `admit(moves)`;
    3. the moves aside, in plan order;
    4. `close()`, also on any error (the files moved stay held, to be restored).

    `Session.open` returns None if another run holds the lock: then this run makes no folder, cleans nothing, and
    moves nothing aside (its other actions go ahead). The helpers never take the lock themselves."""

    def __init__(self, state_dir, fd):
        self.state_dir, self.fd = state_dir, fd

    @classmethod
    def open(cls, state_dir):
        trash = _trash(state_dir)
        try:
            fcntl.flock(trash, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as e:
            os.close(trash)
            if e.errno in (errno.EWOULDBLOCK, errno.EAGAIN, errno.EACCES):
                return None
            raise
        return cls(state_dir, trash)

    def close(self):
        if self.fd is not None:
            fcntl.flock(self.fd, fcntl.LOCK_UN)
            os.close(self.fd)
            self.fd = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def cleanup(self, now=None):
        """Remove the runs whose id is more than 30 days old, oldest first; returns their ids. Only after the whole
        folder has been counted within its bounds: if it can't be, nothing is removed. Nothing younger, and nothing
        whose name isn't a run id, is removed."""
        if not shutil.rmtree.avoids_symlink_attacks:
            return []                                   # (never a removal that could follow a link)
        try:
            usage(self.state_dir)                       # (the whole tree first: the removals below are within it)
        except Uncountable:
            return []
        now = time.time() if now is None else now
        old = []
        fresh = os.open(".", _DIR_FLAGS, dir_fd=self.fd)
        try:
            with os.scandir(fresh) as it:               # (streamed; only expired run ids kept, within the count)
                for e in it:
                    t = run_time(e.name)
                    if t is not None and now - t > KEEP_SECONDS:
                        old.append((t, e.name))
        finally:
            os.close(fresh)
        removed = []
        for _, name in sorted(old):
            st = os.stat(name, dir_fd=self.fd, follow_symlinks=False)
            if not stat.S_ISDIR(st.st_mode):
                continue                                # (a link with a run id's name: left, and counted)
            shutil.rmtree(name, dir_fd=self.fd)
            removed.append(name)
        return removed

    def new_run(self, now=None):
        """This run's Holding (new_run), made under the lock."""
        return new_run(self.state_dir, now)

    def admit(self, moves):
        """Whether this run may move these files aside (admit), measured under the lock."""
        return admit(self.state_dir, moves)

    def abandon(self, holding):
        """A run refused admission, before any move: its run folder, still empty, is removed (and the handle closed)."""
        holding.close()
        try:
            os.rmdir(holding.run_id, dir_fd=self.fd)
        except FileNotFoundError:
            pass
