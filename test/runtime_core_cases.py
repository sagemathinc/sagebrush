# Python's runtime core as CPython 3.14's (the Codex audit P01): float.from_number and complex.from_number (a real
# number only, PyFloat_AsDouble's rule, a complex's own value, __complex__; a subclass called with the result);
# bytes.fromhex and bytearray.fromhex of a subclass (the class called with the base's value); BaseException's args
# (any iterable, stored as a tuple), __cause__, __context__ and __suppress_context__ (checked, a cause suppressing the
# context) and add_note (a str only, __notes__ a list). Compared with CPython line for line by
# test/runtime-core.test.ts.
def show(t, f):
    try:
        r = f(); print(t, '|', type(r).__name__, repr(r))
    except BaseException as e: print(t, '| !!', type(e).__name__, e)
class I(int):
    def __float__(self): return 19.0
    def __complex__(self): return 7j
class I2(int):
    def __float__(self): return 19.0
class F(float):
    def __float__(self): return 9.0
class Fc(float):
    def __complex__(self): return 5j
class Cx(complex):
    def __complex__(self): return 8j
class Idx:
    def __index__(self): return 4
class Fl:
    def __float__(self): return 2.5
class Co:
    def __complex__(self): return 1 + 1j
class FS(float): pass
class CS(complex): pass
class FSnew(float):
    def __new__(cls, v): print('FSnew', v); return super().__new__(cls, v)
for nm, x in (("3", 3), ("2**1100", 2**1100), ("1.5", 1.5), ("True", True), ("I(2)", I(2)), ("I2(2)", I2(2)), ("F(1.5)", F(1.5)), ("Fc(1.5)", Fc(1.5)), ("Cx(1)", Cx(1)),
              ("Idx()", Idx()), ("Fl()", Fl()), ("Co()", Co()), ("'1.5'", '1.5'), ("None", None), ("1j", 1j), ("b'1'", b'1')):
    show(f"float.from_number({nm})", lambda: float.from_number(x))
    show(f"FS.from_number({nm})", lambda: FS.from_number(x))
    show(f"complex.from_number({nm})", lambda: complex.from_number(x))
    show(f"CS.from_number({nm})", lambda: CS.from_number(x))
show("FSnew.from_number(3)", lambda: FSnew.from_number(3))
show("float.from_number()", lambda: float.from_number())
show("(1.5).from_number(2)", lambda: (1.5).from_number(2))
show("hasattr(int, from_number)", lambda: hasattr(int, 'from_number'))
# F3
class B(bytes): pass
class BA(bytearray): pass
class Bnew(bytes):
    def __new__(cls, v): print('Bnew', v); return super().__new__(cls, v)
class BAinit(bytearray):
    def __init__(self, *a): print('BAinit', a); super().__init__(*a)
for c in (bytes, bytearray, B, BA, Bnew, BAinit):
    show(f"{c.__name__}.fromhex", lambda: c.fromhex('41 42'))
    show(f"{c.__name__}.fromhex bad", lambda: c.fromhex('4x'))
    show(f"{c.__name__}().fromhex", lambda: c(b'z').fromhex('43'))
# F4
for label, v in (('[1, 2]', [1, 2]), ("'xy'", 'xy'), ('()', ()), ('(3,)', (3,)), ('range(2)', range(2)), ('iter([5])', iter([5])), ('5', 5), ('None', None), ("{'a': 1}", {'a': 1})):
    def setargs(v=v):
        e = ValueError(9); e.args = v; return (type(e.args).__name__, e.args, str(e), repr(e))
    show(f"args = {label}", setargs)
def delargs():
    e = ValueError(); del e.args
show("del args", delargs)
class MyE(Exception):
    def __init__(self, a, b): self.extra = a
show("subclass args", lambda: (lambda e: (e.args, str(e)))(MyE(1, 2)))
# F5
def chain(attr, v):
    e = ValueError(); setattr(e, attr, v); return (e.__cause__, e.__context__, e.__suppress_context__)
for attr in ("__cause__", "__context__"):
    for v in (None, KeyError('k'), 1, KeyError, 'x'):
        show(f"{attr} = {v!r}", lambda: chain(attr, v))
for v in (True, False, 1, 0, None, 'x'):
    show(f"__suppress_context__ = {v!r}", lambda: chain("__suppress_context__", v))
def cause_then_context():
    e = ValueError(); e.__cause__ = KeyError(); e.__suppress_context__ = False; return e.__suppress_context__
show("cause then suppress False", cause_then_context)
show("default chain", lambda: (lambda e: (e.__cause__, e.__context__, e.__suppress_context__))(ValueError()))
def del_cause():
    e = ValueError(); del e.__cause__
show("del __cause__", del_cause)
def raise_from_none():
    try:
        try: raise KeyError(1)
        except KeyError: raise ValueError(2) from None
    except ValueError as e: return (e.__cause__, type(e.__context__).__name__, e.__suppress_context__)
show("raise from None", raise_from_none)
def raise_from():
    try:
        raise ValueError(2) from KeyError(3)
    except ValueError as e: return (repr(e.__cause__), e.__suppress_context__)
show("raise from", raise_from)
def implicit():
    try:
        try: raise KeyError(1)
        except KeyError: raise ValueError(2)
    except ValueError as e: return (e.__cause__, repr(e.__context__), e.__suppress_context__)
