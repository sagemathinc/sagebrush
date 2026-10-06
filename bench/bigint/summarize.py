"""Markdown tables from the benchmark's CSV: python3 summarize.py results/native.csv [results/wasm.csv]

For each operation, one row per size; each library's time, and its ratio to
the reference (GMP natively; for WebAssembly, the fastest permissive library
at that size, since GMP is not built for wasm)."""
import csv, sys
from collections import defaultdict

ORDER = ["gmp(rug)", "malachite-0.12", "dashu-0.6", "num-bigint-0.5", "num-bigint-0.4"]


def fmt_ns(ns):
    for unit, k in (("s", 1e9), ("ms", 1e6), ("µs", 1e3)):
        if ns >= k:
            return "%.3g %s" % (ns / k, unit)
    return "%.0f ns" % ns


def table(path):
    data = defaultdict(dict)  # (op, bits) -> lib -> ns
    mism = []
    for row in csv.reader(open(path)):
        if not row or row[0] == "lib":
            continue
        if row[0] == "MISMATCH":
            mism.append(row)
            continue
        lib, op, bits, ns = row
        data[(op, int(bits))][lib] = float(ns)
    libs = [l for l in ORDER if any(l in d for d in data.values())]
    out = ["### %s\n" % path]
    if mism:
        out.append("**Mismatches:** %s\n" % mism)
    for op in ["mul", "sqr", "divrem", "gcd", "powmod", "to_dec", "from_dec"]:
        sizes = sorted(b for (o, b) in data if o == op)
        if not sizes:
            continue
        out.append("\n**%s**\n\n| bits | %s |\n|---:|%s" % (op, " | ".join(libs), "---:|" * len(libs)))
        for b in sizes:
            d = data[(op, b)]
            ref = d.get("gmp(rug)") or min(v for k, v in d.items() if "gmp" not in k and "malachite" not in k)
            cells = []
            for l in libs:
                if l in d:
                    cells.append("%s (%.1fx)" % (fmt_ns(d[l]), d[l] / ref))
                else:
                    cells.append("-")
            out.append("| %d | %s |" % (b, " | ".join(cells)))
    return "\n".join(out) + "\n"


for p in sys.argv[1:]:
    print(table(p))
