% Sparse matrices: arithmetic, comparisons, logic and elementwise functions,
% and which results stay sparse.
S = sparse([3 2 3 4 1], [1 2 2 3 4], [1 2 3 4 5], 4, 4);
F = full(S); F(1, 1) = 1;
L = S > 2;
C = sparse([1 2 4], [1 3 4], [1+2i, -3, 2i], 4, 4);
b = [1; 2; 3; 4];
v = sparse([0 3 0 -1]);
% + and -: sparse when both are
sp(S + S); sp(S - S); sp(S + F); sp(F + S); sp(F - S); sp(S + 1); sp(1 + S); sp(S - 1);
sp(-S); sp(+S); sp(-L); sp(C + S); sp(L + L); sp(L + 1); sp(S + true);
sp(S + sparse(true)); sp(S + v); sp(S + b);
sp(sparse([1 2], [1 2], [1 -1]) + sparse([1 2], [1 2], [-1 1]));
% .*: sparse when either is
sp(S .* S); sp(S .* F); sp(F .* S); sp(S .* 2); sp(2 .* S); sp(S .* 0); sp(S .* v); sp(S .* b);
sp(S .* [1 2 3 4]); sp(C .* S); sp(L .* L); sp(L .* S); sp(S .* true);
sp(times(S, F)); sp(plus(S, S)); sp(minus(S, 1));
% ./ and .^: sparse when the numerator (base) is
sp(S / 2); sp(S ./ 2); sp(S ./ F); sp(F ./ S); sp(2 ./ S); sp(S ./ -4);
sp(S .^ 2); sp(S .^ 0.5); sp(2 .^ S); sp(power(S, 2)); sp(C .^ 2);
% *: sparse for sparse times sparse or a scalar
sp(S * 2); sp(2 * S); sp(S * S); sp(S * F); sp(F * S); sp(S * b); sp(b' * S); sp(v * S); sp(S * v');
sp(C * S); sp(S * C); sp(L * L); sp(L * 2); sp(S * true); sp(S * [1 2; 3 4; 5 6; 7 8]);
sp(S ^ 2); sp(S ^ 0); sp(S ^ 1); sp(S ^ 3);
B = sparse([1 1e5], [1 1e5], [1 2], 1e5, 1e5);
% (large: never expanded)
show(nnz(B * B)); show(nnz(B + B)); show(nnz(B .* 3)); show(nnz(B > 1)); show(issparse(B'));
% comparisons: sparse logical
sp(S > 2); sp(S > 0); sp(S >= 0); sp(S == 0); sp(S ~= 0); sp(S < F); sp(S == S); sp(S > -1); sp(2 < S);
sp(C == 0); sp(C ~= 0); sp(S <= v); sp(S == 3);
% logic
sp(~S); sp(~L); sp(not(L)); sp(S & F); sp(S & L); sp(S | L); sp(S & 1); sp(L & true);
% elementwise functions: sparse
sp(abs(-S)); sp(abs(C)); sp(sqrt(S)); sp(sqrt(-S)); sp(exp(S)); sp(cos(S)); sp(sin(S)); sp(log1p(S));
sp(round(S / 3)); sp(floor(S / 3)); sp(ceil(S / 3)); sp(fix(-S / 3)); sp(sign(-S)); sp(real(C)); sp(imag(C));
sp(angle(C)); sp(mod(S, 2)); sp(rem(S, 2)); sp(isnan(S)); sp(isinf(S)); sp(atan2(S, F));
sp(double(L)); sp(logical(S)); sp(double(S)); sp(atan(S)); sp(sinh(S)); sp(tanh(S));
sp(sparse([1 NaN 0]) .* 2); sp(sparse([0 1]) .* [Inf 1]); sp(sparse([0 1]) ./ 0); sp(isnan(sparse([NaN 0 1])));

function sp(x)
fprintf('sparse=%d ', issparse(x));
show(full(x));
end
