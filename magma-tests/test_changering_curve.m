// ChangeRing of an elliptic curve over the rationals to GF(q): the reduced curve and its
// number of points (over GF(p^k) too), the plane cubic at a prime dividing the model's
// discriminant and # of it, the curve's type, long lines wrapped
E := EllipticCurve([0, -1, 1, -10, -10]); Rank(E); #ChangeRing(E, GF(101));
Ep := ChangeRing(E, GF(101)); Ep; #Ep; Type(Ep); Type(E);
ChangeRing(E, GF(11)); #ChangeRing(E, GF(11));
ChangeRing(E, GF(5));
ChangeRing(E, GF(25)); #ChangeRing(E, GF(25)); #ChangeRing(E, GF(9));
E := EllipticCurve([1, 1, 1, 1, 1]); ChangeRing(E, GF(7));
E := EllipticCurve([3, 0, 2, 0, 0]); ChangeRing(E, GF(7));
E := EllipticCurve([0, 0, 0, 0, 1]); ChangeRing(E, GF(7)); ChangeRing(E, GF(5));
E := EllipticCurve([0, 0, 0, 7, 7]); ChangeRing(E, GF(7));
E := EllipticCurve([1, 3]); F := ChangeRing(E, GF(1000003)); F; #F;
F eq ChangeRing(E, GF(1000003));
F := ChangeRing(E, GF(7^3)); F; #F;
E := EllipticCurve([1, 2, 3, 4, 5]); C := ChangeRing(E, GF(11)); C; ChangeRing(E, GF(941)); Type(C); C eq C;
p := 2^61 - 1; F := ChangeRing(EllipticCurve([1, 2, 3, -4, -5]), GF(p)); F; #F;
F := ChangeRing(EllipticCurve([123456789, 987654321, 1122334455, -4, -5]), GF(p)); F;
E := EllipticCurve([0, 0, 1, -1, 0]); [#ChangeRing(E, GF(p)) : p in [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31]];
E := EllipticCurve([0, 0, 0, -1, 0]); F := ChangeRing(E, GF(3)); F; #F;
