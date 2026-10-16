# Kronecker, Legendre and Jacobi symbols (Integer.kronecker returned None)
print(ZZ(2).kronecker(7), ZZ(-1).kronecker(-1), ZZ(3).kronecker(-8), ZZ(6).kronecker(4))
print([kronecker_symbol(a, 0) for a in (-1, 0, 1, 5)], [kronecker(a, 2) for a in range(-4, 5)])
print([kronecker_symbol(a, -12) for a in range(-6, 7)])
print(kronecker_symbol(2, 3^100 + 2), kronecker(10^30 + 7, -(3^41)), kronecker(3/1, 5))
print(type(kronecker(2, 7)) == type(ZZ(1)))
vals = list(range(-25, 26)) + [2^64 + 1, -(3^41)]
print(sum(kronecker_symbol(a, n) * (i + 1) for i, (a, n) in enumerate((a, n) for a in vals for n in vals)))
print([legendre_symbol(a, 11) for a in range(11)], legendre_symbol(14, 7), legendre_symbol(-1, 10^9 + 7))
print([jacobi_symbol(a, 15) for a in range(15)], jacobi_symbol(5, -21), jacobi_symbol(0, 1))
for f, args in [(legendre_symbol, (2, 9)), (legendre_symbol, (3, 2)), (legendre_symbol, (-1, -7)), (jacobi_symbol, (5, 20))]:
    try:
        f(*args)
    except ValueError as e:
        print("ValueError:", e)
