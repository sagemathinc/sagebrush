// Real literals as Magma 2.18-5 reads them (a session: each error is reported and the input goes on).
// a point with no digits after it, as in 1. and 12., is a real
print 1.;
x := 1.;
print x, Type(x);
print 12., -1., 0.;
print 1. + 2;
print [1.];
print 1.e5, 1.E2, 1.e+2, 2.e-1;
print 1.5e2, 1e5, 1.0;
// a range is not one
print [1..3];
print [1. .. 3];
// an exponent needs digits after it (and after its sign): Magma's error just after the e
print 1e;
print 1.5e;
print 1.e;
print 1.5e+;
print 1ex;
print 1.ex;
print 1.5ex;
// what follows a real that can't: bad syntax there
print 1.x;
print 1/0.x;
print 1. 2;
print "end";
