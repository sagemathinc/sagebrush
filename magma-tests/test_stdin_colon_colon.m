// :: is one token, as Magma 2.18-5 reads it: where it can't stand, the bad syntax is at its first colon; ::= is
// : and :=, and a zero denominator before :: is the parser's bad syntax there.
print 1 :: 2;
x := 1 :: 2;
1 ::;
x :: y;
print [1 :: 2];
x := [1, 2 :: 3];
x := <1 :: 2>;
print 1 :: Magma;
print 1 :Magma;
a ::= 1;
x := 1 ::= 2;
z := 1; y := z::2;
print 1/0 :: 2;
1/0 :: 2;
print "end";
