# Polynomials over prime fields: products, division with remainder and
# gcds, computed by the engine for p < 2^63 (products up to 2^15
# coefficients, divisions up to 2^15, gcds up to 2^14; small ones and
# larger p in Python), with their parents, zero cases and errors.

def poly(R, n, seed):
    # a deterministic polynomial of degree n - 1 (monic or not)
    F = R.base_ring()
    return R([F((i + seed) ** 3 + 7 * i * seed + 1) for i in range(n - 1)] + [F(seed + 2)])

def digest(f):
    return sum((i + 3) * ZZ(c) for i, c in enumerate(f.list()))

def show(label, f):
    try:
        print(label, f())
    except Exception as e:
        print(label, type(e).__name__)

for p in [2, 3, 7, 65537, 2^31 - 1, 4601552919265804289, 2^61 - 1, 2^63 - 25, 2^63 + 29]:
    F = GF(p)
    R.<x> = F[]
    print("p =", p, R)
    a, b, c = poly(R, 30, 1), poly(R, 25, 2), poly(R, 12, 3)
    print(a * b)
    q, r = a.quo_rem(b)
    print(q, "|", r, q * b + r == a)
    print(a // c, "|", a % c)
    print((a * c).gcd(b * c), (a * c).gcd(b * c).parent())
    print(a.gcd(a), R(0).gcd(R(0)), a.gcd(R(0)).monic() == a.monic())
    print(a.gcd(R(3)), R(5) * a == a * 5, (a * R(0)).is_zero(), (R(0) * a).parent())
    print(c.quo_rem(a), R(0).quo_rem(a))
    show("zero divisor", lambda: a.quo_rem(R(0)))
    show("zero floordiv", lambda: a // R(0))
    g, s, t = (a * c).xgcd(b * c)
    print("xgcd", g, s * a * c + t * b * c == g)
    print(a.lcm(c * b) == a * c * b / a.gcd(c * b), pow(x + 1, 1000, c))
    # larger (in the engine; one in Python for p > 2^63): compared by
    # checksums
    for (la, lb) in [(200, 150), (1000, 999), (3000, 70), (5000, 2500)][:1 if p > 2^63 else 4]:
        f, g = poly(R, la, 5), poly(R, lb, 6)
        h = poly(R, 50, 7)
        q, r = f.quo_rem(g)
        print(la, lb, digest(f * g), digest(q), digest(r), (q * g + r == f), digest((f * h).gcd(g * h)))
    G = R(1)
    for k in range(6 if p < 2^63 else 1):
        G *= poly(R, 40, 10 + k)
    f, g = G * poly(R, 300, 20), G * poly(R, 280, 21)
    print("gcd", digest(f.gcd(g)) == digest(G.monic()), f.gcd(g).degree())

# another variable name, and a monic divisor equal to the dividend
R.<y> = GF(65537)[]
f = poly(R, 300, 2)
print(f.quo_rem(f), (f * f).gcd(f) == f.monic(), (f * f).parent())

# past the engine's limits (2^15 coefficients): Python
R.<x> = GF(7)[]
f = R([1] * (2^15 + 1))
print((f * x).degree(), (f * R([1, 1])).degree())
