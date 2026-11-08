# Sagebrush's pyexpat: what is its own (P3c-1; design note r3 sections 4 and 4a; #849 r2), checked as rules and
# printed as one JSON object of raw numbers for test/expat.test.ts, which states the bounds: the allocation tracker
# (small thresholds through pyexpat's own setters), the work (every pattern and string scan under a spy, with the
# tokenizer's character steps), the window (the shipped one, and the corpus again at 7 characters), the two ledgers
# and their admission, the trackers' boundaries, no I/O at all for any external identifier, and the stated interface
# divergences.
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

# ---- the spy (design note r3 section 4a; #849 r2): every compiled pattern the module uses (its _Chars, created per
# parser through _re.compile, and its module-level patterns) is wrapped, and the module's string-scan helpers report
# through _SPY: each call's span (the characters it may examine: endpos - pos for a match or search, the string for a
# sub, a helper's window), the largest, the calls without an end bound, the characters each call examined (a match:
# what it matched and the character that stopped it; a search: up to its match or its end; a sub or a helper: its
# whole span), and the tokenizer's character-by-character steps (_Tok.bt)
import re as _real_re  # noqa: E402

_PATTERN = type(_real_re.compile(""))


class Probe:
    def __init__(self):
        self.reset()

    def reset(self):
        self.calls = 0
        self.span = 0
        self.max = 0
        self.unbounded = 0
        self.bt = 0
        self.examined = 0

    def note(self, kind, span, examined=None):
        self.calls += 1
        self.span += span
        self.examined += span if examined is None else examined
        if span > self.max:
            self.max = span

    def numbers(self):
        return {"calls": self.calls, "span": self.span, "max": self.max, "unbounded": self.unbounded, "bt": self.bt,
                "examined": self.examined}


probe = Probe()


class SpyPattern:
    def __init__(self, r):
        self.r = r

    def match(self, s, pos=0, endpos=None):
        if endpos is None:
            probe.unbounded += 1
            endpos = len(s)
        span = max(0, min(endpos, len(s)) - pos)
        m = self.r.match(s, pos, endpos)
        probe.note("match", span, min(span, (m.end() - pos if m else 0) + 1))
        return m

    def search(self, s, pos=0, endpos=None):
        if endpos is None:
            probe.unbounded += 1
            endpos = len(s)
        span = max(0, min(endpos, len(s)) - pos)
        m = self.r.search(s, pos, endpos)
        probe.note("search", span, (m.end() if m else min(endpos, len(s))) - pos)
        return m

    def sub(self, repl, s, count=0):
        probe.note("sub", len(s))
        return self.r.sub(repl, s, count)


class ReShim:
    def compile(self, pattern, flags=0):
        return SpyPattern(_real_re.compile(pattern, flags))

    def __getattr__(self, name):
        return getattr(_real_re, name)


pyexpat._re = ReShim()
pyexpat._SPY = probe.note
for _name, _v in list(vars(pyexpat).items()):
    if isinstance(_v, _PATTERN):
        setattr(pyexpat, _name, SpyPattern(_v))
pyexpat._VALUE_RUN = {k: SpyPattern(v) for k, v in pyexpat._VALUE_RUN.items()}
pyexpat._NAME_CLASS_RE.clear()
_bt = pyexpat._Tok.bt


def _counted_bt(self, i):
    probe.bt += 1
    return _bt(self, i)


pyexpat._Tok.bt = _counted_bt
# (the spy's own check: no compiled pattern is left unwrapped in the module, in a dict or not)
out["spy_unwrapped"] = sorted(n for n, v in vars(pyexpat).items() if isinstance(v, _PATTERN)) + sorted(
    n for n, v in vars(pyexpat).items() if isinstance(v, dict) and any(isinstance(x, _PATTERN) for x in v.values()))


def measured(doc, chunk=None, deferral=True, setup=None, handlers=True):
    """Parse doc under the spy: the spy's numbers, the work counters and the error"""
    probe.reset()
    p = pyexpat.ParserCreate()
    p.SetReparseDeferralEnabled(deferral)
    if handlers:
        p.StartElementHandler = lambda n, a: None
        p.CharacterDataHandler = lambda d: None
        p.CommentHandler = lambda d: None
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
        err = e.code
    r = probe.numbers()
    r.update({k: v for k, v in p._work_counts().items() if k in ("scanned", "attempts", "copied", "decoded")})
    r["n"] = len(doc)
    r["err"] = err
    return r


