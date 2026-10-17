% Complex multiplication against Octave: every pair of values whose parts are
% drawn from {-Inf, -1, -0, 0, 1, Inf, NaN}, in double and single, through .*,
% a scalar *, prod (whose running product starts from 1) and cumprod (which
% starts from the first value). The parts are printed as real arrays, so that
% each zero shows its sign.
v = [-Inf -1 -0 0 1 Inf NaN];
[re, im] = ndgrid(v, v);
Z = complex(re(:), im(:));
classes = {'double', 'single'};
for c = 1:2
  W = cast(Z, classes{c});
  A = repmat(W, 1, 49);
  B = repmat(W.', 49, 1);
  s = W(10);
  results = {A .* B, s * B, prod(cat(3, A, B), 3), cumprod(cat(3, A, B), 3)};
  results{4} = results{4}(:, :, 2);
  for r = 1:4
    X = results{r};
    Re = real(X);
    Im = imag(X);
    fprintf('%s %d %s\n', classes{c}, r, class(X));
    for k = 1:49
      show(Re(k, :))
      show(Im(k, :))
    end
  end
end

% overflow and underflow of the parts in single, as the parts are rounded at each step
s = single(complex(1e20, 1e20));
show(s .* s)
show(s .* conj(s))
show(cumprod([s s s]))
show(isreal(cumprod([s conj(s)])))
t = single(complex(1e-30, 1e-30));
show(t .* t)
show(cumprod([t t]))

% products of two written as a matrix literal, one row per pair, reduced along rows
% (the -0 parts of the literal's elements must survive the concatenation and double())
M = [complex(-1,-0) complex(-1,-0); complex(-0,-0) complex(-1,-0); complex(1,0) complex(-1,-0); ...
     complex(0,0) complex(-0,-0); complex(-0,-0) complex(1,-0); complex(1,1) complex(2,2)];
for X = {prod(M, 2), prod(double(M), 2), prod(single(M), 2), M(:, 1) .* M(:, 2)}
  show(real(X{1}).')
  show(imag(X{1}).')
end

% joining complex values keeps them complex, with their zero signs, though no imaginary part is nonzero
R = [complex(-1,-0) complex(1,-0)];
show(isreal(R))
show(1 ./ imag(R))
show(isreal([complex(1,0) 2]))
show(isreal([complex(1,0); 2]))
show(isreal(cat(3, complex(1,0), 2)))
show(isreal([2 3]))
% a matrix literal is made real only as a whole: its rows keep their zero signs when it is complex
M = [complex(-1,-0) complex(1,-0); complex(2,3) 4];
show(1 ./ imag(M(1, :)))
show(isreal([complex(-1,-0); complex(1,-0)]))
show(isreal([complex(1,0)]))
show(isreal(single([complex(1,0) 2])))
show(isreal([single(complex(1,0)) single(2)]))
show(isreal(horzcat(complex(1,0), 2)))
