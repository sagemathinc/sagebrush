# Newform methods (Sage mode), as Sage gives them.
f = Newforms(11, names="a")[0]
g = Newforms(27, names="b")[0]
h = Newforms(37, names="c")[0]
h2 = Newforms(37, names="c")[1]
def show(label, f):
    try:
        r = f()
        print(label, "->", repr(r), flush=True)
    except Exception as e:
        print(label, "->", ("%s: %s" % (type(e).__name__, str(e).split(chr(10))[0])).rstrip(), flush=True)
show('f.coefficient(7)', lambda: f.coefficient(7))
show('[f.coefficient(n) for n in range(1, 11)]', lambda: [f.coefficient(n) for n in range(1, 11)])
show('f.character()', lambda: f.character())
show('f.has_cm()', lambda: f.has_cm())
show('g.has_cm()', lambda: g.has_cm())
show('g.cm_discriminant()', lambda: g.cm_discriminant())
show('f.atkin_lehner_eigenvalue()', lambda: f.atkin_lehner_eigenvalue())
show('h.atkin_lehner_eigenvalue()', lambda: h.atkin_lehner_eigenvalue())
show('f.padded_list(6)', lambda: f.padded_list(6))
show('f.qexp(6)', lambda: f.qexp(6))
show('h2.atkin_lehner_eigenvalue()', lambda: h2.atkin_lehner_eigenvalue())
show('f.coefficients(5)', lambda: f.coefficients(5))
show('f.coefficient(1)', lambda: f.coefficient(1))
show('f.coefficient(0)', lambda: f.coefficient(0))
show('h.has_cm()', lambda: h.has_cm())
show('f.cm_discriminant()', lambda: f.cm_discriminant())
show('f.level()', lambda: f.level())
show('f.weight()', lambda: f.weight())
show('Newforms(121, names="e")[0].has_cm()', lambda: Newforms(121, names="e")[0].has_cm())
show('f.atkin_lehner_eigenvalue(11)', lambda: f.atkin_lehner_eigenvalue(11))
show('f.atkin_lehner_eigenvalue(2)', lambda: f.atkin_lehner_eigenvalue(2))
show('Newforms(15, names="x")[0].atkin_lehner_eigenvalue(3)', lambda: Newforms(15, names="x")[0].atkin_lehner_eigenvalue(3))
show('Newforms(15, names="x")[0].atkin_lehner_eigenvalue(5)', lambda: Newforms(15, names="x")[0].atkin_lehner_eigenvalue(5))
show('f.padded_list(0)', lambda: f.padded_list(0))
show('f.qexp()', lambda: f.qexp())
