% Single and integer classes kept, complex promotion of real elements, gamma's
% signed pole, and roots' empty column: cases where Octave's results are the
% ones MATLAB documents (or where its documentation is silent).

% trapz in single at each step: the pair sums, and the spacing factored out
show(trapz(single([1e8 1 -1e8])))
show(trapz(single([3e38 3e38])))
show(trapz(single([1 2 4])))
show(trapz(single(0.1), single([247360.9375 2310102.75 -9766948 -0.011645719408988953 8017.31884765625 8473543 -68189.4296875])))
show(trapz(single([0 0.5 2 3.25]), single([1e7 3 -1e7 0.1])))
show(trapz([0 0.5 2 3.25], single([1e7 3 -1e7 0.1])))
show(trapz(single([0 0.5 2 3.25]), [1e7 3 -1e7 0.1]))
% a scalar spacing X gives X*trapz(Y): finite where X times a pair sum overflows
% (the subnormal cases, where Octave departs from X*trapz(Y), are in test/matlab.test.ts)
show(trapz(single(1e38), single([2 2])))
show(trapz(1e38, single([2 2])))
show(trapz(1e308, [1 1]))
show(trapz(1e308, [1 1; 1 1]))
show(trapz(1e308, [1 1 1]))
show(trapz(1e-323, [1e300 1e300]))
show(trapz(0.1, [1 2 3 4 5 6 7]))
show(trapz([1e308 0 1e308]))
show(trapz(single([3e38 0 3e38])))
show(trapz(single([0 1e38]), single([2 2])))

% meshgrid keeps each coordinate vector's class
show(meshgrid(uint8(255)) + 1)
show(meshgrid(int8(127)) + 1)
show(meshgrid(single(1)) + 1e-8)
[X, Y] = meshgrid(single([1 2]), [3 4 5]);
show(X)
show(Y)

% real elements of an array made complex keep their own real results
show(imag(log2([-0 -1])))
a = asin([NaN 2]);
show(isnan(imag(a)))
show(imag(log1p([NaN -2])))
show(isnan(imag(acos(single([NaN 2])))))
show(isnan(imag(log10([NaN -10]))))
show(imag(sqrt([NaN -4])))

% gamma: the pole at -0 is -Inf; negative integers are Inf
show(gamma(-0))
show(gamma(single(-0)))
show(gamma([0 -1 -2]))

% polyfit of single data is single
show(polyfit(single([0 1]), single([1 3]), 1))
show(polyfit(single([0 1]), [1 3], 1) + 1e-8)
% S.R, the factor of x's Vandermonde matrix, and mu follow x's class
[p, s, m] = polyfit([0 1 2], single([1 3 4]), 1);
show({class(p), class(s.R), class(s.normr), class(m)})
[p, s, m] = polyfit(single([0 1 2]), [1 3 4], 1);
show({class(p), class(s.R), class(s.normr), class(m)})

% roots of a constant: an empty column
show(size(roots(1)))
show(size(roots([0 0 1])))
