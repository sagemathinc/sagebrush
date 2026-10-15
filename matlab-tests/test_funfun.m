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
% lsqnonneg
C = [0.0372 0.2869; 0.6861 0.7071; 0.6233 0.6245; 0.6344 0.6170]; d = [0.8587; 0.1781; 0.0747; 0.8405];
[x, resnorm, residual] = lsqnonneg(C, d); show(r(x)); show(r(resnorm)); show(r(residual));
show(r(lsqnonneg([1 0; 0 1], [1; 2])));
show(r(lsqnonneg([1 0; 0 1], [-1; 2])));
show(r(lsqnonneg([1 2; 3 4; 5 6], [-1; -2; -3])));
show(r(lsqnonneg([1 2 3; 4 5 6; 7 8 10; 1 0 1], [1; -2; 3; 4])));
show(r(lsqnonneg(magic(5), [1; -1; 2; -2; 3])));
show(r(lsqnonneg([magic(4); 1 -1 1 -1], [10; -5; 3; 8; 0])));
show(r(lsqnonneg(hilb(6), [1; -1; 1; -1; 1; -1])));
show(r(lsqnonneg([1 1; 1 1], [1; 1])));
show(r(lsqnonneg([1 2 3], 4)));
show(r(lsqnonneg([2 -1 0; -1 2 -1; 0 -1 2; 1 1 1], [1; 0; -3; 2])));
[x, rn, res, ef, out, lambda] = lsqnonneg([1 2; 3 4; 5 6], [3; -1; 2]); show(r(x)); show(r(lambda));
% quad (to 8 digits with a tight tolerance)
show(r8(quad(@(x) 1./(x.^3 - 2*x - 5), 0, 2, 1e-12)));
show(r8(quad(@(x) exp(-x.^2), -3, 3, 1e-12)));
show(r8(quad(@(x) sin(x).^2, 0, pi, 1e-12)));
show(r8(quad(@(x) x.^5 - 3*x, 1, 4, 1e-12)));
show(r8(quad(@(x) exp(x), 1, 0, 1e-12)));
show(r8(quad(@(x) abs(x - 1/3), 0, 1, 1e-12)));
show(r8(quad(@(x) sqrt(x), 0, 1, 1e-12)));
show(r8(quad(@(x) log(1 + x) ./ (1 + x.^2), 0, 1, 1e-12)));
show(quad(@(x) x, 2, 2));
% integral and quadgk (to 10 digits with tight tolerances)
t = {'AbsTol', 1e-14, 'RelTol', 1e-12};
show(r(integral(@(x) exp(-x.^2).*log(x).^2, 0, Inf, t{:})));
show(r(integral(@(x) 1./(x.^3 - 2*x - 5), 0, 2, t{:})));
show(r(integral(@(x) log(x), 0, 1, t{:})));
show(r(integral(@(x) x.^5.*exp(-x).*sin(x), 0, Inf, t{:})));
show(r(integral(@(x) exp(-x.^2), -Inf, Inf, t{:})));
show(r(integral(@(x) 1./(1 + x.^2), -Inf, 0, t{:})));
show(r(integral(@(x) 1./sqrt(x), 0, 1, t{:})));
show(r(integral(@(x) abs(x - 0.3), 0, 1, 'Waypoints', 0.3, t{:})));
show(r(integral(@(x) exp(x), 1, 0, t{:})));
show(r(integral(@(z) 1./(2*z - 1), 0, 0, 'Waypoints', [1+1i, 1-1i], t{:})));
show(r(integral(@(x) sin((1:5)*x), 0, 1, 'ArrayValued', true, t{:})));
show(r(quadgk(@(x) exp(x).*log(x), 0, 1, t{:})));
show(r(quadgk(@(z) 1./(2.*z - 1), 1, 1, 'Waypoints', [1+1i 0+1i 0-1i 1-1i], t{:})));
show(r(quadgk(@(x) cos(x), 0, pi/2, 'Waypoints', [0.5 1], t{:})));
show(integral(@(x) x, 2, 2));
% integral2 and integral3 (to 8 digits with tight tolerances)
t = {'AbsTol', 1e-12, 'RelTol', 1e-10};
show(r8(integral2(@(x,y) 1./(sqrt(x+y).*(1+x+y).^2), 0, 1, 0, @(x) 1 - x, t{:})));
show(r8(integral2(@(x,y) 3*x.^2 + 5*y.^2, 0, 5, -5, 0, t{:})));
show(r8(integral2(@(x,y) exp(-x.^2 - y.^2), -Inf, Inf, -Inf, Inf, t{:})));
show(r8(integral2(@(x,y) x.*y, 0, 1, @(x) x.^2, @(x) sqrt(x), t{:})));
show(r8(integral3(@(x,y,z) y.*sin(x) + z.*cos(x), 0, pi, 0, 1, -1, 1, t{:})));
show(r8(integral3(@(x,y,z) x + y.*z, 0, 1, 0, @(x) x, 0, @(x,y) x + y, t{:})));
