% Wrong answers a sweep against Octave found: classes and values that must match

% diff keeps its input's class; an integer class saturates at each order
show(diff(uint8([1 0])))
show(diff(int8([-128 127])))
show(diff(int16([1 5 2]), 2))
show(diff(uint16([3; 1; 7])))
show(diff(single([1 2.5 4])))
show(diff([true false true]))
show(diff(int8([1 2]), 1, 1))

% complex numbers of equal magnitude sort by phase angle
% (shown by phase angle: how a zero part's sign is printed is not what is tested)
show(imag(sort([1i -1i])))
show(angle(sort([1 -1 1i -1i])))
show(imag(sort([1i -1i], 'descend')))
[s, k] = sort([2i -2 2 -2i]);
show(k)
show(angle(sort([1+1i; 1-1i; -1+1i; -1-1i])))
[s, k] = sort([3, 3i, -3, -3i], 'descend');
show(k)

% a negative imaginary zero keeps its sign, and with it the side of a branch cut
show(imag(log(complex(-1, -0))))
show(imag(sqrt(complex(-4, -0))))
show(angle(complex(-1, -0)))
show(1 ./ imag(complex(-1, -0)))
show(imag(log(complex(-1, 0))))
show(imag(complex([-1 -2], [-0 0])))

% logical median, min and max stay logical
show(median(logical([1 0 1])))
show(max(logical([1 0])))
show(min(logical([1 0])))
show(max(true, false))
show(min(logical([1 0; 1 1]), [], 2))

% single inputs give single results
show(conv(single(1), 1))
show(conv([1 2], single([1 1])))
show(polyval(single([1 2]), 2))
show(polyval([1 2], single(2)))
show(interp1(single([1 2]), [3 4], 1.5))
show(interp1([1 2], single([3 4]), 1.5))
show(interp1([1 2], [3 4], single(1.5)))
show(det(single(eye(2))))
show(inv(single(eye(2))))
show(norm(single([3 4])))

% min and max of complex numbers of equal magnitude: the phase angle decides
show(angle(min([1i -1i])))
show(angle(max([-1i 1i])))
[m, k] = max([1 -1]);
show(k)
[m, k] = min([1 -1 1i -1i]);
show(k)
show(angle(max([1+1i 1-1i; -1+1i -1-1i], [], 2)))

% complex components of single stay single
show(real(single(1+2i)))
show(imag(single(1+2i)))
show(conj(single(1+2i)))
show(angle(single(1i)))

% single sums and products accumulate in single
show(sum(single([1e8 1 -1e8])))
show(cumsum(single([1e8 1 -1e8])))
show(prod(single([1e-30 1e-30 1e30])))
show(cumprod(single([1e-30 1e-30 1e30])))
show(prod(single([1e30 1e30 1e-30])))
show(sum(single([1 2 3])))

% single inputs to vector, matrix and transform functions give single
show(dot(single([1 2]), single([3 4])))
show(dot([1 2], single([3 4])))
show(cross(single([1 0 0]), single([0 1 0])))
show(std(single([1 2])))
show(var(single([1 2])))
show(trace(single(eye(2))))
show(svd(single(eye(2))))
show(class(qr(single(eye(2)))))
show(chol(single(eye(2))))
[L, U] = lu(single(eye(2)));
show(class(L))
show(class(U))
show(eig(single([2 0; 0 3])))
show(kron(single(1), 1))
show(class(ifft(single([1 2]))))
show(real(ifft(single([1 2]))))

% a single option argument (a norm's p, a weight, a length, a dimension, a tolerance) does not
% make a double result single
show(norm([3 4], single(2)))
show(ifft([1 2], single(2)))
show(var([1 2 3], 0, single(2)))
show(std([1 2 3], 0, single(2)))
show(dot([1 2], [3 4], single(2)))
show(svd(eye(2), single(0)))

% var's and std's weight is data: a single weight gives single (the dimension above does not)
show(var([1 3], single(0)))
show(std([1 3], single(1)))

% chol's failure index stays double while R is single
[R, p] = chol(single(eye(2)));
show(R)
show(p)

% a NaN never wins the phase tie-break against a genuine infinity
show(min([complex(Inf, 0), complex(NaN, 1)]))
show(max([complex(-Inf, 0), complex(NaN, 1)]))
[m, k] = min([complex(NaN, 1), complex(Inf, 0), complex(-Inf, 0)]);
show(k)

% single complex products round each step to single: underflow to 0, overflow to Inf
v = single([1e-30 1e-30 1e30]);
show(prod(complex(v, v)))
w = single([1e30 1e30 1e-30]);
show(prod(complex(w, w)))

% each complex multiply rounds its four real products and two sums to single
s = single(complex(1e20, 1e20));
show(prod([s s]))
show(prod([s conj(s)]))
show(isnan(real(prod([s s]))))
% an infinite factor is recovered when both parts of the product come out NaN
show(prod([complex(Inf, Inf), 1]))
show(prod([complex(Inf, 0), complex(0, 1)]))
show(prod([complex(NaN, Inf), complex(2, 0)]))
show(prod(single([complex(Inf, Inf), 1])))
show(isreal(prod([s conj(s)])))
