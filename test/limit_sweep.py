"""The baseline sweep of the limit-sites census (plan-limit-sites-sweep-r3):
the baseline's sites registered batch by batch, and the registered class-1/2/3
entries given their dispositions, until the baseline excuses nothing.

Its files, in test/limit-sweep/:
  rules.json      the partition's rules: the owners by path (the first row
                  that matches wins), the target and the tail, the owners'
                  order, and whether every entry needs its disposition yet
                  (from B18)
  manifest.json   the work, frozen at one commit M: every item (a baseline
                  site to register, or a class-1/2/3 entry to give a
                  disposition) in exactly one batch, with M, the sha256 of
                  its inputs at M and of rules.json.  Built only by
                  `manifest`; the test rebuilds it from M and compares it
                  byte for byte, so it never changes but by a reviewed
                  migration (a new version recording the old one's sha256)
  routes.json     the reviewed routes a disposition may name: a memory guard
                  (kind "memory") or a trusted host capability (kind "host",
                  with its unarmed default), each where = "path::name",
                  resolved in the current source
  followups.json  the follow-ups, the source of truth: open, fixed (by a PR
                  and its merge commit) or withdrawn (with the reason)
  batches.json    the batches done, and the active-baseline count the tree
                  must have (recomputed by apply, recount and merge)

An entry of test/limit-sites.json is {class, owner, batch?, disposition?,
reason?, ...}.  A disposition has one field per class component:
  "1": "shared" (a shared resource, editor, protocol, display or parser), or {"followup": ID}
  "2": {"route": ROUTE} (a memory route), or {"followup": ID}
  "3": {"limits": KEY} (a key of lib/_limits.py's TABLE), {"host": ROUTE} (a host route), or {"followup": ID}
It is required for the entries a batch wrote (with "batch"), the done
batches' items, every entry registered after M (no batch's item: whichever
change registers it gives it, `limit_sites.py --register ... --disposition`),
and, once rules.json says so (B18), every entry.  A `none`
entry a batch wrote whose line has the refusal signal needs a one-line
reason.

What the census checks (test/limit_sites.py's check(), "sweep"), each
problem naming its key or item:
  - every active baseline site (present, unregistered, its hash in the
    baseline) is one of the manifest's sites to register: a site that lost
    its entry, or a seed line that reappeared, is registered in the same
    change, never excused again;
  - a done batch's sites stay registered, its entries keep their
    dispositions;
  - the entries' dispositions, routes, keys and follow-ups are valid;
  - an open follow-up has at least one active key (a current site with an
    entry), its active keys and the entries pointing to it agree, and no
    active key points to a fixed or withdrawn one;
  - the active-baseline count is batches.json's.

    python3 test/limit_sweep.py manifest REV        write manifest.json from the files at REV
    python3 test/limit_sweep.py verify              rebuild the manifest from its REV and compare (exit 1 if it differs)
    python3 test/limit_sweep.py worksheet BATCH [OUT]
                                                    a batch's worksheet (default test/limit-sweep/work/BATCH.json)
    python3 test/limit_sweep.py apply WORKSHEET     validate the whole worksheet, then write its rows (or nothing)
    python3 test/limit_sweep.py merge KIND BASE OURS THEIRS
                                                    a three-way merge of a registry, followups or batches file
                                                    (KIND), into OURS; exit 1 naming each conflict
    python3 test/limit_sweep.py recount             write the tree's active-baseline count to batches.json
"""
import ast
import hashlib
import json
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import limit_sites as L  # noqa: E402

FORMAT = "sagebrush-limit-sweep-manifest"
INPUTS = ("test/limit-sites.json", "test/limit-sites-baseline.txt", "test/limit_sites.py")
FOLLOWUP_ID = re.compile(r"FU-B\d+-\d+")
SHA = re.compile(r"[0-9a-f]{40}")

# A line's priority signal (the plan's §3, its probe's): a named constant, a refusal, a comparison with a number.
CONST = re.compile(r"^\s*(?:pub\s+)?(?:const|static|let|export\s+const|const\s+)?\s*_?[A-Z][A-Z0-9_]*(?:\s*:\s*[\w<>\[\]]+)?\s*=")
REFUSE = re.compile(r"raise |throw |Err\(|refus|panic!|return Err|NotImplementedError|too large|exceeds|unsupported", re.I)
CMP = re.compile(r"[<>]=?\s*-?\d|\d\s*[<>]=?|len\(.*\)\s*[<>]")


