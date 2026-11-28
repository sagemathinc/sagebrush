# Python's object and control-flow protocols as CPython 3.14's (the Codex audit P01b): descriptor hooks of every
# callable form (__get__ called raw with the descriptor, __set__/__delete__/__set_name__ bound as methods), partial data
# descriptors refusing the missing half, a metaclass set-only descriptor leaving the class's value, __init_subclass__
# of every form, slotted exception subclasses keeping their dict, slot layout conflicts and nonempty slots on int,
# tuple and bytes refused, callable and descriptor context-manager hooks, generator.throw's argument forms,
# StopIteration thrown into a new or finished generator, GeneratorExit closing a delegate, gi_running. Compared
# with CPython line for line by test/object-protocols.test.ts.
import warnings
warnings.simplefilter("ignore")
log = []
def show(t, f):
    del log[:]
    try:
        r = f(); print(t, '|', repr(r), log)
    except BaseException as e: print(t, '| !!', type(e).__name__, e, log)
class Call:
    def __init__(self, tag, ret=None): self.tag, self.ret = tag, ret
    def __call__(self, *a): log.append((self.tag, len(a))); return self.ret
class Desc:
    def __init__(self, f): self.f = f
    def __get__(self, inst, owner): log.append('desc-get'); return self.f
# F1: __get__ forms
for nm, g in (("function", lambda self, i, o: 42), ("staticmethod", staticmethod(lambda self, i, o: 42)), ("callable", Call('get', 42)),
              ("classmethod", classmethod(lambda cls, i, o: 42)), ("descriptor", Desc(lambda *a: 42)), ("None", None), ("int", 5)):
    def f1(g=g):
        D = type('D', (), {'__get__': g}); C = type('C', (), {'x': D()}); return (C().x, C.x)
    show(f"F1 __get__ {nm}", f1)
for nm, s in (("function", lambda self, o, v: log.append(('set', v))), ("staticmethod", staticmethod(lambda o, v: log.append(('sset', v)))), ("callable", Call('set')),
              ("classmethod", classmethod(lambda cls, o, v: log.append(('cset', v)))), ("None", None)):
    def f1s(s=s):
        D = type('D', (), {'__set__': s}); C = type('C', (), {'x': D()}); c = C(); c.x = 7; return c.__dict__
    show(f"F1 __set__ {nm}", f1s)
for nm, s in (("function", lambda self, o: log.append('del')), ("staticmethod", staticmethod(lambda o: log.append('sdel'))), ("callable", Call('del')),
              ("classmethod", classmethod(lambda cls, o: log.append('cdel'))), ("None", None)):
    def f1d(s=s):
        D = type('D', (), {'__delete__': s}); C = type('C', (), {'x': D()}); c = C(); del c.x; return 'ok'
    show(f"F1 __delete__ {nm}", f1d)
for nm, s in (("function", lambda self, owner, name: log.append(('sn', owner.__name__, name))), ("staticmethod", staticmethod(lambda owner, name: log.append(('ssn', name)))),
              ("classmethod", classmethod(lambda cls, owner, name: log.append(('csn', cls.__name__, name)))), ("callable", Call('sn')), ("None", None), ("descriptor", Desc(lambda *a: log.append(('dsn', len(a)))))):
    def f1n(s=s):
        D = type('D', (), {'__set_name__': s}); C = type('C', (), {'x': D()}); return 'made'
    show(f"F1 __set_name__ {nm}", f1n)
# F2: partial descriptors
class DelOnly:
    def __delete__(self, obj): log.append('del')
class SetOnly:
    def __set__(self, obj, v): log.append(('set', v))
def f2a():
    class C: x = DelOnly()
    c = C(); c.x = 1; return c.__dict__
show("F2 delete-only set", f2a)
def f2b():
    class C: x = SetOnly()
    c = C(); c.__dict__['x'] = 5; del c.x; return c.__dict__
show("F2 set-only delete", f2b)
def f2c():
    class C: x = SetOnly()
    c = C(); c.__dict__['x'] = 5; return (c.x, type(C.__dict__['x']).__name__)
show("F2 set-only read shadow", f2c)
def f2d():
    class M(type): x = SetOnly()
    class C(metaclass=M): x = 3
    return C.x == 3
