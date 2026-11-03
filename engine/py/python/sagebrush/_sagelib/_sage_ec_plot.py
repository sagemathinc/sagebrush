"""Plotting an elliptic curve over QQ or RR (E.plot(), plot(E)): Sage
10.9's EllipticCurve_generic.plot, ported line by line.  Loaded on first
use, so the start doesn't carry it.
"""


def plot(E, xmin=None, xmax=None, components='both', **args):
    """The real points of E, as Sage draws them (see
    EllipticCurve_rational_field.plot).

    EXAMPLES::

        sage: import _sage_ec_plot
        sage: _sage_ec_plot.plot(EllipticCurve([0, -1]))
        Graphics object consisting of 1 graphics primitive
    """

    import math
    from _sage_ec import _real_roots_in
    if components not in ['both', 'bounded', 'unbounded']:
        raise ValueError("component must be one of 'both', 'bounded' or 'unbounded'")
    a1, a2, a3, a4, a6 = (float(a) for a in E._a)
    b2, b4, b6, b8 = (float(b) for b in E.b_invariants())

    def roots(c):
        # the real roots, ascending, of c[0] + c[1] x + ... (floats)
        while len(c) > 1 and c[-1] == 0:
            c = c[:-1]
        B = 1 + max(abs(t) for t in c[:-1]) / abs(c[-1]) if len(c) > 1 else 1
        return sorted(_real_roots_in(list(c), -B, B))

    d = [b6, 2 * b4, b2, 4.0]  # the 2-division polynomial, 4x^3 + b2 x^2 + 2 b4 x + b6

    def dz(z):
        return ((4.0 * z + b2) * z + 2 * b4) * z + b6

    def f1(z):
        return (-(a1 * z + a3) + math.sqrt(abs(dz(z)))) / 2

    def f2(z):
        return (-(a1 * z + a3) - math.sqrt(abs(dz(z)))) / 2

    r = roots(d)
    if components == 'bounded' and len(r) == 1:
        raise ValueError("no bounded component for this curve")
    if isinstance(xmin, (tuple, list)):
        if xmax is not None:
            raise ValueError("xmax must be None if xmin is a tuple")
        if len(xmin) != 2:
            raise ValueError("if xmin is a tuple it must have length 2")
        xmin, xmax = xmin
    if xmin is not None:
        xmin = float(xmin)
    if xmax is not None:
        xmax = float(xmax)
    if xmin is None or xmax is None:
        xmins = []
        xmaxs = []
        if components in ['both', 'bounded'] and len(r) > 1:
            xmins.append(r[0])
            xmaxs.append(r[1])
        if components == 'unbounded' or components == 'both' and (len(r) == 1 or r[2] - r[1] > 3 * (r[1] - r[0])):
            # the 3-division polynomial 3x^4 + b2 x^3 + 3 b4 x^2 + 3 b6 x + b8: the flex points
            flex = roots([b8, 3 * b6, 3 * b4, b2, 3.0])[-1]
            xmins.append(r[-1])
            xmaxs.append(flex + 2 * (flex - r[-1]))
        elif components == 'both':
            xmins.append(r[-1])
            # the horizontal tangents on the bounded component, scaled by 2.5
            if a1 == 0:
                ederiv = [a4, 2 * a2, 3.0]
            else:
                # y = (3x^2 + 2 a2 x + a4)/a1 in y^2 + a1 x y + a3 y - (x^3 + a2 x^2 + a4 x + a6)
                y = [a4 / a1, 2 * a2 / a1, 3.0 / a1]
                ederiv = [0.0] * 5
                for i in range(3):
                    for j in range(3):
                        ederiv[i + j] += y[i] * y[j]
                    ederiv[i + 1] += a1 * y[i]
                    ederiv[i] += a3 * y[i]
                for i, c in enumerate([a6, a4, a2, 1.0]):
                    ederiv[i] -= c
            critx = [a for a in roots(ederiv) if r[0] < a < r[1]]
            if not critx:
                raise RuntimeError("No horizontal tangent lines on bounded component")
            ymax = 2.5 * max([f1(a) for a in critx])
            ymin = 2.5 * min([f2(a) for a in critx])

            def branch(yv):
                # yv^2 + a1 x yv + a3 yv - (x^3 + a2 x^2 + a4 x + a6)
                return [yv * yv + a3 * yv - a6, a1 * yv - a4, -a2, -1.0]
            xmaxs.append(max(roots(branch(ymax)) + roots(branch(ymin))))
        xmins = min(xmins)
        xmaxs = max(xmaxs)
        span = xmaxs - xmins
        if xmin is None:
            xmin = xmins - .02 * span
        if xmax is None:
            xmax = xmaxs + .02 * span
    elif xmin >= xmax:
        raise ValueError("xmin must be less than xmax")

    I = []
    if components in ['unbounded', 'both'] and xmax > r[-1]:
        if xmin <= r[-1]:
            I.append((r[-1], xmax, '<'))
        else:
            I.append((xmin, xmax, '='))
    if components in ['bounded', 'both'] and len(r) > 1 and (xmin < r[1] or xmax > r[0]):
        if xmin <= r[0]:
            if xmax >= r[1]:
                I.append((r[0], r[1], 'o'))
            else:
                I.append((r[0], xmax, '<'))
        elif xmax >= r[1]:
            I.append((xmin, r[1], '>'))
        else:
            I.append((xmin, xmax, '='))

    from sage_plot import Graphics, line
    from _graphics import adaptive_sample
    g = Graphics()
    plot_points = int(args.pop('plot_points', 200))
    adaptive_tolerance = args.pop('adaptive_tolerance', 0.01)
    adaptive_recursion = args.pop('adaptive_recursion', 5)
    args.pop('randomize', None)

    def points(f, a, b):
        if a > b:
            # (Sage's generate_plot_points: no points over a reversed range, so
            # the line is empty, as plot(E, xmin=25, xmax=26)'s bounded part)
            return []
        xs, ys = adaptive_sample(f, a, b, plot_points, adaptive_tolerance, adaptive_recursion)
        return [(x, y) for x, y in zip(xs, ys) if y is not None]
    for a, b, shape in I:
        v = points(f1, a, b)
        w = points(f2, a, b)
        if shape == 'o':
            g += line(v + list(reversed(w)) + [v[0]], **args)
        elif shape == '<':
            g += line(list(reversed(v)) + w, **args)
        elif shape == '>':
            g += line(v + list(reversed(w)), **args)
        else:
            g += line(v, **args)
            g += line(w, **args)
    return g
