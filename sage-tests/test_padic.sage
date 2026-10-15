# p-adic numbers: Zp and Qp with capped relative precision, O(p^n), their
# arithmetic and precision, functions (log, exp, sqrt, teichmuller), print
# modes and power series over them.
R = Zp(5); K = Qp(5); R6 = Zp(5, 6); K6 = Qp(5, 6)
print(R, K, Zp(5, 10), Qp(7, 3), Zp(2), Qp(3, 1))
print(R(7), R(0), R(25), R6(-1), R(1/3), R(10^30), R6(5^30), R(2^100), Qp(5, 3)(10^-7))
print(K(1/25), K6(3/10), R(7, 3), R(7, absprec=3), R(7, relprec=3), R6(0, 3), K6(0, -2), R6(23, 0), R6(23, 1), K6(23/5, 1))
print(R(Mod(3, 25)), R(Integers(25)(3)), R6(1/2), K6(1/2), K6(2/5), K6(-2/125), R6(123456789), Zp(3, 5)(-1), Zp(2, 8)(-1))
print(O(5^3), O(5^-2), O(25), 1 + O(5^3), 5 + O(5^3), 3/5 + O(5^3), O(5^3) + O(5^2), Zp(5, 4)(1) + O(5^9))
print((1 + O(5^3))*(5 + O(5^2)), (1 + O(5^3)) - (1 + O(5^3)), (5 + O(5^3)) - 5, (1 + O(5^3))/(5 + O(5^2)))
print((2 + O(5^3))^5, (2 + O(5^3))^25, (2 + O(5^3))^10, (2 + O(5^3))^-5, (5 + O(5^3))^5, (10 + O(5^4))^5)
print((1 + O(2^3))^2, (1 + O(2^3))^4, (3 + O(2^3))^2, (1 + O(2^1))^2, (1 + O(2^2))^2, (1 + O(3^2))^3, (1 + O(3))^3, (2 + O(3))^3)
print(O(5^3)^0, (5 + O(5^3))^0, R6(2)^0, O(5^3)^2, O(5^3)*O(5^2), O(5^3)*7, O(5^3)/5, -O(5^3), R6(23) - 23, R6(23) * 0, R6(23) + 0)
print(R(3)/R(5), R(3)/5, K(3)/5, Zp(5, 4)(2)/3, Zp(5, 4)(10)*Zp(5, 4)(10), R(2)^10, R6(2)^-1, R6(25)^-1)
print(R6(23) + 1/5, R6(23)*(1/5), 1/5 + R6(23), R6(23) + K6(1/5), Zp(5, 8)(1/3) + Zp(5, 4)(1), Zp(5, 8)(1/3)*Qp(5, 4)(5))
for a, b in [(Zp(5, 6), Qp(5, 8)), (Zp(5, 8), Qp(5, 4)), (Qp(5, 4), Qp(5, 8)), (Zp(5, 8), Zp(5, 4)), (Qp(5, 8), Zp(5, 4))]:
    print(parent(a(1) * b(1)))
