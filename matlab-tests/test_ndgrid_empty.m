% ndgrid of empty grid vectors, and of one vector with one output (MCF-22):
% each output is numel(x1)-by-numel(x2)-by-...  The ndgrid lines are real
% MATLAB's output (R2026b Update 1, run by @sagebrush-matlab, Nov 5 2026);
% the meshgrid and repmat lines (the same zero repetition) follow their pages.
% With one grid vector the number of outputs decides: one output is a column,
% n outputs are ndgrid(x,...,x) (real MATLAB, the same session).
[X, Y] = ndgrid([], 1);
show(X)
show(Y)
[X, Y] = ndgrid(1:2, []);
show(X)
show(Y)
[X, Y, Z] = ndgrid([], 1, 1:2);
show(X)
show(Y)
show(Z)
X = ndgrid([]);
show(X)
X = ndgrid(1:3);
show(X)
[X, Y] = ndgrid(1:3);
show(X)
show(Y)
X = ndgrid([1; 2; 3]);
show(X)
X = ndgrid(1:3, 1:2);
show(X)
[X, Y] = meshgrid([], 1);
show(X)
show(Y)
show(repmat([1 2], 0, 1))
