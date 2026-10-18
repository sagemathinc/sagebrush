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

print("test_certify: ok")
