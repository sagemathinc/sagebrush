# Records test/expat_corpus.json from CPython's own pyexpat (P3c-1; design note r3 section 5a, X1): run it with
# CPython 3.14.10, the reference. Every case's handler trace and error come from that pyexpat; nothing here is
# written by hand except the inputs. The test checks the recording's provenance (this file's sha256 and the
# oracle's sys.version) and runs each case on Sagebrush's pyexpat.  Usage: python3 test/gen_expat_corpus.py
import hashlib, json, os, random, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pyexpat
from xml.parsers import expat
from expat_trace import trace

assert sys.version_info[:3] == (3, 14, 10), f"the oracle is CPython 3.14.10, not {sys.version}"

ET_CONFIG = dict(sep="}", buffer_text=True, ordered=True)          # ElementTree's own configuration
RAW_CONFIG = dict(sep=None, buffer_text=False, ordered=False)       # every option the other way (X6)

WELL_FORMED = [
    "<a/>", "<a></a>", "<a>text</a>", "<a b='1' c=\"2\">x</a>", "<a><b/><c>t</c>tail</a>",
    "<?xml version='1.0'?><a/>", "<?xml version=\"1.0\" encoding=\"utf-8\" standalone=\"yes\"?>\n<a/>\n",
    "<a>&lt;&gt;&amp;&apos;&quot;</a>", "<a b='&lt;&amp;&#65;&#x42;'/>", "<a>&#65;&#x1F600;&#xE9;</a>",
    "<a><![CDATA[<raw> & ]]></a>", "<a><!-- comment --></a>", "<!--c--><a/><!--d-->",
    "<?pi data?><a><?target  some data ?></a>", "<a>\n  <b>x</b>\n</a>",
    "<a b='x\ty\nz'/>", "<a b='  sp  '/>", "<a>café 中文 \U0001F600</a>", "<élément atté='v'/>",
    "<a xmlns='urn:d'><b/></a>", "<p:a xmlns:p='urn:p'><p:b p:at='1' at='2'/></p:a>",
    "<a xmlns='urn:d'><b xmlns=''/></a>", "<a xmlns:p='urn:p' xmlns:q='urn:q'><p:b q:c='1'/></a>",
    "<a xml:lang='en' xml:space='preserve'/>",
    "<!DOCTYPE a><a/>", "<!DOCTYPE a SYSTEM 'a.dtd'><a/>", "<!DOCTYPE a PUBLIC '-//X//EN' 'a.dtd'><a/>",
    "<!DOCTYPE a [<!ENTITY e 'replaced'>]><a>&e;</a>",
    "<!DOCTYPE a [<!ENTITY e '<b>in</b>'>]><a>&e;&e;</a>",
    "<!DOCTYPE a [<!ENTITY e 'x'><!ENTITY f '&e;&e;'>]><a at='&f;'>&f;</a>",
    "<!DOCTYPE a [<!ATTLIST a d CDATA 'def'>]><a/>", "<!DOCTYPE a [<!ATTLIST a d CDATA 'def'>]><a d='own'/>",
    "<!DOCTYPE a [<!ELEMENT a (#PCDATA)><!ATTLIST a id ID #IMPLIED>]><a id='i'/>",
    "<!DOCTYPE a [<!ENTITY % pe 'x'><!-- c --><?pi in dtd?>]><a/>",
    "<!DOCTYPE a SYSTEM 'ext.dtd'><a>&undeclared;</a>",
    "<!DOCTYPE a [<!ENTITY ext SYSTEM 'file.xml'>]><a>&ext;</a>",
    "<a>]]</a>", "<a>]</a>", "<a>x&#13;y</a>",
]

LINE_ENDS = ["<a>\r\n<b/>\r\n</a>", "<a>\r<b/>\r</a>", "<a\r\nb='1\r\n2'/>", "<a>x\r\n\r\ny</a>\r\n"]

