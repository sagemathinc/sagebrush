"""fs-sync's read-only scan of LOCAL_DIR (design/fs-sync.md §1, §2.2, §4.1, §4.4, §4.5).

`scan(root, workspace_path, known)` walks the folder depth first, without following any link and without writing
anything. LOCAL_DIR itself is opened one component at a time from `/`, each with `O_NOFOLLOW`, and checked to be the
folder `refuse_overlap` resolved. Every later step is relative to an open directory handle (`os.open(..., dir_fd=...)`
with `O_NOFOLLOW`, `os.scandir(fd)`, `os.stat(..., dir_fd=..., follow_symlinks=False)`), so a folder swapped for a
link during the walk makes that step fail, never escape. A folder is opened only when it is walked and closed when it
is done: the open descriptors are two per level of the current path (the folder's handle and the copy
os.scandir(fd) makes of it to read the listing), plus the one file being hashed.

It returns the files (by NFC relative path) with their stat key, SHA-256 and on-disk spelling, and what it skipped
and why. A file whose stat key equals the one in `known` (the base) keeps the known hash and isn't read: a planning
shortcut only, never what allows a local file to be replaced or deleted (§2.2, §4.1).

Bounds (§4.5): past 200,000 entries visited or 100,000 files, the scan stops before planning (TooMany, exit 1). A
path deeper than 64 folders or longer than 1,024 bytes is skipped and listed (§4.5's "a deeper or longer path is
skipped and listed"; @sagebrush's ruling on #882), as is a file over 95 MiB (from its stat, never opened).

Also here, because they come before any scan or pairing: the refusals of a LOCAL_DIR overlapping fs-sync's own
folders and of native Windows (§1)."""

import errno
import hashlib
import os
import re
import stat
import sys
import unicodedata
from dataclasses import dataclass, field

# ---- bounds (§4.5, and the workspace's own path rules, web/workspace/paths.ts)
MAX_ENTRIES = 200_000       # directory entries visited, of any kind: past it, stop before planning
MAX_FILES = 100_000         # files kept (the account's index maximum): past it, stop before planning
MAX_DEPTH = 64              # folders deep under LOCAL_DIR: deeper is skipped and listed
MAX_PATH_BYTES = 1024       # a local relative path, in UTF-8: longer is skipped and listed
MAX_FILE_BYTES = 95 * 2**20  # the single-PUT limit: larger files are skipped from their stat, never opened
MAX_IGNORE_BYTES = 2**20    # .sagebrushignore: larger stops the run
MAX_IGNORE_LINES = 10_000   # and more lines than this
WS_MAX_PATH, WS_MAX_DEPTH, WS_MAX_NAME = 1024, 32, 255      # a workspace path (UTF-16 units, names, units)
HASH_CHUNK = 2**20

#: ignored both ways and never deleted (§4.4); a `!` line in .sagebrushignore can't un-ignore these
DEFAULT_IGNORES = (".git/", "node_modules/", "__pycache__/", ".DS_Store", "Thumbs.db", "desktop.ini", "*.swp", "*~",
                   "~$*", ".sagebrush-tmp-*")
IGNORE_FILE = ".sagebrushignore"
TMP_PREFIX = ".sagebrush-tmp-"     # a download's temporary file: ignored, and swept by a later run (move.sweep_temps)

# ---- why a path was skipped
IGNORED = "ignored"
SYMLINK = "symlink"
SPECIAL = "special"             # a socket, device or FIFO
TOO_BIG = "too-big"
TOO_DEEP = "too-deep"
TOO_LONG = "too-long"           # the local path over MAX_PATH_BYTES
NAME_REFUSED = "name-refused"   # the workspace's path rules refuse it (length, depth, control characters)
NFC_CLASH = "nfc-clash"         # two names here that are one name in NFC
UNREADABLE = "unreadable"       # vanished, or couldn't be opened or listed
CHANGED = "changed-while-reading"   # changed, grew or was replaced while it was hashed (left for the next run)

_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
_CLOEXEC = getattr(os, "O_CLOEXEC", 0)
_DIR_FLAGS = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | _NOFOLLOW | _CLOEXEC


