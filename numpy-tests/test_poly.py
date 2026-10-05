import numpy as np
def show(name, x, digits=9):
    x = np.asarray(x)
    print(name, x.shape, x.dtype, (np.round(np.real(x), digits) + 0.0).tolist(), (np.round(np.imag(x), digits) + 0.0).tolist() if x.dtype.kind == "c" else "")
x = np.linspace(0, 3, 20)
y = 2 * x ** 2 - 3 * x + 1 + 0.01 * np.sin(7 * x)
show("polyfit", np.polyfit(x, y, 2)); show("polyfit1", np.polyfit(x, y, 1)); show("polyfit w", np.polyfit(x, y, 2, w=np.linspace(1, 2, 20)))
show("polyval", np.polyval([1, -2, 1], [0, 1, 2, 3])); show("polyval s", np.polyval([3, 0, 1], 2.0))
show("roots", np.sort_complex(np.roots([1, -6, 11, -6]))); show("roots c", np.sort_complex(np.roots([1, 0, 1]))); show("roots z", np.roots([1, 0, 0]))
show("poly", np.poly([1, 2, 3])); show("polyder", np.polyder([1, 2, 3, 4])); show("polyint", np.polyint([3, 2, 1])); show("polymul", np.polymul([1, 1], [1, -1]))
show("polyadd", np.polyadd([1, 2], [1, 2, 3])); q, r = np.polydiv([1, -3, 2], [1, -1]); show("polydiv q", q); show("polydiv r", r)
p = np.poly1d([1, -3, 2])
print(repr(p), p.order, p(2), repr(p.roots), repr(p.deriv()), repr(p * p), repr(p + 1), p[0], p[2])
show("vander", np.vander(np.array([1, 2, 3]))); show("vander inc", np.vander(np.array([1.5, 2]), 3, increasing=True))
np.testing.assert_allclose(np.polyval(np.polyfit(x, y, 2), x), y, atol=0.05)
np.testing.assert_array_equal(np.arange(3), [0, 1, 2])
np.testing.assert_almost_equal(np.pi, 3.1415926, decimal=6)
try:
    np.testing.assert_allclose([1.0, 2.0], [1.0, 2.1])
except AssertionError:
    print("assert_allclose raised")
print("done")
