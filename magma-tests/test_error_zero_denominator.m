// An integer literal over a literal zero stops a file as Magma 2.18-5 reads the statement, even in a function
// that is never called: the statement before it has run, the one after never does.
print "before";
f := func< | (-1)/(0) >;
print "after";