def here(name):
    return os.path.join(L.ROOT, "test", "limit-sweep", name)


def text_of(key):
    return key.split(" :: ", 2)[2]


def signal(key):
    t = text_of(key)
    if CONST.match(t):
        return "constant"
    if REFUSE.search(t):
        return "refusal"
    if CMP.search(t):
        return "comparison"
    return "other"


def refusal(key):
    return bool(REFUSE.search(text_of(key)))


def components(cls):
    return sorted(set(c for c in cls or "" if c in "123"))


def dump(value):
    return json.dumps(value, indent=1, sort_keys=True, ensure_ascii=False) + "\n"


def load_json(name, default=None):
    p = here(name)
    if default is not None and not os.path.exists(p):
        return default
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def write_all(files):
    """Write {path: text} so that a failure leaves every file as it was: all
    written aside first, then each moved into place."""
    tmp = []
    try:
        for p, text in files.items():
            t = p + ".sweep-tmp"
            with open(t, "w", encoding="utf-8") as f:
                f.write(text)
            tmp.append((t, p))
        for t, p in tmp:
            os.replace(t, p)
    finally:
        for t, _ in tmp:
            if os.path.exists(t):
                os.remove(t)


def git(*args, text=True):
    return subprocess.run(["git", *args], cwd=L.ROOT, capture_output=True, check=True, text=text).stdout


# ---------------------------------------------------------------------------
# The partition and the manifest (§3, §4.1)

def owner_of(path, rules):
    for row in rules["owners"]:
        if re.fullmatch(row["match"], path):
            return row["owner"]
    raise ValueError("no owner row matches %s" % path)


def partition(work, rules):
    """[(owner, [paths], work)]: each owner's files whole, ordered by their
    share of high-signal work, cut at the target, a tail under the tail size
    joining the owner's previous batch.  work: path -> [register, high, dispositions]."""
    by = {}
    for p, (n, h, d) in work.items():
        by.setdefault(owner_of(p, rules), []).append((p, n + d, h + d))
    out = []
    for o in rules["order"]:
        fs = sorted(by.pop(o, []), key=lambda f: (-(f[2] / f[1]), f[0]))
        cur, n = [], 0
        for f in fs:
            if cur and n + f[1] > rules["target"]:
                out.append((o, cur, n))
                cur, n = [], 0
            cur.append(f)
            n += f[1]
        if cur:
            if n < rules["tail"] and out and out[-1][0] == o:
                _, f0, n0 = out.pop()
                out.append((o, f0 + cur, n0 + n))
            else:
                out.append((o, cur, n))
    if by:
        raise ValueError("owners missing from rules.json's order: %s" % ", ".join(sorted(by)))
    return [(o, [f[0] for f in fs], n) for o, fs, n in out]


def build_manifest(rev, rules_bytes):
    """The manifest's text, from the files, registry and baseline at REV only."""
    rules = json.loads(rules_bytes)
    sha = git("rev-parse", "--verify", rev + "^{commit}").strip()
    found = L.sites(sha)
    reg, base = L.load(sha), L.baseline_keys(sha)
    now = {k for k, _, _ in found}
    stale = sorted(set(reg) - now)
    if stale:
        raise ValueError("the registry at %s has stale entries (prune them first): %s" % (sha, stale[0]))
    register = L.active_baseline(now, reg, base)
    dispose = sorted(k for k, v in reg.items() if components(v.get("class")))
    work = {}
    for k in register:
        w = work.setdefault(k.split(" :: ", 1)[0], [0, 0, 0])
        w[0] += 1
        w[1] += signal(k) != "other"
    for k in dispose:
        work.setdefault(k.split(" :: ", 1)[0], [0, 0, 0])[2] += 1
    parts = partition(work, rules)
    batch_of, batches = {}, []
    for i, (o, files, n) in enumerate(parts, 1):
        b = "B%d" % i
        for p in files:
            batch_of[p] = b
        batches.append({"id": b, "owner": o, "files": files, "work": n, "register": sum(work[p][0] for p in files),
                        "dispositions": sum(work[p][2] for p in files), "oversize": len(files) == 1 and n > rules["target"]})
    order = {b["id"]: i for i, b in enumerate(batches)}
    items = [[k, "register", batch_of[k.split(" :: ", 1)[0]], signal(k)] for k in register] + \
            [[k, "disposition", batch_of[k.split(" :: ", 1)[0]], signal(k)] for k in dispose]
    items.sort(key=lambda it: (order[it[2]], it[0]))
    inputs = {p: hashlib.sha256(git("show", "%s:%s" % (sha, p), text=False)).hexdigest() for p in INPUTS}
    head = {"format": FORMAT, "v": 1, "rev": sha, "inputs": inputs, "rules_sha256": hashlib.sha256(rules_bytes).hexdigest()}
    line = lambda v: json.dumps(v, sort_keys=True, ensure_ascii=False)
    return (dump(head)[:-2] + ",\n \"batches\": [\n" + ",\n".join("  " + line(b) for b in batches) + "\n ],\n"
            " \"items\": [\n" + ",\n".join("  " + line(it) for it in items) + "\n ]\n}\n")


