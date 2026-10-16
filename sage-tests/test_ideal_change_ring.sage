# An ideal moved to another polynomial ring takes that ring's term order (the
# sagebook, p. 208: J_lex.change_ring(R_invlex) kept the lex basis; astra's
# HUNT-E4A-1)
R_lex.<x,y> = PolynomialRing(QQ, order='lex')
J_lex = (x*y+x+y^2+1, x^2*y+x*y^2+1)*R_lex; print(J_lex.gens())
print(J_lex.groebner_basis())
R_invlex = PolynomialRing(QQ, 'x,y', order='invlex')
J_invlex = J_lex.change_ring(R_invlex); print(J_invlex.gens(), J_invlex.ring() == R_invlex)
print(J_invlex.groebner_basis())
R_drl = PolynomialRing(QQ, 'x,y', order='degrevlex')
J_drl = J_lex.change_ring(R_drl); print(J_drl.gens(), J_drl.ring() == R_drl)
print(J_drl.groebner_basis())
p = (x + y)^5
print(J_lex.reduce(p))
print(J_lex.normal_basis()); print(J_invlex.normal_basis()); print(J_drl.normal_basis())
R = PolynomialRing(QQ, 'x,y', order='lex'); x, y = R.gens()
J = R.ideal([x*y - 1, y^2 - x])
S = PolynomialRing(QQ, 'x,y', order='degrevlex')
K = J.change_ring(S); print(K.ring() == S, K.groebner_basis(), K.normal_basis())
