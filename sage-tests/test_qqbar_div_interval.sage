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
# (a complex number whose real part excludes 0 but whose imaginary part's interval spans it: the norm's interval
# contained 0 by the generic product im*im, astra's CORR-F30-1)
a = QQbar(2).sqrt() * QQbar(I); b = QQbar(3).sqrt() * QQbar(I)
for w in (1 + (a - a)*10^20, a/1000 + (b - b)*10^20, QQbar(I) + (a - a)*10^20, AA(2).sqrt() + (b - b)*10^20):
    print(1/w == 1/(w + 0), (1/w)*w == 1)
