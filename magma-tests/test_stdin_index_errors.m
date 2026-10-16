// reading S[i] outside a sequence, string, tuple or indexed set: Magma's
// words, at the "["
a := [1,2,3];
a[5];
a[0];
a[-1];
b := a[7];
s := "abc"; s[5];
s[0];
t := <1,2>; t[3];
a[2] := 9; a[6] := 1; a;
a[4];
a[7];
e := [ ]; e[1];
e[0];
I := {@ 4, 5 @}; I[3];
I[0];
J := {@ @}; J[1];
c := [ [1,2], [3] ]; c[2][2];
c[1,2];
c[3,1];
c[1,3];
a[[1,9]];
a[1..9];
x := a[1.5];
x := a[true];
a[2], a[6];
