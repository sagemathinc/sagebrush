# A rational's numerator() and denominator() are Integers, with Sage's
# methods (under CPython they were plain ints).
q = 3/1024
print(q.numerator(), q.denominator(), q.denominator().nbits(), q.denominator().factor())
r = -6/35
print(r.numerator().abs(), r.numerator().divisors(), r.denominator().is_prime(), r.denominator().factor())
print(parent(r.numerator()), parent(r.denominator()), (7/1).denominator().is_one())
print(sum(x.denominator() for x in [1/2, 1/3, 1/6]).factor())
