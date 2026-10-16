# Matrix indexing and assignment as in Sage: rows, entries, slices and index
# lists, scalar fill, shape errors (the sagebook, p. 160: A[:,1] = vector(...)
# assigned nothing, and A[::-1] was a list)
A = matrix(QQ, 3, 3, range(9))
try:
    v = A[1]
    print('A[1]', '->', repr(v).replace('\n', ' / '))
except Exception as e:
    print('A[1]', '!!', type(e).__name__, '')

try:
    v = A[-1]
    print('A[-1]', '->', repr(v).replace('\n', ' / '))
except Exception as e:
    print('A[-1]', '!!', type(e).__name__, '')

try:
    v = A[1, 2]
    print('A[1, 2]', '->', repr(v).replace('\n', ' / '))
except Exception as e:
    print('A[1, 2]', '!!', type(e).__name__, '')

try:
    v = A[-1, -1]
    print('A[-1, -1]', '->', repr(v).replace('\n', ' / '))
except Exception as e:
    print('A[-1, -1]', '!!', type(e).__name__, '')

try:
    v = A[1:3]
    print('A[1:3]', '->', repr(v).replace('\n', ' / '))
except Exception as e:
    print('A[1:3]', '!!', type(e).__name__, '')

try:
    v = A[[0, 2]]
    print('A[[0, 2]]', '->', repr(v).replace('\n', ' / '))
except Exception as e:
    print('A[[0, 2]]', '!!', type(e).__name__, '')

try:
    v = A[[2, 0], 1]
    print('A[[2, 0], 1]', '->', repr(v).replace('\n', ' / '))
except Exception as e:
    print('A[[2, 0], 1]', '!!', type(e).__name__, '')

try:
    v = A[1, [0, 2]]
    print('A[1, [0, 2]]', '->', repr(v).replace('\n', ' / '))
except Exception as e:
    print('A[1, [0, 2]]', '!!', type(e).__name__, '')

try:
    v = A[[0,2],[0,2]]
    print('A[[0,2],[0,2]]', '->', repr(v).replace('\n', ' / '))
except Exception as e:
    print('A[[0,2],[0,2]]', '!!', type(e).__name__, '')

try:
    v = A[:, 1]
    print('A[:, 1]', '->', repr(v).replace('\n', ' / '))
except Exception as e:
    print('A[:, 1]', '!!', type(e).__name__, '')

try:
    v = A[1, :]
    print('A[1, :]', '->', repr(v).replace('\n', ' / '))
except Exception as e:
    print('A[1, :]', '!!', type(e).__name__, '')

try:
    v = A[1:2, 1:2]
    print('A[1:2, 1:2]', '->', repr(v).replace('\n', ' / '))
except Exception as e:
    print('A[1:2, 1:2]', '!!', type(e).__name__, '')

try:
    v = A[3]
    print('A[3]', '->', repr(v).replace('\n', ' / '))
except Exception as e:
    print('A[3]', '!!', type(e).__name__, '')

try:
    v = A[0, 3]
    print('A[0, 3]', '->', repr(v).replace('\n', ' / '))
except Exception as e:
    print('A[0, 3]', '!!', type(e).__name__, '')

try:
    v = A[3, 0]
    print('A[3, 0]', '->', repr(v).replace('\n', ' / '))
except Exception as e:
    print('A[3, 0]', '!!', type(e).__name__, '')

try:
    v = A[:, 5]
    print('A[:, 5]', '->', repr(v).replace('\n', ' / '))
except Exception as e:
    print('A[:, 5]', '!!', type(e).__name__, '')

try:
    v = A[(0, 1)]
    print('A[(0, 1)]', '->', repr(v).replace('\n', ' / '))
except Exception as e:
    print('A[(0, 1)]', '!!', type(e).__name__, '')

try:
    v = A['a']
    print("A['a']", '->', repr(v).replace('\n', ' / '))
except Exception as e:
    print("A['a']", '!!', type(e).__name__, '')

try:
    v = A[1.0]
    print('A[1.0]', '->', repr(v).replace('\n', ' / '))
except Exception as e:
    print('A[1.0]', '!!', type(e).__name__, '')

try:
    v = A[0:0]
    print('A[0:0]', '->', repr(v).replace('\n', ' / '))
except Exception as e:
    print('A[0:0]', '!!', type(e).__name__, '')

try:
    v = A[:, 0:0]
    print('A[:, 0:0]', '->', repr(v).replace('\n', ' / '))