show("implicit context", implicit)
# F6
for v in ('n', 1, None, b'x', ['a']):
    def note(v=v):
        e = ValueError(); e.add_note(v); return e.__notes__
    show(f"add_note({v!r})", note)
class S(str): pass
show("add_note(str subclass)", lambda: (lambda e: (e.add_note(S('s')), type(e.__notes__[0]).__name__))(ValueError()))
def notes_not_list():
    e = ValueError(); e.__notes__ = 5; e.add_note('x'); return e.__notes__
show("__notes__ not a list", notes_not_list)
def notes_tuple():
    e = ValueError(); e.__notes__ = ('a',); e.add_note('x'); return e.__notes__
show("__notes__ tuple", notes_tuple)
# an int subclass's own __float__ returning infinity is its value; int's own conversion past a double's range
# OverflowError (an int subclass without __float__ too); the classmethods' and add_note's argument errors; deleting
# __suppress_context__; fromhex's odd digit count
class FI(int):
    def __float__(self): return float("inf")
class BI(int): pass
show("float.from_number(FI(1))", lambda: float.from_number(FI(1)))
show("FS.from_number(FI(1))", lambda: FS.from_number(FI(1)))
show("complex.from_number(FI(1))", lambda: complex.from_number(FI(1)))
show("float.from_number(BI(10**400))", lambda: float.from_number(BI(10 ** 400)))
show("complex.from_number(BI(10**400))", lambda: complex.from_number(BI(10 ** 400)))
show("float.from_number(x=1)", lambda: float.from_number(x=1))
show("float.from_number(1, 2)", lambda: float.from_number(1, 2))
show("complex.from_number(x=1)", lambda: complex.from_number(x=1))
show("complex.from_number()", lambda: complex.from_number())
show("add_note('a', 'b')", lambda: ValueError().add_note('a', 'b'))
show("add_note()", lambda: ValueError().add_note())
def del_suppress():
    e = ValueError(); del e.__suppress_context__
show("del __suppress_context__", del_suppress)
for s in ("4", "4 1", "41 4", "", " ", "4x", "x4", "41 ", "4\t1"):
    show(f"fromhex {s!r}", lambda: bytes.fromhex(s))
    show(f"bytearray.fromhex {s!r}", lambda: bytearray.fromhex(s))
# fromhex of any bytes-like object (a memoryview, an array, bytearray), read byte by byte; anything else CPython's
# TypeError
import array
for fname, f in (("bytes.fromhex", bytes.fromhex), ("bytearray.fromhex", bytearray.fromhex), ("B.fromhex", B.fromhex), ("BA.fromhex", BA.fromhex)):
    for label, x in (("memoryview(b'4142')", memoryview(b'4142')), ("bytearray(b'41 42')", bytearray(b'41 42')), ("array('B')", array.array('B', b'4142')),
                     ("memoryview(b'\\xe9')", memoryview(b'\xe9')), ("b'\\xe9'", b'\xe9'), ("5", 5), ("None", None), ("memoryview(b'4')", memoryview(b'4'))):
        show(f"{fname}({label})", lambda: f(x))
# a contiguous buffer only (a strided memoryview CPython's BufferError), and a
# Python-level exporter (PEP 688): its __buffer__(0), then __release_buffer__
log = []
class Buf:
    def __buffer__(self, flags): log.append(('buffer', flags)); return memoryview(b"4142")
    def __release_buffer__(self, view): log.append(('release', type(view).__name__))
class BadBuf:
    def __buffer__(self, flags): return b"4142"
class NoRelease:
    def __buffer__(self, flags): return memoryview(b"41")
for fname, f in (("bytes.fromhex", bytes.fromhex), ("bytearray.fromhex", bytearray.fromhex), ("B.fromhex", B.fromhex)):
    for label, mk in (("Buf()", Buf), ("BadBuf()", BadBuf), ("NoRelease()", NoRelease), ("strided view", lambda: memoryview(b"441122")[::2])):
        del log[:]
        show(f"{fname}({label})", lambda: (f(mk()), list(log)))
# an exporter whose view is strided: CPython's BufferError, __release_buffer__ not called; one whose release raises:
# the result kept (CPython reports the release's exception as unraisable)
class StridedBuf:
    def __buffer__(self, flags): log.append('buffer'); return memoryview(b"441122")[::2]
    def __release_buffer__(self, view): log.append('release')
class BadRelease:
    def __buffer__(self, flags): return memoryview(b"41")
    def __release_buffer__(self, view): raise KeyError('release')
del log[:]
show("bytes.fromhex(StridedBuf())", lambda: (bytes.fromhex(StridedBuf()), list(log)))
print("log after strided |", log)
show("bytes.fromhex(BadRelease())", lambda: bytes.fromhex(BadRelease()))
# any Python exception from __release_buffer__ lets the result stand (CPython reports it as unraisable); a
# KeyboardInterrupt is Sagebrush's deliberate exception, a Stop never lost (test/runtime-core.test.ts)
for exc in (SystemExit(3), GeneratorExit(), ValueError('v')):
    class R:
        def __buffer__(self, flags): return memoryview(b"41")
        def __release_buffer__(self, view, exc=exc): raise exc
    show(f"release raising {type(exc).__name__}", lambda: bytes.fromhex(R()))
