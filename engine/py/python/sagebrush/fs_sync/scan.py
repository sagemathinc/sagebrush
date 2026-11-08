"""fs-sync's read-only scan of LOCAL_DIR (design/fs-sync.md §1, §2.2, §4.1, §4.4, §4.5).

`scan(root, workspace_path, known)` walks the folder without following any link and without writing anything: every
step is relative to an open directory handle (`os.open(..., dir_fd=...)` with `O_NOFOLLOW`, `os.scandir(fd)`,
`os.stat(..., dir_fd=..., follow_symlinks=False)`), so a folder swapped for a link during the walk makes that step
fail, never escape. It returns the files (by NFC relative path) with their stat key and SHA-256, and what it skipped
and why. A file whose stat key equals the one in `known` (the base) keeps the known hash and isn't read: a planning
shortcut only, never what allows a local file to be replaced or deleted (§2.2, §4.1).

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
MAX_ENTRIES = 200_000       # directory entries visited, of any kind
MAX_DEPTH = 64              # folders deep under LOCAL_DIR
MAX_FILES = 100_000         # files kept (the account's index maximum)
MAX_PATH_BYTES = 1024       # a local relative path, in UTF-8
MAX_FILE_BYTES = 95 * 2**20  # the single-PUT limit: larger files are skipped from their stat, never opened
WS_MAX_PATH, WS_MAX_DEPTH, WS_MAX_NAME = 1024, 32, 255      # a workspace path (UTF-16 units, names, units)
HASH_CHUNK = 2**20

#: ignored both ways and never deleted (§4.4), before LOCAL_DIR/.sagebrushignore
DEFAULT_IGNORES = (".git/", "node_modules/", "__pycache__/", ".DS_Store", "Thumbs.db", "desktop.ini", "*.swp", "*~",
                   "~$*", ".sagebrush-tmp-*")
IGNORE_FILE = ".sagebrushignore"

# ---- why a path was skipped
IGNORED = "ignored"
SYMLINK = "symlink"
SPECIAL = "special"             # a socket, device or FIFO
TOO_BIG = "too-big"
TOO_DEEP = "too-deep"
TOO_LONG = "too-long"           # the local path over MAX_PATH_BYTES
NAME_REFUSED = "name-refused"   # the workspace's path rules refuse it (length, depth, control characters)
NFC_CLASH = "nfc-clash"         # two names here that are one name in NFC
UNREADABLE = "unreadable"       # changed or vanished while it was read


class Refused(Exception):
    """fs-sync won't run: `message` says why, word for word (§1.2), and `code` is the exit code (§1.3)."""

    def __init__(self, message, code=2):
        super().__init__(message)
        self.message, self.code = message, code


class TooMany(Refused):
    """A scan bound was passed: fs-sync stops before planning (exit 1, §4.5)."""

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

    @property
    def key(self):
        return (self.size, self.mtime_ns, self.ctime_ns, self.ino, self.dev)


@dataclass
class ScanResult:
    files: dict = field(default_factory=dict)       # NFC relative path -> LocalFile
    skipped: list = field(default_factory=list)     # (path, why)
    case_insensitive: bool = False
    hashed: int = 0                                 # files whose contents were read (the rest kept a known hash)


# ---------------------------------------------------------------------------- refusals before anything (§1)

def _home_short(p):
    home = os.path.expanduser("~")
    return "~" + p[len(home):] if home and (p == home or p.startswith(home + os.sep)) else p


def refuse_platform():
    """Native Windows isn't supported in v1 (§1, §4.4): exit 2, before pairing or reading anything."""
    if os.name == "nt":
        raise Refused("fs-sync doesn't run on native Windows yet. Use it from WSL (Windows Subsystem for Linux).", 2)


