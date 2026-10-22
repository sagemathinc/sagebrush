# The shared finite-field core (lib/_sage_ffsub.py) seen from both front
# ends: run by test/ff-shared.test.ts; test/ff_shared_cases.out is its output.
# Sage's own answers for the same surface are sage-tests/test_ff_embed.
import _sage_ff as s
import _sage_ffsub as sub
import _magma as m


def t(label, f):
    try:
        print(label, f())
    except Exception as e:
        print(label, type(e).__name__, str(e).split(" (subfields")[0])


# astra CORR-FFSHARED-1: the cached image of GF(4)'s generator is
# parent-neutral, made an element of each target on use
F, U, V = s.GF(4, "a"), s.GF(16, "b"), s.GF(16, "c")
sub.IMAGES.clear()
y = sub.up(F.gen(), U, [sub.WORK], ValueError)
print("first target", y.parent() is U, y)
print("image for the second target", sub.image(F, V).parent() is V)
z = sub.up(F.gen(), V, [sub.WORK], ValueError)
print("second target", z.parent() is V, z)
out = []
for T in (U, V, U, V):
    w = sub.up(F.gen() + 1, T, [sub.WORK], ValueError)
    out.append((w.parent() is T, str(w)))
print("interleaved", out, len(sub.IMAGES))

# ONE bounded LRU for Sage and Magma: Magma's GF(16) is Sage's prefix GF(16)
sub.IMAGES.clear()
Z2, Z3, Z4, Z6 = s.GF(4), s.GF(8), s.GF(16), s.GF(64)
print("sage z2 + z4", Z2.gen() + Z4.gen(), sorted(sub.IMAGES))
a, b = m.GF(4).K.gen(), m.GF(16).K.gen()
print("magma same field objects", m.GF(16).K is Z4, m.GF(64).K is Z6)
print("magma a + b", m._str(m._add(a, b)), sorted(sub.IMAGES))
c = m.GF(8).K.gen()
print("magma a + c", m._str(m._add(a, c)), sorted(sub.IMAGES))
print("sage z3 * z6", Z3.gen() * Z6.gen(), sorted(sub.IMAGES))

# every Sage hook calls the bounded core
calls = {}
HOOKS = ("up", "down", "admit", "conjugates", "apply", "charge", "subfields_admit")
saved = {name: getattr(sub, name) for name in HOOKS}
for name in HOOKS:
    def spy(*args, _f=saved[name], _n=name, **kw):
        calls[_n] = calls.get(_n, 0) + 1
        return _f(*args, **kw)
    setattr(sub, name, spy)


def counted(label, f):
    calls.clear()
    r = f()
    print(label, sorted(calls.items()), r)


Fa, Kb = s.GF(4, "a"), s.GF(16, "b")
bb = Kb.gen()
counted("coerce up", lambda: Z4(Z2.gen()))
counted("descend", lambda: Z2(Z4.gen() ** 5))
counted("pushout", lambda: (Z2.gen() + Z3.gen()).parent())
counted("Hom", lambda: len(s.Hom(Fa, Kb)))
counted("hom check", lambda: Fa.hom([bb ** 5], Kb).im_gens())
counted("hom apply", lambda: Fa.hom([bb ** 5], Kb)(Fa.gen() + 1))
counted("subfields", lambda: len(Kb.subfields()))
counted("coerce_map_from", lambda: Z4.coerce_map_from(Z2).im_gens())
counted("prime value", lambda: s.GF(2)(Z4(1)))
for name in HOOKS:
    setattr(sub, name, saved[name])

# bounded refusals in words, Sage's side (the 2^20 cap of embeddings), the
# top-level GF cap distinct: GF(2^21) is made, embedding into it refused
Z11, Z10, Z21 = s.GF(2 ** 11), s.GF(2 ** 10), s.GF(2 ** 21)
t("common field past 2^20", lambda: Z11.gen() + Z10.gen())
t("embedding past 2^20", lambda: Z21(Z3.gen()))
t("GF(2^21) itself", lambda: Z21.order())

# subfields: one shared admission before anything is made (daybreak2
# LIMIT-PR53-1): the parent's size first (prime degree too), then the
# degrees, then the aggregate work; a refusal leaves every cache as it was
made = [0]
gf = s.GF


def gf_spy(*a, **k):
    made[0] += 1
    return gf(*a, **k)


def state():
    return (list(sub.IMAGES.items()), list(s._RINGS), list(s._CONWAY))


def sub_attempt(label, f):
    before, made[0] = state(), 0
    try:
        r = f()
        print(label, "admitted", len(r), "made", made[0])
    except (NotImplementedError, KeyError, ValueError) as e:
        print(label, "refused", type(e).__name__, "made", made[0], "unchanged", state() == before, str(e).split(" (computed")[0])


P13, P23, B21, F9 = s.GF(3 ** 13, "u"), s.GF(2 ** 23, "v"), s.GF(2 ** 21, "w"), s.GF(5 ** 9, "t")
B20 = s.GF(2 ** 20, "r")
s.GF = gf_spy
sub_attempt("prime degree past 2^20", lambda: P13.subfields())
sub_attempt("prime degree past 2^20, itself", lambda: P13.subfields(13))
sub_attempt("prime degree past 2^20, characteristic 2", lambda: P23.subfields(1))
sub_attempt("composite past 2^20", lambda: B21.subfields())
sub_attempt("composite past 2^20, one proper", lambda: B21.subfields(7))
sub_attempt("odd composite past 2^20", lambda: F9.subfields(3))
sub_attempt("a name missing", lambda: B20.subfields(name={2: "u"}))
# the aggregate: GF(2^20)'s proper subfields (degrees 2, 4, 5, 10), each
# image cold, refused one cop short with nothing made, admitted at exactly it
sub.IMAGES.clear()
seen = set()
need = sum(sub.degree_cost(d, 2, 20, seen) for d in (2, 4, 5, 10))
work = sub.WORK
sub.WORK = need - 1
sub_attempt("aggregate one short", lambda: B20.subfields())
sub.WORK = need
sub_attempt("aggregate exact", lambda: B20.subfields())
print("images", sorted(sub.IMAGES))
sub.WORK = work
# (fault injected: a subfield's Conway polynomial missing is refused, no
# search started, nothing made)
c10 = s._CONWAY.pop((2, 10))
sub_attempt("conway missing", lambda: B20.subfields(10))
s._CONWAY[(2, 10)] = c10
# (fault injected at the reservation itself: nothing made, caches as they were)
charge = sub.charge


def failing(*a):
    raise NotImplementedError("injected fault")


sub.charge = failing
sub_attempt("fault at the reservation", lambda: B20.subfields())
sub.charge = charge
s.GF = gf
