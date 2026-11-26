"""sagebrush:// URLs: read a workspace's files by range (design sagebrush-fsspec r3, with r3.1-r3.3).

    sagebrush:///data/trips.csv            a file in this kernel's own workspace
    sagebrush:///data/trips.csv?v=<sha256> a version of it (the SHA-256 of its bytes)

``open(url)`` gives a seekable, read-only binary file whose reads fetch only the
bytes asked for; ``info``, ``ls``, ``exists`` and ``cat_file`` answer about
files and folders.  Sagebrush's pandas accepts these URLs wherever it accepts
a path.

Python never holds a key, a signed URL or a socket: each call is one closed
operation the page answers (src/sbfs.ts), and the page checks everything again.
Other workspaces (``sagebrush://<workspace-id>/path``) are refused for now;
reading them will take a grant the person gives in the page.  With no page to
ask (the command line), every call raises OSError."""

import builtins as _builtins
import io as _io
import json as _json
import re as _re

__all__ = ["open", "info", "ls", "exists", "cat_file", "SagebrushFile"]

# the same limits as the page's (src/sbfs.ts): bytes per fs.read call, a path's UTF-8 bytes
_MAX_READ = 64 << 20
_MAX_PATH = 4096
_WS = _re.compile(r"[0-9a-f]{16}")
_VERSION = _re.compile(r"[0-9a-f]{64}")


def _parse(url):
    """(ws, path, version) of a sagebrush:// URL: ws None for this workspace."""
    if not isinstance(url, str):
        raise TypeError(f"expected a sagebrush:// URL, got {type(url).__name__}")
    if not url.startswith("sagebrush://"):
        raise ValueError(f"not a sagebrush:// URL: {url!r}")
    rest = url[len("sagebrush://"):]
    version = None
    if "?" in rest:
        rest, query = rest.split("?", 1)
        if not query.startswith("v=") or not _VERSION.fullmatch(query[2:]):
            raise ValueError(f"{url!r}: the only query is v=<sha256>, 64 lowercase hex digits")
        version = query[2:]
    if "/" not in rest:
        raise ValueError(f"{url!r}: no path (sagebrush:///path, or sagebrush://<workspace-id>/path)")
    auth, path = rest.split("/", 1)
    path = "/" + path
    ws = None
    if auth:
        if not _WS.fullmatch(auth):
            raise ValueError(f"{url!r}: {auth!r} is not a workspace id")
        ws = auth
    if path != "/":
        path = path.rstrip("/") or "/"
    segs = path[1:].split("/") if path != "/" else []
    if "\0" in path or "\\" in path or any(s in ("", ".", "..") for s in segs) or len(path.encode()) > _MAX_PATH:
        raise ValueError(f"{url!r}: not a normalized workspace path")
    return ws, path, version


_ERRORS = {"not_found": FileNotFoundError, "permission": PermissionError, "memory": MemoryError}


def _ask(op, params, out=None, at=0):
    host = getattr(_builtins, "__pyjs_host__", None)
    answer = host("sb_fs", op, _json.dumps(params, sort_keys=True), out, at) if host is not None else None
    if answer is None:
        raise OSError("sagebrush:// files can be read in a notebook in the browser (a cross-origin isolated page)")
    a = _json.loads(answer)
    if "error" in a:
        code, message = a["error"]["code"], a["error"]["message"]
        if code == "interrupted":
            raise KeyboardInterrupt
        raise _ERRORS.get(code, OSError)(message)
    return a["ok"]


def info(url):
    """{"name", "size", "type", "version", "mtime", "kind", ...} for a file or folder."""
    ws, path, version = _parse(url)
    params = {"ws": ws, "path": path}
    if version is not None:
        params["version"] = version
    return _ask("fs.stat", params)


def exists(url):
    """Whether the file or folder exists (a version too, given ?v=)."""
    try:
        info(url)
    except FileNotFoundError:
        return False
    return True


def ls(url, detail=False):
    """A folder's entries: their URLs, or with detail=True their info dicts."""
    ws, path, version = _parse(url)
    if version is not None:
        raise ValueError("ls: a folder has no version")
    out, cursor = [], None
    while True:
        params = {"ws": ws, "path": path}
        if cursor is not None:
            params["cursor"] = cursor
        page = _ask("fs.list", params)
        for e in page["entries"]:
            name = ("sagebrush://" + (ws or "")) + (path.rstrip("/") + "/" + e["name"])
            out.append(dict(e, name=name) if detail else name)
        cursor = page.get("cursor")
        if cursor is None:
            return out


def cat_file(url, start=None, end=None):
    """The file's bytes, or those from start to end (as a slice: negative counts from the end)."""
    with open(url) as f:
        size = f.size
        s = 0 if start is None else (start + size if start < 0 else start)
        e = size if end is None else (end + size if end < 0 else end)
        s, e = max(0, min(s, size)), max(0, min(e, size))
        if e <= s:
            return b""
        f.seek(s)
        return f.read(e - s)


# a buffered file's read buffer: line reads and small reads refill it a run at a time (a fixed size, never more)
_BUFFER = 64 << 10


