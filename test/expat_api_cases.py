# pyexpat's interface, beyond the handler traces of test/expat_corpus.json (P3c-1): every line as CPython 3.14.10
# prints it (test/expat.test.ts compares them on the CLI and in the browser worker).
import pyexpat
from xml.parsers import expat


def t(f):
    try:
        return "ok " + repr(f())[:120]
    except BaseException as e:
        return f"{type(e).__name__}: {e}"


# the module and its tables, whole
print(pyexpat.EXPAT_VERSION, pyexpat.version_info, pyexpat.native_encoding, pyexpat.features)
print(sorted(expat.errors.codes.items()) == sorted((m, c) for c, m in expat.errors.messages.items()),
      len(expat.errors.codes), expat.errors.messages[43], expat.errors.XML_ERROR_SYNTAX, expat.errors.__name__)
print(sorted((n, getattr(expat.model, n)) for n in dir(expat.model) if n.startswith("XML")), expat.model.__name__)
# (expat_CAPI, the C API capsule, is CPython's alone: test/expat_divergences.json)
print(sorted(n for n in dir(pyexpat) if not n.startswith("_") and n != "expat_CAPI"))
print(pyexpat.ErrorString(7), pyexpat.ErrorString(999), pyexpat.ErrorString(0), t(lambda: pyexpat.ErrorString("x")))
print(pyexpat.ExpatError is pyexpat.error, pyexpat.ExpatError.__module__, pyexpat.ExpatError.__mro__[1:],
      pyexpat.XMLParserType.__name__, t(lambda: pyexpat.xmlparser), t(lambda: pyexpat.XMLParserType()))
print(expat.ErrorString is pyexpat.ErrorString, expat.ParserCreate is pyexpat.ParserCreate)
print(pyexpat.XML_PARAM_ENTITY_PARSING_NEVER, pyexpat.XML_PARAM_ENTITY_PARSING_UNLESS_STANDALONE,
      pyexpat.XML_PARAM_ENTITY_PARSING_ALWAYS)

# ParserCreate's arguments
for args, kw in [((), {"namespace_separator": "ab"}), ((1,), {}), ((None, 1), {}), ((), {"intern": 3}),
                 ((), {"intern": None}), ((), {"encoding": "klingon"}), ((), {"bogus": 1}), (("a", "b", {}, 4), {})]:
    print(args, kw, t(lambda: type(pyexpat.ParserCreate(*args, **kw)).__name__)[:60])

# a fresh parser's attributes
p = pyexpat.ParserCreate()
print(p.buffer_text, p.buffer_size, p.buffer_used, p.ordered_attributes, p.specified_attributes,
      p.namespace_prefixes, p.intern, p.ErrorCode, p.ErrorLineNumber, p.ErrorColumnNumber, p.ErrorByteIndex,
      p.CurrentLineNumber, p.CurrentColumnNumber, p.CurrentByteIndex, p.GetReparseDeferralEnabled(), p.GetBase(),
      p.GetInputContext(), p.StartElementHandler)
for name, v in [("buffer_size", 0), ("buffer_size", "x"), ("buffer_size", 2**31), ("buffer_size", -1),
                ("CurrentLineNumber", 3), ("ErrorCode", 1), ("intern", {}), ("buffer_used", 1), ("Bogus", 1),
                ("ordered_attributes", "yes"), ("buffer_text", []), ("namespace_prefixes", 2)]:
    print(name, v, t(lambda: setattr(p, name, v)))
print(p.ordered_attributes, p.buffer_text, p.namespace_prefixes)
print(t(lambda: p.SetBase(3)), t(lambda: p.SetBase("base")), p.GetBase())

