% The values the search box's MATLAB examples make (lib/_matlab_examples.py),
% compared with GNU Octave's (made by matlab-tests/doc_examples.py --octave).
% abs
clear
v = abs([-3 2 -1.5]);
show(v);
% sqrt
clear
v = sqrt([4 9 2]);
show(v);
% exp
clear
v = exp([0 1]);
show(v);
% log
clear
v = log([1 10]);
show(v);
% log10
clear
v = log10([10 1000 0.01]);
show(v);
% log2
clear
v = log2([8 0.5]);
show(v);
% hypot
clear
v = hypot(3, 4);
show(v);
% round
clear
v = round([2.5 -1.4 3.75]);
show(v);
% floor
clear
v = floor([-2.5 2.5]);
show(v);
% ceil
clear
v = ceil([-2.5 2.5]);
show(v);
% fix
clear
v = fix([-2.7 2.7]);
show(v);
% mod
clear
v = mod([7 -7], 3);
show(v);
% rem
clear
v = rem([7 -7], 3);
show(v);
% sign
clear
v = sign([-2 0 5]);
show(v);
% sin
clear
v = sin([0 pi/6 pi/2]);
show(v);
% cos
clear
v = cos([0 pi]);
show(v);
% tan
clear
v = tan(pi/4);
show(v);
% atan2
clear
v = atan2([1 -1], [1 -1]);
show(v);
% sind
clear
v = sind([30 90]);
show(v);
% cosd
clear
v = cosd([0 90 180 270]);
show(v);
% tand
clear
v = tand([-45 0 60]);
show(v);
% atan
clear
v = atan([-2 0 2]);
show(v);
% sec
clear
v = sec([0 pi/4]);
show(v);
% csc
clear
v = csc([pi/6 pi/2]);
show(v);
% cot
clear
v = cot([pi/8 pi/4]);
show(v);
% sinh
clear
v = sinh([-0.5 0 0.5]);
show(v);
% cosh
clear
v = cosh([0 0.5 1]);
show(v);
% tanh
clear
v = tanh([-2 0 2]);
show(v);
% asinh
clear
v = asinh([-2 0 2]);
show(v);
% expm1
clear
v = expm1([-1e-8 0 1e-8]);
show(v);
% factorial
clear
v = factorial([3 5]);
show(v);
% nchoosek
clear
v = nchoosek(6, 2);
show(v);
% gcd
clear
v = gcd(12, 18);
show(v);
% lcm
clear
v = lcm(4, 6);
show(v);
% primes
clear
v = primes(20);
show(v);
% isprime
clear
v = isprime([2 9 11]);
show(v);
% factor
clear
v = factor(84);
show(v);
% real
clear
v = real(3 - 4i);
show(v);
% imag
clear
v = imag(3 - 4i);
show(v);
% conj
clear
v = conj(3 - 4i);
show(v);
% angle
clear
v = angle(1i);
show(v);
% complex
clear
v = complex(2, 5);
show(v);
% logspace
clear
v = logspace(-2, 1, 4);
show(v);
% flip
clear
v = flip([2 5 1; 7 4 9], 2);
show(v);
% permute
clear
v = permute(reshape(1:12, 2, 3, 2), [2 1 3]);
show(v);
% squeeze
clear
v = squeeze(reshape(1:6, 1, 2, 3));
show(v);
% repelem
clear
v = repelem([3 -2 5], [1 3 2]);
show(v);
% cummin
clear
v = cummin([8 3 5 2 6]);
show(v);
% cummax
clear
v = cummax([2 5 1 7 4]);
show(v);
% bounds
clear
[lo, hi] = bounds([2 9; -3 4; 7 1]);
show(lo);
show(hi);
% true
clear
v = true(2, 3);
show(v);
% false
clear
v = false(3, 1);
show(v);
% nan
clear
v = nan(1, 3);
show(v);
% NaN
clear
v = NaN(2, 1);
show(v);
% inf
clear
v = inf(1, 2);
show(v);
% Inf
clear
v = Inf(2, 1);
show(v);
% zeros
clear
v = zeros(2, 3);
show(v);
% ones
clear
v = ones(2);
show(v);
% eye
clear
v = eye(3);
show(v);
% magic
clear
v = magic(3);
show(v);
% linspace
clear
v = linspace(0, 1, 5);
show(v);
% colon
clear
v = colon(1, 2, 9);
show(v);
% repmat
clear
v = repmat([1 2], 2, 2);
show(v);
% reshape
clear
v = reshape(1:6, 2, 3);
show(v);
% transpose
clear
v = transpose([1 2 3]);
show(v);
% cat
clear
v = cat(1, [1 2], [3 4]);
show(v);
% horzcat
clear
v = horzcat([1 2], [3 4 5]);
show(v);
% vertcat
clear
v = vertcat([1 2], [3 4]);
show(v);
% diag
clear
v = diag([4 5 6]);
show(v);
% fliplr
clear
v = fliplr([1 2 3]);
show(v);
% flipud
clear
v = flipud([1; 2; 3]);
show(v);
% rot90
clear
v = rot90([1 2; 3 4]);
show(v);
% circshift
clear
v = circshift(1:5, 2);
show(v);
% tril
clear
v = tril(magic(3));
show(v);
% triu
clear
v = triu(magic(3));
show(v);
% kron
clear
v = kron([1 2], [1; 10]);
show(v);
% size
clear
v = size(zeros(2, 5));
show(v);
% numel
clear
v = numel(magic(4));
show(v);
% length
clear
v = length(zeros(3, 7));
show(v);
% ndims
clear
v = ndims(ones(2, 3, 4));
show(v);
% isempty
clear
v = isempty([]);
show(v);
% find
clear
v = find([0 4 0 7]);
show(v);
% any
clear
v = any([0 0 1]);
show(v);
% all
clear
v = all([1 1 0]);
show(v);
% cumsum
clear
v = cumsum(1:5);
show(v);
% cumprod
clear
v = cumprod([1 2 3 4]);
show(v);
% diff
clear
v = diff([1 4 9 16]);
show(v);
% sum
clear
v = sum([1 2; 3 4]);
show(v);
% prod
clear
v = prod([1 2 3 4]);
show(v);
% max
clear
[m, k] = max([3 9 4]);
show(m);
show(k);
% min
clear
v = min([4 2 8; 1 5 3]);
show(v);
% sort
clear
[s, k] = sort([3 1 2], 'descend');
show(s);
show(k);
% unique
clear
v = unique([3 1 3 2 1]);
show(v);
% ismember
clear
v = ismember([1 5 2], [2 3 1]);
show(v);
% intersect
clear
v = intersect([1 2 3 4], [3 4 5]);
show(v);
% union
clear
v = union([1 3], [2 3]);
show(v);
% setdiff
clear
v = setdiff([1 2 3 4], [2 4]);
show(v);
% mean
clear
v = mean([2 4 9]);
show(v);
% median
clear
v = median([5 1 3 2]);
show(v);
% mode
clear
v = mode([1 2 2 3 3 3]);
show(v);
% std
clear
v = std([2 4 4 4 5 5 7 9]);
show(v);
% var
clear
v = var([1 2 3 4]);
show(v);
% det
clear
v = det([1 2; 3 4]);
show(v);
% inv
clear
v = inv([1 2; 3 4]);
show(round(v * 1e12) / 1e12);
% rank
clear
v = rank(magic(4));
show(v);
% trace
clear
v = trace(magic(3));
show(v);
% mldivide
clear
v = mldivide([4 -2; 1 1], [2; 3]);
show(v);
% eig
clear
v = eig([2 0; 0 3]);
show(v);
% norm
clear
v = norm([3 4]);
show(v);
% dot
clear
v = dot([1 2 3], [4 5 6]);
show(v);
% cross
clear
v = cross([1 0 0], [0 1 0]);
show(v);
% polyval
clear
v = polyval([1 2 3], 2);
show(v);
% roots
clear
v = roots([1 -3 2]);
show(v);
% conv
clear
v = conv([1 1], [1 -1]);
show(v);
% polyfit
clear
p = polyfit([0 1 2], [1 3 5], 1);
show(round(p * 1e12) / 1e12);
% interp1
clear
v = interp1([1 2 3], [10 20 30], [1.5 2.5]);
show(v);
% trapz
clear
v = trapz([1 2 3]);
show(v);
% class
clear
v = class(int8(1));
show(v);
% double
clear
v = double(int8(-3)) / 2;
show(v);
% uint8
clear
v = uint8([-5 100 300]);
show(v);
% int32
clear
v = int32([2.5 -2.5]);
show(v);
% logical
clear
v = logical([2 0 -1]);
show(v);
% isnan
clear
v = isnan([1 NaN 3]);
show(v);
% isinf
clear
v = isinf([1 Inf -Inf]);
show(v);
% isequal
clear
v = isequal([1 2], [1 2]);
show(v);
% num2str
clear
v = num2str(pi, 4);
show(v);
% str2double
clear
v = str2double('3.25') * 2;
show(v);
% sprintf
clear
v = sprintf('%d-%d', 3, 4);
show(v);
% mat2str
clear
v = mat2str([1 2; 3 4]);
show(v);
% strcat
clear
v = strcat('ab', 'cd');
show(v);
% strsplit
clear
v = strsplit('a,b,c', ',');
show(v);
% strjoin
clear
v = strjoin({'a', 'b', 'c'}, '-');
show(v);
% strrep
clear
v = strrep('hello', 'l', 'L');
show(v);
% upper
clear
v = upper('abc');
show(v);
% lower
clear
v = lower('ABC');
show(v);
% strtrim
clear
v = strtrim('  hi  ');
show(v);
% strcmp
clear
v = strcmp('abc', 'abc');
show(v);
% regexprep
clear
v = regexprep('abc123', '\d', '#');
show(v);
% cellfun
clear
v = cellfun(@numel, {'ab', 'cde', ''});
show(v);
% arrayfun
clear
v = arrayfun(@(x) x^2, 1:4);
show(v);
% cell2mat
clear
v = cell2mat({1 2; 3 4});
show(v);
% num2cell
clear
v = num2cell([1 2]);
show(v);
% struct
clear
s = struct('a', 1, 'b', 'text');
show(s);
% fieldnames
clear
v = fieldnames(struct('a', 1, 'b', 2));
show(v);
% isfield
clear
v = isfield(struct('a', 1), {'a', 'b'});
show(v);
% plus
clear
v = [1 2 3] + 10;
show(v);
% minus
clear
v = [5 7] - [1 2];
show(v);
% uminus
clear
v = -[2 -3];
show(v);
% times
clear
v = [1 2 3] .* [4 5 6];
show(v);
% mtimes
clear
v = [1 2; 3 4] * [1; 1];
show(v);
% rdivide
clear
v = [6 8 9] ./ [3 2 4];
show(v);
% ldivide
clear
v = [2 4] .\ [6 8];
show(v);
% mrdivide
clear
v = [2 4] / 2;
show(v);
% power
clear
v = [1 2 3] .^ 2;
show(v);
% mpower
clear
v = [1 1; 0 1] ^ 3;
show(v);
% eq
clear
v = [1 2 3] == 2;
show(v);
% ne
clear
v = [1 2 3] ~= 2;
show(v);
% lt
clear
v = [1 5 3] < 3;
show(v);
% gt
clear
v = [1 5 3] > 3;
show(v);
% le
clear
v = [1 5 3] <= 3;
show(v);
% ge
clear
v = [1 5 3] >= 3;
show(v);
% and
clear
v = [1 0 1] & [1 1 0];
show(v);
% or
clear
v = [1 0 0] | [0 0 1];
show(v);
% not
clear
v = ~[1 0 2];
show(v);
% xor
clear
v = xor([1 0 1], [1 1 0]);
show(v);
% ctranspose
clear
v = [1+2i 3]';
show(v);
% lu
clear
[L, U, P] = lu([1 2; 3 4]);
show(L);
show(U);
show(P);
% chol
clear
v = chol([4 2; 2 3]);
show(v);
% svd
clear
v = svd([3 0; 0 4]);
show(v);
% pinv
clear
v = pinv([1 2; 2 4]);
show(v);
% expm
clear
v = expm([0 1; 0 0]);
show(v);
% cond
clear
v = cond([2 0; 0 0.5]);
show(v);
% linsolve
clear
v = linsolve([2 1; 1 3], [3; 5]);
show(round(v * 1e12) / 1e12);
% issymmetric
clear
v = issymmetric([1 2; 2 1]);
show(v);
% regexp
clear
v = regexp('a1b22c333', '\d+', 'match');
show(v);
% strfind
clear
v = strfind('abcabc', 'bc');
show(v);
% startsWith
clear
v = startsWith("report.txt", "rep");
show(v);
% endsWith
clear
v = endsWith({'a.m', 'b.txt'}, '.m');
show(v);
% strncmp
clear
v = strncmp('hello', 'help', 3);
show(v);
% strcmpi
clear
v = strcmpi('ABC', 'abc');
show(v);
% int2str
clear
v = int2str(2.7);
show(v);
% str2num
clear
v = str2num('[1 2 3]');
show(v);
% char
clear
v = char([72 105]);
show(v);
% blanks
clear
v = ['[' blanks(3) ']'];
show(v);
% deblank
clear
v = ['[' deblank('hi   ') ']'];
show(v);
% isspace
clear
v = isspace('a b');
show(v);
% isstrprop
clear
v = isstrprop('a1B', 'digit');
show(v);
% fliplr
clear
v = fliplr('abc');
show(v);
% regexprep
clear
v = regexprep('2024-01-05', '(\d+)-(\d+)-(\d+)', '$3/$2/$1');
show(v);
% isnumeric
clear
v = isnumeric([1 2]);
show(v);
% ischar
clear
v = ischar('abc');
show(v);
% iscell
clear
v = iscell({1, 'a'});
show(v);
% isstruct
clear
v = isstruct(struct('a', 1));
show(v);
% islogical
clear
v = islogical(true);
show(v);
% isreal
clear
v = isreal([1 2i]);
show(v);
% isscalar
clear
v = isscalar(5);
show(v);
% isvector
clear
v = isvector([1 2 3]);
show(v);
% isrow
clear
v = isrow([1 2 3]);
show(v);
% iscolumn
clear
v = iscolumn([1; 2]);
show(v);
% isa
clear
v = isa(int8(5), 'integer');
show(v);
% int8
clear
v = int8([100 200 -200]);
show(v);
% single
clear
v = single(1) / 3;
show(v);
% cast
clear
v = cast(3.7, 'int16');
show(v);
% intmax
clear
v = intmax('uint8');
show(v);
% intmin
clear
v = intmin('int16');
show(v);
% realmax
clear
v = realmax;
show(v);
% eps
clear
v = eps(1);
show(v);
% flintmax
clear
v = flintmax;
show(v);
% idivide
clear
v = idivide(int32(7), int32(2));
show(v);
% bitand
clear
v = bitand(12, 10);
show(v);
% bitor
clear
v = bitor(12, 10);
show(v);
% bitxor
clear
v = bitxor(12, 10);
show(v);
% bitshift
clear
v = bitshift(1, 4);
show(v);
% gamma
clear
v = gamma([1 5 0.5]);
show(round(v * 1e12) / 1e12);
% beta
clear
v = beta(2, 3);
show(v);
% erf
clear
v = erf([0 1]);
show(v);
% erfc
clear
v = erfc(1);
show(v);
% legendre
clear
v = legendre(2, 0.5);
show(v);
% expint
clear
v = expint(1);
show(v);
% gammainc
clear
v = gammainc(1, 2);
show(round(v * 1e12) / 1e12);
% gammainc
clear
v = gammainc([1 3], 2, 'upper');
show(round(v * 1e12) / 1e12);
% besselj
clear
v = besselj(0, 1);
show(round(v * 1e12) / 1e12);
% besselj
clear
v = besselj(1:3, 2.5);
show(round(v * 1e12) / 1e12);
% meshgrid
clear
[X, Y] = meshgrid(1:3, 1:2);
show(X);
show(Y);
% ndgrid
clear
[A, B] = ndgrid(1:2, 1:3);
show(A);
show(B);
% nnz
clear
v = nnz([1 0 2 0 3]);
show(v);
% isfinite
clear
v = isfinite([1 Inf NaN]);
show(v);
% sortrows
clear
v = sortrows([3 1; 1 2; 2 0]);
show(v);
% accumarray
clear
v = accumarray([1; 2; 1], [10; 20; 30]);
show(v);
% deal
clear
[a, b] = deal(7);
show(a);
show(b);
% cumsum
clear
v = cumsum([1 2; 3 4], 2);
show(v);
% abs
clear
v = abs(3 + 4i);
show(v);
% dec2bin
clear
v = dec2bin(10);
show(v);
% dec2bin
clear
v = dec2bin(5, 8);
show(v);
% bin2dec
clear
v = bin2dec('1010');
show(v);
% dec2hex
clear
v = dec2hex(255);
show(v);
% hex2dec
clear
v = hex2dec('FF');
show(v);
% sub2ind
clear
v = sub2ind([3 4], 2, 3);
show(v);
% ind2sub
clear
[r, c] = ind2sub([3 4], 8);
show(r);
show(c);
% mat2cell
clear
c = mat2cell([1 2 3 4], 1, [1 3]);
show(c);
