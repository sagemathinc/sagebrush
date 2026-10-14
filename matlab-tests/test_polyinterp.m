% Polynomials (polyder, polyint, polyvalm) and piecewise polynomials (spline,
% pchip, ppval, mkpp, unmkpp), and interp2.  (Values to 10 digits.)
r = @(x) round(x * 1e10) / 1e10 + 0;
show(polyder([1 2 3 4])); show(polyder(5)); show(polyder([1 1], [1 -1]));
[q, d] = polyder([1 2], [1 -1]); show(q); show(d);
show(polyint([3 2 1])); show(polyint([3 2 1], 5)); show(polyint(4));
show(polyvalm([1 2 3], [1 2; 3 4])); show(polyvalm([1 0], eye(2)));
x = 0:5; y = sin(x);
show(r(spline(x, y, [0.5 2.5 4.75]))); show(r(spline(x, y, 6))); show(r(spline([0 1 2], [1 3 2], [0.5 1.5])));
show(r(spline([0 1], [2 4], 0.25))); show(r(spline(x, [1 y 0], [0.5 2.5])));
pp = spline(x, y); show(pp.form); show(pp.breaks); show(r(pp.coefs)); show(pp.pieces); show(pp.order); show(pp.dim);
show(r(ppval(pp, [0 1.5 5 5.5])));
show(r(pchip(x, y, [0.5 2.5 4.75]))); show(r(pchip([1 2 3 4], [1 1 2 2], [1.5 2.5 3.5])));
pp2 = pchip([1 2 3 4], [1 4 2 3]); show(r(pp2.coefs));
pp3 = mkpp([0 1 3], [1 0 0; 2 -1 4]); show(r(ppval(pp3, [0.5 1 2 3.5])));
[b, c, l, k, dd] = unmkpp(pp3); show(b); show(c); show([l k dd]);
show(r(spline(1:4, [1 2 3 4; 4 3 2 1], 2.5)));
[X, Y] = meshgrid(1:3, 1:4); V = X.^2 + Y;
show(r(interp2(X, Y, V, 1.5, 2.5))); show(r(interp2(X, Y, V, [1.5 2.5], [1.5 3.5])));
show(r(interp2(V, 2.2, 3.7))); show(r(interp2(V, 2.6, 1.2, 'nearest'))); show(isnan(interp2(V, 4, 1)));
show(r(interp2(V, 4, 1, 'linear', -1))); show(size(interp2(V))); show(r(interp2(V, 1)));
show(r(interp2(1:3, 1:4, V, 2.5, 2.5, 'spline')));
% (cubic convolution, not the spline; the spline extrapolates; decreasing grids)
V = [1 2 4 8; 2 3 7 9; 4 5 6 12; 8 7 10 15];
show(r(interp2(V, 2.3, 2.7, 'cubic'))); show(r(interp2(V, [1 3.9 4], [1 1.2 4], 'cubic'))); show(r(interp2(V, 1, 'cubic')));
show(isnan(interp2(V, 0.5, 2, 'cubic'))); show(r(interp2(10:-2:4, 1:4, V, 7.1, 2.2, 'cubic')));
show(r(interp2(V, 0.5, 2.7, 'spline'))); show(r(interp2(V, 0.5, 2.7, 'spline', -1)));
W = [1 4 9; 2 5 10; 3 6 11];
show(r(interp2([3 2 1], [3 2 1], W, 2.5, 2.5))); show(r(interp2([3 2 1], [1 2 3], W, [2.5 1.2], [2.5 2.9], 'nearest')));
show(r(interp2(1:4, 4:-1:1, V, 2.2, 3.1, 'spline'))); show(r(interp2(1:4, 4:-1:1, V, 2.2, 3.1)));
% (pchip of complex values)
show(r(pchip([1 2 3], [1+1i 2-1i 4+2i], 1.5))); pp = pchip([1 2 3], [1+1i 2-1i 4+2i]); show(r(ppval(pp, [1.2 2.8])));
