# capacity()["domains"] on the real basis of the runtime running this
# (plan-d0-domains-r2 §2.1): run by test/capacity.test.ts with python3 and
# with Sagebrush, and by engine/py/test_capacity.py in the CPython package
# (check(C) with its own _capacity).  Prints "domains ok" and the rows, or
# the problems.
import os
import sys

# Each source's domains, by the table in plan-d0-domains-r2 §1.2: (includes,
# constrains); a row whose usage is unknown includes nothing.
def table(C, row):
    ALL, SELF = list(C.DOMAINS), [d for d in C.DOMAINS if d != "child"]
    s = row["source"]
    if s.startswith("cgroup ") or s in ("MemAvailable", "physical available"):
        return ALL, ALL
    if s in ("RLIMIT_AS", "RLIMIT_DATA"):
        return SELF, SELF
    if s == "windows job":
        return {"job": (ALL, ALL), "process": (SELF, SELF)}.get(row.get("scope"), (SELF, ALL))
    if s == "wasm engine":
        return ["wasm-engine"], ["wasm-engine"]
    if s == "js heap":
        return ["js-heap"], ["js-heap"]
    return None


def check(C):
    rec = C.capacity()
    problems = []
    for b in rec["basis"]:
        want = table(C, b)
        if want is None:
            problems.append("a source the table doesn't know: %r" % b["source"])
            continue
        inc, con = want
        if b["used"] is None:
            inc = []
        if (b["includes"], b["constrains"]) != (list(inc), list(con)):
            problems.append("%s: %r, the table says %r" % (b["source"], (b["includes"], b["constrains"]), (inc, con)))
        if not set(b["includes"]) <= set(C.DOMAINS) or not set(b["constrains"]) <= set(C.DOMAINS):
            problems.append("%s: a domain not in DOMAINS" % b["source"])
    # the set, by the rule written out again here
    rows = [b for b in rec["basis"] if b["remaining"] is not None]
    seen = {d for b in rows for d in b["includes"]}
    blind = {d for b in rows for d in b["constrains"] if d not in b["includes"]}
    want = [] if rec["bytes"] is None else [d for d in C.DOMAINS if d in seen and d not in blind]
    if rec["domains"] != want:
        problems.append("domains %r, the rule gives %r" % (rec["domains"], want))
    # a Linux host whose OS rows are readable: every domain (they all count
    # and bound all of this process's memory and its children's)
    if sys.platform.startswith("linux") and any(b["source"] in ("MemAvailable",) or b["source"].startswith("cgroup ") for b in rows):
        if rec["domains"] != list(C.DOMAINS):
            problems.append("on this Linux host: %r, not all six" % rec["domains"])
    return rec, problems


if __name__ == "__main__":
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib"))
    import _capacity
    rec, problems = check(_capacity)
    for p in problems:
        print("WRONG", p)
    if not problems:
        print("domains ok", rec["domains"], [b["source"] for b in rec["basis"]])
