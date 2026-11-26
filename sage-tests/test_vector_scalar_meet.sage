# A scalar over one GF(q) or Z/n ring times a vector over another, in both
# orders: computed in the ring where Sage's coercion meets them (Z/m and Z/n
# in Z/gcd(m, n), the smaller ring when one order divides the other, GF(p)
# over Z/p, GF(p^k) with Z/n when p divides n), or refused where it doesn't.
def show(f):
    try:
        r = f()
        print(parent(r))
        print(r)
    except TypeError:
        print("TypeError")

rings = [GF(2), GF(3), GF(5), GF(4, 'a'), GF(9, 'b'), Zmod(1), Zmod(4), Zmod(6), Zmod(8), Zmod(9), Zmod(12), Zmod(30), Zmod(2**64), Zmod(3**41)]
for R in rings:
    for S in rings:
        if R is S:
            continue
        print(R, "|", S)
        s = S(7)
        w = vector(R, [3, 4, 5])
        show(lambda: s * w)
        show(lambda: w * s)
