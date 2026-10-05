# Sage's language: the preparser (src/sagepre.ts) and its runtime (lib/_sage_lang.py)
try:
    print(repr(([1..10])))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr(([1,3..11])))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr(([10,8..0])))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr((list((1..5)))))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr((sum([1..100]))))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr(([x^2 for x in [1..5]])))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr(([2..2])))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr(([5..1])))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr((100r + 1)))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr((1.5)))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr((1.5r)))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr((0.1 + 0.2)))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr((2.0^10)))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr((1e20)))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr((1e-5)))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr((1e-10)))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr((-3.25)))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr((12.factor())))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr(((12).factor())))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr((12.is_prime(), 13.is_prime())))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr(((2^64-1).factor())))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr(((100).digits())))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr(((100).divisors())))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr(((17).next_prime())))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr(((10).binomial(3))))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr(((5).factorial())))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr(((255).binary())))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr(((255).nbits())))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr(((-7).abs())))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr(((36).is_square(), (36).sqrt())))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr(((7).inverse_mod(11))))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr(((10).gcd(4))))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr((2/3 + (1/3))))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr(((2/3).numerator(), (2/3).denominator())))
except Exception as e:
    print('ERR', type(e).__name__)
x = 5
try:
    print(repr((x.is_prime())))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr((0x1F, 0b101, 0o17)))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr((3^^5)))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr((srange(5))))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr((srange(0, 1, 1/4))))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr((range(5))))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr((len([1..1000]))))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr(("a..b", 'x = 1.5', "[1..3]")))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr((f"{2^3} {1.5}")))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr(([1..4])))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr((r"\d..\d")))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr(([i for i in (1..4)])))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr((sum(1/n for n in [1..10]))))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr(([2*i for i in [0,2..8]])))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr((1.5 + 1)))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr((2 * 0.5)))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr((1/3.0)))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr((sqrt(2.0))))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr((n(pi))))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr((N(1/3))))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr((RR(2/3))))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr((pi.n())))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr((float(1.5))))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr((int(2.7))))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr((round(2.5))))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr((abs(-1.5))))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr((max(1.5, 2))))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr(([0.1*i for i in range(3)])))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr((RealNumber('1.5'))))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr((1.5.floor(), 2.5.ceil())))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr((.5 + 5.)))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr((1e3)))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr((2*.5)))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr((1.e5)))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr(((2/3).numerator(), (2/3).denominator(), (5).numerator())))
except Exception as e:
    print('ERR', type(e).__name__)
x2 = 3
try:
    print(repr((x2.is_prime())))
except Exception as e:
    print('ERR', type(e).__name__)
a = [10..20]
try:
    print(repr((a[2:5])))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr((list(range(3))[1:])))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr(({i: i^2 for i in [1..3]})))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr((tuple((1..3)))))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr((len(list((1,3..99))))))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr(([1..3, step=0.5])))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr(([1,1.5..3])))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr((1.5r * 2)))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr(((2^100).nbits())))
except Exception as e:
    print('ERR', type(e).__name__)
try:
    print(repr(((1000).ndigits())))
except Exception as e:
    print('ERR', type(e).__name__)
print([1..3]) # comment 1..2 and 2.5 'quote
s = """multi
1..2 line [1..3]
"""; print(s)
f(x) = x^2 + 1
print(f, f(3), f(1/2), f(0.5))
g(x, y) = x*y - 1
print(g, g(2, 3))
h(t) = sin(t)/t
print(h, h(1.0))
for i in [1..3]: print(i, end=' ')
print()
it = (1,3..); print([next(it) for _ in range(4)])
it = (1,2..5,10..); print([next(it) for _ in range(10)])
# ellipsis_range's doctests
X = Ellipsis
for args, kw in [((1,X,11,100),{}), ((0,2,X,10,X,20),{}), ((0,2,X,11,X,20),{}), ((0,2,X,11,X,20),{'step':3}), ((10,X,0),{}),
                 ((0,X,10,X,20),{'step':2}), ((100,X,10,X,20),{'step':2}), ((0,X,10,X,-20),{'step':2}), ((100,X,10,X,-20),{'step':2}),
                 ((0,X,10,X,20),{'step':3}), ((100,X,10,X,20),{'step':3}), ((0,X,10,X,-20),{'step':3}), ((100,X,10,X,-20),{'step':3}),
                 ((0,1,X,-10),{}), ((0,1,X,-10),{'step':1}), ((100,0,1,X,-10),{}), ((0,X,5,5,X,10),{}), ((1,3,X,10,10,X,20),{}),
                 ((0,2,X,10,10,X,20,20,X,25),{}), ((10,9,X,1),{}), ((10,11,X,1),{}), ((100,102,X,10,X,20),{})]:
    print(ellipsis_range(*args, **kw))
print([1..5, step=1/2], [5,4..1], [1/2..3], [0,1/3..1])
print(f"{1.5} {2^10} {[1..3]} {0.5:.3f}")
