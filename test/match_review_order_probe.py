# astra's match-statement review probe (order_probe.py, 35611c48), compared with CPython 3.14 by test/match.test.ts
import collections.abc as abc
log=[]
def show(label, f):
    log.clear()
    try: print(label,'ok',repr(f()),'log',repr(log))
    except Exception as e: print(label,type(e).__name__,str(e),'log',repr(log))

class Vary(abc.Sequence):
    def __len__(self): return 2
    def __getitem__(self,i): return [1,2,3][i]
    def __iter__(self): return iter([1,2,3])
def star(s):
    match s:
        case [head,*tail]: return head,tail
show('star-count',lambda:star(Vary()))

class Map(abc.Mapping):
    def __len__(self): log.append('len'); return 2
    def __iter__(self): log.append('iter'); raise RuntimeError('rest copied')
    def __getitem__(self,k): log.append(('item',k)); return 9
    def get(self,k,d=None): log.append(('get',k)); return 9
def rest(s):
    match s:
        case {'x':0,**r}: return r
        case _: return 'miss'
show('rest-failed-subpattern',lambda:rest(Map()))

# Class namespace ordering for mapping rest, OR and AS captures.
class Rest:
    before=0
    match {'x':1,'z':2}:
        case {'x':a,**r}: after=3
class As:
    before=0
    match [1,2]:
        case [a,b] as c: after=3
class Or:
    before=0
    match [1,2]:
        case (0,a,b) | (b,a): after=3
for cls in [Rest,As,Or]:
    print('keys-'+cls.__name__, [n for n in cls.__dict__ if n in ('before','a','b','c','r','after') or n.startswith('$')])
    print('values-'+cls.__name__, [(n,getattr(cls,n)) for n in ('a','b','c','r') if hasattr(cls,n)])

# A prepared class namespace should see no compiler helper lookups.
class NS(dict):
    def __getitem__(self,k):
        log.append(('get',k)); return super().__getitem__(k)
    def __setitem__(self,k,v):
        log.append(('set',k)); return super().__setitem__(k,v)
class Meta(type):
    @classmethod
    def __prepare__(m,n,b): return NS()
log.clear()
class Prepared(metaclass=Meta):
    before=0
    match [1,2]:
        case [a,b]: after=3
print('prepared-helper-ops', [(op,k) for op,k in log if k.startswith('$') or k.startswith('__pyjs_')])
print('prepared-stores', [k for op,k in log if op=='set' and k in ('before','a','b','after')])

# Real type admission, not a spoofed __class__.
class Pretend:
    @property
    def __class__(self): return list
    def __len__(self): return 0
    def __iter__(self): return iter(())
def empty(s):
    match s:
        case []: return True
        case _: return False
show('spoofed-class',lambda:empty(Pretend()))

# Binding and guard evaluation with global/nonlocal, OR captures and failures.
x=10
def glob(s):
    global x
    match s:
        case [x] if False: pass
        case _: pass
    return x
show('global-capture',lambda:glob([31]))
def outer(s):
    x=10
    def inner():
        nonlocal x
        match s:
            case {'v':x} if False: pass
            case _: pass
    inner(); return x
show('nonlocal-capture',lambda:outer({'v':32}))
