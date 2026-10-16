# Rational %, //, divmod, ord, is_perfect_power and is_prime on QQ, as Sage
# (the sagebook, p. 120: the Chinese remainder example gave 3, not 17)
import warnings; warnings.simplefilter('ignore')
try:
    print('(1/5) % 7', '->', (1/5) % 7)
except Exception as e:
    print('(1/5) % 7', '!!', type(e).__name__, e)

try:
    print('(-1/5) % 7', '->', (-1/5) % 7)
except Exception as e:
    print('(-1/5) % 7', '!!', type(e).__name__, e)

try:
    print('(3/5) % 10', '->', (3/5) % 10)
except Exception as e:
    print('(3/5) % 10', '!!', type(e).__name__, e)

try:
    print('(2/3) % 9', '->', (2/3) % 9)
except Exception as e:
    print('(2/3) % 9', '!!', type(e).__name__, e)

try:
    print('(1/2) % (1/3)', '->', (1/2) % (1/3))
except Exception as e:
    print('(1/2) % (1/3)', '!!', type(e).__name__, e)

try:
    print('(7/2) % 2', '->', (7/2) % 2)
except Exception as e:
    print('(7/2) % 2', '!!', type(e).__name__, e)

try:
    print('7 % (1/2)', '->', 7 % (1/2))
except Exception as e:
    print('7 % (1/2)', '!!', type(e).__name__, e)

try:
    print('(5/1) % 3', '->', (5/1) % 3)
except Exception as e:
    print('(5/1) % 3', '!!', type(e).__name__, e)

try:
    print('(1/5) % -7', '->', (1/5) % -7)
except Exception as e:
    print('(1/5) % -7', '!!', type(e).__name__, e)

try:
    print('(1/5) % 0', '->', (1/5) % 0)
except Exception as e:
    print('(1/5) % 0', '!!', type(e).__name__, e)

try:
    print('(4/6) % 5', '->', (4/6) % 5)
except Exception as e:
    print('(4/6) % 5', '!!', type(e).__name__, e)

try:
    print('(1/3) % 3', '->', (1/3) % 3)
except Exception as e:
    print('(1/3) % 3', '!!', type(e).__name__, e)

try:
    print('(10/1) % 4', '->', (10/1) % 4)
except Exception as e:
    print('(10/1) % 4', '!!', type(e).__name__, e)

try:
    print('(7/2) % 1', '->', (7/2) % 1)
except Exception as e:
    print('(7/2) % 1', '!!', type(e).__name__, e)

try:
    print('(0/1) % 5', '->', (0/1) % 5)
except Exception as e:
    print('(0/1) % 5', '!!', type(e).__name__, e)

try:
    print('(5/2) % -3', '->', (5/2) % -3)
except Exception as e:
    print('(5/2) % -3', '!!', type(e).__name__, e)

try:
    print('(-7/2) % 3', '->', (-7/2) % 3)
except Exception as e:
    print('(-7/2) % 3', '!!', type(e).__name__, e)

try:
    print('(1/2) % 2.0', '->', (1/2) % 2.0)
except Exception as e:
    print('(1/2) % 2.0', '!!', type(e).__name__, e)

try:
    print('(7/2) % 1.5', '->', (7/2) % 1.5)
except Exception as e:
    print('(7/2) % 1.5', '!!', type(e).__name__, e)

try:
    print('(5/1) % (3/1)', '->', (5/1) % (3/1))
except Exception as e:
    print('(5/1) % (3/1)', '!!', type(e).__name__, e)

try:
    print('(1/5) % (7/1)', '->', (1/5) % (7/1))
except Exception as e:
    print('(1/5) % (7/1)', '!!', type(e).__name__, e)

try:
    print('7 % (7/1)', '->', 7 % (7/1))
except Exception as e:
    print('7 % (7/1)', '!!', type(e).__name__, e)

