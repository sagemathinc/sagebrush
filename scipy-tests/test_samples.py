# trapezoid, cumulative_trapezoid and simpson: SciPy's formulas, compared exactly.
import numpy as np
from scipy.integrate import trapezoid, cumulative_trapezoid, simpson

for n in [2, 3, 4, 5, 8, 11]:
    x = np.linspace(0, 2, n)
    y = np.sin(x) + x**2
    print(n, trapezoid(y), trapezoid(y, x), trapezoid(y, dx=0.25), simpson(y), simpson(y, x=x), simpson(y, dx=0.25))
    print(cumulative_trapezoid(y, x))
    print(cumulative_trapezoid(y, dx=0.5, initial=0))
x = np.array([0.0, 0.1, 0.35, 0.4, 0.9, 1.5, 1.6])
y = np.exp(x)
print(trapezoid(y, x), simpson(y, x=x), simpson(y[:-1], x=x[:-1]), cumulative_trapezoid(y, x, initial=0))
Y = np.arange(24.0).reshape(4, 6) ** 1.5
print(trapezoid(Y), trapezoid(Y, axis=0), simpson(Y), simpson(Y, axis=0), simpson(Y[:, :5], dx=0.5))
print(cumulative_trapezoid(Y, axis=0), cumulative_trapezoid(Y, axis=1, initial=0))
print(trapezoid([1, 2, 3]), trapezoid([1, 2, 3], [0, 1, 3]), simpson([1, 2, 3]), simpson([1, 4, 9, 16]))
xs = np.linspace(0, 1, 6)
print(trapezoid(Y[:, :6], xs), simpson(Y[:, :6], x=xs))
# complex samples and points stay complex
yc = np.array([1 + 2j, 3 + 4j, 5 + 6j, 2 - 1j])
print(trapezoid(yc), simpson(yc[:3]), simpson(yc), simpson([1, 2, 3], x=[0 + 1j, 1 + 2j, 2 + 3j]))
print(simpson(yc, x=[0.0, 0.5, 1.5, 2.0]), cumulative_trapezoid(yc), cumulative_trapezoid(yc, dx=0.5, initial=0))
print(cumulative_trapezoid(np.array([[1j, 2, 3], [4, 5j, 6]]), axis=0), cumulative_trapezoid(np.array([[1j, 2, 3], [4, 5j, 6]])))
try:
    cumulative_trapezoid([1.0, 2.0], initial=1)
except ValueError as e:
    print("ValueError", e)
