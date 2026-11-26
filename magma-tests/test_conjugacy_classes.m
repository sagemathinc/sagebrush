// ConjugacyClasses of Sym(n): the classes' order (element order, length, then the larger
// representative), Magma's table (named by the group's variable), a copy and a changed sequence
G := Sym(5); Order(G); #ConjugacyClasses(G);
C := ConjugacyClasses(G); C;
Type(C); Type(C[1]); C[2]; C[2][3]; Parent(C[2][3]);
ConjugacyClasses(Sym(3));
ConjugacyClasses(Sym(1));
#ConjugacyClasses(Sym(6));
E := C; E;
C[1] := C[1]; C;
H := ConjugacyClasses(Sym(4)); Append(~H, H[1]); H;
5, ConjugacyClasses(Sym(2));
print ConjugacyClasses(Sym(2));
x := ConjugacyClasses(G)[7]; x; Order(x[3]);
[c[2] : c in ConjugacyClasses(Sym(4))];
ConjugacyClasses(DihedralGroup(3));
C := ConjugacyClasses(Sym(9)); #C; C[30]; [c[1] : c in C | c[2] eq 2520];
ConjugacyClasses(Sym(13));
// a fresh Sym(5) is G's (Magma's Sym(n) is one object): of group G, Id(G)
ConjugacyClasses(Sym(5))[1]; ConjugacyClasses(Sym(5));
// long representatives wrapped at 80 columns, the next line indented by 12
ConjugacyClasses(Sym(20));