MALFORMED = [
    "", "   ", "<a>", "<a></b>", "<a x='1' x='2'/>", "<a>&foo;</a>", "<a/><b/>", "<a/>junk", "text", "<a>&#0;</a>",
    "<a>&#xD800;</a>", "<a b=1/>", "<a b='1'c='2'/>", "<a <b/>", "<a>< /a>", "<1a/>", "<a>\x01</a>", "<a/",
    "<a><![CDATA[x</a>", "<a><!-- x -- y --></a>", "<?xml version='1.0'?><?xml version='1.0'?><a/>",
    " <?xml version='1.0'?><a/>", "<?xml version='2.0'?><a/>", "<?xml encoding='utf-8'?><a/>",
    "<p:a/>", "<a xmlns:p=''/>", "<a xmlns:xml='urn:x'/>", "<a xmlns:xmlns='urn:x'/>",
    "<a xmlns:p='http://www.w3.org/XML/1998/namespace'/>", "<!DOCTYPE a [<!ENTITY e '&e;'>]><a>&e;</a>",
    "<!DOCTYPE a [<!ENTITY e '&f;'><!ENTITY f '&e;'>]><a>&e;</a>", "<!DOCTYPE a [<!ENTITY e 'x'>]><a b='&e'/>",
    "<!DOCTYPE a [<!ENTITY bin SYSTEM 'x' NDATA n>]><a>&bin;</a>",
    "<!DOCTYPE a [<!ENTITY ext SYSTEM 'f.xml'>]><a b='&ext;'/>",
    "<!DOCTYPE a [<!ENTITY e '<b>'>]><a>&e;</b></a>", "<!DOCTYPE a PUBLIC 'bad\x7f' 'x'><a/>",
    "<!DOCTYPE a [ %pe; ]><a/>", "<!DOCTYPE a [<!ENTITY e 'x'>]><a>&e</a>", "<a>&#x110000;</a>", "<a>&#65</a>",
    "<!DOCTYPE a><!DOCTYPE b><a/>", "<a></a><!DOCTYPE a>", "<a b='<'/>", "<a>x</a >tail",
    "<?xml version='1.0' standalone='no'?><!DOCTYPE a SYSTEM 'x'><a>&u;</a>",
    "<?xml version='1.0' standalone='yes'?><!DOCTYPE a SYSTEM 'x'><a>&u;</a>",
]

ENCODED = [
    ("utf-8", "<a>café</a>".encode("utf-8")),
    ("bom", b"\xef\xbb\xbf<a>caf\xc3\xa9</a>"),
    ("utf-16-le", "﻿<a>café \U0001F600</a>".encode("utf-16-le")),
    ("utf-16-be", "﻿<a>café</a>".encode("utf-16-be")),
    ("latin-1 decl", "<?xml version='1.0' encoding='ISO-8859-1'?><a>café</a>".encode("latin-1")),
    ("ascii decl", b"<?xml version='1.0' encoding='US-ASCII'?><a>x</a>"),
    ("cp1252 decl", "<?xml version='1.0' encoding='windows-1252'?><a>€</a>".encode("cp1252")),
    ("bad utf-8", b"<a>\xff</a>"),
    ("truncated utf-8", b"<a>\xc3"),
    ("klingon", b"<?xml version='1.0' encoding='klingon'?><a/>"),
    ("utf-16 decl, utf-8 bytes", b"<?xml version='1.0' encoding='utf-16'?><a/>"),
    ("non-ascii positions", "<a>ééé<b>\né</c></a>".encode("utf-8")),
]


