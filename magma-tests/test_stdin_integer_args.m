// integer intrinsics at the edges of their arguments, as Magma takes them
// (their refusals, in Magma's words: test/magma.test.ts)
IsPrime(-13); IsPrime(-1); IsPrime(-4); IsProbablePrime(-13);
NextPrime(0); NextPrime(2); PreviousPrime(3);
PrimesUpTo(1); PrimesInInterval(1, 12); PrimesInInterval(7, 7);
NthPrime(0); NthPrime(5);
PrimeDivisors(-90); Divisors(1);
Gcd(-9, 0); Lcm(-6, 4); Gcd([-8, 12]);
Modexp(-3, 5, 11); Modexp(0, 0, 6); Modexp(4, -1, 9);
Modinv(5, 1); Modinv(-4, 9);
ChineseRemainderTheorem([3, 4], [5, 7]); ChineseRemainderTheorem([1, 5], [6, 10]);
ChineseRemainderTheorem([1, 2], [6, 10]); ChineseRemainderTheorem([2, 1], [-5, 3]); ChineseRemainderTheorem([4], [9]);
Valuation(-48, 2); Valuation(5/27, 3);
Seqint([0, 0, 1], 3); Seqint([9, 9]);
StringToInteger("+17"); StringToInteger("Zz", 36); StringToInteger("-101", 2);
Max([2, 9, 9]); Min({4, -1});
"end";
