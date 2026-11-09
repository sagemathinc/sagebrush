"""fs-sync's moves on this computer (design/fs-sync.md §2.4, §4.1, §4.3, §4.4): the primitives the apply loop uses to
delete and replace local files without ever losing a byte. No CLI and no network here.

- **No-replace rename:** `renameat2(RENAME_NOREPLACE)` on Linux, `renameatx_np(RENAME_EXCL)` on macOS, between two
  open folder handles. A taken name is `Occupied`. A rename the filesystem can't do that way (another filesystem, or
  the flag refused) is `NoReplace`: never a plain rename, a copy or a fallback of any kind.
- **Folder handles:** every path is opened one component at a time from an open folder (LOCAL_DIR's, or the holding
  folder's), each `O_NOFOLLOW | O_DIRECTORY`, so a link anywhere on the way fails the open and is never followed. Every
  component is the name as spelled on disk (the scan's `raw`), not its NFC form (§4.4).
- **The holding folder:** `<state>/trash/<run id>/<relative path>`, fs-sync's own: each folder in it made 0700 and
  opened by handle. It must be on the same filesystem as LOCAL_DIR (§2.4), so that a move there is one rename and can
  be undone.
- **Move aside** (a delete here, or a file a download replaces): one no-replace rename into the holding folder, then
  the file is hashed there; if it isn't the planned file it is moved back, and if its name was taken meanwhile it
  stays held and is reported.
- **Install:** a temporary file in the target's folder renamed into place without replacing; if the name was taken
  meanwhile, the file goes beside it under the conflict name.
- **Restore:** each held file renamed back without replacing; an occupied path is left as it is and the file stays
  held, listed.
- **Temporary files** (§4.3): a download's bytes go to `.sagebrush-tmp-<run id>-<k>` (k: the action's number in the
  run) in its target's folder; the scan ignores those names and collects the ones it meets, and the next run sweeps
  the earlier runs' away (`sweep_temps`).
- **Seams** (§5): `hooks["after_move_aside"](rel)` and `hooks["before_install"](rel)`, points where a test can change
  a side and let the move go on."""

import ctypes
import errno
import os
import re
import stat
import sys

from .plan import conflict_name
from .scan import TMP_PREFIX, _hash

_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
_CLOEXEC = getattr(os, "O_CLOEXEC", 0)
_DIR_FLAGS = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | _NOFOLLOW | _CLOEXEC
_RUN_ID = re.compile(r"^[0-9A-Za-z][0-9A-Za-z_-]{0,63}$")
MAX_CONFLICT_TRIES = 8              # names tried for a conflict copy when each is taken in turn meanwhile


class Occupied(Exception):
    """The target name is taken (by anything: a file, folder or link)."""


class NoReplace(Exception):
    """This filesystem can't rename without replacing here (another filesystem, or the flag refused): `reason`."""

    def __init__(self, reason):
        super().__init__(reason)
        self.reason = reason


class Changed(Exception):
    """The file isn't the one planned (or isn't a plain file now). `held` says it stayed in the holding folder because
    its name was taken meanwhile; otherwise it was moved back."""

    def __init__(self, rel, held=False):
        super().__init__(rel)
        self.rel, self.held = rel, held


class InstalledBeside(Exception):
    """The target name was taken meanwhile: the new file was installed beside it, at `rel` (the conflict name)."""

    def __init__(self, rel):
        super().__init__(rel)
        self.rel = rel


# ---- the no-replace rename

def _renamer():
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform.startswith("linux") and hasattr(libc, "renameat2"):
        fn, flag = libc.renameat2, 1                    # RENAME_NOREPLACE
    elif sys.platform == "darwin" and hasattr(libc, "renameatx_np"):
        fn, flag = libc.renameatx_np, 0x4               # RENAME_EXCL
    else:
        return None
    fn.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    fn.restype = ctypes.c_int
    return lambda sd, s, dd, d: fn(sd, s, dd, d, flag)


_rename = _renamer()


