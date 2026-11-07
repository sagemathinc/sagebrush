# The bits of arithmetic with polynomials over RR, RDF, CC and CDF, as Sage 10.9 (1b stage 1):
# a product sums a_i b_(k-i) for i ascending; a square (f*f) is its own sum over RDF, CC and CDF;
# a power is binary from the low bit; division by a number is by its inverse (CC's is the
# conjugate over the norm); evaluation is Horner's rule.  (A power of a constant is the
# coefficient's own power, CDF fidelity's, and is left out.)
import random
def hx(c):
    z = complex(c)
    return '%s,%s' % (float(z.real).hex(), float(z.imag).hex())
def bits(f):
    return ' '.join(hx(c) for c in f.list())
for bn, B in [('RR', RR), ('RDF', RDF), ('CC', CC), ('CDF', CDF)]:
    P = PolynomialRing(B, 't'); t = P.gen()
    f = B(7)*t^2 + B(5)*t + B(1)/B(3)
    print(bn, 'f/3', bits(f/3))
    print(bn, 'f/0.7', bits(f/B(0.7)))
    if bn in ('CC', 'CDF'):
        print(bn, 'f/(1+2i)', bits(f/B(1, 2)))
        print(bn, 'f/(0.3+0.7i)', bits(f/B(0.3, 0.7)))
    g = B(1.1)*t + 1
    print(bn, 'g^3', bits(g^3))
    print(bn, 'g^5', bits(g^5))
    h = B(0.1)*t^4 + B(0.7)*t^3 + B(1.3)*t^2 + B(2.9)*t + B(0.3)
    for a in [B(0.37), B(1.9), B(-2.3)]:
        print(bn, 'h(%s)' % a, hx(h(a)))
    print(bn, 'h(1/3)', hx(h(1/3)))
    print(bn, 'h deriv', bits(h.derivative()), '| int', bits(h.integral()))
    print(bn, 'h*h', bits(h*h))
    print(bn, 'h*copy', bits(h*P(h.list())))
    print(bn, 'h+1/3', bits(h + 1/3), '| 0.7*h', bits(B(0.7)*h))
    print(bn, 'monic', bits(h.monic()))
    rnd = random.Random(int(1234))
    def rp(d, cplx):
        return [B(rnd.uniform(-3.0r, 3.0r), rnd.uniform(-3.0r, 3.0r)) if cplx else B(rnd.uniform(-3.0r, 3.0r)) for _ in range(d + 1)]
    for k in range(12):
        da, db = rnd.randint(int(1), int(7)), rnd.randint(int(0), int(7))
        cp = bn in ('CDF', 'CC') and k % 2 == 1
        fa, fb = P(rp(da, cp)), P(rp(db, cp))
        print(bn, k, 'ab', bits(fa*fb))
        print(bn, k, 'aa', bits(fa*fa))
        if da <= 4:
            for n in (2, 3, 5, 7):
                print(bn, k, 'p%d' % n, bits(fa^n))