except Exception as e:
    print('A[:, 0:0]', '!!', type(e).__name__, '')

try:
    v = A[::-1, ::-1]
    print('A[::-1, ::-1]', '->', repr(v).replace('\n', ' / '))
except Exception as e:
    print('A[::-1, ::-1]', '!!', type(e).__name__, '')

try:
    v = A[-5:2]
    print('A[-5:2]', '->', repr(v).replace('\n', ' / '))
except Exception as e:
    print('A[-5:2]', '!!', type(e).__name__, '')

try:
    v = A[1:3, -1]
    print('A[1:3, -1]', '->', repr(v).replace('\n', ' / '))
except Exception as e:
    print('A[1:3, -1]', '!!', type(e).__name__, '')

try:
    B = matrix(QQ, 3, 3, range(9))
    B[0] = vector([7, 8, 9])
    print('B[0] = vector([7, 8, 9]); B', '->', repr(B).replace('\n', ' / '))
except Exception as e:
    print('B[0] = vector([7, 8, 9]); B', '!!', type(e).__name__, '')

try:
    B = matrix(QQ, 3, 3, range(9))
    B[0] = [1, 2, 3]
    print('B[0] = [1, 2, 3]; B', '->', repr(B).replace('\n', ' / '))
except Exception as e:
    print('B[0] = [1, 2, 3]; B', '!!', type(e).__name__, '')

try:
    B = matrix(QQ, 3, 3, range(9))
    B[0, 0] = 1/2
    print('B[0, 0] = 1/2; B', '->', repr(B).replace('\n', ' / '))
except Exception as e:
    print('B[0, 0] = 1/2; B', '!!', type(e).__name__, '')

try:
    B = matrix(QQ, 3, 3, range(9))
    B[:, 0] = vector([4, 5, 6])
    print('B[:, 0] = vector([4, 5, 6]); B', '->', repr(B).replace('\n', ' / '))
except Exception as e:
    print('B[:, 0] = vector([4, 5, 6]); B', '!!', type(e).__name__, '')

try:
    B = matrix(QQ, 3, 3, range(9))
    B[:, 0] = [4, 5, 6]
    print('B[:, 0] = [4, 5, 6]; B', '->', repr(B).replace('\n', ' / '))
except Exception as e:
    print('B[:, 0] = [4, 5, 6]; B', '!!', type(e).__name__, '')

try:
    B = matrix(QQ, 3, 3, range(9))
    B[0:2, 0:2] = matrix([[9, 9], [9, 9]])
    print('B[0:2, 0:2] = matrix([[9, 9], [9, 9]]); B', '->', repr(B).replace('\n', ' / '))
except Exception as e:
    print('B[0:2, 0:2] = matrix([[9, 9], [9, 9]]); B', '!!', type(e).__name__, '')

try:
    B = matrix(QQ, 3, 3, range(9))
    B[0:2, 0:2] = 0
    print('B[0:2, 0:2] = 0; B', '->', repr(B).replace('\n', ' / '))
except Exception as e:
    print('B[0:2, 0:2] = 0; B', '!!', type(e).__name__, '')

try:
    B = matrix(QQ, 3, 3, range(9))
    B[0:2, 0:2] = 5
    print('B[0:2, 0:2] = 5; B', '->', repr(B).replace('\n', ' / '))
except Exception as e:
    print('B[0:2, 0:2] = 5; B', '!!', type(e).__name__, '')

try:
    B = matrix(QQ, 3, 3, range(9))
    B[0, :] = vector([1, 1, 1])
    print('B[0, :] = vector([1, 1, 1]); B', '->', repr(B).replace('\n', ' / '))
except Exception as e:
    print('B[0, :] = vector([1, 1, 1]); B', '!!', type(e).__name__, '')

try:
    B = matrix(QQ, 3, 3, range(9))
    B[0, :] = matrix([[2, 2, 2]])
    print('B[0, :] = matrix([[2, 2, 2]]); B', '->', repr(B).replace('\n', ' / '))
except Exception as e:
    print('B[0, :] = matrix([[2, 2, 2]]); B', '!!', type(e).__name__, '')

try:
    B = matrix(QQ, 3, 3, range(9))
    B[0] = vector([1, 2])
    print('B[0] = vector([1, 2]); B', '->', repr(B).replace('\n', ' / '))
except Exception as e:
    print('B[0] = vector([1, 2]); B', '!!', type(e).__name__, '')