# the shipped window, and the largest call at it: a fallback attribute (an & keeps it off the fast path) of 3 MiB
out["window"] = pyexpat._WINDOW
big = b"<r a='" + b"x" * (3 << 20) + b"&amp;'/>"
out["span_default"] = measured(big)

# the work (raw numbers; test/expat.test.ts states the bounds): each family at n and at 4n, whole or fed a byte at a
# time; and the positive control, expat's own quadratic rescans with reparse deferral off
work = {}
for label, make, chunk in (
        ("tabs attribute", lambda k: b"<a x='" + b"v\t" * k + b"'/>", None),
        ("fallback attribute", lambda k: b"<a x='" + b"x" * (2 * k) + b"&amp;' y='" + b"z \n" * k + b"' w=\""
         + b"q \t" * k + b"\"/>", None),
        ("comment, 1-byte feeds", lambda k: b"<a><!--" + b"c" * (2 * k) + b"--></a>", 1),
        ("attribute, 1-byte feeds", lambda k: b"<a x='" + b"v" * (2 * k) + b"'/>", 1),
        ("tokens", lambda k: b"<a>" + b"<b x='1'>t</b>" * (k // 8) + b"</a>", None),
        ("expansion in content", lambda k: b"<!DOCTYPE r [<!ENTITY e 'x y\tz &#38;amp;'>]><r>" + b"&e;" * (k // 2)
         + b"</r>", None),
        ("expansion in an attribute", lambda k: b"<!DOCTYPE r [<!ENTITY e 'x y\tz'>]><r a='" + b"&e; " * (k // 4)
         + b"'/>", None),
        ("text and lines", lambda k: b"<r>" + b"ab\r\ncd\n\xc3\xa9 " * (k // 8) + b"</r>", None)):
    work[label] = [measured(make(k), chunk) for k in (2048, 8192)]
work["control: no deferral, 1-byte feeds"] = [measured(b"<a><!--" + b"c" * k + b"--></a>", 1, False) for k in (1024, 4096)]
out["work"] = work

# the scan window: the corpus's whole documents again with every window 7 characters, under the spy: CPython's
# results still, and no call examines more than 7 characters (rfind's two calls a window, each at most 7)
corpus = json.load(open(os.path.join(HERE, "expat_corpus.json"), encoding="utf-8"))
divergences = json.load(open(os.path.join(HERE, "expat_divergences.json"), encoding="utf-8"))
saved = pyexpat._WINDOW
pyexpat._WINDOW = 7
probe.reset()
try:
    r = run(corpus, divergences, True, True)
    small = b"<r a='" + b"x" * 100 + b"&amp;' b='p\tq'>" + b"t" * 50 + b"<!--" + b"c" * 40 + b"--></r>"
    pp = pyexpat.ParserCreate()
    pp.Parse(small, True)
finally:
    pyexpat._WINDOW = saved
out["window_7"] = [r["cases"], r["mismatch_count"], r["mismatches"][:2], r["stated_but_same"], r["stated_but_other"],
                   probe.numbers()]


# ---- the ledgers (section 4.3; astra's X1 and X2): owned (expat's tracked memory) and buffers, by slot
def ledger(p):
    w = p._work_counts()
    return [w["owned"], w["buffers"], w["slots"]]


led = {}
# (X2) a buffered run of text and references, flushed at each Parse's end: the same state after each feed
p = pyexpat.ParserCreate()
p.buffer_text = True
p.CharacterDataHandler = lambda d: None
p.Parse(b"<r>", False)
led["flushes"] = []
for _ in range(4):
    p.Parse(b"a&#98;" * 4, False)
    led["flushes"].append(ledger(p))
# (X1) an incomplete token fed a byte at a time: each waiting part a string and a list entry
p = pyexpat.ParserCreate()
p.Parse(b"<r><!--", False)
for _ in range(100):
    p.Parse(b"x", False)
led["parts"] = [len(p._raw_parts), ledger(p)]
p.Parse(b"--></r>", True)
led["parts_end"] = [ledger(p), len(p._raw_parts), len(p._text), len(p._raw)]
# (B2) the character buffer's fragments, as charged: sampled at each token's accounting
samples = []
_account = pyexpat.XMLParserType._account


def _sampled(self, nbytes, direct):
    samples.append([self._led[3], self._led[4]])
    return _account(self, nbytes, direct)


pyexpat.XMLParserType._account = _sampled
try:
    p = pyexpat.ParserCreate()
    p.buffer_text = True
    p.CharacterDataHandler = lambda d: None
    p.Parse(b"<r>ab&amp;cd</r>", True)
finally:
    pyexpat.XMLParserType._account = _account
led["fragments"] = samples
# every Parse's return over fed documents: the buffers ledger is exactly its slots, and linear in what waits
inv = []
for doc, chunk in ((b"<r a='1'>" + b"<b>t&amp;u</b>" * 300 + b"<!--c-->" + b"</r>", 37),
                   ("<r>" + "é\U0001F600" * 500 + "</r>", 5), (b"<r><![CDATA[" + b"x]" * 400 + b"]]></r>", 64)):
    p = pyexpat.ParserCreate()
    p.buffer_text = True
    p.CharacterDataHandler = lambda d: None
    worst = [0, 0, 0]
    data = doc.encode("utf-16") if isinstance(doc, str) else doc
    for i in range(0, len(data), chunk):
        p.Parse(data[i:i + chunk], False)
        w = p._work_counts()
        waiting = sum(len(x) for x in p._raw_parts) + len(p._raw) + len(p._text)
        worst[0] = max(worst[0], abs(w["buffers"] - sum(w["slots"])))
        worst[1] = max(worst[1], w["buffers"] - (4 * waiting + 256 * len(p._raw_parts) + 512))
        worst[2] = max(worst[2], w["owned"])
    p.Parse(b"", True)
    inv.append(worst + [ledger(p)])
led["invariants"] = inv
# after an error and after an exception in a handler: the objects and both ledgers cleared (an error keeps the
# span it re-advances positions over, among the buffers)
p = pyexpat.ParserCreate()
p.buffer_text = True
p.CharacterDataHandler = lambda d: None
try:
    p.Parse(b"<r>abc<a>de</b>", True)
except pyexpat.ExpatError as e:
    led["error"] = [e.code, ledger(p), p._raw_parts, p._text, p._buffer, len(p._error_span or "")]
p = pyexpat.ParserCreate()


def _boom(n, a):
    raise KeyError("boom")


p.StartElementHandler = _boom
try:
    p.Parse(b"<r>" + b"x" * 5000, False)
except KeyError:
    led["exception"] = [ledger(p), p._raw_parts, p._text, p._buffer]
out["ledger"] = led


# ---- admission (X1): small thresholds, refused at the charge, before what it would pay for is built or delivered
def admitted(doc, act, amp, extra=None):
    p = pyexpat.ParserCreate()
    p.SetAllocTrackerActivationThreshold(act)
    p.SetAllocTrackerMaximumAmplification(amp)
    ev = []
    p.StartElementHandler = lambda n, a: ev.append(["SE", n, len(a)])
    p.EntityDeclHandler = lambda *a: ev.append(["ED", a[0], len(a[2] or "")])
    p.CharacterDataHandler = lambda d: ev.append(["CD", len(d)])
    err = None
    try:
        p.Parse(doc, True)
    except pyexpat.ExpatError as e:
        err = e.code
    return [err, ev, ledger(p)[0]]


adm = {}
adm["attribute expansion"] = admitted(b"<!DOCTYPE r [<!ENTITY e '" + b"v" * 300 + b"'>]><r a='&e;&e;&e;&e;&e;&e;'/>",
                                      4096, 1.0)
adm["entity value"] = admitted(b"<!DOCTYPE r [<!ENTITY e '" + b"v" * 5000 + b"'>]><r/>", 4096, 1.0)
adm["many pieces"] = admitted(b"<!DOCTYPE r [<!ENTITY e 'a'>]><r a='" + b"&e;" * 200 + b"'/>", 8000, 1.0)
adm["many character references"] = admitted(b"<r a='" + b"&#97;" * 200 + b"'/>", 8000, 1.0)
adm["many attributes"] = admitted(b"<r " + b" ".join(b"a%d='1'" % i for i in range(200)) + b"/>", 8192, 1.0)
adm["fallback attributes"] = admitted(b"<r " + b" ".join(b"a%d='&amp;'" % i for i in range(200)) + b"/>", 8192, 1.0)
out["admission"] = adm


# ---- the boundaries (grader's A4, A5, A6, and the amplification check's own): each at, just under and just over
def first_charge(doc):
    seen = []
    charge = pyexpat.XMLParserType._charge

    def rec(self, n):
        seen.append([self._acc[2] + n, self._acc[0]])
        return charge(self, n)

    pyexpat.XMLParserType._charge = rec
    try:
        q = pyexpat.ParserCreate()
        q.Parse(doc, True)
    finally:
        pyexpat.XMLParserType._charge = charge
    return seen[0]


def events_with(doc, setup):
    """[error, events, the charges admitted before it]"""
    q = pyexpat.ParserCreate()
    ev = []
    ok = [0]
    q.StartElementHandler = lambda n, a: ev.append(n)
    q.CharacterDataHandler = lambda d: ev.append(len(d))
    setup(q)
    charge = pyexpat.XMLParserType._charge

    def counted(self, n):
        charge(self, n)
        ok[0] += 1

    pyexpat.XMLParserType._charge = counted
    try:
        q.Parse(doc, True)
        return [None, ev, ok[0]]
    except pyexpat.ExpatError as e:
        return [e.code, ev, ok[0]]
    finally:
        pyexpat.XMLParserType._charge = charge


bnd = {}
doc = b"<a><b/></a>"
total, direct = first_charge(doc)
bnd["tracker_first"] = [total, direct]
for label, act, amp in (("act at", total, 1.0), ("act over", total + 1, 1.0),
                        ("amp at", 0, total / direct), ("amp under", 0, (total / direct) * (1 - 1e-9))):
    bnd["tracker " + label] = events_with(doc, lambda q: (q.SetAllocTrackerActivationThreshold(act),
                                                          q.SetAllocTrackerMaximumAmplification(max(1.0, amp))))
# (the amplification check: the output and factor at the first indirect bytes)
seen = []
_acct = pyexpat.XMLParserType._account


def _rec(self, nbytes, direct):
    r = _acct(self, nbytes, direct)
    seen.append([self._acc[0], self._acc[1], direct])
    return r


edoc = b"<!DOCTYPE r [<!ENTITY e 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'>]><r>&e;&e;&e;</r>"
pyexpat.XMLParserType._account = _rec
try:
    q = pyexpat.ParserCreate()
    q.Parse(edoc, True)
finally:
    pyexpat.XMLParserType._account = _acct
k = next(i for i, x in enumerate(seen) if not x[2])
d, ind = seen[k][0], seen[k][1]
bnd["amplification_point"] = [d, ind]
for label, act, amp in (("act at", d + ind, 1.0), ("act over", d + ind + 1, 1.0),
                        ("amp at", 0, (d + ind) / d), ("amp under", 0, ((d + ind) / d) * (1 - 1e-9))):
    bnd["amplification " + label] = events_with(edoc, lambda q: (
        q.SetBillionLaughsAttackProtectionActivationThreshold(act),
        q.SetBillionLaughsAttackProtectionMaximumAmplification(max(1.0, amp))))
# (A4: with no direct bytes yet, expat's factors: the accounting's (22 + indirect) / 22, the tracker's infinite one)
zero = []
for amp in (27 / 22, (27 / 22) * (1 - 1e-9)):
    q = pyexpat.ParserCreate()
    q.SetBillionLaughsAttackProtectionActivationThreshold(0)
    q.SetBillionLaughsAttackProtectionMaximumAmplification(amp)
    try:
        q._account(5, False)
        zero.append("ok")
    except pyexpat._Error as e:
        zero.append(e.code)
q = pyexpat.ParserCreate()
q.SetAllocTrackerActivationThreshold(0)
try:
    q._charge(1)
    zero.append("ok")
except pyexpat._Error as e:
    zero.append(e.code)
bnd["zero direct"] = zero
out["boundaries"] = bnd

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
