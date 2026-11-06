from sage_all import *
def tr(l, f):
    try: print(l, "=>", f())
    except Exception as e: print(l, "!!", type(e).__name__, str(e)[:100])
tr("eigvec ints", lambda: matrix(SR, [[2, 1], [1, 2]]).eigenvectors_right())
tr("eigvec SR(n)", lambda: matrix(SR, [[SR(2), SR(1)], [SR(1), SR(2)]]).eigenvectors_right())
tr("solve QQ/SR(n)", lambda: matrix(QQ, [[1, 1], [1, -1]]).solve_right(vector(SR, [SR(3), SR(1)])))
tr("solve QQ/ints", lambda: matrix(QQ, [[1, 1], [1, -1]]).solve_right(vector(SR, [3, 1])))
