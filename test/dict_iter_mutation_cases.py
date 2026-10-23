# A dict (and a set) changed while it is iterated, the change made after
# the first item: what the iterator gives, and the error it raises. Run by
# test/dict-iter-mutation.test.ts, under CPython and Sagebrush; the outputs
# must be the same.


def nxt(it):
    try:
        return next(it)
    except StopIteration:
        return "StopIteration"
    except RuntimeError as e:
        return "RuntimeError: %s" % e


def run(label, make, act, kind=iter, steps=6):
    d = make()
    it = kind(d)
    first = nxt(it)
    act(d)
    print(label, [first] + [nxt(it) for _ in range(steps)])


D = lambda: {1: 1, 2: 2, 3: 3}
S = lambda: {1, 2, 3}
keys = lambda d: iter(d.keys())
values = lambda d: iter(d.values())
items = lambda d: iter(d.items())
rkeys = lambda d: reversed(d.keys())
rvalues = lambda d: reversed(d.values())
ritems = lambda d: reversed(d.items())

run("pop yielded, add", D, lambda d: (d.pop(1), d.__setitem__(4, 4)))
run("pop yielded, add (keys)", D, lambda d: (d.pop(1), d.__setitem__(4, 4)), keys)
run("pop yielded, add (values)", D, lambda d: (d.pop(1), d.__setitem__(4, 4)), values)
run("pop yielded, add (items)", D, lambda d: (d.pop(1), d.__setitem__(4, 4)), items)
run("pop later, add", D, lambda d: (d.pop(3), d.__setitem__(4, 4)))
run("pop later, add (items)", D, lambda d: (d.pop(2), d.__setitem__(4, 4)), items)
run("clear, add 3", D, lambda d: (d.clear(), d.update({4: 4, 5: 5, 6: 6})))
run("clear, add 2 then 1", D, lambda d: (d.clear(), d.update({4: 4, 5: 5}), d.__setitem__(6, 6)))
run("clear, add 3 (values)", D, lambda d: (d.clear(), d.update({4: 40, 5: 50, 6: 60})), values)
run("replace a value (items)", D, lambda d: d.__setitem__(2, "x"), items)
run("add", D, lambda d: d.__setitem__(4, 4))
run("pop", D, lambda d: d.pop(2))
run("add then pop", D, lambda d: (d.__setitem__(4, 4), d.pop(4)))
run("pop 2 later, add 2", lambda: {i: i for i in range(10)}, lambda d: (d.pop(5), d.pop(6), d.__setitem__(20, 1), d.__setitem__(21, 1)), steps=10)
run("reversed: add", D, lambda d: d.__setitem__(4, 4), reversed)
run("reversed: pop yielded, add", D, lambda d: (d.pop(3), d.__setitem__(4, 4)), reversed)
run("reversed: pop next, add", D, lambda d: (d.pop(2), d.__setitem__(5, 5)), reversed)
run("reversed: pop first, add", D, lambda d: (d.pop(1), d.__setitem__(4, 4)), reversed)
run("reversed: clear, add 3", D, lambda d: (d.clear(), d.update({4: 4, 5: 5, 6: 6})), reversed)
run("reversed keys: pop next, add", D, lambda d: (d.pop(2), d.__setitem__(5, 5)), rkeys)
run("reversed values: replace", D, lambda d: d.__setitem__(1, "x"), rvalues)
run("reversed items: replace", D, lambda d: d.__setitem__(2, "x"), ritems)
run("set: add", S, lambda s: s.add(4))
run("set: discard", S, lambda s: s.discard(3))
run("set: add then restore size", S, lambda s: (s.add(4), s.discard(4)))



def sticky(label, make, grow, shrink):
    # (a changed size raises at every step after, even once the size is back)
    d = make()
    it = iter(d)
    first = nxt(it)
    grow(d)
    second = nxt(it)
    shrink(d)
    print(label, [first, second, nxt(it), nxt(it)])


sticky("size back after the error", D, lambda d: d.__setitem__(4, 4), lambda d: d.pop(4))
sticky("set: size back after the error", S, lambda s: s.add(4), lambda s: s.discard(4))


# (two items past the size: the error, and then the iterator is done)
d = {i: i for i in range(8)}
it = iter(d)
out = [nxt(it), nxt(it), nxt(it)]
del d[0], d[1]
d[10] = d[11] = 0
print("two past the size", out + [nxt(it) for _ in range(9)])


# list(), tuple() and sorted() of a dict or its views take the rest at once;
# the same items and errors as one at a time, and a dict subclass's own
# __iter__ is still used
def whole(label, f):
    try:
        print(label, f())
    except RuntimeError as e:
        print(label, "RuntimeError:", e)


class Rev(dict):
    def __iter__(self):
        return reversed(list(super().__iter__()))


class Plain(dict):
    pass


whole("list(d)", lambda: list({3: 0, 1: 0, 2: 0}))
whole("tuple(d.values())", lambda: tuple({1: "a", 2: "b"}.values()))
whole("sorted(d.items())", lambda: sorted({2: "b", 1: "a"}.items()))
whole("list(subclass with __iter__)", lambda: list(Rev({1: 1, 2: 2, 3: 3})))
whole("list(subclass)", lambda: list(Plain({1: 1, 2: 2})))


def rest_after(act):
    d = {1: 1, 2: 2, 3: 3}
    it = iter(d)
    next(it)
    act(d)
    return list(it)


