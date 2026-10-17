# types.GenericAlias (list[int] and the like) as CPython 3.14's, and a
# builtin class that isn't generic refused: compared with CPython by
# test/generic-alias.test.ts
import types
import collections
import collections.abc


def t(f):
    try:
        print(repr(f()))
    except Exception as e:
        print(type(e).__name__, e)


t(lambda: int[5])
t(lambda: str[int])
t(lambda: list[int])
t(lambda: dict[str, list[int]])
t(lambda: tuple[()])
t(lambda: tuple[int, ...])
t(lambda: list["x"])
t(lambda: list[collections.OrderedDict])
t(lambda: type[int])
t(lambda: set[int], )
t(lambda: frozenset[int])
t(lambda: enumerate[int])
t(lambda: memoryview[int])
a = list[int]
t(lambda: (a.__origin__, a.__args__, a.__parameters__, type(a), type(a).__module__, type(a).__name__))
t(lambda: a == list[int])
t(lambda: hash(a) == hash(list[int]))
t(lambda: a("ab"))
t(lambda: a.append is list.append)
t(lambda: a.__name__)
t(lambda: isinstance([], a))
t(lambda: issubclass(list, a))
t(lambda: isinstance([], list[int] | None))
t(lambda: a[int])
t(lambda: a | None)
t(lambda: None | a)
t(lambda: a | int | a)
t(lambda: list[int, str])
t(lambda: dict[int])
t(lambda: a.__mro_entries__((a,)))


class L(list[int]):
    pass


t(lambda: L.__mro__)
t(lambda: L.__orig_bases__)
t(lambda: L([1, 2]))
t(lambda: types.GenericAlias(list, (int,)))
t(lambda: types.GenericAlias(list, int))
t(lambda: list[int].__class__)
t(lambda: list[...])
t(lambda: dict[str, int].__args__)
t(lambda: list[int] == list[str])
t(lambda: list[[int, str]])
t(lambda: a.__reduce__())
t(lambda: [n for n in dir(a) if n in ("__args__", "__origin__", "append", "__parameters__")])
t(lambda: collections.deque[int])
t(lambda: collections.OrderedDict[str, int])
t(lambda: collections.defaultdict[str, int])
t(lambda: collections.Counter[str])
t(lambda: collections.ChainMap[str, int])
t(lambda: collections.abc.Iterable[int])
t(lambda: collections.abc.Mapping[str, int])
# (Callable's repr is collections.abc's, through annotationlib: not yet)
t(lambda: collections.abc.Callable[[int, str], float].__args__)
t(lambda: collections.abc.Callable[..., int].__args__)
t(lambda: collections.abc.Callable[[int], str].__args__)


class G:
    __class_getitem__ = classmethod(types.GenericAlias)


t(lambda: G[int])
t(lambda: (type(G[int]()), G[int]().__orig_class__))

import copy, pickle
t(lambda: copy.copy(a))
t(lambda: pickle.loads(pickle.dumps(a)))


class P:
    pass


class Meta(type):
    def __getitem__(cls, k):
        return ("meta", cls.__name__, k)


class M(metaclass=Meta):
    pass


class H:
    def __class_getitem__(cls, k):
        return ("cgi", cls.__name__, k)


t(lambda: P[int])
t(lambda: M[int])
t(lambda: H[int])
t(lambda: bool[int])
t(lambda: object[int])
t(lambda: BaseException[int])
t(lambda: ValueError[int])
t(lambda: hash(dict[str, int]) == hash(dict[str, int]))
t(lambda: {list[int]: 1}[list[int]])
t(lambda: list[int] == list)
t(lambda: list[len, print, 3, "s", None])
t(lambda: type(collections.abc.Callable[[int], str]).__mro__)
t(lambda: collections.abc.Callable[[int], str] == collections.abc.Callable[[int], str])


# PEP 560: __mro_entries__ and __orig_bases__
class E:
    def __init__(self, r):
        self.r = r

    def __mro_entries__(self, bases):
        print("entries", len(bases))
        return self.r


class N1(E((int,)), E(())):
    pass


