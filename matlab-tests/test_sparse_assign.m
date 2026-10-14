% Sparse matrices: indexed assignment, deletion and concatenation.
S = sparse([3 2 3 4 1], [1 2 2 3 4], [1 2 3 4 5], 4, 4);
F = full(S); F(1, 1) = 1;
L = S > 2;
% assignment keeps a sparse matrix sparse, and its class
T = S; T(1, 1) = 7; sp(T);
T = S; T(5, 5) = 1; sp(T);
T = S; T(2, 2) = 0; sp(T);
T = S; T(2, :) = 0; sp(T);
T = S; T(:, 3) = [9; 9; 9; 9]; sp(T);
T = S; T(1, :) = 1:4; sp(T);
T = S; T(:) = 1:16; sp(T);
T = S; T(:) = 0; sp(T);
T = S; T(3, 2) = 1 + 1i; sp(T);
T = S; T(1) = true; sp(T);
T = S; T(6) = -1; sp(T);
T = S; T([1 16]) = [8 9]; sp(T);
T = S; T([2 2], 1) = [3; 4]; sp(T);
T = S; T(S > 2) = 0; sp(T);
T = S; T(L) = -1; sp(T);
T = S; T(S > 2) = [10 20 30]; sp(T);
T = L; T(1, 1) = 5; sp(T);
T = L; T(1, 1) = true; sp(T);
T = L; T(3, 2) = false; sp(T);
T = sparse(3, 3); T(2, :) = [1 2 3]; sp(T);
T = sparse(2, 2); T(1, 1) = single(4); sp(T);
T = sparse(2, 2); T(:, :) = [1 2; 3 4]; sp(T);
T = sparse(2, 2); T(1:2, 1:2) = sparse([0 5; 6 0]); sp(T);
T = sparse(2, 2); T(3, 4) = 1; sp(T);
T = sparse(1, 3); T(5) = 2; sp(T);
T = sparse(3, 1); T(5) = 2; sp(T);
T = sparse(0, 0); T(2, 3) = 1; sp(T);
T = S; T(end + 1, :) = 1; sp(T);
T = S; T(:, end + 1) = b(); sp(T);
% a full matrix stays full
T = F; T(1, 1) = S(2, 2); sp(T);
T = F; T(:, 1) = S(:, 1); sp(T);
T = zeros(2); T(1, 1) = sparse(3); sp(T);
% deletion
T = S; T(:, 1) = []; sp(T);
T = S; T(2, :) = []; sp(T);
T = S; T([1 3], :) = []; sp(T);
T = S; T(:, [2 4]) = []; sp(T);
T = S; T([1 2 3]) = []; sp(T);
T = S; T(:) = []; sp(T);
v = sparse([0; 3; 0; -1]); v([1 4]) = []; sp(v);
% loops of assignments
T = sparse(5, 5);
for k = 1:5
  T(k, k) = k;
  T(k, 6 - k) = -k;
end
sp(T);
% concatenation: sparse if any part is
sp([S F]); sp([F S]); sp([S; F]); sp([S S]); sp([S; S]); sp([S(1, :) 7]); sp([L L]); sp([L S]);
sp([L F]); sp([S []]); sp([S zeros(4, 0)]); sp([S; zeros(0, 4)]); sp(cat(1, S, F)); sp(cat(2, S, F));
sp(horzcat(S, F)); sp(vertcat(S, F)); sp([S, sparse([1 2 4], [1 3 4], [1+2i, -3, 2i], 4, 4)]);
sp([sparse(1), 2, sparse(0)]); sp([sparse(2, 0), sparse(2, 3)]); sp([sparse([]); sparse(1, 2)]);
B = sparse([1 1e5], [1 1e5], [1 2], 1e5, 1e5);
B2 = [B B; B B]; show(size(B2)); show(nnz(B2));
B(5e4, 5e4) = 3; show(nnz(B)); B(:, 1) = []; show(size(B)); show(nnz(B));

function r = b()
r = [1; 2; 3; 4];
end

function sp(x)
fprintf('sparse=%d ', issparse(x));
show(full(x));
end
