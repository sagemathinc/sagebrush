% psi, beta, betaln, erfcx, erfinv, erfcinv and expint: the examples on
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
