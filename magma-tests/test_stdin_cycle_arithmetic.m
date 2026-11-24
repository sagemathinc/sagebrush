// A cycle written in a permutation group's context is an element of that group, as Magma 2.18-5 makes it, so
// arithmetic on it works there: G!((1, 2)^2) is Id(G); a cycle the group doesn't have is Magma's error at its "(".
G := Sym(3);
G!((1,2)^2);
G!((1,2)*(2,3));
G!((1,2,3)^2);
G!((1,2)^-1);
G!((1,2,3)^2 * (1,2));
G!((1,2)(2,3)^2);
G!((1,2)(2,3)(1,3)^3);
x := G!((1,2)*(1,3)); x; Parent(x);
G!((1,2,3)/(1,2));
G!((1,4)^2);
H := Sym(4); H!((1,4)^2 * (2,3));
D := DihedralGroup(4); D!((1,2,3,4)^2);
// in a subgroup's context the arithmetic is in Sym(n), and only the result is coerced into the group
D!((1,2)^2);
D!((1,2)*(3,4));
D!((1,2)(3,4));
D!((1,2)/(1,2));
D!((1,5)^2);
// the innermost context's degree governs a cycle
G := Sym(3); H := Sym(4); H!(G!((1,4)^2));
f := func< | (1,2,3)^2>; G!f();
(1,2)^2;
// g/h is g*h^-1 for permutations; with a number, Magma's "Bad argument types"
a := G!(1,2,3); b := G!(1,2);
a/b;
1/b;
b/1;
b/(1/2);
y := a; y /:= a; y;
print "end";