class Refused(Exception):
    """fs-sync won't run: `message` says why, word for word (§1.2), and `code` is the exit code (§1.3)."""

    def __init__(self, message, code=2):
        super().__init__(message)
        self.message, self.code = message, code


class TooMany(Refused):
    """The entries or files bound was passed: fs-sync stops before planning (exit 1, §4.5)."""

    def __init__(self, message):
        super().__init__(message, 1)


@dataclass(frozen=True)
class LocalFile:
    sha256: str
    size: int
    mtime_ns: int
    ctime_ns: int
    ino: int
    dev: int
    raw: str = None             # the relative path as spelled on disk (it may differ from its NFC key)

    @property
    def key(self):
        return (self.size, self.mtime_ns, self.ctime_ns, self.ino, self.dev)


@dataclass
class ScanResult:
    files: dict = field(default_factory=dict)       # NFC relative path -> LocalFile
    skipped: list = field(default_factory=list)     # (path, why)
    case_insensitive: bool = False
    hashed: int = 0                                 # files whose contents were read (the rest kept a known hash)
    temps: list = field(default_factory=list)       # download temps met (on-disk spelling), for move.sweep_temps


# ---------------------------------------------------------------------------- refusals before anything (§1)

def _home_short(p):
    home = os.path.expanduser("~")
    return "~" + p[len(home):] if home and (p == home or p.startswith(home + os.sep)) else p


def refuse_platform():
    """Native Windows isn't supported in v1 (§1, §4.4): exit 2, before pairing or reading anything."""
    if os.name == "nt":
        raise Refused("fs-sync doesn't run on native Windows yet. Use it from WSL (Windows Subsystem for Linux).", 2)


@dataclass(frozen=True)
class Root:
    """LOCAL_DIR as `refuse_overlap` accepted it: its real path and its identity, which `scan` checks again."""
    path: str
    dev: int
    ino: int


def refuse_overlap(local_dir, private_dirs):
    """LOCAL_DIR may not be, contain, or be inside one of fs-sync's own folders (the config and state folders), all
    resolved to real paths through any symlinks (§1). Raises Refused (exit 2) with §1's message; returns the accepted
    Root otherwise."""
    root = os.path.realpath(local_dir)
    try:
        st = os.stat(root, follow_symlinks=False)
    except OSError:
        st = None
    if st is None or not stat.S_ISDIR(st.st_mode):
        raise Refused("%s isn't a folder on this computer." % _home_short(os.path.abspath(local_dir)), 2)
    for d in private_dirs:
        own = os.path.realpath(d)
        if root == own or root.startswith(own + os.sep):
            raise Refused("%s can't be synced: it is inside fs-sync's own files. Choose a folder outside %s."
                          % (_home_short(root), _home_short(own)), 2)
        if own.startswith(root.rstrip(os.sep) + os.sep):
            raise Refused("%s can't be synced: it contains fs-sync's own files (%s). Choose a folder that doesn't."
                          % (_home_short(root), _home_short(own)), 2)
    return Root(root, st.st_dev, st.st_ino)


