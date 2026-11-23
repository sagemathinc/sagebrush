# latex() of negative powers and of floats inside expressions, as Sage writes them (#715):
# x^(-n) goes over 1, except base e, sums and complex exponents; a float coefficient keeps its printed exponent digits
x = var("x")
for c in [RDF(2.5e-7), RDF(-3.25e-12), RDF(1e20), CDF(1e20, 2.5e-7), RR(-2.5), RDF(-2.5), QQ(-3/2)]:
    print(repr(c), "|", c*x, "|", x^c, "|", latex(x^c), "|", x + c)
x, a = var("x a")
for f in [x^(-2), x^(-3/2), x^(-2.5), x^RDF(-2.5), x^(-a), x^(-2*a), (x+1)^(-3/2), (x+1)^(-2), 3*x^(-3/2), x^(-1/2)*a, x^(-1/2) + 1, sin(x)^(-3/2), x^(-1), x^CDF(-1,2), e^(-3/2*x), 2^(-1/2), x^(-RR(1e-20))]:
    print(latex(f))
for c in [RDF(2.5e-7), RDF(1.5e-300), RDF(1e100), RDF(-1e-5), RR(1.5e-7), CDF(1e-7, 2)]:
    print(repr(c), "|", latex(c*x), "|", latex(x^2 + c))
x, a, b = var("x a b")
for f in [a*x^(-b), x^(-b)*a, 3*x^(-2*b), x^(-a)*b, e^(-x), e^(-a*x), 2^(-x), x^(-a-1), x^(a-1), x^(-x), (x+1)^(-a), x^(-2)*(x+1)^(-1), x^(-3/2)*sin(x), x^(-I), sqrt(x)^(-3)]:
    print(latex(f))
for f in [3*e^(-2), e^(-2), x*e^(-x), e^(-2)/x, x*e^(-2*x), sin(x)*e^(-1), x^2*e^(-3/2)]:
    print(latex(f))
