// A rational function field over Q with its variable unnamed ($.1, as Magma prints it): its fractions and their gcd
// reduction go through internal polynomial rings named $.1, which must not meet the user-name check (#776).
F := FunctionField(Rationals());
x := F.1;
(x + 1)/(x + 2);
(x^2 - 1)/(x - 1);
(x^3 - x)/(x^2 + x);
