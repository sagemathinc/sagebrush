# matrix(...) from a dict of positions {(i, j): x}: the bare form (the
# dimensions from the largest indices), with a ring, with the number of rows
# (square), and with both dimensions; the keys' errors.  (Parents aren't
# printed: Sage makes these sparse, Sagebrush has dense matrices only.)
def show(label, f):
    try:
        M = f()
        print(label)
        print(M)
        print(M.dimensions(), M.base_ring())
    except Exception as e:
        print(label, "error:", type(e).__name__, str(e).split("\n")[0])

a = GF(4, 'a').gen()
show("bare", lambda: matrix({(0, 1): 3}))
show("bare, two keys", lambda: matrix({(1, 2): 3, (0, 0): -1}))
show("bare, empty", lambda: matrix({}))
show("bare, a rational", lambda: matrix({(1, 0): 1/2, (0, 1): 2}))
show("bare, zeros only", lambda: matrix({(3, 3): 0}))
show("ZZ", lambda: matrix(ZZ, {(0, 1): 3}))
show("QQ", lambda: matrix(QQ, {(1, 0): 1/2}))
show("ZZ, 2 x 2", lambda: matrix(ZZ, 2, 2, {(0, 1): 3}))
show("ZZ, 2 x 2, sparse=True", lambda: matrix(ZZ, 2, 2, {(0, 1): 3}, sparse=True))
show("ZZ, 2 x 2, sparse=False", lambda: matrix(ZZ, 2, 2, {(0, 1): 3}, sparse=False))
show("2 x 2, no ring", lambda: matrix(2, 2, {(0, 1): 3}))
show("2 x 3, no ring, a rational", lambda: matrix(2, 3, {(1, 2): 1/3}))
show("ZZ, 2 x 3", lambda: matrix(ZZ, 2, 3, {(1, 2): 5}))
show("ZZ, 3 rows", lambda: matrix(ZZ, 3, {(0, 1): 3}))
show("3 rows, no ring", lambda: matrix(3, {(0, 1): 3}))
show("ZZ, 2 x 2, empty", lambda: matrix(ZZ, 2, 2, {}))
show("ZZ, 0 x 0, empty", lambda: matrix(ZZ, 0, 0, {}))
show("ZZ, 3 x 0, empty", lambda: matrix(ZZ, 3, 0, {}))
show("ZZ, 0 x 3, empty", lambda: matrix(ZZ, 0, 3, {}))
show("a zero value", lambda: matrix(ZZ, 2, 2, {(0, 0): 0}))
show("negative row index", lambda: matrix(ZZ, 2, 2, {(-1, 0): 1}))
show("negative row index -2", lambda: matrix(ZZ, 2, 2, {(-2, 0): 1}))
show("negative column index", lambda: matrix(ZZ, 2, 3, {(0, -1): 1}))
show("the same position twice, -1 then 1", lambda: matrix(ZZ, 2, 2, {(-1, 0): 7, (1, 0): 5}))
show("the same position twice, 1 then -1", lambda: matrix(ZZ, 2, 2, {(1, 0): 5, (-1, 0): 7}))
show("integral rational index", lambda: matrix(ZZ, 2, 2, {(1/1, 1): 1}))
show("Integer and bool indices", lambda: matrix(ZZ, 2, 2, {(Integer(1), False): 4}))
show("a frozenset key", lambda: matrix(ZZ, 2, 2, {frozenset([0, 1]): 1}))
show("GF(5), 2 x 2", lambda: matrix(GF(5), 2, 2, {(0, 1): 3}))
show("GF(5), 2 x 3", lambda: matrix(GF(5), 2, 3, {(1, 2): 7}))
show("GF(5), bare", lambda: matrix(GF(5), {(1, 1): 7}))
show("GF(5), 2 rows", lambda: matrix(GF(5), 2, {(1, 0): 6}))
show("GF(4), 2 x 2", lambda: matrix(GF(4, 'a'), 2, 2, {(1, 1): a}))
show("MatrixSpace(ZZ, 2)", lambda: MatrixSpace(ZZ, 2)({(0, 1): 3}))
show("MatrixSpace(QQ, 2, 3)", lambda: MatrixSpace(QQ, 2, 3)({(1, 2): 1/2}))
show("MatrixSpace(ZZ, 2), negative", lambda: MatrixSpace(ZZ, 2)({(-1, -1): 4}))
# errors
show("row out of range", lambda: matrix(ZZ, 2, 2, {(2, 0): 1}))
show("column out of range", lambda: matrix(ZZ, 2, 2, {(0, 5): 1}))
show("both out of range", lambda: matrix(ZZ, 2, 2, {(5, 7): 1}))
show("negative row index -3", lambda: matrix(ZZ, 2, 2, {(-3, 0): 1}))
show("negative column index -4", lambda: matrix(ZZ, 2, 3, {(0, -4): 1}))
show("bare, negative row", lambda: matrix({(-1, 0): 1}))
show("bare, negative column", lambda: matrix({(0, -1): 1}))
show("bare, negative column before a negative row", lambda: matrix({(0, -1): 1, (-1, 0): 1}))
show("3 rows, an index past them", lambda: matrix(ZZ, 1, {(2, 1): 3}))
show("QQ, 2 rows, a column past them", lambda: matrix(QQ, 2, {(0, 2): 1}))
show("0 x 0, a key", lambda: matrix(ZZ, 0, 0, {(0, 0): 1}))
show("GF(5), out of range", lambda: matrix(GF(5), 2, 2, {(2, 0): 1}))
show("GF(5), bare, negative", lambda: matrix(GF(5), {(-1, 0): 1}))
show("MatrixSpace, out of range", lambda: MatrixSpace(ZZ, 2)({(3, 1): 3}))
show("a float index", lambda: matrix(ZZ, 2, 2, {(0.5, 1): 1}))
show("an integral float index", lambda: matrix(ZZ, 2, 2, {(1.0, 1): 1}))
show("a rational index", lambda: matrix(ZZ, 2, 2, {(1/2, 1): 1}))
show("a string index", lambda: matrix(ZZ, 2, 2, {("a", 1): 1}))
show("a two-letter string key", lambda: matrix(ZZ, 2, 2, {"ab": 1}))
show("an integer key", lambda: matrix(ZZ, 2, 2, {1: 1}))
show("a bool key", lambda: matrix(ZZ, 2, 2, {True: 1}))
show("bare, an integer key", lambda: matrix({1: 1}))
show("a triple key", lambda: matrix(ZZ, 2, 2, {(0, 1, 2): 1}))
show("a 1-tuple key", lambda: matrix(ZZ, 2, 2, {(0,): 1}))
show("bare, a 0-tuple key", lambda: matrix({(): 1}))
show("bare, a float index", lambda: matrix({(0.5, 0): 1}))
show("bare, a string index", lambda: matrix({("a", 0): 1}))
# every key is checked before any entry: given dimensions, all made
# integers first, then each range-checked; bare, each key in turn
show("out of range, then a float", lambda: matrix(ZZ, 2, 2, {(9, 0): 1, (0, 0.5): 1}))
show("a float, then out of range", lambda: matrix(ZZ, 2, 2, {(0, 0.5): 1, (9, 0): 1}))
show("out of range, then a triple", lambda: matrix(ZZ, 2, 2, {(9, 0): 1, (0, 0, 0): 1}))
show("in range, then out of range", lambda: matrix(ZZ, 2, 2, {(0, 0): 1, (9, 0): 2}))
show("bare, negative, then a float", lambda: matrix({(-1, 0): 1, (0, 0.5): 1}))
show("bare, a float, then negative", lambda: matrix({(0, 0.5): 1, (-1, 0): 1}))

