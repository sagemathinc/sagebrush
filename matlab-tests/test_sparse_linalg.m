% Sparse matrices: linear algebra, spdiags, spfun, sprand, 'like', cast,
% accumarray's sparse result, and matrix structure.  (Results that depend
% on the order of floating-point operations are rounded to 10 digits.)
r = @(x) round(x * 1e10) / 1e10 + 0;
S = sparse([3 2 3 4 1], [1 2 2 3 4], [1 2 3 4 5], 4, 4);
A = S + speye(4);
b = [1; 2; 3; 4];
% solving: full for a full right side, sparse for a sparse one
sp(r(A \ b)); sp(r(A \ speye(4))); sp(r(b' / A)); sp(r(inv(A))); sp(r(speye(3) \ [1; 2; 3]));
sp(r(sparse([4 1; 1 3]) \ [1; 2])); show(r(det(A))); show(trace(A));
% a large banded system, solved without the full matrix (x(i) = i (n + 1 - i) / 2)
n = 3e4;
e = ones(n, 1);
T = spdiags([-e 2 * e -e], -1:1, n, n);
x = T \ e;
show(issparse(x)); show(round([x(1) x(2) x(n / 2) x(n)])); show(norm(T * x - e, inf) < 1e-6);
T2 = spdiags([e 4 * e e 2 * e], [-2 0 1 3], n, n);
x2 = T2 \ e;
show(norm(T2 * x2 - e, inf) < 1e-9); show(nnz(T2)); show(bandwidth(T2, 'lower')); show(bandwidth(T2, 'upper'));
% factorizations: sparse
R = chol(sparse([4 1; 1 3])); sp(r(R));
[L, U, P] = lu(sparse([1 2; 3 4])); sp(r(L)); sp(r(U)); show(full(P));
Q = qr(sparse([4 1; 1 3])); show(issparse(Q));
sp(r(eig(sparse([2 1; 1 2]))));
% norms
show(norm(S, 1)); show(norm(S, inf)); show(r(norm(S, 'fro'))); show(r(norm(sparse([0 3 0 -4])))); show(norm(sparse([0 3 0 -4]), 1));
show(r(condest(A))); show(r(cond(full(A), 1)));
% spdiags
sp(spdiags([1 2 3; 4 5 6; 7 8 9]', [-1 0 1], 3, 3));
sp(spdiags([1 2 3; 4 5 6; 7 8 9]', [-1 0 1], 3, 4));
sp(spdiags([1 2 3; 4 5 6; 7 8 9]', [-1 0 1], 4, 3));
[B, d] = spdiags(S); sp(B); sp(d);
sp(spdiags(S, 0)); sp(spdiags(S, [-1 3]));
sp(spdiags([9; 9; 9; 9], 0, S));
% spfun, sprand's shape
sp(spfun(@exp, S)); sp(spfun(@(x) x - 1, S));
R = sprand(50, 40, 0.1); show(issparse(R)); show(size(R)); show(nnz(R) <= 200 && nnz(R) > 150);
show(all(nonzeros(R) > 0 & nonzeros(R) < 1));
R = sprand(S); show(isequal(spones(R), spones(S)));
R = sprandn(30, 30, 0.2); show(issparse(R)); show(size(R));
R = sprandsym(20, 0.3); show(issparse(R)); show(isequal(R, R'));
% 'like', cast
sp(cast(full(S), 'like', S)); sp(cast(S, 'double'));
% accumarray's sparse result
sp(accumarray([1 1; 2 2; 1 1], [1 2 3], [3 3], [], [], true));
% structure
show(issymmetric(S + S')); show(issymmetric(S)); show(isdiag(speye(3))); show(isdiag(S)); show(istril(tril(S)));
show(istril(S)); show(istriu(triu(S))); show(bandwidth(S, 'lower')); show(bandwidth(S, 'upper'));
show(isbanded(S, 2, 3)); show(isbanded(S, 1, 3)); show(ishermitian(sparse([1 2i; -2i 1])));
show(issymmetric([1 2; 2 1])); show(istril([1 0; 2 3])); show(bandwidth([1 2 0; 0 1 2; 0 0 1], 'upper'));

% nzmax's reservation lasts through assignment (and grows past it)
A = spalloc(4, 4, 6); n1 = nzmax(A); A(2, 3) = 7; n2 = nzmax(A); A(1, 1) = 0; n3 = nzmax(A); A(1:3, 1:3) = 1;
show([n1 n2 n3 nzmax(A)]);
% skew modes
show([ishermitian(sparse([0 1; -1 0])), ishermitian(sparse([0 1; -1 0]), 'skew'), ishermitian(sparse([0 1i; 1i 0]), 'skew'), issymmetric(sparse([0 1; -1 0]), 'skew')]);
% a density outside [0, 1] is refused
for d = [-0.1 1.1]
  try
    sprand(2, 2, d);
    disp('accepted');
  catch
    disp('refused');
  end
end
show(r(condest(sparse([4 1; 1 3]))));

% [C, R] = qr(S, B): C = Q'*B, and X = R\C solves S*X = B in the least-squares
% sense (R's signs are the factorization's own: compared through X and |C|)
S = sparse([1 0 2; 0 3 0; 4 0 5; 0 6 1; 7 0 0]);
b = [1; 2; 3; 4; 5];
[C, R] = qr(S, b, 'econ');
show(size(C)); show(size(R)); show(issparse(R)); show(issparse(C));
show(r(full(R \ C)));
show(r(norm(C)^2));
[C, R] = qr(S, b);
show(size(C)); show(size(R)); show(r(norm(C)^2));
[C, R] = qr(S, [b 2*b], 0);
show(r(full(R \ C)));
A = [1 2; 3 4; 5 6];
[Q, R] = qr(A, 0); show(size(Q)); show(size(R)); show(r(abs(R)));
[Q, R] = qr(A, 'econ'); show(size(Q)); show(size(R));
% the sparse LU in a fill-reducing column order (n > 4000, neither diagonal nor
% banded): a permuted 2-D Laplacian, the cross (tridiagonal plus the
% antidiagonal) and a complex arrow; logicals only: the backward error
% norm(A*x - b, 1) / (norm(A, 1) norm(x, 1) + norm(b, 1)) under 64 n eps
be = @(A, x, b) norm(A * x - b, 1) / (norm(A, 1) * norm(x, 1) + norm(b, 1));
k = 70; n = k * k; e = ones(k, 1);
T = spdiags([-e 2 * e -e], -1:1, k, k);
L2 = kron(speye(k), T) + kron(T, speye(k));
p = mod((0:n - 1) * 1999, n) + 1;
A = L2(p, p); b = (1:n)' / n;
x = A \ b;
show(issparse(x)); show(size(x)); show(be(A, x, b) < 64 * n * eps);
B = [b, 2 * b, ones(n, 1)]; X = A \ B;
show(size(X)); show(be(A, X(:, 1), B(:, 1)) < 64 * n * eps); show(be(A, X(:, 3), B(:, 3)) < 64 * n * eps);
y = A' \ b; show(be(A', y, b) < 64 * n * eps);
n = 5000; e = ones(n, 1);
C = spdiags([-e 4 * e -e], -1:1, n, n) + 0.5 * sparse(1:n, n:-1:1, 1, n, n);
x = C \ e; show(be(C, x, e) < 64 * n * eps);
Z = sparse([1:n, n * ones(1, n - 1), 1:n - 1], [1:n, 1:n - 1, n * ones(1, n - 1)], [(4 + 1i) * ones(1, n), ones(1, n - 1), 1i * ones(1, n - 1)], n, n);
x = Z \ e; show(isreal(x)); show(be(Z, x, e) < 64 * n * eps);
% just past the dense route (n = 4001: the sparse route by cost, band or LU;
% the n = 4000 side is a dense solve, too slow here, timed by M2's boundary
% probe), a 41-diagonal band, a complex band and a zero right-hand side
% (exactly zero); logicals only
n = 4001; e = ones(n, 1);
T = spdiags([-e 3 * e -e], -1:1, n, n);
x = T \ e; show(be(T, x, e) < 64 * n * eps);
R = T + sparse([n * ones(1, n - 1), 1:n - 1], [1:n - 1, n * ones(1, n - 1)], 0.25, n, n);
x = R \ e; show(be(R, x, e) < 64 * n * eps);
show(all(T \ zeros(n, 1) == 0));
W = spdiags([ones(n, 20), 50 * e, ones(n, 20)] ./ (1:41), -20:20, n, n);
x = W \ e; show(be(W, x, e) < 64 * n * eps); show(bandwidth(W, 'lower')); show(bandwidth(W, 'upper'));
Wc = spdiags([1i * e, (4 + 1i) * e, e], -1:1, n, n);
x = Wc \ (2 * e); show(isreal(x)); show(be(Wc, x, 2 * e) < 64 * n * eps);
function sp(x)
fprintf('sparse=%d ', issparse(x));
show(full(x));
end
