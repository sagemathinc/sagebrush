# RealIntervalField of a symbolic value at the field's own precision
# (CORR-AA4-1): checked by test/rif-symbolic.test.ts. Containment is checked
# exactly, by rational endpoint arithmetic, never by a float of the root.
def ends(v):
    return v.lower().exact_rational(), v.upper().exact_rational()
def width_bits(v):
    lo, hi = ends(v)
    w = hi - lo
    return -100000 if w == 0 else int(w.numerator()).bit_length() - int(w.denominator()).bit_length()
for prec in [53, 128, 1024]:
    F = RealIntervalField(prec)
    lo, hi = ends(F(sqrt(2)))
    assert lo * lo <= 2 <= hi * hi, prec
    lo, hi = ends(F(2^(3/2)))
    assert lo * lo <= 8 <= hi * hi and lo >= 0, prec
    lo, hi = ends(F(1/sqrt(5)))
    assert lo * lo <= QQ(1)/5 <= hi * hi, prec
    lo, hi = ends(F((sqrt(2) + 1)^2))
    assert lo <= 3 + 2*F(sqrt(2)).upper().exact_rational() and hi >= 3, prec
    print(prec, width_bits(F(sqrt(2))) <= -prec + 4, width_bits(F(pi*sqrt(3)/2)) <= -prec + 6, width_bits(F(e^2 - 7)) <= -prec + 6, width_bits(F(sqrt(2) - 14142135623730951/10^16)) <= -prec + 6)
# the direct route, for comparison: the same widths
print(width_bits(RealIntervalField(128)(sqrt(2))) == width_bits(RealIntervalField(128)(2).sqrt()))
# outside the arithmetic: the coarse certified enclosure, as before
v = RealIntervalField(128)(sin(1)); lo, hi = ends(v); print(0.8414 < lo and hi < 0.8415 and lo <= hi)
try:
    RealIntervalField(128)(x + 1)
except Exception as err:
    print(type(err).__name__)
