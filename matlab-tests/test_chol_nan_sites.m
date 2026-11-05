% MATLAB chol's rule at eig's and eigs's own Cholesky factorizations: a NaN pivot is not positive definite
% (test_chol_nan.m pins chol itself from real MATLAB, o20). These are regression pins of Sagebrush's behaviour,
% not real-MATLAB output: B is finite and symmetric, and its third pivot is NaN (1e200/1e-150 overflows to Inf,
% Inf*0 is NaN), so B is not positive definite. NumPy's rule would let that pivot pass. Each case prints only
% whether the call returned (and its size), since the pencil's values are not the point.
B = [1e-300 0 1e200; 0 1 0; 1e200 0 1];
A = diag([1 2 3]);
try
  chol(B);
  disp('chol: factored');
catch err
  disp('chol: refused');
end
% eig: B is not positive definite, so the general algorithm is the one asked for; with this badly conditioned B it
% needs QZ, which Sagebrush refuses (real MATLAB would run QZ). The pin is the reason, not the text: a NaN factor
% instead fails later, in inv.
try
  d = eig(A, B);
  disp('eig: returned'); show(size(d))
catch err
  if isempty(strfind(err.message, 'QZ'))
    disp('eig: refused, other reason');
  else
    disp('eig: refused, needs QZ');
  end
end
% eig 'chol': B is not positive definite, so Sagebrush refuses (it does not fall back)
try
  d = eig(A, B, 'chol');
  disp('eig chol: returned'); show(size(d))
catch err
  disp('eig chol: refused');
end
% eigs: B is not positive definite, so the problem is not symmetric and 'largestimag' is allowed
try
  d = eigs(A, B, 2, 'largestimag');
  disp('eigs largestimag: returned'); show(size(d))
catch err
  disp('eigs largestimag: refused');
end
% eigs with IsSymmetricDefinite true: Cholesky fails, and the operator's matrix is used instead
try
  d = eigs(A, B, 2, 1.5, 'IsSymmetricDefinite', true);
  disp('eigs IsSymmetricDefinite: returned'); show(size(d))
catch err
  disp('eigs IsSymmetricDefinite: refused');
end
