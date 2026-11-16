# Generate tests/an_reference.txt: a_1..a_1000 by Sage's anlist, run (not read) as an oracle.
#
#     sage engine/lfun/gen/an_reference.sage > engine/lfun/tests/an_reference.txt
print("# name a1 a2 a3 a4 a6, then a_1 ... a_1000 (Sage 10.10 anlist)")
for name, a in [("11a1", [0, -1, 1, -10, -20]), ("37a1", [0, 0, 1, -1, 0]), ("27a1", [0, 0, 1, 0, -7]),
                ("N99974", [1, 0, 1, 11, -2])]:
    E = EllipticCurve(a)
    print("curve %s %s" % (name, " ".join(str(x) for x in a)))
    print(" ".join(str(x) for x in E.anlist(1000)[1:]))
