"""The data replay layer (plan-network-data r3, replay-layer r2): a folder's
.sagebrush-data snapshot, replayed by urllib.request.urlopen, never the
network.

- key(method, url): the normalized key ("GET https://host/path?query"), or
  Refused (r2 §2.1).
- find(): the snapshot directory for the current directory under the trusted
  data root (_fs.data_root()), or a miss reason (§2.2).
- load(snapdir): the manifest, parsed by a strict bounded parser and checked
  against the closed version 1 schema (§2.4).
- verify(snapdir, entry): the pinned bytes, read once without following
  links, from a regular file, and returned only when their length and
  sha256 match (§2.3).
- redact(url): the url as it may be shown: credential-named parameters,
  userinfo and the fragment hidden; an unparseable url shown as a
  placeholder (§2.7).
- FRED (api, fred, alfred.stlouisfed.org) is never replayed: each reader
  fetches it live with their own key (§2.6).

What it scopes is this replay API only: it is no sandbox for open().  It
guards a static poisoned layout (an imported or shared folder); a parent
directory swapped and swapped back between the checks and the read is not
detected (Node has no openat).
"""

import hashlib
import re

import _fs

FILE_CAP = 8_000_000           # snapshot.json, bytes
ENTRIES_CAP = 2000
URL_CAP = 2048                 # UTF-8 bytes
# (an entry key's bound is derived from its method and the url cap, checked
# after the url: len(method) + 1 + URL_CAP, 2053 for HEAD; grader X6)
META_CAP = 512
STRING_CAP = 4096              # the parser's bound on any one string
ENTRY_CAP = 50_000_000         # one entry's size
FOLDER_CAP = 500_000_000       # the sum of the entries' sizes
DEPTH_CAP = 3
DIGITS_CAP = 16
FRED_HOSTS = frozenset(["api.stlouisfed.org", "fred.stlouisfed.org", "alfred.stlouisfed.org"])
CRED_NAMES = frozenset(["api_key", "apikey", "access_token", "token", "secret", "client_secret", "password", "passwd", "auth", "key_id"])
UNRESERVED = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
HEX = "0123456789abcdefABCDEF"

# (a test hook: production never calls it; test/sbdata/HARNESS.md H5)
_test_after_verify = None


class Refused(Exception):
    def __init__(self, code):
        Exception.__init__(self, code)
        self.code = code


# ------------------------------------------------------------------ keys (§2.1)

_LABEL = re.compile(r"[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\Z")


def _printable_ascii(s):
    return all(" " < c < "\x7f" and c != "\\" for c in s)


def _pct(s):
    # (each %HH: two hex digits; an unreserved character decoded, any other
    # escape kept with uppercase hex)
    out = []
    i = 0
    while i < len(s):
        c = s[i]
        if c == "%":
            h = s[i + 1:i + 3]
            if len(h) != 2 or h[0] not in HEX or h[1] not in HEX:
                raise Refused("url")
            ch = chr(int(h, 16))
            out.append(ch if ch in UNRESERVED else "%" + h.upper())
            i += 3
        else:
            out.append(c)
            i += 1
    return "".join(out)


def _host(h):
    h = h.lower()
    if h.endswith("."):
        h = h[:-1]
    labels = h.split(".")
    if not h or len(h) > 253 or not all(_LABEL.match(x) for x in labels):
        raise Refused("url")
    last = labels[-1]
    if last.isdigit() or (last.startswith("0x") and all(c in HEX for c in last[2:])):
        raise Refused("url")
    return h


def _split(url):
    # scheme://authority path ?query #fragment, or Refused
    if not isinstance(url, str) or not _printable_ascii(url):
        raise Refused("url")
    m = re.match(r"([A-Za-z][A-Za-z0-9+.-]*)://([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#.*)?\Z", url)
    if m is None:
        raise Refused("url")
    scheme = m.group(1).lower()
    if scheme not in ("http", "https"):
        raise Refused("url")
    return scheme, m.group(2), m.group(3), m.group(4)


def _authority(scheme, auth):
    if "@" in auth:
        raise Refused("url")
    if auth.startswith("["):
        raise Refused("url")
    host, sep, port = auth.partition(":")
    host = _host(host)
    if sep:
        if not port.isdigit() or not 1 <= int(port) <= 65535:
            raise Refused("url")
        if int(port) != {"http": 80, "https": 443}[scheme]:
            host += ":" + str(int(port))
    return host


def _path(p):
    p = p or "/"
    if not p.startswith("/"):
        raise Refused("url")
    # (dot segments, %2E included, refused on their own: no RFC removal)
    if any(seg in (".", "..") for seg in re.sub("%2[eE]", ".", p).split("/")):
        raise Refused("url")
    return _pct(p)


