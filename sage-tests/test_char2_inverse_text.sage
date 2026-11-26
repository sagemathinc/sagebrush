# The ZeroDivisionError of a singular matrix's inverse: Sage's own text over
# the fields of characteristic 2 with at most 2^16 elements, its generic text
# over GF(2^17), other fields and Z/n; by inverse(), ~M and negative powers.
def show(f):
    try:
        r = f()
        print(parent(r))
        print(r)
    except ZeroDivisionError as e:
        print("ZeroDivisionError:", e)

for R in [GF(2), Zmod(2), GF(4, 'a'), GF(8, 'a'), GF(2**16, 'a'), GF(2**17, 'a'), GF(3), GF(7), Zmod(4), Zmod(6)]:
    print(R)
    M = matrix(R, [[1, 1], [1, 1]])
    show(lambda: M.inverse())
    show(lambda: ~M)
    show(lambda: M**-1)
    show(lambda: M**-2)
    show(lambda: matrix(R, 1, 1, [0]).inverse())
    show(lambda: matrix(R, 3, 3, [1, 0, 1, 0, 1, 1, 1, 1, 0]).inverse())
    show(lambda: matrix(R, 0, 0).inverse())
