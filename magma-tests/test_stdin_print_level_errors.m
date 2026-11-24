// print x : Level, as Magma 2.18-5 reads it: a name that isn't a print level is "Bad print level" at the name, before
// the statement runs; a level anywhere but the end of a print, or of a statement of its own, is bad syntax.
print 1 : Foo;
print 1 : foo;
print 1 : TeX;
print 1 : MAGMA;
x := 3; print x : Foo;
print 1, 2 : Foo;
print "a"; print 1 : Sage;
print 1 : Magma;
print 1 : Minimal;
print 1 : Maximal;
print 1 : Default;
print 1 : Latex;
print 1 : Debug;
print 1 : : Magma;
print 1 : Magma : Foo;
print 1 : 2;
x := 1 : Magma;
f := func<x | x : Magma>;
printf "%o", 1 : Magma;
print "end";