def refuse_overlap(local_dir, private_dirs):
    """LOCAL_DIR may not be, contain, or be inside one of fs-sync's own folders (the config and state folders), all
    resolved to real paths through any symlinks (§1). Raises Refused (exit 2) with §1's message; returns the real path
    of LOCAL_DIR otherwise."""
    root = os.path.realpath(local_dir)
    if not os.path.isdir(root):
        raise Refused("%s isn't a folder on this computer." % _home_short(os.path.abspath(local_dir)), 2)
    for d in private_dirs:
        own = os.path.realpath(d)
        if root == own or root.startswith(own + os.sep):
            raise Refused("%s can't be synced: it is inside fs-sync's own files. Choose a folder outside %s."
                          % (_home_short(root), _home_short(own)), 2)
        if own.startswith(root.rstrip(os.sep) + os.sep):
            raise Refused("%s can't be synced: it contains fs-sync's own files (%s). Choose a folder that doesn't."
                          % (_home_short(root), _home_short(own)), 2)
    return root


# ---------------------------------------------------------------------------- ignore rules (§4.4)

class Ignore:
    """`.gitignore` syntax, the part fs-sync uses: one pattern a line, `#` comments, `!` negation (the last matching
    pattern wins), a leading `/` anchoring to LOCAL_DIR, a trailing `/` matching folders only, `*` and `?` within a
    name, `**` across folders, and `[...]` classes. A pattern with no `/` but a trailing one matches a name at any
    depth. A folder that is ignored isn't entered, so nothing under it can be un-ignored (as git)."""

    def __init__(self, lines):
        self.rules = []
        for raw in lines:
            line = raw.rstrip("\n").rstrip("\r")
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            line = line.rstrip(" ")
            neg = line.startswith("!")
            if neg:
                line = line[1:]
            dir_only = line.endswith("/")
            line = line.rstrip("/")
            if not line:
                continue
            anchored = "/" in line
            line = line.lstrip("/")
            self.rules.append((neg, dir_only, re.compile(self._regex(line, anchored))))

    @staticmethod
    def _regex(pat, anchored):
        out, i = [], 0
        while i < len(pat):
            if pat.startswith("**/", i):
                out.append("(?:.*/)?")
                i += 3
            elif pat.startswith("/**", i) and i + 3 == len(pat):
                out.append("/.*")
                i += 3
            elif pat.startswith("**", i):
                out.append(".*")
                i += 2
            elif pat[i] == "*":
                out.append("[^/]*")
                i += 1
            elif pat[i] == "?":
                out.append("[^/]")
                i += 1
            elif pat[i] == "[":
                j = pat.find("]", i + 2)
                if j < 0:
                    out.append(re.escape("["))
                    i += 1
                else:
                    body = pat[i + 1:j]
                    if body.startswith("!"):
                        body = "^" + body[1:]
                    out.append("[" + body.replace("\\", "\\\\") + "]")
                    i = j + 1
            else:
                out.append(re.escape(pat[i]))
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
    """Whether this filesystem matches names without regard to case, found without writing anything: an existing
    name with letters, looked up with its case swapped, names the same file. With no such name, the platform's
    default (macOS: insensitive)."""
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
    """The SHA-256 of `name` in `dir_fd`, read through a no-follow handle checked to be the file just stated."""
    # (O_NONBLOCK: a file swapped for a FIFO after its stat can't hang the open; regular files ignore the flag)
    fd = os.open(name, os.O_RDONLY | os.O_NONBLOCK | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0),
                 dir_fd=dir_fd)
    try:
        st2 = os.fstat(fd)
        if not stat.S_ISREG(st2.st_mode) or (st2.st_ino, st2.st_dev) != (st.st_ino, st.st_dev):
            raise OSError(errno.ESTALE, "changed while it was read")
        h = hashlib.sha256()
        while True:
            b = os.read(fd, HASH_CHUNK)
            if not b:
                break
            h.update(b)
        st3 = os.fstat(fd)
        if (st3.st_size, st3.st_mtime_ns, st3.st_ctime_ns) != (st.st_size, st.st_mtime_ns, st.st_ctime_ns):
            raise OSError(errno.ESTALE, "changed while it was read")
        return h.hexdigest()
    finally:
        os.close(fd)


