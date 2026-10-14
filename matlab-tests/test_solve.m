% Solving: square systems by LU, tall ones by least squares, and inv.
% (Values to 10 digits: the last bits depend on the factorization.)
r = @(x) round(x * 1e10) / 1e10 + 0;
show(r([4 -2; 1 1] \ [2; 3]));
show(r(magic(3) \ [1; 2; 3]));
show(r(magic(3) \ eye(3)));
show(r([1 2; 3 4] \ [5 6; 7 8]));
show(r([2 1; 1 3] \ [1; 2]));
show(r([1 2; 3 4; 5 6] \ [1; 2; 4]));
show(r([1 2; 3 4; 5 7] \ [1 0; 0 1; 1 1]));
show(r([2 1; 1 3; 0 1; 1 1] \ [1; 2; 3; 4]));
show(r([1 2] / [4 -2; 1 1]));
show(r([1 2; 3 4] / [2 0; 0 4]));
show(r(inv([4 -2; 1 1])));
show(r(inv(magic(3))));
show(r([1+2i 2; 3 4-1i] \ [1; 1i]));
show(r(3 \ [6 9]));
show(r([6 9] / 3));
