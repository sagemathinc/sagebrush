% Solving nearly singular, singular and rank-deficient systems as MATLAB does:
% the LU's own result (with a warning) for a square matrix, the basic solution
% (QR with column pivoting, free variables 0) for a rank-deficient one.
x = magic(4) \ [1; 2; 3; 4]; fprintf('%.17g ', x); fprintf('\n');
x = [1 2; 2 4] \ [1; 2]; fprintf('%g ', x); fprintf('\n');
x = [1 1; 1 1; 1 1] \ [1; 2; 3]; fprintf('%.15g ', x); fprintf('\n');
x = inv([1 2; 2 4]); fprintf('%g ', x); fprintf('\n');
