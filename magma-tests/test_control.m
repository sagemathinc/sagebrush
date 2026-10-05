// procedures, reference arguments, value semantics, closures
procedure Inc(~n) n +:= 1; end procedure;
n := 5; Inc(~n); n;
procedure Push(~L, x) Append(~L, x); end procedure;
L := [1]; Push(~L, 2); Push(~L, 3); L;
procedure Swap(~a, ~b) t := a; a := b; b := t; end procedure;
a := 1; b := 2; Swap(~a, ~b); a, b;
A := [[1, 2], [3]]; B := A; B[1][1] := 100; A; B;
function F(S) S[1] := 0; return S; end function;
X := [5, 6]; Y := F(X); X; Y;
make := function(k) return func<x | x + k>; end function;
add3 := make(3); add3(10);
fib := function(n) if n le 2 then return 1; end if; return $$(n-1) + $$(n-2); end function;
[fib(i) : i in [1..15]];
function Collatz(n)
    steps := 0;
    while n ne 1 do
        n := IsEven(n) select n div 2 else 3*n + 1;
        steps +:= 1;
    end while;
    return steps;
end function;
[Collatz(n) : n in [1..20]];
// loops with break and continue
s := 0;
for i in [1..100] do
    if i mod 3 eq 0 then continue; end if;
    if i gt 20 then break; end if;
    s +:= i;
end for;
s;
for i := 10 to 1 by -3 do print i; end for;
k := 0; repeat k +:= 2; until k ge 7; k;
for x in ["a", "bb", "ccc"] do printf "%o has length %o\n", x, #x; end for;
// case
for v in [1, 2, 3, 4] do
    case v:
        when 1, 2: print "small";
        when 3: print "three";
        else: print "big";
    end case;
end for;
// tuples, sets, multisets, indexed sets
t := <1, "two", [3]>; t[3]; #t;
t[1] := 10; t;
S := {1, 2, 3}; Include(~S, 10); Exclude(~S, 2); S;
3 in S, 2 in S, 2 notin S;
{1, 2} subset S;
M := {* 1, 1, 2, 3, 3, 3 *}; M; #M;
I := {@ "x", "y", "z" @}; I[2]; I;
&+[x : x in {1..10}];
&cat[ "a", "b", "c" ];
&cat[ [1], [2, 3] ];
&and[ IsPrime(p) : p in [2, 3, 5] ];
&or[ IsEven(p) : p in [3, 5, 7] ];
// sorting and searching
Sort([5, 3, 9, 1]);
Sort([5, 3, 9, 1], func<a, b | b - a>);
Sort(["pear", "apple", "fig"]);
L := [10, 20, 30]; L[4] := 40; L;
L[2..3];
Position(L, 30), Index(L, 99);
#[1..0];
[];
Reverse("abc");
"abc"[2];
"hello" eq "hello", "a" lt "b";
// strings
s := "Magma"; #s, s cat "!" ;
IntegerToString(255, 16), StringToInteger("ff", 16);
Sprintf("%o + %o = %o", 2, 3, 5);
printf "[%3o]\n", 7;
// arithmetic corner cases
-7 div 2, -7 mod 2, 7 div -2, 7 mod -2;
(-2)^3, 2^-2, (2/3)^-2;
Abs(-7/3), Floor(-7/3), Ceiling(-7/3), Round(-7/3);
Gcd([12, 18, 30]), Lcm([4, 6, 10]);
Valuation(-96, 2);
IsSquare(49/4);
Numerator(-6/4), Denominator(-6/4);
x := 0; x +:= 1/2; x *:= 4; x;
