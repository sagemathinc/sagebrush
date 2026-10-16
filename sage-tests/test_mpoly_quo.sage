# R.quo(J) for a multivariate polynomial ring (the sagebook, p. 209:
# ch09-150/151; R.quo was an AttributeError)
def T(name, fun):
    try: print(name, '::', fun())
    except Exception as e: print(name, '::', type(e).__name__, str(e)[:150])
R_lex.<x,y> = PolynomialRing(QQ, order='lex')
J_lex = (x*y+x+y^2+1, x^2*y+x*y^2+1)*R_lex
R_drl = PolynomialRing(QQ, 'x,y', order='degrevlex'); J_drl = J_lex.change_ring(R_drl)
p = (x + y)^5
Q = R_lex.quo(J_lex)
T('repr', lambda: Q)
T('ch09-150', lambda: Q(p))
T('ch09-151', lambda: R_drl.quo(J_drl)(p))
T('gens', lambda: Q.gens())
a, b = Q.gens()
T('arith', lambda: (a*b + a^3, a + 1 == Q(x + 1), (a*b)^2, -a, a - b, 2*a + 1/2, b^10))
T('lift', lambda: Q(p).lift())
T('zero', lambda: (Q(x*y+x+y^2+1), Q(x*y+x+y^2+1) == 0, Q(0).is_zero()))
T('parent', lambda: Q(p).parent() is Q)
T('names', lambda: R_lex.quo(J_lex, names='u,v')(x))
T('quotient', lambda: R_lex.quotient(J_lex)(y^4))
T('ring', lambda: (Q.cover_ring(), Q.defining_ideal()))
T('poly gens', lambda: R_lex.quo([x^2, y^2])(x*y + x^3))
T('latex', lambda: latex(Q(p)))
R3.<z,wbar,a1> = QQ[]
T('latex poly', lambda: (latex(-z^2/2 + 3*z*wbar - z*a1^3 - 1/3), latex(R3(-5/7)), latex(R3(0))))
S7.<u,v> = GF(7)[]
T('latex gf', lambda: latex(3*u^2*v - v + 2))
SZ.<p1,q> = ZZ[]
T('latex zz', lambda: latex(-2*p1*q^10 + 1))
