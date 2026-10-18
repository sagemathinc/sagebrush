# Generated from ../test_rational_parts.sage by Sage's preparser (run_cpython.py --regen).
_sage_const_3 = Integer(3); _sage_const_1024 = Integer(1024); _sage_const_6 = Integer(6); _sage_const_35 = Integer(35); _sage_const_7 = Integer(7); _sage_const_1 = Integer(1); _sage_const_2 = Integer(2)# A rational's numerator() and denominator() are Integers, with Sage's
# methods (under CPython they were plain ints).
q = _sage_const_3 /_sage_const_1024
print(q.numerator(), q.denominator(), q.denominator().nbits(), q.denominator().factor())
r = -_sage_const_6 /_sage_const_35
print(r.numerator().abs(), r.numerator().divisors(), r.denominator().is_prime(), r.denominator().factor())
print(parent(r.numerator()), parent(r.denominator()), (_sage_const_7 /_sage_const_1 ).denominator().is_one())
print(sum(x.denominator() for x in [_sage_const_1 /_sage_const_2 , _sage_const_1 /_sage_const_3 , _sage_const_1 /_sage_const_6 ]).factor())