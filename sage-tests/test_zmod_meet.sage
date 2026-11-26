# GF(q) and Z/n operands that Sage's coercion meets in a common ring: Z/m
# and Z/n in Z/gcd(m, n) (the smaller ring when one order divides the other,
# GF(p) rather than Z/p), scalars, matrices
# and vectors, for *, + and - in both orders; and the pairs Sage refuses.
def show(f):
    try:
        r = f()
        print(parent(r))
        print(r)
    except (TypeError, ArithmeticError) as e:
        print(type(e).__name__ + ":", e)

rings = [Zmod(12), Zmod(9), GF(3), Zmod(3), Zmod(24), Zmod(4), GF(5), Zmod(35), Zmod(2**64), Zmod(3 * 2**64), GF(2)]

def mat(R, r, c, k):
    return matrix(R, r, c, [(k * 7 + 3 * i) % 97 for i in range(r * c)])

for R in rings:
    for S in rings:
        if R is S:
            continue
        print(R, "|", S)
        s = S(5)
        M = mat(R, 2, 2, 1)
        show(lambda: s * M)
        show(lambda: M * s)
        show(lambda: M + s)
        show(lambda: s + M)
        show(lambda: M - s)
        show(lambda: s - M)
        N = mat(S, 2, 2, 2)
        show(lambda: M * N)
        show(lambda: M + N)
        show(lambda: N - M)
        show(lambda: M * vector(S, [1, 2]))
        show(lambda: vector(S, [2, 1]) * M)

# shapes: a non-square matrix with a scalar (+ and - need square), and a
# product of non-square matrices over two rings
A = mat(Zmod(12), 2, 3, 3)
B = mat(Zmod(9), 3, 1, 4)
show(lambda: A * B)
show(lambda: GF(3)(2) * A)
show(lambda: A + GF(3)(2))
show(lambda: A + GF(3)(0))
show(lambda: B * mat(Zmod(9), 2, 2, 1))

# Z/1: the matrices meet in Z/1, and so does a scalar with a matrix over Z/1,
# but Sage refuses a scalar over Z/1 with a matrix over another ring
M = matrix(Zmod(12), [[1, 2], [3, 4]])
O = matrix(Zmod(1), [[0, 0], [0, 0]])
show(lambda: Zmod(1)(0) * M)
show(lambda: M + Zmod(1)(0))
show(lambda: Zmod(12)(5) * O)
show(lambda: M * O)
show(lambda: O + M)
show(lambda: GF(3)(1) * O)
show(lambda: O * matrix(GF(3), [[1, 0], [0, 1]]))
