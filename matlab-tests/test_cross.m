% cross of matrices and N-D arrays: the 3-element vectors along the first
% dimension of size 3, or along dim (MCF-15).  The matrix cases and the two
% errors are real MATLAB's output (R2026b Update 1, run by @sagebrush-matlab,
% Nov 5 2026); the vector, single and 3-D lines follow the definition.
% Octave's error identifiers and messages differ, hence .matlab.out.
show(cross(eye(3), eye(3)))
show(cross(magic(3), eye(3)))
show(cross([1 2 3; 4 5 6]', [7 8 9; 1 2 3]'))
show(cross(ones(3, 4), ones(3, 4), 1))
show(cross(ones(2, 3), ones(2, 3)))
show(cross([1 0 0], [0 1 0]))
show(cross(single([1 0 0]), single([0 1 0])))
show(cross(reshape(1:12, 3, 2, 2), reshape(12:-1:1, 3, 2, 2)))
try, cross(ones(2, 2), ones(2, 2)), catch e, fprintf('%s | %s\n', e.identifier, e.message), end
try, cross(ones(3), ones(3, 4)), catch e, fprintf('%s | %s\n', e.identifier, e.message), end
