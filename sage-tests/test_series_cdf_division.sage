# A series divided by an inexact number, and CDF's own division, as Sage 10.9 (the grader's r766): a series
# divides by multiplying with the inverse, and CDF divides as GSL does (1/CDF(49) is 0.020408163265306117, so
# (49 + 49*x)/CDF(49) is 0.9999999999999998 + ...); RDF and RR at full precision; CC divided by a series.
# Not here: CDF's integer powers (CDF(49)^-1, CDF(49)^2), whose rule is separate.
R.<x> = PowerSeriesRing(QQ)
L.<t> = LaurentSeriesRing(QQ)
for c in [CDF(49), RDF(49), RR(49), CDF(10), RDF(10), CDF(3), CDF(1,2), CDF(3,4), CDF(0.1,0.3)]:
    print(c, '|', (49 + 49*x + O(x^3))/c, '|', (3 + 7*x + O(x^3))/c, '|', (49*t^-1 + 2 + O(t^2))/c)
for t2 in [CC(1,2)/(1 + x + O(x^3)), CC(1,2)/(t^-1 + 2 + O(t^2)), CDF(1,2)/(1 + x + O(x^3)), RDF(3)/(1 + x + O(x^3))]:
    print(t2, '|', t2.parent())
for z in [CDF(49), CDF(3), CDF(10), CDF(1,2), CDF(3,4), CDF(0,7), CDF(-2,5), CDF(1e-300, 1), CDF(1e300, 1e300), CDF(0.1, 0.3)]:
    print(z, '|', CDF(1)/z, '|', ~z, '|', CDF(7, 1)/z, '|', 49/z, '|', z*(1/z), '|', z/2, '|', 2/z)