t(lambda: (N1.__mro__, N1.__orig_bases__[0].r, N1.__bases__))
t(lambda: "__orig_bases__" in N1.__dict__)


class N2(int):
    pass


t(lambda: "__orig_bases__" in N2.__dict__)
try:
    class N3(E([int])):
        pass
except TypeError as e:
    print("TypeError", e)


class Meta2(type):
    @classmethod
    def __prepare__(mcls, name, bases, **kw):
        print("prepare", bases)
        return {}


class N4(list[int], metaclass=Meta2):
    pass


t(lambda: (N4.__bases__, N4.__orig_bases__))
import builtins
# (the builtin classes that are generic; Sagebrush has no exception groups)
t(lambda: [n for n in dir(builtins) if isinstance(getattr(builtins, n), type) and "__class_getitem__" in getattr(builtins, n).__dict__ and "ExceptionGroup" not in n])
t(lambda: "__class_getitem__" in type.__dict__)
t(lambda: (type.__module__, type.__qualname__, types.FunctionType.__module__))
t(lambda: dict[str, int](a=1))
# (a list argument: its items at the top only; a list holding itself)
t(lambda: (list[[[int]]], list[[int, [str]]], list[(int, str), ...]))
x = []
x.append(x)
r = types.GenericAlias(list, x)
t(lambda: r)
t(lambda: types.GenericAlias(list, (x,)))
try:
    r.__parameters__
except RecursionError as e:
    print("RecursionError")
t(lambda: r == types.GenericAlias(list, x))
t(lambda: hash(list[[int]]))
# (__mro_entries__ gets the same original bases tuple each time)
seen_bases = []


class E2:
    def __mro_entries__(self, bases):
        seen_bases.append(bases)
        return ()


class N5(E2(), E2(), int):
    pass


t(lambda: (len(seen_bases), seen_bases[0] is seen_bases[1], type(seen_bases[0]), len(seen_bases[0]), N5.__bases__))


# @sagebrush-astra's review probes of a71b3d50 (CORR-A71-1..6)

def show(name, f):
    try:
        print(name, repr(f()))
    except Exception as e:
        print(name, type(e).__name__, str(e))

show('isinstance union early', lambda: isinstance(1, int | list[int]))
show('issubclass union early', lambda: issubclass(int, int | list[int]))
show('isinstance union late', lambda: isinstance(1, list[int] | int))
show('generic basic', lambda: (list[int], list[int].__origin__, list[int].__args__))
show('nongeneric', lambda: int[str])

seen = []
class Entry:
    def __mro_entries__(self, bases):
        seen.append(bases)
        return ()
e1, e2 = Entry(), Entry()
class C(e1, e2, int): pass
show('original bases identity', lambda: (seen[0] is seen[1], C.__orig_bases__ is seen[0], len(C.__orig_bases__)))
print('original bases elements', C.__orig_bases__[0] is e1, C.__orig_bases__[1] is e2)

calls = []
class Param:
    @property
    def __typing_subst__(self):
        calls.append('subst')
        return lambda x: x
    def __repr__(self): return 'Param'
p = Param()
a = types.GenericAlias(list, p)
show('parameters first', lambda: a.__parameters__)
show('parameters second', lambda: a.__parameters__)
show('parameters cache', lambda: (calls, a.__parameters__ is a.__parameters__))
mutable = [p]
b = types.GenericAlias(list, mutable)
show('parameters mutation before', lambda: b.__parameters__)
mutable.clear()
show('parameters mutation after', lambda: b.__parameters__)

class LS(list): pass
show('list subclass repr', lambda: types.GenericAlias(list, LS([int, str])))
show('list subclass params', lambda: types.GenericAlias(list, LS([p])).__parameters__)

class Dynamic(type):
    def __getattribute__(cls, name):
        if name == '__class_getitem__': return lambda x: ('dynamic', x)
        return super().__getattribute__(name)
class D(metaclass=Dynamic): pass
show('dynamic class getitem', lambda: D[int])

class Meta(type):
    def __getattribute__(cls, name):
        if name == '__module__': return 'shown'
        if name == '__qualname__': return 'Name'
        return super().__getattribute__(name)
