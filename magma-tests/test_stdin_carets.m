P<x> := PolynomialRing(Integers());
// two calls of one intrinsic in one statement, the second failing
print ChangeRing(x, Rationals()), ChangeRing(x, 5);
// nested: the inner call fails
ChangeRing(x, ChangeRing(x, 5));
// nested: the outer call fails
ChangeRing(ChangeRing(x, Rationals()), 5);
// a call over two lines
ChangeRing(x,
  5);
// the name in a string and in a comment before the call
print "ChangeRing(x, 5)", /* ChangeRing( */ ChangeRing(x, 5);
// another signature intrinsic, repeated
print Sym(3), Sym("a");
// two intrinsics in one statement, the second failing
print Trace(GF(4).1), Trace(GF(4).1, GF(8));
// an intrinsic that refuses its argument in Magma's words, nested
print Root(Root(GF(11)!4, 2), 0);
"end";
