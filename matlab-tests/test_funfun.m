% Function functions: the solvers' results, to 10 digits (their last bits
% and their iteration counts depend on the algorithm).
r = @(x) round(x * 1e10) / 1e10 + 0;
% fzero, from a point and from an interval
show(r(fzero(@sin, 3)));
show(r(fzero(@cos, [1 2])));
show(r(fzero(@(x) x.^3 - 2*x - 5, 2)));
show(r(fzero(@(x) cos(2*x), 0.1)));
show(r(fzero(@(x) sin(cosh(x)), 1)));
show(r(fzero(@(x) exp(-exp(-x)) - x, [0 1])));
show(r(fzero(@(x) cosh(x) - 2*sinh(x), [-1 1])));
show(r(fzero(@(x) 1 ./ ((x - 0.3).^2 + 0.01) + 1 ./ ((x - 0.9).^2 + 0.04) - 6, [-1 1])));
show(r(fzero(@(x) 1 ./ ((x - 0.3).^2 + 0.01) + 1 ./ ((x - 0.9).^2 + 0.04) - 6, -0.2)));
show(r(fzero(@(x) x - 1e-3, 0)));
show(r(fzero(@(x) x.^2 - 4, [0 5])));
show(r(fzero(@(x) x.^2 - 4, [-5 0])));
show(r(fzero(@(x) x - 3, [3 7])));
show(r(fzero(@(x) x - 7, [3 7])));
show(r(fzero(@(x) atan(x) - 1, 100)));
show(r(fzero(@(x) exp(x) - 1e5, 1)));
[x, fval] = fzero(@(x) x - 2, [0 4]); show(r([x fval]));
show(r(fzero('sin', 3)));
show(r(fzero(@(x) x - 2, [0 4], optimset('TolX', 1e-3))) > 1.99);
show(class(fzero(@(x) x - 2, single([0 4]))));
show(class(fzero(@(x) single(x) - 2, [0 4])));
show(r(double(fzero(@(x) x.^2 - 2, single([0 2])))) - sqrt(2) < 1e-6);
% fminbnd (to 8 digits with a tight TolX: the default 1e-4 leaves the
% last digits to the method)
r8 = @(x) round(x * 1e8) / 1e8 + 0;
t = optimset('TolX', 1e-12);
show(r8(fminbnd(@sin, 0, 2*pi, t)));
show(r8(fminbnd(@(x) sin(x - 9/7), 1, 2*pi, t)));
show(r8(fminbnd(@(x) 1 ./ ((x - 0.3).^2 + 0.01) + 1 ./ ((x - 0.9).^2 + 0.04) - 6, 0.3, 1, t)));
show(r8(fminbnd(@(x) -tan(cos(x)), 3, 8, t)));
show(r8(fminbnd(@(x) (x - 2).^2 + 1, -10, 10, t)));
show(r8(fminbnd(@(x) x.^4 - 3*x.^3 + 2, 0, 5, t)));
show(r8(fminbnd(@(x) abs(x - 0.7), 0, 1, t)));
show(round(fminbnd(@(x) -x.*exp(-3*x), 0, 2, t) * 1e6) / 1e6);  % (a flat minimum: sqrt(eps) accuracy)
[x, fval] = fminbnd(@(x) cos(x), 2, 4, t); show(r8([x fval]));
show(r8(fminbnd(@(x) x.^2, 3, 3)));
show(abs(fminbnd(@sin, 0, 2*pi) - 3*pi/2) < 1e-4);
% fminsearch (to 6 digits with tight tolerances)
r6 = @(x) round(x * 1e6) / 1e6 + 0;
t = optimset('TolX', 1e-10, 'TolFun', 1e-12, 'MaxIter', 5000, 'MaxFunEvals', 10000);
show(r6(fminsearch(@(x) 100*(x(2) - x(1)^2)^2 + (1 - x(1))^2, [-1.2, 1], t)));
show(r6(fminsearch(@(x) 100*(x(2) - x(1)^2)^2 + (3 - x(1))^2, [-1, 1.9], t)));
show(r6(fminsearch(@(x) (x - 3)^2 + 1, 0, t)));
show(r6(fminsearch(@(x) sum((x - [1 2; 3 4]).^2, 'all'), zeros(2), t)));
show(r6(fminsearch(@(x) (x(1) - 1)^2 + 10*(x(2) + 2)^2 + abs(x(3)), [0; 0; 1], t)));
[x, fval] = fminsearch(@(x) exp(x(1)) * (4*x(1)^2 + 2*x(2)^2 + x(1)*x(2) + 2*x(2)), [-1 1], t); show(r6([x fval]));