def rules_bytes():
    with open(here("rules.json"), "rb") as f:
        return f.read()


def manifest():
    """The committed manifest, parsed: {rev, batches: {id: batch}, items: {key: (kind, batch, signal)}}, and its problems."""
    with open(here("manifest.json"), encoding="utf-8") as f:
        m = json.load(f)
    errs, items = [], {}
    batches = {b["id"]: b for b in m["batches"]}
    for k, kind, b, sig in m["items"]:
        if k in items:
            errs.append("%s: in the manifest twice" % k)
        if b not in batches:
            errs.append("%s: in the manifest's batch %s, which it doesn't have" % (k, b))
        items[k] = (kind, b, sig)
    return {"rev": m["rev"], "batches": batches, "items": items, "raw": m}, errs


def coverage(m):
    """[problem]: at M, every active baseline site is exactly one register item and every class-1/2/3 entry
    exactly one disposition item, read from M's files again, not through build_manifest (daybreak2, #181)."""
    errs, rev = [], m["rev"]
    found = L.sites(rev)
    reg, base = L.load(rev), L.baseline_keys(rev)
    now = {k for k, _, _ in found}
    want = {k: "register" for k in now if k not in reg and L.short(k) in base}
    want.update({k: "disposition" for k, v in reg.items() if any(c in v.get("class", "") for c in "123")})
    counts = {}
    for k, kind, _, _ in m["raw"]["items"]:
        counts[(k, kind)] = counts.get((k, kind), 0) + 1
    for k, kind in sorted(want.items()):
        if counts.get((k, kind), 0) != 1:
            errs.append("%s: a %s item at %s, in the manifest %d times" % (k, kind, rev[:8], counts.get((k, kind), 0)))
    for (k, kind), n in sorted(counts.items()):
        if want.get(k) != kind:
            errs.append("%s: a %s item in the manifest, which isn't one at %s" % (k, kind, rev[:8]))
    return errs


def verify():
    """[problem]: the committed manifest against the one rebuilt from its REV, each difference by key."""
    with open(here("manifest.json"), encoding="utf-8") as f:
        text = f.read()
    m, errs = manifest()
    rb = rules_bytes()
    if hashlib.sha256(rb).hexdigest() != m["raw"]["rules_sha256"]:
        return errs + ["rules.json isn't the manifest's (its sha256 changed): a change of the rules is a reviewed migration, a new manifest version"]
    try:
        git("cat-file", "-e", m["rev"] + "^{commit}")
    except subprocess.CalledProcessError:
        git("fetch", "--quiet", "--no-tags", "--depth=1", "origin", m["rev"])
    errs += coverage(m)
    again = build_manifest(m["rev"], rb)
    if again == text:
        return errs
    want = {k: (kind, b, sig) for k, kind, b, sig in json.loads(again)["items"]}
    for k in sorted(set(want) | set(m["items"])):
        if k not in m["items"]:
            errs.append("%s: missing from the manifest (rebuilt: %s in %s)" % (k, want[k][0], want[k][1]))
        elif k not in want:
            errs.append("%s: in the manifest, but not an item at %s" % (k, m["rev"]))
        elif want[k] != m["items"][k]:
            errs.append("%s: the manifest has %s, rebuilt %s" % (k, m["items"][k], want[k]))
    return errs or ["the manifest's text differs from the one rebuilt from %s (its header or batches)" % m["rev"]]