def normalize_url(url):
    scheme, auth, path, query = _split(url)
    host = _authority(scheme, auth)
    s = "%s://%s%s" % (scheme, host, _path(path))
    if query:
        s += "?" + _pct(query)
    return s


def key(method, url):
    if method not in ("GET", "HEAD"):
        raise Refused("method")
    return method + " " + normalize_url(url)


def host_of(url):
    """the url's host, lowercased, one trailing dot dropped; None if none"""
    m = re.match(r"[A-Za-z][A-Za-z0-9+.-]*://([^/?#]*)", url) if isinstance(url, str) else None
    if m is None:
        return None
    h = m.group(1).rpartition("@")[2].partition(":")[0].lower()
    return h[:-1] if h.endswith(".") else h


def is_fred(url):
    return host_of(url) in FRED_HOSTS


# ------------------------------------------------------------------ redaction (§2.7)

def _unquote(s):
    # (every %HH decoded, a malformed escape kept as it is: for names only)
    return re.sub("%([0-9A-Fa-f]{2})", lambda m: chr(int(m.group(1), 16)), s)


def _decode_name(name):
    return _unquote(name).lower()


def _cred(name):
    n = _decode_name(name)
    return n in CRED_NAMES


def redact(url):
    """the url as it may appear in any message"""
    if not isinstance(url, str) or not _printable_ascii(url):
        return "<unparseable URL>"
    m = re.match(r"([A-Za-z][A-Za-z0-9+.-]*)://([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#.*)?\Z", url)
    if m is None or not re.match(r"[A-Za-z0-9.\-:@%_~!$&'()*+,;=]*\Z", m.group(2)):
        return "<unparseable URL>"
    auth = m.group(2)
    if "@" in auth:
        auth = "<redacted>@" + auth.rpartition("@")[2]
    s = "%s://%s%s" % (m.group(1), auth, m.group(3))
    if m.group(4) is not None:
        parts = []
        for p in m.group(4).split("&"):
            name, eq, _ = p.partition("=")
            parts.append(name + "=<redacted>" if _cred(name) else p)
        s += "?" + "&".join(parts)
    return s


# ------------------------------------------------------------------ the manifest parser (§2.4)

class _Parser:
    def __init__(self, text):
        self.s = text
        self.i = 0

    def ws(self):
        s, i = self.s, self.i
        while i < len(s) and s[i] in " \t\n\r":
            i += 1
        self.i = i

    def value(self, depth):
        self.ws()
        if self.i >= len(self.s):
            raise Refused("not-json")
        c = self.s[self.i]
        if c == "{":
            return self.obj(depth + 1)
        if c == "[":
            raise Refused("array")
        if c == '"':
            return self.string(STRING_CAP)
        if c in "tfn":
            raise Refused("literal")
        if c == "-" or c.isdigit():
            return self.number()
        raise Refused("not-json")

    def obj(self, depth):
        if depth > DEPTH_CAP:
            raise Refused("depth")
        self.i += 1
        out = {}
        self.ws()
        if self.s[self.i:self.i + 1] == "}":
            self.i += 1
            return out
        while True:
            self.ws()
            if self.s[self.i:self.i + 1] != '"':
                raise Refused("not-json")
            k = self.string(STRING_CAP)
            if k in out:
                raise Refused("duplicate-key")
            self.ws()
            if self.s[self.i:self.i + 1] != ":":
                raise Refused("not-json")
            self.i += 1
            out[k] = self.value(depth)
            self.ws()
            c = self.s[self.i:self.i + 1]
            self.i += 1
            if c == "}":
                return out
            if c != ",":
                raise Refused("not-json")

    def string(self, cap, capcode="cap:string"):
        s = self.s
        i = self.i + 1
        out = []
        n = 0
        while True:
            if i >= len(s):
                raise Refused("not-json")
            c = s[i]
            if c == '"':
                break
            if c < " ":
                raise Refused("not-json")
            if c == "\\":
                e = s[i + 1:i + 2]
                if e == "u":
                    h = s[i + 2:i + 6]
                    if len(h) != 4 or not all(x in HEX for x in h):
                        raise Refused("not-json")
                    c = chr(int(h, 16))
                    i += 6
                    if 0xD800 <= ord(c) < 0xDC00 and s[i:i + 2] == "\\u":
                        h2 = s[i + 2:i + 6]
                        if len(h2) == 4 and all(x in HEX for x in h2) and 0xDC00 <= int(h2, 16) < 0xE000:
                            c = chr(0x10000 + ((ord(c) - 0xD800) << 10) + (int(h2, 16) - 0xDC00))
                            i += 6
                else:
                    c = {'"': '"', "\\": "\\", "/": "/", "b": "\b", "f": "\f", "n": "\n", "r": "\r", "t": "\t"}.get(e)
                    if c is None:
                        raise Refused("not-json")
                    i += 2
            else:
                i += 1
            n += len(c.encode("utf-8", "surrogatepass"))
            if n > cap:
                raise Refused(capcode)
            out.append(c)
        self.i = i + 1
        return "".join(out)

    def number(self):
        s, i = self.s, self.i
        neg = s[i] == "-"
        if neg:
            i += 1
        j = i
        while j < len(s) and s[j].isdigit():
            j += 1
            if j - i > DIGITS_CAP:
                raise Refused("number")
        if j == i or (s[i] == "0" and j - i > 1):
            raise Refused("not-json")
        if j < len(s) and s[j] in ".eE":
            raise Refused("number")
        self.i = j
        v = int(s[i:j])
        return -v if neg else v

    def document(self):
        self.ws()
        if self.s[self.i:self.i + 1] == "[":
            raise Refused("array")
        if self.s[self.i:self.i + 1] != "{":
            raise Refused("not-json")
        v = self.obj(1)
        self.ws()
        if self.i != len(self.s):
            raise Refused("not-json")
        return v


