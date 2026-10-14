% MATLAB's random numbers: rand, randn (its ziggurat), randi and their classes,
% after rng default, rng(0), rng(42) and rng(1), each value to 17 digits (num, below).
fprintf('%s\n', rand_default());
fprintf('%s\n', rand_zero());
fprintf('%s\n', seeded(0, @() num(randn(1, 2000))));
fprintf('%s\n', seeded(0, @() num(rand(1, 2000))));
fprintf('%s\n', seeded(0, @() num(randi(6, 1, 1000))));
fprintf('%s\n', seeded(0, @() num(randi([-1e9 1e9], 1, 200))));
fprintf('%s\n', seeded(0, @() num(randi(2^40, 1, 50))));
fprintf('%s\n', rand_matrices());
fprintf('%s\n', rand_interleaved());
fprintf('%s\n', rand_classes());
fprintf('%s\n', rand_uses());

function s = num(x)
% a value exactly: class, size, then its elements in column-major order
% (doubles and singles to 17 significant digits; integers exactly; complex
% as real and imaginary parts)
sz = sprintf('%dx', size(x));
s = sprintf('%s %s\n', class(x), sz(1:end-1));
if isempty(x)
    return;
end
if isinteger(x)
    s = [s, sprintf('%d ', x(:)), newline];
elseif islogical(x) || ischar(x)
    s = [s, sprintf('%d ', double(x(:))), newline];
elseif isreal(x)
    s = [s, sprintf('%.17g ', double(x(:))), newline];
else
    s = [s, 're ', sprintf('%.17g ', double(real(x(:)))), newline, 'im ', sprintf('%.17g ', double(imag(x(:)))), newline];
end
end


function s = nums(varargin)
% several named values: nums('a', a, 'b', b, ...)
s = '';
for k = 1:2:numel(varargin)
    s = [s, '-- ', varargin{k}, newline, num(varargin{k + 1})]; %#ok<AGROW>
end
end


function s = seeded(seed, f)
rng(seed, 'twister');
s = f();
end


function s = rand_default()
rng('default');
a = rand(1, 5); b = randn(1, 5); c = randi(10, 1, 5);
s = nums('rand(1,5)', a, 'randn(1,5)', b, 'randi(10,1,5)', c);
end


function s = rand_zero()
rng(0);
a = rand(1, 10); b = randn(1, 10); c = randi(100, 1, 10); d = randi([-5 5], 1, 10);
s = nums('rand(1,10)', a, 'then randn(1,10)', b, 'then randi(100,1,10)', c, 'then randi([-5 5],1,10)', d);
end


function s = rand_matrices()
rng(42);
a = rand(3, 4); b = randn(3, 2); c = randi(9, 2, 3); d = rand(2, 2, 2);
s = nums('rand(3,4)', a, 'then randn(3,2)', b, 'then randi(9,2,3)', c, 'then rand(2,2,2)', d);
end


function s = rand_interleaved()
rng(1);
a = rand; b = randn; c = rand; d = randi(10); e = randn; f = randn(1, 3); g = rand;
s = nums('rand', a, 'randn', b, 'rand', c, 'randi(10)', d, 'randn', e, 'randn(1,3)', f, 'rand', g);
end


function s = rand_classes()
rng(0);
a = rand(1, 4, 'single'); b = randn(1, 4, 'single'); c = randi(100, 1, 4, 'int8'); d = randi(5, 1, 4, 'uint16');
e = rand(1, 2, 'like', single(1)); f = randn(1, 2) + 1i * randn(1, 2);
s = nums('rand(1,4,single)', a, 'randn(1,4,single)', b, 'randi(100,1,4,int8)', c, 'randi(5,1,4,uint16)', d, ...
    'rand(1,2,like single)', e, 'complex randn', f);
end


function s = rand_uses()
rng(0);
a = rand(1, 20) < 0.3; b = 5 + 2 * randn(1, 5); c = floor(rand(1, 5) * 6) + 1; d = rand(3) * 10;
s = nums('rand(1,20) < 0.3', a, '5 + 2*randn(1,5)', b, 'floor(rand*6)+1', c, 'rand(3)*10', d);
end

