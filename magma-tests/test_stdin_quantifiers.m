// exists{ } and forall{ }, with witnesses or without (Magma 2.18)
exists{ x : x in [1..5] | x gt 3 };
exists{ x : x in [] | true };
forall{ x : x in [1..5] | x gt 0 };
forall{ x : x in [] | false };
exists{ x : x in [1..3] };
exists(t){ x : x in [1..5] | x gt 3 }; t;
forall(t){ x : x in [1..5] | x lt 3 }; t;
exists(t){ <x, y> : x, y in [1..5] | x*y eq 6 }; t;
exists(u, v){ <x, y> : x in [1..3], y in [4..6] | x + y eq 7 }; u, v;
exists(r){ x : x in [1..5] | x gt 9 };
assigned r;
f := func< n | exists{ d : d in [2..n-1] | n mod d eq 0 } >; f(9), f(7);
{ x : x in [1..10] | exists{ d : d in [2..x-1] | x mod d eq 0 } };
function IsPerfectPower(n)
  return exists(p){ <b, e> : b in [2..n], e in [2..20] | b^e eq n };
end function;
IsPerfectPower(64), IsPerfectPower(10);
forall{ <c, d> : c, d in [1, 2, 3] | c + d gt 1 };
// a multiple assignment of fewer values: Magma's words, at the :=
b, w := exists{ x : x in [1..5] | x gt 3 };
function g() return 1, 2; end function;
a, b, c := g();
// no witness: the witnesses are unassigned, not left with old values
w := 99;
exists(w){ x : x in [1..3] | x eq 8 };
assigned w;
w;
w := 99;
forall(w){ x : x in [1..3] | x lt 8 };
assigned w;
u := 1; v := 2;
exists(u, v){ <x, y> : x in [1..2], y in [1..2] | x + y eq 9 };
assigned u, assigned v;
function F()
  t := 5;
  b := exists(t){ x : x in [1..3] | x gt 7 };
  return assigned t;
end function;
F();
exists(z){ x : x in [] | true }; assigned z;
w := 1; exists(w){ x : x in [5..7] | x gt 5 }; w;