def scan(root, workspace_path="/", known=None, limits=None):
    """Walk the folder at real path `root` (from `refuse_overlap`), read-only. `known`: NFC relative path -> (stat
    key, sha256) from the base, for the hashing shortcut. `limits` overrides the bounds (tests). Raises TooMany when a
    bound is passed."""
    lim = dict(entries=MAX_ENTRIES, depth=MAX_DEPTH, files=MAX_FILES, path_bytes=MAX_PATH_BYTES,
               file_bytes=MAX_FILE_BYTES)
    lim.update(limits or {})
    known = known or {}
    out = ScanResult()
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
    root_fd = os.open(root, flags)
    visited = 0
    stack = []                                  # (directory handle, NFC relative path, depth) still to walk
    cur = None                                  # the handle being read now
    try:
        try:
            with open(os.open(IGNORE_FILE, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0), dir_fd=root_fd), "r",
                      encoding="utf-8", errors="replace") as f:
                user_rules = f.read().splitlines()[:10_000]
        except OSError:
            user_rules = []
        ignore = Ignore(list(DEFAULT_IGNORES) + user_rules)
        stack.append((root_fd, "", 0))
        top_names = []
        while stack:
            dfd, rel_dir, depth = stack.pop()
            cur = dfd
            try:
                with os.scandir(dfd) as it:
                    entries = sorted(it, key=lambda e: e.name)
            except OSError:
                out.skipped.append((rel_dir or ".", UNREADABLE))
                if dfd != root_fd:
                    os.close(dfd)
                cur = None
                continue
            # (names here that NFC makes one: every spelling is skipped, files and folders alike)
            spellings = {}
            for e in entries:
                spellings.setdefault(unicodedata.normalize("NFC", e.name), []).append(e.name)
            for e in entries:
                visited += 1
                if visited > lim["entries"]:
                    raise TooMany("Stopped before planning: %s has more than %d entries (the limit for one sync)."
                                  % (_home_short(root), lim["entries"]))
                name = e.name
                if dfd == root_fd:
                    top_names.append(name)
                nfc = unicodedata.normalize("NFC", name)
                rel = rel_dir + "/" + nfc if rel_dir else nfc
                try:
                    st = os.stat(name, dir_fd=dfd, follow_symlinks=False)
                except OSError:
                    out.skipped.append((rel, UNREADABLE))
                    continue
                is_dir = stat.S_ISDIR(st.st_mode)
                if ignore.ignored(rel, is_dir):
                    out.skipped.append((rel + ("/" if is_dir else ""), IGNORED))
                    continue
                if stat.S_ISLNK(st.st_mode):
                    out.skipped.append((rel, SYMLINK))
                    continue
                if len(rel.encode("utf-8")) > lim["path_bytes"]:
                    out.skipped.append((rel, TOO_LONG))
                    continue
                if len(spellings[nfc]) > 1:
                    out.skipped.append((rel, NFC_CLASH))
                    continue
                if is_dir:
                    if depth + 1 > lim["depth"]:
                        out.skipped.append((rel + "/", TOO_DEEP))
                        continue
                    try:
                        sub = os.open(name, flags, dir_fd=dfd)
                    except OSError:
                        out.skipped.append((rel + "/", UNREADABLE))
                        continue
                    stack.append((sub, rel, depth + 1))
                    continue
                if not stat.S_ISREG(st.st_mode):
                    out.skipped.append((rel, SPECIAL))
                    continue
                why = workspace_refuses(rel, workspace_path)
                if why:
                    out.skipped.append((rel, NAME_REFUSED))
                    continue
                if st.st_size > lim["file_bytes"]:
                    out.skipped.append((rel, TOO_BIG))
                    continue
                if len(out.files) >= lim["files"]:
                    raise TooMany("Stopped before planning: %s has more than %d files (the limit for one sync)."
                                  % (_home_short(root), lim["files"]))
                key = (st.st_size, st.st_mtime_ns, st.st_ctime_ns, st.st_ino, st.st_dev)
                k = known.get(rel)
                if k is not None and tuple(k[0]) == key:
                    sha = k[1]
                else:
                    try:
                        sha = _hash(dfd, name, st)
                    except OSError:
                        out.skipped.append((rel, UNREADABLE))
                        continue
                    out.hashed += 1
                out.files[rel] = LocalFile(sha, *key)
            if dfd != root_fd:
                os.close(dfd)
            cur = None
        out.case_insensitive = _case_insensitive(root_fd, top_names)
    finally:
        for dfd in [cur] + [x[0] for x in stack]:
            if dfd is None:
                continue
            if dfd != root_fd:
                try:
                    os.close(dfd)
                except OSError:
                    pass
        os.close(root_fd)
    return out