def open_root(root):
    """A directory handle on `root` (a Root), opened one path component at a time from `/`, each with O_NOFOLLOW, so
    no link anywhere on the path is followed; then checked to be the folder that was accepted. Refused (exit 2) if it
    isn't (the path changed since): §4.1."""
    if not root.path.startswith(os.sep):
        raise Refused("fs-sync needs an absolute folder path.", 2)
    fd = os.open(os.sep, _DIR_FLAGS)
    try:
        for part in [p for p in root.path.split(os.sep) if p]:
            nxt = os.open(part, _DIR_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = nxt
        st = os.fstat(fd)
    except OSError:
        os.close(fd)
        raise Refused("%s changed while fs-sync was starting (a folder on its path was moved or replaced by a link). "
                      "Run it again." % _home_short(root.path), 2)
    if (st.st_dev, st.st_ino) != (root.dev, root.ino):
        os.close(fd)
        raise Refused("%s changed while fs-sync was starting (a folder on its path was moved or replaced by a link). "
                      "Run it again." % _home_short(root.path), 2)
    return fd


# ---------------------------------------------------------------------------- ignore rules (§4.4)

class Ignore:
    """`.gitignore` syntax, the part fs-sync uses: one pattern a line; `#` starts a comment; `!` negates (the last
    matching pattern wins); `\\#`, `\\!` and `\\` before any character make it literal; a leading `/` (or a `/` in the
    middle) anchors to LOCAL_DIR; a trailing `/` matches folders only; `*` and `?` within a name, `**` across folders,
    and `[...]` classes (`[!...]` negated). A malformed class (such as `[z-a]`) matches its characters literally,
    never an error. A folder that is ignored isn't entered, so nothing under it can be un-ignored (as git)."""

    def __init__(self, lines):
        self.rules = []
        for raw in lines:
            line = raw.rstrip("\n")         # (CRs are the reader's: only one just before an LF is dropped)
            if not line.strip() or line.startswith("#"):
                continue
            # (trailing spaces are dropped unless escaped)
            while line.endswith(" ") and not line.endswith("\\ "):
                line = line[:-1]
            neg = line.startswith("!")
            if neg:
                line = line[1:]
            if line.endswith("\\/"):
                continue                    # (an escaped "/" is a "/" within a name, which no name has: like git, no match)
            dir_only = line.endswith("/")
            line = line.rstrip("/")
            if not line:
                continue
            anchored = "/" in line
            line = line.lstrip("/")
            self.rules.append((neg, dir_only, re.compile(self._regex(line, anchored))))

    @staticmethod
    def _class(body):
        """`[body]` as a regex class, or None if it isn't a valid one."""
        if body.startswith("!"):
            body = "^" + body[1:]
        rx = "[" + body.replace("\\", "\\\\") + "]"
        try:
            re.compile(rx)
        except re.error:
            return None
        return rx

    @classmethod
    def _regex(cls, pat, anchored):
        out, i = [], 0
        while i < len(pat):
            c = pat[i]
            if c == "\\" and i + 1 < len(pat):
                out.append(re.escape(pat[i + 1]))
                i += 2
            elif pat.startswith("**/", i):
                out.append("(?:.*/)?")
                i += 3
            elif pat.startswith("/**", i) and i + 3 == len(pat):
                out.append("/.*")
                i += 3
            elif pat.startswith("**", i):
                out.append(".*")
                i += 2
            elif c == "*":
                out.append("[^/]*")
                i += 1
            elif c == "?":
                out.append("[^/]")
                i += 1
            elif c == "[":
                j = pat.find("]", i + 2)
                rx = cls._class(pat[i + 1:j]) if j >= 0 else None
                if rx is None:
                    out.append(re.escape("["))
                    i += 1
                else:
                    out.append(rx)
                    i = j + 1
            else:
                out.append(re.escape(c))
                i += 1
        return ("^" if anchored else "^(?:.*/)?") + "".join(out) + "$"

    def ignored(self, path, is_dir):
        hit = False
        for neg, dir_only, rx in self.rules:
            if dir_only and not is_dir:
                continue
            if rx.match(path):
                hit = not neg
        return hit


_DEFAULTS = Ignore(DEFAULT_IGNORES)


def read_ignore_file(root_fd):
    """LOCAL_DIR/.sagebrushignore's lines (§4.4), read fail closed: no rules only if there is none; otherwise it must
    be a regular file (a no-follow, non-blocking handle, checked by fstat) of at most 1 MiB and 10,000 lines, and
    never more than 1 MiB + 1 byte is read. Anything else stops before planning (Refused, exit 1) with §4.4's words."""
    try:
        fd = os.open(IGNORE_FILE, os.O_RDONLY | os.O_NONBLOCK | _NOFOLLOW | _CLOEXEC, dir_fd=root_fd)
    except FileNotFoundError:
        return []
    except OSError as e:
        if e.errno in (errno.ELOOP, errno.EISDIR, errno.ENXIO, errno.ENOTDIR):
            raise Refused(_NOT_PLAIN, 1)
        raise Refused("Stopped before planning: %s couldn't be read (%s)." % (IGNORE_FILE, e.strerror or e), 1)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            raise Refused(_NOT_PLAIN, 1)
        before = (st.st_size, st.st_mtime_ns, st.st_ctime_ns, st.st_ino, st.st_dev)
        # (one pass of at most 1 MiB + 1 byte, stopping at the first byte of a 10,001st line, whichever comes first:
        # any byte after the 10,000th newline begins a 10,001st line)
        too_many = Refused("Stopped before planning: %s has more than %s lines (the limit)."
                           % (IGNORE_FILE, format(MAX_IGNORE_LINES, ",")), 1)
        data, n, newlines = [], 0, 0
        while n <= MAX_IGNORE_BYTES:
            try:
                b = os.read(fd, min(64 * 1024, MAX_IGNORE_BYTES + 1 - n))
            except OSError as e:
                raise Refused("Stopped before planning: %s couldn't be read (%s)." % (IGNORE_FILE, e.strerror or e), 1)
            if not b:
                break
            need = MAX_IGNORE_LINES - newlines         # (0 once the limit is reached: then any byte is too many)
            if b.count(b"\n") < need:
                newlines += b.count(b"\n")
            else:
                j = -1
                for _ in range(need):
                    j = b.find(b"\n", j + 1)
                if j + 1 < len(b):
                    raise too_many
                newlines = MAX_IGNORE_LINES
            data.append(b)
            n += len(b)
        if n > MAX_IGNORE_BYTES:
            raise Refused("Stopped before planning: %s is over 1 MiB (the limit)." % IGNORE_FILE, 1)
        st2 = os.fstat(fd)
        if (st2.st_size, st2.st_mtime_ns, st2.st_ctime_ns, st2.st_ino, st2.st_dev) != before or n != st.st_size:
            raise Refused("Stopped before planning: %s couldn't be read (it changed while being read)." % IGNORE_FILE, 1)
        # (lines end at LF only, as counted above: one CR just before an LF is dropped, so CRLF files read the same;
        # any other CR, a lone one or one ending a last line with no LF, is part of its line: §4.4)
        try:
            text = b"".join(data).decode("utf-8")      # (strict: a rule changed by decoding would silently match nothing)
        except UnicodeDecodeError:
            raise Refused("Stopped before planning: %s couldn't be read (it isn't UTF-8 text)." % IGNORE_FILE, 1)
        lines = text.split("\n")
        last = lines.pop()                              # (what follows the last LF: "" if the file ends in one)
        lines = [line[:-1] if line.endswith("\r") else line for line in lines]
        if last:
            lines.append(last)
        return lines
    finally:
        os.close(fd)


_NOT_PLAIN = ("Stopped before planning: %s isn't a plain file (a link, folder or special file has that name). Replace it "
              "with a plain file, or remove it." % IGNORE_FILE)


# ---------------------------------------------------------------------------- the walk

def _units(s):
    return len(s.encode("utf-16-le")) // 2


_CONTROL = re.compile("[\u0000-\u001f\u007f]")


def workspace_refuses(rel, workspace_path):
    """Why the workspace would refuse `workspace_path/rel` (paths.ts normPath), or None."""
    full = workspace_path.rstrip("/") + "/" + rel
    if _units(full) > WS_MAX_PATH:
        return "a workspace path is at most %d characters" % WS_MAX_PATH
    names = full.strip("/").split("/")
    if len(names) > WS_MAX_DEPTH:
        return "a workspace path is at most %d folders deep" % WS_MAX_DEPTH
    for n in names:
        if n in ("", ".", ".."):
            return "not a name in a path"
        if _units(n) > WS_MAX_NAME:
            return "a name is at most %d characters" % WS_MAX_NAME
        if _CONTROL.search(n):
            return "a name can't hold control characters"
    return None


def _case_insensitive(root_fd, names):
    """Whether this filesystem matches names without regard to case, found without writing anything (so `--dry-run`
    writes nothing): an existing name with letters, looked up with its case swapped, names the same file. With no such
    name, the platform's default (macOS: insensitive). So on Linux, a case-insensitive filesystem (exFAT on a USB
    drive, ext4 casefold) with no top-level name that has letters is taken as case-sensitive: two workspace names that
    differ only in case aren't then listed as a clash, and the second download's no-replace install refuses instead
    (§4.1), so nothing is overwritten."""
    for n in names:
        s = n.swapcase()
        if s == n:
            continue
        try:
            a = os.stat(n, dir_fd=root_fd, follow_symlinks=False)
            b = os.stat(s, dir_fd=root_fd, follow_symlinks=False)
        except OSError:
            return False                    # the swapped name isn't there: this filesystem tells case apart
        return (a.st_ino, a.st_dev) == (b.st_ino, b.st_dev)
    return sys.platform == "darwin"


def _hash(dir_fd, name, st):
    """The SHA-256 of `name` in `dir_fd`, read through a no-follow handle checked to be the file just stated, reading
    never more than its stated size + 1 byte: a file that grew, shrank or changed while it was read is refused."""
    # (O_NONBLOCK: a file swapped for a FIFO after its stat can't hang the open; regular files ignore the flag)
    fd = os.open(name, os.O_RDONLY | os.O_NONBLOCK | _NOFOLLOW | _CLOEXEC, dir_fd=dir_fd)
    try:
        st2 = os.fstat(fd)
        if not stat.S_ISREG(st2.st_mode) or (st2.st_ino, st2.st_dev) != (st.st_ino, st.st_dev):
            raise OSError(errno.ESTALE, "changed while it was read")
        h, n = hashlib.sha256(), 0
        while True:
            # (never past the stated size + 1 byte: one extra byte says it grew, and the check below refuses it)
            b = os.read(fd, min(HASH_CHUNK, st.st_size + 1 - n))
            if not b:
                break
            n += len(b)
            h.update(b)
        st3 = os.fstat(fd)
        if n != st.st_size or (st3.st_size, st3.st_mtime_ns, st3.st_ctime_ns) != (st.st_size, st.st_mtime_ns,
                                                                                  st.st_ctime_ns):
            raise OSError(errno.ESTALE, "changed while it was read")
        return h.hexdigest()
    finally:
        os.close(fd)


def scan(root, workspace_path="/", known=None, limits=None):
    """Walk LOCAL_DIR (`root`, the Root `refuse_overlap` returned), read-only and depth first. `known`: NFC relative
    path -> (stat key, sha256) from the base, for the hashing shortcut. `limits` overrides the bounds (tests). Raises
    TooMany past the entries or files bound, and Refused if LOCAL_DIR changed since it was accepted or its
    .sagebrushignore can't be read."""
    lim = dict(entries=MAX_ENTRIES, depth=MAX_DEPTH, files=MAX_FILES, path_bytes=MAX_PATH_BYTES,
               file_bytes=MAX_FILE_BYTES)
    lim.update(limits or {})
    known = known or {}
    out = ScanResult()
    visited = [0]
    top_names = []
    shown = _home_short(root.path)

    clashes = set()                 # NFC paths with two spellings here: neither is synced, nor anything under them
    spelled = {}                    # NFC path -> the on-disk spelling first seen

    def clash(rel):
        """A second spelling of `rel` (as NFC): drop what the first one brought, and list both."""
        clashes.add(rel)
        for p in [p for p in out.files if p == rel or p.startswith(rel + "/")]:
            del out.files[p]
        out.skipped.append((rel, NFC_CLASH))
        out.skipped.append((rel, NFC_CLASH))

    def unlistable(rel_dir, err):
        """A folder whose listing failed, at its start or partway: skipped whole (listed once as `folder/`, and
        whatever it already added dropped), so the plan leaves everything under it alone (§2.2, §4.4). LOCAL_DIR
        itself unlistable stops the run: with nothing read, every recorded file would look deleted here."""
        if not rel_dir:
            raise Refused("Stopped before planning: %s couldn't be listed (%s)." % (shown, err.strerror or err), 1)
        for p in [p for p in out.files if p.startswith(rel_dir + "/")]:
            del out.files[p]
        out.skipped[:] = [(p, why) for p, why in out.skipped if not p.startswith(rel_dir + "/")]
        out.skipped.append((rel_dir + "/", UNREADABLE))

    def walk(dfd, rel_dir, raw_dir, depth, ignore):
        # (streamed: nothing is sorted and no folder's listing is held; a subfolder is entered as soon as it is read,
        # while this folder's listing waits, so the open handles are one per level of the current path)
        try:
            it = os.scandir(dfd)
        except OSError as err:
            unlistable(rel_dir, err)
            return
        with it:
            while True:
                try:
                    e = next(it)
                except StopIteration:
                    break
                except OSError as err:
                    unlistable(rel_dir, err)
                    return
                visited[0] += 1
                if visited[0] > lim["entries"]:
                    raise TooMany("Stopped before planning: %s has more than %s entries (the limit for one sync)."
                                  % (shown, format(lim["entries"], ",")))
                entry(dfd, e.name, rel_dir, raw_dir, depth, ignore)

    def entry(dfd, name, rel_dir, raw_dir, depth, ignore):
        if depth == 0:
            top_names.append(name)
        nfc = unicodedata.normalize("NFC", name)
        rel = rel_dir + "/" + nfc if rel_dir else nfc
        raw = raw_dir + "/" + name if raw_dir else name
        if rel in clashes:
            return
        if rel in spelled and spelled[rel] != raw:
            clash(rel)
            return
        spelled[rel] = raw
        try:
            st = os.stat(name, dir_fd=dfd, follow_symlinks=False)
        except OSError:
            out.skipped.append((rel, UNREADABLE))
            return
        is_dir = stat.S_ISDIR(st.st_mode)
        if name.startswith(TMP_PREFIX) and stat.S_ISREG(st.st_mode):
            out.temps.append(raw)
        if _DEFAULTS.ignored(rel, is_dir) or ignore.ignored(rel, is_dir):
            out.skipped.append((rel + ("/" if is_dir else ""), IGNORED))
            return
        if stat.S_ISLNK(st.st_mode):
            out.skipped.append((rel, SYMLINK))
            return
        if len(rel.encode("utf-8")) > lim["path_bytes"]:
            out.skipped.append((rel, TOO_LONG))
            return
        if is_dir:
            if depth + 1 > lim["depth"]:
                out.skipped.append((rel + "/", TOO_DEEP))
                return
            try:
                sub = os.open(name, _DIR_FLAGS, dir_fd=dfd)
            except OSError:
                out.skipped.append((rel + "/", UNREADABLE))
                return
            try:
                walk(sub, rel, raw, depth + 1, ignore)
            finally:
                os.close(sub)
            return
        if not stat.S_ISREG(st.st_mode):
            out.skipped.append((rel, SPECIAL))
            return
        if workspace_refuses(rel, workspace_path):
            out.skipped.append((rel, NAME_REFUSED))
            return
        if st.st_size > lim["file_bytes"]:
            out.skipped.append((rel, TOO_BIG))
            return
        if len(out.files) >= lim["files"]:
            raise TooMany("Stopped before planning: %s has more than %s files (the limit for one sync)."
                          % (shown, format(lim["files"], ",")))
        key = (st.st_size, st.st_mtime_ns, st.st_ctime_ns, st.st_ino, st.st_dev)
        k = known.get(rel)
        if k is not None and tuple(k[0]) == key:
            sha = k[1]
        else:
            try:
                sha = _hash(dfd, name, st)
            except OSError as err:
                out.skipped.append((rel, CHANGED if err.errno == errno.ESTALE else UNREADABLE))
                return
            out.hashed += 1
        out.files[rel] = LocalFile(sha, *key, raw=raw)

    root_fd = open_root(root)
    try:
        walk(root_fd, "", "", 0, Ignore(read_ignore_file(root_fd)))
        out.case_insensitive = _case_insensitive(root_fd, top_names)
    finally:
        os.close(root_fd)
    return out
