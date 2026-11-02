# discrete_log as the pcimc cryptography book (github.com/lrfinotti/pcimc) uses it (Pohlig-Hellman, index calculus),
# with bounds, ord, operation='+', GF(p^k) and the error cases.  The .out is SageMath 10.9's output of these statements
# (VM2, ~/sage-conda), less S26 (see test_discrete_log.deviations.md).
# One line per statement: S<nn> <repr> | <parent>, or S<nn> ERR <type>: <message>.
def show(n, f):
    try:
        v = f()
        print('S%02d %s | %s' % (n, repr(v).replace('\n', ' ; '), parent(v)))
    except Exception as e:
        print('S%02d ERR %s: %s' % (n, type(e).__name__, str(e)[:100]))
p = 1019
g = Mod(2, p)
show(1, lambda: discrete_log(Mod(5, p), g))
show(2, lambda: g^discrete_log(Mod(5, p), g))
show(3, lambda: [discrete_log(Mod(l, p), g) for l in prime_range(20)])
F = GF(p)
show(4, lambda: [discrete_log(F(l), F(2)) for l in [2, 3, 5, 7]])
show(5, lambda: discrete_log(F(1), F(2)))
show(6, lambda: discrete_log(F(2)^5, F(2)^3))
show(7, lambda: discrete_log(Mod(3, 7), Mod(6, 7)))
show(8, lambda: discrete_log(Mod(2, 7), Mod(3, 7)))
show(9, lambda: discrete_log(Mod(4, 15), Mod(2, 15)))
show(10, lambda: discrete_log(Mod(8, 15), Mod(2, 15)))
show(11, lambda: discrete_log(Mod(3, 15), Mod(2, 15)))
show(12, lambda: discrete_log(Mod(16, 101), Mod(2, 101), ord=100))
show(13, lambda: discrete_log(Mod(16, 101), Mod(2, 101), bounds=(10, 20)))
show(14, lambda: discrete_log(Mod(16, 101), Mod(2, 101), bounds=(5, 9)))
show(15, lambda: discrete_log(Mod(21, 101), Mod(3, 101), operation='+'))
show(16, lambda: discrete_log(F(21), F(3), operation='+'))
K = GF(3^4, 'z'); z = K.gen()
show(17, lambda: discrete_log(z^7, z))
show(18, lambda: discrete_log(z^6, z^2))
show(19, lambda: discrete_log(z, z^2))
q = 1000003
h = Mod(123456, q); b = Mod(2, q)
show(20, lambda: b.multiplicative_order())
show(21, lambda: discrete_log(h, b))
show(22, lambda: b^discrete_log(h, b) == h)
N = b.multiplicative_order(); r = N // 3
show(23, lambda: discrete_log(h^r, b^r))
show(24, lambda: discrete_log(Mod(1, p), g))
show(25, lambda: discrete_log(F(0), F(2)))
show(27, lambda: discrete_log(5, g))
show(28, lambda: discrete_log(Mod(5, p), 2))
P = 2^61 - 1
show(29, lambda: discrete_log(Mod(3, P)^123456789, Mod(3, P)))
show(30, lambda: discrete_log(Mod(16, 101), Mod(2, 101), ord=100, bounds=(10, 20)))
show(31, lambda: discrete_log(Mod(16, 101), Mod(2, 101), bounds=(0, 300)))
show(32, lambda: discrete_log(Mod(16, 101), Mod(2, 101), bounds=(50, 300)))
show(33, lambda: discrete_log(Mod(16, 101), Mod(2, 101), bounds=(104, 104)))
show(34, lambda: discrete_log(Mod(16, 101), Mod(2, 101), bounds=(0, 4)))
show(35, lambda: discrete_log(Mod(16, 101), Mod(4, 101)))
show(36, lambda: discrete_log(Mod(5, 101), Mod(4, 101)))
show(37, lambda: discrete_log(Mod(0, 101), Mod(3, 101), operation='+'))
show(38, lambda: discrete_log(Mod(4, 12), Mod(2, 12), operation='+'))
show(39, lambda: discrete_log(Mod(3, 12), Mod(2, 12), operation='+'))
show(40, lambda: discrete_log(Mod(16, 101), Mod(2, 101), ord=50))
