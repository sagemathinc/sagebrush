"""The Smith form work estimate's report as a Markdown summary (for CI's job
summary): per corpus and seed, its rows and the p90 over them of
max(actual / E, E / actual) for each estimate.  The formula is the test's
(engine/arith/tests/smith_estimate.rs), but pooled over every row with an
estimate: the test's ceilings apply it to per-route subsets, so these
figures are a view, not the gate.  Report-only; malformed lines are skipped.

Usage: python3 scripts/smith-estimate-summary.py <report>"""

import sys


def p90(v):
    v = sorted(v)
    # (9 n).div_ceil(10).max(1) - 1, as the test
    return v[max(-(-9 * len(v) // 10), 1) - 1]


def sym(actual, e):
    a, e = float(actual), float(max(e, 1))
    return max(a / e, e / a) if a > 0 else float("inf")


def value(s):
    # "Some(123)" or "None"
    if s.startswith("Some(") and s.endswith(")"):
        return int(s[5:-1])
    if s == "None":
        return None
    raise ValueError(s)


def parse(line):
    parts = line.split()
    if len(parts) < 4 or not parts[2].isdigit():
        return None
    kv = dict(p.split("=", 1) for p in parts[3:] if "=" in p)
    try:
        row = {"actual": int(kv["actual"])}
        for key in ("stage1", "stage2", "beside"):
            row[key] = value(kv.get(key, "None"))
    except (KeyError, ValueError):
        return None
    return parts[0], (parts[1], parts[2]), row


def main(path):
    groups = {}
    heads = set()
    skipped = 0
    with open(path) as f:
        for line in f:
            p = parse(line)
            if p is None:
                skipped += line.strip() != ""
                continue
            heads.add(p[0][:12])
            groups.setdefault(p[1], []).append(p[2])
    if not groups:
        print("The report has no rows.")
        return
    print(f"Tested head {', '.join(sorted(heads))}. Per corpus and seed, the p90 over rows of max(actual / E, E / actual) for each estimate, pooled over the rows that have one (their count in parentheses). The test's ceilings apply the same measure to per-route subsets, so these figures are a view, not the gate.")
    print()
    print("| corpus | seed | rows | stage 1 | stage 2 | beside |")
    print("|---|---|---|---|---|---|")
    for (corpus, seed), rows in groups.items():
        cells = []
        for key in ("stage1", "stage2", "beside"):
            r = [sym(x["actual"], x[key]) for x in rows if x[key] is not None]
            cells.append(f"{p90(r):.2f} ({len(r)})" if r else "-")
        print(f"| {corpus} | {seed} | {len(rows)} | " + " | ".join(cells) + " |")
    if any(c == "base-train" for c, _ in groups):
        print()
        print("(base-train is the training corpus, measured with unit scales before the refit; the held-out corpora are scored with the fitted constants.)")
    if skipped:
        print()
        print(f"({skipped} malformed lines skipped.)")


if __name__ == "__main__":
    main(sys.argv[1])
