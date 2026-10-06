# Number fields, integer matrices, roots, factoring: the Rust engine
# (engine/classgroup).  Class groups and regulators assume GRH, as Sage's do.
x = polygen(QQ, "x")

# a cubic field with class number 2
K.<a> = NumberField(x^3 - 11)
print(K)
print(K.discriminant(), K.degree(), K.signature())
print(K.class_group())
print(K.class_number(), K.class_group().invariants(), K.class_group().order())
print(K.regulator())
print(K.number_of_roots_of_unity(), K.unit_group())
print(K.integral_basis())
print(K.maximal_order())
print(K.primes_above(7))
print(K.factor(7))
P = K.primes_above(5)[0]; print(P, P.norm(), P.ramification_index(), P.residue_class_degree())
print(K.ideal(5).factor())
print((a+1)^3, (a^2+1)/(a-1), (a+1).norm(), (a+1).trace(), a.minpoly())

# class number 1, units of rank 1
K2.<a2> = NumberField(x^3 - 2)
print(K2.class_group()); print(K2.unit_group()); print(K2.regulator())
print((a2+1)^3, (a2^2+1)/(a2-1), (a2+1).norm(), (a2+1).trace(), a2.minpoly())
P = K2.factor(5)[1][0]; print(P.norm(), P.residue_class_degree(), P.is_prime())

# non-monogenic orders, roots of unity, unit rank 3
L.<b> = NumberField(x^2 + 3)
print(L.integral_basis()); print(L.maximal_order()); print(L.unit_group()); print(L.class_group())
M.<c> = NumberField(x^3 + x^2 - 2*x + 8)
print(M.integral_basis()); print(M.maximal_order()); print(M.discriminant())
N.<d> = NumberField(x^4 - 10*x^2 + 1)
print(N.unit_group()); print(N.signature()); print(N.regulator())
Z.<z> = NumberField(x^4 + 1); print(Z.unit_group()); print(Z.number_of_roots_of_unity())

# quadratic fields (the quadratic class group algorithms)
Q.<q> = QuadraticField(-23); print(Q); print(Q.class_group()); print(Q.class_number())
Q.<e> = QuadraticField(10); print(Q); print(Q.class_group()); print(Q.regulator())

# integers: ECM
print(factor(2^128+1))
print(factor(10^30+1))

# integer matrices
A = matrix(ZZ, [[2,-4,6],[3,0,-1]]); print(A); print(A.hermite_form()); print(A.elementary_divisors()); print(A.smith_form()[0]); print(A.rank())
B = matrix(QQ, [[1,2],[3,4]]); print(B.echelon_form()); print(B.det()); print(B^-1)
print(matrix(ZZ,3,3,range(9)))
M = matrix(ZZ, [[4,6,2],[3,9,12],[1,1,1]]); print(M.hermite_form()); print(M.elementary_divisors()); print(M.smith_form()[0])
print(matrix(ZZ, [[1,2,3],[4,5,6],[7,8,10]]).LLL())

# roots
R.<y> = QQ[]; print((y^2-2).roots(RR)); print((y^4+1).roots(CC)); print((y^3-2).roots(CC))
