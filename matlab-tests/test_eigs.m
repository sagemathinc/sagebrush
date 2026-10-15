% eigs: eigenvalues to 10 digits (eigenvectors are determined only up to
% sign or scale, so they are checked through their residuals).  sigma is
% given by the names before R2017a and options as a structure, which the
% page lists too, since Octave knows only those.
r = @(x) round(x * 1e10) / 1e10 + 0;
n = 100; e = ones(n, 1);
T = spdiags([-e 2*e -e], -1:1, n, n);
L = kron(speye(12), spdiags(ones(12,1)*[-1 2 -1], -1:1, 12, 12)) + kron(spdiags(ones(12,1)*[-1 2 -1], -1:1, 12, 12), speye(12));
show(r(eigs(T, 5)));
show(r(sort(eigs(T, 4, 'sm'))));
show(r(eigs(T, 3, 'la')));
show(r(eigs(T, 3, 'sa')));
show(r(sort(eigs(T, 4, 1.5))));
show(r(eigs(L, 6)));
show(r(sort(eigs(L, 5, 'sm'))));
show(r(eigs(full(T), 3)));
show(r(eigs(diag(1:50), 4, 'sa')));
show(r(eigs(diag([1:20 -30]), 3)));
show(r(eigs(diag(1:10), 3)));
show(r(eigs(@(x) T*x, n, 3, 'lm', struct('issym', true))));
show(r(sort(eigs(@(x) T\x, n, 3, 'sm', struct('issym', true)))));
B = spdiags([e 4*e e], -1:1, n, n);
show(r(eigs(T, B, 3)));
show(r(sort(eigs(T, B, 3, 'sm'))));
% a nonsymmetric matrix with real eigenvalues 1..60 and complex pairs
U = triu(reshape(mod((1:3600)*7, 11), 60, 60) / 11, 1);
N = U + diag(1:60);
show(r(eigs(N, 4)));
show(r(eigs(sparse(N), 3, 'sm')));
show(r(eigs(N, 3, 30.4)));
R = [0 -5; 5 0]; C = blkdiag(R, 2*R, diag(1:20));
d = eigs(C, 4); show(r(sort(abs(d))));
d = eigs(C, 2, 'li', struct('p', 10)); show(r(sort(imag(d))));
% eigenvectors: residuals and normalization
[V, D, flag] = eigs(T, 4); show(flag); show(norm(T*V - V*D) < 1e-10); show(norm(V'*V - eye(4)) < 1e-12);
[V, D] = eigs(T, B, 3); show(norm(T*V - B*V*D) < 1e-10); show(r(diag(V'*B*V)'));