try:
    B = matrix(QQ, 3, 3, range(9))
    B[:, 0] = vector([1, 2])
    print('B[:, 0] = vector([1, 2]); B', '->', repr(B).replace('\n', ' / '))
except Exception as e:
    print('B[:, 0] = vector([1, 2]); B', '!!', type(e).__name__, '')

try:
    B = matrix(QQ, 3, 3, range(9))
    B[0:2, 0:2] = matrix([[1, 2, 3]])
    print('B[0:2, 0:2] = matrix([[1, 2, 3]]); B', '->', repr(B).replace('\n', ' / '))
except Exception as e:
    print('B[0:2, 0:2] = matrix([[1, 2, 3]]); B', '!!', type(e).__name__, '')

try:
    B = matrix(QQ, 3, 3, range(9))
    B[[0, 2], 1] = vector([5, 5])
    print('B[[0, 2], 1] = vector([5, 5]); B', '->', repr(B).replace('\n', ' / '))
except Exception as e:
    print('B[[0, 2], 1] = vector([5, 5]); B', '!!', type(e).__name__, '')

try:
    B = matrix(QQ, 3, 3, range(9))
    B[5] = vector([1, 2, 3])
    print('B[5] = vector([1, 2, 3]); B', '->', repr(B).replace('\n', ' / '))
except Exception as e:
    print('B[5] = vector([1, 2, 3]); B', '!!', type(e).__name__, '')

try:
    B = matrix(QQ, 3, 3, range(9))
    B[0, 0] = 'a'
    print("B[0, 0] = 'a'; B", '->', repr(B).replace('\n', ' / '))
except Exception as e:
    print("B[0, 0] = 'a'; B", '!!', type(e).__name__, '')

try:
    B = matrix(QQ, 3, 3, range(9))
    B[0] = 3
    print('B[0] = 3; B', '->', repr(B).replace('\n', ' / '))
except Exception as e:
    print('B[0] = 3; B', '!!', type(e).__name__, '')

try:
    B = matrix(QQ, 3, 3, range(9))
    B[::-1] = matrix(3, 3, range(9))
    print('B[::-1] = matrix(3, 3, range(9)); B', '->', repr(B).replace('\n', ' / '))
except Exception as e:
    print('B[::-1] = matrix(3, 3, range(9)); B', '!!', type(e).__name__, '')

try:
    B = matrix(QQ, 3, 3, range(9))
    B[0, 0] = x
    print('B[0, 0] = x; B', '->', repr(B).replace('\n', ' / '))
except Exception as e:
    print('B[0, 0] = x; B', '!!', type(e).__name__, '')

try:
    B = matrix(QQ, 3, 3, range(9))
    B[0, 0] = 1.5
    print('B[0, 0] = 1.5; B', '->', repr(B).replace('\n', ' / '))
except Exception as e:
    print('B[0, 0] = 1.5; B', '!!', type(e).__name__, '')

# entries are converted, not truncated: a non-integral real is refused by
# ZZ, an integral one or an integer mod n is its integer (astra's CORR-552-1)
def entries(A): return [str(x) for row in A.rows() for x in row]
values = [('float-half', lambda: float(1.5)), ('float-negative', lambda: float(-1.5)), ('RR-half', lambda: RR(1.5)), ('RDF-half', lambda: RDF(1.5)), ('RF-half', lambda: RealField(100)(1.5)), ('QQ-half', lambda: QQ(3)/2), ('float-integral', lambda: float(2)), ('RR-integral', lambda: RR(2)), ('GF-two', lambda: GF(5)(2)), ('mod-two', lambda: Mod(2, 5))]
for R in [ZZ, QQ]:
    for name, mk in values:
        for kind in ['entry', 'row', 'col', 'vector']:
            A = matrix(R, 2, 2, [11, 12, 13, 14])
            try:
                v = mk()
                if kind == 'entry': A[0, 0] = v
                elif kind == 'row': A[0, :] = v
                elif kind == 'col': A[:, 0] = v
                else: A[0] = [v, 15]
                print(str(R), name, kind, 'OK', entries(A))
            except Exception as e:
                print(str(R), name, kind, type(e).__name__, entries(A))
# a bool index is 0 or 1 (CORR-552-2); an empty block takes any value
A = matrix(QQ, 2, 2, [1, 2, 3, 4])
print(A[True, False], A[False, True], A[True])
A[True, False] = 7; print(entries(A))
A[[], :] = float(1.5); A[:, []] = 'a'; print(entries(A))
