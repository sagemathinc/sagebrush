# xml.etree.ElementTree, CPython 3.14.10's unchanged, over Sagebrush's pyexpat (P3c-2): each case prints what
# a program sees, and test/etree_cases.out is CPython 3.14.10's output (python3 -I). Deterministic: no ids or
# addresses are printed (a factory such as ET.Comment is shown by its name). The C accelerator is blocked so the
# oracle runs CPython's pure-Python ElementTree, the code Sagebrush ships; warnings are errors, so t() shows them.
import sys
import warnings

sys.modules["_elementtree"] = None
warnings.simplefilter("error")
import io
import xml.etree.ElementTree as ET
from xml.etree import ElementPath, ElementInclude


def t(f):
    try:
        return repr(f())
    except Exception as e:
        return type(e).__name__ + ": " + str(e)


def dump(e, depth=0):
    tag = e.tag if isinstance(e.tag, str) else getattr(e.tag, "__name__", "?")
    print("  " * depth + repr(tag), sorted(e.attrib.items()), repr(e.text), repr(e.tail))
    for c in e:
        dump(c, depth + 1)


def perr(f):
    try:
        f()
        print("no error")
    except ET.ParseError as e:
        print("ParseError", e.code, e.position, str(e))


print("-- fromstring, attributes, text and tail")
root = ET.fromstring('<a x="1" y=\'2\'>text<b>in b</b>tail of b<c/>tail of c</a>')
dump(root)
print(root.get("x"), root.get("missing"), root.get("missing", "dflt"), sorted(root.keys()), sorted(root.items()))
print(len(root), [c.tag for c in root], root[0].tag, root[-1].tag, [e.tag for e in root.iter("c")])
print(repr(ET.tostring(root)), repr(ET.tostring(root, encoding="unicode")))

print("-- the friction shapes: an SVG read by tag with namespaces")
svg = '''<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="100" height="50" viewBox="0 0 100 50">
  <!-- a comment -->
  <defs><path id="p0" d="M 0 0 L 10 10"/></defs>
  <g id="figure_1" transform="translate(1,2)">
    <rect x="0" y="0" width="100" height="50" style="fill:#ffffff"/>
    <use xlink:href="#p0" x="5" y="5"/>
    <text x="10" y="20">Résumé &amp; &lt;tags&gt; &#x3b1;&#946;</text>
    <g id="axes_1"><path d="M 1 2 C 3 4 5 6 7 8 Z" style="stroke:#1f77b4"/></g>
  </g>
</svg>'''
r = ET.fromstring(svg)
NS = {"svg": "http://www.w3.org/2000/svg", "xlink": "http://www.w3.org/1999/xlink"}
print(r.tag, r.attrib)
print([e.tag for e in r.iter()])
print([e.get("id") for e in r.iter("{http://www.w3.org/2000/svg}g")])
print([e.get("d") for e in r.findall(".//svg:path", NS)])
print([e.get("{http://www.w3.org/1999/xlink}href") for e in r.iter("{http://www.w3.org/2000/svg}use")])
print(repr("".join(r.itertext())))
print(r.find("svg:g/svg:text", NS).text, r.findtext(".//svg:text", namespaces=NS))
print(r.find(".//{*}rect").attrib, [e.tag for e in r.findall("{*}g/{*}g")])
tree = ET.ElementTree(r)
print(tree.getroot() is r, [e.tag for e in tree.iterfind(".//{*}path")])

print("-- ElementPath")
doc = ET.fromstring('<r><i n="1" k="a">x</i><i n="2" k="b"><j>y</j></i><i n="3">z</i><g><i n="4" k="a"/></g></r>')
for path in ("i", "./i", ".//i", "i[@k]", "i[@k='a']", ".//i[@k='a']", "i[1]", "i[last()]", "i[last()-1]", "i[j]", "i[j='y']", "*", ".//*", "g/i", "..", ".", "i[.='x']", "i[@n!='2']", ".//j/..", "i[2]/j"):
    print(repr(path), t(lambda: [(e.tag, e.get("n")) for e in doc.findall(path)]))
print(t(lambda: doc.find("i").get("n")), t(lambda: doc.findtext("i")), t(lambda: doc.findtext("nope", "dflt")))
print(t(lambda: doc.findall("i[")), t(lambda: doc.findall("/i")))
print(t(lambda: list(ElementPath.iterfind(doc, "g/i"))[0].get("n")))

