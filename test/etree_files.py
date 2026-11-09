# xml.etree's file paths (P3c-2, the design note's inventory): every open() the package makes, under a spy on
# builtins.open, in the current directory. parse and iterparse read a path through open(); write writes through
# open(); ElementInclude's default_loader reads an href through open() only when a program calls include(). Parsing a
# document that has an xi:include, an external entity or a DTD opens nothing. The output is CPython 3.14.10's
# (python3 -I), the same on the CLI's file system and the browser worker's.
import builtins
import io
import os
import sys
import warnings

sys.modules["_elementtree"] = None
warnings.simplefilter("error")
import xml.etree.ElementTree as ET
from xml.etree import ElementInclude

opened = []
_open = builtins.open


def spy(file, mode="r", *a, **k):
    opened.append((os.path.basename(file) if isinstance(file, str) else type(file).__name__, mode))
    return _open(file, mode, *a, **k)


def rd(n):
    with _open(n, "rb") as f:
        return f.read()


def parse_open(n, f):
    with _open(n, "rb") as fo:
        return f(fo)


def t(f):
    try:
        return repr(f())
    except Exception as e:
        return type(e).__name__ + ": " + str(e)


def step(what, f):
    del opened[:]
    builtins.open = spy
    try:
        r = t(f)
    finally:
        builtins.open = _open
    print(what, "->", r, "| opened:", opened)


SVG = ('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="10" height="10">'
       '<g id="g1"><path d="M0 0L10 10" style="stroke:#000"/><text x="1" y="2">café &amp; tea</text></g>'
       '<use xlink:href="#g1"/></svg>')
with _open("plot.svg", "w", encoding="utf-8") as f:
    f.write(SVG)

step("parse(path)", lambda: ET.parse("plot.svg").getroot().tag)
step("parse(file object)", lambda: parse_open("plot.svg", lambda fo: ET.parse(fo).getroot()[0].get("id")))
step("iterparse(path)", lambda: [(e, x.tag.split("}")[1]) for e, x in ET.iterparse("plot.svg", events=("end",))])
step("XMLPullParser over read bytes", lambda: (lambda p: (p.feed(rd("plot.svg")), [e for e, _ in p.read_events()])[1])(ET.XMLPullParser(("start", "end"))))
step("canonicalize(from_file=path)", lambda: ET.canonicalize(from_file="plot.svg")[:60])

tree = ET.parse("plot.svg")
step("write(path)", lambda: tree.write("out.svg"))
step("write(path, utf-8, declaration)", lambda: tree.write("out8.svg", encoding="utf-8", xml_declaration=True))
step("write(path, unicode)", lambda: tree.write("outu.svg", encoding="unicode"))
step("write(file object)", lambda: tree.write(io.BytesIO()))
# (the default: us-ascii, each character outside it a character reference, written through open()'s error handler)
print(rd("out.svg"))
print(rd("out8.svg")[:80])
print(rd("outu.svg") == rd("out8.svg").split(b"\n", 1)[1])
step("write(path, latin-1)", lambda: tree.write("out.svg", encoding="latin-1"))
print(rd("out.svg")[-90:])

# (an include: parsing opens nothing; include() opens each href through the default loader, as text or as XML)
with _open("part.xml", "w") as f:
    f.write("<part n='1'>included</part>")
with _open("note.txt", "w") as f:
    f.write("plain text")
DOC = ('<doc xmlns:xi="http://www.w3.org/2001/XInclude"><xi:include href="part.xml"/>'
       '<p><xi:include href="note.txt" parse="text"/></p></doc>')
step("fromstring of a document with xi:include", lambda: len(ET.fromstring(DOC)))
root = ET.fromstring(DOC)
step("ElementInclude.include", lambda: ElementInclude.include(root))
print(ET.tostring(root))
step("include of a missing href", lambda: ElementInclude.include(ET.fromstring('<d xmlns:xi="http://www.w3.org/2001/XInclude"><xi:include href="nope.xml"/></d>')))
step("include with a loader of its own", lambda: ET.tostring(ElementInclude.include(ET.fromstring(DOC), loader=lambda href, parse, encoding=None: "L:" + href if parse == "text" else ET.Element("L", h=href)) or b""))

# (external forms: never resolved, never opened)
step("an external entity", lambda: ET.fromstring('<!DOCTYPE d [<!ENTITY e SYSTEM "part.xml">]><d>&e;</d>'))
step("an external DTD", lambda: ET.fromstring('<!DOCTYPE d SYSTEM "part.xml"><d>x</d>').text)
step("parse of a missing path", lambda: ET.parse("missing.svg"))
for n in ("plot.svg", "out.svg", "out8.svg", "outu.svg", "part.xml", "note.txt"):
    os.remove(n)
print(sorted(n for n in os.listdir(".") if n.endswith((".svg", ".xml", ".txt"))))
