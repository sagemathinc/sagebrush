// values the coverage run found printed differently from Magma 2.18
// break x and continue x: the for loop of x, through the loops inside it
p := 10037;
for x in [1 .. 100] do
  for y in [1 .. 100] do
    if x^2 + y^2 eq p then x, y; break x; end if;
  end for;
end for;
for x in [1 .. 3] do
  for y in [1 .. 3] do
    if y eq 2 then continue x; end if;
    print x, y;
  end for;
  print "after y", x;
end for;
for x in [1 .. 2] do
  for y in [1 .. 2] do
    for z in [1 .. 3] do
      if z eq 2 then break y; end if;
      print x, y, z;
    end for;
  end for;
end for;
i := 0;
for x in [1 .. 3] do
  while true do
    i +:= 1;
    if i gt 4 then break x; end if;
    if i mod 2 eq 0 then break; end if;
  end while;
  print x, i;
end for;
function F(n)
  for i in [1 .. n] do
    for j in [1 .. n] do
      if i*j eq 6 then return <i, j>; end if;
      if j eq 3 then continue i; end if;
    end for;
  end for;
  return 0;
end function;
F(4);
for x in [1 .. 2] do break q; end for;
// a range set: printed as a range only while it is one
{ 2 .. 7 by 2 };
{ 6 .. 2 by -2 };
{ 5 .. 1 };
{ 3 .. 3 };
S := { 1 .. 4 }; Include(~S, 9); S;
S := { 1 .. 4 }; Exclude(~S, 2); S;
{ 1 .. 4 } join { 5 };
// a range's universe
T := { Integers() | 2 .. 6 by 2 }; T; Universe(T);
S := [ Rationals() | 1 .. 4 ];
R := { Rationals() | 1 .. 4 };
// a matrix's parent
Parent(Matrix(2, 2, [1, 2, 3, 4]));
Parent(Matrix(2, 3, [1, 2, 3, 4, 5, 6]));
Parent(Matrix(Rationals(), 2, 2, [1, 2, 3, 4]));
Parent(Matrix(Rationals(), 2, 3, [1, 2, 3, 4, 5, 6]));
// a class group's invariants, from the smallest
Zx<x> := PolynomialRing(Integers());
k := NumberField(x^2 + 1001);
g, m := ClassGroup(k); g;
// reals between 10^-4 and 1 print without an exponent
for v in [5*10^-4, 9.99*10^-5, 1.23*10^-4, -0.00123, 0.05] do RealField(10) ! v; end for;
// quadratic fields: the same for the same squarefree part
QuadraticField(5) eq QuadraticField(45);
QuadraticField(5) eq QuadraticField(5);
QuadraticField(5) eq NumberField(x^2 - 5);
NumberField(x^2 - 2) eq NumberField(x^2 - 2);
