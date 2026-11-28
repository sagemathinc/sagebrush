# More of Python's object and control-flow protocols as CPython 3.14's (the Codex audit P01b, the TESTS review's
# probes): a re-entrant next() leaving the running generator's state alone, the with hooks bound __exit__ first,
# nonempty __slots__ of __dict__ or __weakref__ on tuple, int and bytes refused, a plain __init_subclass__ set on the
# class later called with no class, the native-slots marker not honoured in user code. Compared with CPython by
# test/object-protocols.test.ts. (An exception's __dict__ showing args is a separate, older difference, not checked here.)
import warnings
warnings.simplefilter("ignore")
log = []
def show(t, f):
    del log[:]
    try:
        r = f(); print(t, '|', repr(r), log)
    except BaseException as e: print(t, '| !!', type(e).__name__, e, log)
# re-entrant next: the outer generator stays running and live
def reent():
    def g():
        yield me.gi_running
        try: next(me)
        except ValueError as e: log.append(str(e))
        yield me.gi_running
        yield 'after'
    me = g(); return [next(me), next(me), next(me), me.gi_running]
show("R1 re-entry keeps gi_running", reent)
def reent2():
    def g():
        try: next(me)
        except ValueError: pass
        yield 1
        yield 2
    me = g(); a = next(me)
    try: me.throw(StopIteration)
    except BaseException as e: return (a, type(e).__name__, type(e.__cause__).__name__)
show("R2 re-entry then StopIteration thrown in: PEP 479", reent2)
def reent3():
    def g():
        try: me.send(None)
        except ValueError: pass
        yield 1
    me = g(); a = next(me); me.close(); return (a, me.gi_running, list(me))
show("R3 re-entry via send", reent3)
def reent4():
    def g():
        try: me.throw(KeyError)
        except ValueError as e: log.append(str(e))
        yield 1
        yield 2
    me = g(); return [next(me), next(me)]
show("R4 re-entry via throw", reent4)
def fin1():
    def g(): yield 1
    x = g(); list(x)
    try: x.throw(StopIteration)
    except BaseException as e: return type(e).__name__
show("R5 StopIteration into finished", fin1)
def fin2():
    def g():
        yield 1; raise KeyError
    x = g(); next(x)
    try: next(x)
    except KeyError: pass
    try: x.throw(StopIteration("v"))
    except BaseException as e: return (type(e).__name__, e.args)
show("R6 StopIteration into a generator that raised", fin2)
def fin3():
    def g(): yield 1
    x = g(); x.close()
    try: x.throw(StopIteration)
    except BaseException as e: return (type(e).__name__, x.gi_running)
show("R7 StopIteration into closed new", fin3)
def fin4():
    def g():
        try: yield 1
        finally: log.append(x.gi_running)
    x = g(); next(x); x.close(); return x.gi_running
show("R8 gi_running inside finally on close", fin4)
def fin5():
    def g():
        yield 1
        return 5
    x = g(); next(x)
    try: x.throw(StopIteration)
    except BaseException as e: return (type(e).__name__, type(e.__cause__).__name__)
show("R9 StopIteration into a live generator at a yield", fin5)
# throw forms
def g0():
    yield 1
for nm, a in (("cls tuple", (ValueError, (1, 2))), ("cls inst", (ValueError, ValueError(3))), ("inst val", (ValueError(1), 2)),
              ("cls None", (KeyError, None)), ("inst None", (KeyError(4), None)), ("cls str", (KeyError, "k")), ("subcls inst", (LookupError, KeyError(5))),
              ("cls other inst", (KeyError, ValueError(6))), ("cls tb", (ValueError, 1, None)), ("not exc", (5,)), ("cls empty tuple", (ValueError, ()))):
    def ft(a=a):
        x = g0(); next(x)
        try: x.throw(*a)
        except BaseException as e: return (type(e).__name__, e.args)
    show(f"T {nm}", ft)
# with hooks
class D:
    def __init__(self, f, tag): self.f, self.tag = f, tag
    def __get__(self, i, o): log.append(('get', self.tag)); return self.f.__get__(i, o)
def w1():
    class M:
        __enter__ = D(lambda s: log.append('enter') or s, 'enter')
        __exit__ = D(lambda s, *a: log.append('exit'), 'exit')
    m = M()
    with m as a, m as b: log.append('body')
    return a is b
show("W1 same object twice", w1)
def w2():
    class M:
        __enter__ = D(lambda s: log.append('enter'), 'enter')
    with M(): pass
show("W2 no __exit__", w2)
def w3():
    class M:
        __exit__ = D(lambda s, *a: None, 'exit')
    with M(): pass
show("W3 no __enter__", w3)
def w4():
    class M:
        __enter__ = D(lambda s: log.append('enter'), 'enter')
        __exit__ = D(lambda s, *a: log.append('exit'), 'exit')
    def g():
        with M():
            yield 1
            with M():
                yield 2
    return list(g())
show("W4 nested in a generator", w4)
def w5():
    class Bad:
        def __get__(s, i, o): log.append('badget'); raise KeyError('x')
    class M:
        __enter__ = D(lambda s: log.append('enter'), 'enter')
        __exit__ = Bad()
    m = M()
    try:
        with m: pass
    except KeyError: log.append('caught')
    class N:
        __enter__ = D(lambda s: log.append('enter2'), 'enter2')
        __exit__ = D(lambda s, *a: log.append('exit2'), 'exit2')
    with N(): pass
