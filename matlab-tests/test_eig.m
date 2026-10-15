% eig with B, options and left eigenvectors: values to 10 digits, vectors
% through their residuals and normalization (they are determined only up
% to sign or scale)
r = @(x) round(x * 1e10) / 1e10 + 0;
T = [2 -1 0; -1 2 -1; 0 -1 2]; Bs = [4 1 0; 1 4 1; 0 1 4];
show(r(eig(T, Bs)));
show(r(eig(T, Bs, 'chol')));
[V, D] = eig(T, Bs); show(r(diag(D))); show(norm(T*V - Bs*V*D) < 1e-12); show(norm(V'*Bs*V - eye(3)) < 1e-12);
A = [1 2; 3 4]; B = [2 0; 0 1];
show(r(sort(eig(A, B))));
[V, D] = eig(A, B); show(norm(A*V - B*V*D) < 1e-12);
A = [1/sqrt(2) 0; 0 1]; B = [0 1; -1/sqrt(2) 0];
show(r(sort(imag(eig(A, B)))));
A = [1 7 3; 2 9 12; 5 22 7];
[V, D, W] = eig(A); show(r(sort(diag(D)))); show(norm(W'*A - D*W') < 1e-12); show(r(sqrt(sum(abs(W).^2))));
[V, D, W] = eig(T); show(norm(W'*T - D*W') < 1e-12);
show(size(eig(T, 'matrix'))); [V, D] = eig(T, 'vector'); show(size(D));
show(r(sort(eig(magic(4), 'nobalance'))'));
show(class(eig(single([1 2;3 4])))); show(class(eig(single([1 0;0 2]), single(eye(2)))));
[V, D] = eig(single([2 1;1 2])); show([class(V) ' ' class(D)]);
