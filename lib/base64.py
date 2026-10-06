"""base64 (the common part of CPython's module), over the native binascii."""

import binascii

__all__ = ["b64encode", "b64decode", "standard_b64encode", "standard_b64decode",
           "urlsafe_b64encode", "urlsafe_b64decode", "b16encode", "b16decode",
           "encodebytes", "decodebytes"]


def _bytes(s):
    if isinstance(s, str):
        return s.encode("ascii")
    return bytes(s)


def b64encode(s, altchars=None):
    r = binascii.b2a_base64(_bytes(s), newline=False)
    if altchars is not None:
        a = _bytes(altchars)
        r = r.replace(b"+", a[0:1]).replace(b"/", a[1:2])
    return r


def b64decode(s, altchars=None, validate=False):
    s = _bytes(s)
    if altchars is not None:
        a = _bytes(altchars)
        s = s.replace(a[0:1], b"+").replace(a[1:2], b"/")
    return binascii.a2b_base64(s)


def standard_b64encode(s):
    return b64encode(s)


def standard_b64decode(s):
    return b64decode(s)


def urlsafe_b64encode(s):
    return b64encode(s, b"-_")


def urlsafe_b64decode(s):
    return binascii.a2b_base64(_bytes(s))  # (- and _ are accepted)


def b16encode(s):
    return binascii.hexlify(_bytes(s)).upper()


def b16decode(s, casefold=False):
    s = _bytes(s)
    if casefold:
        s = s.lower()
    return binascii.unhexlify(s.lower())


def encodebytes(s):
    s = _bytes(s)
    out = []
    for i in range(0, len(s), 57):
        out.append(binascii.b2a_base64(s[i:i + 57]))
    return b"".join(out)


def decodebytes(s):
    return binascii.a2b_base64(_bytes(s))
