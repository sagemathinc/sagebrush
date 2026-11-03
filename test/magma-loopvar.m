// A for loop's variable is the loop's own (test/magma-loopvar.test.ts).  Run
// by Magma 2.18 as a session (magma -b < test/magma-loopvar.m), its output
// is test/magma-loopvar.out; Sagebrush must print the same.
print "L1 an outer variable is untouched";
i := 99; for i in [1..2] do print i; end for; print i;
print "L2 a new one stays unassigned";
for j in [1..2] do print j; end for; print assigned j;
print "L3 the := to form";
for k := 1 to 3 by 2 do print k; end for; print assigned k;
print "L4 its own range: unassigned there";
i := 3;
for i in [1..i] do print i; end for;
print i;
print "L5 another name in the range";
n := 3; for i in [1..n] do print i; end for; print i;
print "L6 nested: the inner range reads the outer loop's";
for a in [1..2] do for b in [1..a] do print a, b; end for; end for; print assigned a, assigned b;
print "L7 nested, same name: the inner loop's own";
for c in [1..2] do for c in [c..3] do print c; end for; end for;
print "L8 in a function";
function h2() s := 0; for m in [1..3] do s +:= m; end for; return s, assigned m; end function;
p, q := h2(); print p, q;
print "L9 a func made in the loop takes its value";
for r in [1..3] do if r eq 2 then fr := func<y | r*y>; end if; end for; print fr(10), assigned r;
print "L10 break and continue with the loop's name";
for u in [1..3] do for v in [1..3] do if v eq 2 then continue u; end if; if u eq 3 then break u; end if; print u, v; end for; end for;
print "L11 an error in the loop: still unassigned after";
for w in [1..3] do if w eq 2 then error "stop at", w; end if; end for;
print assigned w;
print "L12 assigned in the range";
for z in [1..(assigned z select 5 else 2)] do print z; end for;
print "done";
