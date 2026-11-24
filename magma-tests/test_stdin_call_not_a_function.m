// A value that isn't a function or a map, called, as Magma 2.18-5 refuses it (a session: each error is reported
// and the input goes on), at the call's "(": "Bad argument types" with one argument, the argument's type then the
// value's; "Attempting to call something that is not callable" with none or several.  The call alone as a
// statement names the application, '@'; inside anything else, no name.
x := 5;
x(1);
print x(1);
y := x(1) + 1;
print x(1, 2);
print x();
x();
x(1, 2);
print 2(3);
print (1+1)(3);
L := [1, 2];
print L(1);
s := "ab";
print s(1);
b := true;
b(1);
print (1/2)(1);
F := GF(7);
a := F!3;
print a(1);
R<t> := PolynomialRing(GF(7));
f := t^2 + 1;
f(3);
print f(3);
f(3) + 1;
[f(3)];
z := f(3);
print f(1, 2);
print f();
g := func< | f >;
print g()(3);
K<w> := GF(9);
P<u> := PolynomialRing(K);
h := u^2 + w;
E<e> := GF(27);
print h(e);
print h(1/2);
print h("s");
Q<v> := PolynomialRing(Rationals());
q := v^2 + 1;
print q(3);
q(3);
M := Matrix(2, 2, [1, 2, 3, 4]);
M(1);
print M(1);
Z := Integers();
Z(3);
print Z(3);
// a function and a map still apply
sq := func< n | n^2 >;
print sq(4);
G, m := ext<F | 2>;
print m(a) eq G!a;
print "end";
