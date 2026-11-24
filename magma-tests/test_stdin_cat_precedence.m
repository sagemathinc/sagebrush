// cat binds tighter than * / div mod meet and + - join, and looser than ^ and the unary operators, as Magma 2.18-5
// reads it: the argument types in each error show which operation ran first.
2/1 cat [1];
x := 4; x/2 cat [1];
(1/2)*2 cat [1];
(1/2) + 2 cat [1];
(1/2) - 2 cat [1];
(3/2) div 1 cat [1];
x mod 2 cat [1];
{1} meet {2} cat [1];
2 cat [1] * (1/2);
(1/2) cat [1] + 2;
// a literal zero followed by cat is not a zero denominator: the denominator is 0 cat [1]
1/0 cat [1];
1/0 cat "a";
"a" cat 1/0;
1/(0) cat [1];
// tighter than cat: ^, unary minus, #
"x" cat "y" ^ 2;
-[1] cat [2];
#[1] cat [2];
2^[1] cat [2];
// and as before
[1] cat [2] cat [3];
[1] cat [2] eq [1, 2];
"a" cat "b" cat "c";
S := [1]; S cat:= [2] cat [3]; S;
&cat [[1], [2]];
[1..2] cat [3];
print "end";
