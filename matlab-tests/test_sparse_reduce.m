% Sparse matrices: reductions, shape functions, sort and unique, max and min.
S = sparse([3 2 3 4 1], [1 2 2 3 4], [1 2 3 4 5], 4, 4);
F = full(S); F(1, 1) = 1;
L = S > 2;
C = sparse([1 2 4], [1 3 4], [1+2i, -3, 2i], 4, 4);
v = sparse([0 3 0 -1]);
% reductions: sparse
sp(sum(S)); sp(sum(S, 1)); sp(sum(S, 2)); sp(sum(S, 3)); sp(sum(S(:))); sp(sum(L)); sp(sum(C)); sp(sum(v));
sp(sum(sparse(0, 3))); sp(sum(sparse(2, 3), 2));
sp(prod(S)); sp(prod(S + speye(4))); sp(cumsum(S)); sp(cumsum(S, 2)); sp(cumprod(S));
sp(max(S)); sp(max(S, [], 2)); sp(min(S)); sp(max(-S)); sp(min(-S)); sp(max(sparse(2, 3))); sp(max(v));
sp(max(S, 2)); sp(max(S, 0)); sp(min(S, 0)); sp(min(S, -1)); sp(max(S, S'));
[m, k] = max(S); sp(m); sp(k);
[m, k] = min(S, [], 2); sp(m); sp(k);
sp(mean(S)); sp(mean(S, 2)); sp(median(S)); sp(std(S)); sp(var(S));
sp(any(S)); sp(all(S)); sp(any(S, 2)); sp(all(S + 1)); sp(any(S(:)));
sp(all(sparse([1 NaN])));
% shape
sp(reshape(S, 2, 8)); sp(reshape(S, 16, 1)); sp(reshape(S, [], 2)); sp(reshape(S, 8, [])); sp(reshape(S, [1 16]));
sp(repmat(S, 2, 1)); sp(repmat(v, 1, 2)); sp(repmat(v, [2 2])); sp(repmat(S, 0, 1));
sp(kron(S, speye(2))); sp(kron(S, F)); sp(kron(F, S)); sp(kron(v, v')); sp(kron(L, L));
sp(diag(S)); sp(diag(S, 1)); sp(diag(S, -1)); sp(diag(S, 3)); sp(diag(v)); sp(diag(v, 1)); sp(diag(v, -2));
sp(diag(sparse([1; 2]))); sp(diag(sparse(2, 3)));
sp(tril(S)); sp(triu(S)); sp(tril(S, -1)); sp(triu(S, 1)); sp(tril(S, 2)); sp(triu(sparse(ones(3, 4)), -1));
sp(fliplr(S)); sp(flipud(S)); sp(rot90(S)); sp(circshift(S, 1)); sp(permute(S, [2 1])); sp(squeeze(S));
sp(blkdiag(S, speye(2))); sp(blkdiag(F, S)); sp(blkdiag(F, F)); sp(blkdiag(sparse(1), 2, sparse([3 4])));
% sort and unique
sp(sort(S)); sp(sort(S, 2, 'descend')); sp(sort(v));
[s2, i2] = sort(v); sp(s2); sp(i2);
% large: never expanded
B = sparse([1 7 1e5], [1 7 1e5], [1 2 3], 1e5, 1e5);
show(nnz(sum(B))); show(full(sum(B, 'all'))); show(nnz(diag(B))); show(nnz(tril(B, -1))); show(size(kron(B, speye(2))));
show(nnz(repmat(B, 2, 2))); show(full(B(7, 7))); show(nnz(fliplr(B))); show(full(any(B(:, 7)))); show(nnz(mean(B)));

function sp(x)
fprintf('sparse=%d ', issparse(x));
show(full(x));
end
