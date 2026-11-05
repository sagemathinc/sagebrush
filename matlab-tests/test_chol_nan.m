% chol with NaN and Inf, as real MATLAB R2026b Update 1 (o20, run by @sagebrush-matlab, Nov 5 2026): a NaN pivot
% is not positive definite (MATLAB:posdef; [R,p] gives the failing column and the leading block), an Inf pivot
% passes. Sagebrush's numpy cholesky takes NumPy's rule instead (a NaN pivot passes); these pin that MATLAB
% mode keeps MATLAB's. (The error is pinned as refused, not by its text: Sagebrush's message and identifier
% differ from MATLAB's "Matrix must be positive definite." / MATLAB:posdef, before this change as after.)
try
  chol([4 NaN; NaN 9]);
catch err
  disp('refused: not positive definite');
end
[R, p] = chol([4 NaN; NaN 9]);
show(R)
show(p)
[R, p] = chol([NaN 0; 0 1]);
show(R)
show(p)
[R, p] = chol([1 0; 0 NaN]);
show(R)
show(p)
[R, p] = chol([Inf 0; 0 1]);
show(R)
show(p)
try
  chol([4 2; 2 NaN], 'lower');
catch err
  disp('refused: not positive definite');
end