show("W5 __exit__ get raises, then another with", w5)
def w6():
    class M:
        __enter__ = staticmethod(lambda: log.append('senter'))
        __exit__ = classmethod(lambda c, *a: log.append(('cexit', c.__name__)))
    with M(): pass
show("W6 static/class hooks", w6)
def w7():
    class E:
        def __enter__(s): raise ValueError('e')
        def __exit__(s, *a): log.append('exit'); return True
    with E(): pass
show("W7 enter raises", w7)
# slots
def sl(src):
    def f():
        ns = {}; exec(src, ns); return 'ok'
    return f
for nm, src in (("int slot", "class I(int): __slots__=('a',)"), ("int empty", "class I(int): __slots__=()"),
                ("tuple dict", "class T(tuple): __slots__=('__dict__',)"), ("tuple weakref", "class T(tuple): __slots__=('__weakref__',)"),
                ("bytes str", "class B(bytes): __slots__='x'"), ("str slot", "class S(str): __slots__=('a',)"),
                ("float slot", "class F(float): __slots__=('a',)"), ("list slot", "class L(list): __slots__=('a',)"),
                ("int via sub", "class I(int): pass\nclass J(I): __slots__=('a',)"),
                ("A,B slots", "class A: __slots__=('a',)\nclass B: __slots__=('b',)\nclass C(A,B): pass"),
                ("A,int", "class A: __slots__=('a',)\nclass C(A,int): pass"),
                ("int,A", "class A: __slots__=('a',)\nclass C(int,A): pass"),
                ("A,Exception", "class A: __slots__=('a',)\nclass C(A,Exception): pass"),
                ("empty,empty", "class A: __slots__=()\nclass B: __slots__=()\nclass C(A,B): pass"),
                ("A2,B(A)", "class A: __slots__=('a',)\nclass A2(A): pass\nclass B(A): __slots__=('b',)\nclass C(A2,B): pass"),
                ("A,dict", "class A: __slots__=('a',)\nclass C(dict,A): pass"),
                ("A,object", "class A: __slots__=('a',)\nclass C(A,object): pass"),
                ("dictslot,B", "class A: __slots__=('__dict__',)\nclass B: __slots__=('b',)\nclass C(A,B): pass"),
                ("exc slots dict", "class E(Exception): __slots__=('a',)\ne=E(); e.x=1; assert e.x == 1 and e.__dict__['x'] == 1"),
                ("exc slots sub", "class E(KeyError): __slots__=('a',)\nclass F(E): __slots__=('b',)\nf=F(); f.y=2"),
                ("struct_time", "import time\nt=time.gmtime(0); assert t.tm_year==1970 and not hasattr(type(t),'__sagebrush_native_slots__')"),
                ("native flag user", "class T(tuple):\n  __slots__=('a',)\n  __sagebrush_native_slots__=True"),
                ):
    show(f"S {nm}", sl(src))
# descriptors
def d1():
    class DelOnly:
        def __delete__(s, o): log.append('del')
    class C: x = DelOnly()
    c = C()
    try: c.x = 1
    except AttributeError as e: log.append(str(e))
    del c.x
    return c.__dict__
show("D1 delete-only set", d1)
def d2():
    class SetOnly:
        def __set__(s, o, v): log.append(('set', v))
    class C: x = SetOnly()
    c = C(); c.x = 3
    try: del c.x
    except AttributeError as e: log.append(str(e))
    return type(C.x).__name__
show("D2 set-only del", d2)
def d3():
    class SetOnly:
        def __set__(s, o, v): log.append(('mset', v))
    class M(type): x = SetOnly()
    class C(metaclass=M): x = 5
    C.x = 6
    return (C.x, C.__dict__['x'])
show("D3 metaclass set-only", d3)
def d4():
    class DelOnly:
        def __delete__(s, o): log.append('mdel')
    class M(type): x = DelOnly()
    class C(metaclass=M): pass
    try: C.x = 1
    except AttributeError as e: log.append(str(e))
    del C.x
    return 'x' in C.__dict__
show("D4 metaclass delete-only", d4)
def d5():
    class N:
        def __set_name__(s, o, n): log.append(('sn', n))
    class SN:
        __set_name__ = staticmethod(lambda o, n: log.append(('ssn', n)))
    class C:
        a = N(); b = SN()
    return 'ok'
show("D5 set_name forms", d5)
# __init_subclass__
def i1():
    class A:
        __init_subclass__ = staticmethod(lambda **kw: log.append(('s', kw)))
    class B(A, k=1): pass
    class C(B): pass
show("I1 staticmethod init_subclass", i1)
def i2():
    class A:
        def __init_subclass__(cls, **kw): log.append((cls.__name__, kw))
    class B(A, k=1): pass
    A.__init_subclass__ = lambda cls, **kw: log.append(('late', cls.__name__))
    class C(A): pass
show("I2 function and late assignment", i2)
def i3():
    class A: pass
    class B(A, k=1): pass
show("I3 object's with keywords", i3)
def i4():
    class Cl:
        def __call__(s, **kw): log.append(('call', kw))
    class A:
        __init_subclass__ = Cl()
    class B(A, z=2): pass
show("I4 callable object", i4)
def i5():
    class A:
        @classmethod
        def __init_subclass__(cls, **kw): log.append(('A', cls.__name__))
    class B(A):
        def __init_subclass__(cls, **kw): log.append(('B', cls.__name__)); super().__init_subclass__()
    class C(B): pass
show("I5 chain", i5)