MORE_WELL_FORMED = [
    "<?xml version='1.0' encoding='UTF-8' standalone='no'?><a/>", "<a><![CDATA[x\r\ny]]>z</a>",
    "<!DOCTYPE a [<!ENTITY e 'v'><!ENTITY f SYSTEM 'x.xml'><!ENTITY g PUBLIC '-//p//EN' 'g.xml'>"
    "<!NOTATION n SYSTEM 'n.exe'><!NOTATION m PUBLIC '-//m//EN'><!ENTITY u SYSTEM 'u.bin' NDATA n>"
    "<!ATTLIST a x (p|q) 'p' y NOTATION (n|m) #IMPLIED z CDATA #FIXED 'zz' w ID #REQUIRED v NMTOKENS #IMPLIED>]>"
    "<a w='i'/>",
    "<!DOCTYPE a [<!ELEMENT a (b,c)*><!ELEMENT b (#PCDATA|c)*><!ELEMENT c EMPTY><!ELEMENT d ANY>]><a/>",
    "<!DOCTYPE a [<!ATTLIST a xmlns CDATA 'urn:def' xmlns:p CDATA 'urn:p' p:x CDATA 'px'>]><a/>",
    "<!DOCTYPE a [<!ATTLIST a t NMTOKEN '  a  b  '>]><a t=' x  y '/>",
    "<!DOCTYPE a [<!ENTITY e '&#60;b/&#62;'>]><a>&e;</a>",
    "<a xmlns:p='urn:p'><p:b><c xmlns='urn:c'><d/></c></p:b></a>", "<a xmlns='urn:x' xmlns:x='urn:x' x:at='1' at='2'/>",
    "<?xml version='1.0' standalone='yes'?><!DOCTYPE a SYSTEM 'x'><a/>", "<!DOCTYPE a [<!ENTITY % p 'x'> %p; ]><a/>",
    "<!DOCTYPE a SYSTEM 'x'><a b='&u;'/>", "<a>&#x9;&#xA;&#xD;</a>", "<a b='&#x9;&#xA;&#xD;'/>",
    "<!DOCTYPE a [<!ENTITY % p 'x'> %p; <!ENTITY e 'y'>]><a>&e;</a>",
    "<!DOCTYPE a [<!ENTITY e 'x'><!ENTITY f '&e;'>]><a b='&f;&e;'>&f;</a>", "<a·/>", "<a:b:c/>", "<:a/>",
]

# (long documents, kept as recipes: [piece, count] pairs, rebuilt by the test; their traces recorded as digests)
LONG = [
    [["<a>", 1], ["x", 20000], ["</a>", 1]], [["<a>", 1], ["line\n", 300], ["</a>", 1]],
    [["<a>", 1], ["&amp;", 3000], ["</a>", 1]], [["<a>", 1], ["<b c='d'>t</b>\n", 4000], ["</a>", 1]],
]


def build(recipe):
    return "".join(piece * count for piece, count in recipe)

MORE_MALFORMED = [
    "<!DOCTYPE a [<!ENTITY e '%p;'>]><a/>", "<!DOCTYPE a [<!ENTITY e '<b>'>]><a>&e;</a>",
    "<!DOCTYPE a [<!ENTITY e '</a>'>]><a>&e;", "<a>&#xFFFE;</a>", "<a b='&#1;'/>",
    "<!DOCTYPE a [<!ENTITY e '&#0;'>]><a/>", "<a><?xml version='1.0'?></a>",
    "<?xml version='1.0' encoding='utf-8' standalone='maybe'?><a/>", "<?xml version=\"1.0\"encoding='x'?><a/>",
    "<?xml standalone='yes'?><a/>", "<?xml version='1.0' version='1.0'?><a/>", "<?xml version='1.0' encoding=''?><a/>",
    "<?xml version='1.x'?><a/>", "<a>éé<b></c></a>", "<a>\r\n\r\n<b></c></a>", "<a>\r<b></c></a>",
    "<a b='xé'>\n</c>", "<!-- é --><a></b>", "<?pi é?><a></b>", "<a><![CDATA[éé]]></b>",
    "<!DOCTYPE a [\né ]><a/>", "<a>\t\t</b>", "<a/>\r\n<b/>", "<a/><!-- c --><?p?>x", "<a b='1", "<a><!-- x",
    "<a><?p x", "<!-- only comment -->", "<?xml version='1.0'?>", "<·a/>",
    "<!DOCTYPE a [<!ENTITY e '&f;'><!ENTITY f '&e;'>]><a b='&e;'/>", "<a>\U0001F600</b>", "<a>x]]>y</a>",
    "<a><![CDATA[ok]]]]></a>", "<a b='a&lt;'c='d'/>", "<a xmlns:p='urn:p' p:x='1' xmlns:q='urn:p' q:x='2'/>",
    "<!DOCTYPE a [<!ATTLIST a b CDATA #IMPLIED b CDATA 'x'>]><a/>", "<!DOCTYPE a [<!ELEMENT a (b|c,d)>]><a/>",
    "<!DOCTYPE a [<![IGNORE[ x ]]>]><a/>", "<!DOCTYPE a [<!ENTITY e SYSTEM>]><a/>", "<!DOCTYPE>",
    "<!DOCTYPE a PUBLIC 'p'><a/>", "<a x='é' y='\U0001F600' x='z'/>",
]

