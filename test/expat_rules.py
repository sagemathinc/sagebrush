# Sagebrush's pyexpat: what is its own (P3c-1; design note r3 sections 4 and 4a), checked as rules and printed as one
# JSON object for test/expat.test.ts: the parser's memory accounting (small thresholds through pyexpat's own setters),
# the work bounds of one-byte feeds, the scan window (the corpus again with a window of 7 characters), no I/O at all
# for any external identifier, and the stated interface divergences.
import builtins
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import pyexpat  # noqa: E402
from expat_run import run  # noqa: E402

out = {}


def parse(doc, setup=None, chunk=None, deferral=True):
    p = pyexpat.ParserCreate()
    p.SetReparseDeferralEnabled(deferral)
    events = []
    p.StartElementHandler = lambda n, a: events.append(n)
    if setup:
        setup(p)
    err = None
    try:
        if chunk is None:
            p.Parse(doc, True)
        else:
            for i in range(0, len(doc), chunk):
                p.Parse(doc[i:i + chunk], False)
            p.Parse(b"", True)
    except pyexpat.ExpatError as e:
        err = [e.code, str(e)]
    return p, events, err


# the allocation tracker (section 4.3): past the activation threshold, more than the factor over the direct input is
# expat's out of memory, raised before the growth; nothing is delivered past it; everything held is released
def tracker(act, amp):
    return lambda p: (p.SetAllocTrackerActivationThreshold(act), p.SetAllocTrackerMaximumAmplification(amp))


deep = b"<a>" * 200 + b"</a>" * 200
p, ev, err = parse(deep, tracker(4096, 1.0))
out["tracker_deep"] = [err[0] if err else None, len(ev), p._work_counts()["owned"]]
p, ev, err = parse(deep, tracker(4096, 1.0), chunk=7)
out["tracker_deep_chunked"] = [err[0] if err else None, len(ev) < 200, p._work_counts()["owned"]]
p, ev, err = parse(b"<r>" + b"<a/>" * 200 + b"</r>", tracker(4096, 100.0))
out["tracker_flat_under"] = [err, len(ev), p._work_counts()["owned"]]
wide = b"<r>" + b"<a " + b" ".join(b"x%d='%s'" % (i, b"v" * 40) for i in range(300)) + b"/></r>"
p, ev, err = parse(wide, tracker(8192, 1.0))
out["tracker_wide_tag"] = [err[0] if err else None, ev]
p, ev, err = parse(deep, tracker(0, 1.0))
out["tracker_zero"] = [err[0] if err else None, len(ev)]

# the work bounds (section 4a): one-byte feeds, deferral on, scanned and copied linear in the input
bounds = {}
for label, doc in (("comment", b"<a><!--" + b"c" * 16384 + b"--></a>"),
                   ("attribute", b"<a x='" + b"v" * 16384 + b"'/>"),
                   ("tokens", b"<a>" + b"<b x='1'>t</b>" * 1200 + b"</a>")):
    p, ev, err = parse(doc, chunk=1)
    w = p._work_counts()
    bounds[label] = [err, w["scanned"] <= 6 * len(doc), w["copied"] <= 7 * len(doc), w["attempts"] <= len(doc) + 1]
p, ev, err = parse(b"<a><!--" + b"c" * 2048 + b"--></a>", chunk=1, deferral=False)
w = p._work_counts()
n = 2048 + 14
bounds["no deferral (expat's quadratic, stated)"] = [err, w["scanned"] > n * n // 4, w["scanned"] <= n * n]
out["work"] = bounds

# the scan window: every windowed scan's seams, by the corpus again with a window of 7 characters
corpus = json.load(open(os.path.join(HERE, "expat_corpus.json"), encoding="utf-8"))
divergences = json.load(open(os.path.join(HERE, "expat_divergences.json"), encoding="utf-8"))
saved = pyexpat._WINDOW
pyexpat._WINDOW = 7
try:
    r = run(corpus, divergences, True, True)
finally:
    pyexpat._WINDOW = saved
out["window_7"] = [r["cases"], r["mismatch_count"], r["mismatches"][:2], r["stated_but_same"], r["stated_but_other"]]

# no I/O (section 4.1): every external identifier, under a spy on the ways to reach a file
calls = []
real = {"open": builtins.open}
for name in ("open", "stat", "listdir", "scandir", "remove", "unlink", "rename", "mkdir", "makedirs", "rmdir"):
    if hasattr(os, name):
        real["os." + name] = getattr(os, name)


def spy(name):
    return lambda *a, **k: calls.append(name)


builtins.open = spy("open")
for name in list(real):
    if name.startswith("os."):
        setattr(os, name[3:], spy(name))
try:
    docs = [
        b"<!DOCTYPE a SYSTEM 'file:///etc/passwd'><a>&e;</a>",
        b"<!DOCTYPE a PUBLIC '-//x//EN' 'http://example.com/a.dtd'><a/>",
        b"<!DOCTYPE a [<!ENTITY e SYSTEM 'file:///etc/passwd'>]><a>&e;</a>",
        b"<!DOCTYPE a [<!ENTITY e PUBLIC '-//x//EN' 'http://example.com/e'>]><a>&e;</a>",
        b"<!DOCTYPE a [<!ENTITY % p SYSTEM 'p.dtd'> %p; ]><a>&undefined;</a>",
        b"<!DOCTYPE a [<!ENTITY u SYSTEM 'u.bin' NDATA n><!NOTATION n SYSTEM 'n'>]><a b='u'/>",
        b"<!DOCTYPE a [<!ENTITY e SYSTEM 'e.xml'>]><a b='&e;'/>",
        b"<?xml-stylesheet href='s.xsl'?><a xmlns:xi='http://www.w3.org/2001/XInclude'><xi:include href='x.xml'/></a>",
    ]
    results = []
    for d in docs:
        p = pyexpat.ParserCreate(None, "}")
        p.DefaultHandlerExpand = lambda s: None
        p.StartElementHandler = lambda n, a: None
        try:
            p.Parse(d, True)
            results.append("ok")
        except pyexpat.ExpatError as e:
            results.append(e.code)
finally:
    builtins.open = real["open"]
    for name, f in real.items():
        if name.startswith("os."):
            setattr(os, name[3:], f)
out["no_io"] = [calls, results]

# the stated interface divergences: what this slice doesn't do says so, before anything is parsed
divs = []
p = pyexpat.ParserCreate()
for name in ("ExternalEntityRefHandler", "ElementDeclHandler"):
    try:
        setattr(p, name, lambda *a: 1)
        divs.append([name, "set"])
    except NotImplementedError as e:
        divs.append([name, "NotImplementedError", str(e)])
    setattr(p, name, None)
for label, f in (("SetParamEntityParsing(1)", lambda: p.SetParamEntityParsing(1)),
                 ("SetParamEntityParsing(0)", lambda: p.SetParamEntityParsing(0)),
                 ("UseForeignDTD()", lambda: p.UseForeignDTD()),
                 ("ExternalEntityParserCreate", lambda: p.ExternalEntityParserCreate(None))):
    try:
        divs.append([label, "returned", f()])
    except NotImplementedError as e:
        divs.append([label, "NotImplementedError", str(e)])
divs.append(["expat_CAPI", hasattr(pyexpat, "expat_CAPI")])
out["interface"] = divs
print(json.dumps(out))