try:
    print('(6/3) // 4', '->', (6/3) // 4)
except Exception as e:
    print('(6/3) // 4', '!!', type(e).__name__, e)

try:
    print('(7/2) // 1', '->', (7/2) // 1)
except Exception as e:
    print('(7/2) // 1', '!!', type(e).__name__, e)

try:
    print('(6/3) // (1/3)', '->', (6/3) // (1/3))
except Exception as e:
    print('(6/3) // (1/3)', '!!', type(e).__name__, e)

try:
    print('7 // (2/3)', '->', 7 // (2/3))
except Exception as e:
    print('7 // (2/3)', '!!', type(e).__name__, e)

try:
    print('(7/2) // 0', '->', (7/2) // 0)
except Exception as e:
    print('(7/2) // 0', '!!', type(e).__name__, e)

try:
    print('(7/2) // -2', '->', (7/2) // -2)
except Exception as e:
    print('(7/2) // -2', '!!', type(e).__name__, e)

try:
    print('divmod(7/2, 1)', '->', divmod(7/2, 1))
except Exception as e:
    print('divmod(7/2, 1)', '!!', type(e).__name__, e)

try:
    print('divmod(7, 1/2)', '->', divmod(7, 1/2))
except Exception as e:
    print('divmod(7, 1/2)', '!!', type(e).__name__, e)

try:
    print('divmod(7/2, 1/3)', '->', divmod(7/2, 1/3))
except Exception as e:
    print('divmod(7/2, 1/3)', '!!', type(e).__name__, e)

try:
    print('(12/1).ord(2)', '->', (12/1).ord(2))
except Exception as e:
    print('(12/1).ord(2)', '!!', type(e).__name__, e)

try:
    print('(3/8).ord(2)', '->', (3/8).ord(2))
except Exception as e:
    print('(3/8).ord(2)', '!!', type(e).__name__, e)

try:
    print('[q.is_perfect_power() for q in [4/9, -8/27, 1/1, 0/1, 2/1, 1/4, -1/1, 8/3, -4/9]]', '->', [q.is_perfect_power() for q in [4/9, -8/27, 1/1, 0/1, 2/1, 1/4, -1/1, 8/3, -4/9]])
except Exception as e:
    print('[q.is_perfect_power() for q in [4/9, -8/27, 1/1, 0/1, 2/1, 1/4, -1/1, 8/3, -4/9]]', '!!', type(e).__name__, e)

try:
    print('is_prime(6/3)', '->', is_prime(6/3))
except Exception as e:
    print('is_prime(6/3)', '!!', type(e).__name__, e)

try:
    print('is_prime(7/2)', '->', is_prime(7/2))
except Exception as e:
    print('is_prime(7/2)', '!!', type(e).__name__, e)

try:
    print('(6/3).is_prime()', '->', (6/3).is_prime())
except Exception as e:
    print('(6/3).is_prime()', '!!', type(e).__name__, e)

try:
    print('(6/3).is_unit()', '->', (6/3).is_unit())
except Exception as e:
    print('(6/3).is_unit()', '!!', type(e).__name__, e)

try:
    print('(0/1).is_unit()', '->', (0/1).is_unit())
except Exception as e:
    print('(0/1).is_unit()', '!!', type(e).__name__, e)

a = 2; b = 3; m = 5; n = 7; lambda0 = (b-a)/m % n; print('crt ->', a + lambda0 * m)

# mixed operands (astra's probes on 08b6327f): bools are integers, a Python
# float floors as a float, RDF divides, RR has no //, and divmod converts the
# other operand exactly to QQ, with a Python int 0 as the remainder
def mixed(label, f):
    try:
        v = f()
        print(label, '->', v)
    except Exception as e:
        print(label, '!!', (type(e).__name__ + ' ' + str(e)).rstrip())
qs = [('7/2', 7/2), ('4/2', 4/2), ('-7/2', -7/2)]
xs = [('True', True), ('False', False), ('float(2)', float(2)), ('float(1.5)', float(1.5)), ('float(-3)', float(-3)), ('RR(2)', RR(2)), ('RR(1.5)', RR(1.5)), ('RDF(2)', RDF(2)), ('RDF(1.5)', RDF(1.5)), ('RealField(100)(2)', RealField(100)(2)), ('inf', float('inf'))]
for qn, q in qs:
    for xn, x in xs:
        mixed('%s %% %s' % (qn, xn), lambda: q % x)
        mixed('%s %% %s' % (xn, qn), lambda: x % q)
        mixed('%s // %s' % (qn, xn), lambda: q // x)
        mixed('%s // %s' % (xn, qn), lambda: x // q)
        mixed('divmod(%s, %s)' % (qn, xn), lambda: (divmod(q, x), type(divmod(q, x)[1]) is int))
        mixed('divmod(%s, %s)' % (xn, qn), lambda: divmod(x, q))
mixed('RR(7) % (2/1)', lambda: RR(7) % (2/1))
mixed('RR(1) % (1/3)', lambda: RR(1) % (1/3))
mixed('RealField(100)(1) % (1/3)', lambda: RealField(100)(1) % (1/3))
mixed('RR(5) % (0/1)', lambda: RR(5) % (0/1))
mixed('5 % (0/1)', lambda: 5 % (0/1))
mixed('divmod(5, 0/1)', lambda: divmod(5, 0/1))
mixed('divmod(2, 7/2)', lambda: divmod(2, 7/2))
mixed('divmod(RR(2), 0/1)', lambda: divmod(RR(2), 0/1))
mixed('divmod(4/2, RR(0))', lambda: divmod(4/2, RR(0)))
mixed('divmod(7/2, RealField(100)(1) + 2^-70)', lambda: divmod(7/2, RealField(100)(1) + RealField(100)(2)^-70))
mixed('(7/2) % (RealField(100)(1) + 2^-70)', lambda: (7/2) % (RealField(100)(1) + RealField(100)(2)^-70))
mixed('(7/2) % GF(5)(2)', lambda: (7/2) % GF(5)(2))
mixed('(4/2) % GF(5)(2)', lambda: (4/2) % GF(5)(2))
mixed('(4/2) % SR(2)', lambda: (4/2) % SR(2))
mixed('divmod(7/2, GF(5)(2))', lambda: divmod(7/2, GF(5)(2)))
mixed('divmod(7/2, SR(2))', lambda: divmod(7/2, SR(2)))
# divmod takes an RR, RealField(p) or RDF number as the simplest rational
# that rounds to it (1/10 for RR(0.1)); a float exactly
for xn, x in [('RR(0.1)', RR(0.1)), ('RDF(0.1)', RDF(0.1)), ('RealField(100)(0.1)', RealField(100)(0.1)), ('RealField(20)(0.1)', RealField(20)(0.1)), ('RR(pi)', RR(pi)), ('RDF(exp(1))', RDF(exp(1))), ('RR(1e300)', RR(1e300)), ('RealField(20)(2^53 + 1)', RealField(20)(2^53 + 1)), ('RR(-1/3)', RR(-1/3)), ('float(0.1)', float(0.1)), ('float(1/3)', float(1/3))]:
    mixed('divmod(1/1, %s)' % xn, lambda: divmod(1/1, x))
# a real number in divmod is the simplest rational in its field's own
# rounding interval, for every rounding mode and both signs (astra's
# CORR-F2B-2); a float in x % q is taken the same way (CORR-F2B-1)
for rnd in ['RNDN', 'RNDD', 'RNDU', 'RNDZ', 'RNDA']:
    for prec in [2, 3, 10]:
        R = RealField(prec, rnd=rnd)
        out = []
        for v in [5/12, 7/12, 1/10, 7/10, 1/3, 22/7]:
            for s in [1, -1]:
                out.append(divmod(1/1, R(s*v))[0])
        print(rnd, prec, out)
for xn, x in [('float(0.1)', float(0.1)), ('float(0.2)', float(0.2)), ('float(-0.1)', float(-0.1)), ('float(2.5)', float(2.5)), ('float(1.1)', float(1.1))]:
    for q in [3, 5, 7]:
        mixed('%s %% %s' % (xn, q), lambda: x % (q/1))
        mixed('divmod(%s, %s)' % (xn, q), lambda: divmod(x, q/1))
