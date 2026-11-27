// Generator names in a multiple assignment, as Magma 2.18-5 binds them: the structure at its place named, the
// other values bound as usual.
F<a> := GF(4);
G<g>, m := ext<F | 3>;
print G;
print g, g^63;
print m;
print m(a) eq g^21, Domain(m) eq F, Codomain(m) eq G;
H<h>, _ := ext<F | 2>;
print h, H;
X, n := ext<F | 3>;
print X;
print n;
// fewer values than names: Magma's error at the :=
K<k>, p := 5;
