# The hooks bound as special methods (astra's sage-sr-hunt1 review): a
# staticmethod, classmethod, property or custom descriptor, the instance
# binding where class and instance access differ; a subclass result becomes
# an exact float, int or complex, with the DeprecationWarning


class Desc:
    def __init__(self, inst, cls):
        self.inst, self.cls = inst, cls

    def __get__(self, obj, owner=None):
        v = self.inst if obj is not None else self.cls
        return lambda *a: v


class FS(float):
    pass


class IS(int):
    pass


class CSub(complex):
    pass


def kinds(base, name, value, cls_value):
    out = {}
    out['static'] = type('S', (base,), {name: staticmethod(lambda: value)})
    out['class'] = type('K', (base,), {name: classmethod(lambda c: value)})
    out['property'] = type('P', (base,), {name: property(lambda self: (lambda: value))})
    out['descriptor'] = type('D', (base,), {name: Desc(value, cls_value)})
    return out


for conv, base, name, value, cls_value, arg in (
        (float, float, '__float__', 9.0, -1.0, 2.0), (float, object, '__float__', 9.0, -1.0, None),
        (int, int, '__int__', 5, -1, 2), (int, object, '__index__', 5, -1, None),
        (complex, complex, '__complex__', 5j, -1j, 1 + 2j), (complex, object, '__complex__', 5j, -1j, None)):
    for kind, cls in kinds(base, name, value, cls_value).items():
        x = cls() if arg is None else cls(arg)
        try:
            r = conv(x)
            print(conv.__name__, base.__name__, name, kind, repr(r), type(r).__name__)
        except Exception as e:
            print(conv.__name__, base.__name__, name, kind, type(e).__name__, e)
import warnings
for conv, name, sub in ((float, '__float__', FS(2.5)), (int, '__int__', IS(3)), (int, '__index__', IS(4)), (complex, '__complex__', CSub(1j))):
    for base in (object, conv):
        cls = type('R', (base,), {name: lambda self, s=sub: s})
        x = cls() if base is object else cls(1)
        with warnings.catch_warnings(record=True) as w:
            warnings.simplefilter('always')
            r = conv(x)
        print(conv.__name__, base.__name__, name, 'subclass result', repr(r), type(r).__name__, len(w))
