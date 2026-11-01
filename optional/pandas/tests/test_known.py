# known.json against test_unsupported.out (plan-pandas r7 D4): every
# NotImplementedError the package raises on purpose is one divergence there,
# with its message and reason, and known.json exempts no whole test.  Its .out
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
