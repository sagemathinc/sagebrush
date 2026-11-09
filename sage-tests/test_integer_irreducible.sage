# Integer.is_irreducible(), as Sage: whether the integer is irreducible in ZZ, that is, whether its absolute value is
# prime (so 0, 1 and -1 are not; -7 is), a bool.
def show(label, f):
    try:
        print(label, "->", repr(f()), flush=True)
    except Exception as e:
        print(label, "->", "%s: %s" % (type(e).__name__, e), flush=True)
for n in [0, 1, -1, 2, -2, 3, 4, -4, 6, 7, -7, 9, 25, 97, 561, 2^61 - 1, -(2^61 - 1), 2^64 + 13, 2^89 - 1, (2^31 - 1)^2, 10^20 + 39, -(10^20 + 39), 2^127 - 1, (2^61 - 1) * (2^89 - 1)]:
    show("ZZ(%s).is_irreducible()" % n, lambda: ZZ(n).is_irreducible())
show("[n for n in [-10..10] if ZZ(n).is_irreducible()]", lambda: [n for n in [-10..10] if ZZ(n).is_irreducible()])
show("type(ZZ(7).is_irreducible()) is bool", lambda: type(ZZ(7).is_irreducible()) is bool)
show("Integer(7).is_irreducible(), (7).is_irreducible()", lambda: (Integer(7).is_irreducible(), (7).is_irreducible()))
show("ZZ(-7).is_irreducible(), ZZ(-7).is_prime()", lambda: (ZZ(-7).is_irreducible(), ZZ(-7).is_prime()))
show("count in [1..2000], in [-2000..-1]", lambda: (sum(1 for n in [1..2000] if ZZ(n).is_irreducible()), sum(1 for n in [-2000..-1] if ZZ(n).is_irreducible())))
show("ZZ['x'](7).is_irreducible()", lambda: ZZ['x'](7).is_irreducible())
