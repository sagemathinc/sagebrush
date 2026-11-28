# Evaluation order and semantics as CPython 3.14's (the Codex audit R07 of the Python
# evaluator, one section a finding), compared with CPython line for line by
# test/eval-order.test.ts
log = []


def note(tag, value=None):
    log.append(tag)
    return value


def show(label, f):
    del log[:]
    try:
        r = repr(f())
    except BaseException as e:
        r = f'{type(e).__name__}: {e}'
    print(label, r, log)


# 1. in and not in: the item, then the container
xs = [1, 2]
show('in pop/copy', lambda: xs.pop(0) in xs.copy())
xs = [1, 2]
show('not in pop/copy', lambda: xs.pop(0) not in xs.copy())
show('in log', lambda: note('item', 1) in note('container', [1]))
show('not in log', lambda: note('item', 1) not in note('container', [1]))
show('chain log', lambda: note('a', 1) in note('b', [1]) in note('c', [[1]]))
show('chain short', lambda: note('a', 2) in note('b', [1]) in note('c', [[1]]))


# 2. a method looked up on its receiver before its arguments run
class C:
    def f(self, x): return 'old'


c = C()


def rebind():
    c.f = lambda x: 'new'
    return 0


show('method rebound in arg', lambda: c.f(rebind()))
show('method rebound, two args', lambda: C().f(note('arg', 1)))


class P:
    @property
    def m(self):
        note('lookup')
        return lambda *a: a


show('property lookup first', lambda: P().m(note('arg1', 1), note('arg2', 2)))
show('constant args', lambda: P().m(1, 'x'))
show('missing method, arg raises', lambda: object().nope(undefined_name))


def recurse(n, acc):
    return acc if n == 0 else acc.append(recurse(n - 1, acc)) or acc


show('same site re-entered', lambda: len(recurse(3, [])))


class Counter:
    def __init__(self): self.n = 0
    def bump(self, k): self.n += k; return self


show('chained calls', lambda: Counter().bump(1).bump(note('two', 2)).n)


# 3. keywords and ** mappings, each where it stands
d = {'a': 1}


def mutate():
    d['a'] = 2
    return 0


def kw(*args, **kwargs): return args, kwargs


show('mapping read before later keyword', lambda: kw(**d, b=mutate()))
show('keyword order', lambda: list(kw(a=0, **{'b': 1}, c=2)[1]))
show('log order', lambda: kw(**note('a', {'a': 1}), b=note('b', 2), **note('c', {'c': 3}), d=note('d', 4)))
show('positional before keywords', lambda: kw(note('p', 0), x=note('x', 1), **note('m', {})))
show('keyword before *args', lambda: kw(b=note('b', 1), *note('args', [2])))
show('repeated after mapping', lambda: kw(**{'a': 1}, a=2))
show('repeated across mappings', lambda: kw(**{'a': 1}, **{'a': 2}))
show('repeated value runs first', lambda: kw(**{'a': 1}, a=note('value', 2)))
show('not a mapping', lambda: kw(a=1, **note('m', 3)))
show('non-string key', lambda: kw(**{1: 2}))
show('repeated in a run: the run runs first', lambda: kw(**{'a': 0}, a=note('dup'), b=note('later'), **note('m', {})))
show('non-string key: later keywords run first', lambda: kw(**{1: 0}, a=note('later')))
show('non-string key, then repeated', lambda: kw(**{1: 0}, **{'a': 1}, a=note('later')))
show('non-string key, then a mapping', lambda: kw(**{1: 0}, **note('m2', {'x': 1})))


class KeysMapping:
    def keys(self): note('keys'); return [1, 'b']
    def __getitem__(self, k): note('get %r' % (k,)); return 5


show('a mapping with a non-string key, read whole', lambda: kw(**KeysMapping(), c=note('c')))


# 4. range's callable loaded before its arguments
def swap_range():
    globals()['range'] = lambda n: [99]
    return 3


def range_loop():
    out = []
    for i in range(swap_range()):
        out.append(i)
    return out


show('range rebound in arg', range_loop)
# (not `del range`: a statement binding range at the top level would turn the loop's optimized range off)
globals().pop('range')
show('range restored', range_loop)
globals().pop('range')


def call_rebound():
    def f(x): return 'old'
    g = {'f': f}

    def arg():
        g['f'] = lambda x: 'new'
        return 1
    return g['f'](arg())


