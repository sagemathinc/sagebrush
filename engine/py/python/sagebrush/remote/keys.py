"""The runner's enrollment: its key and remote id (design remote-v1 §3).

One file, `$XDG_CONFIG_HOME/sagebrush/remote/key.json` (default `~/.config/...`), mode 0600 in a 0700 directory:
`{"v": 1, "d": <b64url, the secret scalar>, "remote_id": ..., "origin": ..., "name": ...}`.  The secret is drawn
from the OS (os.urandom) and used only by the native es256_sign (p256); it is never printed or logged.  A file that
is a symlink, not ours, or readable by others is refused rather than used or repaired."""

import base64
import json
import os
import stat

from sagebrush._native import remote as _native

KEY_VERSION = 1


def b64url(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode("ascii")


def unb64url(s):
    if not isinstance(s, str) or not s or any(c not in _B64URL for c in s) or len(s) % 4 == 1:
        raise ValueError("not base64url")
    b = base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))
    if b64url(b) != s:
        raise ValueError("not canonical base64url")
    return b


_B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
_B64URL = frozenset(_B64)


class KeyFileError(Exception):
    """The key file can't be used (the message says why, without its contents)."""


class RunnerKey:
    """A secret scalar d and what it was enrolled as.  repr() never shows d."""

    __slots__ = ("_d", "x", "y", "remote_id", "origin", "name")

    def __init__(self, d, remote_id=None, origin=None, name=None):
        pub = _native.es256_public(d)
        if pub is None:
            raise KeyFileError("not a P-256 secret")
        self._d = bytes(d)
        self.x, self.y = pub
        self.remote_id, self.origin, self.name = remote_id, origin, name

    @classmethod
    def generate(cls):
        while True:  # (0 or >= n: about 2**-32 likely; draw again)
            d = os.urandom(32)
            if _native.es256_public(d) is not None:
                return cls(d)

    def jwk(self):
        return {"kty": "EC", "crv": "P-256", "x": b64url(self.x), "y": b64url(self.y)}

    def sign(self, message):
        """ES256 over message: 64 bytes r || s."""
        return _native.es256_sign(self._d, message)

    def __repr__(self):
        return "RunnerKey(remote_id=%r, origin=%r)" % (self.remote_id, self.origin)


def default_path():
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")
    return os.path.join(base, "sagebrush", "remote", "key.json")


def _check_private(st, what):
    if st.st_uid != os.getuid():
        raise KeyFileError("%s isn't owned by this user" % what)
    if st.st_mode & 0o077:
        raise KeyFileError("%s is readable or writable by others (chmod go-rwx)" % what)


def load(path=None):
    """The enrolled key, or None if there is no file.  Raises KeyFileError for a file that can't be trusted or read."""
    path = path or default_path()
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0))
    except FileNotFoundError:
        return None
    except OSError as e:
        raise KeyFileError("%s can't be opened (%s)" % (path, e.strerror or "a symlink?"))
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            raise KeyFileError("%s isn't a regular file" % path)
        _check_private(st, path)
        _check_private(os.stat(os.path.dirname(path)), os.path.dirname(path))
        raw = os.read(fd, 8193)
    finally:
        os.close(fd)
    if len(raw) > 8192:
        raise KeyFileError("%s is too long" % path)
    try:
        v = json.loads(raw.decode("utf-8"))
        if not isinstance(v, dict) or v.get("v") != KEY_VERSION:
            raise ValueError
        d = unb64url(v["d"])  # (any length: RunnerKey refuses all but a valid 32-byte scalar)
        rid, origin, name = v.get("remote_id"), v.get("origin"), v.get("name")
        if not all(isinstance(s, str) for s in (rid, origin, name)):
            raise ValueError
    except (ValueError, KeyError, TypeError, UnicodeDecodeError):
        raise KeyFileError("%s isn't a sagebrush remote key file (enroll again: sagebrush remote login)" % path)
    try:
        return RunnerKey(d, rid, origin, name)
    except KeyFileError:
        raise KeyFileError("%s holds no valid key (enroll again: sagebrush remote login)" % path)


def _write_all(fd, data):
    """Every byte, or OSError: os.write may write fewer than asked (astra's R765-WRITE-1), so advance by what it
    wrote, and refuse a write that makes no progress rather than loop."""
    view = memoryview(data)
    while view:
        n = os.write(fd, view)
        if not isinstance(n, int) or n <= 0 or n > len(view):
            raise OSError("the key file's write made no progress")
        view = view[n:]


def save(key, path=None):
    """Write the key atomically: a new 0600 file beside it (O_EXCL, never through a symlink), written whole and
    synced, then renamed over the old one; any failure before the rename removes the new file and leaves the old."""
    path = path or default_path()
    d = os.path.dirname(path)
    os.makedirs(d, mode=0o700, exist_ok=True)
    st = os.lstat(d)
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode):
        raise KeyFileError("%s isn't a directory" % d)
    _check_private(st, d)
    body = json.dumps({"v": KEY_VERSION, "d": b64url(key._d), "remote_id": key.remote_id, "origin": key.origin,
                       "name": key.name}, sort_keys=True).encode("utf-8") + b"\n"
    tmp = "%s.%d.%s.tmp" % (path, os.getpid(), b64url(os.urandom(6)))
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
                 | getattr(os, "O_CLOEXEC", 0), 0o600)
    try:
        try:
            os.fchmod(fd, 0o600)  # (whatever the umask)
            _write_all(fd, body)
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return path
