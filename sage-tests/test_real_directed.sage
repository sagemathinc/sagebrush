# RealField(p)'s functions in every rounding mode, by their exact values
# (sign, mantissa, exponent: a directed rounding one unit off prints the same
# decimal digits), as Sage gives them, correctly rounded; tiny and large
# arguments included (sec, csc and cot of tiny numbers, tanh of large ones are
# a number of the field moved far below its last place).
import random
random.seed(int(1632))
FS = ["exp", "log", "sin", "cos", "tan", "cot", "sec", "csc", "arctan", "arcsin", "arccos",
      "sinh", "cosh", "tanh", "arcsinh", "arccosh", "arctanh", "gamma", "log_gamma"]


def arg(f, R):
    k = random.random()
    if k < 0.15:
        v = R(random.choice([-1, 1])) * R(2) ^ random.randint(-3 * R.prec(), -R.prec() // 2)
    elif k < 0.25:
        v = R(random.choice([-1, 1])) * R(random.randint(40, 2000))
    else:
        v = R(random.randint(-10 ^ 6, 10 ^ 6)) / R(random.randint(1, 10 ^ 5))
    if f in ("arcsin", "arccos", "arctanh"):
        v = v / (abs(v) + 1) if abs(v) >= 1 else v
    if f in ("log", "arccosh", "gamma", "log_gamma"):
        v = abs(v) + (1 if f == "arccosh" else 0)
    if f in ("exp", "sinh", "cosh") and abs(v) > 500:
        v = v / 1000
    return v


for p in [2, 3, 5, 21, 24, 64, 100]:
    for rnd in ["RNDN", "RNDU", "RNDD", "RNDZ", "RNDA"]:
        R = RealField(p, rnd=rnd)
        for f in FS:
            for i in range(3):
                x = arg(f, R)
                try:
                    v = getattr(x, f)()
                    out = v.sign_mantissa_exponent() if not v.is_infinity() and not v.is_NaN() else str(v)
                except Exception as _err:
                    out = type(_err).__name__
                print(p, rnd, f, x.sign_mantissa_exponent(), out)
# tiny numbers far below the working precision (the functions' own analytic
# values), logarithms of negative numbers (log |x| + pi I in ComplexField(p)),
# and 1-bit fields
for p in [5, 54, 100]:
    for rnd in ["RNDN", "RNDU", "RNDD", "RNDZ", "RNDA"]:
        R = RealField(p, rnd=rnd)
        for s in [1, -1]:
            x = s * R(2) ^ (-8 * (p + 40))
            print(p, rnd, s, [getattr(x, f)().sign_mantissa_exponent() for f in ["exp", "sin", "cos", "tan", "arctan", "arcsin", "sinh", "cosh", "tanh", "arcsinh", "arctanh"]])
        for v in [R(-1) - R(2) ^ (1 - p), R(-2), R(-1) / 3]:
            z = v.log()
            print(p, rnd, v.sign_mantissa_exponent(), z.real().sign_mantissa_exponent(), z.imag().sign_mantissa_exponent(), z.parent())
for rnd in ["RNDN", "RNDU", "RNDD", "RNDZ", "RNDA"]:
    R = RealField(1, rnd=rnd)
    print(1, rnd, R(-1/2).log(), R(-1).log(), R(3).log(), R(3).exp())