def rename_noreplace(src_dir, src, dst_dir, dst):
    """Rename `src` in folder handle `src_dir` to `dst` in `dst_dir`, never replacing anything at `dst`. The names are
    single components as spelled on disk. Raises Occupied, NoReplace, or the OSError (FileNotFoundError: `src` is
    gone)."""
    for name in (src, dst):
        _component(name)
    if _rename is None:
        raise NoReplace("this system has no rename that refuses to replace")
    if _rename(src_dir, os.fsencode(src), dst_dir, os.fsencode(dst)) == 0:
        return
    e = ctypes.get_errno()
    if e in (errno.EEXIST, errno.ENOTEMPTY):
        raise Occupied(dst)
    if e == errno.EXDEV:
        raise NoReplace("it is on another filesystem")
    if e in (errno.EINVAL, errno.ENOSYS, errno.ENOTSUP, getattr(errno, "EOPNOTSUPP", errno.ENOTSUP)):
        raise NoReplace("this filesystem can't rename without replacing")
    raise OSError(e, os.strerror(e), src)


def _component(name):
    if not name or name in (".", "..") or "/" in name or "\0" in name:
        raise ValueError("not a single path component: %r" % (name,))


# ---- folders, by handle

def open_dir(dir_fd, parts, make=False, mode=0o700):
    """A new handle on the folder `parts` (components as spelled on disk) under `dir_fd`, opened one component at a
    time, no-follow: a link or non-folder anywhere on the way raises (ELOOP or ENOTDIR). `make` makes the missing
    folders with `mode`. The caller closes the handle."""
    fd = os.dup(dir_fd)
    try:
        for part in parts:
            _component(part)
            try:
                nxt = os.open(part, _DIR_FLAGS, dir_fd=fd)
            except FileNotFoundError:
                if not make:
                    raise
                try:
                    os.mkdir(part, mode, dir_fd=fd)
                except FileExistsError:
                    pass
                nxt = os.open(part, _DIR_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = nxt
        return fd
    except BaseException:
        os.close(fd)
        raise


def _split(rel):
    parts = rel.split("/")
    for p in parts:
        _component(p)
    return parts[:-1], parts[-1]


# ---- the holding folder

class Holding:
    """`<state>/trash/<run id>/`, open by handle. `state_dir` is the state folder #886 checked (state._state_dirs)."""

    def __init__(self, state_dir, run_id):
        if not _RUN_ID.match(run_id):
            raise ValueError("not a run id: %r" % (run_id,))
        self.run_id = run_id
        top = os.open(state_dir, _DIR_FLAGS)
        try:
            self.fd = open_dir(top, ["trash", run_id], make=True)
        finally:
            os.close(top)
        try:
            for fd in (self.fd,):
                st = os.fstat(fd)
                if st.st_uid != os.getuid():
                    raise PermissionError(errno.EPERM, "the holding folder isn't yours", run_id)
                if stat.S_IMODE(st.st_mode) != 0o700:
                    os.fchmod(fd, 0o700)
        except BaseException:
            os.close(self.fd)
            raise

    def same_filesystem(self, root_fd):
        """Whether a file under LOCAL_DIR (`root_fd`) can be moved here by one rename (§2.4)."""
        return os.fstat(self.fd).st_dev == os.fstat(root_fd).st_dev

    def close(self):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None


# ---- the moves

def _hook(hooks, name, rel):
    if hooks and name in hooks:
        hooks[name](rel)


def _is_planned(dir_fd, name, sha256):
    try:
        st = os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
        return stat.S_ISREG(st.st_mode) and _hash(dir_fd, name, st) == sha256
    except OSError:
        return False


def move_aside(root_fd, rel, holding, sha256, hooks=None):
    """Move LOCAL_DIR's `rel` ("a/b/name", as spelled on disk) into the holding folder at the same relative path, by
    one no-replace rename, and check there that it is the planned file (`sha256`). If it isn't, it is moved back
    without replacing and Changed is raised; Changed(held=True) if its name was taken meanwhile, so it stays held."""
    folders, name = _split(rel)
    src = open_dir(root_fd, folders)
    try:
        dst = open_dir(holding.fd, folders, make=True)
        try:
            rename_noreplace(src, name, dst, name)
            _hook(hooks, "after_move_aside", rel)
            if _is_planned(dst, name, sha256):
                return
            try:
                rename_noreplace(dst, name, src, name)
            except Occupied:
                raise Changed(rel, held=True)
            raise Changed(rel)
        finally:
            os.close(dst)
    finally:
        os.close(src)


def install(root_fd, rel, tmp, computer, hooks=None):
    """Rename the temporary file `tmp` (in `rel`'s folder) to `rel`'s name without replacing anything. If the name is
    taken meanwhile, the file is installed beside it under the conflict name (plan.conflict_name, as the reducer
    names a conflict copy) and InstalledBeside(that path) is raised."""
    folders, name = _split(rel)
    _component(tmp)
    d = open_dir(root_fd, folders)
    try:
        _hook(hooks, "before_install", rel)
        try:
            rename_noreplace(d, tmp, d, name)
            return
        except Occupied:
            pass

        def taken(path):
            try:
                os.stat(path.rsplit("/", 1)[-1], dir_fd=d, follow_symlinks=False)
                return True
            except FileNotFoundError:
                return False
        for _ in range(MAX_CONFLICT_TRIES):
            beside = conflict_name(rel, computer, taken)
            try:
                rename_noreplace(d, tmp, d, beside.rsplit("/", 1)[-1])
            except Occupied:
                continue
            raise InstalledBeside(beside)
        raise Occupied(rel)
    finally:
        os.close(d)


def restore(root_fd, holding):
    """Put each file of the holding folder's run back into LOCAL_DIR at its relative path, by a no-replace rename
    (missing folders made as ordinary folders). Returns the relative paths left held because something occupies them
    now (the caller lists them, "not restored: a/b exists", and exits 1). Links and special files held there are left
    as they are (fs-sync never holds one)."""
    left = []

    def walk(hold_dir, parts):
        # (listed through a fresh handle: one held open since the folder was made can read as empty)
        fresh = os.open(".", _DIR_FLAGS, dir_fd=hold_dir)
        try:
            with os.scandir(fresh) as it:
                entries = [(e.name, e.is_dir(follow_symlinks=False), e.is_file(follow_symlinks=False)) for e in it]
        finally:
            os.close(fresh)
        for name, is_dir, is_file in entries:
            rel = "/".join(parts + [name])
            if is_dir:
                sub = open_dir(hold_dir, [name])
                try:
                    walk(sub, parts + [name])
                finally:
                    os.close(sub)
            elif is_file:
                try:
                    dst = open_dir(root_fd, parts, make=True, mode=0o777)
                except OSError:
                    left.append(rel)                    # (a file or link where a folder should be)
                    continue
                try:
                    rename_noreplace(hold_dir, name, dst, name)
                except Occupied:
                    left.append(rel)
                finally:
                    os.close(dst)
    walk(holding.fd, [])
    return left


# ---- temporary files (§4.3)

_TMP = re.compile(r"^" + re.escape(TMP_PREFIX) + r"([0-9A-Za-z][0-9A-Za-z_-]{0,63})-([0-9]+)$")


def temp_name(run_id, k):
    """The temporary file's name for action `k` of run `run_id`, in its target's folder."""
    if not _RUN_ID.match(run_id) or not isinstance(k, int) or k < 0:
        raise ValueError("not a run id and action number: %r, %r" % (run_id, k))
    return "%s%s-%d" % (TMP_PREFIX, run_id, k)


def sweep_temps(root_fd, temps, run_id):
    """Remove the temporary files earlier runs left (`temps`: the scan's ScanResult.temps, as spelled on disk): each
    whose name is exactly an earlier run's temp name (never `run_id`'s own), and that is still a plain file of ours,
    reached through its folder's handle with no link followed. Returns how many were removed."""
    removed = 0
    for rel in temps:
        try:
            folders, name = _split(rel)
        except ValueError:
            continue
        m = _TMP.match(name)
        if not m or m.group(1) == run_id:
            continue
        try:
            d = open_dir(root_fd, folders)
        except OSError:
            continue
        try:
            st = os.stat(name, dir_fd=d, follow_symlinks=False)
            if stat.S_ISREG(st.st_mode) and st.st_uid == os.getuid():
                os.unlink(name, dir_fd=d)
                removed += 1
        except OSError:
            pass
        finally:
            os.close(d)
    return removed
