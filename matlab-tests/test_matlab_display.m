% MATLAB's own output, where Octave's differs: the Command Window display
% (format short, loose), and documented behaviours.  The expected output,
% test_matlab_display.matlab.out, is written by hand from MATLAB's
% documentation and from published MATLAB output (see design/matlab.md).
x = 5
y = -4.5951
big = 2855
m = [16 2; 5 11]
w = [1.5 -2.25; 100.5 3]
e = 1e-5
s = [1 1000.5]
r = 1:30
L = true
B = [true false true]
k = int16(4)
u = uint8([255 40; 120 200])
c = 'hello'
C = ['abc'; 'def']
z = []
q = {3, 'abc'}
st.a = 1;
st.name = 'hi'
cplx = [0.7356, -0.0104 - 0.4365i]
f = @(t) t.^2 + 1
format long
p = pi
format short
disp(5)
disp([1 2 3])
disp('text')
disp(true)
fprintf('%s\n', sprintf('%d', pi));
fprintf('%d\n', nthroot(-27, 3));
fprintf('%d\n', contains('hello world', 'wor'));
fprintf('%s\n', mat2str('it''s'));
fprintf('%s\n', mat2str(zeros(1, 0)));
3 + 4
