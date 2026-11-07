# x in ZZ / QQ / RR / RDF / CC / CDF as Sage decides it: a string converts but is never an element ('7' in ZZ is
# False), and an element of another ring is one when it converts and compares equal (GF(5)(2) in ZZ) (friction W26)
def show(label, f):
    try:
        print(label, '|', f())
    except Exception as e:
        print(label, '| ERR', type(e).__name__, repr(str(e)[:120]))
R.<m> = QQ[]
for n, F in [("'7' in ZZ", lambda: '7' in ZZ), ("'7' in QQ", lambda: '7' in QQ), ("'1/2' in QQ", lambda: '1/2' in QQ), ("b'7' in ZZ", lambda: b'7' in ZZ), ("'x' in ZZ", lambda: 'x' in ZZ),
             ("'7' in RR", lambda: '7' in RR), ("'7' in RDF", lambda: '7' in RDF), ("'7' in RealField(100)", lambda: '7' in RealField(100)), ("'7' in CC", lambda: '7' in CC), ("'7' in CDF", lambda: '7' in CDF),
             ("7.0 in ZZ", lambda: 7.0 in ZZ), ("7.5 in ZZ", lambda: 7.5 in ZZ), ("7.5 in QQ", lambda: 7.5 in QQ), ("RDF(2.5) in QQ", lambda: RDF(2.5) in QQ), ("QQ(7) in ZZ", lambda: QQ(7) in ZZ), ("1/2 in ZZ", lambda: 1/2 in ZZ),
             ("1/2 in QQ", lambda: 1/2 in QQ), ("sqrt(4) in ZZ", lambda: sqrt(4) in ZZ), ("sqrt(2) in QQ", lambda: sqrt(2) in QQ), ("pi in QQ", lambda: pi in QQ), ("int(3) in ZZ", lambda: int(3) in ZZ), ("True in ZZ", lambda: True in ZZ),
             ("GF(5)(2) in ZZ", lambda: GF(5)(2) in ZZ), ("GF(5)(2) in QQ", lambda: GF(5)(2) in QQ), ("Zmod(6)(5) in ZZ", lambda: Zmod(6)(5) in ZZ), ("QQbar(2) in ZZ", lambda: QQbar(2) in ZZ), ("QQbar(sqrt(2)) in QQ", lambda: QQbar(sqrt(2)) in QQ),
             ("CDF(2) in ZZ", lambda: CDF(2) in ZZ), ("CC(2) in ZZ", lambda: CC(2) in ZZ), ("RR(2) in ZZ", lambda: RR(2) in ZZ), ("RR(2.5) in QQ", lambda: RR(2.5) in QQ), ("R(2) in ZZ", lambda: R(2) in ZZ), ("m in ZZ", lambda: m in ZZ),
             ("I in QQ", lambda: I in QQ), ("None in ZZ", lambda: None in ZZ), ("[1] in ZZ", lambda: [1] in ZZ), ("float('inf') in ZZ", lambda: float('inf') in ZZ), ("2^100 in ZZ", lambda: 2^100 in ZZ), ("complex(2) in ZZ", lambda: complex(2) in ZZ),
             ("Infinity in ZZ", lambda: Infinity in ZZ), ("Integer(QQ(15)/2)", lambda: Integer(QQ(15)/2)), ("ZZ('7')", lambda: ZZ('7')), ("RR(7) in ZZ", lambda: RR(7) in ZZ),
             ("CC(1,2) in CC", lambda: CC(1, 2) in CC), ("2 in CC", lambda: 2 in CC), ("I in CC", lambda: I in CC), ("CDF(1,2) in CC", lambda: CDF(1, 2) in CC), ("pi in CC", lambda: pi in CC), ("'x' in CC", lambda: 'x' in CC),
             ("1/2 in CC", lambda: 1/2 in CC), ("CDF(1,2) in CDF", lambda: CDF(1, 2) in CDF), ("2 in CDF", lambda: 2 in CDF), ("I in CDF", lambda: I in CDF), ("pi in CDF", lambda: pi in CDF),
             ("1/2 in CDF", lambda: 1/2 in CDF), ("2.5 in RDF", lambda: 2.5 in RDF), ("pi in RR", lambda: pi in RR)]:
    show(n, F)