print(R6(0) == O(5^3), O(5^3) == 0, R6(5) + O(5^3) == 5, R6(23) == 23, R6(23) == 1/5, hash(R6(23)) == hash(23))
print(R6(5) < R6(1), R6(24) < R6(5), R6(1) < R6(-1))
# functions
print(R6(1 + 5).log(), R6(4).log(), R6(2).log(), Zp(2, 10)(3).log(), Zp(2, 10)(5).log(), Zp(2, 10)(-1).log(), Zp(3, 6)(2).log(), Zp(3, 6)(4).log())
print(Zp(2, 10)(1, 1).log(), Zp(2, 10)(3, 2).log(), R6(2, 1).log(), R6(1 + 5, 2).log(), R6(23).log(p_branch=0), K6(5).log(p_branch=0))
print(R6(2).log(p_branch=5), R6(10).log(p_branch=5), K6(2/5).log(p_branch=1), R6(10).log(p_branch=R6(5)), R6(10).log(0))
print(R6(5).exp(), R6(25).exp(), Zp(3, 6)(3).exp(), Zp(2, 10)(4).exp(), Zp(2, 10)(8).exp(), Zp(3, 6)(9).exp(), R6(5, 3).exp(), R6(0, 3).exp(), R6(0).exp())
print(R6(2).log().exp(), R6(1 + 5).log().exp())
print(R6(6).sqrt(), R6(-1).sqrt(), R6(25*6).sqrt(), Zp(2, 10)(17).sqrt(), R6(4).sqrt(), R6(9).sqrt(), R6(11).sqrt(), R6(-4).sqrt(), R6(16).sqrt(), R6(14).sqrt())
print(Zp(7, 4)(2).sqrt(), Zp(7, 4)(-3).sqrt(), Zp(11, 4)(3).sqrt(), Zp(13, 4)(10).sqrt(), Zp(2, 10)(9).sqrt(), Zp(2, 10)(25).sqrt(), Zp(2, 10)(-7).sqrt(), Zp(2, 10)(4*17).sqrt())
print(Zp(3, 6)(7).sqrt(), Zp(3, 6)(4).sqrt(), (4 + O(5^3)).sqrt(), R6(0).sqrt(), R6(4).sqrt(all=True))
for r in [3, 4, 5, 8]:
    print([Zp(2, 20)(u, r).sqrt() for u in [1, 9, 17, 33, 57]])
