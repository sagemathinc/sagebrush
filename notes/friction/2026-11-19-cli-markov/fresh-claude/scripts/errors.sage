import json
cases = [
    ("singular_inverse", lambda: matrix(QQ, [[1, 1], [1, 1]]).inverse()),
    ("singular_I_minus_Q", lambda: (identity_matrix(QQ, 2) - matrix(QQ, [[1, 0], [0, 1]])).inverse()),
    ("nonsquare_inverse", lambda: matrix(QQ, [[1, 2, 3], [4, 5, 6]]).inverse()),
    ("dim_mismatch_mul", lambda: matrix(QQ, 2, 3, range(6)) * matrix(QQ, 2, 3, range(6))),
    ("ragged_rows", lambda: matrix(QQ, [[1, 2], [3]])),
    ("non_numeric_entry", lambda: matrix(QQ, [['a', 1], [0, 1]])),
    ("rational_div_zero", lambda: QQ(1) / 0),
    ("QQ_parse_1_over_0", lambda: QQ('1/0')),
    ("negative_power_singular", lambda: matrix(QQ, [[1, 1], [1, 1]])^-1),
    ("fractional_power", lambda: matrix(QQ, [[1, 0], [0, 1]])^(1/2)),
    ("nonsquare_power", lambda: matrix(QQ, 2, 3, range(6))^2),
    ("index_out_of_range", lambda: matrix(QQ, [[1, 2], [3, 4]])[5, 0]),
    ("add_mismatch", lambda: matrix(QQ, 2, 2, range(4)) + matrix(QQ, 3, 3, range(9))),
]
for name, expr in cases:
    try:
        r = expr()  # WORKAROUND: Sagebrush has no global preparse()
        out = {"case": name, "ok": True, "value": str(r)}
    except Exception as e:
        out = {"case": name, "ok": False, "type": type(e).__name__, "msg": str(e)[:120]}
    print(json.dumps(out))
