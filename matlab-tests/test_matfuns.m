% Special matrices and matrix functions.  (Values to 10 digits where they
% depend on the eigendecomposition or the SVD.)
r = @(x) round(x * 1e10) / 1e10 + 0;
show(hilb(3)); show(hilb(1)); show(size(hilb(0)));
show(invhilb(4)); show(invhilb(6)); show(r(invhilb(4) * hilb(4)));
show(pascal(4)); show(pascal(4, 1)); show(pascal(4, 2)); show(pascal(5, 2)); show(pascal(1));
show(vander([1 2 3])); show(vander([2 -1 0 3])); show(vander([1 2], 4));
show(toeplitz([1 2 3])); show(toeplitz([1 2 3], [1 5 6 7])); show(toeplitz([1; 2; 3], [1 4])); show(toeplitz([1 2+1i 3]));
show(hankel([1 2 3])); show(hankel([1 2 3], [3 4 5 6])); show(hankel([1 2], [2 9 8]));
show(rosser()); show(wilkinson(5)); show(wilkinson(4)); show(wilkinson(1));
show(r(sqrtm([4 1; 1 3]))); show(r(sqrtm([4 0; 0 9]))); show(r(sqrtm([1 2; 3 4]))); show(r(sqrtm([2 1; 0 2]) ^ 2));
show(r(logm(eye(2) * 2))); show(r(logm([2 1; 1 2]))); show(r(expm(logm([1 0.5; 0.25 2]))));
show(r(funm([1 0; 0 2], @exp))); show(r(funm([2 1; 1 2], @cos)));
show(r(abs(orth([1 1; 1 1])))); show(size(orth([1 2; 2 4; 3 6]))); show(size(orth(zeros(3)))); show(r(abs(orth(eye(2)))));
show(r(rcond(magic(3)))); show(rcond([1 2; 2 4])); show(rcond(eye(3))); show(r(rcond([4 -2; 1 1])));
show(r(linsolve([4 -2; 1 1], [2; 3])));
show(r(sqrtm([2 1; 0 2]))); show(r(sqrtm([1 1 0; 0 1 1; 0 0 1]))); show(r(logm([2 1; 0 2]))); show(r(logm([1 1; 0 1])));
show(r(sqrtm([3 1; -1 1]))); show(r(logm([3 1; -1 1])));
% (linsolve's options change the equation: A', or one triangle of A)
o = struct('TRANSA', true); show(r(linsolve([1 2; 3 5], [7; 11], o)));
o = struct('LT', true); show(r(linsolve([2 9; 1 4], [2; 5], o)));
o = struct('UT', true, 'TRANSA', true); show(r(linsolve([2 1; 9 4], [2; 5], o)));
% (funm of a defective matrix: the Jordan block's derivatives)
show(r(funm([1 1; 0 1], @exp))); show(r(funm([1 1; 0 1], @cos))); show(r(funm([1 1; 0 1], @sin)));
show(r(funm([2 1; 0 2], @cosh))); show(r(funm([2 1; 0 2], @sinh))); show(r(funm([2 1; 0 2], @log)));
show(invhilb(9)); A = invhilb(12); show(A(6:7, 11:12));
show(magic(5)); show(magic(6)); show(magic(8)); show(magic(10)); show(magic(14)); show(sum(magic(18)) - sum(magic(18), 2)');
% (rcond, estimated: agrees with LAPACK's estimate, as Octave's rcond uses it)
r10 = @(x) round(x ./ 10.^floor(log10(abs(x))) * 1e9) / 1e9 .* 10.^floor(log10(abs(x)));
show(r10([rcond([4 -2 1; 3 6 -4; 2 1 8]) rcond(vander(1:6)) rcond(toeplitz([4 1 0 0 2])) rcond([1 2 3; 4 5 6; 7 8 10])]));
show(r10([rcond([2 -1 0 0; -1 2 -1 0; 0 -1 2 -1; 0 0 -1 2]) rcond(pascal(7)) rcond([1+2i 3; 4i 5-1i]) rcond(magic(6) + eye(6))]));
show(rcond(eye(3))); show(rcond(zeros(2)));
