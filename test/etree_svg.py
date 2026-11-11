# xml.etree over real SVG files (P3c-2): what a program reading an SVG sees, printed so CPython and Sagebrush can be
# compared line for line. The files are made at test time (Sagebrush's own plots; matplotlib's and Sage's from the
# oracles when they are on the machine), never committed. Usage: etree_svg.py FILE...
import hashlib
import sys
import warnings

sys.modules["_elementtree"] = None
warnings.simplefilter("error")
import xml.etree.ElementTree as ET

NS = {"svg": "http://www.w3.org/2000/svg", "xlink": "http://www.w3.org/1999/xlink"}


def h(b):
    return hashlib.sha256(b if isinstance(b, bytes) else b.encode("utf-8")).hexdigest()[:16]


def local(tag):
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else "?"


for path in sys.argv[1:]:
    root = ET.parse(path).getroot()
    with open(path, "rb") as f:
        data = f.read()
    again = ET.fromstring(data)
    els = list(root.iter())
    counts = {}
    for e in els:
        counts[local(e.tag)] = counts.get(local(e.tag), 0) + 1
    print("file", len(data), "bytes;", len(els), "elements; root", root.tag, sorted(root.attrib.items())[:6])
    print("tags", sorted(counts.items()))
    print("fromstring the same", ET.tostring(again) == ET.tostring(root))
    nss = [ns for ev, ns in ET.iterparse(path, events=("start-ns",))]
    print("namespaces", nss)
    evs = [(ev, e if e is None or isinstance(e, tuple) else e.tag if isinstance(e.tag, str) else (e.tag.__name__, e.text))
           for ev, e in ET.iterparse(path, events=("start", "end", "comment", "pi", "start-ns", "end-ns"))]
    print("iterparse events", len(evs), h(repr(evs)))
    paths = root.findall(".//svg:path", NS)
    print("paths", len(paths), [len(p.get("d", "")) for p in paths[:5]], h("".join(p.get("d", "") for p in paths)))
    print("ids", len(root.findall(".//*[@id]")), [e.get("id") for e in root.findall(".//*[@id]")][:5])
    print("hrefs", [e.get("{%s}href" % NS["xlink"]) or e.get("href") for e in root.iter() if e.get("{%s}href" % NS["xlink"]) or e.get("href")][:5])
    print("text", h("".join(root.itertext())), repr("".join(root.itertext()).split()[:8]))
    print("styles", h(repr([e.get("style") for e in els])))
    print("tostring", h(ET.tostring(root)), "unicode", h(ET.tostring(root, encoding="unicode")))
    ET.indent(again)
    print("indent", h(ET.tostring(again, encoding="unicode")))
    print("canonicalize", h(ET.canonicalize(data.decode("utf-8"))), "strip", h(ET.canonicalize(from_file=path, strip_text=True)))
