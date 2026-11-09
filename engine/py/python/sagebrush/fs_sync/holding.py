"""fs-sync's holding folder: its bounds, admission and cleanup (design/fs-sync.md §2.4). The moves themselves are in
move.py; this decides whether a run may move anything there, and removes old runs.

- **Run ids:** the run's start in UTC, `YYYYMMDD-HHMMSS`, its folder `trash/<run id>/` made exclusively (one mkdir),
  so two runs, of any pairs, never share one; a second in the same second gets `-2` … `-9`.
- **Bounds, in entries** (files and folders alike): at most 20 GiB and 200,000 entries in the holding folder in all,
  and 10 GiB and 100,000 entries from one run. Every bound is a constant here, so tests can lower it.
- **Counting** (`usage`): a streaming depth-first walk of trash/, a fresh handle and its listing per level (so at most
  2 x HOLD_LEVELS open), no link followed, every entry counted. HOLD_LEVELS = 66 is the handle-level form of the
  product bound: trash/, the run folder, and its mirror of at most the scan's 64 LOCAL_DIR folders. A walk that can't
  finish within the bounds (too many entries, too deep, an entry not ours, or any error) raises Uncountable: never a
  partial total.
- **Admission** (before applying): the run's entries (each file it would move there, deletes here and files a download
  replaces, at their planned sizes, and each distinct folder it would make for them) must fit the run's bound and,
  with what is held already, the total. If they don't, or the holding folder can't be counted, all of those actions
  stay pending (`Admission.reason` says why); the run's other actions go ahead.
- **One run at a time** (@sagebrush): a non-blocking flock on trash/. `reserve` holds it from admission until the
  run's last move aside, so runs of different pairs can't each pass against the same total; `cleanup` holds it while
  it removes. If another run holds it, this run's moves aside stay pending ("busy"), or its cleanup is skipped.
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
from .scan import MAX_DEPTH

TOTAL_BYTES = 20 * 2**30
TOTAL_ENTRIES = 200_000
RUN_BYTES = 10 * 2**30
RUN_ENTRIES = 100_000
KEEP_SECONDS = 30 * 86400
MAX_SAME_SECOND = 9                 # run ids tried within one second (the first, then -2 … -9)
HOLD_LEVELS = 2 + MAX_DEPTH         # handle levels: trash/, the run folder, then at most the scan's 64 folders
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


def usage(state_dir):
    """(bytes, entries) held in all: every entry under trash/, folders included, files at their lstat size, by a
    streaming depth-first walk with no link followed (see the module docstring). Raises Uncountable if the walk can't
    finish within TOTAL_ENTRIES and HOLD_LEVELS, meets an entry not ours, or fails part way."""
    total, entries = 0, 0
    trash = _trash(state_dir)
    stack = []
    try:
        fd = os.open(".", _DIR_FLAGS, dir_fd=trash)            # (a fresh handle: one held long can list as empty)
        try:
            listing = os.scandir(fd)
        except BaseException:
            os.close(fd)
            raise
        stack.append((fd, listing))
        while stack:
            fd, it = stack[-1]
            e = next(it, None)
            if e is None:
                it.close()
                os.close(fd)
                stack.pop()
                continue
            st = e.stat(follow_symlinks=False)
            entries += 1
            if entries > TOTAL_ENTRIES:
                raise Uncountable("more than %s entries" % format(TOTAL_ENTRIES, ","), bound=True)
            if st.st_uid != os.getuid():
                raise Uncountable("an entry that isn't yours: %s" % e.name)
            if stat.S_ISDIR(st.st_mode):
                if len(stack) >= HOLD_LEVELS:
                    raise Uncountable("more than %d levels of folders" % (HOLD_LEVELS - 2), bound=True)
                sub = os.open(e.name, _DIR_FLAGS, dir_fd=fd)
                try:
                    listing = os.scandir(sub)
                except BaseException:
                    os.close(sub)                          # (not on the stack yet: closed here)
                    raise
                stack.append((sub, listing))
            else:
                total += st.st_size
    except OSError as e:
        raise Uncountable(str(e))
    finally:
        for fd, it in stack:
            it.close()
            os.close(fd)
        os.close(trash)
    return total, entries


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
    entries: int = 0                # its files and the folders it would make for them
    held_bytes: int = 0             # what is held already
    held_entries: int = 0


def admit(state_dir, moves):
    """Whether a run may move these files into the holding folder (`moves`: (relative path, planned size) pairs):
    all of them, or none (§2.4)."""
    moves = list(moves)
    run_bytes, entries = sum(size for _, size in moves), run_entries([rel for rel, _ in moves])
    a = dict(bytes=run_bytes, entries=entries)
    try:
        held_bytes, held_entries = usage(state_dir)
    except Uncountable as e:
        return Admission(False, "total-entries" if e.bound else "holding-unreadable", detail=e.detail, **a)
    a.update(held_bytes=held_bytes, held_entries=held_entries)
    for reason, over in (("run-entries", entries > RUN_ENTRIES), ("run-bytes", run_bytes > RUN_BYTES),
                         ("total-entries", held_entries + entries > TOTAL_ENTRIES),
                         ("total-bytes", held_bytes + run_bytes > TOTAL_BYTES)):
        if over:
            return Admission(False, reason, **a)
    return Admission(True, **a)


def not_applied(admission, local, trash):
    """board's words (design §2.4) for an admission refused because another run holds the lock, or because the
    holding folder couldn't be measured; `local` and `trash` as shown to the person (~/thesis,
    ~/.local/state/sagebrush/fs-sync/trash). None for the other reasons, which the apply step words."""
    if admission.reason == "busy":
        return ("Not applied: deleting or replacing files in %s, while another fs-sync moves files into the holding "
                "folder. Run it again when that one finishes." % local)
    if admission.reason == "total-entries" and admission.detail:
        return ("Not applied: deleting or replacing files in %s. fs-sync's holding folder (%s) has more than %s "
                "entries or %d levels of folders, too many to measure. Each sync's folder there is removed 30 days "
                "after that sync." % (local, trash, format(TOTAL_ENTRIES, ","), HOLD_LEVELS - 2))
    if admission.reason == "holding-unreadable":
        return ("Not applied: deleting or replacing files in %s. fs-sync couldn't measure its holding folder (%s): "
                "%s." % (local, trash, admission.detail))
    return None


def _lock(state_dir):
    """trash/'s handle, flocked without waiting; None if another run holds it."""
    trash = _trash(state_dir)
    try:
        fcntl.flock(trash, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as e:
        os.close(trash)
        if e.errno in (errno.EWOULDBLOCK, errno.EAGAIN, errno.EACCES):
            return None
        raise
    return trash


def _unlock(fd):
    fcntl.flock(fd, fcntl.LOCK_UN)
    os.close(fd)


class Reservation:
    """The holding folder's lock for this run, and the admission made under it. While it is held and
    `admission.ok`, the run may move files aside; `release()` after its last move aside (or at exit)."""

    def __init__(self, fd, admission):
        self.fd, self.admission = fd, admission

    def release(self):
        if self.fd is not None:
            _unlock(self.fd)
            self.fd = None


def reserve(state_dir, moves):
    """Take the holding folder's lock without waiting, then admit `moves` under it (§2.4). The lock is kept only if
    they are admitted; otherwise, or if another run holds it ("busy"), all of this run's moves aside stay pending."""
    moves = list(moves)
    lock = _lock(state_dir)
    if lock is None:
        return Reservation(None, Admission(False, "busy", bytes=sum(s for _, s in moves),
                                           entries=run_entries([r for r, _ in moves])))
    try:
        a = admit(state_dir, moves)
    except BaseException:
        _unlock(lock)
        raise
    if not a.ok:
        _unlock(lock)
        return Reservation(None, a)
    return Reservation(lock, a)


def cleanup(state_dir, now=None):
    """Remove the runs whose id is more than 30 days old, oldest first; returns their ids. Under the holding folder's
    lock (skipped, returning [], if another run holds it), and only after the whole folder has been counted within its
    bounds: if it can't be, nothing is removed. Nothing younger, and nothing whose name isn't a run id, is removed."""
    if not shutil.rmtree.avoids_symlink_attacks:
        return []                                       # (never a removal that could follow a link)
    lock = _lock(state_dir)
    if lock is None:
        return []
    try:
        try:
            usage(state_dir)                            # (the whole tree first: the removals below are within it)
        except Uncountable:
            return []
        now = time.time() if now is None else now
        old = []
        fresh = os.open(".", _DIR_FLAGS, dir_fd=lock)
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
            st = os.stat(name, dir_fd=lock, follow_symlinks=False)
            if not stat.S_ISDIR(st.st_mode):
                continue                                # (a link with a run id's name: left, and counted)
            shutil.rmtree(name, dir_fd=lock)
            removed.append(name)
        return removed
    finally:
        _unlock(lock)
