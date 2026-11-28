# RR's finite values past the doubles (RR('1e400'), RR('1e-400')): a base
# of a logarithm, and the infinity predicates, next to the infinities, 0, 1
# and ordinary bases
def show(label, f):
    try:
        v = f(); print(label, "|", v, "|", v.parent())
    except Exception as e:
        print(label, "|", type(e).__name__)
for bs in ['1e400', '1e-400', '-1e400', '-1e-400', 'inf', '-inf', '0', '1', '10', '-10', '2.5e-310']:
    b = RR(bs)
    show("CC(2).log(RR(%s))" % bs, lambda: CC(2).log(b))
    show("CC(-3, 4).log(RR(%s))" % bs, lambda: CC(-3, 4).log(b))
    show("CC(0, 1).log(RR(%s))" % bs, lambda: CC(0, 1).log(b))
    show("RR(-2).log(RR(%s))" % bs, lambda: RR(-2).log(b))
    show("RR(2).log(RR(%s))" % bs, lambda: RR(2).log(b))
for bs in ['1e400', '-1e400', '1e-400', '-1e-400', '2^1024', '-2^1024', 'inf', '-inf', '1', '0', 'nan']:
    x = RR(bs) if not bs.startswith(('2', '-2')) else RR(sage_eval(bs))
    print(bs, "|", x.is_infinity(), x.is_positive_infinity(), x.is_negative_infinity(), x.is_NaN(), x.is_zero())
