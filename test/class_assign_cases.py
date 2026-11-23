# __class__ assignment (src/runtime/types.ts object.__class__'s setter): allowed between mutable classes whose
# instances have the same layout, CPython's compatible_for_assignment (the same slots, sorted, and the same __dict__
# over one base, after the bases that add nothing); refused otherwise, and for a builtin type's instance. Every line
# is CPython 3.14.10's (test/class_assign_cases.out, python3 -I).
import types

def t(label, f):
    try:
        r = f()
        print(label, "ok", r)
    except Exception as e:
        print(label, type(e).__name__, e)

class A:
    __slots__ = ("x", "y")
class B:
    __slots__ = ("x", "y")
class C:
    __slots__ = ("x",)
class D:
    __slots__ = ("y", "x")
class P:
    pass
class Q:
    pass
class S0:
    __slots__ = ()

a = A(); a.x = 1
def ab():
    a.__class__ = B
    return type(a).__name__, a.x
t("A->B", ab)
t("B.y unset", lambda: a.y)
def by():
    a.y = 5
    return a.y, a.x
t("B set y", by)
def bc():
    a.__class__ = C
t("B->C", bc)
def bd():
    a.__class__ = D
t("B->D", bd)
def back():
    a.__class__ = A
    return a.x, a.y
t("B->A", back)
def ap():
    a.__class__ = P
t("A->P", ap)
p = P(); p.z = 3
def pq():
    p.__class__ = Q
    return type(p).__name__, p.z, p.__dict__
t("P->Q", pq)
def pa():
    p.__class__ = A
t("Q->A", pa)
def ps0():
    p.__class__ = S0
t("Q->S0", ps0)
s = S0()
def s0p():
    s.__class__ = P
t("S0->P", s0p)
# subclasses adding nothing, over one slotted base
class A1(A):
    __slots__ = ()
class A2(A):
    __slots__ = ()
class A3(A):
    __slots__ = ("z",)
class A4(A):
    __slots__ = ("z",)
o = A1(); o.x = 7
def a12():
    o.__class__ = A2
    return type(o).__name__, o.x
t("A1->A2", a12)
def a2a():
    o.__class__ = A
    return o.x
t("A2->A", a2a)
o3 = A3(); o3.z = 9; o3.x = 1
def a34():
    o3.__class__ = A4
    return o3.z, o3.x
t("A3->A4", a34)
def a4a1():
    o3.__class__ = A1
t("A4->A1", a4a1)
# modules
class M(types.ModuleType):
    pass
m = types.ModuleType("m")
def mm():
    m.__class__ = M
    return type(m).__name__
t("module->M", mm)
# exceptions
class E1(Exception):
    pass
class E2(Exception):
    pass
e = E1("hi")
def ee():
    e.__class__ = E2
    return type(e).__name__, e.args
t("E1->E2", ee)
t("int", lambda: setattr(1, "__class__", bool))
t("object()", lambda: setattr(object(), "__class__", P))
t("P->int", lambda: setattr(P(), "__class__", int))
# private name mangling
class Pv1:
    __slots__ = ("__k",)
class Pv2:
    __slots__ = ("__k",)
pv = Pv1()
def pvv():
    pv.__class__ = Pv2
t("Pv1->Pv2", pvv)
class W:
    __slots__ = ("x", "y", "__dict__")
class W2:
    __slots__ = ("x", "y", "__dict__")
w = W(); w.x = 1; w.q = 2
def ww():
    w.__class__ = W2
    return w.x, w.q
t("W->W2", ww)
def wa():
    w.__class__ = A
t("W2->A", wa)
