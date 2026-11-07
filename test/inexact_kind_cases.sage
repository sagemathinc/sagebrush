# The inexact meet knows a field by identity and class, never by its name (lib/_sage_ffmat.py _inexact_kind;
# test/inexact-kind.test.ts; daybreak3's #767 FIELD-REPR-DISPATCH-1): the six fields' kinds, and three parents whose
# names look like a real field's (a parent named "Real Field with 53 bits of precision", QQ, RealIntervalField(53)) are
# not classified.
import _sage_ffmat
print([_sage_ffmat._inexact_kind(F) for F in (RDF, CDF, RR, CC, RealField(20), ComplexField(100))])
class Named:
    def __repr__(self):
        return "Real Field with 53 bits of precision"
    def prec(self):
        return 53
print(_sage_ffmat._inexact_kind(Named()), _sage_ffmat._inexact_kind(QQ), _sage_ffmat._inexact_kind(RealIntervalField(53)))
