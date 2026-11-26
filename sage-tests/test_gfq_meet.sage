# Extension fields GF(p^k) with Z/n, GF(p) and each other: Sage's coercion
# meets GF(p^k) with Z/n when p divides n (the Z/n element enters GF(p^k)
# through its integer lift), and refuses the other pairs; scalars, matrices
# and vectors, for *, + and - in both orders.
def show(f):
    try:
        r = f()
        print(parent(r))
        print(r)
    except TypeError as e:
        print("TypeError:", e)

rings = [GF(4, 'a'), GF(9, 'b'), GF(8, 'c'), GF(2), GF(3), Zmod(6), Zmod(12), Zmod(9), Zmod(4), Zmod(5), Zmod(1), Zmod(3**41)]

def mat(R, r, c, k):
    return matrix(R, r, c, [(k * 7 + 3 * i) % 97 for i in range(r * c)])

for R in rings:
    for S in rings:
        if R is S or not (R.degree() > 1 if hasattr(R, 'degree') and R.is_field() else False) and not (S.degree() > 1 if hasattr(S, 'degree') and S.is_field() else False):
            continue
        print(R, "|", S)
        s = S(7)
        M = mat(R, 2, 2, 1)
        show(lambda: s * M)
        show(lambda: M * s)
        show(lambda: M + s)
        show(lambda: s - M)
        N = mat(S, 2, 2, 2)
        show(lambda: M * N)
        show(lambda: M + N)
        show(lambda: N - M)
        show(lambda: M * vector(S, [1, 2]))
        show(lambda: vector(S, [2, 1]) * M)

# shapes: a non-square GF(4) matrix with a zero and a nonzero Z/4 or Z/6
# scalar for + (square only), and a scalar product
A = mat(GF(4, 'a'), 2, 3, 3)
show(lambda: A + Zmod(4)(0))
show(lambda: A + Zmod(6)(1))
show(lambda: Zmod(6)(7) * A)
# the elements themselves
print(GF(4, 'a')(Zmod(6)(7)), GF(9, 'b')(Zmod(3**41)(5)))
