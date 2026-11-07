# bool() of a relation between algebraic constants (rationals, I, sums,
# products, rational powers, abs) decided exactly, as Sage decides it: the
# double enclosure of q*sqrt(2) - p held 0 for p^2 - 2*q^2 = 1 near 10^7,
# and 8*4^(1/4)*sqrt(2) == 16 was False (friction W28)
def show(label, f):
    try:
        print(label, '|', f())
    except Exception as e:
        print(label, '| ERR', type(e).__name__, repr(str(e)[:150]))
a = 8*4^(1/4)*sqrt(2)
print(bool(a == 16))
p = 22619537; q = 15994428
print(p*p - 2*q*q, bool(q*sqrt(2) < p), max(q*sqrt(2), p), 2*q*q < p*p, bool(sqrt(2) < QQ(p)/q))
print(bool(abs(sqrt(2)) == sqrt(2)))
cases = [
 ('denest', lambda: bool(sqrt(sqrt(3) + 2) == (sqrt(6) + sqrt(2))/2)),
 ('denest ne', lambda: bool(sqrt(sqrt(3) + 2) != (sqrt(6) + sqrt(2))/2)),
 ('roots sum lt', lambda: bool(2^(1/3) + 3^(1/5) < 3)),
 ('roots sum gt', lambda: bool(2^(1/3) + 3^(1/5) > 3)),
 ('4^(1/4) == sqrt2', lambda: bool(4^(1/4) == sqrt(2))),
 ('8*4^(1/4)*sqrt2 != 16', lambda: bool(8*4^(1/4)*sqrt(2) != 16)),
 ('8*4^(1/4)*sqrt2 <= 16', lambda: bool(8*4^(1/4)*sqrt(2) <= 16)),
 ('8*4^(1/4)*sqrt2 >= 16', lambda: bool(8*4^(1/4)*sqrt(2) >= 16)),
 ('8*4^(1/4)*sqrt2 < 16', lambda: bool(8*4^(1/4)*sqrt(2) < 16)),
 ('q sqrt2 <= p', lambda: bool(q*sqrt(2) <= p)),
 ('q sqrt2 > p', lambda: bool(q*sqrt(2) > p)),
 ('q sqrt2 >= p', lambda: bool(q*sqrt(2) >= p)),
 ('q sqrt2 == p', lambda: bool(q*sqrt(2) == p)),
 ('q sqrt2 != p', lambda: bool(q*sqrt(2) != p)),
 ('p > q sqrt2', lambda: bool(p > q*sqrt(2))),
 ('min', lambda: min(q*sqrt(2), p)),
 ('sorted', lambda: sorted([p, q*sqrt(2)])),
 ('sorted 3', lambda: sorted([QQ(p)/q, sqrt(2), 1414213562373095/10^15])),
 ('pell 12 digits', lambda: bool(3122670429399*sqrt(2) < 4416180000000)),
 ('pell 6 digits', lambda: bool(470832*sqrt(2) < 665857)),
 ('sqrt2+sqrt3 == sqrt(5+2 sqrt6)', lambda: bool(sqrt(2) + sqrt(3) == sqrt(5 + 2*sqrt(6)))),
 ('sqrt2*sqrt3 == sqrt6', lambda: bool(sqrt(2)*sqrt(3) == sqrt(6))),
 ('(2^(1/3))^3 == 2', lambda: bool((2^(1/3))^3 == 2)),
 ('(1+sqrt2)^2 == 3+2sqrt2', lambda: bool((1 + sqrt(2))^2 == 3 + 2*sqrt(2))),
 ('(1+sqrt2)^10 > 5000', lambda: bool((1 + sqrt(2))^10 > 5000)),
 ('sqrt(2)^(1/2) == 2^(1/4)', lambda: bool(sqrt(2)^(1/2) == 2^(1/4))),
 ('I sqrt2 == sqrt(-2)', lambda: bool(I*sqrt(2) == sqrt(-2))),
 ('sqrt(-2) < 1', lambda: bool(sqrt(-2) < 1)),
 ('sqrt(-2) > 1', lambda: bool(sqrt(-2) > 1)),
 ('I + sqrt(2) == sqrt(2) + I', lambda: bool(I + sqrt(2) == sqrt(2) + I)),
 ('(1 + I)^2 == 2*I', lambda: bool((1 + I)^2 == 2*I)),
 ('abs(1-sqrt2) == sqrt2-1', lambda: bool(abs(1 - sqrt(2)) == sqrt(2) - 1)),
 ('abs(1-sqrt2) < 1/2', lambda: bool(abs(1 - sqrt(2)) < 1/2)),
 ('abs(1+I) == sqrt2', lambda: bool(abs(1 + I) == sqrt(2))),
 ('golden', lambda: bool(((1 + sqrt(5))/2)^2 == (1 + sqrt(5))/2 + 1)),
 ('cube roots, principal', lambda: bool((2 + sqrt(5))^(1/3) + (2 - sqrt(5))^(1/3) == 1)),
 ('(-8)^(1/3) == -2', lambda: bool((-8)^(1/3) == -2)),
 ('(-8)^(1/3) == 1 + I*sqrt(3)', lambda: bool((-8)^(1/3) == 1 + I*sqrt(3))),
 ('2^(1/2) == 2^(2/4)', lambda: bool(2^(1/2) == 2^(2/4))),
 ('sqrt(8) == 2 sqrt(2)', lambda: bool(sqrt(8) == 2*sqrt(2))),
 ('27^(1/6) == sqrt(3)', lambda: bool(27^(1/6) == sqrt(3))),
 ('9^(1/4) == sqrt(3)', lambda: bool(9^(1/4) == sqrt(3))),
 ('9^(1/4) < 1.733', lambda: bool(9^(1/4) < 1.733)),
 ('seven roots == 20', lambda: bool(sqrt(2) + sqrt(3) + sqrt(5) + sqrt(7) + sqrt(11) + sqrt(13) + sqrt(17) == 20)),
 ('seven roots < 20', lambda: bool(sqrt(2) + sqrt(3) + sqrt(5) + sqrt(7) + sqrt(11) + sqrt(13) + sqrt(17) < 20)),
 ('pi > 355/113', lambda: bool(pi > 355/113)),
 ('pi < 355/113', lambda: bool(pi < 355/113)),
 ('sin(pi/12) == (sqrt6-sqrt2)/4', lambda: bool(sin(pi/12) == (sqrt(6) - sqrt(2))/4)),
 ('cos(pi/5) == (1+sqrt5)/4', lambda: bool(cos(pi/5) == (1 + sqrt(5))/4)),
]
for n, f in cases:
    show(n, f)
