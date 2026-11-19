import json
cases = [
    ("zero_division", lambda: 1 / 0),
    ("wrong_argument_type", lambda: len(1)),
    ("missing_name", lambda: not_a_defined_name),
    ("bad_integer", lambda: int("not-an-integer")),
]
rows = []
for label, action in cases:
    try:
        action()
        rows.append({"case": label, "type": None})
    except Exception as error:
        rows.append({"case": label, "type": type(error).__name__, "message": str(error)})
print(json.dumps(rows, sort_keys=True))
