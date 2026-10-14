% Writes data/sagebrush.mat with Sagebrush (sagebrush --matlab make_sagebrush_mat.m);
% test_matfile_sagebrush.m reads it, and its expected output is Octave's, so
% Octave must be able to read what Sagebrush writes.
A = [1 2 3; 4 5 6];
T = reshape(1:12, 2, 3, 2);
i8 = int8([-5 100; 7 -128]);
s32 = single([1.5; -2.25]);
L = logical([1 0 1; 0 0 1]);
C = ['abc'; 'def'];
z = [1+2i, -3.5i; 4, 0];
cel = {1, 'two'; [1 2 3], {4, 'five'}};
st(1).name = 'Ada'; st(1).v = [1 2]; st(2).name = 'Bob'; st(2).v = 3;
e = [];
sp = sparse([3 2 3 4 1], [1 2 2 3 4], [1 2 3 4 5], 4, 4);
spz = sparse([1 2], [2 1], [1+2i, -3], 2, 3);
spe = sparse(3, 2);
save('data/sagebrush.mat', 'A', 'T', 'i8', 's32', 'L', 'C', 'z', 'cel', 'st', 'e', 'sp', 'spz', 'spe');
