# Dividing by a nonzero algebraic number whose interval from arithmetic contains 0 refines it instead of failing
# (the right kernel of this 24 x 24 matrix of rank 5 over AA raised ZeroDivisionError "interval contains 0")
s2 = AA(2).sqrt()
n = 24
A = matrix(AA, n, n, [s2*(i % 3) + j*j + (i*j) % 5 for i in range(n) for j in range(n)])
K = A.right_kernel_matrix()
print(K.dimensions(), A.rank(), (A * K.transpose()).is_zero())
print(K[0])
print(K[K.nrows() - 1])
m = 12
B = matrix(QQbar, m, m, [QQbar(I)*(i % 3) + s2*(j % 2) + j*j + (i*j) % 5 for i in range(m) for j in range(m)])
L = B.right_kernel_matrix()
print(L.dimensions(), B.rank(), (B * L.transpose()).is_zero())
print(L[0][:6])
x = s2
for k in range(12):
    x = (x * x - 2) / (x + 1) + s2
print(x == x, 1 / (x - x + s2) == s2 / 2)
y = QQbar(2).sqrt() + QQbar(I)
for k in range(8):
    y = (y * y - 1) / (y + 1) + QQbar(I)
print(y.minpoly().degree())
