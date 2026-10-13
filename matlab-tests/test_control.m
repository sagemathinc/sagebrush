% Control flow: if, for, while, switch, try, break, continue, functions.
total = 0;
for k = 1:10
  if mod(k, 2) == 0
    continue
  end
  if k > 7
    break
  end
  total = total + k;
end
show(total);
show(k);
n = 0;
while n < 5
  n = n + 2;
end
show(n);
for v = [1 2; 3 4]
  show(v);
end
for c = {1, 'two'}
  show(c);
end
for e = []
  show('never');
end
x = 7;
if x < 0
  show('negative');
elseif x < 5
  show('small');
else
  show('large');
end
for s = {'apple', 'kiwi', 'fig', 'plum'}
  switch s{1}
    case 'apple'
      show(1);
    case {'kiwi', 'fig'}
      show(2);
    otherwise
      show(3);
  end
end
switch 4
  case {1, 2}
    show('one or two');
  case 4
    show('four');
end
try
  error('my:id', 'Value %d is bad', 42);
catch err
  show(err.message);
  show(err.identifier);
end
try
  error('plain message');
catch err
  show(err.message);
end
try
  y = undefined_function_xyz(3);
catch
  show('caught');
end
try
  disp('in try');
catch err
  show('not reached');
end
result = fib(10);
show(result);
[q, r] = divmod(17, 5);
show([q r]);
[q2] = divmod(17, 5);
show(q2);
show(add3(1, 2));
show(add3(1));
show(count_args(1, 2, 3));
show(count_args());
[a, b, c] = multi();
show({a, b, c});
f = @(x, y) x + 2 * y;
show(f(1, 2));
g = @() 42;
show(g());
offset = 10;
h = @(x) x + offset;
offset = 100;
show(h(1));
compose = @(f1, f2) @(x) f1(f2(x));
inc = @(x) x + 1;
dbl = @(x) 2 * x;
k2 = compose(inc, dbl);
show(k2(5));
show(apply_twice(@(x) x ^ 2, 3));
show(cellfun(@(x) x * 2, {1, 2, 3}));
show(cellfun(@length, {'ab', 'cde', ''}));
show(cellfun('isempty', {[], 1, ''}));
show(cellfun(@(x) [x x], {1, 2}, 'UniformOutput', false));
show(arrayfun(@(x) x ^ 2, [1 2 3]));
show(arrayfun(@(x) {x}, [1 2], 'UniformOutput', false));
[mx, ix] = cellfun(@max, {[1 5 2], [7 3]});
show(mx);
show(ix);
sq = @sqrt;
show(sq(16));
show(feval(@plus, 2, 3));
show(feval('minus', 5, 3));
vals = zeros(1, 3);
for i = 1:3
  vals(i) = i * 10;
end
show(vals);
show(i);
acc = recursive_sum([1 2 3 4]);
show(acc);
show(nargin_demo(1, 2));

function r = fib(n)
  if n < 2
    r = n;
  else
    r = fib(n - 1) + fib(n - 2);
  end
end

function [q, r] = divmod(a, b)
  q = floor(a / b);
  r = a - q * b;
end

function s = add3(a, b, c)
  if nargin < 2
    b = 10;
  end
  if nargin < 3
    c = 100;
  end
  s = a + b + c;
end

function n = count_args(varargin)
  n = numel(varargin);
end

function varargout = multi()
  for k = 1:nargout
    varargout{k} = k * 11;
  end
end

function y = apply_twice(f, x)
  y = f(f(x));
end

function s = recursive_sum(v)
  if isempty(v)
    s = 0;
  else
    s = v(1) + recursive_sum(v(2:end));
  end
end

function s = nargin_demo(varargin)
  s = sprintf('%d inputs', nargin);
end
