"""fs-sync's holding folder: its bounds, admission and cleanup (design/fs-sync.md §2.4). The moves themselves are in
move.py; this decides whether a run may move anything there, and removes old runs.

- **Run ids:** the run's start in UTC, `YYYYMMDD-HHMMSS`, its folder `trash/<run id>/` made exclusively (one mkdir),
  so two runs, of any pairs, never share one; a second in the same second gets `-2` … `-9`.
- **Bounds:** at most 20 GiB and 200,000 files in the holding folder in all, and 10 GiB and 100,000 files from one
  run. Every bound is a constant here, so tests can lower it.
- **Admission** (before applying): the bytes and files the run would move there (deletes here, and files a download
  replaces, at their planned sizes) must fit both bounds, with what is held already, measured after cleanup. If they
  don't, all of those actions stay pending (`Admission.reason` says which bound); the run's other actions go ahead.
- **One run at a time moves files aside** (@sagebrush): `reserve` takes a non-blocking flock on trash/ for admission
  and holds it until the run's last move aside, so runs of different pairs can't each pass against the same total and
  overshoot the bound together. If another run holds it, this run's moves aside stay pending (reason "busy").
- **Cleanup** (at the start of every run): runs whose id is more than 30 days old are removed, oldest first, each by
  handle with no link followed. Nothing younger is ever removed to make room, and a folder whose name isn't a run id
  is never removed (it still counts toward the bounds)."""

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

TOTAL_BYTES = 20 * 2**30
TOTAL_FILES = 200_000
RUN_BYTES = 10 * 2**30
RUN_FILES = 100_000
KEEP_SECONDS = 30 * 86400
MAX_SAME_SECOND = 9                 # run ids tried within one second (the first, then -2 … -9)
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


def _names(dir_fd):
    # (listed through a fresh handle, as in move.restore)
    fresh = os.open(".", _DIR_FLAGS, dir_fd=dir_fd)
    try:
        return sorted(os.listdir(fresh))
    finally:
        os.close(fresh)


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


def usage(state_dir, stop_files=TOTAL_FILES + 1):
    """(bytes, files) held in all: every non-folder entry under trash/, its size from lstat, walked by handle with no
    link followed. Counting stops once `stop_files` entries are seen (past the bound, the exact total doesn't matter)."""
    total, files = 0, 0
    trash = _trash(state_dir)
    stack = [trash]
    try:
        while stack and files < stop_files:
            d = stack.pop()
            try:
                for name in _names(d):
                    st = os.stat(name, dir_fd=d, follow_symlinks=False)
                    if stat.S_ISDIR(st.st_mode):
                        stack.append(os.open(name, _DIR_FLAGS, dir_fd=d))
                    else:
                        total += st.st_size
                        files += 1
                        if files >= stop_files:
                            break
            finally:
                os.close(d)
    finally:
        for d in stack:
            os.close(d)
    return total, files


@dataclass(frozen=True)
class Admission:
    ok: bool
    reason: str = None              # "run-bytes", "run-files", "total-bytes", "total-files" or "busy" when not ok
    bytes: int = 0                  # what the run would move there
    files: int = 0
    held_bytes: int = 0             # what is held already
    held_files: int = 0


def admit(state_dir, sizes):
    """Whether a run may move files of these planned `sizes` into the holding folder: all of them, or none (§2.4)."""
    run_bytes, run_files = sum(sizes), len(sizes)
    held_bytes, held_files = usage(state_dir)
    a = dict(bytes=run_bytes, files=run_files, held_bytes=held_bytes, held_files=held_files)
    for reason, over in (("run-files", run_files > RUN_FILES), ("run-bytes", run_bytes > RUN_BYTES),
                         ("total-files", held_files + run_files > TOTAL_FILES),
                         ("total-bytes", held_bytes + run_bytes > TOTAL_BYTES)):
        if over:
            return Admission(False, reason, **a)
    return Admission(True, **a)


class Reservation:
    """The holding folder's lock for this run (an flock on trash/), and the admission made under it. While it is held
    and `admission.ok`, the run may move files aside; `release()` after its last move aside (or at exit)."""

    def __init__(self, fd, admission):
        self.fd, self.admission = fd, admission

    def release(self):
        if self.fd is not None:
            fcntl.flock(self.fd, fcntl.LOCK_UN)
            os.close(self.fd)
            self.fd = None


def reserve(state_dir, sizes):
    """Take the holding folder's lock without waiting, then admit `sizes` under it (§2.4). The lock is kept only if
    they are admitted; otherwise, or if another run holds it ("busy"), all of this run's moves aside stay pending."""
    trash = _trash(state_dir)
    try:
        fcntl.flock(trash, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as e:
        os.close(trash)
        if e.errno in (errno.EWOULDBLOCK, errno.EAGAIN, errno.EACCES):
            return Reservation(None, Admission(False, "busy", bytes=sum(sizes), files=len(sizes)))
        raise
    try:
        a = admit(state_dir, sizes)
    except BaseException:
        fcntl.flock(trash, fcntl.LOCK_UN)
        os.close(trash)
        raise
    if not a.ok:
        fcntl.flock(trash, fcntl.LOCK_UN)
        os.close(trash)
        return Reservation(None, a)
    return Reservation(trash, a)


def cleanup(state_dir, now=None):
    """Remove the runs whose id is more than 30 days old, oldest first, each folder by handle with no link followed.
    Returns their ids. Nothing younger, and nothing whose name isn't a run id, is removed."""
    if not shutil.rmtree.avoids_symlink_attacks:
        return []                                       # (never a removal that could follow a link)
    now = time.time() if now is None else now
    trash = _trash(state_dir)
    try:
        old = sorted((t, name) for name in _names(trash)
                     for t in [run_time(name)] if t is not None and now - t > KEEP_SECONDS)
        removed = []
        for _, name in old:
            st = os.stat(name, dir_fd=trash, follow_symlinks=False)
            if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid():
                continue                                # (not a run folder of ours: left, and counted)
            shutil.rmtree(name, dir_fd=trash)
            removed.append(name)
        return removed
    finally:
        os.close(trash)