MORE_ENCODED = [
    ("latin-1 positions", "<?xml version='1.0' encoding='ISO-8859-1'?><a>éé</b>".encode("latin-1")),
    ("utf-16 positions", "﻿<a>é\U0001F600</b>".encode("utf-16-le")),
    ("utf-16-le no BOM", "<a>x</a>".encode("utf-16-le")), ("utf-16-be no BOM", "<a>x</a>".encode("utf-16-be")),
    ("utf-16 declaring utf-8", "﻿<?xml version='1.0' encoding='utf-8'?><a/>".encode("utf-16-le")),
    ("utf-16 declaring utf-16", "﻿<?xml version='1.0' encoding='UTF-16'?><a/>".encode("utf-16-be")),
    ("shift_jis decl", b"<?xml version='1.0' encoding='shift_jis'?><a/>"),
    ("utf-32 decl", b"<?xml version='1.0' encoding='utf-32'?><a/>"),
    ("bom then latin-1 decl", b"\xef\xbb\xbf<?xml version='1.0' encoding='latin-1'?><a>\xe9</a>"),
    ("koi8-r decl", "<?xml version='1.0' encoding='koi8-r'?><a>д</a>".encode("koi8-r")),
    ("odd utf-16", "﻿<a/>".encode("utf-16-le") + b"\x00"),
    ("utf-8 in utf-8 decl, invalid", b"<?xml version='1.0' encoding='utf-8'?><a>\xed\xa0\x80</a>"),
    ("ascii decl, high byte", b"<?xml version='1.0' encoding='US-ASCII'?><a>\xe9</a>"),
    ("str with latin-1 decl", "<?xml version='1.0' encoding='latin-1'?><a>é€</a>"),
]

PROTOCOL = [
    ("iso-8859-1", "<a>é</a>".encode("latin-1")), ("utf-16", "﻿<a/>".encode("utf-16-be")),
    ("utf-16", "﻿<a/>".encode("utf-16-le")), ("UTF-8", b"\xef\xbb\xbf<a/>"), ("klingon", b"<a/>"),
    ("cp1252", "<a>€</a>".encode("cp1252")), ("iso-8859-1", b"<?xml version='1.0' encoding='utf-8'?><a>\xe9</a>"),
]

HANDLER_DOCS = [
    "<?xml version='1.0' encoding='UTF-8' standalone='no'?><!DOCTYPE a SYSTEM 'a.dtd' [<!ENTITY e 'v'>"
    "<!ENTITY f SYSTEM 'f.xml'><!NOTATION n SYSTEM 'n'><!ENTITY u SYSTEM 'u' NDATA n><!ATTLIST a b CDATA 'd'>"
    "<!ELEMENT a ANY><!-- c --><?pi x?>]><a>&e;&undef;<![CDATA[ c ]]><b/></a>",
    "<!DOCTYPE a [<!ENTITY e '<b>x</b>'>]><a>&e;&amp;&#65;</a>", "<a><![CDATA[]]><![CDATA[x]]></a>",
    "<?xml version='1.0'?><!DOCTYPE a PUBLIC '-//a//EN' 'a.dtd'><a/>", "<!DOCTYPE a [<!ENTITY % p 'x'> %p; ]><a/>",
]

NS_DOCS = [
    "<p:a xmlns:p='urn:p'><p:b p:at='1' at='2'/></p:a>", "<a xmlns='urn:d'><b xmlns=''/></a>",
    "<!DOCTYPE a [<!ATTLIST a xmlns CDATA 'urn:def' xmlns:p CDATA 'urn:p' p:x CDATA 'px' y CDATA 'yy'>]><a z='1'/>",
    "<a xml:lang='en'/>", "<a xmlns:p='urn}p'/>", "<a xmlns:p='urn:p' xmlns:q='urn:q'><q:b p:c='1'/></a>",
]

