# Review fixtures for python-class-cell (astra's CORR-644-1..4 probes and
# metaclass controls, and the super().attr forms), against CPython 3.14
# (test/class-cell.test.ts runs this with python3 and with sagebrush).

def run(label, source):
    ns={'__name__':'__main__'}
    try:
        exec(source,ns)
        print(label,'OK',ns.get('result'))
    except BaseException as e:
        print(label,type(e).__name__,str(e))

run('nested_body_cell', '''
class Outer:
    def make(self):
        class Inner:
            owner = __class__
            def who(self): return __class__
        return Inner.owner is Outer, Inner().who() is Inner
result = Outer().make()
''')
run('nested_body_no_cell', '''
class Outer:
    def make(self):
        class Inner:
            owner = __class__
        return Inner.owner is Outer
result = Outer().make()
''')
run('nested_class_body_global', '''
__class__ = 'module value'
class Outer:
    class Inner:
        owner = __class__
        def who(self): return __class__
result = Outer.Inner.owner, Outer.Inner().who() is Outer.Inner
''')
run('nonlocal_class_read', '''
class C:
    def method(self):
        nonlocal __class__
        return __class__
result = C().method() is C
''')
run('nonlocal_class_write', '''
class C:
    def method(self):
        nonlocal __class__
        __class__ = int
    def who(self): return __class__
c=C(); c.method(); result = c.who() is int
''')
run('nonlocal_prefers_class', '''
def make():
    __class__ = 'outer function'
    class C:
        def who(self):
            nonlocal __class__
            return __class__
    return C().who() is C
result = make()
''')
run('global_class', '''
__class__ = 'global'
class C:
    def who(self):
        global __class__
        def f(): return __class__
        return f()
result = C().who()
''')
run('bare_super_deleted_arg', '''
class C:
    def method(self):
        del self
        return super()
result = C().method()
''')
run('attr_super_deleted_arg', '''
class C:
    def method(self):
        del self
        return super().__repr__()
result = C().method()
''')
run('super_reference_cell', '''
seen=[]
class M(type):
    def __new__(m,n,b,d):
        seen.append('__classcell__' in d)
        return type.__new__(m,n,b,d)
class C(metaclass=M):
    def method(self): return super
result = seen
''')
run('explicit_super_cell', '''
seen=[]
class M(type):
    def __new__(m,n,b,d):
        seen.append('__classcell__' in d)
        return type.__new__(m,n,b,d)
class C(metaclass=M):
    def method(self): return super(C,self)
result = seen
''')
run('drop_explicit_super_cell', '''
class M(type):
    def __new__(m,n,b,d):
        d.pop('__classcell__',None)
        return type.__new__(m,n,b,d)
class C(metaclass=M):
    def method(self): return super(C,self)
result = 'created'
''')
run('cell_delete', '''
from types import CellType
c=CellType(3)
del c.cell_contents
try: c.cell_contents
except ValueError as e: result=str(e)
''')
run('cell_none', '''
from types import CellType
c=CellType(None); result=c.cell_contents is None
''')
run('wrong_classcell_before_hook', '''
class M(type):
    def __new__(m,n,b,d):
        c=type.__new__(m,n,b,d)
        d['__classcell__'].cell_contents=int
        return c
class C(metaclass=M):
    def who(self): return __class__
''')
run('metaclass_foreign_type', '''
class M(type):
    def __new__(m,n,b,d): return int
class C(metaclass=M):
    def who(self): return __class__
''')
run('metaclass_non_type', '''
class M(type):
    def __new__(m,n,b,d): return 3
class C(metaclass=M):
    def who(self): return __class__
result=C
''')
run('object_init_subclass_bound', '''
class Outer:
    class Inner:
        pass
result=Outer.Inner.__init_subclass__(a=1)
''')

run('metaclass_deletes_contents', '''
class M(type):
    def __new__(m, n, b, d):
        cls = type.__new__(m, n, b, d)
        del d['__classcell__'].cell_contents
        return cls
class C(metaclass=M):
    def owner(self): return __class__
result = 'created'
''')
run('ordinary_class_no_cell', '''
seen = []
class M(type):
    def __new__(m, n, b, d):
        seen.append((n, '__classcell__' in d))
        return type.__new__(m, n, b, d)
class Base(metaclass=M):
    def value(self): return 7
class Child(Base):
    def value(self): return Base.value(self) + 5
    @classmethod
    def name(cls): return cls.__name__
    @staticmethod
    def square(x): return x*x
result = seen, Child().value(), Child.name(), Child.square(3)
''')
run('plain_class_dict_super_name', '''
seen = []
class M(type):
    def __new__(m, n, b, d):
        seen.append('__classcell__' in d)
        return type.__new__(m, n, b, d)
class C(metaclass=M):
    super = 5
    __class__ = 'attribute'
    def value(self): return self.__class__
result = seen, C().value()
''')
run('drop_classcell_normal_case', '''
class M(type):
    def __new__(m, n, b, d):
        d.pop('__classcell__', None)
        return type.__new__(m, n, b, d)
class C(metaclass=M):
    def owner(self): return __class__
''')

