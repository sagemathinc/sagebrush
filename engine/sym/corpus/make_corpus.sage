# The symbolic corpus: inputs (Sage syntax) and what Sage prints for them.
# Run with Sage to regenerate corpus.json:  sage make_corpus.sage
import json
var('x y z t a b c n')
cases = r'''
x + x
x + y + x
2*x + 3*y - x
x*x
x*y*x
x^2*x^3
(x^2)^3
(x*y)^2
x - x
0*x
1*x
x/x
x/y
1/x
2/x
-1/x
x^-2
y/x^2
(x+1)/(x-1)
x/(x+1)
sin(x)/x
(x+1)^2
2*(x+1)
-(x+1)
(x+1)/2
x/2
-x/2
3/4*x^2
x^2 + 2*x + 1
1 + 2*x + x^2
x^3 - x + 1
x^3 + sin(x) + 1
sin(x) + cos(x)
cos(x) + sin(x)
x*sin(x)
sin(x)*x
2*x*sin(x)
sin(x)^2 + cos(x)^2
y*x
z*y*x
x^2*y + x*y^2
a*x^2 + b*x + c
x + y + z
z + y + x
exp(x)
exp(2*x)
exp(-x)
exp(x)*exp(y)
exp(x)^2
e^x
log(x)
log(x^2)
log(e)
log(1)
exp(0)
exp(log(x))
log(exp(x))
sqrt(x)
sqrt(x)^2
sqrt(x^2)
1/sqrt(x)
x^(1/3)
x^(-1/3)
x^(3/2)
sqrt(2)
sqrt(8)
sqrt(12)
sqrt(1/2)
sqrt(2)*sqrt(2)
sqrt(2)*sqrt(3)
sqrt(-1)
sqrt(-4)
8^(1/3)
(-8)^(1/3)
2^(3/2)
2^(1/2)*2^(1/3)
I^2
I^3
(1+I)^2
pi
2*pi
pi/2
pi/2 + pi/3
sin(pi)
sin(pi/2)
sin(pi/6)
sin(pi/4)
sin(pi/3)
cos(pi/3)
cos(2*pi/3)
tan(pi/4)
tan(pi/3)
sin(pi/12)
cos(pi/5)
sin(-x)
cos(-x)
tan(-x)
asin(1/2)
acos(1/2)
atan(1)
atan(sqrt(3))
sinh(0)
cosh(0)
abs(-3)
abs(x)
abs(-x)
sin(1.0)
1.5*x + 2
x + 0.5
exp(1.0)
2^x
2^x*2^y
x^y
factorial(5)
binomial(5, 2)
expand((x+1)^3)
expand((x+y)^2)
expand((x+1)*(x-1))
expand((x+1)/(x-1))
expand(sin(x)*(x+1))
expand(2*(x+1)*(y+1))
expand((x+1)^2*(x-1))
diff(x^2, x)
diff(x^3 + 2*x, x)
diff(sin(x), x)
diff(cos(x), x)
diff(tan(x), x)
diff(exp(x), x)
diff(exp(2*x), x)
diff(log(x), x)
diff(sqrt(x), x)
diff(1/x, x)
diff(x*sin(x), x)
diff(sin(x)/x, x)
diff(sin(x^2), x)
diff(exp(x^2), x)
diff(x^x, x)
diff(atan(x), x)
diff(asin(x), x)
diff(acos(x), x)
diff(sinh(x), x)
diff(cosh(x), x)
diff(tanh(x), x)
diff(log(sin(x)), x)
diff(x^2*y^3, y)
diff(x^4, x, 2)
diff(sin(x)*cos(x), x)
diff(abs(x), x)
diff(2^x, x)
diff(x^n, x)
diff(sec(x), x)
diff(cot(x), x)
diff(acot(x), x)
diff((x^2+1)/(x-1), x)
factor(x^2 - 1)
factor(x^3 - x)
factor(x^2 + 2*x + 1)
factor(x^2 - y^2)
factor(x^4 - 1)
factor(6*x^2 + 5*x + 1)
simplify((x^2-1)/(x-1))
((x^2-1)/(x-1)).simplify_rational()
((x^2-1)/(x+1)).full_simplify()
(sin(x)^2 + cos(x)^2).simplify_trig()
(1/x + 1/y).simplify_rational()
(x/(x+1) + 1/(x+1)).simplify_full()
taylor(sin(x), x, 0, 7)
taylor(cos(x), x, 0, 6)
taylor(exp(x), x, 0, 5)
taylor(log(1+x), x, 0, 5)
taylor(1/(1-x), x, 0, 5)
taylor(tan(x), x, 0, 7)
taylor(sqrt(1+x), x, 0, 3)
taylor(exp(x), x, 1, 3)
taylor(atan(x), x, 0, 7)
taylor(x/(exp(x)-1), x, 0, 4)
limit(sin(x)/x, x=0)
limit((1+1/x)^x, x=oo)
limit(x^2, x=3)
limit(1/x, x=oo)
limit((x^2-1)/(x-1), x=1)
limit((exp(x)-1)/x, x=0)
limit((1-cos(x))/x^2, x=0)
limit(x*log(x), x=0)
limit(x^x, x=0)
limit((x^3+1)/(2*x^3+x), x=oo)
solve(x^2 - 4 == 0, x)
solve(x^2 + x - 1 == 0, x)
solve(x^2 + 1 == 0, x)
solve(2*x + 3 == 0, x)
solve(x^3 - 6*x^2 + 11*x - 6 == 0, x)
solve([x + y == 3, x - y == 1], x, y)
(x^2 + 2*x + 1).degree(x)
(x^2*y + x).coefficient(x, 2)
((x+1)/(x-1)).numerator()
((x+1)/(x-1)).denominator()
(x^2+sin(x)).subs(x=2)
(x^2+y).subs(x=y+1)
(x + 1/2).n()
(pi).n()
sqrt(2).n()
(sin(x)^2).subs(x=pi/4)
latex(x^2 + 1/2*x)
latex(sin(x)/x)
latex(sqrt(x+1))
latex(exp(-x^2))
latex(x^(1/3))
latex((x+1)^2/(x-1))
latex(pi/2)
latex(log(x))
latex(atan(x))
(x^2).variables()
(x*y + z).variables()
'''
out = []
for line in cases.strip().split("\n"):
    try:
        v = eval(preparse(line))
        out.append({"in": line, "out": str(v)})
    except Exception as ex:
        out.append({"in": line, "error": type(ex).__name__ + ": " + str(ex)})
json.dump(out, open("corpus.json", "w"), indent=0)
for o in out:
    print(o["in"], "  =>  ", o.get("out", o.get("error")))
