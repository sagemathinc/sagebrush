% Small programs of the kind numerical papers publish.
r = @(x) round(x * 1e8) / 1e8 + 0;

% 1-D heat equation, explicit finite differences
nx = 21; nt = 200;
dx = 1 / (nx - 1); dt = 0.4 * dx^2;
u = sin(pi * (0:nx-1) * dx);
for n = 1:nt
  un = u;
  u(2:end-1) = un(2:end-1) + dt / dx^2 * (un(3:end) - 2 * un(2:end-1) + un(1:end-2));
end
show(r(max(u)));
show(r(u(11)));

% Runge-Kutta 4 for y' = -2 t y, y(0) = 1
f = @(t, y) -2 * t * y;
h = 0.1; t = 0; y = 1;
for k = 1:10
  k1 = f(t, y);
  k2 = f(t + h/2, y + h/2 * k1);
  k3 = f(t + h/2, y + h/2 * k2);
  k4 = f(t + h, y + h * k3);
  y = y + h / 6 * (k1 + 2*k2 + 2*k3 + k4);
  t = t + h;
end
show(r(y));
show(r(abs(y - exp(-1))) < 1e-5);

% Newton's method for a system
F = @(x) [x(1)^2 + x(2)^2 - 4; x(1) - x(2)];
J = @(x) [2*x(1), 2*x(2); 1, -1];
x = [1; 0.5];
for it = 1:20
  dxn = -J(x) \ F(x);
  x = x + dxn;
  if norm(dxn) < 1e-12
    break
  end
end
show(r(x));
show(it < 20);

% bisection
g = @(x) x^3 - 2*x - 5;
a = 2; b = 3;
while b - a > 1e-10
  c = (a + b) / 2;
  if g(a) * g(c) <= 0
    b = c;
  else
    a = c;
  end
end
show(r((a + b) / 2));

% Gauss-Seidel
A = [4 -1 0; -1 4 -1; 0 -1 4];
rhs = [15; 10; 10];
xg = zeros(3, 1);
for sweep = 1:50
  for i = 1:3
    s = rhs(i) - A(i, [1:i-1, i+1:3]) * xg([1:i-1, i+1:3]);
    xg(i) = s / A(i, i);
  end
end
show(r(xg));

% sieve of Eratosthenes
N = 50;
isp = true(1, N);
isp(1) = false;
for p = 2:floor(sqrt(N))
  if isp(p)
    isp(p*p:p:N) = false;
  end
end
show(find(isp));

% word counts
text = 'the quick brown fox jumps over the lazy dog the end';
words = strsplit(text, ' ');
[uw, ~, idx] = unique(words);
counts = accumarray(idx(:), 1)';
show(uw);
show(counts);
[~, order] = sort(counts, 'descend');
show(uw{order(1)});

% a struct array of records
people = struct('name', {'Ann', 'Bob', 'Cy'}, 'age', {31, 25, 40});
ages = [people.age];
[~, oldest] = max(ages);
show(people(oldest).name);
show(mean(ages));
names = {people.name};
show(strjoin(sort(names), ', '));
for k = 1:numel(people)
  people(k).senior = people(k).age > 30;
end
show([people.senior]);

% matrix building and cumulative operations
M = zeros(4);
for i = 1:4
  for j = 1:4
    M(i, j) = 1 / (i + j - 1);
  end
end
show(r(M(2, :)));
show(r(sum(M(:))));
show(r(cumsum(1:5) ./ (1:5)));
P = pascal_like(5);
show(P);
show(fliplr(P(end, :)));

% string building
out = '';
for k = 1:5
  out = [out sprintf('%d^2=%d', k, k^2)];
  if k < 5
    out = [out ', '];
  end
end
show(out);

function P = pascal_like(n)
  P = ones(n);
  for i = 2:n
    for j = 2:n
      P(i, j) = P(i - 1, j) + P(i, j - 1);
    end
  end
end
