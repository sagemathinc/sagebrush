# astra's match-statement review probe (probe.py, 35611c48), compared with CPython 3.14 by test/match.test.ts
import collections.abc as abc

log=[]
def show(label, f):
    log.clear()
    try:
        print(label, 'ok', repr(f()), 'log', repr(log))
    except Exception as e:
        print(label, type(e).__name__, str(e), 'log', repr(log))

# Mapping key evaluation must follow subject kind and length checks.
class KeySource:
    @property
    def key(self):
        log.append('key')
        raise RuntimeError('key looked up')
K=KeySource()
def key_order(s):
    match s:
        case {K.key: v}: return v
        case _: return 'miss'
show('mapping-nonmapping', lambda:key_order(1))
show('mapping-too-short', lambda:key_order({}))
show('mapping-enough', lambda:key_order({'a':1}))

# Sequence subclass protocol, and wildcard patterns that require no unpacking.
class Seq(abc.Sequence):
    def __len__(self):
        log.append('len'); return 2
    def __getitem__(self, i):
        log.append(('item',i))
        if i>=2: raise IndexError
        return 10+i
    def __iter__(self):
        log.append('iter'); raise RuntimeError('iterator accessed')
def wild(s):
    match s:
        case [_, _]: return 'matched'
        case _: return 'miss'
def starwild(s):
    match s:
        case [*_]: return 'matched'
        case _: return 'miss'
def first(s):
    match s:
        case [x,*_]: return x
        case _: return 'miss'
show('seq-wildcards',lambda:wild(Seq()))
show('seq-star-wildcard',lambda:starwild(Seq()))
show('seq-first-star',lambda:first(Seq()))
class L(list):
    def __iter__(self):
        log.append('list-iter'); return iter([8,9])
def pair(s):
    match s:
        case [a,b]: return (a,b)
        case _: return 'miss'
show('list-override',lambda:pair(L([1,2])))

# Repeated positional attributes and evaluation order in __match_args__.
class C:
    __match_args__=('x','x')
    @property
    def x(self): log.append('get-x'); return 1
def duplicate(s):
    match s:
        case C(a,b): return (a,b)
        case _: return 'miss'
show('class-duplicate',lambda:duplicate(C()))
class Bad:
    __match_args__=('missing',1)
def badargs(s):
    match s:
        case Bad(a,b): return (a,b)
        case _: return 'miss'
show('class-missing-before-invalid',lambda:badargs(Bad()))
class Missing:
    __match_args__=('missing',)
def missingdup(s):
    match s:
        case Missing(a,missing=b): return (a,b)
        case _: return 'miss'
show('class-missing-before-duplicate',lambda:missingdup(Missing()))

# Empty mapping should require only mapping type, not len/get/iteration.
class M(abc.Mapping):
    def __len__(self): log.append('len'); raise RuntimeError('len accessed')
    def __iter__(self): log.append('iter'); return iter(())
    def __getitem__(self,k): raise KeyError(k)
def empty_map(s):
    match s:
        case {}: return 'matched'
        case _: return 'miss'
show('empty-map',lambda:empty_map(M()))

# Duplicate literal keys are compile-time errors, including signed/complex keys.
for label, pattern in [('negative','{-1:a,-1:b}'),('complex','{1+0j:a,1:b}'),('signedzero','{-0.0:a,0:b}'),('bigfloat','{1000000000000000000000:a,1e21:b}'),('negcomplex','{-1-2j:a,-1-2j:b}'),('newline',"{'a\\nb':a,'a\\nb':b}"),('bytes',"{b'a':a,b'a':b}")]:
    src='match {}:\n case '+pattern+': pass\n'
    try:
        compile(src,'<dup>','exec')
        print('compile-'+label,'accepted')
    except SyntaxError as e:
        print('compile-'+label,repr((e.msg,e.lineno,e.offset,e.end_lineno,e.end_offset)))

# Class namespace captures and temporary names: exact user key order.
class Order:
    before=0
    match [1,2,3]:
        case [a,b,c] if False: pass
        case [d,e,f]: after=4
    snapshot=list(locals())
print('class-keys', [k for k in Order.__dict__ if k in ('before','a','b','c','d','e','f','after','snapshot') or k.startswith('$')])
print('class-locals', [k for k in Order.snapshot if k in ('before','a','b','c','d','e','f','after') or k.startswith('$')])
