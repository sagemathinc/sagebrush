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
// a tuple is not an index; S[i, j] is S[i][j] while it can be indexed
T := [[5,6],[7]]; T[<1,2>];
T[<2>];
T[<>];
T[1,2];
T[1,2,1];
// index lists: of an empty sequence, of a string (the place in the list
// names the index), of a tuple, of an indexed set; undefined elements kept
E := []; E[[2]];
w := "xyz"; w[[2,7]];
w[2..5];
u := <5,6>; u[[1,2]];
u[2..1];
I := {@ 6, 7 @}; I[[2,1]];
I[[1,4]];
I[3..1];
N := {@ @}; N[true];
N[1..0];
V := [5]; V[4] := 9; V[1..4];
V[2..3];
