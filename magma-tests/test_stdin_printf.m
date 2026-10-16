// printf and Sprintf, as the Handbook describes them (Magma 2.18)
for i := 1 to 150 by 33 do printf "[%3o]\n", i; end for;
for i := 1 to 150 by 33 do printf "[%-3o]\n", i; end for;
for w := 1 to 5 do printf "[%*o]", w, 1; end for;
printf "\n[%*o][%*o][%0o][%3o]\n", 4, 7, -4, 7, 5, 12345;
p := 53.211; x := 123.2;
printf "%.3o%% of %.2o is %.3o\n", p, x, p/100.0 * x;
printf "[%8.3o][%-8.2o][%.3o][%.2o][%.3o]\n", 3.14159, 2.0, 7, 1/3, "abcdef";
printf "[%h][%h][%5h][%h]\n", 255, 4096, 10, -255;
printf "[%o][%O][%o]\n", "s", "t", "Default", [1, 2];
printf "[%o]\n", 1, 2;
Q := [Sprintf("{%4o<->%-4o}", x, x): x in [1, 10, 100, 1000]];
Q;
printf "%o %o\n", 1;
printf "[%d]\n", 5;
printf "%";
printf "[%h]\n", 2.5;
printf "[%O]\n", 5, "Bogus";
printf "[%O]\n", 5;
printf "[%*o]\n", "x", 5;
printf 5;
// Sprint and Sprintf make strings: no 80-column layout of a value on one
// line; nested elements a line each, without indentation
s := Sprint(3^700); #s; Position(s, "\\"); Position(s, "\n");
t := Sprint([i : i in [1..40]]); #t; Position(t, "\n");
u := Sprint([[i : i in [1..30]],[2]]); #u; u;
v := Sprintf("%o", [i : i in [1..40]]); #v; Position(v, "\n");
x := Sprintf("a%ob", 7^150); #x; Position(x, "\n");
y := "abc" cat Sprint(10^100); #y; Position(y, "\\");
z := Sprint(<[i : i in [1..30]], 2>); #z; Position(z, "\n");
a := Sprint([<1, [2, 3]>, <4, [5]>]); a;
b := Sprint([[[1]], [[2]]]); b;
d := "x" cat Sprint([[1],[2]]); d;
f := Sprint([ 10^90 ]); #f; Position(f, "\n");
g := Sprintf("%10o|%-6o|", [1,2], 5); g;
// (each shape as Sprint and as Sprintf: length, equal, first newline)
P := func< v | <#Sprint(v), Sprint(v) eq Sprintf("%o", v), Index(Sprint(v), "\n")> >;
P(7^95); P(10^79); P(-10^79); P(10^83 / 7); P(2^9000);
P("yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy");
P("q q q q q q q q q q q q q q q q q q q q q q q q q q q q q q q q q q q q q q q q q q q q q q q q q");
P([3..44]); P(<3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33>);
P([i^2 : i in [1..35]]); P({@ i^2 : i in [1..35] @}); P({* i^2 : i in [1..35] *}); P({ i^2 : i in [1..35] });
P({3..44}); P([[i : i in [1..20]], [i : i in [21..40]]]);
P(["c c c c c c c c c c c c c c c c c c c c c c c c c c c c c c c c c c c c c c c c c c c c c c c c", "d"]);
P([[5,6],[7,8]]); P(<10^90, 10^90, 4>); P([<10^90, "u">, <3, "w">]);
P([[], [5,6]]); P("three\nfour"); P([false, true, false]);
// no width layout inside a nested value either (CORR-173-1)
P([[10^85, 3], [4, 10^85]]); Position(Sprint([[10^85, 3], [4, 10^85]]), "\\");
P([[i^3 : i in [1..40]], [5]]); P([["r r r r r r r r r r r r r r r r r r r r r r r r r r r r r r r r r r r r r r r r r r"]]);
P({ [10^85], [6] }); P([<10^85, 7>, <8, 9>]);
