# Generated from ../test_ant.sage by Sage's preparser (run_cpython.py --regen).
_sage_const_3 = Integer(3); _sage_const_11 = Integer(11); _sage_const_2 = Integer(2); _sage_const_30 = Integer(30); _sage_const_17 = Integer(17); _sage_const_1 = Integer(1); _sage_const_200 = Integer(200); _sage_const_12 = Integer(12); _sage_const_5 = Integer(5); _sage_const_7 = Integer(7); _sage_const_10 = Integer(10); _sage_const_23 = Integer(23); _sage_const_99 = Integer(99); _sage_const_101 = Integer(101); _sage_const_1000003 = Integer(1000003); _sage_const_8 = Integer(8); _sage_const_19 = Integer(19); _sage_const_39 = Integer(39); _sage_const_14 = Integer(14); _sage_const_31 = Integer(31); _sage_const_16 = Integer(16); _sage_const_61 = Integer(61); _sage_const_18 = Integer(18); _sage_const_20 = Integer(20); _sage_const_24 = Integer(24); _sage_const_123456789 = Integer(123456789); _sage_const_987654321987 = Integer(987654321987); _sage_const_128 = Integer(128); _sage_const_0 = Integer(0); _sage_const_6 = Integer(6)# Algebraic number theory as on sagebrush.space ("Algebraic number theory"
# examples): symbolic defining polynomials, splitting of primes, quadratic
# and cyclotomic fields, and how Sage prints their embeddings.
x = var('x')

K = NumberField(x**_sage_const_3  - _sage_const_11 , names=('a',)); (a,) = K._first_ngens(1)
print(K)
print(K.discriminant(), K.signature(), K.integral_basis())
print(K.maximal_order(), K.unit_group(), K.regulator())
for p in prime_range(_sage_const_2 , _sage_const_30 ):
    print(p, [(P.residue_class_degree(), e) for P, e in K.factor(p)])

K = NumberField(x**_sage_const_3  + _sage_const_17 *x + _sage_const_1 , names=('a',)); (a,) = K._first_ngens(1)
print(K.class_group(), K.regulator())

print([d for d in range(_sage_const_1 , _sage_const_200 ) if is_squarefree(d) and QuadraticField(-d).class_number() == _sage_const_1 ])
print(is_squarefree(_sage_const_12 ), is_squarefree(_sage_const_30 ), is_squarefree(-_sage_const_30 ))

# the embeddings Sage prints for QuadraticField ("question style" intervals)
for n in [_sage_const_2 , _sage_const_3 , _sage_const_5 , _sage_const_7 , _sage_const_10 , _sage_const_23 , _sage_const_99 , _sage_const_101 , _sage_const_1000003 , _sage_const_10 **_sage_const_8  + _sage_const_7 , _sage_const_10 **_sage_const_10  + _sage_const_19 , _sage_const_10 **_sage_const_12  + _sage_const_39 , _sage_const_10 **_sage_const_14  + _sage_const_31 , _sage_const_10 **_sage_const_16  + _sage_const_61 , _sage_const_10 **_sage_const_18  + _sage_const_3 , _sage_const_10 **_sage_const_20  + _sage_const_1 , _sage_const_10 **_sage_const_24  + _sage_const_7 , _sage_const_123456789 , _sage_const_987654321987 ]:
    print(QuadraticField(n), QuadraticField(-n))

K = CyclotomicField(_sage_const_7 )
print(K, K.unit_group(), K.regulator())
print(CyclotomicField(_sage_const_12 ), CyclotomicField(_sage_const_5 ).class_number())

print(factor(_sage_const_2 **_sage_const_128  + _sage_const_1 ))
M = matrix(ZZ, [[_sage_const_1 , _sage_const_1 , _sage_const_1 ], [-_sage_const_1 , _sage_const_0 , _sage_const_2 ], [_sage_const_3 , _sage_const_5 , _sage_const_6 ]])
print(M.hermite_form())
print(M.elementary_divisors())
print(M.LLL())
R = QQ['y']; (y,) = R._first_ngens(1)
print((y**_sage_const_5  - y - _sage_const_1 ).roots(CC))