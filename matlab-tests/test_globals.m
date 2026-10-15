% Global variables: one value shared by every workspace that declares it,
% changed by a script or by any function, read back after each change.
global h count
h = 1;
bump(2);
show(h);
f = @(x) bump(x);
f(3);
show(h);
count = 0;
while count < 3
  tick();
end
show(count);
s = 0; for k = 1:4, tick(); s = s + count; end
show([s count]);
r = tock();
show([r count]);
h(2) = 5; bump(7);
show(h);
show(readh());
% (a global changed by a call partway through a statement: the same
% expression, a condition and its body, a catch after the call errs, a
% loop condition, an indexed, field and cell assignment, a switch case,
% a for loop's values)
global g
g = 1; x = setg(2) + g; show([x g]);
g = 1; if setg(2), show(g); end
g = 1; try, seterr(2); catch, x = g; end, show(x);
g = 1; k = 0; while setg(g + 1) < 4, k = k + 1; end, show([k g]);
g = [1 2 3]; setg([5 6 7]); g(2) = 0; show(g);
g = 1; switch setg(3), case g, show('new'); otherwise, show('stale'); end
g = 1; v = []; for t = [setg(2) g], v(end+1) = t; end, show(v);
g = struct('a', 1); setg(struct('a', 5)); g.b = 2; show([g.a g.b]);
g = {1}; setg({7}); g{2} = 3; show(g);
% (an anonymous function keeps the global's value when it is made; a call
% in the index or the value of an indexed, field or cell assignment that
% changes the global changes the value assigned into)
g = 1; setg(2); f = @() g; setg(3); show([f() g]);
g = [1 2 3]; g(2) = setg9(7); show(g);
g = [1 2 3]; g(idx(5)) = 4; show(g);
g = [1 2 3]; g(end) = setg9(7); show(g);
g = struct('a', 1); g.b = setgs(); show([g.a g.b]);
g = {1 2}; g{2} = setgc(); show(g);
function bump(x)
  global h
  h = [h x];
end
function tick()
  global count
  count = count + 1;
end
function r = tock()
  global count
  count = count * 10;
  r = count;
  helper();
  r = [r count];
end
function helper()
  global count
  count = -1;
end
function v = readh()
  global h
  v = numel(h);
end
function r = setg(v)
  global g
  g = v; r = v;
end
function seterr(v)
  global g
  g = v; error('boom');
end
function r = setg9(v)
  global g
  g = v; r = 9;
end
function i = idx(v)
  global g
  g = [10 20]; i = 1;
end
function r = setgs()
  global g
  g = struct('a', 5); r = 6;
end
function r = setgc()
  global g
  g = {7}; r = 8;
end
