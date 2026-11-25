# Number fields of a non-monic or rational defining polynomial, as Sage has them: the generator is a root of the
# polynomial given, which is the field's defining polynomial; elements print, convert and give coordinates on
# its powers.  (Invariants such as the discriminant are the field's.)
R.<x> = QQ[]
K.<a> = NumberField(3*x^2 + 1)
print(K)
print(a^2, a.minpoly(), a.charpoly(), K.defining_polynomial(), K.polynomial())
print(K.discriminant(), K.degree(), K.signature())
print(K.integral_basis())
print(K.maximal_order().basis())
print(K.class_number(), K.unit_group().rank(), K.number_of_roots_of_unity())
print((a + 1)^2, (a + 1)/(a - 1), (2*a).list(), a.list())
print((1 + a).matrix())
print(a.norm(), a.trace(), (3*a).is_integral(), a.is_integral())
print(K(x^2 + 1), K([1, 2]), K(3), K.gen())
print(latex(K), latex(a/2 + 1))
L.<b> = NumberField(x^2 + 1/3)
print(L, L == K, b^2, L.discriminant())
print(NumberField(3*x^2 + 1, "a") is K, NumberField(3*x^2 + 1, "a") == K, NumberField(x^2 + 1/3, "a") == K, NumberField(x^2 + 1/3, "a") is K)
M.<c> = NumberField(2*x^3 - 1/2*x + 5)
print(M)
print(c^3, M.discriminant(), M.polynomial(), c.minpoly())
print(M.integral_basis())
print(M.class_number(), M.unit_group().rank())
print((c^2 + c + 1)^-1, (c^2 + c + 1).norm(), (c + 1).matrix())
N.<d> = NumberField(x^2 - 1/2)
print(N, d^2, N.discriminant(), N.integral_basis(), (d + 1)^3)
P.<e> = NumberField(x^3 - 2/27)
print(P, e^3, P.discriminant(), P.integral_basis(), e.minpoly())
print(P.maximal_order().basis(), (3*e).is_integral())
# Polynomials over these fields (factor, gcd, roots), the maximal order's generators and name, and the primes above
# small p (norm, ramification index, residue degree, integral generators), which go through the field's model
for f in [x^2 - 1/2, 3*x^2 + 1, 2*x^3 - 1/2*x + 5, x^3 - 2/27, 4*x^2 + 2*x + 1]:
    K = NumberField(f, 'a'); a = K.gen()
    S.<y> = K[]
    print(f, "|", K.maximal_order())
    print((y^2 - a^2).factor(), "|", gcd(y^2 - a^2, y - a), "|", (y^2 - a^2).roots())
    print((y^3 - a^3).factor(), "|", (y^2 + y*a).roots(), "|", gcd((y - a)*(y + 1), (y - a)*(y - 1)))
    for p in [2, 3, 5, 7]:
        print(p, [(q.norm(), q.ramification_index(), q.residue_class_degree(), all(K(z).is_integral() for z in q.gens())) for q in K.primes_above(p)])