# the ring inferred from finite-field values, bare and with dimensions
# (astra2's CORR-PR107-1: they gave a matrix over the Symbolic Ring)
F5 = GF(5)
show("GF(5), bare", lambda: matrix({(0, 0): F5(2)}))
show("GF(5), 2 x 2", lambda: matrix(2, 2, {(0, 1): F5(3)}))
show("GF(5), 2 rows", lambda: matrix(2, {(1, 1): F5(3)}))
show("GF(5) and an integer", lambda: matrix({(0, 0): F5(2), (0, 1): 3}))
show("GF(5), 2 x 2, sparse=False", lambda: matrix(2, 2, {(0, 0): F5(2)}, sparse=False))
show("GF(4), bare", lambda: matrix({(0, 0): a, (1, 1): 1}))
show("GF(4), 2 x 3", lambda: matrix(2, 3, {(0, 2): a + 1}))

# a position given twice (a negative index and its positive one): the ring
# is inferred from every value, the overwritten one too; the default
# (sparse) constructor converts every value, and a zero does not
# overwrite; sparse=False keeps the last value as given (astra2's
# CORR-PR107-2)
def show_type(label, f):
    # (the error's type only: Sagebrush's wording for a value ZZ refuses
    # is its own)
    try:
        M = f()
        print(label)
        print(M)
        print(M.dimensions(), M.base_ring())
    except Exception as e:
        print(label, "error:", type(e).__name__)
