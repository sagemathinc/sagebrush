P<x> := PolynomialRing(Integers());
// an intrinsic called through a variable
f := ChangeRing;
y := f(x, 5);
z := 1 + f(x, 5);
// an alias of an alias, the second of two calls failing
h := f;
print [h(x, Rationals()), h(x, 5)];
// nested: the inner call fails, then the outer
h(x, h(x, 5));
h(h(x, Rationals()), 5);
// a variable reassigned to a user function, then to another intrinsic
f := func< a, b | a >;
print f(x, 5);
f := Trace;
print f(GF(4).1), f(GF(4).1, GF(8));
// the alias's name in a string before the call
print "f(x)", f(GF(4).1, GF(8));
"end";
