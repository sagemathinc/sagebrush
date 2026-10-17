# Sagebrush: _codecs, CPython's C codecs module, for its encode and decode
# (lib/codecs.py imports them, as CPython's codecs.py does), so that what
# names them, a protocol 2 pickle of bytes, names _codecs.encode, as
# CPython's: such a pickle loads in either.


def encode(obj, encoding="utf-8", errors="strict"):
    return obj.encode(encoding, errors)


def decode(obj, encoding="utf-8", errors="strict"):
    return bytes(obj).decode(encoding, errors)
