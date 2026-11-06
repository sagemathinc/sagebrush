# A large sum of products (an expanded power of a sum mixing symbols, kernels, e^x, sqrt(2) and pi), printed and
# typeset whole, as Sage 10.9 does: master f4574baf's term comparator was not a total order, and its sort
# panicked here ("Sagebrush engine: unreachable"); #754's keys order it (and the latex) as Sage.
var('a b c x y')
f = expand((a + b + c + sin(x) + cos(y) + e^x + sqrt(2)*x + pi)^5)
print(f)
print(latex(f))
g = expand((a + b*sin(x) + c*e^(2*x) + x^(3/2))^6)
print(g)
