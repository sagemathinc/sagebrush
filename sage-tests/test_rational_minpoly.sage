# Rational numbers' minimal and characteristic polynomials (Sage 10.9); one line per statement
def show(n, f):
    try:
        print('S%02d %s' % (n, str(f()).replace('\n', ' ; ')))
    except Exception as e:
        print('S%02d ERR %s: %s' % (n, type(e).__name__, str(e)[:200]))
show(1, lambda: QQ(3/2).minpoly())
show(2, lambda: QQ(3/2).minpoly('t'))
show(3, lambda: QQ(3/2).minpoly().parent())
show(4, lambda: (3/2).minpoly())
show(5, lambda: QQ(-7).minpoly(var='y'))
show(6, lambda: QQ(0).charpoly())
show(7, lambda: (2/3).charpoly('z'))
show(8, lambda: QQ(5).minpoly()(5))
show(9, lambda: QQ(-1/3).minpoly().roots())
