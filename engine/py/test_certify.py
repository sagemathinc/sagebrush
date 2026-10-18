"""quadratic_class_group_data's certify option (python engine/py/test_certify.py):
the analytic certificate is skipped only when asked, the result then says it
is conditional, and Sage mode keeps the certified default."""

from sagebrush import nf
from sagebrush.sage import QuadraticField

CERTIFIED = "certified (assuming GRH)"
CONDITIONAL = "conditional on GRH and the stopping rule's estimate, not certified"

for d in [-67128026883063, -718243867543907291096, 1000000009, 54475728456]:
    c = nf.quadratic_class_group_data(d)
    assert c["certified"] is True and c["status"] == CERTIFIED and c["assumes"] == ["GRH"], c
    assert nf.quadratic_class_group_data(d, certify=True) == c
    u = nf.quadratic_class_group_data(d, certify=False)
    assert u["certified"] is False and u["status"] == CONDITIONAL, u
    assert "GRH" in u["assumes"] and any("estimate" in a for a in u["assumes"]), u
    assert (u["h"], u["cyc"]) == (c["h"], c["cyc"]), (u, c)
    if d > 0:
        assert abs(float(u["regulator"]) / float(c["regulator"]) - 1) < 1e-14, (u, c)
    # the tuple form is the certified default
    assert nf.quadratic_class_group(d) == (c["h"], c["cyc"], c["regulator"])

# below the exhaustive bound h is proven either way
assert nf.quadratic_class_group_data(-8888, certify=False)["status"] == CERTIFIED

for bad in ["false", 0, 1, None]:
    try:
        nf.quadratic_class_group_data(-23, certify=bad)
    except TypeError as e:
        assert "certify must be True or False" in str(e)
    else:
        raise AssertionError("certify=%r accepted" % (bad,))

# Sage mode uses the certified default: proof=None accepts it (an
# uncertified estimate would be refused) and it is certified
K = QuadraticField(-67128026883063)
assert K.class_group().invariants() == (327924, 2, 2, 2, 2)
assert K._bnfdata()["certified"] is True

# Sage mode's proof=False: the quadratic algorithms without the certificate,
# cached apart from the default data (sage-proof-false-quadratic). Fields
# are unique (QuadraticField(D) is the same object each time, as in Sage),
# so each order uses a discriminant not used above.
K = QuadraticField(-718243867543907291096)
assert K._bnf is None and K._bnf_uncertified is None
assert K.class_group(proof=False).invariants() == (2378498846, 2, 2, 2)
u = K._bnf_uncertified
assert K._bnf is None and u["certified"] is False and any("estimate" in a for a in u["assumes"]), u
# a default call after it still certifies; proof=False then reuses that
assert K.class_group().invariants() == (2378498846, 2, 2, 2) and K._bnf["certified"] is True
assert K._bnf_checked(False) is K._bnf
# the other order: certified first, proof=False reuses it, nothing uncertified computed
K = QuadraticField(-1016021983508)
assert K._bnf is None and K._bnf_uncertified is None
assert K.class_number() == 48592 * 8 and K._bnf["certified"] is True
assert K.class_number(proof=False) == 48592 * 8 and K._bnf_checked(False) is K._bnf and K._bnf_uncertified is None
# a real field's regulator, both ways
K = QuadraticField(1000000009)
r0 = K.regulator(proof=False)
assert K._bnf is None and K._bnf_uncertified["certified"] is False
r1 = K.regulator()
assert K._bnf["certified"] is True and abs(r0 / r1 - 1) < 1e-14, (r0, r1)
# below the quadratic shortcut (|d| < 1000) proof=False is the default path
K = QuadraticField(-23)
assert K.class_number(proof=False) == 3 and K._bnf_uncertified is None and K._bnf is not None

print("test_certify: ok")
