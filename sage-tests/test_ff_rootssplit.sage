# Splitting fields of polynomials over finite fields and the roots there
# (F3 of plan-finite-fields, Magma's RootsInSplittingField): splitting_field
# (with map=True) and roots(ring) in an overfield, by the shared core.
# Expected output from Sage 10.9.
def check(label, f):
    try:
        v = f()
        print(label, v)
    except Exception as e:
        print(label, "ERR", type(e).__name__, str(e).splitlines()[0])
R.<x> = GF(5)[]
f = x^2 + 2
check('sf', lambda: f.splitting_field('b'))
check('sf map', lambda: f.splitting_field('b', map=True))
K.<b> = f.splitting_field()
check('roots K', lambda: f.roots(K))
check('roots K nomult', lambda: f.roots(K, multiplicities=False))
check('sf cubic', lambda: (x^3 + x + 1).splitting_field('c'))
check('sf mixed', lambda: ((x^2 + 2)*(x^3 + x + 1)).splitting_field('c'))
check('sf linear', lambda: (x - 1).splitting_field('c'))
check('sf linear map', lambda: (x - 1).splitting_field('c', map=True))
check('sf const', lambda: R(3).splitting_field('c'))
check('sf const map', lambda: R(3).splitting_field('c', map=True))
check('sf names tuple', lambda: (x^2 + 2).splitting_field(('b',)))
L.<c> = ((x^2 + 2)*(x^3 + x + 1)).splitting_field()
check('roots mixed', lambda: ((x^2 + 2)*(x^3 + x + 1)).roots(L))
check('roots in GF(5^4)', lambda: (x^2 + 2).roots(GF(5^4, 'e')))
check('roots none', lambda: (x^3 + x + 1).roots(GF(25, 'b')))
check('roots mixed 25', lambda: ((x^2+2)*(x^3+x+1)*(x-1)).roots(GF(25, 'b')))
check('roots zero', lambda: R(0).roots(GF(25, 'b')))
check('roots const', lambda: R(3).roots(GF(25, 'b')))
check('roots rep', lambda: ((x^2 + 2)^2*(x - 1)).roots(GF(25, 'b')))
check('roots mult=False', lambda: ((x^2+2)^2).roots(GF(25,'b'), multiplicities=False))
F4.<a> = GF(4)
S.<t> = F4[]
check('sf F4', lambda: (t^2 + t + a).splitting_field('d'))
check('sf F4 map', lambda: (t^2 + t + a).splitting_field('d', map=True))
check('roots F4 in GF16', lambda: (t^2 + t + a).roots(GF(16, 'e')))
G4 = GF(4)
P4.<s> = G4[]
check('prefix roots', lambda: (s^2 + s + G4.gen()).roots(GF(16)))
G2.<y> = GF(2)[]
check('roots GF2 in GF16', lambda: (y^4 + y + 1).roots(GF(16, 'g')))
check('roots GF2 in GF8', lambda: (y^4 + y + 1).roots(GF(8, 'h')))
