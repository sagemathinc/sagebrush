// A file goes on after an undeclared identifier but stops at its first
// runtime error.
x := 1;
y := Foo(2);
x + 1;
print x, Baz;
x + 2;
assert x eq 2;
x + 3;