# ---------------------------------------------------------------------------
# Entries, routes, follow-ups (§1, §2)

def limit_keys():
    """lib/_limits.py's TABLE keys, read from its source."""
    with open(os.path.join(L.ROOT, "lib", "_limits.py"), encoding="utf-8") as f:
        tree = ast.parse(f.read())
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "TABLE" for t in node.targets) \
                and isinstance(node.value, ast.Dict):
            return {k.value for k in node.value.keys if isinstance(k, ast.Constant) and isinstance(k.value, str)}
    return set()


def resolves(where):
    """Does "path::qualified name" name a function or class in the current source?"""
    path, _, name = (where or "").partition("::")
    p = os.path.join(L.ROOT, path)
    if not name or not path or ".." in path.split("/") or not os.path.isfile(p):
        return False
    with open(p, encoding="utf-8", errors="replace") as f:
        text = f.read()
    if path.endswith(".py"):
        return name in set(L.py_functions(text).values())
    lang = "rs" if path.endswith(".rs") else "ts"
    found = set()
    for line in text.split("\n"):
        m = L._DECL[lang].match(line)
        if m:
            found.add(next(g for g in m.groups() if g))
    return name in found


def context():
    routes = load_json("routes.json", {"routes": []})["routes"]
    fus = load_json("followups.json", {"items": []})["items"]
    return {"routes": {r.get("id"): r for r in routes}, "route_rows": routes, "limits": limit_keys(),
            "followups": {f.get("id"): f for f in fus}, "followup_rows": fus,
            "rules": json.loads(rules_bytes()) if os.path.exists(here("rules.json")) else {"dispositions_everywhere": False}}


def route_problems(ctx):
    errs, seen = [], set()
    for r in ctx["route_rows"]:
        rid = r.get("id")
        if not isinstance(rid, str) or not rid or rid in seen:
            errs.append("routes.json: a row's id is missing or repeated: %r" % (rid,))
        seen.add(rid)
        if r.get("kind") not in ("memory", "host"):
            errs.append("route %s: kind must be memory or host" % rid)
        if not resolves(r.get("where")):
            errs.append("route %s: %r names no function in the current source" % (rid, r.get("where")))
        if r.get("kind") == "host" and not resolves(r.get("default")):
            errs.append("route %s: a host route names its default-unarmed route (default), which must resolve" % rid)
    return errs


def entry_problems(key, v, ctx, require, reason=None):
    """[problem] of one registry entry's disposition (required if `require`) and reason (if `reason`, which
    defaults to `require`)."""
    reason = require if reason is None else reason
    errs, cls = [], v.get("class")
    cs, d = components(cls), v.get("disposition")
    if d is None:
        if require and cs:
            errs.append("%s: class %s needs a disposition for %s" % (key, cls, " and ".join(cs)))
    elif not isinstance(d, dict) or sorted(d) != cs:
        errs.append("%s: its disposition must have exactly the class's components (%s)" % (key, ", ".join(cs) or "none"))
    else:
        for c in cs:
            x = d[c]
            if isinstance(x, dict) and list(x) == ["followup"]:
                if x["followup"] not in ctx["followups"]:
                    errs.append("%s: component %s names follow-up %r, which followups.json doesn't have" % (key, c, x["followup"]))
            elif c == "1" and x == "shared":
                pass
            elif c == "2" and isinstance(x, dict) and list(x) == ["route"]:
                if ctx["routes"].get(x["route"], {}).get("kind") != "memory":
                    errs.append("%s: component 2 names %r, not a memory route of routes.json" % (key, x["route"]))
            elif c == "3" and isinstance(x, dict) and list(x) == ["limits"]:
                if x["limits"] not in ctx["limits"]:
                    errs.append("%s: component 3 names %r, not a key of lib/_limits.py's TABLE" % (key, x["limits"]))
            elif c == "3" and isinstance(x, dict) and list(x) == ["host"]:
                if ctx["routes"].get(x["host"], {}).get("kind") != "host":
                    errs.append("%s: component 3 names %r, not a host route of routes.json" % (key, x["host"]))
            else:
                errs.append("%s: component %s's disposition %s isn't one it may have" % (key, c, json.dumps(x)))
    r = v.get("reason")
    if r is not None and (not isinstance(r, str) or not r.strip() or "\n" in r or len(r) > 300):
        errs.append("%s: its reason must be one line of text" % key)
    if reason and cls == "none" and refusal(key) and r is None:
        errs.append("%s: a none site whose line has the refusal signal needs a one-line reason" % key)
    return errs


