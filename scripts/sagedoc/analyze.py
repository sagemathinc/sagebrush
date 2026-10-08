import json, glob, re, collections, sys
area_of = lambda f: f.split("src/doc/en/")[1].split("/")[0]
tot = collections.Counter()
by = collections.defaultdict(collections.Counter)
missing_names = collections.Counter()
missing_attrs = collections.Counter()
err_types = collections.Counter()
files = 0
per_file = []
for p in glob.glob((sys.argv[1] if len(sys.argv) > 1 else "/scratch/sagedoc/out") + "/*.json"):
    d = json.load(open(p))
    files += 1
    a = area_of(d["file"])
    c = collections.Counter()
    defined_fail = set()
    for e in d.get("examples", []):
        st = e["status"]
        # a NameError for a name an earlier failed example would have defined: cascade
        if st == "error":
            err = e.get("error", "")
            m = re.search(r"NameError: name '(\w+)' is not defined", err)
            if m and re.search(r"\b%s\s*[,=]|\b%s\b\s*=" % (m.group(1), m.group(1)), "\n".join(x["code"] for x in d["examples"] if x["status"] == "error" and x is not e)):
                st = "cascade"
            elif m:
                missing_names[m.group(1)] += 1
            m2 = re.search(r"AttributeError: '(\w+)' object has no attribute '(\w+)'", err)
            if m2:
                missing_attrs["%s.%s" % m2.groups()] += 1
            err_types[err.split(":")[0][:40]] += 1
        c[st] += 1
    tot.update(c)
    by[a].update(c)
    n = sum(v for k, v in c.items() if k != "skipped")
    per_file.append(((c["ok"] + c["random-ok"]) / n if n else 0, n, d["file"].split("src/doc/en/")[1]))
def line(name, c):
    n = sum(v for k, v in c.items() if k != "skipped")
    ok = c["ok"] + c["random-ok"]
    return "%-20s %5d examples: ok %5d (%4.1f%%), wrong %4d, error %4d, cascade %4d, timeout %3d, skipped %4d" % (
        name, n, ok, 100 * ok / max(n, 1), c["wrong"], c["error"], c["cascade"], c["timeout"], c["skipped"])
print("files", files)
for a in sorted(by):
    print(line(a, by[a]))
print(line("ALL", tot))
print("\nmost frequent missing global names:")
print(", ".join("%s %d" % kv for kv in missing_names.most_common(40)))
print("\nmost frequent missing methods:")
print(", ".join("%s %d" % kv for kv in missing_attrs.most_common(30)))
print("\nerror types:", err_types.most_common(10))
per_file.sort()
print("\nbest files:", [(round(r, 2), n, f) for r, n, f in per_file[-8:]])
print("worst big files:", [(round(r, 2), n, f) for r, n, f in per_file if n >= 40][:8])