# (amplification: the setters bring the activation threshold down so that both sides of each boundary are small)
LAUGHS = ("<!DOCTYPE a [<!ENTITY a '0123456789'><!ENTITY b '&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;'>"
          "<!ENTITY c '&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;'>]>")
AMPLIFICATION = [
    (LAUGHS + "<a>&c;</a>", {"SetBillionLaughsAttackProtectionActivationThreshold": 600,
                              "SetBillionLaughsAttackProtectionMaximumAmplification": 2.0}),
    (LAUGHS + "<a>&c;</a>", {"SetBillionLaughsAttackProtectionActivationThreshold": 600,
                              "SetBillionLaughsAttackProtectionMaximumAmplification": 20.0}),
    (LAUGHS + "<a>&c;</a>", {"SetBillionLaughsAttackProtectionActivationThreshold": 2000,
                              "SetBillionLaughsAttackProtectionMaximumAmplification": 2.0}),
    (LAUGHS + "<a x='&c;'/>", {"SetBillionLaughsAttackProtectionActivationThreshold": 600,
                                "SetBillionLaughsAttackProtectionMaximumAmplification": 2.0}),
    ("<!DOCTYPE a [<!ENTITY q '" + "q" * 200 + "'>]><a>" + "&q;" * 40 + "</a>",
     {"SetBillionLaughsAttackProtectionActivationThreshold": 1000,
      "SetBillionLaughsAttackProtectionMaximumAmplification": 3.0}),
    ("<!DOCTYPE a [<!ENTITY q '" + "q" * 200 + "'>]><a>" + "&q;" * 40 + "</a>",
     {"SetBillionLaughsAttackProtectionActivationThreshold": 1000,
      "SetBillionLaughsAttackProtectionMaximumAmplification": 70.0}),
    (LAUGHS + "<a>&c;</a>", {"SetBillionLaughsAttackProtectionActivationThreshold": 0,
                              "SetBillionLaughsAttackProtectionMaximumAmplification": 1.0}),
]


def chunkings(doc, rnd):
    whole = [doc]
    out = {"whole": whole}
    if len(doc) <= 160:
        out["unit"] = [doc[i:i + 1] for i in range(len(doc))]
    if len(doc) > 2:
        cuts = sorted(rnd.sample(range(1, len(doc)), min(3, len(doc) - 1)))
        out["seeded"] = [doc[a:b] for a, b in zip([0] + cuts, cuts + [len(doc)])]
    return out


