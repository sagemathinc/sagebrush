for a in [QQ(1)/2, QQ(1)/3, QQ(2)/3, QQ(-3)/2]:
    for b in [QQ(1), QQ(2), QQ(-2), QQ(3)/4]:
        g, s, t = xgcd(a, b)
        print((g, s, t), s*a + t*b == g)
print(xgcd(2, QQ(1)/3), xgcd(QQ(1)/3, 2), xgcd(QQ(2), QQ(4)))
print(xgcd(240, 46), xgcd(-12, 18), xgcd(0, 5))
print(gcd(QQ(2)/3, QQ(4)/9), gcd([QQ(1)/2, QQ(3)/4, 5]), gcd(2, QQ(1)/3))
print(lcm(QQ(2)/3, QQ(4)/9), lcm([QQ(1)/2, QQ(3)/4, 5]), lcm(2, QQ(1)/3), lcm(QQ(0), QQ(1)/2))
print(lcm(4, 6), lcm([2, 3, 4, 5]), gcd(12, 18))
print([xgcd(a, b) for a, b in [(1, -2), (0, -5), (-5, 0), (0, 0), (-6, 4), (4, -6), (7, 7), (-7, 7), (10^20 + 1, 3*10^19)]])
