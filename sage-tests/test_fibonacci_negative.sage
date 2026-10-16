for n in [-1, -2, -3, -4, -10, -11, -79, -80, -200, -201]:
    f = fibonacci(n)
    print(n, f, parent(f), f == (-1)^(n + 1) * fibonacci(-n))
print(fibonacci(-79) == 14472334024676221, type(fibonacci(-79)) == type(fibonacci(79)))