class Named(metaclass=Meta): pass
show('class argument repr', lambda: list[Named])

class SetAttr:
    def __setattr__(self, name, value): raise ValueError('reject setattr')
show('orig class setattr error', lambda: isinstance(types.GenericAlias(SetAttr, int)(), SetAttr))

class GA(types.GenericAlias): pass
show('subclass reduce', lambda: GA(list, int).__reduce__()[0] is GA)
show('subclass copy', lambda: __import__('copy').copy(GA(list, int)).__class__ is GA)
show('unpack alias', lambda: tuple(list[int]))
show('unpack args', lambda: tuple(list[int])[0].__unpacked__)

show('constructor missing', lambda: types.GenericAlias(list))
show('constructor extra', lambda: types.GenericAlias(list, int, str))
show('alias args identity', lambda: a.__args__ is a.__args__)


# (a failed first __parameters__ computation is retried, not kept)
class Flaky:
    n = 0

    @property
    def __typing_subst__(self):
        Flaky.n += 1
        if Flaky.n == 1:
            raise ValueError("first")
        return lambda x: x

    def __repr__(self):
        return "Flaky"


fl = types.GenericAlias(list, Flaky())
show("parameters retry 1", lambda: fl.__parameters__)
show("parameters retry 2", lambda: (fl.__parameters__, Flaky.n))
show("parameters retry 3", lambda: (fl.__parameters__, Flaky.n))
# (unpacking: a starred alias)
st = next(iter(tuple[int, ...]))
show("starred", lambda: (st, st.__unpacked__, st.__typing_unpacked_tuple_args__, st == next(iter(tuple[int, ...])), st == tuple[int, ...], list[int].__typing_unpacked_tuple_args__))
show("starred list", lambda: [*list[int]])
# (a metaclass __getattr__ and __class_getitem__ = None)
class MG(type):
    def __getattr__(cls, name):
        if name == "__class_getitem__":
            return lambda x: ("getattr", x)
        raise AttributeError(name)


class CG(metaclass=MG):
    pass


class CN:
    __class_getitem__ = None


show("metaclass getattr", lambda: (CG[int], CG.missing if False else None))
show("class_getitem None", lambda: CN[int])
show("union issubclass abc", lambda: issubclass(list, collections.abc.Iterable | int))
show("union isinstance late", lambda: isinstance("s", int | str | list[int]))


# @sagebrush-astra's review probe of 621a4691 (CORR-621-1, 2): metaclass hooks
# Ordinary class attributes under different metaclass hook bindings.
events=[]
class Hooked(type):
    def __getattribute__(cls,name):
        events.append(('ga',name))
        if name=='virtual':return 42
        if name=='bad':raise ValueError('hook failure')
        return super().__getattribute__(name)
    def __getattr__(cls,name):
        events.append(('gf',name))
        if name=='fallback':return 43
        raise AttributeError(name)
    @property
    def prop(cls):return 'property'
class HC(metaclass=Hooked):
    real=41
for name in ['real','virtual','prop','fallback','missing','bad']:
    events.clear();show('ordinary '+name,lambda:getattr(HC,name,'default'));print('events',events)
class Child(HC):pass
events.clear();show('inherited meta hook',lambda:Child.real);print('events',events)
class StaticMeta(type):
    @staticmethod
    def __getattribute__(name):return ('static',name)
class SC(metaclass=StaticMeta):pass
show('static hook',lambda:SC.value)
class ClassMeta(type):
    @classmethod
    def __getattribute__(meta,name):return ('class',meta is ClassMeta,name)
class CC(metaclass=ClassMeta):pass
show('class hook',lambda:CC.value)
class Descriptor:
    def __get__(self,obj,owner):
        return lambda name:('descriptor',obj is DC,owner is DescMeta,name)
class DescMeta(type):__getattribute__=Descriptor()
class DC(metaclass=DescMeta):pass
show('descriptor hook',lambda:DC.value)
class Callable:
    def __call__(self,*args):return ('callable',len(args),args[-1])
