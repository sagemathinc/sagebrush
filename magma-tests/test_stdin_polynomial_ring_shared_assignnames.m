// AssignNames on the shared ring renames it everywhere too.
P<x> := PolynomialRing(Rationals());
f := x^3;
Q := PolynomialRing(Rationals());
AssignNames(~Q, ["q"]);
print f, x, P;
print "end";