# the protection setters' arguments
for n, v in [("SetBillionLaughsAttackProtectionActivationThreshold", -1),
             ("SetBillionLaughsAttackProtectionActivationThreshold", 2**64),
             ("SetBillionLaughsAttackProtectionActivationThreshold", 1.5),
             ("SetBillionLaughsAttackProtectionMaximumAmplification", 0.5),
             ("SetBillionLaughsAttackProtectionMaximumAmplification", float("nan")),
             ("SetBillionLaughsAttackProtectionMaximumAmplification", "1"),
             ("SetBillionLaughsAttackProtectionMaximumAmplification", 1),
             ("SetAllocTrackerMaximumAmplification", 1.0), ("SetAllocTrackerMaximumAmplification", 0.99),
             ("SetAllocTrackerActivationThreshold", 0)]:
    print(n, v, t(lambda: getattr(pyexpat.ParserCreate(), n)(v)))

# Parse's arguments, and what may follow the end, an error, or an exception in a handler
q = pyexpat.ParserCreate()
print(t(lambda: q.Parse()), t(lambda: q.Parse(3)), t(lambda: q.Parse(b"<a/>", True, 3)),
      t(lambda: q.Parse(bytearray(b"<a"), False)), t(lambda: q.Parse(memoryview(b"/>"), True)),
      t(lambda: q.Parse(b"", True)), q.ErrorCode, q.ErrorLineNumber, q.ErrorColumnNumber, q.ErrorByteIndex)
r = pyexpat.ParserCreate()
print(t(lambda: r.Parse(b"<a></b>", True)), t(lambda: r.Parse(b"<c/>", True)), r.ErrorCode, r.ErrorLineNumber,
      r.ErrorColumnNumber, r.ErrorByteIndex)
s = pyexpat.ParserCreate()
s.StartElementHandler = lambda n, a: 1 / 0
print(t(lambda: s.Parse(b"<a><b/></a>", True)), t(lambda: s.Parse(b"", True)), s.ErrorCode)
u = pyexpat.ParserCreate()
u.StartElementHandler = lambda n, a: u.Parse(b"x")
print(t(lambda: u.Parse(b"<a/>", True)))
v = pyexpat.ParserCreate("iso-8859-1")
v.Parse("<a>é", False)
print(t(lambda: v.Parse(b"\xc3\xa9</a>", True)))
w = pyexpat.ParserCreate()
print(t(lambda: w.Parse("<a>\udcff</a>", True)))

# positions and the input's context inside a handler
x = pyexpat.ParserCreate()
seen = []
x.StartElementHandler = lambda n, a: seen.append((n, x.GetInputContext(), x.CurrentLineNumber, x.CurrentColumnNumber,
                                                   x.CurrentByteIndex))
x.EndElementHandler = lambda n: seen.append((n, x.CurrentLineNumber, x.CurrentColumnNumber, x.CurrentByteIndex))
x.Parse(b"<a>\n <b/>", False)
x.Parse("é</a>".encode(), True)
print(seen, x.GetInputContext())

# interning, and pyexpat's character data buffer
y = pyexpat.ParserCreate()
y.StartElementHandler = lambda n, a: None
y.ProcessingInstructionHandler = lambda t, d: None
y.Parse(b"<?t d?><a x='1'><a/></a>", True)
print(sorted(y.intern))
z = pyexpat.ParserCreate()
z.buffer_text = True
got = []
z.CharacterDataHandler = got.append
z.Parse(b"<a>hello", False)
print(z.buffer_used, got)
z.Parse(b" there", False)
z.buffer_size = 3
print(z.buffer_size, z.buffer_used, got)
z.Parse(b"abcd&amp;ef</a>", True)
print(got)
zz = pyexpat.ParserCreate()
zz.buffer_text = True
got2 = []
zz.CharacterDataHandler = got2.append
zz.CommentHandler = lambda c: got2.append(("comment", c))
zz.Parse(b"<a>x<!--c-->y", False)
zz.buffer_text = False
print(got2)
zz.Parse(b"z</a>", True)
print(got2)

# handler attributes: any value is kept; a handler that isn't callable fails when called
h = pyexpat.ParserCreate()
h.StartElementHandler = 3
print(h.StartElementHandler, t(lambda: h.Parse(b"<a/>", True)))
d = pyexpat.ParserCreate()
d.DefaultHandler = lambda s: None
d.DefaultHandlerExpand = None
print(d.DefaultHandler is not None, d.DefaultHandlerExpand)
