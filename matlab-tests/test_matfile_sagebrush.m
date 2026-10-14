% Read the .mat file Sagebrush wrote (data/sagebrush.mat, by make_sagebrush_mat.m).
% The expected output is Octave's reading of the same file.
S = load('data/sagebrush.mat');
show(S.A);
show(S.T);
show(S.i8);
show(S.s32);
show(S.L);
show(S.C);
show(S.z);
show(S.cel);
show(S.st);
show(S.e);
show([issparse(S.sp) issparse(S.spz) issparse(S.spe)]);
show(full(S.sp)); show(full(S.spz)); show(full(S.spe));
