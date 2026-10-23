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
