// A permutation coerced into a permutation group of another degree, as Magma 2.18-5 has it: "Could not find a
// covering group"; of the same degree but not in the group, an illegal coercion.
G := Sym(4);
H := Sym(5);
H!(G!(1, 2));
x := G!(1, 2, 3);
H!x;
Sym(3)!x;
G!(Sym(3)!(1, 2));
Sym(4)!(G!(1, 2));
D := DihedralGroup(4);
D!(G!(1, 2));
D!(G!(1, 3));
D!(H!(1, 2));
G!(D.1);
H!(D.1);
E := DihedralGroup(5);
G!(E.1);
H!(E.1);
print "end";
