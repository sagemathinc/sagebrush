# random_matrix(ZZ, n, x=a, y=b) has entries a <= e < b, b excluded as in ZZ.random_element(a, b); x alone is
# 0 <= e < x (friction W35).  The entries' set over a large matrix, not the seeded values (the generators differ)
for args in [dict(x=1, y=2), dict(x=0, y=5), dict(x=-3, y=3), dict(x=5), dict(x=-1, y=0), dict(x=10, y=12)]:
    set_random_seed(239)
    A = random_matrix(ZZ, 30, **args)
    print(args, sorted(set(A.list())), A.parent())
