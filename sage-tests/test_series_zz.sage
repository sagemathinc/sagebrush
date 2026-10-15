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
