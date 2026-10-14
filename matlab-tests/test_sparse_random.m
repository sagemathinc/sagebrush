% sprand: MATLAB's random sparse matrices, from rng's stream (num, below:
% class, sparsity, size and every value).
rng(0, 'twister');
a = sprand(5, 4, 0.3);
rng(0, 'twister');
e = sprand(sparse([1 0; 0 1]));
rng(0, 'twister');
f = sprand(1000, 1000, 0.001);
[i, j, v] = find(f);
fprintf('%s', num(a)); fprintf('%s', num(e)); fprintf('f nnz=%d\n', nnz(f)); fprintf('%s', num(i(1:20))); fprintf('%s', num(j(1:20))); fprintf('%s', num(v(1:20)));

function s = num(x)
% a value exactly: its class, sparsity, size, then its elements in
% column-major order (to 17 significant digits; complex as real and
% imaginary parts)
sz = sprintf('%dx', size(x));
sp = '';
if issparse(x)
    sp = sprintf(' sparse nnz=%d', nnz(x));
end
s = sprintf('%s%s %s\n', class(x), sp, sz(1:end-1));
if isempty(x) || ~(isnumeric(x) || islogical(x) || ischar(x))
    return;
end
x = full(x);
if isinteger(x)
    s = [s, sprintf('%d ', x(:)), newline];
elseif islogical(x) || ischar(x)
    s = [s, sprintf('%d ', double(x(:))), newline];
elseif isreal(x)
    s = [s, sprintf('%.17g ', double(x(:))), newline];
else
    s = [s, 're ', sprintf('%.17g ', double(real(x(:)))), newline, 'im ', sprintf('%.17g ', double(imag(x(:)))), newline];
end
end
