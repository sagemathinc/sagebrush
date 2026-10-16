// an intrinsic is one name over many signatures, chosen by the argument types
// the types of matrices
a := Matrix(Integers(), 3, 3, [2, 0, 1, 5, -4, 7, 1, 1, 9]);
b := Matrix(Rationals(), 2, 3, [1/2, 0, 1, 5, -4, 7]);
Type(a); Type(b); Type(Matrix(Rationals(), 2, 2, [1/3, 1, 0, 2]));
Type(Matrix(Integers(), 1, 3, [4, 5, 6])); Type(a) eq AlgMatElt;
// which types are also which
ISA(AlgMatElt, MtrxS); ISA(ModMatRngElt, MtrxS); ISA(ModMatRngElt, RngElt); ISA(AlgMatElt, RngElt);
ISA(ModMatFldElt, ModMatRngElt); ISA(ModMatFldElt, MtrxS); ISA(ModMatRngElt, ModMatFldElt);
ISA(FldQuadElt, FldNumElt); ISA(FldNumElt, FldQuadElt); ISA(FldQuadElt, FldAlgElt);
ISA(RngIntElt, FldElt); ISA(FldRatElt, FldElt); ISA(FldFinElt, RngElt); ISA(SeqEnum, Any);
ISA(FldQuad, FldNum); ISA(FldFin, Fld); ISA(RngInt, Fld); ISA(SeqEnum, Str); ISA(Tup, Str);
// one name, a function for each type
Trace(a);
Trace(Matrix(Rationals(), 2, 2, [1/3, 1, 0, 2]));
Trace(12); Trace(-5/6);
K<r> := QuadraticField(-5); Trace(2 - 3*r); Trace(r^2);
L<s> := NumberField(PolynomialRing(Rationals()).1^3 - 3); Trace(s + 1);
F<y> := GF(25); Trace(y); Trace(y^3); Trace(F!3);
G<t> := GF(7); Trace(t + 2);
// (arguments no signature takes: test/magma.test.ts, as Magma says it but
// for the caret, which Magma puts at the call)
"end";
