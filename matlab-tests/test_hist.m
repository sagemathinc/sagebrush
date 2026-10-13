% Binning: histcounts, discretize and histogram's edges.  Octave has none of
% these; the expected values are those MATLAB's documentation prints
% (histcounts, discretize).
[N, edges] = histcounts([2 3 5 7 11 13 17 19 23 29], 6)
[N, edges] = histcounts(primes(100), 'Normalization', 'probability')
Y = discretize([1 1 2 3 6 5 8 10 4 4], 2:2:10)
Y = discretize(1:2:11, [1 3 4 7 10 11], 'IncludedEdge', 'right')
Z = discretize(1:2:11, [1 3 4 7 10 11])
X = [5 30 55 80 100 1 26];
Y = discretize(X, 0:25:100, 25:25:100)
figure('visible', 'off');
h = histogram([2 3 5 7 11 13 17 19 23 29], 6);
disp(h.BinEdges)
disp(h.Values)
h = histogram(primes(100));
disp(h.BinEdges)
close all
