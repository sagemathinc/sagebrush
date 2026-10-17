# lib/board_checks.py, in Sage mode: checked by test/board-checks.test.ts
from board_checks import *
def show(v):
    print(v.ok, repr(v.__sagebrush_verdict__()))
show(close(3.14159, pi, rel=1e-5)); show(close(3.14, pi, rel=1e-5)); show(close(1, 1.05, abs=0.1))
show(close(float('nan'), 1, abs=1)); show(close(float('inf'), float('inf'), abs=1)); show(close(1+1e-12*I, 1, abs=1e-9))
for bad in [dict(), dict(rel=-1)]:
    try: close(1, 2, **bad)
    except ValueError as e: print("ValueError:", e)
try: close(["x"], 2, abs=1)
except TypeError as e: print("TypeError:", e)
show(same_set({3, 1, 2}, [1, 2, 3, 3])); show(same_set([1, 5], [1, 2])); show(same_set([], [1, 2, 3, 4, 5]))
show(same_multiset([2, 1, 2], [1, 2, 2])); show(same_multiset([1, 2], [1, 2, 2]))
show(same_sequence([1, 1, 2, 3], (1, 1, 2, 3))); show(same_sequence([1, 2, 4], [1, 2, 3])); show(same_sequence([1, 2], [1, 2, 3]))
show(same_sequence([3, 1, 2], [1, 2, 3], ordered=False))
import itertools
try: same_set(itertools.count(), [1])
except ValueError as e: print("ValueError:", e)
show(same_permutation('(1,2,3)', '(1,2,3)')); show(same_permutation('(1,3,2)', '(1,2,3)'))
show(same_group(PermutationGroup(['(1,2)', '(1,2,3)']), SymmetricGroup(3))); show(same_group(['(1,2,3)'], SymmetricGroup(3)))
show(same_group(['(1,2)', '(3,4)'], ['(1,3)(2,4)', '(1,2)']))
show(symbolic_equal((x + 1)^2, x^2 + 2*x + 1)); show(symbolic_equal('x^2 + 2*x', x^2 + 2*x + 1)); show(symbolic_equal(sin(x)^2, 1 - cos(x)^2))
show(symbolic_equal('2*a + b', 'b + a + a')); show(symbolic_equal(sqrt(2), 1.41421356))
v = symbolic_equal(exp(x), 1 + x)
print(v.ok, v.__sagebrush_verdict__() if v.ok is not False else v.reason)
try: bool(Verdict(None, "hard"))
except CannotDecide as e: print("CannotDecide:", e)
# --- astra2's categories: exact rational boundaries
from fractions import Fraction
show(close(Fraction(11, 10), 1, abs=Fraction(1, 10)))
show(close(1.1, 1, abs=0.1))
show(close('3.25', Fraction(13, 4), abs=0)); show(close('13/4', 3.25, rel=0)); show(close(QQ(1)/3, '1/3', abs=0))
show(close(1, 1 + 10^-20, rel=10^-20)); show(close(1, 1 + 2*10^-20, rel=10^-20))
for bad in ['2**10', '1/0', 'pi', '1e99999', '']:
    try: close(bad, 1, abs=1)
    except ValueError as e: print("ValueError:", e)
show(close(float('inf'), float('-inf'), abs=1)); show(close(1, float('nan'), abs=1))
# order versus multiplicity; strings; unhashable items
show(same_set('{1, 2, 2}', [2, 1])); show(same_multiset('[1, 2, 2]', [2, 1])); show(same_sequence('1, 2, 3', [1, 3, 2]))
show(same_sequence('(a, b)', ['a', 'b']))
try: same_set([[1], [2]], [[1], [2]])
except TypeError as e: print("TypeError:", e)
try: parse_list('[[1, 2], 3]')
except ValueError as e: print("ValueError:", e)
# groups: the same group from other generators; isomorphic but not the same
show(same_group(['(1,2,3)', '(1,2)'], ['(1,3)', '(2,3)']))
show(same_group(['(1,2)'], ['(3,4)']))
show(same_permutation([2, 1, 3], '(1,2)')); show(same_permutation('(1,2)(3,4)', '(3,4)(1,2)'))
# symbolic: algebraic equality, undefined points skipped, never right by sampling
show(symbolic_equal(x^2/x, x))
show(symbolic_equal('1/(2x - 1)', 1/(2*x - 1) + 1))
show(symbolic_equal('2x^2 + 3(x - 1)', 2*x^2 + 3*x - 3))
show(symbolic_equal('x*y', 'y*x + 1'))
for bad in ['__import__("os")', 'x.__class__', '2^(10^10)', '(' * 200 + 'x' + ')' * 200, 'lambda: 1', 'x[0]']:
    try: parse_expression(bad); print("not refused", bad[:20])
    except ValueError as e: print("ValueError:", str(e)[:70])
print(parse_expression('x^(10^10)'))
# astra2's CORR-230: exact through complex values; a tiny negative tolerance
# refused; reasons for tiny and huge differences
show(close(9007199254740993, complex(9007199254740992), abs=0))
show(close(Fraction(1, 10**400), 0j, abs=0))
show(close(1 + 2j, Fraction(1) + 2j, abs=0)); show(close(3 + 4j, 0, abs=5)); show(close(3 + 4j, 0, abs=Fraction(49, 10)))
try: close(2, 2, abs=Fraction(-1, 10**400))
except ValueError as e: print("ValueError:", e)
try: close(2, 2, rel=complex(1, 0))
except ValueError as e: print("ValueError:", e)
show(close(Fraction(1, 10**400), 0, abs=0)); show(close(10**400, 0, abs=0)); show(close(10**400, 10**400 + 1, rel=10**-401))
# inexact comparisons that floats can't resolve: undecided, not right
show(close(2^60 + 1, 2^60 + RR(0), abs=0)); show(close(pi, 3.141592653589793, abs=0)); show(close(10^400, pi, abs=1))
# astra's: never right from a lossy difference or from infinity
show(close(pi + QQ(1)/10^20, pi, abs=QQ(1)/10^30)); show(close(RealField(200)(1) + 2^-100, 1, abs=1e-40))
show(close(complex(-1e308, 1e308), complex(1e308, -1e308), rel=1.5))
# scientific literals read alike by both parsers; an ambiguous one refused
print(parse_expression('1e-3'), parse_expression('2e3'), parse_expression('1.2e+3'), parse_expression('2e'), parse_number('1.2e+3'))
for bad in ['2e3x', '1e5000']:
    try: parse_expression(bad); print("not refused", bad)
    except ValueError as e: print("ValueError:", str(e)[:80])
