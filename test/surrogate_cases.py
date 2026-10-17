# Lone surrogates through str.encode and bytes.decode, every codec and error
# handler as CPython 3.14's (sage2's time/datetime cases found
# '\ud800'.encode('utf-8') giving b'\xef\xbf\xbd'): compared with CPython by
# test/unicode-errors.test.ts


def t(label, f):
    try:
        print(label, repr(f()))
    except Exception as e:
        print(label, type(e).__name__, e)


S = ["\ud800", "a\udfffb", "\udc80", "x😀y", "\ud83d", "ab\udcff", "\udc00\ud800", "\U0001f600\ud800"]
CODECS = ["utf-8", "utf8", "UTF-8", "utf-16", "utf-16-le", "utf-16-be", "utf-32", "utf-32-le", "utf-32-be", "ascii", "latin-1", "cp1252"]
ERRORS = ["strict", "surrogatepass", "surrogateescape", "replace", "ignore", "backslashreplace", "xmlcharrefreplace", "namereplace"]
for s in S:
    for c in CODECS:
        for e in ERRORS:
            # (namereplace of a named character needs Unicode's names, which
            # Sagebrush has no table of yet: refused, test/unicode-errors.test.ts)
            if e == "namereplace" and "\U0001f600" in s and c in ("ascii", "latin-1", "cp1252"):
                continue
            t("encode %r %s %s" % (s, c, e), lambda s=s, c=c, e=e: s.encode(c, e))
t("encode default", lambda: "\ud800".encode())
t("encode kw", lambda: "\ud800".encode(errors="surrogatepass"))
# (and back)
for b in (b"\xed\xa0\x80", b"a\xed\xbf\xbfb", b"\x80", b"\xff\xfe", b"\xed\xb2\x80", b"\xf0\x9f\x98\x80"):
    for e in ("strict", "surrogatepass", "surrogateescape", "replace", "ignore", "backslashreplace"):
        t("decode %r utf-8 %s" % (b, e), lambda b=b, e=e: b.decode("utf-8", e))
for b in (b"\x00\xd8", b"\x00\xd8\x00\xdc", b"\x00\xdc"):
    for e in ("strict", "surrogatepass", "replace"):
        t("decode %r utf-16-le %s" % (b, e), lambda b=b, e=e: b.decode("utf-16-le", e))
# (round trips)
t("surrogateescape round trip", lambda: b"\xff\xfe".decode("utf-8", "surrogateescape").encode("utf-8", "surrogateescape"))
t("surrogatepass round trip", lambda: "\ud800".encode("utf-8", "surrogatepass").decode("utf-8", "surrogatepass") == "\ud800")
t("str() of a lone surrogate", lambda: str(b"\xed\xa0\x80", "utf-8", "surrogatepass"))
t("print-free len", lambda: len("\ud800".encode("utf-16", "surrogatepass")))
