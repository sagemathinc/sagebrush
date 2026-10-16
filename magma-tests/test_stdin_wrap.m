// Magma's 80-column layout: a chunk that doesn't fit moves to the next line
// past the middle of the line (counted from the indentation), and before it
// is split with a backslash in column 80
2^300;
-2^300;
[2^300, 5];
<2^300, 1>;
2^300, 7;
"abc", 2^300;
2^300 / 3^170;
[ 1, 2^250 ];
10^78; 10^79; -10^78;
2^1000;
// the edges: a comma or an item in column 80, the closing bracket alone
[ 1111111111, 2222222222, 3333333333, 4444444444, 5555555555, 10^14, 7 ];
[ 1111111111, 2222222222, 3333333333, 4444444444, 5555555555, 10^15, 7 ];
[ 1111111111, 2222222222, 3333333333, 4444444444, 5555555555, 10^16, 7 ];
[ 1111111111, 2222222222, 3333333333, 4444444444, 5555555555, 10^17, 7 ];
[ 1111111111, 2222222222, 3333333333, 4444444444, 5555555555, 10^77, 7 ];
[ 1111111111, 2222222222, 3333333333, 4444444444, 5555555555, 10^78, 7 ];
[10^76]; [10^77];
[ 1111111111, 10^65 ];
// the middle of the line: start columns 40 and 41
[ 111111111111111111111111111111111111, 10^69 ];
[ 1111111111111111111111111111111111111, 10^69 ];
// nested: indentation 4 (columns 42, 43) and 8 (columns 44, 45)
[ [ 1111111111111111111111111111111111, 10^69 ], [1] ];
[ [ 11111111111111111111111111111111111, 10^69 ], [1] ];
[ [ [ 11111111111111111111111111111111, 10^69 ], [1] ], [[1]] ];
[ [ [ 111111111111111111111111111111111, 10^69 ], [1] ], [[1]] ];
// strings, reals, tuples, sets, polynomials
s := &cat["a" : i in [1..100]]; s; [s];
<1111111111111111111111111111111111111111111111111111111111111111111111111, 22>;
<111111111111111111111111111111111111111111111111111111111111111111111111111, 2>;
{10^100, 3};
Zx<x> := PolynomialRing(Integers()); (10^100)*x^2 + 1;
// a tuple's or a string's own spaces are places to break too
[<10^20,10^45>,<2,3>];
[<10^37,10^45>];
["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "tail"];
// deep indentation: a chunk moves only when that gains more than the
// indentation (indentation 28, columns 55 and 57; indentation 40, 79)
[[[[[[[[ 11111111111111111111111, 10^85, 9 ]]]]]]]];
[[[[[[[[ 1111111111111111111111111, 10^85, 9 ]]]]]]]];
[[[[[[[[[[[ 10000000000000000000000000000000, 10^85, 9 ]]]]]]]]]]];
[[[[[[[[[[[ 1000000000000000000000000000000000000, 10^85, 9 ]]]]]]]]]]];
// error messages
error "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
error 10^65;
missingvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv;
