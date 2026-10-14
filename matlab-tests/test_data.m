% Data analysis and signals: filter, conv, conv2, filter2, gradient, del2,
% detrend, cov, corrcoef, prctile, quantile and the moving statistics.
% (Values to 10 digits.)
r = @(x) round(x * 1e10) / 1e10 + 0;
% filter
show(r(filter(1, [1 -0.5], [1 1 1 1 1])));
show(r(filter([1 2 3], 1, [1 0 0 0 0 1])));
show(r(filter([0.5 0.5], [1 -0.2 0.1], [1 2 3; 4 5 6; 7 8 9])));
show(r(filter([1 1], 2, [1 2 3 4]')));
[y, zf] = filter([1 2], [1 -0.5], [1 2 3], 0.5); show(r(y)); show(r(zf));
[y, zf] = filter([1 2 1], [1 0.3 0.2], [1 2; 3 4; 5 6]); show(r(y)); show(r(zf));
show(r(filter([1 1], 1, [1 2; 3 4; 5 6], [], 2)));
show(r(filter(1, [1 -0.9], [1 1i 2])));
% conv and conv2, filter2
show(conv([1 2 3], [1 1])); show(conv([1 2 3]', [1 1])); show(conv([1 2 3 4 5], [1 1 1], 'same')); show(conv([1 2 3 4 5], [1 1 1], 'valid'));
A = magic(4); K = [1 2; 3 4];
show(conv2(A, K)); show(conv2(A, K, 'same')); show(conv2(A, K, 'valid')); show(conv2(K, A, 'same'));
show(conv2([1 2 1], [1 0 -1], A)); show(conv2([1 2 1], [1 0 -1], A, 'same'));
show(conv2(A, [1 2 3; 4 5 6; 7 8 10], 'same'));
show(filter2(K, A)); show(filter2(K, A, 'valid')); show(filter2([1 2 1; 0 0 0; -1 -2 -1], A, 'full'));
% gradient
show(r(gradient([1 4 9 16 25])));
show(r(gradient([1 4 9 16 25], 0.5)));
show(r(gradient([1 4 9 16 25]', [0 1 3 4 7])));
[gx, gy] = gradient(magic(4)); show(r(gx)); show(r(gy));
[gx, gy] = gradient(magic(4), 2, [1 2 4 8]); show(r(gx)); show(r(gy));
show(r(gradient(5)));
% del2
show(r(del2([1 4 9 16 25 36])));
show(r(del2(magic(4))));
show(r(del2(magic(5), 2)));
show(r(del2(magic(4), [1 2 4 5], 3)));
[x, y] = meshgrid(-2:2, -1:2); show(r(del2(x.^2 + y.^3)));
show(r(del2([1 2 4])));
% detrend
show(r(detrend([1 3 2 5 4])));
show(r(detrend([1 3 2 5 4], 'constant')));
show(r(detrend([1 3 2 5 4]', 0)));
show(r(detrend([1 4 9 16 26 36], 2)));
show(r(detrend(magic(4))));
% cov and corrcoef
X = [1 2 3; 2 4 1; 3 5 7; 4 1 2];
show(r(cov([1 2 3 4]))); show(r(cov(X))); show(r(cov(X, 1))); show(r(cov([1 2 3 4], [2 4 5 9])));
show(r(cov([1 2 3 4]', [4 3 2 1]', 1))); show(r(cov(5))); show(r(cov([1+1i 2 3-1i])));
show(r(corrcoef(X))); show(r(corrcoef([1 2 3 4], [2 4 5 9]))); show(r(corrcoef([1 2 3 4]', [4 3 2 1]')));
show(corrcoef([1 2 3 4]', [5 5 5 5]')); show(corrcoef([1 NaN 3 4]', [2 4 5 9]')); show(r(del2([1 2 4]))); show(del2([1 5])); show(r(del2([1 2 4; 3 5 9; 2 2 2])));
% prctile and quantile
v = [3 1 4 1 5 9 2 6];
show(r(prctile(v, 50))); show(r(prctile(v, [0 25 50 75 100])));
show(r(prctile(X, 50))); show(r(prctile(X, [25 75]))); show(r(prctile(X, 50, 2)));
show(r(quantile(v, [0.1 0.5 0.9]))); show(r(quantile(v', 0.3))); show(r(quantile(X, 0.5)));
show(r(quantile(v, 3))); show(r(quantile([2 NaN 4 6], 0.5)));
% moving statistics
a = [4 8 6 -1 -2 -3 -1 3 4 5];
show(r(movmean(a, 3))); show(r(movmean(a, 4))); show(r(movmean(a, [2 0]))); show(r(movsum(a, 3)));
show(r(movmax(a, 3))); show(r(movmin(a, [1 2]))); show(r(movmedian(a, 4))); show(r(movprod(a, 2)));
show(r(movvar(a, 3))); show(r(movstd(a, 5))); show(r(movvar(a, 3, 1)));
show(r(movmean(a, 3, 'Endpoints', 'discard'))); show(r(movsum(a, 3, 'Endpoints', 'fill')));
b = [1 NaN 3 4 NaN 6];
show(r(movmean(b, 3))); show(r(movmean(b, 3, 'omitnan'))); show(r(movsum(b, 3, 'omitnan'))); show(r(movmax(b, 2, 'omitnan')));
show(r(movmedian(b, 3, 'omitnan')));
show(r(movmean(magic(4), 3))); show(r(movmean(magic(4), 3, 2))); show(r(movsum(magic(4)', [1 1])));
% the reductions' 'omitnan'
X = [1 NaN 3; 4 5 NaN; NaN 8 9; 2 2 2];
show(median(X, 'omitnan')); show(median(X, 2, 'omitnan')); show(r(var(X, 0, 'omitnan'))); show(r(std(X, 1, 2, 'omitnan')));
show(prod(X, 'omitnan')); show(median([NaN NaN], 'omitnan')); show(var([NaN 5], 0, 'omitnan')); show(median(X, 'all', 'omitnan'));
show(r(var(X, 0, 'all', 'omitnan'))); show(sum(X, 'omitmissing')); show(median(X)); show(var(X));
[lo, hi] = bounds([3 1 4 1 5]); show([lo hi]); show(bounds([3 1 4]));
