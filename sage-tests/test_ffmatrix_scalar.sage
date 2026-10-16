# A scalar is that multiple of the identity in == + - (any shape for 0), over number fields, QQbar and finite fields
# (A == 1 was False: the scalar fell through to identity comparison; A - 1 was a TypeError)
def T(name, fun):
    try: print(name, '::', fun())
    except Exception as e: print(name, '::', (type(e).__name__ + ' ' + str(e)[:120]).rstrip())
P.<t> = QQ[]
K.<a> = NumberField(t^2 - 2)
for R in (K, QQbar, GF(7), GF(9, 'z')):
    A = matrix(R, 2, 2, [1, 2, 3, 4]); N = matrix(R, 2, 3, [1, 2, 3, 4, 5, 6])
    T(str(R)[:20] + ' eq', lambda: (A == 1, A == A, matrix(R, 2, 2, 1) == 1, matrix(R, 2, 2, 3) == 3, matrix(R, 2, 3, 0) == 0, N == 1, N == 0, A != 1, 1 == matrix(R, 2, 2, 1)))
    T(str(R)[:20] + ' add', lambda: (A + 1, 1 + A, A - 1, 1 - A))
    T(str(R)[:20] + ' nonsq add', lambda: N + 1)
    T(str(R)[:20] + ' nonsq sub', lambda: 1 - N)
