# astra's lazy-annotations 2f02dd88 findings (CORR-2F0-1); her raw-write
# case (CORR-2F0-2) is refused instead: test/annotations-review.test.ts
class M(type):
    @classmethod
    def __prepare__(m, name, bases): return {}
    def __new__(m, name, bases, ns):
        cls = super().__new__(m, name, bases, ns)
        cls.value = 9
        print('metaclass after type_new', cls.f.__annotations__['x'])
        return cls
class C(metaclass=M):
    value = 3
    def f(x: __classdict__['value']): pass
print('cached', C.f.__annotations__['x'], 'actual', C.value)
class Desc:
    def __set_name__(self, owner, name):
        owner.value = 9
        print('descriptor', owner.f.__annotations__['x'])
class PlainMeta(type):
    @classmethod
    def __prepare__(m, name, bases): return {}
class D(metaclass=PlainMeta):
    value = 3
    def f(x: __classdict__['value']): pass
    d = Desc()
