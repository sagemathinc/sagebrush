# R754-NEARTIE-1 (daybreak3, @sagebrush's ruling): an exact number against a double it rounds to, or near it,
# as a term's degree, an exponent in a product and a numeric base (Sage 10.9, the same on every run). A
# kernel's argument at such a tie is not pinned: Sage's order there differs from run to run.
var('x y')
A = 2^53
for t in ["x^(A+1) + x^RR(A)", "x^(A+2) + x^RR(A)", "x^(A+4) + x^RR(A)", "x^(A-1) + x^RR(A)", "x^(A-2) + x^RR(A)",
          "x^(A+1) + x^A", "x^A + x^(A+1)", "x^(A+3) + x^RR(A+2)", "x^(A+5) + x^RR(A+4)", "x^(A+5) + x^RR(A+6)",
          "x^(-A-3) + x^RR(-A-2)", "x^(-A-3) + x^RR(-A-4)", "x^(A+1/2) + x^RR(A)", "x^(1/7) + x^RR(1/7)",
          "(A+1)^x + RR(A)^x", "(A+1)^x + RR(A+2)^x", "(A+3)^x + RR(A+2)^x", "(A+2)^x + (A+1)^x",
          "x^(A+1)*y + x^RR(A)*y", "x^(1/3)*y^RR(1/3) + x^RR(1/3)*y^(1/3)", "x^(A+1)*y^RR(A) + x^RR(A)*y^(A+1)",
          "(A+1)*x^RR(A) + RR(A)*x^(A+1)", "x^RR(A)*y + x^(A+1)*y", "x^3 + x^RR(2.5) + x^2 + x^RR(3.5)", "x^RR(4.0) + x^3", "x^RR(2.0) + x^3"]:
    print(t, '=>', sage_eval(t, locals=dict(x=x, y=y, A=A, RR=RR)))
