# A metaclass's __setattr__ and __delattr__ for its classes, as CPython's
# type slots: setattr(), delattr(), C.x = v, del C.x, augmented
# assignment, type.__setattr__ and object.__setattr__ directly; compared
# with CPython by test/metaclass-setattr.test.ts
log = []


def show(label, f):
    log.clear()
    try:
        r = repr(f())
    except Exception as e:
        r = f'{type(e).__name__}: {e}'
    print(label, r, log)


class M(type):
    def __setattr__(cls, k, v):
        log.append(('set', cls.__name__, k, v))
        super().__setattr__(k, v)

    def __delattr__(cls, k):
        log.append(('del', cls.__name__, k))
        super().__delattr__(k)


class C(metaclass=M):
    a = 1


def aug():
    C.a += 5
    return C.a


def stmt_set():
    C.b = 2
    return C.b


def stmt_del():
    del C.b
    return hasattr(C, 'b')


show('setattr', lambda: (setattr(C, 'x', 1), C.x))
show('delattr', lambda: (delattr(C, 'x'), hasattr(C, 'x')))
show('statement set', stmt_set)
show('statement del', stmt_del)
show('augmented', aug)
show('del missing', lambda: delattr(C, 'nope'))


class D(C):
    pass


show('subclass set', lambda: (setattr(D, 'y', 3), D.y, 'y' in vars(D)))
show('subclass inherits', lambda: (setattr(C, 'z', 4), D.z))


class Block(type):
    def __setattr__(cls, k, v):
        log.append(('blocked', k))
        raise AttributeError(f'{cls.__name__} is read-only')

    def __delattr__(cls, k):
        log.append(('blocked del', k))


class F(metaclass=Block):
    v = 1


show('blocked set', lambda: setattr(F, 'v', 2))
show('blocked value', lambda: F.v)
show('swallowed del', lambda: (delattr(F, 'v'), F.v))


class Rec(type):
    def __setattr__(cls, k, v):
        log.append(('rec', k))
        type.__setattr__(cls, k, v * 10)


class G(metaclass=Rec):
    pass


show('type.__setattr__ call', lambda: (setattr(G, 'w', 2), G.w))
show('type.__setattr__ direct', lambda: (type.__setattr__(G, 'u', 1), G.u))
show('type.__delattr__ direct', lambda: (type.__delattr__(G, 'u'), hasattr(G, 'u')))
show('object.__setattr__ on class', lambda: object.__setattr__(G, 'u', 1))
show('object.__delattr__ on class', lambda: object.__delattr__(G, 'w'))
show('type.__setattr__ builtin', lambda: type.__setattr__(int, 'x', 1))
show('type.__setattr__ instance', lambda: type.__setattr__(G(), 'x', 1))
show('type.__setattr__ int name', lambda: type.__setattr__(G, 1, 1))
show('setattr int builtin', lambda: setattr(int, 'x', 1))


class Desc:
    def __set__(self, obj, v):
        log.append(('desc set', type(obj).__name__, v))

    def __get__(self, obj, owner=None):
        return 'desc'


class MD(type):
    p = Desc()


class H(metaclass=MD):
    pass


show('metaclass data descriptor', lambda: (setattr(H, 'p', 5), H.p))
print('dunder', '__setattr__' in vars(type), '__delattr__' in vars(type))