class CallableMeta(type):__getattribute__=Callable()
class NC(metaclass=CallableMeta):pass
show('non-descriptor hook',lambda:NC.value)
class CallableFallback(type):__getattr__=Callable()
class NF(metaclass=CallableFallback):pass
show('non-descriptor fallback',lambda:NF.value)
class ObjectMeta(type):__getattribute__=object.__getattribute__
class OC(metaclass=ObjectMeta):value=99
show('object hook class field',lambda:OC.value)
show('object hook type field',lambda:OC.__name__)
class Missing(type):
    def __getattribute__(cls,name):raise AttributeError('attribute first')
    def __getattr__(cls,name):raise AttributeError('fallback last')
class MC(metaclass=Missing):pass
show('both missing default',lambda:getattr(MC,'value','default'))
show('both missing error',lambda:getattr(MC,'value'))
class Exploding(type):
    def __getattribute__(cls,name):raise ValueError('not absent')
class EC(metaclass=Exploding):pass
show('error never default',lambda:getattr(EC,'value','default'))
# Alias own attrs and dynamic class attributes continue to coexist.
show('ordinary alias origin',lambda:types.GenericAlias(HC,int).__origin__ is HC)
show('alias forwarded attribute',lambda:types.GenericAlias(HC,int).virtual)
star=next(iter(tuple[int,...]))
show('star iteration again',lambda:(repr(next(iter(star))),next(iter(star)).__unpacked__))
show('star nested',lambda:list[star])


# @sagebrush-astra's review probe of 6c84d71f (CORR-6C8-1), to its str
# subclass names (refused: test/generic-alias.test.ts) and without the
# wrong-receiver wording

print('--- delegation controls ---')
events=[]
class Instance:
    def __init__(self): self.real=51
    def __getattribute__(self,name):
        events.append(('ga',name))
        return super().__getattribute__(name)
    def __getattr__(self,name):
        events.append(('gf',name))
        if name=='fallback': return 52
        raise AttributeError(name)
    @property
    def broken(self):
        events.append(('prop','broken'))
        raise AttributeError('descriptor')
i=Instance()
for name in ('real','fallback','missing','broken'):
    events.clear()
    show('instance '+name,lambda:getattr(i,name,'default'))
    print('instance events',events)
events.clear()
show('object direct missing',lambda:object.__getattribute__(i,'missing'))
print('object direct events',events)
events.clear()
show('object direct property',lambda:object.__getattribute__(i,'broken'))
print('object direct property events',events)
events.clear()
show('type direct missing',lambda:type.__getattribute__(HC,'missing'))
print('type direct events',events)
show('type direct field',lambda:type.__getattribute__(HC,'real'))

class Parent:
    inherited=73
class RawMeta(type): __getattribute__=object.__getattribute__
class Raw(Parent,metaclass=RawMeta):
    own=74
    def func(self):return 75
    @staticmethod
    def static():return 76
    @classmethod
    def class_(cls):return 77
show('raw own field',lambda:Raw.own)
show('raw inherited field',lambda:getattr(Raw,'inherited','default'))
show('raw descriptor untouched',lambda:(isinstance(Raw.static,staticmethod),isinstance(Raw.class_,classmethod)))
show('type lookup override raw',lambda:type.__getattribute__(Raw,'inherited'))
show('object lookup raw static',lambda:isinstance(object.__getattribute__(Raw,'static'),staticmethod))
class DescriptorRaised:
    def __get__(self,obj,owner): raise AttributeError('get descriptor')
    def __set__(self,obj,value):pass
class MetaDescriptor(type):
    bad=DescriptorRaised()
    def __getattribute__(cls,name):return super().__getattribute__(name)
    def __getattr__(cls,name):events.append(name);return 'fallback'
class MD(metaclass=MetaDescriptor):bad='class field'
events.clear()
show('meta data descriptor fallback',lambda:MD.bad)
print('meta fallback events',events)
events.clear()
show('meta direct descriptor error',lambda:type.__getattribute__(MD,'bad'))
print('meta direct events',events)
for v in (1,None,b'x'):
    show('type descriptor wrong name '+repr(v),lambda:type.__getattribute__(HC,v))
for v in (1, None, b'x'):
    show('object descriptor wrong name ' + repr(v), lambda: object.__getattribute__(HC, v))
