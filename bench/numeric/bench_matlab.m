% MATLAB mode's dense kernels, timed as the numeric track's §3 says: warm-up runs, then the median of 7.
% One line per (op, n): op n median_s gflops. Run under taskset -c 0 for one thread.
sizes = [10 30 50 100 300 1000];
R = 7;
rng(1);
for n = sizes
  A = rand(n); B = rand(n); b = rand(n, 1);
  S = A' * A + n * eye(n);
  ops = {'gemm', @() A * B, 2 * n^3; ...
         'solve', @() A \ b, 2 / 3 * n^3; ...
         'chol', @() chol(S), 1 / 3 * n^3; ...
         'eigsym', @() eig(S), 4 / 3 * n^3; ...
         'eig', @() eig(A), 10 * n^3};
  for k = 1:size(ops, 1)
    f = ops{k, 2};
    reps = R;
    if n >= 1000 && any(strcmp(ops{k, 1}, {'eig', 'eigsym'})), reps = 3; end
    f(); f();
    t = zeros(1, reps);
    for r = 1:reps
      t0 = tic; f(); t(r) = toc(t0);
    end
    m = median(t);
    fprintf('%s %d %.6g %.4g\n', ops{k, 1}, n, m, ops{k, 3} / m / 1e9);
  end
end