print("-- building trees, SubElement, mutation")
a = ET.Element("a", {"x": "1"}, y="2")
b = ET.SubElement(a, "b", z="3")
b.text = "bee"
c = ET.SubElement(a, "c")
c.tail = "after c"
a.insert(0, ET.Comment(" c1 "))
a.append(ET.ProcessingInstruction("pi", "data here"))
a.set("w", "4")
print(repr(ET.tostring(a, encoding="unicode")))
a.remove(b)
print(repr(ET.tostring(a, encoding="unicode")), len(a))
d = ET.Element("d")
d.extend([ET.Element("e1"), ET.Element("e2")])
d[0:1] = [ET.Element("e0")]
del d[1]
print([x.tag for x in d], t(lambda: d.remove(ET.Element("zz"))))
a.clear()
print(repr(ET.tostring(a, encoding="unicode")), a.attrib)
print(t(lambda: ET.Element("x", 1)), t(lambda: ET.SubElement(None, "x")))
e = ET.Element("q")
e2 = e.makeelement("r", {"s": "t"})
print(e2.tag, e2.attrib, ET.iselement(e2), ET.iselement("x"))

print("-- serialization: tostring, methods, encodings, xml_declaration, short_empty_elements, escaping")
s = ET.fromstring('<a b="&lt;&amp;&quot;\n&#9;x"><c/>t &lt; &gt; &amp; "q" \'a\'<d></d></a>')
for kw in ({}, {"encoding": "unicode"}, {"encoding": "us-ascii"}, {"encoding": "utf-8"}, {"encoding": "UTF-8"}, {"encoding": "iso-8859-1"}, {"encoding": "utf-16"},
           {"method": "html"}, {"method": "text"}, {"short_empty_elements": False}, {"xml_declaration": True}, {"xml_declaration": True, "encoding": "unicode"},
           {"default_namespace": "urn:d"}, {"encoding": "utf-8", "xml_declaration": False}):
    print(sorted(kw.items()), t(lambda: ET.tostring(s, **kw)))
print(t(lambda: ET.tostringlist(s, encoding="unicode")))
u = ET.Element("u")
u.text = "ü€😀 \x00?"[:-3] + "\r\n"
print(t(lambda: ET.tostring(u)), t(lambda: ET.tostring(u, encoding="unicode")), t(lambda: ET.tostring(u, encoding="ascii")))
h = ET.fromstring("<html><head><script>if (a &lt; b &amp;&amp; c) {}</script><style>p > q {}</style></head><body><br/><p>x<img src='i'/></p><textarea></textarea></body></html>")
print(t(lambda: ET.tostring(h, method="html", encoding="unicode")))

print("-- namespaces in output: register_namespace, prefixes, default_namespace")
ET.register_namespace("my", "urn:mine")
n = ET.Element("{urn:mine}root")
ET.SubElement(n, "{urn:mine}kid", {"{urn:other}attr": "v", "plain": "p"})
ET.SubElement(n, "{urn:third}x")
print(t(lambda: ET.tostring(n, encoding="unicode")))
print(t(lambda: ET.tostring(n, encoding="unicode", default_namespace="urn:mine")))
print(t(lambda: ET.register_namespace("ns0", "urn:bad")), t(lambda: ET.register_namespace("1bad", "urn:x")))
print(t(lambda: ET.tostring(ET.Element("{urn:z}plain"), encoding="unicode", default_namespace="urn:other")))

print("-- indent")
ind = ET.fromstring("<a><b><c>t</c><d/></b><e>  </e><f/></a>")
ET.indent(ind)
print(repr(ET.tostring(ind, encoding="unicode")))
ET.indent(ind, space="\t", level=1)
print(repr(ET.tostring(ind, encoding="unicode")))
print(t(lambda: ET.indent(ind, level=-1)))
ET.indent(ET.ElementTree(ind), space="")
print(repr(ET.tostring(ind, encoding="unicode")))

print("-- iterparse and XMLPullParser events")
data = b'<?xml version="1.0"?><r xmlns="urn:a" xmlns:p="urn:p"><!--c--><?pi d?><p:x a="1">t<y/>u</p:x></r>'
for events in (None, ("start",), ("end",), ("start", "end"), ("start", "end", "start-ns", "end-ns", "comment", "pi")):
    out = []
    for ev, el in ET.iterparse(io.BytesIO(data), events=events):
        if ev in ("start", "end"):
            out.append((ev, el.tag))
        elif ev == "start-ns":
            out.append((ev, el))
        elif ev == "end-ns":
            out.append((ev, el))
        elif ev == "comment":
            out.append((ev, el.text))
        else:
            out.append((ev, el.tag is ET.PI, el.text))
    print(events, out)
