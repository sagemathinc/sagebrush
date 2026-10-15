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

