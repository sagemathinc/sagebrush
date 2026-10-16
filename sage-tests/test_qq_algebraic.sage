# QQ[a] for an algebraic number a: the number field it generates, embedded
# at a (the sagebook, p. 211: L.<a> = QQ[sqrt(2-sqrt(3))] was a polynomial
# ring in "sqrt(-sqrt(3) + 2)")
print(QQ[sqrt(2)]); print(QQ[sqrt(2-sqrt(3))]); print(QQ[I]); print(QQ[2^(1/3)]); print(QQ[sqrt(2)+sqrt(3)]); print(QQ[pi]); print(QQ['x'])
try:
    QQ[sqrt(4)]
except ValueError as e:
    print('ValueError', e)
L.<a> = QQ[sqrt(2-sqrt(3))]; print(a^4 - 4*a^2 + 1, a.minpoly())
K.<b> = QQ[sqrt(2)]; print(b^2, b.parent() is K, K.degree())
M.<c> = QQ[2^(1/3)]; print(c^3, M.discriminant())
# an algebraic number from QQbar or AA generates the same field (a
# polynomial ring "in 1.414213562373095?" before)
print(QQ[QQbar(sqrt(2))]); print(QQ[AA(sqrt(2))]); print(QQ[QQbar(2^(1/3))])
