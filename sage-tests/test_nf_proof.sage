# Class groups, class numbers, regulators and unit groups proven without
# GRH (proof=True): Sagebrush's certificate against Sage's (PARI's
# bnfcertify), on fields of degree 2 to 6 from
# engine/classgroup/tests/proof_fixture.txt.
x = polygen(QQ, 'x')
for f in [x^2 - 7316798,
          x^2 - x - 599640,
          x^2 - 42,
          x^2 - x - 942,
          x^2 - 3492343,
          x^2 - 238,
          x^2 + 1677678,
          x^2 - x - 424,
          x^3 - 123*x - 303,
          x^3 - 2*x - 16,
          x^3 - x^2 - 242*x + 1434,
          x^3 - x^2 + 60*x + 148,
          x^3 - 99*x - 367,
          x^3 - x^2 - 83*x + 309,
          x^3 - x^2 - 214*x - 1098,
          x^4 - x^3 - 14*x^2 + 48*x - 50,
          x^4 - 2*x^2 - 2*x - 5,
          x^4 - 2*x^3 - 36*x^2 - 92*x - 67,
          x^4 - x^3 + 9*x^2 - 24*x + 9,
          x^4 - 8*x^2 - 13*x - 12,
          x^4 - x^3 + 8*x^2 - 22*x + 16,
          x^4 - x^3 - x^2 - 16*x - 8,
          x^4 - 2*x^3 + 5*x^2 + 2*x + 3,
          x^5 - x^4 - 11*x^3 + 33*x^2 - 35*x + 16,
          x^5 - x^4 - 8*x^3 - 14*x^2 - 9*x - 7,
          x^5 - 2*x^4 - 3*x^3 - 6*x^2 + x - 3,
          x^5 - x^4 - 6*x^3 + 18*x^2 - 14*x - 3,
          x^5 - x^4 - 2*x^3 + 2*x^2 - x + 5,
          x^5 - 3*x^3 - 2*x^2 - 5*x + 5,
          x^5 - 2*x^4 + 5*x^3 + 2*x^2 - 8*x + 16,
          x^6 - 4*x^4 - 4*x^3 + 3*x^2 + 1,
          x^6 - 2*x^4 - 3*x^3 - 3*x^2 - 3*x + 3,
          x^6 - x^5 - x^4 - 3*x^3 + x^2 + 4*x + 4,
          x^6 - 3*x^5 + 2*x^4 - 2*x^3 - x^2 + x + 4,
          x^6 - x^5 - 2*x^4 - 3*x^3 + 4*x^2 - 4*x + 1,
          x^6 - x^5 - 3*x^4 + x^3 + 4*x^2 - 4*x + 4,
          x^6 + 4*x^4 - x^3 + x^2 - x + 4,
          x^6 - 2*x^5 + 2*x^4 - 3*x^3 - 4*x^2 + 4*x - 3]:
    K = NumberField(f, 'a')
    print(f, K.discriminant())
    print("  ", K.class_group(proof=True).invariants(), K.class_number(proof=True))
    print("  ", K.regulator(proof=True))
    print("  ", K.unit_group(proof=True))
print(NumberField(x^2 + 2184, 'a').class_group(proof=True))
print(NumberField(x^5 - 11, 'a').class_group(proof=True))
