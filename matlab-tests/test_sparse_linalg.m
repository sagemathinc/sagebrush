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

function sp(x)
fprintf('sparse=%d ', issparse(x));
show(full(x));
end