def followup_problems(reg, now, ctx):
    errs, seen = [], set()
    pointing = {}
    for k, v in reg.items():
        d = v.get("disposition")
        if k in now and isinstance(d, dict):
            for x in d.values():
                if isinstance(x, dict) and list(x) == ["followup"]:
                    pointing.setdefault(x["followup"], set()).add(k)
    for f in ctx["followup_rows"]:
        fid, st = f.get("id"), f.get("status")
        if not isinstance(fid, str) or not FOLLOWUP_ID.fullmatch(fid) or fid in seen:
            errs.append("followups.json: an id is malformed or repeated: %r" % (fid,))
        seen.add(fid)
        keys = f.get("keys")
        if not isinstance(keys, list) or not all(isinstance(k, str) for k in keys) or not f.get("what") or not f.get("owner"):
            errs.append("%s: needs keys (a list), what and owner" % fid)
            continue
        if st == "fixed":
            fb = f.get("fixed_by")
            if not (isinstance(fb, dict) and isinstance(fb.get("pr"), int) and fb["pr"] > 0 and SHA.fullmatch(str(fb.get("commit", "")))):
                errs.append("%s: fixed needs fixed_by: {pr, commit (the merge commit's full sha)}" % fid)
        elif st == "withdrawn":
            if not isinstance(f.get("withdrawn_because"), str) or not f["withdrawn_because"].strip():
                errs.append("%s: withdrawn needs withdrawn_because" % fid)
        elif st != "open":
            errs.append("%s: status must be open, fixed or withdrawn" % fid)
        active = {k for k in keys if k in now and k in reg}
        to = pointing.get(fid, set())
        if st == "open":
            if not active:
                errs.append("%s: an open follow-up with no active key (its keys are historical, or none): migrate its key, or mark it fixed or withdrawn, in this change" % fid)
            for k in sorted(active - to):
                errs.append("%s: listed by %s, but its entry doesn't point to it" % (k, fid))
            for k in sorted(to - set(keys)):
                errs.append("%s: points to %s, which doesn't list it" % (k, fid))
        else:
            for k in sorted(to):
                errs.append("%s: an active key pointing to %s, which is %s" % (k, fid, st))
    for fid in sorted(set(pointing) - seen):
        for k in sorted(pointing[fid]):
            errs.append("%s: points to %s, which followups.json doesn't have" % (k, fid))
    return errs


def problems(found, reg, base, active):
    """The sweep's census problems (check()'s "sweep"), each naming its key."""
    if not os.path.exists(here("manifest.json")):
        return []
    m, errs = manifest()
    ctx = context()
    now = {k for k, _, _ in found}
    state = load_json("batches.json", {"done": [], "active_baseline": None})
    done = set(state.get("done", []))
    every = bool(ctx["rules"].get("dispositions_everywhere"))
    errs += route_problems(ctx)
    for b in sorted(done - set(m["batches"])):
        errs.append("batches.json: %s is done, but the manifest has no such batch" % b)
    for k, v in sorted(reg.items()):
        if "batch" in v and v["batch"] not in m["batches"]:
            errs.append("%s: its batch %r isn't the manifest's" % (k, v["batch"]))
        item = m["items"].get(k)
        # (a class-1/2/3 entry the manifest doesn't know was registered, or reclassified, after M: it is no
        # batch's, so it needs its disposition now, from whichever change registers it (daybreak2, #181))
        swept = every or "batch" in v or (item is not None and item[1] in done)
        errs += entry_problems(k, v, ctx, swept or item is None, swept)
    errs += followup_problems(reg, now, ctx)
    for k in active:
        if m["items"].get(k, ("",))[0] != "register":
            errs.append("%s: an active baseline site that isn't one of the manifest's to register: register it in this change" % k)
    for k, (kind, b, _) in sorted(m["items"].items()):
        if b in done and k in now and k not in reg:
            errs.append("%s: unregistered, in %s, which is done" % (k, b))
    if state.get("active_baseline") != len(active):
        errs.append("batches.json's active_baseline is %s, the tree's %d: run test/limit_sweep.py recount" % (state.get("active_baseline"), len(active)))
    return errs


