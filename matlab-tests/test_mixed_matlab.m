% Mixed single and double operands as MATLAB documents them: the single operand
% is converted to double, the operation is done in double, and only the result
% is made single (MATLAB's documentation: matlab_prog/floating-point-numbers,
% "Intermediate Conversions", and, for binary elementwise operations in general,
% coder/ug/expected-differences-in-behavior-after-compiling-your-matlab-code).
% Octave converts the double operand to single first instead, so its answers
% differ here; the expected values (test_mixed_matlab.matlab.out) follow
% MATLAB's rule, checked against the same rule computed with numpy's float32.
show(0.2 - single(0.2))
show(single(0.2) - 0.2)
show(-single(0.2) + 0.2)
show(0.2 + (-single(0.2)))
d = 2^-24 + 2^-50;
show(single(1) + d)
show(single(1) - d)
show(single(1) .* (1 + d))
show(single([1 2; 3 4]) * [1 + d; 1])

% a single complex value times a double one: the parts are computed in double,
% then each part is made single once
a = single(complex(1.5, 1.5));
b = complex(1 + 2^-24, 1 - 2^-24);
show(real(a .* b))
show(imag(a .* b))
show(real(a * b))
show(real(b .* a))
% single times single is single arithmetic at each step
show(real(a .* single(b)))

% an integer combines only with its own class or with double
try, int8(3) + single(1.5), catch e, disp(e.message), end
try, single(1.5) .* uint16(2), catch e, disp(e.message), end
show(int8(3) + 1.5)

% comparisons do not lose precision to a conversion (MATLAB's documentation:
% ref/double.eq and ref/double.lt, Input Arguments): a single is compared as the
% double it exactly is. int64 values are exact in double below 2^53, and
% Sagebrush refuses larger ones
show(single(0.1) == 0.1)
show(single(0.1) ~= 0.1)
show(single(0.1) > 0.1)
show(single(0.1) >= 0.1)
show(0.1 < single(0.1))
show(0.1 <= single(0.1))
show(single(0.5) == 0.5)
show(isequal(single(0.1), 0.1))
show(isequal(single(0.5), 0.5))
show(single(pi) == pi)
show(int64(2^52) + 1 == 2^52 + 1)
show(int64(2^52) + 1 > 2^52)
show([int64(1) int64(2)] < [1.5 1.5])
show(single(3) == int16(3))
try, x = intmax('int64') == 2^63, catch e, disp(e.message), end
