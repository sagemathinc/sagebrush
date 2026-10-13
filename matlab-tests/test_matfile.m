% .mat files: load what Octave saved (data/octave.mat, written by
% make_octave_mat.m, compressed -v7), and save then load again.
load data/octave.mat
show(A);
show(T);
show(i8);
show(u16);
show(s32);
show(L);
show(C);
show(z);
show(cel);
show(st);
show(e);
show(ec);
S = load('data/octave.mat');
show(sort(fieldnames(S))');
S2 = load('data/octave.mat', 'A', 'cel');
show(S2);
f = [tempname '.mat'];
x = magic(4)';
y = {1, 'a'; [2 3], {}};
q.a = int16([1 2]);
q.b = 'text';
r = [1+2i 3];
save(f, 'x', 'y', 'q', 'r');
clear x y q r
load(f);
show(x);
show(y);
show(q);
show(r);
w = 7;
save(f, 'w', '-append');
S3 = load(f);
show(sort(fieldnames(S3))');
delete(f);
