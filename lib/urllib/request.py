"""urllib.request for Sagebrush: urlopen replays the folder's .sagebrush-data
snapshot (lib/_sbdata.py; plan-network-data r3, replay-layer r2).  There is
no network path: a url that isn't pinned is a URLError naming the reason.
FRED is fetched live with each reader's own key, which isn't available yet:
its urls are refused before any snapshot is looked at.  Only GET and HEAD,
without Range, conditional or credential headers, are replayed; other
headers are ignored (they are not part of the key)."""

import io

import _sbdata
from urllib.error import URLError, HTTPError

__all__ = ["Request", "urlopen", "URLError", "HTTPError"]

REFUSED_HEADERS = {
    "range": "range", "if-range": "range",
    "if-match": "conditional", "if-none-match": "conditional",
    "if-modified-since": "conditional", "if-unmodified-since": "conditional",
    "authorization": "credential", "proxy-authorization": "credential", "cookie": "credential",
}
REASONS = {200: "OK", 201: "Created", 202: "Accepted", 203: "Non-Authoritative Information", 204: "No Content",
           206: "Partial Content", 301: "Moved Permanently", 302: "Found", 304: "Not Modified", 400: "Bad Request",
           401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 410: "Gone", 429: "Too Many Requests",
           500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable"}


class Request:
    def __init__(self, url, data=None, headers={}, origin_req_host=None, unverifiable=False, method=None):
        self.full_url = url
        self.data = data
        self.headers = {}
        for k, v in headers.items():
            self.add_header(k, v)
        self.method = method

    def add_header(self, key, val):
        self.headers[key.capitalize()] = val

    def get_method(self):
        if self.method is not None:
            return self.method
        return "POST" if self.data is not None else "GET"

    def get_full_url(self):
        return self.full_url


class _Headers:
    def __init__(self, items):
        self._items = list(items)

    def get(self, name, default=None):
        for k, v in self._items:
            if k.lower() == name.lower():
                return v
        return default

    def __getitem__(self, name):
        return self.get(name)

    def __contains__(self, name):
        return self.get(name) is not None

    def items(self):
        return list(self._items)

    def keys(self):
        return [k for k, v in self._items]

    get_content_type = lambda self: (self.get("Content-Type") or "").partition(";")[0].strip()


class _Response(io.BytesIO):
    def __init__(self, body, url, status, headers):
        io.BytesIO.__init__(self, body)
        self.url = url
        self.status = status
        self.code = status
        self.headers = headers
        self.msg = REASONS.get(status, "")
        self.reason = self.msg

    def geturl(self):
        return self.url

    def getcode(self):
        return self.status

    def info(self):
        return self.headers

    def getheader(self, name, default=None):
        return self.headers.get(name, default)

    def getheaders(self):
        return self.headers.items()

    def __repr__(self):
        return "<urllib.request replayed response %s %s>" % (self.status, self.url)


def _error(code, text):
    return URLError("%s: %s" % (code, text))


def urlopen(url, data=None, timeout=None, *, context=None):
    req = url if isinstance(url, Request) else Request(url, data)
    if data is not None:
        req.data = data
    u = req.full_url
    shown = _sbdata.redact(u)
    method = req.get_method()
    for name in req.headers:
        cls = REFUSED_HEADERS.get(name.lower())
        if cls is not None:
            raise _error("header", "request header not supported by replay (%s): %s" % (cls, name))
    if _sbdata.is_fred(u):
        raise _error("fred", "FRED is fetched live with your own key (not available yet)")
    try:
        k = _sbdata.key(method, u)
    except _sbdata.Refused as e:
        if e.code == "method":
            raise _error("method", "only GET and HEAD are replayed: %s" % shown) from None
        raise _error("url-refused", "this url can't be replayed: %s" % shown) from None
    try:
        snapdir, entries = _sbdata.find()
        e = entries.get(k)
        if e is None:
            raise _sbdata.Miss("not-pinned", "not in this folder's snapshot: %s" % shown)
        body = _sbdata.verify(snapdir, e)
    except _sbdata.Miss as m:
        raise _error(m.code, m.text) from None
    headers = _Headers([("Content-Type", e["content_type"]), ("Content-Length", str(len(body)))])
    if not 200 <= e["status"] <= 299:
        raise HTTPError(shown, e["status"], REASONS.get(e["status"], ""), headers, io.BytesIO(body))
    return _Response(body if method == "GET" else b"", shown, e["status"], headers)
