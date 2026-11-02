"""urllib.error for Sagebrush: CPython's URLError and HTTPError (the classes,
attributes and messages programs use), raised by urllib.request's replay
(lib/_sbdata.py).  A url in any of them is already redacted."""

__all__ = ["URLError", "HTTPError"]


class URLError(OSError):
    def __init__(self, reason, filename=None):
        self.args = (reason,)
        self.reason = reason
        if filename is not None:
            self.filename = filename

    def __str__(self):
        return "<urlopen error %s>" % self.reason


class HTTPError(URLError):
    """A pinned response whose status isn't 2xx: also a response, as in
    CPython (code, msg, hdrs/headers, read() of the pinned body)."""

    def __init__(self, url, code, msg, hdrs, fp):
        self.code = code
        self.msg = msg
        self.hdrs = hdrs
        self.fp = fp
        self.url = url
        self.filename = url
        self.args = (msg,)

    @property
    def reason(self):
        return self.msg

    @property
    def headers(self):
        return self.hdrs

    def getcode(self):
        return self.code

    def geturl(self):
        return self.url

    def info(self):
        return self.hdrs

    def read(self, n=-1):
        return self.fp.read(n) if self.fp is not None else b""

    def close(self):
        if self.fp is not None:
            self.fp.close()

    def __str__(self):
        return "HTTP Error %s: %s" % (self.code, self.msg)

    def __repr__(self):
        return "<HTTPError %s: %r>" % (self.code, self.msg)