def parse(raw):
    if raw[:3] == b"\xef\xbb\xbf":
        raise Refused("encoding")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise Refused("encoding")
    return _Parser(text).document()


# ------------------------------------------------------------------ the schema (§2.4)

TOP = ("format", "version", "revision", "entries")
REQUIRED = ("endpoint", "url", "method", "status", "fetched_at", "sha256", "size", "content_type", "via", "source", "terms", "recorded_by")
OPTIONAL = ("etag", "last_modified", "converted_from")
_ID = re.compile(r"[a-z0-9-]{1,64}\Z")
_SHA = re.compile(r"[0-9a-f]{64}\Z")
_TIME = re.compile(r"(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z\Z")
_DAYS = (31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)


def _int(v):
    return type(v) is int


def _valid_time(t):
    m = _TIME.match(t) if isinstance(t, str) else None
    if m is None:
        return False
    y, mo, d, hh, mm, ss = (int(x) for x in m.groups())
    if not 1 <= mo <= 12 or not 1 <= d <= _DAYS[mo - 1] or hh > 23 or mm > 59 or ss > 59:
        return False
    return not (mo == 2 and d == 29 and not (y % 4 == 0 and (y % 100 != 0 or y % 400 == 0)))


def _meta(e, f):
    v = e[f]
    if not isinstance(v, str) or not all(c >= " " and c != "\x7f" for c in v):
        raise Refused("bad-value:" + f)
    if len(v.encode("utf-8")) > META_CAP:
        raise Refused("cap:" + f)


def _check_url(e, f, method):
    u = e[f]
    if not isinstance(u, str):
        raise Refused("bad-value:" + f)
    if len(u.encode("utf-8")) > URL_CAP:
        raise Refused("cap:" + f)
    try:
        key(method, u)
    except Refused:
        raise Refused("bad-value:" + f)
    q = u.partition("#")[0].partition("?")[2]
    if q and any(_cred(p.partition("=")[0]) for p in q.split("&")):
        raise Refused("bad-value:" + f)
    if is_fred(u):
        raise Refused("fred")


def _entry(k, e):
    if not isinstance(e, dict):
        raise Refused("bad-value:entry")
    for f in e:
        if f not in REQUIRED and f not in OPTIONAL:
            raise Refused("unknown-key")
    for f in REQUIRED:
        if f not in e:
            raise Refused("missing:" + f)
    if e["method"] not in ("GET", "HEAD"):
        raise Refused("bad-value:method")
    _check_url(e, "url", e["method"])
    if len(k.encode("utf-8")) > len(e["method"]) + 1 + URL_CAP:
        raise Refused("cap:key")
    if not isinstance(e["endpoint"], str) or not (e["endpoint"] == "import" or _ID.match(e["endpoint"])):
        raise Refused("bad-value:endpoint")
    if not _int(e["status"]) or not 100 <= e["status"] <= 599:
        raise Refused("bad-value:status")
    if not _valid_time(e["fetched_at"]):
        raise Refused("bad-value:fetched_at")
    if not isinstance(e["sha256"], str) or not _SHA.match(e["sha256"]):
        raise Refused("bad-value:sha256")
    if not _int(e["size"]) or e["size"] < 0:
        raise Refused("bad-value:size")
    if e["size"] > ENTRY_CAP:
        raise Refused("cap:size")
    _meta(e, "content_type")
    if not all(" " <= c < "\x7f" for c in e["content_type"]):
        raise Refused("bad-value:content_type")
    if e["via"] not in ("relay", "import", "converted"):
        raise Refused("bad-value:via")
    if e["via"] == "converted" and "converted_from" not in e:
        raise Refused("missing:converted_from")
    if "converted_from" in e:
        _check_url(e, "converted_from", "GET")
    if e["source"] != host_of(normalize_url(e["url"])):
        raise Refused("bad-value:source")
    if not isinstance(e["terms"], str) or not _ID.match(e["terms"]):
        raise Refused("bad-value:terms")
    _meta(e, "recorded_by")
    for f in ("etag", "last_modified"):
        if f in e:
            _meta(e, f)
    if k != key(e["method"], e["url"]):
        raise Refused("key-mismatch")


