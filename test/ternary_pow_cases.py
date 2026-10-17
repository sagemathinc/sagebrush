# Three-argument pow(base, exp, mod) dispatch, as CPython 3.14's
# ternary_op and slot_nb_power (astra CORR-3C7-4): which of __pow__ and
# __rpow__ is called, in which order, and the builtin slots' refusals;
# compared with CPython by test/builtin-args.test.ts
import re

calls = []


def show(label, f):
    calls.clear()
    try:
        r = repr(f())
    except Exception as e:
        r = f'{type(e).__name__}: {e}'
    print(label, re.sub(r' at 0x[0-9a-f]+', '', r), re.sub(r' at 0x[0-9a-f]+', '', repr(calls)))


class A:
    def __pow__(self, o, m=None):
        calls.append(('A.pow', type(o).__name__, m))
        return 'A.pow'

    def __rpow__(self, o, m=None):
        calls.append(('A.rpow', type(o).__name__, m))
        return 'A.rpow'


class B(A):
    pass


class C(A):
    def __rpow__(self, o, m=None):
        calls.append(('C.rpow', type(o).__name__, m))
        return 'C.rpow'


class D(A):
    pass


D.__rpow__ = A.__rpow__


class NI:
    def __pow__(self, o, m=None):
        calls.append(('NI.pow', type(o).__name__, m))
        return NotImplemented

    def __rpow__(self, o, m=None):
        calls.append(('NI.rpow', type(o).__name__, m))
        return NotImplemented


class NIsub(NI):
    def __rpow__(self, o, m=None):
        calls.append(('NIsub.rpow', type(o).__name__, m))
        return NotImplemented


class R:
    def __rpow__(self, o, m=None):
        calls.append(('R.rpow', type(o).__name__, m))
        return ('reflected', o, m)


class P:
    def __pow__(self, o, m=None):
        calls.append(('P.pow', type(o).__name__, m))
        return NotImplemented


class F(float):
    def __rpow__(self, o, m=None):
        calls.append(('F.rpow', type(o).__name__, m))
        return 'F.rpow'


class I(int):
    def __rpow__(self, o, m=None):
        calls.append(('I.rpow', type(o).__name__, m))
        return 'I.rpow'


class Ipow(int):
    def __pow__(self, o, m=None):
        calls.append(('Ipow.pow', type(o).__name__, m))
        return NotImplemented


class Mod:
    def __pow__(self, o, m=None):
        calls.append(('Mod.pow', type(o).__name__, m))
        return 'Mod.pow'

    def __rpow__(self, o, m=None):
        calls.append(('Mod.rpow', type(o).__name__, m))
        return 'Mod.rpow'


objs = {'A': A(), 'B': B(), 'C': C(), 'D': D(), 'NI': NI(), 'NIsub': NIsub(), 'R': R(), 'P': P(),
        'F': F(2.0), 'I': I(3), 'Ipow': Ipow(3), '2': 2, '2.0': 2.0, '2j': 2j, 'Mod': Mod()}
names = list(objs)
for x in names:
    for y in names:
        for z in ('5', '5.0', 'Mod', 'None'):
            if x == y == '2j' and z == 'None':
                continue  # (2j ** 2j's last bit: complex power's own, a known difference, not dispatch)
            m = {'5': 5, '5.0': 5.0, 'Mod': objs['Mod'], 'None': None}[z]
            show(f'pow({x}, {y}, {z})', lambda: pow(objs[x], objs[y], m))
