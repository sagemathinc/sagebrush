// Records: recformat< ... >, rec< ... >, fields, assigned, delete.
// Read on stdin (a session), so that the errors don't stop it.
Pt := recformat< x : Integers(), y : Integers(), label, tags : SeqEnum, k : RngIntElt >;
Pt;
Type(Pt);
Names(Pt);
p := rec< Pt | >;
p;
Type(p);
q := rec< Pt | label := "origin", y := 0, x := 0 >;
q;
q`label;
assigned p`x, assigned q`x;
p`x := 21/7;
p`x, Type(p`x);
p`tags := [4, 5, 6];
p`tags[2] := 50;
p;
Names(q);
// value semantics: a copy
r := q;
r`x := 9;
q`x, r`x;
q`x +:= 1;
q`x;
// a field named by a string
q``"y";
name := "label";
q``name;
q``name := "moved";
q;
delete q`label;
q;
assigned q`label;
<q`x, q`y>;
[p, q];
// fields that don't fit
p`k := "seven";
p`x := 1/2;
z := p`nosuch;
z := q`tags;
rec< Pt | tags := { 1 } >;
rec< Pt | x := "no" >;
// a format prints with the oldest variable that holds it now
F := recformat< a, b >;
G := F;
H := F;
s := rec< F | a := 1 >;
s;
delete F;
s;
delete G;
delete H;
s;
// nested records and long values
Inner := recformat< m >;
Outer := recformat< inner : Rec, items >;
o := rec< Outer | inner := rec< Inner | m := 2 >, items := [ i^2 : i in [1..30] ] >;
o;
rec< Inner | m := "a long string value that does not fit on one line of eighty columns at all" >;
rec< recformat< u, v > | v := { 3, 1, 2 } >;
function mk(n)
    L := recformat< n >;
    return rec< L | n := n >;
end function;
mk(5);
assigned undefined_name;
x := 1;
assigned x;
// formats and records Magma refuses
Twice := recformat< u, v, u >;
Twice;
Ok := recformat< u, v >;
rec< Ok | u := 1, v := 2, u := 3 >;
rec< Ok | w := 1 >;
rec< Ok | u := 1, w := 2, u := 3 >;
recformat< u : 7 >;
recformat< u : Integers(), v : true >;
recformat< u : "text" >;
Empty := recformat< >;
Empty;
Names(Empty);
// assigned and delete take a name or a record field, not an index
seq := [4, 5, 6];
assigned seq[2];
assigned seq;
delete seq[2];
seq;
