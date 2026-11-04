// Magma gaps closed: a variable with no value passed by reference (P(~q)), an intrinsic given one, Append onto [], and where an error inside a loop points; the expected output is Magma 2.18's own
fs := [];
Append(~fs, func<x | x + 1>);
print fs[1](3);
gs := [];
Append(~gs, 5);
Append(~gs, 7);
print gs;
procedure P(~a)
  a := 7;
end procedure;
P(~q);
print q;
procedure Q(~a, b)
  a := b * 2;
end procedure;
Q(~r, 21);
print r;
for i in [1..3] do
  y := 10 div (2 - i);
  print y;
end for;
for i in [1..2] do
  for j in [1..2] do
    print i * j;
    if i eq 2 then z := [1,2][5]; end if;
  end for;
end for;
procedure S(~a)
  if false then a := 1; end if;
end procedure;
S(~v);
print v;
Append(~undefined_list, 5);
procedure T(~a, ~b)
  a := 1; b := a + 1;
end procedure;
T(~m1, ~m2);
print m1, m2;
print true / 0;
print 1 / false;
print false / 0;
print true div 0;
print 7 mod 0;