it = ET.iterparse(io.BytesIO(b"<a><b/></a>"))
print(next(it)[1].tag, it.root, next(it)[1].tag, it.root, t(lambda: next(it)), it.root.tag)
print(t(lambda: list(ET.iterparse(io.BytesIO(b"<a><b></a>")))), t(lambda: list(ET.iterparse(io.BytesIO(b"<a/>"), events=("bogus",)))))
pp = ET.XMLPullParser(events=("start", "end", "start-ns", "end-ns"))
for chunk in (b"<r xmlns:q='urn:q'><q:", b"a>te", b"xt</q:a><b", b"/></r>"):
    pp.feed(chunk)
    print([(ev, el if isinstance(el, tuple) or el is None else el.tag) for ev, el in pp.read_events()])
pp.close()
print(list(pp.read_events()))
pp2 = ET.XMLPullParser()
pp2.feed("<a>")
print(t(lambda: pp2.close()))
pp3 = ET.XMLPullParser(["end"])
pp3.feed("<a><b>1</b>")
pp3.flush()
print([e.tag for _, e in pp3.read_events()])

print("-- XMLParser, TreeBuilder, targets")


class Target:
    def __init__(self):
        self.log = []

    def start(self, tag, attrib):
        self.log.append(("start", tag, sorted(attrib.items())))

    def end(self, tag):
        self.log.append(("end", tag))

    def data(self, d):
        self.log.append(("data", d))

    def comment(self, text):
        self.log.append(("comment", text))

    def pi(self, target, text):
        self.log.append(("pi", target, text))

    def start_ns(self, prefix, uri):
        self.log.append(("start_ns", prefix, uri))

    def end_ns(self, prefix):
        self.log.append(("end_ns", prefix))

    def doctype(self, name, pubid, system):
        self.log.append(("doctype", name, pubid, system))

    def close(self):
        return self.log


tp = ET.XMLParser(target=Target())
tp.feed('<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd"><r xmlns:n="urn:n">a<!--c--><?p q?><n:e k="v">b&amp;c</n:e></r>')
for entry in tp.close():
    print(entry)
tb = ET.TreeBuilder(comment_factory=ET.Comment, pi_factory=ET.PI, insert_comments=True, insert_pis=True)
p2 = ET.XMLParser(target=tb)
p2.feed("<a><!--x--><?y z?></a>")
r2 = p2.close()
print([(c.tag.__name__, c.text) for c in r2])
print(ET.XMLParser().version, t(lambda: ET.XMLParser(encoding="klingon").feed(b"<a/>")))
print(t(lambda: ET.fromstring(b'<?xml version="1.0" encoding="iso-8859-1"?><a>\xe9</a>').text))
print(t(lambda: ET.fromstring('<?xml version="1.0" encoding="iso-8859-1"?><a>é</a>').text))
print(t(lambda: ET.fromstring(b"\xff\xfe<\x00a\x00/\x00>\x00").tag), t(lambda: ET.fromstring(b'<a>\xc3</a>')))
print(t(lambda: ET.XML('<a b="1"/>').attrib), t(lambda: ET.XMLID('<a id="1"><b id="2"/></a>')[1].keys()))
print(t(lambda: [e.tag for e in ET.fromstringlist(["<a>", "<b/>", "</a>"])]))

print("-- ParseError: code, position and message")
for bad in ("<a>", "<a></b>", '<a x="1" x="2"/>', "<a>&foo;</a>", "", "   ", "<a/><b/>", "<a", "<a>\n  <b>\n</a>", "<?xml version='1.0'?><?xml version='1.0'?><a/>",
            "<a>&#0;</a>", "<a>&#xD800;</a>", "<a b=c/>", "<1a/>", "<a><![CDATA[x]]</a>", "<!DOCTYPE a [<!ENTITY e SYSTEM 'x'>]><a>&e;</a>", "<a>\x01</a>", "<a:b/>",
            "<x:a xmlns:x='u'><y:b/></x:a>", "text", "<a>]]></a>"):
    print(repr(bad), end=" ")
    perr(lambda: ET.fromstring(bad))
e = None
try:
    ET.fromstring("<a>\n<b></c>")
except ET.ParseError as err:
    e = err
print(type(e).__mro__[1].__name__, e.lineno, e.offset, e.msg, e.position, e.code)

