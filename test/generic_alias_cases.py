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
