# Float zeros in symbolic expressions, as Sage 10.9: a zero coefficient (exact or float) is the product
# (RR(0)*x is 0.000000000000000, -RR(0)*x is -0.000000000000000), a term whose coefficient became zero drops
# out (RR(2)*x - RR(2)*x is 0), and numbers add left to right with a zero leaving the other as it is
# (SR(0) + RR(0) is 0, RR(0) + SR(0) is 0.000000000000000, RR(0)*x + 1 is 1). Not here: functions at a
# float zero (sin(RR(0)) is 0 in Sage), RR's exponent range, RDF's 0.0 style.
var('x y')
for t in ['SR(RR(1.5)) - RR(1.5)', 'x + RR(1.5) - RR(1.5)', 'SR(RR(0)) + SR(RR(0))', 'SR(RR(0)) + 0', 'SR(0) + RR(0)', 'RR(0) + SR(0)', 'SR(RR(-0.0)) + 0', 'RR(0)*x + RR(0)', 'RR(0)*x + RR(1)', 'RR(0)*x + y', 'RR(0)*x*y + y', 'RR(1.5)*x - RR(1.5)*x + 1', 'RR(1.5)*x - RR(1.5)*x + RR(1)', 'RR(0)*x^2', '(x + RR(0))', '(x + RR(0))*y', 'x*(y + RR(0))', 'RR(0)*x - RR(0)*x', 'RR(0)*x + RR(-0.0)*x', 'RR(-0.0)*x*RR(-1)', '-RR(0)*x', 'RR(-0.0)*x + 1', 'expand((x + RR(0))^2)', 'expand((x + 1)*(x - 1) + RR(0)*x)', 'RR(0)*x == 0', '(RR(0)*x).is_zero()', 'parent(RR(0)*x)', 'RR(0)^x', 'RR(0)*I*x', '(RR(0)*x).subs(x=5)', 'diff(RR(0)*x, x)', 'RR(0)*x + RR(0)*y', 'x + RR(1) - 1', 'x + RR(1) - RR(1)', 'SR(RR(1)) - 1', 'RR(0)*x', 'x*RR(0)', 'RR(-0.0)*x', 'RR(0)*x + 1', 'RR(0)*x*y', 'SR(RR(1.5))*0', 'RR(1.5)*x*0', 'SR(RR(0))', 'SR(RR(0)) + x', 'x - x + RR(0)', 'RR(0) + x', '(x + 1)*RR(0)', 'expand((x + 1)*RR(0))', 'RR(2)*x - RR(2)*x']:
    print(t, '=>', sage_eval(t, locals=dict(x=x, y=y)))
