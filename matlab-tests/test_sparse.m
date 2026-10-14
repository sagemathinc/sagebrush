% Sparse matrices: construction, queries, indexing, and full values.
% (issparse is printed on its own: Octave's mat2str writes a sparse matrix
% in full, MATLAB's as a call to sparse, so show() is given full(x).)
S = sparse([3 2 3 4 1], [1 2 2 3 4], [1 2 3 4 5], 4, 4);
sp(S);
sp(sparse([1 1 2], [1 1 2], [2 3 4]));
sp(sparse([1 2], [1 2], [3 -3], 3, 3));
sp(sparse([1 2], [1 2], [0 5]));
sp(sparse([1 2], [1 2], [true true]));
sp(sparse([1 1], [1 1], [true true]));
sp(sparse(2, 3, 7));
sp(sparse([1 2], 1, 5, 3, 2));
sp(sparse([1 2 3]', [3 2 1]', [1 2 3]'));
sp(sparse([1 2 4], [1 3 4], [1+2i, -3, 2i], 4, 4));
sp(sparse([1 2], [1 2], [1+0i, 2]));
sp(sparse(2, 3));
sp(sparse(0, 0));
sp(sparse(ones(2, 0)));
sp(sparse(5));
sp(sparse(0));
sp(sparse(true));
sp(sparse([0 1; 2 0]));
sp(sparse([0 1; 2 0] > 0));
sp(sparse([1 NaN 0 Inf]));
sp(speye(3));
sp(speye(2, 3));
sp(speye([3 2]));
sp(speye(0));
sp(spones(S));
sp(spones([0 2; -1 0]));
sp(full(S));
sp(full([1 2]));
% queries
show(issparse(S)); show(issparse(full(S))); show(issparse(5));
show(nnz(S)); show(nnz(sparse(2, 3))); show(nnz([1 0 2]));
show(nonzeros(S)); show(nonzeros(S')); show(nonzeros(sparse(2, 2))); show(nonzeros([0 3; 4 0]));
show(size(S)); show(size(sparse(3, 0))); show(numel(S)); show(length(sparse(2, 7))); show(ndims(S));
show(isempty(sparse(0, 3))); show(isempty(S)); show(isscalar(sparse(1))); show(isvector(S(:, 1)));
show(isnumeric(S)); show(isfloat(S)); show(islogical(S)); show(islogical(sparse(true)));
show(isreal(S)); show(isreal(sparse(1i))); show(isa(S, 'double')); show(isa(S, 'numeric')); show(isa(S, 'float'));
show(class(S)); show(class(sparse(true)));
B = sparse(1e6, 1e6);
show(size(B)); show(nnz(B)); show(issparse(B(1:3, 999999:end))); show(nnz(B(:, 5)));
% find
[i, j] = find(S); show(i); show(j);
[i, j, v] = find(S); show(v);
[i, j, v] = find(sparse([1 2 4], [1 3 4], [1+2i, -3, 2i], 4, 4)); show(i); show(j); show(v);
[i, j, v] = find(S > 2); show(v);
show(find(S)); show(find(S')); show(find(sparse([0 3 0 -1]))); show(find(sparse([0; 3; 0; -1])));
show(find(S, 2)); show(find(S, 2, 'last')); show(find(sparse(2, 2)));
[i, j] = find(sparse([0 3 0 -1])); show(i); show(j);
% indexing: always sparse
sp(S(2, 2)); sp(S(1, 1)); sp(S(2, :)); sp(S(:, 2)); sp(S(1:2, 1:2)); sp(S([1 3], :)); sp(S(:, [4 1]));
sp(S([3 3 2], [2 1 2])); sp(S(5)); sp(S(6)); sp(S([6 1 16])); sp(S([6 1 16]')); sp(S(:, :)); sp(S(end, end));
sp(S(end)); sp(S(logical([1 0 1 0]), :)); sp(S(:)); sp(S(2, [])); sp(S([], :));
v = sparse([0 3 0 -1]);
sp(v(2)); sp(v([2 4])); sp(v(:)); sp(v([1 2; 3 4])); sp(S([1 2; 3 4]));
sp(S(sparse(2), 2)); sp(S(S > 2)); sp(S(full(S) > 2));
b = [10 20 30 40];
show(b(sparse([1 0 1 0]) > 0)); show(b(sparse([2 3])));
% everything else sees the full matrix
show(full(sum(S))); show(full(max(S))); show(full(S * [1; 2; 3; 4])); show(full(S + 1)); show(full(abs(-S)));
show(mat2str(full(S)));
% conditions and loops
if sparse(1), disp('yes'), end
if sparse([1 0]), disp('yes'), else, disp('no'), end
if sparse(2, 2), disp('yes'), else, disp('no'), end
for k = sparse([1 0 2])
  show(issparse(k)); show(full(k));
end
for k = sparse([1 2; 0 4])
  show(full(k));
end

function sp(x)
fprintf('sparse=%d ', issparse(x));
show(full(x));
end
