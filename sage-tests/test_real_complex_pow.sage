# A real number to a complex power and back, as Sage: a Python complex
# against 53 bits or more is Python's complex power (RR(2)^complex(3,0) is
# (8+0j)), below 53 bits ComplexField(p)'s; CC and ComplexField(q) give the
# complex field of the lower precision, where a zero base or an infinite
# or NaN part is a complex NaN (x^0 too).  A user's float subclass is
# computed with its value, never its __float__, by the operator and the
# direct method.  (Left out: a negative base's last digits, the
# complex-power branch; refused: a Python complex power with an infinite
# part and |z log x| of 512 or more.)
def show(label, f):
    try:
        r = f()
        p = r.parent() if hasattr(r, 'parent') else type(r).__name__
        print(label, "->", repr(r), p)
    except Exception as e:
        print(label, "!!", type(e).__name__, str(e)[:160])
F30 = RealField(30); F100 = RealField(100); C30 = ComplexField(30); C100 = ComplexField(100)
inf = float('inf'); nan = float('nan')
bases = [("RR", RR), ("F30", F30), ("F100", F100), ("RDF", RDF)]
pyexps = [("complex(3,0)", complex(3,0)), ("complex(-1,0)", complex(-1,0)), ("complex(0,1)", complex(0,1)),
          ("complex(0.5,0)", complex(0.5,0)), ("complex(0,0)", complex(0,0))]
fexps = [("CC(-1)", CC(-1)), ("CC(0)", CC(0)), ("CC(1)", CC(1)), ("CC(0,1)", CC(0,1)), ("C30(-1)", C30(-1)),
         ("C30(2)", C30(2)), ("C100(2)", C100(2)), ("C100(0)", C100(0))]
lastdigits = ("complex(0,1)", "CC(-1)", "CC(1)", "C100(2)")
for bn, B in bases:
    for v in [2, 0, "-0", -2, "inf", "-inf", "nan"]:
        for en, E in pyexps + fexps:
            if v == -2 and bn != "F30" and en in lastdigits:
                continue
            if v in ("inf", "-inf") and bn != "F30" and en.startswith("complex") and en != "complex(0,0)":
                continue
            show("%s(%s)^%s" % (bn, v, en), lambda: B(v) ** E)
for bn, B in bases:
    for v in [2, 0, -2]:
        for en, E in [("complex(3,0)", complex(3,0)), ("complex(0,0)", complex(0,0)), ("complex(-2,0)", complex(-2,0))]:
            show("%s**%s(%s)" % (en, bn, v), lambda: E ** B(v))
            show("%s(%s).__rpow__(%s)" % (bn, v, en), lambda: B(v).__rpow__(E))
# non-finite and tiny exponents in the complex fields
nfexps = [("CC(inf)", CC(inf)), ("CC(-inf)", CC(-inf)), ("CC(nan)", CC(nan)), ("CC(0,inf)", CC(0,inf)),
          ("CC(1,nan)", CC(1,nan)), ("CC(1e-300)", CC(1e-300)), ("complex(nan,0)", complex(nan,0))]
for bn, B in [("F30", F30), ("RR", RR), ("RDF", RDF)]:
    for v in [2, "0.5", -2, 1, -1]:
        for en, E in nfexps + ([("complex(inf,0)", complex(inf,0))] if bn == "F30" else []):
            show("%s(%s)^%s" % (bn, v, en), lambda: B(v) ** E)
    for v in [2, -2, 0]:
        for en, E in nfexps[:5]:
            show("%s(%s).__rpow__(%s)" % (bn, v, en), lambda: B(v).__rpow__(E))
class F(float):
    def __float__(self):
        raise ValueError('must not call __float__')
for bn, B in bases:
    for v, fv in [(2, 3), (0, -1), (-2, 0.5), (-2, 3), (0, 2)]:
        show("%s(%s).__pow__(F(%s))" % (bn, v, fv), lambda: B(v).__pow__(F(fv)))
        show("%s(%s)**F(%s)" % (bn, v, fv), lambda: B(v) ** F(fv))
        show("F(%s)**%s(%s)" % (fv, bn, v), lambda: F(fv) ** B(v))
# CC to a RealField(p) power: Sage's is in the coarser complex field; only
# 53 bits is available (any other precision is refused, as before)
show("CC(2)^RealField(53)(3)", lambda: CC(2) ** RealField(53)(3))
# a user's float subclass against a coarser field: x^0 is 1 and a zero
# base follows 0^y, else refused; above 53 bits Python float's power
fbv = [0.0, -0.0, 1.0, -1.0, 2.0, nan, inf, -inf]
fev = [-3, -2, -1, -0.5, '-0', 0, 0.5, 2, 3, 'nan', '+inf', '-inf']
for p in [30, 100]:
    R = RealField(p)
    for b in fbv:
        show("RealField(%d)(%s).__pow__(F(0))" % (p, b), lambda: R(b).__pow__(F(0.0)))
        show("RealField(%d)(%s).__pow__(F(-0))" % (p, b), lambda: R(b).__pow__(F(-0.0)))
        show("RealField(%d)(%s)**F(0)" % (p, b), lambda: R(b) ** F(0.0))
        show("RealField(%d)(%s).__pow__(F(2))" % (p, b), lambda: R(b).__pow__(F(2.0)))
    for e in fev:
        for b in [0.0, -0.0, 1.0, 2.0]:
            show("RealField(%d)(%s).__rpow__(F(%s))" % (p, e, b), lambda: R(e).__rpow__(F(b)))
            show("F(%s)**RealField(%d)(%s)" % (b, p, e), lambda: F(b) ** R(e))
