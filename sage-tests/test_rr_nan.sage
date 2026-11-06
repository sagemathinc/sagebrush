# RR's and RDF's NaN and infinities in symbolic expressions, as Sage 10.9 (rrnan): they stay real
# (RR('inf')*x was (NaN - NaN*I)*x), an exact zero absorbs them (SR(RR('inf'))*0 is 0), and they print
# as Sage prints them ((+infinity)*x, -infinity*x). The lines where Sagebrush still differs are not here:
# float zeros (0.000000000000000*x), RR's exponent range, 1/NaN left unevaluated, RDF's 0.0 style.
var('x y')
def show(K, ts):
    inf, ninf, nan = K('inf'), K('-inf'), K('nan')
    L = dict(x=x, y=y, inf=inf, ninf=ninf, nan=nan, K=K)
    for t in ts:
        try:
            print(K, '|', t, '=>', sage_eval(t, locals=L))
        except Exception as e:
            print(K, '|', t, '=> ERR', type(e).__name__)
show(RR, ['inf*x', 'x*inf', 'ninf*x', 'nan*x', '-inf*x', '-(inf*x)', 'inf*x^2', 'inf*x*y', 'ninf*x*y', 'inf*x + 1', 'ninf*x + y', 'x + inf', 'x + ninf', 'x - inf', 'x*y + inf', 'inf*x - x', 'inf*inf*x', 'inf*ninf*x', 'inf*x*2', 'inf*x/2', 'ninf*x*K(-2)', '(inf*x).subs(x=2)', '(inf*x).subs(x=-2)', '(ninf*x).subs(x=3)', '(nan*x).subs(x=1)', '(inf*x).coefficient(x)', '(ninf*x).coefficient(x)', '(inf*x + 1).subs(x=1)', 'SR(inf) + SR(ninf)', 'SR(inf)*0', 'SR(inf)*K(0)*x', '(x + 1)*inf', 'expand((x + 1)*inf)', 'expand((x + 1)*ninf)', 'SR(inf)', 'SR(ninf)', 'SR(nan)', '-SR(inf)', '1/SR(inf)', '1/SR(ninf)', 'SR(inf)^2', 'SR(ninf)^3', 'SR(ninf)^2', 'inf*x == inf*x'])
show(RDF, ['inf*x', 'x*inf', 'ninf*x', 'nan*x', '-inf*x', '-(inf*x)', 'inf*x^2', 'inf*x*y', 'ninf*x*y', 'inf*x + 1', 'ninf*x + y', 'x + inf', 'x + ninf', 'x - inf', 'x*y + inf', 'inf*x - x', 'x/nan', 'inf*inf*x', 'inf*ninf*x', 'inf*x*2', 'inf*x/2', 'ninf*x*K(-2)', '(inf*x).subs(x=2)', '(inf*x).subs(x=-2)', '(ninf*x).subs(x=3)', '(nan*x).subs(x=1)', '(inf*x).coefficient(x)', '(ninf*x).coefficient(x)', '(inf*x + 1).subs(x=1)', 'SR(inf) + SR(ninf)', 'SR(inf)*0', 'SR(inf)*K(0)*x', '(x + 1)*inf', 'expand((x + 1)*inf)', 'expand((x + 1)*ninf)', 'SR(inf)', 'SR(ninf)', 'SR(nan)', '-SR(inf)', 'SR(inf)^2', 'SR(ninf)^3', 'SR(ninf)^2', 'inf*x == inf*x'])
for t in ['SR(RR(1.5))*0', "SR(RR('inf'))*0", "SR(RR('nan'))*0", "0*SR(RR('nan'))", "RR('nan')*x*0", "x*0*RR('inf')", 'RR(1.5)*x*0', "1/RR('nan')*x"]:
    print(t, '=>', sage_eval(t, locals=dict(x=x, y=y)))
