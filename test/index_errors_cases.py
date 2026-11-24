# Sequence index errors against CPython: a list's assignment and deletion out of
# range name the assignment ("list assignment index out of range"), its reads and
# pop their own; bytearray.pop takes an index, as CPython's.
from array import array
from collections import deque


class L(list):
    pass


class I:
    def __index__(self):
        return 1


def show(name, f):
    try:
        print(name, repr(f()))
    except Exception as e:
        print(name, type(e).__name__, e)


def assign_local():
    l = [1, 2]
    l[5] = 0


def delete_local():
    l = [1, 2]
    del l[-3]


def augment():
    l = [1, 2]
    l[5] += 1


def after(f, x):
    f(x)
    return x


for name, f in [
    ("set", lambda: [1, 2].__setitem__(5, 0)), ("set-negative", lambda: [1, 2].__setitem__(-3, 0)),
    ("set-empty", lambda: [].__setitem__(0, 1)), ("set-subclass", lambda: L([1]).__setitem__(2, 0)),
    ("set-index-object", lambda: [1].__setitem__(I(), 0)), ("set-local", assign_local),
    ("del", lambda: [1, 2].__delitem__(5)), ("del-negative", delete_local), ("del-subclass", lambda: L([1]).__delitem__(-2)),
    ("get", lambda: [1, 2][5]), ("get-negative", lambda: [1, 2][-3]), ("augmented", augment),
    ("pop", lambda: [1, 2].pop(5)), ("pop-empty", lambda: [].pop()), ("insert-far", lambda: after(lambda l: l.insert(9, 3), [1])),
    ("set-in-range", lambda: after(lambda l: l.__setitem__(-1, 9), [1, 2])),
    ("ba-pop", lambda: after(lambda b: b.pop(), bytearray(b"abc"))), ("ba-pop-value", lambda: bytearray(b"abc").pop(0)),
    ("ba-pop-middle", lambda: (lambda b: (b.pop(1), b))(bytearray(b"abc"))), ("ba-pop-negative", lambda: (lambda b: (b.pop(-3), b))(bytearray(b"abc"))),
    ("ba-pop-index-object", lambda: (lambda b: (b.pop(I()), b))(bytearray(b"abc"))), ("ba-pop-range", lambda: bytearray(b"a").pop(3)),
    ("ba-pop-range-negative", lambda: bytearray(b"a").pop(-2)), ("ba-pop-empty", lambda: bytearray().pop()),
    ("ba-pop-empty-index", lambda: bytearray().pop(5)), ("ba-pop-type", lambda: bytearray(b"a").pop("x")),
    ("ba-pop-float", lambda: bytearray(b"a").pop(1.0)), ("ba-set", lambda: bytearray(b"a").__setitem__(3, 1)),
    ("ba-del", lambda: bytearray(b"a").__delitem__(3)), ("array-set", lambda: array("i", [1]).__setitem__(3, 1)),
    ("deque-set", lambda: deque([1]).__setitem__(3, 1)),
]:
    show(name, f)
