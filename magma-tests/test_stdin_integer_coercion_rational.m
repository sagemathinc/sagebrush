// A rational coerced into the integers, as Magma 2.18-5 has it: a whole one is its integer, any other is "Rational
// argument is not a whole integer", at the !.
Integers()!(1/2);
Integers()!(-2^-1);
Integers()!(+2^-1);
Integers()!(-1/3);
Integers()!(4/2);
Integers()!(-6/3);
Z := Integers(); Z!(7/2);
IntegerRing()!(5/4);
x := 3/2; Integers()!x;
Integers()!(10^20/3);
Rationals()!(1/2);
print "end";
