% repmat(A, 1, 1), and the other all-ones forms, return a new array: assigning
% into the result leaves A unchanged (MATLAB's value semantics; Sagebrush's
% numpy tile returns a copy, never a view, for every count 1).
A = [1 2; 3 4];
B = repmat(A, 1, 1);
B(1) = 9;
show(A)
show(B)
C = repmat(A, [1 1]);
C(2, 2) = 8;
show(A)
D = repmat(A, 1);
D(end) = 7;
show(A)
E = repmat(A, 2, 1);
E(1) = 6;
show(A)
s = 'ab';
t = repmat(s, 1, 1);
t(1) = 'z';
show(s)
show(t)
c = {1, 2};
d = repmat(c, 1, 1);
d{1} = 5;
show(c{1})
show(d{1})
