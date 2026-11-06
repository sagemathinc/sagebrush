# padded_list of a Laurent series of positive valuation, as Sage 10.9 (the grader's r757 S11 follow-up):
# the list starts at t^0, so t^2 + O(t^5) padded to 5 has two leading zeros
L.<t> = LaurentSeriesRing(QQ)
for f in [t^2 + O(t^5), t^2 + 3*t^3 + O(t^6), 2*t + O(t^4), t^3, t^2 + O(t^5), 5 + t + O(t^3), t^-1 + 2 + O(t^2)]:
    for n in [0, 1, 3, 5, 7]:
        try:
            print(f, '|', n, '=>', f.padded_list(n))
        except Exception as e:
            print(f, '|', n, '=> ERR', type(e).__name__)
    try:
        print(f, '| none =>', f.padded_list())
    except Exception as e:
        print(f, '| none => ERR', type(e).__name__)
P.<s> = PowerSeriesRing(QQ)
for f in [s^2 + O(s^5), 1 + s + O(s^3)]:
    print(f, '| 5 =>', f.padded_list(5), '| none =>', f.padded_list())
