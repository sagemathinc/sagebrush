# html and html.entities (lib/html, CPython 3.14's), compared with CPython
# 3.14 by test/stdlib-html-importlib.test.ts
import html
import html.entities as E
import zlib


def show(label, f):
    try:
        print(label, "->", ascii(f()))
    except Exception as e:
        print(label, "raises", type(e).__name__, e)


# escape: the five specials, quote on and off, and not a str
for s in ["", "plain", "<a href=\"x\">&'</a>", "&amp;", "''\"\"", "é<\U0001f600>"]:
    show("escape %s" % ascii(s), lambda: html.escape(s))
    show("escape quote=False %s" % ascii(s), lambda: html.escape(s, quote=False))
show("escape bytes", lambda: html.escape(b"<"))
show("escape None", lambda: html.escape(None))

# unescape: named references with and without ";", the longest prefix of a
# name without one, numeric ones in both bases, and the invalid ones
cases = [
    "no references", "&amp;", "&amp", "&ampx", "&AMP;", "&notit;", "&notin;", "&not", "&noti",
    "&lt;&gt;&quot;&apos;", "&apos", "&unknown;", "& amp;", "&;", "&#", "&#;", "&#x;", "&#X41;",
    "&#65;", "&#65", "&#x41", "&#0;", "&#x80;", "&#x9F;", "&#129;", "&#xD800;", "&#xDFFF;",
    "&#x10FFFF;", "&#x110000;", "&#1114112;", "&#xFFFE;", "&#x1FFFF;", "&#11;", "&#x0D;",
    "&#13;", "&#127;", "&#x7F;", "&#00065;", "&#x0041;", "&CounterClockwiseContourIntegral;",
    "&CounterClockwiseContourIntegral", "&" + "a" * 33 + ";", "&eacute&Eacute;&eacutex",
    "&nbsp&nbsp;", "a&b&c;", "&#x" + "f" * 40 + ";", "&#" + "9" * 4000 + ";",
]
for s in cases:
    show("unescape %s" % ascii(s[:60]), lambda: html.unescape(s))
show("unescape 5000 digits", lambda: html.unescape("&#" + "9" * 5000 + ";"))
show("unescape bytes", lambda: html.unescape(b"&amp;"))
show("unescape None", lambda: html.unescape(None))

# every HTML5 entity, with and without a following letter, as one digest
acc = 0
for name in sorted(E.html5):
    for s in ("&" + name, "&" + name + "z", "x&" + name + "&amp;"):
        acc = zlib.crc32(html.unescape(s).encode("utf-8", "surrogatepass"), acc)
print("html5 unescape digest", len(E.html5), acc)

# the tables
print("tables", len(E.name2codepoint), len(E.codepoint2name), len(E.entitydefs), len(E.html5))
print("name2codepoint", E.name2codepoint["amp"], E.name2codepoint["euro"], E.name2codepoint["thetasym"])
print("codepoint2name", E.codepoint2name[38], E.codepoint2name[8364], E.codepoint2name[977])
print("entitydefs", ascii(E.entitydefs["amp"]), ascii(E.entitydefs["euro"]), ascii(E.entitydefs["nbsp"]))
print("html5", ascii(E.html5["amp;"]), ascii(E.html5["amp"]), ascii(E.html5["NotEqualTilde;"]), ascii(E.html5["fjlig;"]))
print("digests", zlib.crc32(repr(sorted(E.name2codepoint.items())).encode()),
      zlib.crc32(repr(sorted(E.codepoint2name.items())).encode()),
      zlib.crc32(ascii(sorted(E.entitydefs.items())).encode()),
      zlib.crc32(ascii(sorted(E.html5.items())).encode()))
print("all", sorted(html.__all__), sorted(E.__all__))
