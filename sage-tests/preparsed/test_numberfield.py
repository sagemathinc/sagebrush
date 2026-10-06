# Generated from ../test_numberfield.sage by Sage's preparser (run_cpython.py --regen).
_sage_const_3 = Integer(3); _sage_const_11 = Integer(11); _sage_const_7 = Integer(7); _sage_const_5 = Integer(5); _sage_const_0 = Integer(0); _sage_const_1 = Integer(1); _sage_const_2 = Integer(2); _sage_const_8 = Integer(8); _sage_const_4 = Integer(4); _sage_const_10 = Integer(10); _sage_const_23 = Integer(23); _sage_const_128 = Integer(128); _sage_const_30 = Integer(30); _sage_const_6 = Integer(6); _sage_const_9 = Integer(9); _sage_const_12 = Integer(12)# Number fields, integer matrices, roots, factoring: the Rust engine
# (engine/classgroup).  Class groups and regulators assume GRH, as Sage's do.
x = polygen(QQ, "x")

# a cubic field with class number 2
K = NumberField(x**_sage_const_3  - _sage_const_11 , names=('a',)); (a,) = K._first_ngens(1)
print(K)
print(K.discriminant(), K.degree(), K.signature())
print(K.class_group())
print(K.class_number(), K.class_group().invariants(), K.class_group().order())
print(K.regulator())
print(K.number_of_roots_of_unity(), K.unit_group())
print(K.integral_basis())
print(K.maximal_order())
print(K.primes_above(_sage_const_7 ))
print(K.factor(_sage_const_7 ))
P = K.primes_above(_sage_const_5 )[_sage_const_0 ]; print(P, P.norm(), P.ramification_index(), P.residue_class_degree())
print(K.ideal(_sage_const_5 ).factor())
print((a+_sage_const_1 )**_sage_const_3 , (a**_sage_const_2 +_sage_const_1 )/(a-_sage_const_1 ), (a+_sage_const_1 ).norm(), (a+_sage_const_1 ).trace(), a.minpoly())

# class number 1, units of rank 1
K2 = NumberField(x**_sage_const_3  - _sage_const_2 , names=('a2',)); (a2,) = K2._first_ngens(1)
print(K2.class_group()); print(K2.unit_group()); print(K2.regulator())
print((a2+_sage_const_1 )**_sage_const_3 , (a2**_sage_const_2 +_sage_const_1 )/(a2-_sage_const_1 ), (a2+_sage_const_1 ).norm(), (a2+_sage_const_1 ).trace(), a2.minpoly())
P = K2.factor(_sage_const_5 )[_sage_const_1 ][_sage_const_0 ]; print(P.norm(), P.residue_class_degree(), P.is_prime())

# non-monogenic orders, roots of unity, unit rank 3
L = NumberField(x**_sage_const_2  + _sage_const_3 , names=('b',)); (b,) = L._first_ngens(1)
print(L.integral_basis()); print(L.maximal_order()); print(L.unit_group()); print(L.class_group())
M = NumberField(x**_sage_const_3  + x**_sage_const_2  - _sage_const_2 *x + _sage_const_8 , names=('c',)); (c,) = M._first_ngens(1)
print(M.integral_basis()); print(M.maximal_order()); print(M.discriminant())
N = NumberField(x**_sage_const_4  - _sage_const_10 *x**_sage_const_2  + _sage_const_1 , names=('d',)); (d,) = N._first_ngens(1)
print(N.unit_group()); print(N.signature()); print(N.regulator())
Z = NumberField(x**_sage_const_4  + _sage_const_1 , names=('z',)); (z,) = Z._first_ngens(1); print(Z.unit_group()); print(Z.number_of_roots_of_unity())

# quadratic fields (the quadratic class group algorithms)
Q = QuadraticField(-_sage_const_23 , names=('q',)); (q,) = Q._first_ngens(1); print(Q); print(Q.class_group()); print(Q.class_number())
Q = QuadraticField(_sage_const_10 , names=('e',)); (e,) = Q._first_ngens(1); print(Q); print(Q.class_group()); print(Q.regulator())

# integers: ECM
print(factor(_sage_const_2 **_sage_const_128 +_sage_const_1 ))
print(factor(_sage_const_10 **_sage_const_30 +_sage_const_1 ))

# integer matrices
A = matrix(ZZ, [[_sage_const_2 ,-_sage_const_4 ,_sage_const_6 ],[_sage_const_3 ,_sage_const_0 ,-_sage_const_1 ]]); print(A); print(A.hermite_form()); print(A.elementary_divisors()); print(A.smith_form()[_sage_const_0 ]); print(A.rank())
B = matrix(QQ, [[_sage_const_1 ,_sage_const_2 ],[_sage_const_3 ,_sage_const_4 ]]); print(B.echelon_form()); print(B.det()); print(B**-_sage_const_1 )
print(matrix(ZZ,_sage_const_3 ,_sage_const_3 ,range(_sage_const_9 )))
M = matrix(ZZ, [[_sage_const_4 ,_sage_const_6 ,_sage_const_2 ],[_sage_const_3 ,_sage_const_9 ,_sage_const_12 ],[_sage_const_1 ,_sage_const_1 ,_sage_const_1 ]]); print(M.hermite_form()); print(M.elementary_divisors()); print(M.smith_form()[_sage_const_0 ])
print(matrix(ZZ, [[_sage_const_1 ,_sage_const_2 ,_sage_const_3 ],[_sage_const_4 ,_sage_const_5 ,_sage_const_6 ],[_sage_const_7 ,_sage_const_8 ,_sage_const_10 ]]).LLL())

# roots
R = QQ['y']; (y,) = R._first_ngens(1); print((y**_sage_const_2 -_sage_const_2 ).roots(RR)); print((y**_sage_const_4 +_sage_const_1 ).roots(CC)); print((y**_sage_const_3 -_sage_const_2 ).roots(CC))