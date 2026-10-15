// Magma fixtures for the right ideal classes of our maximal orders
// (engine/hmf/src/classes.rs; tests only): Magma is used as a black box.
// Run from this directory with
//     magma -b magma-classes.m > magma-classes.txt
// For each line d | a b | den | h of quat-orders.txt with d <= 200 (our
// algebra (a, b)_F over F = Q(sqrt d) and our maximal order O, as in
// magma-quat.m), a line
//     d | H | [w_1, ..., w_H] | t
// with H = #RightIdealClasses(O), the w_i = #UnitGroup(LeftOrder(I)) (the
// unit groups O_L(I)^x / O_F^x) over the classes, sorted, and t the CPU time
// in seconds of RightIdealClasses and the unit groups (single thread).
SetColumns(0);
R<x> := PolynomialRing(Rationals());
va, vb, vc := GetVersion();
printf "# Magma %o.%o-%o, black box: QuaternionAlgebra, Order, RightIdealClasses, LeftOrder, UnitGroup\n", va, vb, vc;
ints := func<s | [eval t : t in Split(s, " ") | #t gt 0]>;
lines := [l : l in Split(Read("quat-orders.txt"), "\n") | #l gt 0 and l[1] ne "#"];
for l in lines do
  p := Split(l, "|");
  d := ints(p[1])[1];
  if d gt 200 then continue; end if;
  ab := ints(p[2]);
  den := ints(p[3])[1];
  h := ints(p[4]);
  if d mod 4 eq 1 then
    F<w> := NumberField(x^2 - x - (d - 1) div 4);
  else
    F<w> := NumberField(x^2 - d);
  end if;
  A<i, j, k> := QuaternionAlgebra<F | ab[1], ab[2]>;
  e := [A!1, i, j, k];
  basis := [&+[(h[8*r + 2*m + 1] + h[8*r + 2*m + 2]*w) / den * e[m + 1] : m in [0..3]] : r in [0..7]];
  O := Order(basis);
  assert &and[x in O : x in basis];
  t := Cputime();
  cls := RightIdealClasses(O);
  ws := Sort([#UnitGroup(LeftOrder(I)) : I in cls]);
  printf "%o | %o | %o | %o\n", d, #cls, ws, Cputime(t);
end for;
quit;
