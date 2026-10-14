// Input from stdin is a session: an error is reported and the input goes on.
x := 1;
x;
// a syntax error drops the statement and the rest of its line
y := (2 + ; x; x + 10;
x + 1;
y := (2 +
 * 3); x + 2;
x + 3;
z := 3 $ 4;
x + 4;
// an undeclared identifier
y := Foo(2);
print x, Baz;
x + 5;
// runtime errors
error "boom", x;
x + 6;
assert x eq 2;
x + 7;
error if x eq 1, "once more";
x + 8;
// an incomplete statement at the end of the input
y := (1 +
