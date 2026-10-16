# Attributes of None: methods bound to it, get/set descriptors' values
# (None.__class__ was the descriptor itself), and so isinstance(None, ABC)
import numbers
from fractions import Fraction


def t(f):
    try:
        return repr(f())
    except Exception as e:
        return type(e).__name__


print(None.__class__, None.__class__ is type(None), getattr(None, '__class__'), type(None).__repr__(None))
print(t(lambda: None.__repr__()), t(lambda: None.__str__()), t(lambda: None.__bool__()), t(lambda: None.__hash__() == hash(None)),
      t(lambda: None.__eq__(None)), t(lambda: None.__ne__(1)), t(lambda: None.__format__('')),
      t(lambda: None.__reduce__()), t(lambda: None.__dir__ is not None), t(lambda: None.__doc__ is None))
for cls in (Fraction, numbers.Number, numbers.Complex, numbers.Real, numbers.Rational, numbers.Integral):
    print(cls.__name__, isinstance(None, cls), [isinstance(v, cls) for v in (1, 'a', 1.5, True, 2j, Fraction(1, 2), [], object())],
          issubclass(type(None), cls))
print(isinstance(None, (int, Fraction)), isinstance(None, type(None)), isinstance(None, object))
print(t(lambda: None.foo), t(lambda: setattr(None, 'x', 1)), t(lambda: None.__class__.__name__))
# setattr through object.__setattr__ and None.__setattr__; __class__'s TypeError;
# __new__ static, NoneType's own (CORR-4CC-1, -2)
print(t(lambda: None.__setattr__('x', 1)), t(lambda: object.__setattr__(None, 'x', 1)), t(lambda: setattr(None, '__class__', int)),
      t(lambda: object.__setattr__(None, '__class__', int)))
print(None.__new__ is type(None).__new__, t(lambda: None.__new__(type(None))), t(lambda: type(None).__new__(type(None))), t(lambda: type(None)()),
      t(lambda: type(None)(1)), t(lambda: type(None).__new__(int)), (1).__new__ is int.__new__, object().__new__ is object.__new__)
# __new__ with no class is TypeError; a builtin type's __new__ makes only
# its subtypes; bytearray.__new__ makes an empty one, __init__ fills it
# (CORR-A24-1..3)
class C:
    pass


class D(dict):
    pass


class B(bytearray):
    pass


print(t(lambda: object().__new__()), t(lambda: C().__new__()), t(lambda: object.__new__()), t(lambda: dict.__new__()))
print([t(lambda: f(object)) for f in (dict.__new__, {}.__new__, set.__new__, set().__new__, range.__new__, range(1).__new__,
                                         frozenset.__new__, list.__new__, bytearray.__new__)], t(lambda: list.__new__(int)))
print(type(dict.__new__(D)).__name__, len(dict.__new__(D)), type({}.__new__(D)).__name__, D(a=1), t(lambda: C(1)), type(object.__new__(C)).__name__,
      dict.__new__ is object.__new__, set.__new__ is dict.__new__)
print(len(bytearray().__new__(bytearray, b'xy')), len(B().__new__(B, b'xy')), type(B.__new__(B, b'xy')).__name__, len(bytearray.__new__(B, b'xy')),
      B(b'xy'), bytearray(b'xy'), B(source=b'ab'), B('ab', 'ascii'), bytearray.__new__(bytearray))
b = bytearray(b'abc')
b.__init__(b'z')
e = bytearray()
e.__init__()
print(b, e, t(lambda: bytearray.__init__(b'x')))
b.__init__(3)
print(b, t(lambda: b.__init__('x')), t(lambda: b.__init__(encoding='ascii')), b)
print(t(lambda: bytes(encoding='ascii')), t(lambda: bytearray(errors='x')), t(lambda: bytes(errors='x')), t(lambda: bytearray(b'x', errors='x')),
      t(lambda: bytes(3, errors='x')), t(lambda: bytes('a', 'ascii', 'strict')))