show('plain call rebound in arg', call_rebound)

# 5. an f-string's conversion before its format specification runs
state = ['old']


class S:
    def __str__(self): note('str'); return state[0]
    def __repr__(self): note('repr'); return state[0] + '!'
    def __format__(self, spec): note('format'); return 'F' + spec


def spec(text=''):
    note('spec')
    state[0] = 'new'
    return text


state[0] = 'old'
show('!s then spec', lambda: f'{S()!s:{spec()}}')
state[0] = 'old'
show('!r then spec', lambda: f'{S()!r:{spec(">8")}}')
state[0] = 'old'
show('!a then spec', lambda: f'{S()!a:{spec()}}')
state[0] = 'old'
show('no conversion: spec then format', lambda: f'{S():{spec("x")}}')
state[0] = 'old'
show('literal spec', lambda: f'{S()!s:>6}')


# 6. a class statement's ** mappings, its metaclass included
class M(type):
    pass


def make_meta():
    class K(**{'metaclass': M}):
        pass
    return type(K).__name__


show('metaclass from mapping', make_meta)


class Base:
    def __init_subclass__(cls, **kw):
        cls.kw = kw


def make_sub():
    class Sub(Base, **note('m', {'a': 1}), b=note('b', 2)):
        pass
    return Sub.kw


show('init_subclass keywords', make_sub)


def class_repeat():
    class R(Base, **{'a': 1}, a=2):
        pass


show('class keyword repeated', class_repeat)


def class_repeat_run():
    class R(Base, **{'a': 0}, a=note('dup'), b=note('later')):
        pass


def class_non_string():
    class R(Base, **{1: 0}, a=note('later')):
        pass


show('class keyword repeated in a run', class_repeat_run)
show('class non-string key', class_non_string)


def class_not_mapping():
    class R(Base, **3):
        pass


show('class mapping not a mapping', class_not_mapping)


# 7. yield from a list or a tuple: the iterator protocol, send, throw and close as CPython's
def deleg(source):
    value = yield from source
    yield value


def run(source, op):
    it = deleg(source)
    first = next(it)
    try:
        if op == 'send':
            got = it.send(9)
        elif op == 'throw':
            got = it.throw(ValueError('v'))
        elif op == 'stop':
            got = it.throw(StopIteration(7))
        elif op == 'close':
            got = it.close()
        else:
            got = list(it)
    except AttributeError as e:
        # (the type alone: Sagebrush's tuple iterator is named list_iterator, a separate gap)
        got = type(e).__name__
    except BaseException as e:
        got = f'{type(e).__name__}: {e}'
    return first, got


for kind, source in (('list', lambda: [1, 2]), ('tuple', lambda: (1, 2)), ('range', lambda: range(1, 3))):
    for op in ('next', 'send', 'throw', 'stop', 'close'):
        show(f'yield from {kind} {op}', lambda: run(source(), op))


# 8. eval() and locals() in a comprehension inlined in a function see the function's locals
def comp_eval():
    x = 10
    return [eval('x+i') for i in range(3)]


def comp_locals():
    x, y = 10, 5
    return [sorted(locals()) for i in range(1)]


def comp_nested():
    x = 1
    return [[sorted(locals()) for j in range(1)] for i in range(1)]


def comp_shadow():
    i = 'outer'
    return [sorted(locals().items()) for i in range(1)], i


def comp_walrus():
    a = 1
    [b := 2 for i in range(1)]
    return [sorted(locals()) for i in range(1)], b


def comp_cell():
    x = 10
    g = lambda: x
    return [eval('x*i') for i in range(3)], g()


def comp_late():
    x = 1
    r = [locals()['x'] for i in range(1)]
    x = 2
    return r, [locals()['x'] for i in range(1)]


for name, f in (('eval', comp_eval), ('locals', comp_locals), ('nested', comp_nested), ('shadow', comp_shadow),
                ('walrus', comp_walrus), ('cell', comp_cell), ('late', comp_late)):
    show(f'comprehension {name}', f)
show('top-level comprehension', lambda: [sorted(k for k in locals() if not k.startswith('__')) for i in range(1)])


class InClass:
    a = 1
    r = [sorted(locals()) for i in range(1)]


show('class comprehension', lambda: InClass.r)
