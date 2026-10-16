// Python's names never reach a Magma program: an unassigned ord, len, sum
// or list is undeclared, and a variable of that name is the program's
ord;
x := len([1, 2]);
sum := 0; for i in [1 .. 4] do sum +:= i; end for; sum;
list := [3, 4]; list[2];
max := func< a, b | a gt b select a else b >; max(3, 9);
// x, y in S: each over S, the first the outer loop
[ <a, b> : a, b in [1 .. 2] ];
[ <a, b, c> : a, b in [1 .. 2], c in [5, 6] ];
cubes := { -8, -1, 0, 1, 8 };
#{ { x, y } : x, y in cubes | x + y eq 0 };
// coercion: Q ! [n, d], a polynomial from coefficients, a field's element
Q := Rationals();
Q ! [1, 2];
Q ! [3, 0];
Q ! [1, 2, 3];
Q ! [1/2, 3];
P<t> := PolynomialRing(Rationals());
P ! [ [1, 2], [2, 3] ];
Z<y> := PolynomialRing(Integers());
Z ! [1, 2];
Z ! [1/2];
Zx<z> := PolynomialRing(Integers());
k := NumberField(z^2 - 2); l := NumberField(z^2 - 3);
l ! k.1;
l ! 2;
// Random(a, b): an integer in [a, b]
r := [ Random(1, 4) : i in [1 .. 50] ];
&and[ v ge 1 and v le 4 : v in r ];
