# Algebraic number theory as on sagebrush.space ("Algebraic number theory"
# examples): symbolic defining polynomials, splitting of primes, quadratic
# and cyclotomic fields, and how Sage prints their embeddings.
x = var('x')

K.<a> = NumberField(x^3 - 11)
print(K)
print(K.discriminant(), K.signature(), K.integral_basis())
print(K.maximal_order(), K.unit_group(), K.regulator())
for p in prime_range(2, 30):
    print(p, [(P.residue_class_degree(), e) for P, e in K.factor(p)])

K.<a> = NumberField(x^3 + 17*x + 1)
print(K.class_group(), K.regulator())

print([d for d in range(1, 200) if is_squarefree(d) and QuadraticField(-d).class_number() == 1])
print(is_squarefree(12), is_squarefree(30), is_squarefree(-30))

# the embeddings Sage prints for QuadraticField ("question style" intervals)
for n in [2, 3, 5, 7, 10, 23, 99, 101, 1000003, 10^8 + 7, 10^10 + 19, 10^12 + 39, 10^14 + 31, 10^16 + 61, 10^18 + 3, 10^20 + 1, 10^24 + 7, 123456789, 987654321987]:
    print(QuadraticField(n), QuadraticField(-n))

K = CyclotomicField(7)
print(K, K.unit_group(), K.regulator())
print(CyclotomicField(12), CyclotomicField(5).class_number())

print(factor(2^128 + 1))
M = matrix(ZZ, [[1, 1, 1], [-1, 0, 2], [3, 5, 6]])
print(M.hermite_form())
print(M.elementary_divisors())
print(M.LLL())
R.<y> = QQ[]
print((y^5 - y - 1).roots(CC))
