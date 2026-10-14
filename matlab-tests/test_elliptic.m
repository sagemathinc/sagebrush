% ellipke, ellipj and legendre: the examples on their documentation pages
% and values across their ranges, to 10 significant digits (test/special.test.ts
% checks the precision, and the high orders next to +-1, where Octave's
% values are less accurate).
[K, E] = ellipke(0.5); p([K E]);
p(ellipke(0.904561)); p(ellipke(0.904561, eps*1000));
[K, E] = ellipke([0 0.1 0.5 0.9 0.99 1-1e-10 1]); p(K); p(E);
[s, c, d] = ellipj(0.5, 0.25); p([s c d]);
p(ellipj(0.253, 0.937));
[s, c, d] = ellipj(-5:2.5:5, 0.7); p(s); p(c); p(d);
[s, c, d] = ellipj([0.1 1 3 10 30], [0 0.3 0.99 1-1e-9 1]); p(s); p(c); p(d);
[s, c, d] = ellipj(2, [0.2; 0.8]); p(s); p(c); p(d);
p(legendre(2, 0:0.1:0.2)); p(size(legendre(2, 0:0.1:0.2)));
p(legendre(1, 0:0.2:1)); p(legendre(1, 0:0.2:1, 'sch')); p(legendre(1, 0:0.2:1, 'norm'));
p(legendre(3, [-1 -0.5 0 0.3 1])); p(legendre(0, [0.1 0.2]));
p(legendre(5, [-0.9 0.2; 0.7 0.999], 'norm')); p(size(legendre(5, [-0.9 0.2; 0.7 0.999])));
p(legendre(40, 0.31, 'sch')); Q = legendre(12, 0.999999); p(Q(1:8));
p(size(legendre(2, zeros(1, 0)))); p(size(legendre(2, [0.1; 0.2; 0.3])));

function p(x)
  x = x(:).' + 0;
  fprintf(' %.10g', x);
  fprintf('\n');
end