# super().x (CPython's LOAD_SUPER_ATTR) against a bare super(): their errors' order
def t(label, fn):
    try:
        r = fn()
    except BaseException as e:
        r = "%s: %s" % (type(e).__name__, e)
    print(label, r)

class A:
    def v(self): return 1
    x = 5
class B(A):
    def del_attr(self):
        del self
        return super().v
    def del_bare(self):
        del self
        return super()
    def between_attr(self):
        __class__ = 5
        def g(s): return super().v
        return g(self)
    def between_attr_call(self):
        __class__ = 5
        def g(s): return super().v()
        return g(self)
    def wrong_attr(self):
        self = 3
        return super().x
    def store(self):
        del self
        super().y = 1
    def method_call_deleted(self):
        del self
        return super().v()
t("del_attr", lambda: B().del_attr())
t("del_bare", lambda: B().del_bare())
t("between_attr", lambda: B().between_attr())
t("between_attr_call", lambda: B().between_attr_call())
t("wrong_attr", lambda: B().wrong_attr())
t("store", lambda: B().store())
t("method_call_deleted", lambda: B().method_call_deleted())
class M(type):
    def __new__(m, n, b, d):
        if n == "E":
            t("early attr", lambda: d["f"](None))
            t("early bare", lambda: d["g"](None))
            t("early attr deleted", lambda: d["h"](None))
        return type.__new__(m, n, b, d)
class E(A, metaclass=M):
    def f(self): return super().v
    def g(self): return super()
    def h(self):
        del self
        return super().v
def outside(self): return super().v
t("outside attr", lambda: outside(1))
def outside0(): return super().v
t("outside0 attr", outside0)


# super() in functions with no positional parameter still gives the class its
# cell (astra's delta probe on 45c7eae)
run('no_positional_cell', '''
seen=[]
class M(type):
    def __new__(m,n,b,d):
        seen.append('__classcell__' in d)
        return type.__new__(m,n,b,d)
class C(metaclass=M):
    def method(): return super()
result=seen
''')
run('dropped_static_cell', '''
class M(type):
    def __new__(m,n,b,d):
        d.pop('__classcell__',None)
        return type.__new__(m,n,b,d)
class C(metaclass=M):
    @staticmethod
    def method(): return super()
result='created'
''')
run('lambda_cell', '''
seen=[]
class M(type):
    def __new__(m,n,b,d):
        seen.append('__classcell__' in d)
        return type.__new__(m,n,b,d)
class C(metaclass=M):
    method=lambda:super()
result=seen
''')
run('nested_no_positional_cell', '''
seen=[]
class M(type):
    def __new__(m,n,b,d):
        seen.append('__classcell__' in d)
        return type.__new__(m,n,b,d)
class C(metaclass=M):
    def method(self):
        def inner(): return super()
        return inner()
result=seen
''')
run('nonlocal_delete', '''
class C:
    def clear(self):
        nonlocal __class__
        del __class__
    def owner(self): return __class__
c=C();c.clear();result=c.owner()
''')
run('nonlocal_intervening_function', '''
class C:
    def method(self):
        __class__=int
        def inner():
            nonlocal __class__
            __class__=str
        inner()
        return __class__
    def owner(self):return __class__
result=C().method() is str,C().owner() is C
''')
run('nested_defaults', '''
class Outer:
    def method(self):
        class Inner:
            def owner(self, default=__class__):return default,__class__
        owners=Inner().owner()
        return owners[0] is Outer,owners[1] is Inner
result=Outer().method()
''')
run('read_only_descriptor_delete', '''
del (1).real
''')
run('cell_delete_twice', '''
from types import CellType
c=CellType(3)
del c.cell_contents
del c.cell_contents
result='deleted twice'
''')
run('wrong_descriptor_receiver', '''
from types import CellType
CellType.cell_contents.__delete__(3)
''')


# each function without a positional parameter that calls super(): the class
# has its cell (seen by a metaclass, and missed when dropped), and the call
# is still "super(): no arguments"
FORMS = {
    "method": "    def f(): return super()\n    call = lambda: C.f()\n",
    "staticmethod": "    @staticmethod\n    def f(): return super()\n    call = staticmethod(lambda: C.f())\n",
    "lambda": "    f = lambda: super()\n    call = lambda: C.f()\n",
    "nested def": "    def g(self):\n        def h(): return super()\n        return h()\n    call = lambda: C().g()\n",
}
for form, body in FORMS.items():
    for drop in (False, True):
        src = ("seen = []\nclass M(type):\n    def __new__(m, n, b, d):\n        seen.append('__classcell__' in d)\n"
               + ("        d.pop('__classcell__', None)\n" if drop else "")
               + "        return type.__new__(m, n, b, d)\nclass C(metaclass=M):\n" + body
               + "try:\n    C.call()\nexcept RuntimeError as e:\n    result = (seen, str(e))\n")
        run("%s, cell %s" % (form, "dropped" if drop else "kept"), src)
