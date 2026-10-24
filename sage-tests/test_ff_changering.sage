# change_ring and map_coefficients of univariate polynomials over ZZ, QQ,
# Zmod(n) and finite fields (F3 of plan-finite-fields, Magma's ChangeRing):
# coefficients reduced, lifted, embedded or descended by the shared core,
# Sage's rules and errors. Expected output from Sage 10.9.
def check(label, f):
    try:
        v = f()
        print(label, v, "|", v.parent())
    except Exception as e:
        print(label, type(e).__name__, str(e).splitlines()[0])
R.<x> = ZZ[]
f = 3*x^2 - x + 7
check('ZZ->QQ', lambda: f.change_ring(QQ))
check('ZZ->GF5', lambda: f.change_ring(GF(5)))
check('ZZ->GF25', lambda: f.change_ring(GF(25, 'c')))
check('ZZ->Z6', lambda: f.change_ring(Zmod(6)))
check('ZZ->GF5 x^5+5', lambda: (x^5 + 5).change_ring(GF(5)))
print(R.change_ring(GF(5)))
print(R.change_ring(QQ))
S.<y> = QQ[]
check('QQ->ZZ', lambda: (y/2 + 1).change_ring(ZZ))
check('QQ->ZZ int', lambda: (2*y + 1).change_ring(ZZ))
check('QQ->GF5', lambda: (y/2 + 1).change_ring(GF(5)))
check('QQ->GF5 den 5', lambda: (y/5 + 1).change_ring(GF(5)))
check('QQ->GF5 den 4', lambda: (y/4 + 1).change_ring(GF(5)))
check('QQ->Z6', lambda: (y/5 + 1).change_ring(Zmod(6)))
check('QQ->Z6 den 2', lambda: (y/2 + 1).change_ring(Zmod(6)))
U.<z> = GF(5)[]
check('GF5->ZZ', lambda: (z^2 + 3).change_ring(ZZ))
check('GF5->QQ', lambda: (z^2 + 3).change_ring(QQ))
check('GF5->GF7', lambda: (z^2 + 3).change_ring(GF(7)))
check('GF5->GF25', lambda: (z^2 + 3).change_ring(GF(25, 'c')))
F4.<a> = GF(4)
V.<t> = F4[]
F16.<b> = GF(16)
W.<u> = F16[]
check('F4->F16 named', lambda: (t^2 + a*t + 1).change_ring(F16))
check('F16->F4 named', lambda: (u^2 + b^5*u + 1).change_ring(F4))
check('F16->GF2', lambda: (u^2 + 1).change_ring(GF(2)))
check('F16->GF2 b', lambda: (u + b).change_ring(GF(2)))
check('F16->GF3', lambda: (u + 1).change_ring(GF(3)))
check('F4->GF3 a', lambda: (t + a).change_ring(GF(3)))
check('F4->GF8', lambda: (t^2 + a*t + 1).change_ring(GF(8, 'd')))
check('F4->ZZ', lambda: (t + a).change_ring(ZZ))
check('F4->ZZ 1', lambda: (t + 1).change_ring(ZZ))
check('F4->QQ', lambda: (t + 1).change_ring(QQ))
check('zero F4->F16', lambda: V(0).change_ring(F16))
print(V.change_ring(F16))
print(V.change_ring(GF(2)))
Z6.<w> = Zmod(6)[]
check('Z6->ZZ', lambda: (w + 5).change_ring(ZZ))
check('Z6->GF5', lambda: (w + 5).change_ring(GF(5)))
check('Z6->Z3', lambda: (w + 5).change_ring(Zmod(3)))
# prefix fields: Sage coerces GF(4) into GF(16), and back by value
G4 = GF(4)
P4.<s> = G4[]
G16 = GF(16)
P16.<v> = G16[]
check('prefix up', lambda: (s^2 + G4.gen()*s + 1).change_ring(G16))
check('prefix down', lambda: (v^2 + G16.gen()^5*v + 1).change_ring(G4))
check('prefix down not in', lambda: (v^2 + G16.gen()*v + 1).change_ring(G4))
# map_coefficients: by a field embedding (Hom), or by a function
phi = Hom(F4, F16)[0]
check('map phi', lambda: (t^2 + a*t + 1).map_coefficients(phi))
check('map phi base', lambda: (t^2 + a*t + 1).map_coefficients(phi, F16))
check('map square', lambda: (t^2 + a*t + 1).map_coefficients(lambda c: c^2))
check('map zero', lambda: V(0).map_coefficients(phi))
check('map into F16', lambda: (t + a).map_coefficients(lambda c: c^2, F16))
check('map ZZ', lambda: (3*x^2 + 1).map_coefficients(lambda c: c + 1))
check('map ZZ GF5', lambda: (3*x^2 + 1).map_coefficients(GF(5)))
# callbacks see each coefficient in the polynomial's own ring (QQ's, also
# when integral), and the result goes to the given ring
S2.<y2> = QQ[]
check('map QQ parent', lambda: (y2 + 2).map_coefficients(lambda c: c.parent() is QQ))
check('map QQ half', lambda: (y2 + 1/2).map_coefficients(lambda c: 1 if c.parent() is QQ else 0))
check('map QQ to ZZ', lambda: (y2/2 + 3).map_coefficients(lambda c: 2*c, ZZ))
check('map ZZ parent', lambda: (3*x + 1).map_coefficients(lambda c: c.parent() is ZZ))
