// A function, procedure or func< > takes the values of the variables it
// reads when it is defined: later assignments don't reach it.
base := 10;
function addbase(n) return n + base; end function;
base := 20;
addbase(1);
lst := [3, 4];
function first() return lst[1]; end function;
Append(~lst, 5);
lst[1] := 30;
first(), lst;
RF := recformat< k >;
rv := rec< RF | k := 2 >;
function getk() return rv`k; end function;
rv`k := 9;
getk();
inc := func< t | t + 1 >;
function useinc(t) return inc(t); end function;
inc := func< t | t + 1000 >;
useinc(1);
step := 4;
bump := func< t | t + step >;
step := 40;
bump(1);
amount := 6;
procedure addto(~v) v +:= amount; end procedure;
amount := 60;
acc := 1;
addto(~acc);
acc;
// a name not assigned when the function is defined: the definition is
// rejected, so the function stays undeclared
function needslater() return later + 1; end function;
later := 1;
needslater();
g := func< t | t + notyet >;
notyet := 1;
// assigned: a global is not assigned inside; a parameter or local is
function tglob() return assigned base; end function;
tglob();
function tpar(p) return assigned p; end function;
tpar(0);
function tloop()
  out := [];
  for i in [1..3] do
    Append(~out, assigned w);
    w := i;
  end for;
  return out;
end function;
tloop();
// read first, then assigned: rejected
function rw() x := base; base := 1; return x; end function;
rw();
function ra() return base + (assigned base select 1 else 0); end function;
// an element of a variable can only be assigned once it is local
function el() lst[1] := 0; return lst; end function;
function el2() s := lst; s[1] := 0; return s; end function;
el2(), lst;
// recursion, also after the name is given to another function
function down(n) if n le 0 then return 0; end if; return 1 + down(n - 1); end function;
old := down;
function down(n) return -1; end function;
old(4), down(4);
// forward: mutual recursion, and a function defined later
forward isev, isod;
function isev(n) return n eq 0 select true else isod(n - 1); end function;
function isod(n) return n eq 0 select false else isev(n - 1); end function;
isev(6), isod(6);
forward twice;
function twiceplus(n) return twice(n) + 1; end function;
function twice(n) return 2 * n; end function;
function twice(n) return 3 * n; end function;
twiceplus(5);
// intrinsics are taken when the function is defined, too
function g12(n) return Gcd(n, 12); end function;
Gcd := 0;
g12(8);
// nested: an inner function takes the outer one's locals when it is made
function outer(m)
  k := m + 1;
  f := function(y) return y + k; end function;
  k := 100;
  return f(1);
end function;
outer(5);
// a map rule's undeclared name is rejected when the map is made
Z := Integers();
mm := map< Z -> Z | y :-> y + undef >;
undef := 2;
mm2 := map< Z -> Z | y :-> y + base >;
base := 0;
mm2(1);
// named parameters are the function's own, not captured
withp := function(u : Twice := false, Tag := "t") return <Twice select 2 * u else u, Tag>; end function;
withp(3), withp(3 : Twice := true, Tag := "s");
fp2 := func< u : Off := 1 | u + Off >;
fp2(1), fp2(1 : Off := 5);
// each forward makes its own cell: a later forward of the name, or another
// call of a function with a forward inside, doesn't change older functions
forward H1;
function U1(n) return H1(n); end function;
function H1(n) return 2 * n; end function;
forward H1;
function U2(n) return H1(n); end function;
function H1(n) return 3 * n; end function;
U1(5), U2(5), H1(5);
function Build(c)
  forward hh;
  function front(n) return hh(n); end function;
  function hh(n) return n * c; end function;
  return front;
end function;
by2 := Build(2); by5 := Build(5);
by2(3), by5(3);
// an intrinsic Sagebrush lacks: a local of the same name in another
// function doesn't make its use here a variable assigned later
function usesmissing(v) return KernelMatrix(v); end function;
function other() KernelMatrix := 1; return KernelMatrix; end function;
assigned usesmissing, assigned other;
// local and delete make a function's own variable
lv := 7;
function hasloc() local lv; return assigned lv; end function;
function hasloc2() local lv; lv := 8; return lv; end function;
function del1() lv := 9; delete lv; return assigned lv; end function;
function del2() delete lv; return 0; end function;
function del3() lv := 1; delete lv; lv := 2; return lv; end function;
hasloc(), hasloc2(), del1(), assigned del2, del3(), lv;
// a variable deleted before a definition: the definition is rejected
dv := 3;
delete dv;
function usesdv() return dv; end function;
fdv := func< t | t + dv >;
mdv := map< Z -> Z | t :-> t + dv >;
assigned usesdv, assigned fdv, assigned mdv;
dv := 4;
function usesdv2() return dv; end function;
usesdv2();
