% A complex base to a scalar integer power, .^: every bit as Octave, including
% the signs of zero parts (numpy's power squares a + bi with imaginary part
% a b + b a, which is -0 for -3+0i; Octave's is +0), and 1 / that for a
% negative power by Smith's division.
z = [-3+0i, 1+2i, -0.7+1e-3i, 3e5-2e-4i, 0.3-0.9i, -2-0i, 1.1+0i, ...
     complex(-3, -0), complex(-0, 2), complex(0, -2), complex(-1.5, 0)];
for e = [-7 -3 -2 -1 2 3 4 5 17]
  w = z .^ e;
  fprintf('%d', e); fprintf(' %.17g %.17g', [real(w); imag(w)]); fprintf('\n');
  fprintf('%d', e); fprintf(' %d', 1 ./ real(w) > 0, 1 ./ imag(w) > 0); fprintf('\n');
end
% (1e-200+1e-200i) .^ -7, -3 and -2 overflow, where Octave's results are not the true
% values: those are in test/matlab.test.ts)
for e = [-1 2 3 4 5 17]
  w = (1e-200+1e-200i) .^ e;
  fprintf('%d %.17g %.17g %d %d\n', e, real(w), imag(w), 1 ./ real(w) > 0, 1 ./ imag(w) > 0);
end
w = power(z, 3);
fprintf(' %.17g %.17g', [real(w); imag(w)]); fprintf('\n');
% zero to a complex power with a positive real part
w = [0, complex(0, -0)] .^ complex(2, 1);
fprintf(' %.17g %.17g', [real(w); imag(w)]); fprintf('\n');
% sparse
C = sparse([1 2 4], [1 3 4], [1+2i, -3, 2i], 4, 4);
w = full(C .^ 2);
fprintf(' %.17g %.17g', [real(w(:))'; imag(w(:))']); fprintf('\n');
fprintf(' %d', 1 ./ imag(w(:))' > 0); fprintf('\n');
w = nonzeros(C) .^ -3;
fprintf(' %.17g %.17g', [real(w(:))'; imag(w(:))']); fprintf('\n');