def validate(m):
    for f in m:
        if f not in TOP:
            raise Refused("unknown-key")
    for f in TOP:
        if f not in m:
            raise Refused("missing:" + f)
    if m["format"] != "sagebrush-data":
        raise Refused("bad-value:format")
    if not _int(m["version"]) or m["version"] != 1:
        raise Refused("bad-value:version")
    if not _int(m["revision"]) or not 1 <= m["revision"] <= 2 ** 53 - 1:
        raise Refused("bad-value:revision")
    entries = m["entries"]
    if not isinstance(entries, dict):
        raise Refused("bad-value:entries")
    if len(entries) > ENTRIES_CAP:
        raise Refused("cap:entries")
    total = 0
    for k, e in entries.items():
        _entry(k, e)
        total += e["size"]
    if total > FOLDER_CAP:
        raise Refused("cap:folder")
    return entries


def load(snapdir):
    """the entries of snapdir's manifest (a .sagebrush-data directory), or Refused"""
    raw = _fs.read_nofollow(snapdir + "/snapshot.json", FILE_CAP)
    if raw == "too-large":
        raise Refused("too-large")
    if not isinstance(raw, bytes):
        raise Refused("manifest-" + raw)
    return validate(parse(raw))


# ------------------------------------------------------------------ scope (§2.2)

class Miss(Exception):
    def __init__(self, code, text):
        Exception.__init__(self, code)
        self.code = code
        self.text = text


def _inside(path, root):
    return root == "/" or path == root or path.startswith(root + "/")


def _real_dir(p):
    return _fs.lstat_kind(p)[0] == "dir"


def _parent(d):
    return d.rpartition("/")[0] or "/"


def find():
    """(snapdir, entries) for the current directory, or Miss"""
    root = _fs.data_root()
    if root is None:
        raise Miss("no-snapshot", "no data root on this host")
    here = _fs.realpath(".")
    if here is None or not _inside(here, root):
        raise Miss("outside-root", "the current directory is outside the data root")
    d = here
    while True:
        marker = d + "/.sagebrush-data"
        if _fs.lstat_kind(marker)[0] != "none":
            try:
                if not _real_dir(marker):
                    raise Refused("not-a-directory")
                return marker, load(marker)
            except Refused as e:
                raise Miss("invalid-snapshot", "this folder's snapshot is invalid (%s)" % e.code)
        if d == root:
            raise Miss("no-snapshot", "no snapshot in this folder")
        d = _parent(d)


# ------------------------------------------------------------------ blobs (§2.3)

def verify(snapdir, e):
    """the entry's bytes, verified, read once; or Miss"""
    h = e["sha256"]
    dirs = [snapdir + "/blobs", snapdir + "/blobs/sha256", snapdir + "/blobs/sha256/" + h[:2]]
    before = [_fs.lstat_kind(p) for p in dirs]
    if not all(_real_dir(p) for p in dirs):
        raise Miss("invalid-blob", "the pinned bytes are not readable")
    path = dirs[-1] + "/" + h
    buf = _fs.read_nofollow(path, e["size"])
    if not isinstance(buf, bytes):
        raise Miss("invalid-blob", "the pinned bytes are not readable")
    if len(buf) != e["size"]:
        raise Miss("invalid-blob", "the pinned bytes have the wrong length")
    if hashlib.sha256(buf).hexdigest() != h:
        raise Miss("invalid-blob", "the pinned bytes don't match their sha256")
    if [_fs.lstat_kind(p) for p in dirs] != before:
        raise Miss("invalid-blob", "the snapshot changed while it was read")
    return buf
