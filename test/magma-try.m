// try ... catch e ... end try (src/magma.ts tryStmt, lib/_magma.py _caught): the expected output is Magma 2.18's own
z := 0;
try
  x := 1/z;
catch e
  print "A", e`Object;
  print "T", Type(e);
  print "P", e`Position;
end try;
try
  error "boom";
catch e
  print e;
end try;
try
  error 5;
catch e
  print "obj", e`Object, Type(e`Object);
end try;
function f(n)
  if n gt 2 then error "too big"; end if;
  return n;
end function;
try
  print f(1);
  print f(5);
  print "not here";
catch e
  print "f:", e`Object;
end try;
try
  try
    error "inner";
  catch e
    print "in:", e`Object;
    error "outer";
  end try;
catch e2
  print "out:", e2`Object;
end try;
for i in [1..5] do
  try
    if i eq 3 then error "three"; end if;
    print i;
  catch e
    print "skip", i;
    continue;
  end try;
end for;
try
  print undefined_x;
catch e
  print "U", e`Object;
end try;
try
  error if 1 eq 1, "cond";
catch e
  print "C", e`Object;
end try;
h := 5;
try
  error "x";
catch h
  print "in", h`Object;
end try;
print h;
for i in [1..3] do
  try
    error "y";
  catch e
    if i eq 2 then break; end if;
    print "c", i;
  end try;
end for;
for i in [1..2] do
  for j in [1..2] do
    try
      error "z";
    catch e
      print i, j;
    end try;
  end for;
end for;
try
  try
    error "deep";
  catch e
    print "x";
    e2 := e;
  end try;
catch f
  print "y";
end try;
print e2`Object;
print Type(e2);
z := 0;
try
  x := 1/z;
catch e
  print e;
  print "after print";
  print Type(e);
  print e`Type;
end try;
try
  assert 1 eq 2;
catch e
  print "AS", e`Object;
end try;
try
  error "a", 5, [1,2];
catch e
  print "M", e`Object;
  print e`Type;
end try;
function g(n)
  try
    return 1/n;
  catch e
    return -1;
  end try;
end function;
print g(2), g(0);
procedure P(~a)
  try
    a := a + 1;
    error "proc";
  catch e
    a := a + 100;
  end try;
end procedure;
q := 1; P(~q); print q;
