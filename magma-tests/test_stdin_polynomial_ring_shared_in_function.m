// A ring named inside a function names the session's ring.
function F()
  R<y> := PolynomialRing(Rationals());
  return y^2 + y;
end function;
P := PolynomialRing(Rationals());
g := P.1 + 2;
h := F();
print h, g, P;
print "end";
