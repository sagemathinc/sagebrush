# Sage's methods of CC's elements: exp, the trigonometric and hyperbolic
# functions, log, norm and arg, and the functions of an element of CC, which
# are its methods (an element of CC, however real its value).  Each value is
# printed in hex, the operands written in hex; a value past the doubles is
# refused (doctests in lib/_sage_matrix.py), so the rows here are in range.
def h(v):
    try:
        p = (v.real(), v.imag())
    except AttributeError:
        p = (v, 0)
    return float(p[0]).hex() + "," + float(p[1]).hex()

names = ["exp", "sin", "cos", "tan", "cot", "sec", "csc", "sinh", "cosh", "tanh", "coth", "sech", "csch"]
rows = [
    (float.fromhex('0x1.d802db9b6a9c6p-1'), float.fromhex('-0x1.20cbf68c1c088p-8')),
    (float.fromhex('-0x1.f3c0a0f4cb1a8p-5'), float.fromhex('-0x1.2c80a149e2f73p-7')),
    (float.fromhex('-0x1.691ed384e9ca7p-3'), float.fromhex('0x1.8f8d17f9f87dap-5')),
    (float.fromhex('0x1.c93bf9b40970ep+3'), float.fromhex('-0x1.d241492e4456ep-6')),
    (float.fromhex('-0x1.c815d3a0f99f2p-8'), float.fromhex('0x1.5963d9cc5e8d9p+1')),
    (float.fromhex('-0x1.8ce38ffdd0f86p-3'), float.fromhex('0x1.746553b97cf06p+1')),
    (float.fromhex('0x1.70d0cda75d1fap-6'), float.fromhex('0x1.a0ed9bf05552cp+0')),
    (float.fromhex('-0x1.ebf7c6b2365acp-6'), float.fromhex('-0x1.5e7f5bce27506p-5')),
    (float.fromhex('0x1.9edcdb411f304p+2'), float.fromhex('-0x1.78f41c12eb786p+0')),
    (float.fromhex('0x1.25868a5e56d0cp-5'), float.fromhex('0x1.fa4304c8348d3p-7')),
    (float.fromhex('0x1.135a588510a06p-7'), float.fromhex('0x1.940796b3359ffp-7')),
    (float.fromhex('-0x1.405dbfd9c348fp-1'), float.fromhex('0x1.51f97a15720f8p+2')),
    (float.fromhex('0x1.7f4e9f452719ep+1'), float.fromhex('0x1.a2241af2974dap-5')),
    (float.fromhex('0x1.997911995bdf0p-8'), float.fromhex('0x1.72ae651439d78p-2')),
    (float.fromhex('-0x1.e83329e1a2de4p-1'), float.fromhex('-0x1.971f9f36beabep-1')),
    (float.fromhex('-0x1.0f22edaf59369p-4'), float.fromhex('0x1.b419e7c270bcep+0')),
    (float.fromhex('0x1.f1b842d589d6ap-8'), float.fromhex('0x1.9dbdbce48dbbcp+1')),
    (float.fromhex('0x1.61018cc20f9f6p-4'), float.fromhex('0x1.d011dd8a1cf1ep-2')),
    (float.fromhex('-0x1.39d2f19abd673p-7'), float.fromhex('-0x1.a0fbe6bcd15b6p-7')),
    (float.fromhex('-0x1.e4521ba82d9d4p-8'), float.fromhex('0x1.6f8284e3b4bb3p+3')),
    (float.fromhex('0x1.0000000000000p+0'), float.fromhex('0x0.0p+0')),
    (float.fromhex('0x0.0p+0'), float.fromhex('0x1.0000000000000p+0')),
    (float.fromhex('-0x1.0000000000000p+0'), float.fromhex('0x0.0p+0')),
    (float.fromhex('0x0.0p+0'), float.fromhex('0x0.0p+0')),
    (float.fromhex('-0x0.0p+0'), float.fromhex('0x0.0p+0')),
    (float.fromhex('0x1.0000000000000p+0'), float.fromhex('0x1.56e1fc2f8f359p-997')),
    (float.fromhex('inf'), float.fromhex('0x0.0p+0')),
    (float.fromhex('0x1.0000000000000p+0'), float.fromhex('nan')),
    (float.fromhex('0x1.0000000000000p-1'), float.fromhex('0x1.8000000000000p+1')),
    ]
for a, b in rows:
    z = CC(a, b)
    ms = []
    for m in names + ["log", "norm", "arg"]:
        try:
            ms.append(m + "=" + h(getattr(z, m)()))
        except NotImplementedError:
            ms.append(m + "=past")
    print(" ".join(ms))
    fs = []
    for m in names:
        try:
            v = globals()[m](z)
            fs.append(m + "=" + h(v) + ("" if parent(v) is CC else "!" + str(parent(v))))
        except NotImplementedError:
            fs.append(m + "=past")
    print("  f:", " ".join(fs))

# the tests of an element
inf, nan = float("inf"), float("nan")
for a, b in [(1, 2), (1, 0), (0, 2), (0, 0), (-0.0, 0), (inf, 0), (-inf, 0), (inf, 1), (1, inf), (nan, 0), (0, nan)]:
    z = CC(a, b)
    print(a, b, [getattr(z, p)() for p in ["is_real", "is_imaginary", "is_zero", "is_one", "is_NaN", "is_infinity", "is_positive_infinity", "is_negative_infinity", "prec"]])
print(CC(1, 2).argument() == CC(1, 2).arg())