whole("rest: untouched", lambda: rest_after(lambda d: None))
whole("rest: pop yielded, add", lambda: rest_after(lambda d: (d.pop(1), d.__setitem__(4, 4))))
whole("rest: pop later, add", lambda: rest_after(lambda d: (d.pop(3), d.__setitem__(4, 4))))
whole("rest: add", lambda: rest_after(lambda d: d.__setitem__(4, 4)))
whole("rest: clear, add 3", lambda: rest_after(lambda d: (d.clear(), d.update({4: 4, 5: 5, 6: 6}))))


# an exhausted iterator stays exhausted, whatever its dict does after (and
# so after "keys changed"); one that raised at a changed size raises again
def ended(label, kind, act):
    d = {1: 1, 2: 2}
    it = kind(d)
    first = [nxt(it) for _ in range(3)]
    act(d)
    print(label, first, [nxt(it), nxt(it)])


ended("ended, then add", iter, lambda d: d.__setitem__(9, 9))
ended("ended, then pop", iter, lambda d: d.pop(1))
ended("ended values, then add", values, lambda d: d.__setitem__(9, 9))
ended("ended items, then clear", items, lambda d: d.clear())
ended("ended reversed, then add", reversed, lambda d: d.__setitem__(9, 9))
ended("ended reversed values, then add", rvalues, lambda d: d.__setitem__(9, 9))
ended("ended reversed items, then pop", ritems, lambda d: d.pop(2))
ended("ended list(), then add", lambda d: (lambda it: (list(it), it)[1])(iter(d)), lambda d: d.__setitem__(9, 9))
d = {1: 1, 2: 2}
it = iter(d)
whole_ = list(it)
d[9] = 9
print("list(it), then add, then next", whole_, [nxt(it), nxt(it)])

d = {1: 1, 2: 2, 3: 3}
it = iter(d)
out = [nxt(it)]
d.pop(1)
d[4] = 4
out += [nxt(it) for _ in range(3)]
d[10] = 10
print("keys changed, then add", out, [nxt(it), nxt(it)])


# an instance's __dict__ replaced: an iterator on the old one goes on in the
# old one; its __dict__ cleared and refilled: as a dict's
class C:
    pass


def instance():
    c = C()
    c.x = 1
    c.y = 2
    return c


for label, kind in (("keys", iter), ("values", values), ("items", items), ("reversed", reversed)):
    c = instance()
    it = kind(c.__dict__)
    first = nxt(it)
    c.__dict__ = {"p": 3, "q": 4}
    print("__dict__ replaced:", label, [first, nxt(it), nxt(it)])
c = instance()
c.z = 3
it = iter(c.__dict__)
first = nxt(it)
c.__dict__.clear()
c.__dict__.update({"a": 1, "b": 2, "c": 3})
print("__dict__ cleared and refilled", [first, nxt(it), nxt(it), nxt(it)])
# (and the old __dict__ itself keeps what it had; the instance has the new one)
c = instance()
old = c.__dict__
c.__dict__ = {"p": 3}
old["w"] = 9
print("old __dict__ after replacement", old, c.__dict__, c.p, hasattr(c, "w"), hasattr(c, "x"))


# reversed() while keys are deleted, by each way of deleting (it takes its
# keys at the start and passes over one deleted since), and a key deleted
# from an instance's __dict__ through del of the attribute
def rdel(label, act, kind=reversed, make=lambda: {1: 1, 2: 2, 3: 3, 4: 4}):
    d = make()
    it = kind(d)
    first = nxt(it)
    act(d)
    print(label, [first] + [nxt(it) for _ in range(5)])


def _del(d, k):
    del d[k]


rdel("reversed: del, add", lambda d: (_del(d, 2), d.__setitem__(5, 5)))
rdel("reversed: popitem, add", lambda d: (d.popitem(), d.__setitem__(5, 5)))
rdel("reversed: pop with default, add", lambda d: (d.pop(3, None), d.__setitem__(5, 5)))
rdel("reversed: delete then setdefault", lambda d: (_del(d, 1), d.setdefault(9, 9)))
rdel("reversed values: del, add", lambda d: (_del(d, 3), d.__setitem__(6, 6)), rvalues)
rdel("reversed items: del, add", lambda d: (_del(d, 2), d.__setitem__(6, 6)), ritems)
rdel("reversed: replace a value", lambda d: d.__setitem__(2, "x"), rvalues)
rdel("reversed: str keys, del, add", lambda d: (_del(d, "b"), d.__setitem__("e", 5)), make=lambda: {"a": 1, "b": 2, "c": 3, "d": 4})
rdel("reversed: float and int keys", lambda d: (_del(d, 2.0), d.__setitem__(7, 7)), make=lambda: {1: 1, 2: 2, 3.5: 3, 4: 4})
rdel("reversed: tuple keys, del, add", lambda d: (_del(d, (2, "b")), d.__setitem__((5, "e"), 5)), make=lambda: {(1, "a"): 1, (2, "b"): 2, (3, "c"): 3, (4, "d"): 4})
rdel("reversed items: frozenset keys, pop, add", lambda d: (d.pop(frozenset({2})), d.__setitem__(frozenset({5}), 5)), ritems, make=lambda: {frozenset({1}): 1, frozenset({2}): 2, frozenset({3}): 3})
