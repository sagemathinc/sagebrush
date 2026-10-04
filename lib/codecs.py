"""A small codecs module: BOM constants, encode/decode, lookup."""

BOM_UTF8 = b"\xef\xbb\xbf"
BOM_LE = BOM_UTF16_LE = b"\xff\xfe"
BOM_BE = BOM_UTF16_BE = b"\xfe\xff"
BOM_UTF32_LE = b"\xff\xfe\x00\x00"
BOM_UTF32_BE = b"\x00\x00\xfe\xff"
BOM = BOM_UTF16 = BOM_UTF16_LE
BOM_UTF32 = BOM_UTF32_LE


def encode(obj, encoding="utf-8", errors="strict"):
    return obj.encode(encoding, errors)


def decode(obj, encoding="utf-8", errors="strict"):
    return bytes(obj).decode(encoding, errors)


class CodecInfo(tuple):
    def __new__(cls, encode, decode, name=None, **kw):
        self = tuple.__new__(cls, (encode, decode, None, None))
        self.name = name
        self.encode = encode
        self.decode = decode
        return self


def lookup(encoding):
    name = encoding.lower().replace("_", "-")
    if name in ("utf8", "utf-8", "u8"):
        name = "utf-8"
    elif name in ("ascii", "us-ascii"):
        name = "ascii"
    elif name in ("latin1", "latin-1", "iso-8859-1", "iso8859-1", "l1"):
        name = "latin-1"
    else:
        raise LookupError("unknown encoding: " + encoding)
    return CodecInfo(lambda s, errors="strict": (s.encode(name, errors), len(s)),
                     lambda b, errors="strict": (bytes(b).decode(name, errors), len(b)), name=name)
