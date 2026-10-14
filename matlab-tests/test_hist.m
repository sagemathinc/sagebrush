% Binning with given edges: discretize.  Octave has none of these; the
% expected values are those MATLAB's documentation prints.  (Automatic
% edges follow Sagebrush's own rules, and are tested in test/matlab.test.ts.)
Y = discretize([1 1 2 3 6 5 8 10 4 4], 2:2:10)
Y = discretize(1:2:11, [1 3 4 7 10 11], 'IncludedEdge', 'right')
Z = discretize(1:2:11, [1 3 4 7 10 11])
X = [5 30 55 80 100 1 26];
Y = discretize(X, 0:25:100, 25:25:100)
