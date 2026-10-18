#!/usr/bin/env python3
"""Freeze a reproducible corpus: 300 existing fields plus 96 seeded inputs."""
import json
from pathlib import Path
import random

HERE = Path(__file__).resolve().parent
SEED = 20261018


def main():
    fixture = HERE.parent.parent / "engine/classgroup/tests/proof_fixture.txt"
    fields = [(f"fixture-{i:03d}", line.split("|")[0].strip().split(","))
              for i, line in enumerate(fixture.read_text().splitlines(), 1)]
    rng = random.Random(SEED)
    for degree in range(3, 7):
        for i in range(24):
            coefficients = [str(rng.randint(-20, 20)) for _ in range(degree)] + ["1"]
            fields.append((f"seed-{SEED}-degree-{degree}-{i:02d}", coefficients))
    # The original README's 30 random fields were not saved. Include its named
    # cubic and freeze this replacement sample; do not claim to recreate them.
    fields += [("readme-cubic", ["-11", "0", "0", "1"]), ("linear", ["-1", "1"])]
    cases = [{"id": f"{label}-{op}", "request": {"fn": op, "f": coefficients}}
             for label, coefficients in fields for op in ("bnf", "bnf_certify")]
    for label, request in [
        ("proof-norm-limit", {"fn": "bnf_certify", "f": ["23", "0", "1"], "norm_max": 0}),
        ("proof-index-limit", {"fn": "bnf_certify", "f": ["-2", "0", "1"], "index_max": 0}),
        ("nonmonic", {"fn": "bnf", "f": ["-2", "0", "2"]}),
        ("constant", {"fn": "bnf", "f": ["1"]}),
        ("reducible", {"fn": "bnf", "f": ["-1", "0", "1"]}),
    ]:
        cases.append({"id": label, "request": request})
    (HERE / "corpus.json").write_text(json.dumps(cases, indent=2) + "\n")


if __name__ == "__main__":
    main()
