// A number field's maximal order, printed as Magma 2.18-5 prints it: the equation order's polynomial always in x,
// and a long description wrapped (the polynomial continued 4 more in, what follows it at the order's indentation).
P := PolynomialRing(Rationals());
print MaximalOrder(NumberField(P.1^3 - 2));
P<t> := PolynomialRing(Rationals());
print MaximalOrder(NumberField(t^3 - 2));
Q<u> := PolynomialRing(Integers());
print MaximalOrder(NumberField(u^2 + 1));
print MaximalOrder(NumberField(u^2 - 5));
print MaximalOrder(NumberField(u^3 - 19));
print MaximalOrder(CyclotomicField(5));
print MaximalOrder(NumberField(u^6 + u^5 + u^4 + u^3 + u^2 + u + 1));
print MaximalOrder(NumberField(u^7 + 3*u^5 - 11*u^4 + 101*u^2 - 1234567*u + 7654321));
O := MaximalOrder(NumberField(u^3 - 2));
O;
print [O];
print <O, 1>;
O6 := MaximalOrder(NumberField(u^6 + u^5 + u^4 + u^3 + u^2 + u + 1));
print <1, <O6, 2>>;
print <O6, 1>;
printf "%o\n", O6;
printf "order: %o\n", O6;
print [<O6>];
s := Sprint(MaximalOrder(NumberField(u^6 + u^5 + u^4 + u^3 + u^2 + u + 1)));
print #s;
print "end";
