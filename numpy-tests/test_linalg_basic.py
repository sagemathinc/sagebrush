import numpy as np
A = np.array([[2.0, 1], [1, 3]])
B = np.arange(6).reshape(2, 3)
print(repr(A @ B), repr(np.dot(A, A)), repr(A.dot(np.array([1, 1]))), repr(np.matmul(np.ones((2, 2, 3)), np.ones((3, 2))).shape))
print(repr(np.array([1, 2, 3]) @ np.array([4, 5, 6])), repr(np.inner([1, 2], [3, 4])), repr(np.outer(np.arange(3), np.arange(2))))
print(repr(np.cross([1, 0, 0], [0, 1, 0])), repr(np.trace(A)), repr(np.kron(np.eye(2), np.ones((2, 2)))), repr(np.tensordot(np.ones((2, 3)), np.ones((3, 4)), axes=1).shape))
print(repr(np.einsum("ij,jk->ik", A, B)), repr(np.einsum("i,i", np.arange(3), np.arange(3))), repr(np.einsum("ij->j", B)), repr(np.vdot([1, 2], [3, 4])))
