# A sequence that can't add the other operand says so in CPython's words
# (PyNumber_Add's sequence concat): "can only concatenate T (not "X") to T"
# for str, list and tuple, "can't concat X to Y" for bytes and bytearray.
# Each line is compared with CPython's (test/seq-concat.test.ts).
import array, collections


def t(label, f):
    try:
        print(label, repr(f()))
    except Exception as e:
        print(label, type(e).__name__ + ":", e)


class B(bytes): pass
class BA(bytearray): pass
class L(list): pass
class T(tuple): pass
class S(str): pass
class OwnAdd(list):
    def __add__(self, other):
        return NotImplemented
class OwnStr(str):
    def __add__(self, other):
        return NotImplemented
class R:
    def __radd__(self, other):
        return "radd"
class Plain: pass

lefts = [("str", "s"), ("list", [1]), ("tuple", (1,)), ("bytes", b"b"), ("bytearray", bytearray(b"b")),
         ("B", B(b"b")), ("BA", BA(b"b")), ("L", L([1])), ("T", T((1,))), ("S", S("s")),
         ("OwnAdd", OwnAdd([1])), ("OwnStr", OwnStr("s")), ("memoryview", memoryview(b"m")),
         ("int", 5), ("float", 1.5), ("None", None), ("Plain", Plain())]
rights = [("int", 5), ("str", "x"), ("bytes", b"y"), ("list", [2]), ("tuple", (2,)), ("None", None),
          ("float", 2.5), ("dict", {}), ("bytearray", bytearray(b"z")), ("memoryview", memoryview(b"w")),
          ("R", R()), ("Plain", Plain()), ("S", S("q")), ("B", B(b"q"))]
for ln, a in lefts:
    for rn, b in rights:
        t(f"{ln} + {rn}:", lambda: a + b)

# augmented: += falls back to the same concat (immutable left operands)
for ln, a in [("str", "s"), ("tuple", (1,)), ("bytes", b"b"), ("S", S("s")), ("B", B(b"b"))]:
    for rn, b in [("int", 5), ("list", [2]), ("None", None)]:
        def aug():
            x = a
            x += b
            return x
        t(f"{ln} += {rn}:", aug)
# a mutable sequence's own += (list extends from any iterable; bytearray from a buffer)
for ln, mk in [("list", lambda: [1]), ("bytearray", lambda: bytearray(b"b"))]:
    for rn, b in [("int", 5), ("str", "xy"), ("tuple", (2,)), ("bytes", b"y"), ("None", None)]:
        def aug():
            x = mk()
            x += b
            return x
        t(f"{ln} += {rn}:", aug)

# the other builtin sequences that concat
t("deque + int:", lambda: collections.deque([1]) + 5)
t("deque + list:", lambda: collections.deque([1]) + [2])
t("array + int:", lambda: array.array("b", [1]) + 5)
t("array + array other type:", lambda: array.array("b", [1]) + array.array("i", [2]))
class A(array.array):
    def __add__(self, other):
        return NotImplemented
class A2(array.array): pass
t("array subclass, own __add__ + int:", lambda: A("b", [1]) + 5)
t("array subclass + int:", lambda: A2("b", [1]) + 5)
t("array + R:", lambda: array.array("b", [1]) + R())
t("array + array:", lambda: array.array("b", [1]) + array.array("b", [2]))
