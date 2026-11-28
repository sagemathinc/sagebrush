# Derivative counts as Sage takes them (Codex audit A07b F1): a count past a
# C long or a C int, a negative one, and a non-integer are refused, never
# defaulted to 1 or clamped; variable-and-count specs.
var('x y')
def show(label, f):
    try:
        print(label, f())
    except Exception as e:
        print(label, type(e).__name__, e)

show("2^63", lambda: diff(x, x, 9223372036854775808))
show("2^64", lambda: diff(x^2, x, 18446744073709551616))
show("2^63-1", lambda: diff(x^3, x, 9223372036854775807))
show("2^31", lambda: diff(x^3, x, 2147483648))
show("2^31-1", lambda: diff(x^3, x, 2147483647))
show("-1", lambda: diff(x, x, -1))
show("0", lambda: diff(x^2, x, 0))
show("x,2,y", lambda: diff(x^2*y^3, x, 2, y))
show("x,y,2", lambda: diff(x^2*y^3, x, y, 2))
show("x,1,y,1", lambda: diff(x^3*y, x, 1, y, 1))
show("sin 4", lambda: diff(sin(x), x, 4))
show("method", lambda: (x^5).diff(x, 3))
