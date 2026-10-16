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
// two reals meet at the lower precision (CORR-0C6-1)
A := RealField(2)!(2/7); B := RealField(10)!(2/7); B/A; A/B; B - A; A - B; A eq B; B eq A; A lt B; B gt A; Parent(B*A);
A := RealField(10)!(2/7); B := RealField(30)!(2/7); B/A; A/B; B - A; A - B; A eq B; B eq A; A lt B; B gt A; Parent(B*A);
A := RealField(30)!(2/7); B := RealField(50)!(2/7); B/A; A/B; B - A; A - B; A eq B; B eq A; A lt B; B gt A; Parent(B*A);
A := RealField(50)!(2/7); B := RealField(80)!(2/7); B/A; A/B; B - A; A - B; A eq B; B eq A; A lt B; B gt A; Parent(B*A);
// a decimal tie prints to even (CORR-0C6-2)
RealField(2)!(5/4); RealField(2)!(9/4); RealField(2)!(11/4); RealField(2)!(13/4); RealField(3)!(1125/1000); RealField(2)!(249999/200000);
// a square root at its own scale (CORR-0C6-3)
Sqrt(RealField(10)!(1/10^30)); Sqrt(RealField(10)!(4/10^40)); Sqrt(RealField(50)!(1/10^120)); Sqrt(RealField(30)!(9*10^60)); Sqrt(RealField(30)!(2/10^50)); Sqrt(RealField(30)!2^-301);
// a real of precision 1 prints two significant digits
R1 := RealField(1); R1!(5/2); R1!(-5/2); R1!(1/3); R1!3; R1!(15/4); R1!(9/4); R1!100; R1!123; R1!0; R1!(1/1000); R1!(10^6); R1!(1/20);
// a literal is rounded once in binary: its last digit as Magma's
3.234567890123456789012345678904999999e-1500;
3.234567890123456789012345678904999999e-1001;
3.234567890123456789012345678904999999e-999;
3.234567890123456789012345678904999999e1000;
3.234567890123456789012345678904999999e1001;
3.234567890123456789012345678904999999e-2000;
3.234567890123456789012345678904999999e1700;
"end-literal";
// a real field's precision: a positive integer (its refusals: test/magma.test.ts)
RealField(1);
"end-prec";