print(R6(25).is_square(), R6(5).is_square(), Zp(2, 10)(17).is_square(), Zp(2, 10)(5).is_square(), R6(23).is_square(), R6(2).is_square())
print(R6.teichmuller(2), Zp(2, 10).teichmuller(3), Zp(3, 6).teichmuller(2), R6.teichmuller(3, 3), Zp(3, 10).teichmuller(0), R6.teichmuller(R6(7, 2)), R6.teichmuller_system())
# queries
print(R(75).valuation(), R(75).unit_part(), R6(75).precision_absolute(), R6(75).precision_relative(), R6(75).lift(), R6(-1).lift(), R6(0).valuation())
print(R6(-1).residue(), R6(-1).residue(2), R6(5).residue(), list(R6(23).expansion()), R6(23).expansion(1), list(K6(2/25).expansion()), K6(2/25).expansion(-2), list(R6(23, 2).expansion()))
print(K6(2/25).valuation(), K6(2/25).lift(), K6(2/25).unit_part(), K6(2/5).rational_reconstruction(), R6(1/3).rational_reconstruction(), R6(23).ordp())
print(R6(0, 3).valuation(), R6(0, 3).unit_part(), R6(0, 3).precision_relative(), R6(0).precision_absolute(), R6(0).precision_relative(), R6(23, 2).lift(), R6(0, 3).lift())
print(R6(23).norm(), R6(23).trace(), R6(23).abs(), K6(2/5).abs(), R6(23).add_bigoh(2), R6(23).add_bigoh(10), R6(2, 3).lift_to_precision(5), R6(2, 3).lift_to_precision())
print(R6(23).is_zero(), O(5^2).is_zero(), bool(O(5^2)), R6(5).is_unit(), R6(2).is_unit(), K6(5).is_unit(), R6(23).is_equal_to(23, 2), R6(2).multiplicative_order(), R6.teichmuller(2).multiplicative_order())
print(R6(23) % 5, R6(23) // 5, R6(2).inverse_of_unit(), ZZ(R6(23)), QQ(K6(2/5)), R6(Qp(5, 6)(1/5)*5))
# the rings
print(R6.prime(), R6.precision_cap(), R6.residue_field(), R6.fraction_field(), K6.integer_ring(), R6.zero(), R6.one(), R6.gen(), R.uniformizer())
print(R.is_field(), K.is_field(), R.characteristic(), R.residue_characteristic(), R6.absolute_degree(), R6.ngens(), R6.is_finite(), R6.cardinality(), Zp(5) is Zp(5), Zp(5) == Zp(5, 20))
print(latex(R6(23)), latex(K6(2/25)), latex(R6(0, 3)), latex(R6(0)), latex(R6(-1)), latex(Zp(5)), latex(Qp(5, 6)))
# print modes
print(Zp(5, 6, print_mode='terse')(23), Zp(5, 6, print_mode='terse')(-1), Zp(5, 6, print_mode='terse')(0, 3), Qp(5, 6, print_mode='terse')(-2/125), Qp(5, 6, print_mode='terse')(2/5), Zp(5, 6, print_mode='terse')(25), Qp(5, 6, print_mode='terse')(1/5))
print(Zp(5, 6, print_mode='val-unit')(75), Zp(5, 6, print_mode='val-unit')(23), Zp(5, 6, print_mode='val-unit')(5), Zp(5, 6, print_mode='val-unit')(-5), Qp(5, 6, print_mode='val-unit')(2/25), Zp(5, 6, print_mode='val-unit')(0), Zp(5, 6, print_mode='val-unit')(0, 3), Zp(5, 6, print_mode='val-unit')(25*3, 4))
print(Zp(5, 6, print_mode='digits')(23), Zp(5, 6, print_mode='digits')(-1), Qp(5, 6, print_mode='digits')(2/25), Zp(5, 6, print_mode='digits')(75), Zp(5, 6, print_mode='digits')(0, 3), Zp(5, 6, print_mode='digits')(0), Qp(5, 6, print_mode='digits')(2/5^8), Zp(5, 6, print_mode='digits')(5^9))
print(Zp(5, 6, print_mode='bars')(23), Zp(5, 6, print_mode='bars')(75), Qp(5, 6, print_mode='bars')(2/25), Zp(11, 4, print_mode='bars')(23), Zp(5, 6, print_mode='bars')(0, 3))
print(Zp(5, 6, print_pos=False)(23), Zp(5, 6, print_pos=False)(-1), Zp(5, 6, print_pos=False)(23 + 3*125), Zp(5, 6, print_pos=False)(-23), Zp(5, 6, print_pos=False)(2*5), Zp(5, 6, print_pos=False)(3*5), Zp(5, 6, print_pos=False)(-5))
print(Zp(5, 6, print_max_terms=3)(-1), Zp(5, 6, print_max_terms=3)(23), Zp(5, 6, print_max_terms=1)(-1), Zp(13, 4)(-1), Zp(13, 4)(12*13))
print(Zp(5, 6, print_mode='val-unit', print_pos=False)(-5), Zp(5, 6, print_mode='terse', print_pos=False)(-1), Zp(5, 6, print_mode='terse') == Zp(5, 6))
# power series over the p-adics
S.<T> = PowerSeriesRing(Zp(5, 4))
f = (5 + O(5^4)) + O(5)*T + (4*5 + O(5^2))*T^2 + O(T^5)
print(f)
print(S.gen(), f^2, f*T + 1)

# Series over p-adics of different caps and kinds (review CORR-D9E-1):
# the base Sage uses keeps the coefficients' precision; division and
# inversion over Zp (CORR-D9E-2): scalars move to Qp, a nonunit constant
# term is refused, quotients of positive valuation stay over Zp
A = Zp(5, 6); K = Qp(5, 3); B = Zp(5, 3); L = Qp(5, 8)
S.<T> = PowerSeriesRing(A)
R.<U> = PowerSeriesRing(K)
V.<W> = PowerSeriesRing(B)
SK = PowerSeriesRing(K, 'T'); SB = PowerSeriesRing(B, 'T'); SL = PowerSeriesRing(L, 'T')
tK = SK.gen(); tB = SB.gen(); tL = SL.gen()
Q.<q> = QQ[[]]
try:
    r = A(1) + K(1)
    print('A(1) + K(1)', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('A(1) + K(1)', '=>', type(ex).__name__, ex)
try:
    r = B(1) + L(1)
    print('B(1) + L(1)', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('B(1) + L(1)', '=>', type(ex).__name__, ex)
try:
    r = A(1) * K(1)
    print('A(1) * K(1)', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('A(1) * K(1)', '=>', type(ex).__name__, ex)
try:
    r = K(1) + A(1)
    print('K(1) + A(1)', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('K(1) + A(1)', '=>', type(ex).__name__, ex)
try:
    r = A(1) + B(1)
    print('A(1) + B(1)', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('A(1) + B(1)', '=>', type(ex).__name__, ex)
try:
    r = K(1) + L(1)
    print('K(1) + L(1)', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('K(1) + L(1)', '=>', type(ex).__name__, ex)
try:
    r = A(1)/A(5)
    print('A(1)/A(5)', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('A(1)/A(5)', '=>', type(ex).__name__, ex)
try:
    r = A(1)/B(2)
    print('A(1)/B(2)', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('A(1)/B(2)', '=>', type(ex).__name__, ex)
try:
    r = B(1)/A(2)
    print('B(1)/A(2)', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('B(1)/A(2)', '=>', type(ex).__name__, ex)
try:
    r = T + K(1)
    print('T + K(1)', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('T + K(1)', '=>', type(ex).__name__, ex)
try:
    r = T * K(1)
    print('T * K(1)', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('T * K(1)', '=>', type(ex).__name__, ex)
try:
    r = K(1) + T
    print('K(1) + T', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('K(1) + T', '=>', type(ex).__name__, ex)
try:
    r = K(1)*T
    print('K(1)*T', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('K(1)*T', '=>', type(ex).__name__, ex)
try:
    r = (T + 1) * L(2)
    print('(T + 1) * L(2)', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('(T + 1) * L(2)', '=>', type(ex).__name__, ex)
try:
    r = T + L(1)
    print('T + L(1)', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('T + L(1)', '=>', type(ex).__name__, ex)
try:
    r = T + B(1)
    print('T + B(1)', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('T + B(1)', '=>', type(ex).__name__, ex)
try:
    r = T*B(2)
    print('T*B(2)', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('T*B(2)', '=>', type(ex).__name__, ex)
try:
    r = W + A(1)
    print('W + A(1)', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('W + A(1)', '=>', type(ex).__name__, ex)
try:
    r = W * L(1)
    print('W * L(1)', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('W * L(1)', '=>', type(ex).__name__, ex)
try:
    r = T / A(2)
    print('T / A(2)', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('T / A(2)', '=>', type(ex).__name__, ex)
try:
    r = A(2) / T
    print('A(2) / T', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('A(2) / T', '=>', type(ex).__name__, ex)
try:
    r = T / A(5)
    print('T / A(5)', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('T / A(5)', '=>', type(ex).__name__, ex)
try:
    r = T / 2
    print('T / 2', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('T / 2', '=>', type(ex).__name__, ex)
try:
    r = T / 5
    print('T / 5', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('T / 5', '=>', type(ex).__name__, ex)
try:
    r = (1 + T) / A(5)
    print('(1 + T) / A(5)', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('(1 + T) / A(5)', '=>', type(ex).__name__, ex)
try:
    r = T / K(5)
    print('T / K(5)', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('T / K(5)', '=>', type(ex).__name__, ex)
try:
    r = T / B(2)
    print('T / B(2)', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('T / B(2)', '=>', type(ex).__name__, ex)
try:
    r = A(2) / (A(5) + T + O(T^4))
    print('A(2) / (A(5) + T + O(T^4))', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('A(2) / (A(5) + T + O(T^4))', '=>', type(ex).__name__, ex)
try:
    r = A(2) / (A(3) + T + O(T^4))
    print('A(2) / (A(3) + T + O(T^4))', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('A(2) / (A(3) + T + O(T^4))', '=>', type(ex).__name__, ex)
try:
    r = (A(3) + T + O(T^4))^-1
    print('(A(3) + T + O(T^4))^-1', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('(A(3) + T + O(T^4))^-1', '=>', type(ex).__name__, ex)
try:
    r = (A(5) + T + O(T^4))^-1
    print('(A(5) + T + O(T^4))^-1', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('(A(5) + T + O(T^4))^-1', '=>', type(ex).__name__, ex)
try:
    r = 1/(1 + T)
    print('1/(1 + T)', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('1/(1 + T)', '=>', type(ex).__name__, ex)
try:
    r = (A(5) + T)^-1
    print('(A(5) + T)^-1', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('(A(5) + T)^-1', '=>', type(ex).__name__, ex)
try:
    r = (A(3)+T+O(T^4)).inverse()
    print('(A(3)+T+O(T^4)).inverse()', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('(A(3)+T+O(T^4)).inverse()', '=>', type(ex).__name__, ex)
try:
    r = (A(5)+T+O(T^4)).inverse()
    print('(A(5)+T+O(T^4)).inverse()', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('(A(5)+T+O(T^4)).inverse()', '=>', type(ex).__name__, ex)
try:
    r = T/(A(3) + T + O(T^4))
    print('T/(A(3) + T + O(T^4))', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('T/(A(3) + T + O(T^4))', '=>', type(ex).__name__, ex)
try:
    r = T/(A(5) + T + O(T^4))
    print('T/(A(5) + T + O(T^4))', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('T/(A(5) + T + O(T^4))', '=>', type(ex).__name__, ex)
try:
    r = (T + O(T^3)) / K(5)
    print('(T + O(T^3)) / K(5)', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('(T + O(T^3)) / K(5)', '=>', type(ex).__name__, ex)
try:
    r = T^2 / (T + T^2)
    print('T^2 / (T + T^2)', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('T^2 / (T + T^2)', '=>', type(ex).__name__, ex)
try:
    r = (A(5)*T + T^2)^-1
    print('(A(5)*T + T^2)^-1', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('(A(5)*T + T^2)^-1', '=>', type(ex).__name__, ex)
try:
    r = 1/T
    print('1/T', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('1/T', '=>', type(ex).__name__, ex)
try:
    r = 2/(A(5)+T)
    print('2/(A(5)+T)', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('2/(A(5)+T)', '=>', type(ex).__name__, ex)
try:
    r = A(2)/(5 + T)
    print('A(2)/(5 + T)', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('A(2)/(5 + T)', '=>', type(ex).__name__, ex)
try:
    r = U + A(1)
    print('U + A(1)', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('U + A(1)', '=>', type(ex).__name__, ex)
try:
    r = U * A(1)
    print('U * A(1)', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('U * A(1)', '=>', type(ex).__name__, ex)
try:
    r = U / A(5)
    print('U / A(5)', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('U / A(5)', '=>', type(ex).__name__, ex)
try:
    r = U / B(5)
    print('U / B(5)', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('U / B(5)', '=>', type(ex).__name__, ex)
try:
    r = (K(5) + U + O(U^3))^-1
    print('(K(5) + U + O(U^3))^-1', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('(K(5) + U + O(U^3))^-1', '=>', type(ex).__name__, ex)
try:
    r = U + L(1)
    print('U + L(1)', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('U + L(1)', '=>', type(ex).__name__, ex)
try:
    r = U + B(1)
    print('U + B(1)', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('U + B(1)', '=>', type(ex).__name__, ex)
try:
    r = T/(T^2 + T^3)
    print('T/(T^2 + T^3)', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('T/(T^2 + T^3)', '=>', type(ex).__name__, ex)
try:
    r = (T*(A(3) + T))^-1
    print('(T*(A(3) + T))^-1', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('(T*(A(3) + T))^-1', '=>', type(ex).__name__, ex)
try:
    r = (T*(A(3) + T) + O(T^4))^-1
    print('(T*(A(3) + T) + O(T^4))^-1', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('(T*(A(3) + T) + O(T^4))^-1', '=>', type(ex).__name__, ex)
try:
    r = (T^2 + O(T^5))/(T + O(T^3))
    print('(T^2 + O(T^5))/(T + O(T^3))', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('(T^2 + O(T^5))/(T + O(T^3))', '=>', type(ex).__name__, ex)
try:
    r = A(1)/(T + O(T^3))
    print('A(1)/(T + O(T^3))', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('A(1)/(T + O(T^3))', '=>', type(ex).__name__, ex)
try:
    r = (A(3)+T+O(T^4))/(A(2) + T)
    print('(A(3)+T+O(T^4))/(A(2) + T)', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('(A(3)+T+O(T^4))/(A(2) + T)', '=>', type(ex).__name__, ex)
try:
    r = T + tK
    print('T + tK', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('T + tK', '=>', type(ex).__name__, ex)
try:
    r = T * tK
    print('T * tK', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('T * tK', '=>', type(ex).__name__, ex)
try:
    r = tK + T
    print('tK + T', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('tK + T', '=>', type(ex).__name__, ex)
try:
    r = T + tB
    print('T + tB', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('T + tB', '=>', type(ex).__name__, ex)
try:
    r = tB + T
    print('tB + T', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('tB + T', '=>', type(ex).__name__, ex)
try:
    r = T * tL
    print('T * tL', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('T * tL', '=>', type(ex).__name__, ex)
try:
    r = tK * tL
    print('tK * tL', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('tK * tL', '=>', type(ex).__name__, ex)
try:
    r = (1 + T + O(T^3))/(1 + tK + O(tK^3))
    print('(1 + T + O(T^3))/(1 + tK + O(tK^3))', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('(1 + T + O(T^3))/(1 + tK + O(tK^3))', '=>', type(ex).__name__, ex)
try:
    r = T/(5*T)
    print('T/(5*T)', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('T/(5*T)', '=>', type(ex).__name__, ex)
try:
    r = (5*T)/T
    print('(5*T)/T', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('(5*T)/T', '=>', type(ex).__name__, ex)
try:
    r = T^-1
    print('T^-1', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('T^-1', '=>', type(ex).__name__, ex)
try:
    r = (5 + T)/(A(5) + O(T^3))
    print('(5 + T)/(A(5) + O(T^3))', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('(5 + T)/(A(5) + O(T^3))', '=>', type(ex).__name__, ex)
try:
    r = S(1)/A(5)
    print('S(1)/A(5)', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('S(1)/A(5)', '=>', type(ex).__name__, ex)
try:
    r = S(5)/A(5)
    print('S(5)/A(5)', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('S(5)/A(5)', '=>', type(ex).__name__, ex)
try:
    r = (T + 5)/5
    print('(T + 5)/5', '=>', r.parent(), '|', r)
except (ValueError, ZeroDivisionError) as ex:
    print('(T + 5)/5', '=>', type(ex).__name__, ex)
# coefficients with several terms keep their sign inside the parentheses;
# a Laurent series parenthesizes such a constant term
x = polygen(QQ, 'x')
Kn.<an> = NumberField(x^2 - 5)
Ln.<tn> = LaurentSeriesRing(Kn)
Pn.<sn> = PowerSeriesRing(Kn)
print((-an - 1)*sn + O(sn^3), '|', 1 + (-an + 1)*sn^2, '|', tn^-1 - an - 1 + O(tn^2), '|', (an + 1) + sn + O(sn^3))
Mu.<u5> = LaurentSeriesRing(Qp(5, 3))
print(u5^-1 + Qp(5, 3)(6) + O(u5), '|', -Qp(5, 3)(6) + u5)

# Division over Zp by the ring rule shared with ZZ (review D9E-2): an exact
# monomial is inverted in Qp; any other divisor needs a unit constant term
M5.<u5r> = LaurentSeriesRing(Zp(5, 6))
try:
    r = T/(5*T + T^2)
    print('T/(5*T + T^2)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('T/(5*T + T^2)', '=>', type(ex).__name__, ex)
try:
    r = ~S(5)
    print('~S(5)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('~S(5)', '=>', type(ex).__name__, ex)
try:
    r = S(5)^-1
    print('S(5)^-1', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('S(5)^-1', '=>', type(ex).__name__, ex)
try:
    r = 1/(5*T)
    print('1/(5*T)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('1/(5*T)', '=>', type(ex).__name__, ex)
try:
    r = T/(5*T)
    print('T/(5*T)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('T/(5*T)', '=>', type(ex).__name__, ex)
try:
    r = T/(A(5)*T + O(T^3))
    print('T/(A(5)*T + O(T^3))', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('T/(A(5)*T + O(T^3))', '=>', type(ex).__name__, ex)
try:
    r = (A(5)*T + O(T^3))^-1
    print('(A(5)*T + O(T^3))^-1', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('(A(5)*T + O(T^3))^-1', '=>', type(ex).__name__, ex)
try:
    r = S(A(5))^-1
    print('S(A(5))^-1', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('S(A(5))^-1', '=>', type(ex).__name__, ex)
try:
    r = 1/S(A(5))
    print('1/S(A(5))', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('1/S(A(5))', '=>', type(ex).__name__, ex)
try:
    r = T^2/(5*T)
    print('T^2/(5*T)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('T^2/(5*T)', '=>', type(ex).__name__, ex)
try:
    r = T^2/(5*T + T^2)
    print('T^2/(5*T + T^2)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('T^2/(5*T + T^2)', '=>', type(ex).__name__, ex)
try:
    r = (5*T + T^2)^-1
    print('(5*T + T^2)^-1', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('(5*T + T^2)^-1', '=>', type(ex).__name__, ex)
try:
    r = u5r/(5*u5r)
    print('u5r/(5*u5r)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('u5r/(5*u5r)', '=>', type(ex).__name__, ex)
try:
    r = u5r/(5 + u5r)
    print('u5r/(5 + u5r)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('u5r/(5 + u5r)', '=>', type(ex).__name__, ex)
try:
    r = 1/u5r
    print('1/u5r', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('1/u5r', '=>', type(ex).__name__, ex)
try:
    r = u5r^-1
    print('u5r^-1', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('u5r^-1', '=>', type(ex).__name__, ex)
try:
    r = (3 + u5r)^-1
    print('(3 + u5r)^-1', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('(3 + u5r)^-1', '=>', type(ex).__name__, ex)
try:
    r = u5r/(3*u5r + u5r^2)
    print('u5r/(3*u5r + u5r^2)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('u5r/(3*u5r + u5r^2)', '=>', type(ex).__name__, ex)
try:
    r = (T^2 + T^3)/(T + 2*T^2)
    print('(T^2 + T^3)/(T + 2*T^2)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('(T^2 + T^3)/(T + 2*T^2)', '=>', type(ex).__name__, ex)
try:
    r = 1/(1 + T + O(T^3))
    print('1/(1 + T + O(T^3))', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('1/(1 + T + O(T^3))', '=>', type(ex).__name__, ex)
try:
    r = A(3)/(T + O(T^2))
    print('A(3)/(T + O(T^2))', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('A(3)/(T + O(T^2))', '=>', type(ex).__name__, ex)
try:
    r = T/(T + 5*T^2)
    print('T/(T + 5*T^2)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('T/(T + 5*T^2)', '=>', type(ex).__name__, ex)
