import json
cases = [
    ("singular_inverse", lambda: matrix(QQ, [[1,2],[2,4]]).inverse()),
    ("ragged_matrix", lambda: matrix(QQ, [[1,2],[3]])),
    ("dimension_mismatch", lambda: matrix(QQ, [[1,2]]) * vector(QQ,[1,2,3])),
]
rows = []
for label, action in cases:
    try:
        action()
        rows.append({"case": label, "type": None})
    except Exception as error:
        rows.append({"case": label, "type": type(error).__name__, "message": str(error)})
print(json.dumps(rows, sort_keys=True))
