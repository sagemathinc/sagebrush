# Print-order corpus: what Sage prints for sums and products.
import json
var('x y z a b n t')
cases = r'''
x*(x+1)
(x+1)*x
(x+1)*(x-1)
x*(x-1)*(x+1)
(x+2)*(x+1)
(2*x+1)*(3*x+1)
(x^2+1)*(x+1)
x*sin(x)*(x+1)
sin(x)*(x+1)
(x+1)*log(x)
x^x*(log(x)+1)
log(x)*x^x
2^x*log(2)
x^n*n
y*sin(x)
sin(x)*cos(x)
cos(x)*sin(x)*x
exp(x)*x
exp(x)*sin(x)
exp(x)*(x+1)
x^2*(x+1)
(x+1)^2*x
(x+1)^2*(x-1)
sqrt(x)*(x+1)
sqrt(x)*x
sqrt(x)*y
pi*x
pi*x^2
pi*sin(x)
sqrt(2)*x
sqrt(2)*sqrt(3)*sqrt(5)
sqrt(2)*pi
x*y^2
y*x^2
a*b*x
x*(y+1)
(y+1)*(x+1)
(x+y)*(x-y)
x*(x+y)
sin(x)*sin(y)
x^3 + x*y + y^2
x + sin(x) + cos(x) + 1
x^2 + sin(x)
sin(x) + x
sin(x)^2 + x
log(x) + x
exp(x) + x
exp(x) + x^2 + 1
x + pi
x^2 + pi*x + pi
pi + 1
sqrt(2) + 1
sqrt(2) + x
x*y + x + y
x*y + x^2
y^2 + x
a + x
x/y + y/x
1/x + 1/y
1/x + x
1/x^2 + 1/x + 1
x^(1/2) + x
x^(3/2) + x
sqrt(x) + 1
2^x + x
2^x + 3^x
x^y + x
exp(-x) + 1
sin(x)/x + cos(x)
x*cos(x) - sin(x)
-x + 1
-x^2 - x
-sin(x) + x
x - sin(x)
cos(x)^2 - sin(x)^2
-cos(x) + sin(x)
-x*y + x
3*x*y - 2*x
x^2*y^2 + x^2 + y^2
a*x + b*y
b*x + a*y
x*z + y
(x+1)/(x+2)
x/(x^2+1)
2*x/(x^2+1)
-2*x/(x^2+1)^2
(x+1)/x
sin(x)/(x+1)
(x+1)/sin(x)
x/(y*z)
1/(x*y)
1/(2*x)
3/(2*x)
x^2/(2*y)
1/(x+1)^2
1/2/x
-1/2/x
sqrt(x)/x
1/(x*sqrt(x))
x*sqrt(y)/z
2*sqrt(x)
-sqrt(x)
1/2*sqrt(x)
x^(-3/2)
x^(-1)*y^(-1)
e^x/x
x*e^(-x)
e^(-x^2)
(x+1)*e^x
exp(x)*cos(x) + exp(x)*sin(x)
'''
out = []
for line in cases.strip().split("\n"):
    try:
        out.append({"in": line, "out": str(eval(preparse(line)))})
    except Exception as ex:
        out.append({"in": line, "error": str(ex)})
json.dump(out, open("order.json", "w"), indent=0)