print("-- entities, CDATA, whitespace, line ends")
x = ET.fromstring('<!DOCTYPE r [<!ENTITY who "World"><!ENTITY both "&who; &amp; &#65;">]><r a="&who;">Hello &who;! &both; <![CDATA[<raw> & ]]> &#x1F600;</r>')
print(repr(x.text), x.attrib)
y = ET.fromstring("<r>\r\n line\rnext\n<s>  </s>\t</r>")
print(repr(y.text), repr(y[0].text), repr(y[0].tail))
z = ET.fromstring('<r a="  x\n\ty  " b="&#10;&#9;"/>')
print(z.attrib)

print("-- canonicalize (C14N 2.0)")
cdoc = '<root xmlns="urn:r" xmlns:u="urn:unused"><!--c--><b  z="1" a="2">  t  <c/></b><?pi x?></root>'
print(repr(ET.canonicalize(cdoc)))
print(repr(ET.canonicalize(cdoc, with_comments=True)))
print(repr(ET.canonicalize(cdoc, strip_text=True)))
print(repr(ET.canonicalize(cdoc, rewrite_prefixes=True)))
print(repr(ET.canonicalize(cdoc, exclude_tags=["{urn:r}c"])))
print(repr(ET.canonicalize(cdoc, exclude_attrs=["z"])))
out = io.StringIO()
ET.canonicalize(cdoc, out=out)
print(repr(out.getvalue()))
print(t(lambda: ET.canonicalize()), t(lambda: ET.canonicalize("<a/>", from_file=io.StringIO("<b/>"))))

print("-- ElementTree: write to a file object, parse a file object")
tr = ET.ElementTree(ET.fromstring("<a><b>é</b></a>"))
for kw in ({}, {"encoding": "unicode"}, {"encoding": "utf-8", "xml_declaration": True}, {"method": "text", "encoding": "unicode"}):
    buf = io.StringIO() if kw.get("encoding") == "unicode" else io.BytesIO()
    tr.write(buf, **kw)
    print(sorted(kw.items()), repr(buf.getvalue()))
print(t(lambda: ET.parse(io.BytesIO(b"<x><y/></x>")).getroot()[0].tag), t(lambda: ET.parse(io.StringIO("<x/>")).getroot().tag))
print(t(lambda: tr.find("b").text), t(lambda: tr.findall(".//b")[0].tag), t(lambda: tr.findall("/b")))
print(t(lambda: ET.ElementTree().getroot()), t(lambda: ET.ElementTree("notelement")))

print("-- ElementInclude with a loader (no file is opened)")
inc = ET.fromstring('<doc xmlns:xi="http://www.w3.org/2001/XInclude"><xi:include href="part.xml"/><xi:include href="t.txt" parse="text"/></doc>')


def loader(href, parse, encoding=None):
    return ET.fromstring("<part>p</part>") if parse == "xml" else "plain text"


ElementInclude.include(inc, loader=loader)
print(repr(ET.tostring(inc, encoding="unicode")))
loop = ET.fromstring('<doc xmlns:xi="http://www.w3.org/2001/XInclude"><xi:include href="self.xml"/></doc>')
print(t(lambda: ElementInclude.include(loop, loader=lambda h, p, e=None: ET.fromstring('<d xmlns:xi="http://www.w3.org/2001/XInclude"><xi:include href="self.xml"/></d>'))))
print(t(lambda: ElementInclude.include(ET.fromstring('<d xmlns:xi="http://www.w3.org/2001/XInclude"><xi:include href="a" parse="bogus"/></d>'), loader=loader)))

print("-- the module's surface")
print(sorted(n for n in ET.__all__))
print(ET.VERSION, ET.ParseError.__mro__[1].__name__, ET.Element.__module__, ET.XMLParser.__module__)
print(t(lambda: __import__("xml.etree.cElementTree").__name__), "xml.etree.cElementTree" in sys.modules)
el = ET.Element("x")
print(t(lambda: bool(el)), t(lambda: el.getchildren()))


def copy_check():
    import copy
    src = ET.fromstring('<a k="v"><b>t</b></a>')
    c1, c2 = copy.copy(src), copy.deepcopy(src)
    c2[0].text = "changed"
    return (c1[0] is src[0], c2[0] is src[0], src[0].text, c2[0].text)


print(t(copy_check))
import pickle
pk = pickle.loads(pickle.dumps(ET.fromstring('<a k="v"><b>t</b></a>')))
print(pk.tag, pk.attrib, pk[0].text)
