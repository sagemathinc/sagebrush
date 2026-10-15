% psi, beta, betaln, erfcx, erfinv, erfcinv, expint, gammainc, besselj and bessely: the examples on
% their documentation pages and values across their ranges, to 10
% significant digits (the last digits of special functions differ between
% implementations; test/matlab.test.ts checks the precision, and the
% values for tiny erfcinv arguments, where Octave's are less accurate).
p(-psi(1)); p(psi(1, 2)); p(pi^2/6 - 1);
p(beta((1:10)', 3)); p(betaln(510, 510));
p(erfcinv(0.3)); p(erfcinv([-10 0 0.5 1.3 2 Inf])); p(erfcinv([0.1 1.2; 1 0.9]));
p(erfinv(1 - 1e-100));
p(erfcx(5)); p(erfcx([-Inf -1 0 1 10 Inf])); p(erfcx([-0.5 15; 3.2 1])); p(erfcx(35));
p(erfinv(0.25)); p(erfinv([-2 -1 1 2])); p(erfinv([0 -0.5; 0.9 -0.2]));
p(expint(1+2i));
p(psi(0:0.5:3)); p(psi(3, [0.25 1 7.5])); p(psi(1, [1e-3 0.1 10 1e5])); p(psi(10, 2.5));
p(beta([0.5 2 30], [0.5 0.25 40])); p(beta(1e-3, 1e3)); p(betaln([1e-3 5 1e5], [2 1e3 1e5]));
p(erfcx([-26 -5 0.1 2 1e3 1e10]));
p(erfinv([-0.999 -0.3 1e-10 0.7 0.99999])); p(erfcinv([1e-5 0.01 1.5 1.99]));
p(expint([1e-8 0.5 3 30 -0.5 -3 -30 Inf -Inf]));
p(expint([1+1i; -2-0.1i; 0.5i; -40+20i; 100; 3-700i]));
p(beta(0, 0)); p(beta(0, 2)); p(betaln(0, 2)); p(expint(0)); p(psi(0));
fprintf('%s %s %s %s\n', class(psi(single(2))), class(beta(single(2), 3)), class(erfinv(single(0.5))), class(expint(single(-1))));
% gammainc: lower, upper and scaled, across the regions, and at 0
p(gammainc([0.05 0.5 1 2 5 10], 2)); p(gammainc([0.05 0.5 1 2 5 10], 2, 'upper'));
p(gammainc([1e-4 0.3 1.5 3], 1e-3)); p(gammainc([1e-4 0.3 1.5 3], 1e-3, 'upper'));
p(gammainc([90 100 110], 100)); p(gammainc([90 100 110], 100, 'upper')); p(gammainc(1e4 + [-100 0 100], 1e4));
p(gammainc([0.01 0.5 3], 1.5, 'scaledlower')); p(gammainc([0.5 3 30], 1.5, 'scaledupper'));
p(gammainc([0 1 Inf], 2)); p(gammainc(0, [0 1])); p(gammainc([2; 7], [1.5; 6]));
p(gammainc(700, 50, 'upper')); p(gammainc(1e-3, 30));
p(gammainc([1000 2000], [1 2], 'scaledupper')); p(gammainc(1000, 0, 'scaledlower')); p(gammainc(1000, 0, 'scaledupper'));
p(gammainc(5e-324, [0.5 1])); p(gammainc(5e-324, 1, 'scaledlower')); p(gammainc(5e-324, 1, 'upper'));
fprintf('%s\n', class(gammainc(single(1), 2)));
% besselj: the page's examples, real orders across the regions, negative integer orders, scale
p(besselj(3, 0:5)); p(besselj(3, 0:5, 1)); p(besselj(0:4, 2.5)); p(besselj(0:4, 17.5));
p(besselj(0.3, [0.01 1 7 40 1000])); p(besselj(2.5, [0.5 5 50])); p(besselj(-3, [1 4 9]));
p(besselj(50, [10 45 50 55 100])); p(besselj(100, [1 90 110 1e4])); p(besselj(0, [1e5 1e6]));
p(besselj([0 1 2], 0)); p(besselj(0.5, 0));
fprintf('%s\n', class(besselj(single(1), 2)));
% bessely: the page's examples, real orders across the regions, negative orders, the values at 0,
% scale; and besselj at negative non-integer orders
p(bessely(3, 0:5)); p(bessely(3, 0:5, 1)); p(bessely(0:4, 2.5)); p(bessely(0:4, 17.5));
p(bessely(0.3, [1e-5 0.01 1 7 40 1000])); p(bessely(2.5, [0.5 5 50])); p(bessely(-3, [1 4 9]));
p(bessely(50, [10 45 50 55 100])); p(bessely(100, [90 110 1e4])); p(bessely(0, [1e5 1e6]));
p(bessely(-0.3, [0.5 2 30])); p(bessely(-2.5, [1 10])); p(bessely(-10.7, [3 20]));
p(bessely([0 1 -1 -2 -0.5 -0.3 -0.7], 0));
p(besselj(-0.3, [0.5 2 30])); p(besselj(-2.5, [1 10])); p(besselj(-10.7, [3 20])); p(besselj([-0.5 -0.3 -1.3], 0));
fprintf('%s\n', class(bessely(single(1), 2)));
p(double(psi(single(0.3))));

function p(x)
  x = x(:).';
  if isreal(x)
    fprintf(' %.10g', x);
  else
    fprintf(' %.10g%+.10gi', [real(x); imag(x) + 0]);
  end
  fprintf('\n');
end