# ---------------------------------------------------------------------------
# Worksheets and apply (§5)

def current():
    found = L.sites()
    now = {k: (p, n) for k, p, n in found}
    reg, base = L.load(), L.baseline_keys()
    return found, now, reg, base, set(L.active_baseline(now, reg, base))


def worksheet(batch, out=None):
    m, errs = manifest()
    if errs or batch not in m["batches"]:
        raise SystemExit("\n".join(errs) or "the manifest has no batch %s" % batch)
    _, now, reg, _, _ = current()
    rows = []
    for k, (kind, b, sig) in m["items"].items():
        if b != batch:
            continue
        p, n = now.get(k, (k.split(" :: ", 1)[0], None))
        e = reg.get(k)
        rows.append({"key": k, "kind": kind, "path": p, "line": n, "signal": sig, "refusal": refusal(k), "entry": e,
                     "class": e["class"] if e else "", "disposition": (e or {}).get("disposition"), "reason": (e or {}).get("reason")})
    out = out or here(os.path.join("work", batch + ".json"))
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        f.write(dump({"batch": batch, "owner": m["batches"][batch]["owner"], "rows": rows}))
    return out, len(rows)


def batch_done(batch, m, reg, now, ctx):
    for k, (kind, b, _) in m["items"].items():
        if b != batch or k not in now:
            continue
        if k not in reg or entry_problems(k, reg[k], ctx, True) or (kind == "disposition" and components(reg[k]["class"]) and "disposition" not in reg[k]):
            return False
    return True


def apply(path):
    """Validate every row, then write the registry and batches.json together, or nothing."""
    with open(path, encoding="utf-8") as f:
        ws = json.load(f)
    m, errs = manifest()
    batch = ws.get("batch")
    if batch not in m["batches"]:
        return errs + ["the worksheet's batch %r isn't the manifest's" % (batch,)]
    owner = m["batches"][batch]["owner"]
    if ws.get("owner", owner) != owner:
        errs.append("the worksheet's owner %r isn't %s's, %s" % (ws.get("owner"), batch, owner))
    ctx = context()
    _, now, reg, base, active = current()
    new, seen = dict(reg), {}
    for i, row in enumerate(ws.get("rows", []), 1):
        k = row.get("key")
        item = m["items"].get(k)
        if item is None or item[1] != batch:
            errs.append("row %d: %s isn't an item of %s" % (i, k, batch))
            continue
        if k in seen:
            errs.append("row %d: %s again (row %d)%s" % (i, k, seen[k], ", classified differently" if row != ws["rows"][seen[k] - 1] else ""))
            continue
        seen[k] = i
        if row.get("kind", item[0]) != item[0]:
            errs.append("row %d: %s is a %s item, not %s" % (i, k, item[0], row.get("kind")))
            continue
        if row.get("owner", owner) != owner:
            errs.append("row %d: %s's owner is %s, not %r" % (i, k, owner, row.get("owner")))
            continue
        cls, disp, reason = row.get("class") or "", row.get("disposition"), row.get("reason")
        if item[0] == "register":
            if not cls:
                continue  # (not done yet)
            if k not in active:
                errs.append("row %d: %s is no longer an active baseline site (%s)" % (i, k, "registered" if k in reg else "gone, or changed"))
                continue
            entry = {"class": cls, "owner": owner, "batch": batch}
        else:
            if not cls and disp is None:
                continue
            if k not in reg or k not in now:
                errs.append("row %d: %s is no longer a registered site" % (i, k))
                continue
            entry = dict(reg[k], batch=batch)
            if cls:
                entry["class"] = cls
        if entry["class"] not in L.CLASSES:
            errs.append("row %d: %s: class %r isn't one of %s" % (i, k, entry["class"], ", ".join(sorted(L.CLASSES))))
            continue
        if disp is not None:
            entry["disposition"] = disp
        else:
            entry.pop("disposition", None)
        if reason is not None:
            entry["reason"] = reason
        if "explained" in entry and "2" not in entry["class"]:
            errs.append("row %d: %s: explained is for a class-2 site" % (i, k))
        errs += ["row %d: %s" % (i, e) for e in entry_problems(k, entry, ctx, True)]
        new[k] = entry
    errs += followup_problems(new, set(now), ctx)
    if errs:
        return errs
    state = load_json("batches.json", {"done": [], "active_baseline": None})
    done = set(state.get("done", []))
    if batch_done(batch, m, new, now, ctx):
        done.add(batch)
    state = dict(state, done=sorted(done, key=lambda b: int(b[1:])), active_baseline=len(L.active_baseline(now, new, base)))
    write_all({L.REGISTRY: json.dumps(new, indent=1, sort_keys=True, ensure_ascii=False) + "\n", here("batches.json"): dump(state)})
    return []