def record():
    rnd = random.Random(20261107)
    cases = []

    def add_long(group, recipe, label, handlers):
        """A long document: its recipe, cut whole, every 64 KiB, every 4 KiB and at three seeded points; digests"""
        doc = build(recipe)
        n = len(doc)
        cuts = {"whole": [], "64k": list(range(65536, n, 65536)), "4k": list(range(4096, n, 4096)),
                "seeded": sorted(rnd.sample(range(1, n), 3))}
        for kname, cut in cuts.items():
            chunks = [doc[a:b] for a, b in zip([0] + cut, cut + [n])]
            for deferral in ((True, False) if kname == "4k" else (True,)):
                kw = dict(ET_CONFIG, deferral=deferral, digest=True)
                if handlers is not None:
                    kw["handlers"] = sorted(handlers)
                result = trace(expat, chunks, **kw)
                cases.append({"group": group, "label": label, "config": "et", "chunking": kname,
                              "deferral": deferral, "recipe": recipe, "cuts": cut, "bytes": False,
                              "options": {k: v for k, v in kw.items() if k != "deferral"}, "result": result})

    def add(group, doc, label=None, configs=(("et", ET_CONFIG), ("raw", RAW_CONFIG)), **extra):
        for cname, cfg in configs:
            for kname, chunks in chunkings(doc, rnd).items():
                for deferral in ((True, False) if kname != "whole" else (True,)):
                    kw = dict(cfg, deferral=deferral, **extra)
                    result = trace(expat, chunks, **kw)
                    cases.append({"group": group, "label": label or doc, "config": cname, "chunking": kname,
                                  "deferral": deferral, "chunks": [c.hex() if isinstance(c, bytes) else c for c in chunks],
                                  "bytes": isinstance(doc, bytes), "options": {k: v for k, v in kw.items() if k != "deferral"},
                                  "result": result})

    for d in WELL_FORMED:
        add("well-formed", d)
    for d in LINE_ENDS:
        add("line-ends", d)
    for d in MALFORMED:
        add("malformed", d)
    for label, b in ENCODED:
        add("encoded", b, label=label)
    for d in MORE_WELL_FORMED:
        add("well-formed", d)
    for d in MORE_MALFORMED:
        add("malformed", d)
    for label, b in MORE_ENCODED:
        add("encoded", b, label=label)
    for enc, b in PROTOCOL:
        add("protocol", b, label=f"{enc}: {b!r}", configs=(("et", dict(ET_CONFIG, encoding=enc)),))
    for d in HANDLER_DOCS:
        add("handlers", d, configs=(("all", dict(ET_CONFIG, extra=True)), ("noexpand", dict(RAW_CONFIG, extra=True,
                                                                                            noexpand=True))))
    add("handlers", HANDLER_DOCS[0], label="not standalone refused",
        configs=(("refuse", dict(ET_CONFIG, extra=True, standalone_rc=0)),))
    for d in NS_DOCS:
        add("namespaces", d, configs=(("empty-sep", dict(sep="", buffer_text=True, ordered=False)),
                                       ("triplets", dict(ET_CONFIG, triplets=True)),
                                       ("specified", dict(ET_CONFIG, specified=True)),
                                       ("colon-sep", dict(sep=":", buffer_text=False, ordered=True))))
    for d, limits in AMPLIFICATION:
        add("amplification", d, label=f"{d[-24:]} {sorted(limits.items())}",
            configs=(("et", dict(ET_CONFIG, limits=limits)), ("raw", dict(RAW_CONFIG, limits=limits))))
    # (the real defaults: 8 MiB of expansion from a small input, one side of the 100 factor each, recorded as digests;
    # only the element handlers are set, so the size is in the parse, not in the events)
    big = [["<!DOCTYPE a [<!ENTITY q '", 1], ["q", 10000], ["'>]><a>", 1]]
    for label, recipe in (("8 MiB over (factor about 500)", big + [["&q;", 1000], ["</a>", 1]]),
                          ("7 MiB under activation", big + [["&q;", 700], ["</a>", 1]]),
                          ("16 MiB under factor 100", big + [["&q;", 1600], ["<!--", 1], ["c", 170000], ["--></a>", 1]])):
        add_long("amplification-defaults", recipe, label, handlers={"SE", "EE"})
    for recipe in LONG:
        add_long("long", recipe, build(recipe)[:40], handlers=None)
    return cases


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    src = open(os.path.abspath(__file__), "rb").read()
    cases = record()
    out = {
        "provenance": {"generator_sha256": hashlib.sha256(src).hexdigest(),
                       "trace_sha256": hashlib.sha256(open(os.path.join(here, "expat_trace.py"), "rb").read()).hexdigest(),
                       "python": sys.version, "expat": pyexpat.EXPAT_VERSION},
        "tables": {"codes": sorted(expat.errors.codes.items(), key=lambda kv: kv[1]),
                   "messages": sorted(expat.errors.messages.items()), "version_info": list(pyexpat.version_info),
                   "EXPAT_VERSION": pyexpat.EXPAT_VERSION, "features": [list(f) for f in pyexpat.features]},
        "cases": cases,
    }
    with open(os.path.join(here, "expat_corpus.json"), "w") as f:
        json.dump(out, f, ensure_ascii=True, indent=0, sort_keys=True)
        f.write("\n")
    codes = sorted({c["result"]["error"]["code"] for c in cases if c["result"]["error"] and "code" in c["result"]["error"]})
    print(len(cases), "cases; error codes reached:", codes)


if __name__ == "__main__":
    main()