d = {(-1, 0): 1/2, (1, 0): 5}
show("overwritten rational", lambda: matrix(2, 2, d))
show("overwritten rational, sparse=False", lambda: matrix(2, 2, d, sparse=False))
show("overwritten rational, sparse=True", lambda: matrix(2, 2, d, sparse=True))
show("overwritten rational, and another entry", lambda: matrix(2, 2, {(-1, 0): 1/2, (1, 0): 5, (0, 0): 1}))
show("overwritten GF(5) value", lambda: matrix(2, 2, {(-1, 0): F5(1), (1, 0): 5}))
show("overwritten GF(5) value, sparse=False", lambda: matrix(2, 2, {(-1, 0): F5(1), (1, 0): 5}, sparse=False))
show_type("ZZ, an overwritten string", lambda: matrix(ZZ, 2, 2, {(-1, 0): 'bad', (1, 0): 5}))
show("ZZ, an overwritten string, sparse=False", lambda: matrix(ZZ, 2, 2, {(-1, 0): 'bad', (1, 0): 5}, sparse=False))
show_type("ZZ, an overwritten rational", lambda: matrix(ZZ, 2, 2, {(-1, 0): 1/2, (1, 0): 5}))
show_type("ZZ, an overwritten rational, sparse=True", lambda: matrix(ZZ, 2, 2, {(-1, 0): 1/2, (1, 0): 5}, sparse=True))
show("ZZ, an overwritten rational, sparse=False", lambda: matrix(ZZ, 2, 2, {(-1, 0): 1/2, (1, 0): 5}, sparse=False))
show_type("ZZ, a rational last", lambda: matrix(ZZ, 2, 2, {(1, 0): 5, (-1, 0): 1/2}))
show_type("ZZ, a rational last, sparse=False", lambda: matrix(ZZ, 2, 2, {(1, 0): 5, (-1, 0): 1/2}, sparse=False))
show("a zero does not overwrite", lambda: matrix(2, 2, {(-1, 0): 3, (1, 0): 0}))
show("a zero overwrites, sparse=False", lambda: matrix(2, 2, {(-1, 0): 3, (1, 0): 0}, sparse=False))
show("a zero first", lambda: matrix(2, 2, {(1, 0): 0, (-1, 0): 3}))
show("a zero last", lambda: matrix(2, 2, {(1, 0): 3, (-1, 0): 0}))
show("GF(5): 5 is zero", lambda: matrix(GF(5), 2, 2, {(-1, 0): 1, (1, 0): 5}))
show("GF(5): 5 is zero, sparse=False", lambda: matrix(GF(5), 2, 2, {(-1, 0): 1, (1, 0): 5}, sparse=False))
show("QQ, a zero, sparse=True", lambda: matrix(QQ, 2, 2, {(-1, 0): 3, (1, 0): 0}, sparse=True))
show("two positions twice", lambda: matrix(2, 2, {(-1, 0): 3, (1, 0): 0, (-1, -1): 4, (1, 1): 7}))

# keys iterable by the sequence protocol (__getitem__ only), as Sage reads
# them (astra2's CORR-PR107-3), with the same errors for too few or too
# many items
class Seq:
    def __init__(self, n, v):
        self.n, self.v = n, v
    def __getitem__(self, i):
        if i < self.n:
            return self.v[i]
        raise IndexError
show("a sequence key", lambda: matrix(ZZ, 2, 2, {Seq(2, [0, 1]): 3}))
show("a sequence key, bare", lambda: matrix({Seq(2, [0, 1]): 3}))
show("a sequence key of three", lambda: matrix(ZZ, 2, 2, {Seq(3, [0, 0, 0]): 3}))
show("a sequence key of one", lambda: matrix(ZZ, 2, 2, {Seq(1, [0]): 3}))
show("a sequence key of none", lambda: matrix(ZZ, 2, 2, {Seq(0, []): 3}))

# the sparse flag by its truth value, a position given twice: True, 1 and
# None (no flag) are the dict's default, sparse; False and 0 are dense
for s in [True, False, None, 0, 1]:
    show("sparse=%r: a zero last" % (s,), lambda: matrix(2, 2, {(-1, 0): 3, (1, 0): 0}, sparse=s))
    show_type("sparse=%r: ZZ, an overwritten rational" % (s,), lambda: matrix(ZZ, 2, 2, {(-1, 0): 1/2, (1, 0): 5}, sparse=s))
    show("sparse=%r: GF(5), 5 is zero" % (s,), lambda: matrix(GF(5), 2, 2, {(-1, 0): 1, (1, 0): 5}, sparse=s))
