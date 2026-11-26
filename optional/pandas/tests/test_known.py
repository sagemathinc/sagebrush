# known.json against test_unsupported.out (plan-pandas r7 D4): every
# NotImplementedError the package raises on purpose is one divergence there,
# with its message and reason, and known.json exempts no whole test. Its
# value_divergences name the few ruled differences in values, with no refusal.  Its .out
# is Sagebrush's; test_unsupported.out itself is checked against the live run.
import json
from _cases import case

known = json.load(open("../known.json"))
div = known["divergences"]

raised = {}
cur = None
for line in open("test_unsupported.out").read().split("\n"):
    if line.startswith("== "):
        cur = line[3:]
    elif cur is not None and line:
        if line.startswith("!! NotImplementedError: "):
            raised[cur] = line[len("!! NotImplementedError: "):]
        cur = None

case("keys", lambda: sorted(known))
case("no-test-exempted", lambda: known["tests"])
case("entry-fields", lambda: [d.get("case") for d in div if sorted(d) != ["case", "message", "reason"]])
case("entry-text", lambda: [d["case"] for d in div if not all(isinstance(d[k], str) and d[k].strip() for k in d)])
case("unique", lambda: len(div) == len({d["case"] for d in div}))
case("count", lambda: (len(div), len(raised)))
case("missing", lambda: sorted(set(raised) - {d["case"] for d in div}))
case("extra", lambda: sorted({d["case"] for d in div} - set(raised)))
case("message", lambda: [d["case"] for d in div if raised.get(d["case"], d["message"]) != d["message"]])

# values that differ from pandas without a refusal (ruled divergences): each named, with where it shows and why
vdiv = known["value_divergences"]
case("value-entry-fields", lambda: [d.get("case") for d in vdiv if sorted(d) != ["case", "reason", "where"]])
case("value-entry-text", lambda: [d["case"] for d in vdiv if not all(isinstance(d[k], str) and d[k].strip() for k in d)])
case("value-unique", lambda: len(vdiv) == len({d["case"] for d in vdiv}) and not ({d["case"] for d in vdiv} & {d["case"] for d in div}))
case("value-cases", lambda: [d["case"] for d in vdiv])
# (each one pinned by a case of test_groupby_blocks.py, whose .out is Sagebrush's: a change in the values shows there)
pinned = [l[3:] for l in open("test_groupby_blocks.out").read().split("\n") if l.startswith("== ")]
case("value-cases-pinned", lambda: [d["case"] for d in vdiv if d["case"] not in pinned])

# the oracle's coverage (astra's PD626-4): every test_*.py is either listed in
# sagebrush-only.txt (its .out is Sagebrush's, and gen-oracle.sh skips it) or
# has the oracle's output in oracle/, never both and never neither; and the
# list names only test files that exist
import os
only = [l.strip() for l in open("sagebrush-only.txt") if l.strip() and not l.startswith("#")]
tests = sorted(f for f in os.listdir(".") if f.startswith("test_") and f.endswith(".py"))
oracle = sorted(f[:-4] + ".py" for f in os.listdir("oracle") if f.endswith(".txt"))
case("sagebrush-only", lambda: sorted(only))
case("sagebrush-only-unknown", lambda: sorted(set(only) - set(tests)))
case("oracle-and-sagebrush-only", lambda: sorted(set(only) & set(oracle)))
case("neither", lambda: sorted(set(tests) - set(only) - set(oracle)))
case("oracle-without-test", lambda: sorted(set(oracle) - set(tests)))
