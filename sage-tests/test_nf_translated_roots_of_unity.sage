# Roots of unity and signatures of number fields whose generator is translated
# far, (x + M) for M = 2^1024 + 3: the roots past the doubles (their bits
# were u32::MAX, and w came out 0), against the same fields untranslated
x = polygen(QQ, 'x')
M = 2^1024 + 3
for name, f in [("x^2-2", x^2 - 2), ("x^2+1", x^2 + 1), ("x^3-2", x^3 - 2), ("x^3-x-1", x^3 - x - 1), ("x^4-x-1", x^4 - x - 1), ("x^2+3", x^2 + 3), ("x^4+1", x^4 + 1)]:
    for tn, g in [("", f), ("(x+M)", f(x + M)), ("(x-5)", f(x - 5))]:
        K = NumberField(g, 'a')
        print(name, tn, "|", K.number_of_roots_of_unity(), K.signature(), K.discriminant() == NumberField(f, 'b').discriminant())