show("F2 meta set-only read", f2d)
def f2e():
    class M(type): x = DelOnly()
    class C(metaclass=M): pass
    C.x = 4; return C.__dict__.get('x')
show("F2 meta delete-only set", f2e)
def f2f():
    class M(type): x = SetOnly()
    class C(metaclass=M): x = 3
    del C.x; return 'x' in C.__dict__
show("F2 meta set-only del", f2f)
def f2g():
    class M(type): x = SetOnly()
    class C(metaclass=M): pass
    return type(C.x).__name__
show("F2 meta set-only no class value", f2g)
# F3: __init_subclass__ forms
for nm, h in (("staticmethod", staticmethod(lambda **kw: log.append(('s', kw)))), ("classmethod", classmethod(lambda cls, **kw: log.append(('c', cls.__name__, kw)))),
              ("callable", Call('init')), ("None", None), ("function", lambda cls, **kw: log.append(('f', cls.__name__, kw))), ("descriptor", Desc(lambda **kw: log.append(('d', kw))))):
    def f3(h=h):
        A = type('A', (), {'__init_subclass__': h}); B = type('B', (A,), {}); return 'ok'
    show(f"F3 {nm}", f3)
    def f3k(h=h):
        A = type('A', (), {'__init_subclass__': h}); B = type('B', (A,), {}, k=1); return 'ok'
    show(f"F3 {nm} kw", f3k)
# F4: slotted exceptions
for base in (Exception, BaseException, ValueError, StopIteration, OSError, AttributeError, KeyError):
    for slots in ((), ('a',)):
        def f4(base=base, slots=slots):
            E = type('E', (base,), {'__slots__': slots}); e = E(); e.extra = 3; return (hasattr(e, '__dict__'), e.extra)
        show(f"F4 {base.__name__} slots={slots}", f4)
# F5: layout conflicts
def mk(*bases_slots):
    pass
for nm, f in (
    ("two slotted bases", lambda: type('C', (type('A', (), {'__slots__': ('a',)}), type('B', (), {'__slots__': ('b',)})), {})),
    ("same names", lambda: type('C', (type('A', (), {'__slots__': ('a',)}), type('B', (), {'__slots__': ('a',)})), {})),
    ("one empty", lambda: type('C', (type('A', (), {'__slots__': ('a',)}), type('B', (), {'__slots__': ()})), {})),
    ("both empty", lambda: type('C', (type('A', (), {'__slots__': ()}), type('B', (), {'__slots__': ()})), {})),
    ("slotted + plain", lambda: type('C', (type('A', (), {'__slots__': ('a',)}), type('B', (), {})), {})),
    ("int slots", lambda: type('C', (int,), {'__slots__': ('x',)})),
    ("int empty slots", lambda: type('C', (int,), {'__slots__': ()})),
    ("tuple slots", lambda: type('C', (tuple,), {'__slots__': ('x',)})),
    ("bytes slots", lambda: type('C', (bytes,), {'__slots__': ('x',)})),
    ("str slots", lambda: type('C', (str,), {'__slots__': ('x',)})),
    ("float slots", lambda: type('C', (float,), {'__slots__': ('x',)})),
    ("list slots", lambda: type('C', (list,), {'__slots__': ('x',)})),
    ("dict slots", lambda: type('C', (dict,), {'__slots__': ('x',)})),
    ("slotted + Exception", lambda: type('C', (type('A', (), {'__slots__': ('a',)}), Exception), {})),
    ("shared ancestor", lambda: (lambda P: type('C', (type('A', (P,), {'__slots__': ('a',)}), type('B', (P,), {'__slots__': ('b',)})), {}))(type('P', (), {'__slots__': ('p',)}))),
    ("diamond, one slots", lambda: (lambda P: type('C', (type('A', (P,), {'__slots__': ('a',)}), type('B', (P,), {})), {}))(type('P', (), {'__slots__': ('p',)}))),
):
    show(f"F5 {nm}", lambda: f().__name__)
