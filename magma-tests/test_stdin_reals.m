// reals are binary, as Magma's (100 bits for 30 digits, 167 for 50): an
// exact operand is coerced into the real's own field, and every operation
// is rounded once (CORR-C682-1, CORR-C682-2)
R := RealField(50);
a := R!(10^45 + 3); a - (10^45 + 3); a eq 10^45 + 3; Parent(a / 7); Parent(7 / a);
b := R!(2/7); b - 2/7; b eq 2/7; b * 7; Parent(b - 1);
c := RealField(20)!(1/3); c; c eq 1/3; c * 3; Parent(c + 1);
d := RealField(10)!5; d / 3; Parent(d / 3);
(5^(1/2))^2;
(2^(1/2))^2;
(1/7)/(3^(1/2));
(1.0/11)*11; (1.0/3)*3; (1.0/9)*9;
(10^60 + 1)/(10^59)^(1/2);
(2^(1/3))^3;
Sqrt(2.0) * Sqrt(2.0);
x := 1.0; for i in [1..10] do x := x / 3; end for; for i in [1..10] do x := x * 3; end for; x;
1.0 + 2^(-99); 1.0 + 2^(-100); (1.0 + 2^(-99)) eq 1.0; (1.0 + 2^(-100)) eq 1.0;
RealField(50)!1 + 2^(-166) eq RealField(50)!1; RealField(50)!1 + 2^(-167) eq RealField(50)!1;
1.1^100;
1.0001^10000;
0.5^1000;
(-1.5)^7;
2.0^(-10);
Pi(RealField(40));
Exp(1.0); Log(10.0); Sqrt(10.0);
1/3 + 0.5;
0.1 + 0.2; 0.1 + 0.2 eq 0.3;
// large powers, as Magma takes them (and the exponent it refuses)
1.0001^100000;
0.999^123456;
(1.0 + 2^(-60))^(2^29);
(1.0 + 2^(-60))^(2^30);
