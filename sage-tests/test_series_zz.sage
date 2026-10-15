# Power and Laurent series over ZZ, as Sage: scalars outside ZZ and series
# over QQ move to QQ[[z]]; division by a scalar is over QQ; inversion needs
# a unit constant term (an exact monomial is inverted in the fraction
# field); quotients stay over ZZ when they can.
Z.<z> = ZZ[[]]
Lz.<w> = LaurentSeriesRing(ZZ)
try:
    r = 1/z
    print('1/z', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('1/z', '=>', type(ex).__name__, ex)
try:
    r = z^-1
    print('z^-1', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('z^-1', '=>', type(ex).__name__, ex)
try:
    r = ~z
    print('~z', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('~z', '=>', type(ex).__name__, ex)
try:
    r = z.inverse()
    print('z.inverse()', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('z.inverse()', '=>', type(ex).__name__, ex)
try:
    r = 1/(2 + z)
    print('1/(2 + z)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('1/(2 + z)', '=>', type(ex).__name__, ex)
try:
    r = (2 + z)^-1
    print('(2 + z)^-1', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('(2 + z)^-1', '=>', type(ex).__name__, ex)
try:
    r = (2 + z).inverse()
    print('(2 + z).inverse()', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('(2 + z).inverse()', '=>', type(ex).__name__, ex)
try:
    r = (1 + z)^-1
    print('(1 + z)^-1', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('(1 + z)^-1', '=>', type(ex).__name__, ex)
try:
    r = 1/(1 + z + O(z^4))
    print('1/(1 + z + O(z^4))', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('1/(1 + z + O(z^4))', '=>', type(ex).__name__, ex)
try:
    r = (-1 + z)^-1
    print('(-1 + z)^-1', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('(-1 + z)^-1', '=>', type(ex).__name__, ex)
try:
    r = z/2
    print('z/2', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('z/2', '=>', type(ex).__name__, ex)
try:
    r = (z + O(z^3))/2
    print('(z + O(z^3))/2', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('(z + O(z^3))/2', '=>', type(ex).__name__, ex)
try:
    r = z/(2*z)
    print('z/(2*z)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('z/(2*z)', '=>', type(ex).__name__, ex)
try:
    r = (2*z)/z
    print('(2*z)/z', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('(2*z)/z', '=>', type(ex).__name__, ex)
try:
    r = z^2/(z + z^2)
    print('z^2/(z + z^2)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('z^2/(z + z^2)', '=>', type(ex).__name__, ex)
try:
    r = z/(z^2)
    print('z/(z^2)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('z/(z^2)', '=>', type(ex).__name__, ex)
try:
    r = z/(z^2 + z^3)
    print('z/(z^2 + z^3)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('z/(z^2 + z^3)', '=>', type(ex).__name__, ex)
try:
    r = 2/(1 + z)
    print('2/(1 + z)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('2/(1 + z)', '=>', type(ex).__name__, ex)
try:
    r = 3/(2 + z)
    print('3/(2 + z)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('3/(2 + z)', '=>', type(ex).__name__, ex)
try:
    r = z*(1/2)
    print('z*(1/2)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('z*(1/2)', '=>', type(ex).__name__, ex)
try:
    r = (1/2)*z
    print('(1/2)*z', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('(1/2)*z', '=>', type(ex).__name__, ex)
try:
    r = z + 1/2
    print('z + 1/2', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('z + 1/2', '=>', type(ex).__name__, ex)
try:
    r = z/QQ(2)
    print('z/QQ(2)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('z/QQ(2)', '=>', type(ex).__name__, ex)
try:
    r = z/(-1)
    print('z/(-1)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('z/(-1)', '=>', type(ex).__name__, ex)
try:
    r = z/1
    print('z/1', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('z/1', '=>', type(ex).__name__, ex)
try:
    r = (1 + z)/(1 - z)
    print('(1 + z)/(1 - z)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('(1 + z)/(1 - z)', '=>', type(ex).__name__, ex)
try:
    r = (2 + z)/(2 + z)
    print('(2 + z)/(2 + z)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('(2 + z)/(2 + z)', '=>', type(ex).__name__, ex)
try:
    r = (2*z + O(z^3))/(2 + O(z^2))
    print('(2*z + O(z^3))/(2 + O(z^2))', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('(2*z + O(z^3))/(2 + O(z^2))', '=>', type(ex).__name__, ex)
try:
    r = z/(2 + z)
    print('z/(2 + z)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('z/(2 + z)', '=>', type(ex).__name__, ex)
try:
    r = (1 + z)^(-2)
    print('(1 + z)^(-2)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('(1 + z)^(-2)', '=>', type(ex).__name__, ex)
try:
    r = (2 + z)^-2
    print('(2 + z)^-2', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('(2 + z)^-2', '=>', type(ex).__name__, ex)
try:
    r = z^-2
    print('z^-2', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('z^-2', '=>', type(ex).__name__, ex)
try:
    r = (4 + 4*z)/2
    print('(4 + 4*z)/2', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('(4 + 4*z)/2', '=>', type(ex).__name__, ex)
try:
    r = Lz(1)/(2 + Lz.gen())
    print('Lz(1)/(2 + Lz.gen())', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('Lz(1)/(2 + Lz.gen())', '=>', type(ex).__name__, ex)
try:
    r = Lz.gen()/2
    print('Lz.gen()/2', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('Lz.gen()/2', '=>', type(ex).__name__, ex)
try:
    r = 1/Lz.gen()
    print('1/Lz.gen()', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('1/Lz.gen()', '=>', type(ex).__name__, ex)
try:
    r = (2*z^2 + O(z^5))/(z + O(z^3))
    print('(2*z^2 + O(z^5))/(z + O(z^3))', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('(2*z^2 + O(z^5))/(z + O(z^3))', '=>', type(ex).__name__, ex)
try:
    r = z/(2*z + z^2)
    print('z/(2*z + z^2)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('z/(2*z + z^2)', '=>', type(ex).__name__, ex)
try:
    r = ~Z(2)
    print('~Z(2)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('~Z(2)', '=>', type(ex).__name__, ex)
try:
    r = Z(2)^-1
    print('Z(2)^-1', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('Z(2)^-1', '=>', type(ex).__name__, ex)
try:
    r = 1/(2*z)
    print('1/(2*z)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('1/(2*z)', '=>', type(ex).__name__, ex)
try:
    r = 1/Z(2)
    print('1/Z(2)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('1/Z(2)', '=>', type(ex).__name__, ex)
try:
    r = 3/(2*z)
    print('3/(2*z)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('3/(2*z)', '=>', type(ex).__name__, ex)
try:
    r = (2 + O(z^3))^-1
    print('(2 + O(z^3))^-1', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('(2 + O(z^3))^-1', '=>', type(ex).__name__, ex)
try:
    r = 1/(2*z + O(z^3))
    print('1/(2*z + O(z^3))', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('1/(2*z + O(z^3))', '=>', type(ex).__name__, ex)
try:
    r = z/(2*z + O(z^3))
    print('z/(2*z + O(z^3))', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('z/(2*z + O(z^3))', '=>', type(ex).__name__, ex)
try:
    r = z/(2*z^2 + z^3)
    print('z/(2*z^2 + z^3)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('z/(2*z^2 + z^3)', '=>', type(ex).__name__, ex)
try:
    r = z^2/(2*z)
    print('z^2/(2*z)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('z^2/(2*z)', '=>', type(ex).__name__, ex)
try:
    r = Lz.gen()/(2*Lz.gen())
    print('Lz.gen()/(2*Lz.gen())', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('Lz.gen()/(2*Lz.gen())', '=>', type(ex).__name__, ex)
try:
    r = Lz.gen()^-3
    print('Lz.gen()^-3', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('Lz.gen()^-3', '=>', type(ex).__name__, ex)
try:
    r = Z(-1)^-1
    print('Z(-1)^-1', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('Z(-1)^-1', '=>', type(ex).__name__, ex)
try:
    r = ~(-z)
    print('~(-z)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('~(-z)', '=>', type(ex).__name__, ex)
try:
    r = z/(-z)
    print('z/(-z)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('z/(-z)', '=>', type(ex).__name__, ex)
try:
    r = z + QQ[["z"]].gen()
    print('z + QQ[["z"]].gen()', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('z + QQ[["z"]].gen()', '=>', type(ex).__name__, ex)
try:
    r = QQ[["z"]].gen() * z
    print('QQ[["z"]].gen() * z', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('QQ[["z"]].gen() * z', '=>', type(ex).__name__, ex)
try:
    r = (1/2 + z)/(1 + z)
    print('(1/2 + z)/(1 + z)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError) as ex:
    print('(1/2 + z)/(1 + z)', '=>', type(ex).__name__, ex)

# Laurent division, Laurent divisors, exact zeros and mismatched variables
# (review D46): exact coefficient division in a Laurent ring; a Laurent
# divisor gives a Laurent quotient; 0 over a valid divisor stays exact;
# series in different variables do not meet
P = Z
L = Lz
w = L.gen()
LQ = LaurentSeriesRing(QQ, 'z')
Q.<t> = QQ[[]]
T2 = PowerSeriesRing(ZZ, 's').gen()
Lz2 = LaurentSeriesRing(ZZ, 'z')
try:
    r = (2*w) / L(2)
    print('(2*w) / L(2)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print('(2*w) / L(2)', '=>', type(ex).__name__, ex)
try:
    r = (2*w) / (2*w)
    print('(2*w) / (2*w)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print('(2*w) / (2*w)', '=>', type(ex).__name__, ex)
try:
    r = (4*w) / (2*z)
    print('(4*w) / (2*z)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print('(4*w) / (2*z)', '=>', type(ex).__name__, ex)
try:
    r = w / (2*w)
    print('w / (2*w)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print('w / (2*w)', '=>', type(ex).__name__, ex)
try:
    r = (3*w)/L(2)
    print('(3*w)/L(2)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print('(3*w)/L(2)', '=>', type(ex).__name__, ex)
try:
    r = (2*w + 4*w^2)/L(2)
    print('(2*w + 4*w^2)/L(2)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print('(2*w + 4*w^2)/L(2)', '=>', type(ex).__name__, ex)
try:
    r = (2*w + 3*w^2)/L(2)
    print('(2*w + 3*w^2)/L(2)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print('(2*w + 3*w^2)/L(2)', '=>', type(ex).__name__, ex)
try:
    r = (2*w + O(w^3))/L(2)
    print('(2*w + O(w^3))/L(2)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print('(2*w + O(w^3))/L(2)', '=>', type(ex).__name__, ex)
try:
    r = (6*w^-1)/(3*w)
    print('(6*w^-1)/(3*w)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print('(6*w^-1)/(3*w)', '=>', type(ex).__name__, ex)
try:
    r = z/L(1)
    print('z/L(1)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print('z/L(1)', '=>', type(ex).__name__, ex)
try:
    r = z/w
    print('z/w', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print('z/w', '=>', type(ex).__name__, ex)
try:
    r = z/(w^-1)
    print('z/(w^-1)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print('z/(w^-1)', '=>', type(ex).__name__, ex)
try:
    r = z/LQ(1)
    print('z/LQ(1)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print('z/LQ(1)', '=>', type(ex).__name__, ex)
try:
    r = z/(2*w)
    print('z/(2*w)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print('z/(2*w)', '=>', type(ex).__name__, ex)
try:
    r = z/(w + w^2)
    print('z/(w + w^2)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print('z/(w + w^2)', '=>', type(ex).__name__, ex)
try:
    r = (2*z)/(2*w)
    print('(2*z)/(2*w)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print('(2*z)/(2*w)', '=>', type(ex).__name__, ex)
try:
    r = z/(2 + w)
    print('z/(2 + w)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print('z/(2 + w)', '=>', type(ex).__name__, ex)
try:
    r = Z(0)/(1 + z)
    print('Z(0)/(1 + z)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print('Z(0)/(1 + z)', '=>', type(ex).__name__, ex)
try:
    r = Z(0)/Z(1).add_bigoh(3)
    print('Z(0)/Z(1).add_bigoh(3)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print('Z(0)/Z(1).add_bigoh(3)', '=>', type(ex).__name__, ex)
try:
    r = Z(0)/(2 + z)
    print('Z(0)/(2 + z)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print('Z(0)/(2 + z)', '=>', type(ex).__name__, ex)
try:
    r = Z(0)/(2*z)
    print('Z(0)/(2*z)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print('Z(0)/(2*z)', '=>', type(ex).__name__, ex)
try:
    r = Z(0)/z
    print('Z(0)/z', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print('Z(0)/z', '=>', type(ex).__name__, ex)
try:
    r = Q(0)/(1 + t)
    print('Q(0)/(1 + t)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print('Q(0)/(1 + t)', '=>', type(ex).__name__, ex)
try:
    r = L(0)/(1 + w)
    print('L(0)/(1 + w)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print('L(0)/(1 + w)', '=>', type(ex).__name__, ex)
try:
    r = L(0)/(2*w)
    print('L(0)/(2*w)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print('L(0)/(2*w)', '=>', type(ex).__name__, ex)
try:
    r = Z(0)/(1 + z + O(z^3))
    print('Z(0)/(1 + z + O(z^3))', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print('Z(0)/(1 + z + O(z^3))', '=>', type(ex).__name__, ex)
try:
    r = (O(z^3))/(1 + z)
    print('(O(z^3))/(1 + z)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print('(O(z^3))/(1 + z)', '=>', type(ex).__name__, ex)
try:
    r = z + (1/2 + t)
    print('z + (1/2 + t)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print('z + (1/2 + t)', '=>', type(ex).__name__, ex)
try:
    r = z * (1/2 + t)
    print('z * (1/2 + t)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print('z * (1/2 + t)', '=>', type(ex).__name__, ex)
try:
    r = z / (1/2 + t)
    print('z / (1/2 + t)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print('z / (1/2 + t)', '=>', type(ex).__name__, ex)
try:
    r = (1/2 + t) + z
    print('(1/2 + t) + z', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print('(1/2 + t) + z', '=>', type(ex).__name__, ex)
try:
    r = z + Q(1)
    print('z + Q(1)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print('z + Q(1)', '=>', type(ex).__name__, ex)
try:
    r = z + T2
    print('z + T2', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print('z + T2', '=>', type(ex).__name__, ex)
try:
    r = z * T2
    print('z * T2', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print('z * T2', '=>', type(ex).__name__, ex)
try:
    r = z - T2
    print('z - T2', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print('z - T2', '=>', type(ex).__name__, ex)
try:
    r = T2 - z
    print('T2 - z', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print('T2 - z', '=>', type(ex).__name__, ex)
try:
    r = z/T2
    print('z/T2', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print('z/T2', '=>', type(ex).__name__, ex)
try:
    r = z/Lz2(1)
    print('z/Lz2(1)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print('z/Lz2(1)', '=>', type(ex).__name__, ex)
try:
    r = z/Lz2.gen()
    print('z/Lz2.gen()', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print('z/Lz2.gen()', '=>', type(ex).__name__, ex)
try:
    r = z/(Lz2.gen()^-1)
    print('z/(Lz2.gen()^-1)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print('z/(Lz2.gen()^-1)', '=>', type(ex).__name__, ex)
try:
    r = (2*z)/(2*Lz2.gen())
    print('(2*z)/(2*Lz2.gen())', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print('(2*z)/(2*Lz2.gen())', '=>', type(ex).__name__, ex)
try:
    r = z/(2*Lz2.gen())
    print('z/(2*Lz2.gen())', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print('z/(2*Lz2.gen())', '=>', type(ex).__name__, ex)

# A power series and a Laurent series, in either order, over ZZ and QQ:
# Sage takes the common base and a Laurent parent (review CORR-078-1)
P = PowerSeriesRing(QQ, 'z'); L = LaurentSeriesRing(ZZ, 'z'); q = P.gen(); w = L.gen()
try:
    r = q/L(1)
    print(0, 'q/L(1)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(0, 'q/L(1)', '=>', type(ex).__name__, ex)
try:
    r = q/L(2)
    print(0, 'q/L(2)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(0, 'q/L(2)', '=>', type(ex).__name__, ex)
try:
    r = q + L(1)
    print(0, 'q + L(1)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(0, 'q + L(1)', '=>', type(ex).__name__, ex)
try:
    r = q - L(1)
    print(0, 'q - L(1)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(0, 'q - L(1)', '=>', type(ex).__name__, ex)
try:
    r = q * L(1)
    print(0, 'q * L(1)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(0, 'q * L(1)', '=>', type(ex).__name__, ex)
try:
    r = P(1) + w^-1
    print(0, 'P(1) + w^-1', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(0, 'P(1) + w^-1', '=>', type(ex).__name__, ex)
try:
    r = P(1) * w^-1
    print(0, 'P(1) * w^-1', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(0, 'P(1) * w^-1', '=>', type(ex).__name__, ex)
try:
    r = P(1) / w^-1
    print(0, 'P(1) / w^-1', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(0, 'P(1) / w^-1', '=>', type(ex).__name__, ex)
try:
    r = L(1)/q
    print(0, 'L(1)/q', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(0, 'L(1)/q', '=>', type(ex).__name__, ex)
try:
    r = L(1) + q
    print(0, 'L(1) + q', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(0, 'L(1) + q', '=>', type(ex).__name__, ex)
try:
    r = L(1) - q
    print(0, 'L(1) - q', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(0, 'L(1) - q', '=>', type(ex).__name__, ex)
try:
    r = L(1) * q
    print(0, 'L(1) * q', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(0, 'L(1) * q', '=>', type(ex).__name__, ex)
try:
    r = w^-1 + P(1)
    print(0, 'w^-1 + P(1)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(0, 'w^-1 + P(1)', '=>', type(ex).__name__, ex)
try:
    r = w^-1 * P(1)
    print(0, 'w^-1 * P(1)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(0, 'w^-1 * P(1)', '=>', type(ex).__name__, ex)
try:
    r = w^-1 / P(1)
    print(0, 'w^-1 / P(1)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(0, 'w^-1 / P(1)', '=>', type(ex).__name__, ex)
try:
    r = w^-1 - q
    print(0, 'w^-1 - q', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(0, 'w^-1 - q', '=>', type(ex).__name__, ex)
try:
    r = (1 + q)/(1 + w)
    print(0, '(1 + q)/(1 + w)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(0, '(1 + q)/(1 + w)', '=>', type(ex).__name__, ex)
try:
    r = (1 + w)/(1 + q)
    print(0, '(1 + w)/(1 + q)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(0, '(1 + w)/(1 + q)', '=>', type(ex).__name__, ex)
try:
    r = q/(2*w)
    print(0, 'q/(2*w)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(0, 'q/(2*w)', '=>', type(ex).__name__, ex)
try:
    r = w/(2*q)
    print(0, 'w/(2*q)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(0, 'w/(2*q)', '=>', type(ex).__name__, ex)
try:
    r = (2*w)/q
    print(0, '(2*w)/q', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(0, '(2*w)/q', '=>', type(ex).__name__, ex)
try:
    r = P(1)/w
    print(0, 'P(1)/w', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(0, 'P(1)/w', '=>', type(ex).__name__, ex)
P = PowerSeriesRing(ZZ, 'z'); L = LaurentSeriesRing(QQ, 'z'); q = P.gen(); w = L.gen()
try:
    r = q/L(1)
    print(1, 'q/L(1)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(1, 'q/L(1)', '=>', type(ex).__name__, ex)
try:
    r = q/L(2)
    print(1, 'q/L(2)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(1, 'q/L(2)', '=>', type(ex).__name__, ex)
try:
    r = q + L(1)
    print(1, 'q + L(1)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(1, 'q + L(1)', '=>', type(ex).__name__, ex)
try:
    r = q - L(1)
    print(1, 'q - L(1)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(1, 'q - L(1)', '=>', type(ex).__name__, ex)
try:
    r = q * L(1)
    print(1, 'q * L(1)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(1, 'q * L(1)', '=>', type(ex).__name__, ex)
try:
    r = P(1) + w^-1
    print(1, 'P(1) + w^-1', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(1, 'P(1) + w^-1', '=>', type(ex).__name__, ex)
try:
    r = P(1) * w^-1
    print(1, 'P(1) * w^-1', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(1, 'P(1) * w^-1', '=>', type(ex).__name__, ex)
try:
    r = P(1) / w^-1
    print(1, 'P(1) / w^-1', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(1, 'P(1) / w^-1', '=>', type(ex).__name__, ex)
try:
    r = L(1)/q
    print(1, 'L(1)/q', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(1, 'L(1)/q', '=>', type(ex).__name__, ex)
try:
    r = L(1) + q
    print(1, 'L(1) + q', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(1, 'L(1) + q', '=>', type(ex).__name__, ex)
try:
    r = L(1) - q
    print(1, 'L(1) - q', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(1, 'L(1) - q', '=>', type(ex).__name__, ex)
try:
    r = L(1) * q
    print(1, 'L(1) * q', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(1, 'L(1) * q', '=>', type(ex).__name__, ex)
try:
    r = w^-1 + P(1)
    print(1, 'w^-1 + P(1)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(1, 'w^-1 + P(1)', '=>', type(ex).__name__, ex)
try:
    r = w^-1 * P(1)
    print(1, 'w^-1 * P(1)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(1, 'w^-1 * P(1)', '=>', type(ex).__name__, ex)
try:
    r = w^-1 / P(1)
    print(1, 'w^-1 / P(1)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(1, 'w^-1 / P(1)', '=>', type(ex).__name__, ex)
try:
    r = w^-1 - q
    print(1, 'w^-1 - q', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(1, 'w^-1 - q', '=>', type(ex).__name__, ex)
try:
    r = (1 + q)/(1 + w)
    print(1, '(1 + q)/(1 + w)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(1, '(1 + q)/(1 + w)', '=>', type(ex).__name__, ex)
try:
    r = (1 + w)/(1 + q)
    print(1, '(1 + w)/(1 + q)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(1, '(1 + w)/(1 + q)', '=>', type(ex).__name__, ex)
try:
    r = q/(2*w)
    print(1, 'q/(2*w)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(1, 'q/(2*w)', '=>', type(ex).__name__, ex)
try:
    r = w/(2*q)
    print(1, 'w/(2*q)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(1, 'w/(2*q)', '=>', type(ex).__name__, ex)
try:
    r = (2*w)/q
    print(1, '(2*w)/q', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(1, '(2*w)/q', '=>', type(ex).__name__, ex)
try:
    r = P(1)/w
    print(1, 'P(1)/w', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(1, 'P(1)/w', '=>', type(ex).__name__, ex)
P = PowerSeriesRing(ZZ, 'z'); L = LaurentSeriesRing(ZZ, 'z'); q = P.gen(); w = L.gen()
try:
    r = q/L(1)
    print(2, 'q/L(1)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(2, 'q/L(1)', '=>', type(ex).__name__, ex)
try:
    r = q/L(2)
    print(2, 'q/L(2)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(2, 'q/L(2)', '=>', type(ex).__name__, ex)
try:
    r = q + L(1)
    print(2, 'q + L(1)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(2, 'q + L(1)', '=>', type(ex).__name__, ex)
try:
    r = q - L(1)
    print(2, 'q - L(1)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(2, 'q - L(1)', '=>', type(ex).__name__, ex)
try:
    r = q * L(1)
    print(2, 'q * L(1)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(2, 'q * L(1)', '=>', type(ex).__name__, ex)
try:
    r = P(1) + w^-1
    print(2, 'P(1) + w^-1', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(2, 'P(1) + w^-1', '=>', type(ex).__name__, ex)
try:
    r = P(1) * w^-1
    print(2, 'P(1) * w^-1', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(2, 'P(1) * w^-1', '=>', type(ex).__name__, ex)
try:
    r = P(1) / w^-1
    print(2, 'P(1) / w^-1', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(2, 'P(1) / w^-1', '=>', type(ex).__name__, ex)
try:
    r = L(1)/q
    print(2, 'L(1)/q', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(2, 'L(1)/q', '=>', type(ex).__name__, ex)
try:
    r = L(1) + q
    print(2, 'L(1) + q', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(2, 'L(1) + q', '=>', type(ex).__name__, ex)
try:
    r = L(1) - q
    print(2, 'L(1) - q', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(2, 'L(1) - q', '=>', type(ex).__name__, ex)
try:
    r = L(1) * q
    print(2, 'L(1) * q', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(2, 'L(1) * q', '=>', type(ex).__name__, ex)
try:
    r = w^-1 + P(1)
    print(2, 'w^-1 + P(1)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(2, 'w^-1 + P(1)', '=>', type(ex).__name__, ex)
try:
    r = w^-1 * P(1)
    print(2, 'w^-1 * P(1)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(2, 'w^-1 * P(1)', '=>', type(ex).__name__, ex)
try:
    r = w^-1 / P(1)
    print(2, 'w^-1 / P(1)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(2, 'w^-1 / P(1)', '=>', type(ex).__name__, ex)
try:
    r = w^-1 - q
    print(2, 'w^-1 - q', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(2, 'w^-1 - q', '=>', type(ex).__name__, ex)
try:
    r = (1 + q)/(1 + w)
    print(2, '(1 + q)/(1 + w)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(2, '(1 + q)/(1 + w)', '=>', type(ex).__name__, ex)
try:
    r = (1 + w)/(1 + q)
    print(2, '(1 + w)/(1 + q)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(2, '(1 + w)/(1 + q)', '=>', type(ex).__name__, ex)
try:
    r = q/(2*w)
    print(2, 'q/(2*w)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(2, 'q/(2*w)', '=>', type(ex).__name__, ex)
try:
    r = w/(2*q)
    print(2, 'w/(2*q)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(2, 'w/(2*q)', '=>', type(ex).__name__, ex)
try:
    r = (2*w)/q
    print(2, '(2*w)/q', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(2, '(2*w)/q', '=>', type(ex).__name__, ex)
try:
    r = P(1)/w
    print(2, 'P(1)/w', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(2, 'P(1)/w', '=>', type(ex).__name__, ex)
P = PowerSeriesRing(QQ, 'z'); L = LaurentSeriesRing(QQ, 'z'); q = P.gen(); w = L.gen()
try:
    r = q/L(1)
    print(3, 'q/L(1)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(3, 'q/L(1)', '=>', type(ex).__name__, ex)
try:
    r = q/L(2)
    print(3, 'q/L(2)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(3, 'q/L(2)', '=>', type(ex).__name__, ex)
try:
    r = q + L(1)
    print(3, 'q + L(1)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(3, 'q + L(1)', '=>', type(ex).__name__, ex)
try:
    r = q - L(1)
    print(3, 'q - L(1)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(3, 'q - L(1)', '=>', type(ex).__name__, ex)
try:
    r = q * L(1)
    print(3, 'q * L(1)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(3, 'q * L(1)', '=>', type(ex).__name__, ex)
try:
    r = P(1) + w^-1
    print(3, 'P(1) + w^-1', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(3, 'P(1) + w^-1', '=>', type(ex).__name__, ex)
try:
    r = P(1) * w^-1
    print(3, 'P(1) * w^-1', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(3, 'P(1) * w^-1', '=>', type(ex).__name__, ex)
try:
    r = P(1) / w^-1
    print(3, 'P(1) / w^-1', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(3, 'P(1) / w^-1', '=>', type(ex).__name__, ex)
try:
    r = L(1)/q
    print(3, 'L(1)/q', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(3, 'L(1)/q', '=>', type(ex).__name__, ex)
try:
    r = L(1) + q
    print(3, 'L(1) + q', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(3, 'L(1) + q', '=>', type(ex).__name__, ex)
try:
    r = L(1) - q
    print(3, 'L(1) - q', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(3, 'L(1) - q', '=>', type(ex).__name__, ex)
try:
    r = L(1) * q
    print(3, 'L(1) * q', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(3, 'L(1) * q', '=>', type(ex).__name__, ex)
try:
    r = w^-1 + P(1)
    print(3, 'w^-1 + P(1)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(3, 'w^-1 + P(1)', '=>', type(ex).__name__, ex)
try:
    r = w^-1 * P(1)
    print(3, 'w^-1 * P(1)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(3, 'w^-1 * P(1)', '=>', type(ex).__name__, ex)
try:
    r = w^-1 / P(1)
    print(3, 'w^-1 / P(1)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(3, 'w^-1 / P(1)', '=>', type(ex).__name__, ex)
try:
    r = w^-1 - q
    print(3, 'w^-1 - q', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(3, 'w^-1 - q', '=>', type(ex).__name__, ex)
try:
    r = (1 + q)/(1 + w)
    print(3, '(1 + q)/(1 + w)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(3, '(1 + q)/(1 + w)', '=>', type(ex).__name__, ex)
try:
    r = (1 + w)/(1 + q)
    print(3, '(1 + w)/(1 + q)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(3, '(1 + w)/(1 + q)', '=>', type(ex).__name__, ex)
try:
    r = q/(2*w)
    print(3, 'q/(2*w)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(3, 'q/(2*w)', '=>', type(ex).__name__, ex)
try:
    r = w/(2*q)
    print(3, 'w/(2*q)', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(3, 'w/(2*q)', '=>', type(ex).__name__, ex)
try:
    r = (2*w)/q
    print(3, '(2*w)/q', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(3, '(2*w)/q', '=>', type(ex).__name__, ex)
try:
    r = P(1)/w
    print(3, 'P(1)/w', '=>', r.parent(), '|', r)
except (ValueError, ArithmeticError, ZeroDivisionError, TypeError) as ex:
    print(3, 'P(1)/w', '=>', type(ex).__name__, ex)