# F6: context manager hook forms
for nm, enter, exit_ in (("callables", Call('enter'), Call('exit', True)), ("descriptors", Desc(lambda *a: log.append(('denter', len(a)))), Desc(lambda *a: (log.append(('dexit', len(a))), True)[1])),
                         ("staticmethods", staticmethod(lambda: log.append('senter')), staticmethod(lambda *a: (log.append(('sexit', len(a))), True)[1])),
                         ("functions", lambda self: log.append('fenter'), lambda self, *a: (log.append(('fexit', len(a))), True)[1])):
    def f6(enter=enter, exit_=exit_):
        C = type('C', (), {'__enter__': enter, '__exit__': exit_})
        with C():
            raise ValueError('body')
        return 'suppressed'
    show(f"F6 {nm}", f6)
    def f6b(enter=enter, exit_=exit_):
        C = type('C', (), {'__enter__': enter, '__exit__': exit_})
        with C() as v:
            pass
        return v
    show(f"F6 {nm} no error", f6b)
# F7: throw argument forms
def gen():
    try: yield 1
    except ValueError as e: yield e.args
for nm, args in (("type, tuple", (ValueError, ('x', 'y'))), ("type, value", (ValueError, 'x')), ("type, None", (ValueError, None)), ("type", (ValueError,)),
                 ("instance", (ValueError('x'),)), ("instance, value", (ValueError('x'), 'y')), ("instance, None", (ValueError('x'), None)), ("type, instance", (ValueError, ValueError('z'))),
                 ("type, subclass instance", (Exception, ValueError('w'))), ("type, other instance", (ValueError, KeyError('k'))), ("not exc", (5,)), ("type, tuple, None", (ValueError, ('a',), None))):
    for state in ("new", "suspended", "closed"):
        def f7(args=args, state=state):
            g = gen()
            if state != "new": next(g)
            if state == "closed": g.close()
            r = g.throw(*args); g.close(); return r
        show(f"F7 {nm} {state}", f7)
# F8: StopIteration into new/closed
for state in ("new", "closed", "suspended"):
    def f8(state=state):
        def gen(): yield 1
        g = gen()
        if state != "new": next(g)
        if state == "closed": g.close()
        return g.throw(StopIteration(7))
    show(f"F8 {state}", f8)
    def f8b(state=state):
        def gen(): yield 1
        g = gen()
        if state != "new": next(g)
        if state == "closed": g.close()
        return g.throw(StopIteration)
    show(f"F8 type {state}", f8b)
# F10
class It:
    def __iter__(self): return self
    def __next__(self): return 1
    def throw(self, *args): log.append('throw'); return 2
    def close(self): log.append('close')
def f10():
    def gen(): yield from It()
    g = gen(); next(g)
    try: r = g.throw(GeneratorExit)
    except GeneratorExit: r = 'GeneratorExit'
    g.close(); return r
show("F10 GeneratorExit via throw", f10)
def f10b():
    def gen(): yield from It()
    g = gen(); next(g)
    try: r = g.throw(GeneratorExit())
    except GeneratorExit: r = 'GeneratorExit'
    return r
show("F10 GeneratorExit instance", f10b)
def f10c():
    def gen(): yield from It()
    g = gen(); next(g); r = g.throw(ValueError); g.close(); return r
show("F10 ValueError via throw", f10c)
# F11
def f11():
    def gen(): yield g.gi_running
    g = gen(); a = g.gi_running; b = next(g); c = g.gi_running; g.close(); return (a, b, c)
show("F11 gi_running", f11)
def f11b():
    def gen():
        yield g.gi_running
        yield g.gi_running
    g = gen(); return [x for x in g]
show("F11 gi_running loop", f11b)
# a generator closed before it started, then thrown into: the exception as it is
def f8c():
    def gen(): yield 1
    g = gen(); g.close(); return g.throw(StopIteration(7))
show("F8 closed unstarted", f8c)
# a missing __enter__ or __exit__, each refused before anything runs
show("F6 no __enter__", lambda: (lambda C: exec("with C(): pass", {"C": C}))(type('C', (), {'__exit__': lambda *a: None})))
show("F6 no __exit__", lambda: (lambda C: exec("with C(): pass", {"C": C}))(type('C', (), {'__enter__': lambda self: log.append('entered')})))
# the library's time.struct_time keeps its layout (its extra fields), and nothing of its marker shows
import time
st = time.localtime(0)
show("struct_time fields", lambda: (len(st), st.tm_year >= 1969, type(st.tm_gmtoff).__name__, hasattr(type(st), '__sagebrush_native_slots__')))
