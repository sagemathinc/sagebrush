% filter of empty data (MCF-17): y keeps x's size, and zf has
% max(length(a),length(b))-1 rows.  The expected output is real MATLAB's
% (R2026b Update 1, run by @sagebrush-matlab, Nov 5 2026).
show(filter(1, 1, []))
show(filter([1 1], 1, zeros(0, 3)))
show(filter(1, [1 -0.5], zeros(1, 0)))
[y, zf] = filter([1 1 1], 1, []);
show(y)
show(zf)
