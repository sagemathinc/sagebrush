# Real numbers into QQ and ZZ: QQ(x) is the simplest rational that rounds
# to x (an integral x is itself), ZZ(x) needs an integral x; ZZ, QQ and SR
# are singletons under pickle and copy.
import math, pickle, copy

def show(s):
    try:
        print(s, "->", eval(s))
    except Exception as e:
        print(s, "->", type(e).__name__ + ":", e)

for s in ["QQ(float(0.1))", "QQ(float(1/3))", "QQ(float(-2/3))", "QQ(float(0.30000000000000004))", "QQ(float(3.141592653589793))",
          "QQ(float(123456.789))", "QQ(float(1e-20))", "QQ(float(2**53 + 2))", "QQ(float(2**60 + 2**8))", "QQ(float(-0.0))",
          "QQ(0.1)", "QQ(RR(1/3))", "QQ(RDF(0.1))", "QQ(RDF(2**60 + 2**8))", "QQ(RealField(100)(0.1))", "QQ(RealField(20)(0.1))",
          "QQ(float('inf'))", "QQ(float('nan'))", "QQ(RR('inf'))", "Rational(float(0.1))", "RR(0.1).exact_rational()"]:
    show(s)

# floats across the exponent range (subnormals too): m * 2^e exactly
state = 12345
for i in range(300):
    state = (6364136223846793005 * state + 1442695040888963407) % 2^64
    m = state >> 11
    e = [-1074, -1060, -1030, -70, -60, -53, -40, -20, -5, -1, 0, 3, 20, 60, 900][i % 15]
    x = math.ldexp(float(int(m)), int(e - 53 + i % 7))
    q = QQ(x)
    assert float(q) == x
    print(i, x.hex(), q)

for s in ["ZZ(float(3.0))", "ZZ(float(2**70))", "ZZ(float(-0.0))", "ZZ(RDF(4.0))", "ZZ(RR(5.0))", "ZZ(4.0)",
          "ZZ(float(3.5))", "ZZ(RDF(3.5))", "ZZ(RR(3.5))", "ZZ(RealField(100)(7/2))", "ZZ(RealField(100)(7))",
          "ZZ(float('inf'))", "ZZ(float('nan'))", "ZZ(RR('inf'))", "Integer(float(2.0))", "Integer(float(-2.5))", "Integer(RR(2.5))"]:
    show(s)

print(float(0.1) in QQ, RR(0.1) in QQ, float(0.5) in ZZ, float(3.0) in ZZ, float(3.5) in ZZ, float('inf') in QQ, float('nan') in QQ, RR(3.0) in ZZ)
for R in [ZZ, QQ, SR]:
    print(R, pickle.loads(pickle.dumps(R)) is R, all(pickle.loads(pickle.dumps(R, p)) is R for p in range(6)), copy.copy(R) is R, copy.deepcopy(R) is R, copy.deepcopy([R])[0] is R)

# a float subclass's own __float__ is not what ZZ, Integer and QQ convert
class F(float):
    def __float__(self):
        return 9.0
for s in ["ZZ(F('2'))", "Integer(F('2'))", "ZZ(F('2.5'))", "QQ(F('0.5'))", "QQ(F('0.1'))", "Rational(F('0.1'))"]:
    show(s)
# an integral real as a ZZ matrix entry, exactly at any precision
m = matrix(ZZ, [[0, 0]])
m[0, 0] = RealField(16385)(2)
m[0, 1] = RealField(100)(-7)
print(m)
try:
    m[0, 0] = RealField(16385)(5/2)
except TypeError as e:
    print("TypeError")

# __int__ is called once, and its answer checked against the double
class G(float):
    calls = 0
    def __int__(self):
        G.calls += 1
        return int(9)
class H(float):
    calls = 0
    def __int__(self):
        H.calls += 1
        return int(float.__float__(self))
for s in ["ZZ(G('2'))", "Integer(G('2'))", "ZZ(G('2.5'))", "ZZ(H('2'))", "Integer(H('-3'))", "ZZ(H('2.5'))"]:
    show(s)
print(G.calls, H.calls)

# x + n and x * n with an int subclass: its stored value counts, not its
# comparison hooks
class Liar(int):
    def __ne__(self, other):
        return False
    def __eq__(self, other):
        return True
class Raiser(int):
    def __ne__(self, other):
        raise RuntimeError("ne hook")
    def __eq__(self, other):
        raise RuntimeError("eq hook")
a = RealNumber('0.5')
for c in [Liar, Raiser]:
    print(c.__name__, a * c(int(2)), c(int(2)) * a, a + c(int(2)), c(int(2)) + a, a * c(int(1)), a + c(int(0)))