def recount():
    _, now, reg, base, active = current()
    state = load_json("batches.json", {"done": []})
    state["active_baseline"] = len(active)
    write_all({here("batches.json"): dump(state)})
    return len(active)


# ---------------------------------------------------------------------------
# The three-way merge (§5)

def merge3(base, ours, theirs):
    """(merged, conflicts) of three {id: value} maps, absence told from a value:
    equal sides, or one side changed (added, edited, deleted), merge; two
    different changes of one id conflict."""
    out, conflicts = {}, []
    for k in sorted(set(base) | set(ours) | set(theirs)):
        b, o, t = base.get(k), ours.get(k), theirs.get(k)
        if o == t:
            v = o
        elif o == b:
            v = t
        elif t == b:
            v = o
        else:
            what = "added differently on both sides" if b is None else ("deleted on one side, changed on the other" if o is None or t is None else "changed differently on both sides")
            conflicts.append("%s: %s" % (k, what))
            continue
        if v is not None:
            out[k] = v
    return out, conflicts


def merge(kind, base, ours, theirs):
    load = lambda p: json.load(open(p, encoding="utf-8"))
    B, O, T = load(base), load(ours), load(theirs)
    if kind == "registry":
        out, c = merge3(B, O, T)
        text = json.dumps(out, indent=1, sort_keys=True, ensure_ascii=False) + "\n"
    elif kind == "followups":
        by = lambda d: {f["id"]: f for f in d.get("items", [])}
        items, c = merge3(by(B), by(O), by(T))
        text = dump(dict(O, items=[items[k] for k in sorted(items)]))
    elif kind == "batches":
        by = lambda d: {b: True for b in d.get("done", [])}
        done, c = merge3(by(B), by(O), by(T))
        # (the count is the merged tree's, recounted after the merge, never one side's)
        text = dump(dict(O, done=sorted(done, key=lambda b: int(b[1:])), active_baseline=None))
    else:
        raise SystemExit("merge KIND: registry, followups or batches")
    if c:
        return c
    write_all({ours: text})
    if kind == "registry" and os.path.exists(ours) and os.path.samefile(ours, L.REGISTRY):
        recount()
        bad = L.check()["problems"]
        return ["after the merge: %s: %s" % (name, k) for name, ks in bad.items() for k in ks]
    return []


def main(argv):
    cmd = argv[:1]
    if cmd == ["manifest"] and len(argv) == 2:
        text = build_manifest(argv[1], rules_bytes())
        write_all({here("manifest.json"): text})
        m, _ = manifest()
        print("manifest at %s: %d items in %d batches" % (m["rev"], len(m["items"]), len(m["batches"])))
        return 0
    if cmd == ["verify"]:
        errs = verify()
        print("\n".join(errs) or "the manifest is the one rebuilt from its revision")
        return 1 if errs else 0
    if cmd == ["worksheet"] and len(argv) in (2, 3):
        out, n = worksheet(argv[1], argv[2] if len(argv) == 3 else None)
        print("%s: %d rows" % (out, n))
        return 0
    if cmd == ["apply"] and len(argv) == 2:
        errs = apply(argv[1])
        print("\n".join(errs) or "applied")
        return 1 if errs else 0
    if cmd == ["merge"] and len(argv) == 5:
        errs = merge(*argv[1:])
        print("\n".join(errs) or "merged")
        return 1 if errs else 0
    if cmd == ["recount"]:
        print("active baseline: %d" % recount())
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
