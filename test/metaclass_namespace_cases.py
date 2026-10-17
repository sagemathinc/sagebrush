# The namespace a class body runs in is the one its metaclass is given (not
# a copy), as CPython's: a function metaclass, a type subclass, and the
# class's __classdict__ (astra's lazy-annotations ea4f6a63 note); compared
# with CPython by test/metaclass-namespace.test.ts
saved = []


def meta(n, b, ns):
    saved.append(ns)
    return 27


class C(metaclass=meta):
    value = 3

    def f(x: __classdict__): pass


ns = saved[0]
d = ns['f'].__annotate__(1)['x']
print(C, d is ns, type(ns).__name__)
d['value'] = 9
print(ns['value'], d['value'])
print(sorted(k for k in ns if not k.startswith('__')), ns['__module__'], ns['__qualname__'])


def meta2(n, b, ns):
    ns['added'] = 1
    saved.append(ns)
    return type(n, b, ns)


class D(metaclass=meta2):
    x = 1


print(D.added, D.x, saved[1]['added'], isinstance(saved[1], dict))


class M(type):
    def __new__(m, n, b, ns):
        saved.append(ns)
        ns['extra'] = 2
        return super().__new__(m, n, b, ns)


class E(metaclass=M):
    y = 1

    def g(x: __classdict__): pass


print(E.extra, E.y, type(saved[2]).__name__, 'extra' in E.g.__annotations__['x'])