class SagebrushFile(_io.BufferedIOBase):
    """A read-only, seekable binary file over sagebrush://: each read fetches only
    the bytes it asks for (small reads and lines through a 64 KiB buffer).  The
    version is fixed when it is opened (the current one, unless ?v= named
    another), so a reader never sees two versions mixed."""

    def __init__(self, url):
        super().__init__()
        ws, path, version = _parse(url)
        params = {"ws": ws, "path": path}
        if version is not None:
            params["version"] = version
        st = _ask("fs.stat", params)
        if st.get("type") != "file":
            raise IsADirectoryError(f"{url}: a folder")
        self.name = url
        self._ws, self._path, self._version = ws, path, st["version"]
        self.size = st["size"]
        self._pos = 0
        # the read buffer: bytes of the file from self._bpos
        self._buf = b""
        self._bpos = 0

    def readable(self):
        return True

    def seekable(self):
        return True

    def writable(self):
        return False

    def tell(self):
        self._checkClosed()
        return self._pos

    def seek(self, offset, whence=0):
        self._checkClosed()
        if whence == 0:
            pos = offset
        elif whence == 1:
            pos = self._pos + offset
        elif whence == 2:
            pos = self.size + offset
        else:
            raise ValueError(f"invalid whence ({whence}, should be 0, 1 or 2)")
        if pos < 0:
            raise ValueError(f"negative seek position {pos}")
        self._pos = pos
        return pos

    def _fetch(self, buf, start, pos, n):
        """n bytes of the file at pos into bytearray buf from index start (fewer at the end); the count."""
        got = 0
        while got < n and pos + got < 2**53:
            k = min(n - got, _MAX_READ)
            m = _ask("fs.read", {"ws": self._ws, "path": self._path, "version": self._version, "offset": pos + got, "length": k}, buf, start + got)["length"]
            got += m
            if m < k:
                break
        return got

    def _buffered(self):
        """The buffered bytes from self._pos on (refilled with one fetch if none)."""
        k = self._pos - self._bpos
        if 0 <= k < len(self._buf):
            return memoryview(self._buf)[k:]
        if self._pos >= self.size:
            return memoryview(b"")
        b = bytearray(min(_BUFFER, self.size - self._pos))
        del b[self._fetch(b, 0, self._pos, len(b)):]
        self._buf, self._bpos = bytes(b), self._pos
        return memoryview(self._buf)

    def read1(self, size=-1):
        self._checkClosed()
        if size is None or size < 0:
            size = _BUFFER
        out = bytes(self._buffered()[:size])
        self._pos += len(out)
        return out

    def readinto(self, b):
        self._checkClosed()
        mv = memoryview(b).cast("B")
        n = min(len(mv), max(0, self.size - self._pos))
        if n == 0:
            return 0
        if isinstance(b, bytearray) and mv.nbytes == len(b):
            got = self._fetch(b, 0, self._pos, n)
        else:
            tmp = bytearray(min(n, _MAX_READ))
            got = 0
            while got < n:
                k = self._fetch(tmp, 0, self._pos + got, min(n - got, len(tmp)))
                mv[got:got + k] = tmp[:k]
                got += k
                if k == 0:
                    break
        self._pos += got
        return got

    def read(self, size=-1):
        self._checkClosed()
        if size is None or size < 0:
            size = max(0, self.size - self._pos)
        n = min(size, max(0, self.size - self._pos))
        if n == 0:
            return b""
        # (a small read through the buffer; a large one, or one the buffer can't hold whole, fetched straight)
        if n < _BUFFER and len(self._buffered()) >= n:
            return self.read1(n)
        # the output is made first, whole (a refusal here is a MemoryError before anything is fetched), then filled
        buf = bytearray(n)
        got = self._fetch(buf, 0, self._pos, n) if n else 0
        del buf[got:]
        self._pos += got
        return bytes(buf)

    def readall(self):
        return self.read(-1)

    def readline(self, size=-1):
        self._checkClosed()
        if size is None:
            size = -1
        parts, total = [], 0
        while size < 0 or total < size:
            chunk = self._buffered()
            if not chunk:
                break
            limit = len(chunk) if size < 0 else min(len(chunk), size - total)
            i = bytes(chunk[:limit]).find(b"\n")
            take = limit if i < 0 else i + 1
            parts.append(bytes(chunk[:take]))
            total += take
            self._pos += take
            if i >= 0:
                break
        return b"".join(parts)

    def write(self, b):
        raise PermissionError("sagebrush:// is read-only")


def open(url, mode="rb", encoding=None, errors=None, newline=None):
    """A sagebrush:// file: binary ("rb"), or text ("r", "rt") with encoding, errors and newline as for open()."""
    if any(c in mode for c in "wax+"):
        raise PermissionError("sagebrush:// is read-only")
    if mode not in ("r", "rb", "rt", "br", "tr"):
        raise ValueError(f"invalid mode: {mode!r}")
    f = SagebrushFile(url)
    if "b" in mode:
        return f
    return _io.TextIOWrapper(f, encoding=encoding or "utf-8", errors=errors, newline=newline)
