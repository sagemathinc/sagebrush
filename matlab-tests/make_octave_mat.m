% Writes data/octave.mat with Octave (run by hand: octave-cli make_octave_mat.m);
% test_matfile.m loads it.  Values chosen to catch a transposed result.
A = [1 2 3; 4 5 6];
T = reshape(1:12, 2, 3, 2);
i8 = int8([-5 100; 7 -128]);
u16 = uint16([1 65535 3]);
s32 = single([1.5; -2.25]);
L = logical([1 0 1; 0 0 1]);
C = ['abc'; 'def'];
z = [1+2i, -3.5i; 4, 0];
cel = {1, 'two'; [1 2 3], {4, 'five'}};
st(1).name = 'Ada'; st(1).v = [1 2]; st(2).name = 'Bob'; st(2).v = 3;
e = [];
ec = '';
sp = sparse([3 2 3 4 1], [1 2 2 3 4], [1 2 3 4 5], 4, 4);
spz = sparse([1 2], [2 1], [1+2i, -3], 2, 3);
spe = sparse(3, 2);
save('-v7', 'data/octave.mat', 'A', 'T', 'i8', 'u16', 's32', 'L', 'C', 'z', 'cel', 'st', 'e', 'ec', 'sp', 'spz', 'spe');
% (a logical sparse matrix, as Octave writes one: class uint8 with ir, jc and pr;
% test/matlab.test.ts reads it, since Octave's own reading of it is not the matrix)
spl = sparse([1 0 1; 0 0 1]) > 0;
save('-v7', 'data/octave_sparse_logical.mat', 'spl');
