# Dicts and sets past one segment of the runtime's Maps: run with the segment
# lowered to 4 entries, those here larger than that span segments and the
# small ones stay plain Maps. The output is CPython 3.14's
# (test/dict_segmented_cases.expected).
import sys

def show(label, x):
    print(label, x)

def err(label, f):
    try:
        f()
        print(label, "no error")
    except Exception as e:
        print(label, type(e).__name__, e)

# order, a key set again keeping its place, a deleted key going to the end
d = {}
for i in range(10):
    d[i] = i * i
d[3] = "three"
del d[0]
d[0] = "zero"
show("order", list(d.items()))
show("len", len(d))
show("get", (d.get(9), d.get(99, "none"), 5 in d, 50 in d))

# keys that normalize alike (1, 1.0, True) and keys that hash (tuples, frozensets)
m = {}
for i in range(6):
    m[i] = "int"
m[1.0] = "float"
m[True] = "bool"
m[2.5] = "half"
m[(1, 2)] = "tuple"
m[frozenset({3})] = "fs"
m["s"] = "str"
show("mixed", list(m.items()))
show("mixed lookups", (m[1], m[1.0], m[True], m[(1, 2)], m[frozenset([3])], 2.0 in m, (2, 1) in m))
del m[1.0]
show("mixed del", (1 in m, True in m, list(m)))
m[True] = "again"
show("mixed again", list(m.items()))

# the dict methods across segments
p = dict.fromkeys("abcdefghij", 0)
show("pop", (p.pop("c"), p.pop("zz", "dflt")))
show("popitem", [p.popitem() for _ in range(3)])
show("setdefault", (p.setdefault("a", 9), p.setdefault("new", 7)))
p.update({"x": 1, "b": 2}, y=3)
show("update", p)
q = p.copy()
q["copy"] = 1
show("copy", (len(p), len(q), "copy" in p))
show("comprehension", {k: v for k, v in zip(range(12), "abcdefghijkl") if k % 5})
show("reversed", list(reversed(d)))
show("views", (list(p.keys())[:3], list(p.values())[-3:], len(p.items())))
show("eq", ({str(i): i for i in range(9)} == {str(i): i for i in reversed(range(9))}, {1: 1} == {1.0: 1}))
show("or", dict.fromkeys(range(5), "a") | dict.fromkeys(range(3, 9), "b"))
err("popitem empty", lambda: {}.popitem())
err("missing", lambda: d[99])

# changed during iteration
def grow():
    g = dict.fromkeys(range(8))
    for k in g:
        g[k + 100] = 1
err("grow while iterating", grow)

# emptied, then filled again
c = dict.fromkeys(range(10))
c.clear()
show("cleared", (c, len(c)))
for i in range(6):
    c[-i] = i
show("refilled", c)
e = dict.fromkeys(range(9))
for i in range(9):
    del e[i]
e["after"] = 1
show("emptied by del", (e, len(e)))

# sets: membership, discard, algebra on keys alike and on keys that hash
s = set(range(13))
s.discard(5)
s.add(5)
s.remove(0)
show("set", (sorted(s), len(s), 5 in s, 0 in s))
show("set or", sorted(set(range(9)) | set(range(5, 14))))
show("set and", sorted(set(range(20)) & set(range(3, 30, 2))))
show("set sub", sorted(set(range(15)) - set(range(0, 15, 3))))
show("set xor", sorted(set(range(10)) ^ set(range(5, 15))))
t = {(i, i) for i in range(7)} | {1.0, True, 2, "x"}
show("set hashed", (len(t), (3, 3) in t, 1 in t, sorted(map(repr, t))))
show("set hashed and", sorted({(i,) for i in range(9)} & {(i,) for i in range(4, 20)}))
show("frozenset", (frozenset(range(10)) == frozenset(reversed(range(10))), len({frozenset(range(i)) for i in range(9)})))
show("subset", (set(range(5)) <= set(range(12)), set(range(12)) <= set(range(11))))
u = set(range(6))
u |= set(range(4, 12))
show("set ior", sorted(u))
show("set pop", len({u.pop() for _ in range(5)}))

# live iterators across a clear() and across a dict becoming segmented
# while they run (a store fills its Map; a deletion keeps the size)
def set_clear(k):
    s = set(range(10))
    it = iter(s)
    for _ in range(k):
        next(it)
    s.clear()
    s.update(range(100, 110))
    return list(it)
def dict_clear(kind, k):
    d = dict.fromkeys(range(10), 0)
    it = iter(getattr(d, kind)())
    for _ in range(k):
        next(it)
    d.clear()
    d.update((i, i * i) for i in range(100, 110))
    return list(it)
def dict_grow(kind, step):
    d = dict.fromkeys(range(4), 7)
    it = iter(getattr(d, kind)())
    out = [next(it)]
    d[4] = 8
    del d[3]
    if step:
        for x in it:
            out.append(x)
    else:
        out += list(it)
    return out
def set_grow(k):
    s = set(range(4))
    it = iter(s)
    out = [next(it) for _ in range(k)]
    s.add(4)
    s.discard(3)
    return out + list(it)
show("set clear", set_clear(1))
for kind in ("keys", "values", "items"):
    show("dict clear " + kind, (dict_clear(kind, 1), dict_clear(kind, 6)))
    show("dict grow " + kind, (dict_grow(kind, True), dict_grow(kind, False)))
show("set grow", (set_grow(1), set_grow(2)))

# (the reviewers' probes: an iterator across the boundary, and a deleted key
# that must not come back after clear())
for mode in ("keys", "items", "values", "set"):
    c = set(range(4)) if mode == "set" else {i: i for i in range(4)}
    it = iter(c) if mode in ("keys", "set") else iter(c.items()) if mode == "items" else iter(c.values())
    first = next(it)
    c.add(4) if mode == "set" else c.update({4: 4})
    c.remove(3) if mode == "set" else c.pop(3)
    show("boundary " + mode, (first, list(it)))
for kind in ("dict", "set"):
    c = dict.fromkeys(range(8)) if kind == "dict" else set(range(8))
    it = iter(c)
    first = next(it)
    c.clear()
    c.update(dict.fromkeys(range(100, 108))) if kind == "dict" else c.update(range(100, 108))
    got = list(it)
    show("clear " + kind, (first, got, any(x < 100 for x in got)))

# (an iterator that has ended stays ended, whatever its dict or set does
# after: here it becomes segmented)
for mode in ("keys", "values", "items", "set"):
    c = set(range(4)) if mode == "set" else dict.fromkeys(range(4), 0)
    it = iter(c) if mode in ("keys", "set") else iter(getattr(c, mode)())
    first = list(it)
    c.add(4) if mode == "set" else c.update({4: 0})
    show("ended " + mode, (len(first), list(it)))
    c.discard(0) if mode == "set" else c.pop(0)
    show("ended again " + mode, list(it))
    c.clear()
    c.update(range(100, 110)) if mode == "set" else c.update(dict.fromkeys(range(100, 110), 1))
    show("ended after clear " + mode, list(it))
sys.stdout.flush()
