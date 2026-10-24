P<x> := PolynomialRing(GF(5)); R<z> := PolynomialRing(Rationals());
RootsInSplittingField(P!0);
RootsInSplittingField(z^2 + 1);
RootsInSplittingField(x, 2);
RootsInSplittingField(5);
r, K := RootsInSplittingField(x^2 + 2);
r;
K;
"end";
