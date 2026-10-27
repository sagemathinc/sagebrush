"""The sweep tooling's fixture cases (test/limit_sweep.py; plan-limit-sites-sweep-r3
sections 2, 4 and 5), each in a small git repository of its own: the manifest's
reproduction, the membership checks (astra2's counterexamples), the follow-ups'
liveness, apply's refusals and the three-way merge.  Each failing case must name
its key or item.  Run by test/limits.test.ts:

    python3 test/limit_sweep_cases.py         prints "ok: N checks", or the failures and exits 1
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import limit_sites as L  # noqa: E402
import limit_sweep as S  # noqa: E402

checks, failures = 0, []


def ok(cond, what):
    global checks
    checks += 1
    if not cond:
        failures.append(what)


def names(errs, key, *words):
    """Does some problem name KEY (and each of WORDS)?"""
    return any(key in e and all(w in e for w in words) for e in errs)


ONE = '''def f(n):
    if n > LIMIT_A: raise ValueError("limit a")
    if n > LIMIT_B: raise ValueError("limit b")
    k = LIMIT_K
'''
TWO = '''def g(n):
    c = budget_c
    d = budget_d
    e = budget_e
'''
KA = 'lib/one.py :: f :: if n > LIMIT_A: raise ValueError("limit a") #0'
KB = 'lib/one.py :: f :: if n > LIMIT_B: raise ValueError("limit b") #0'
KK = "lib/one.py :: f :: k = LIMIT_K #0"
KC = "lib/two.py :: g :: c = budget_c #0"
KD = "lib/two.py :: g :: d = budget_d #0"
KE = "lib/two.py :: g :: e = budget_e #0"
KG = "lib/two.py :: g :: ghost = limit_ghost #0"  # (in the seed's baseline, absent at M)
RULES = {"v": 1, "target": 3, "tail": 0, "order": ["python", "magma"], "dispositions_everywhere": False,
         "owners": [{"owner": "magma", "match": "lib/_magma[^/]*"}, {"owner": "python", "match": ".*"}]}


class Repo:
    """A fixture checkout: at its first commit M, k is registered (none) with a
    seed-baseline hash, e is registered (class 2), and a, b, c, d are the
    baseline's: B1 = one.py (a, b), B2 = two.py (c, d to register, e's disposition)."""

    def __init__(self):
        self.root = tempfile.mkdtemp(prefix="sb-sweep-")
        self.files = {"lib/one.py": ONE, "lib/two.py": TWO,
                      "lib/_limits.py": 'TABLE = {\n    "ff.work": (0, 1, 2),\n}\n',
                      "lib/_memguard.py": "def memory_guard(what):\n    pass\n",
                      "test/limit-sites.json": json.dumps({KK: {"class": "none", "owner": "python"}, KE: {"class": "2", "owner": "python"}}, indent=1, sort_keys=True) + "\n",
                      "test/limit-sites-baseline.txt": "".join(h + "\n" for h in sorted(L.short(k) for k in (KA, KB, KK, KC, KD, KG)))}
        for p, t in self.files.items():
            self.write(p, t)
        shutil.copy(os.path.join(HERE, "limit_sites.py"), os.path.join(self.root, "test", "limit_sites.py"))
        self.git("init", "-q")
        self.git("add", "-A")
        self.git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "M")
        self.M = self.git("rev-parse", "HEAD").strip()
        L.use_root(self.root)
        self.write("test/limit-sweep/rules.json", json.dumps(RULES, indent=1) + "\n")
        self.write("test/limit-sweep/routes.json", json.dumps({"v": 1, "routes": [{"id": "memguard", "kind": "memory", "where": "lib/_memguard.py::memory_guard"}]}) + "\n")
        self.write("test/limit-sweep/followups.json", json.dumps({"v": 1, "items": []}) + "\n")
        self.write("test/limit-sweep/batches.json", json.dumps({"v": 1, "done": [], "active_baseline": None}) + "\n")
        self.write("test/limit-sweep/manifest.json", S.build_manifest(self.M, S.rules_bytes()))
        S.recount()

    def git(self, *a):
        return subprocess.run(["git", *a], cwd=self.root, capture_output=True, text=True, check=True).stdout

    def path(self, p):
        return os.path.join(self.root, p)

    def write(self, p, text):
        os.makedirs(os.path.dirname(self.path(p)), exist_ok=True)
        with open(self.path(p), "w", encoding="utf-8") as f:
            f.write(text)

    def read(self, p):
        with open(self.path(p), encoding="utf-8") as f:
            return f.read()

    def reg(self, change=None):
        r = json.loads(self.read("test/limit-sites.json"))
        if change:
            change(r)
            self.write("test/limit-sites.json", json.dumps(r, indent=1, sort_keys=True) + "\n")
        return r

    def sweep(self):
        return L.check()["problems"]["sweep"]

    def worksheet(self, batch, rows):
        p = self.path("ws-%s.json" % batch)
        with open(p, "w", encoding="utf-8") as f:
            json.dump({"batch": batch, "owner": "python", "rows": rows}, f)
        return p

    def followups(self, items):
        self.write("test/limit-sweep/followups.json", json.dumps({"v": 1, "items": items}) + "\n")

    def close(self):
        L.use_root(os.path.dirname(HERE))
        shutil.rmtree(self.root, ignore_errors=True)


def reg_row(key, cls, **kw):
    return dict({"key": key, "kind": "register", "class": cls}, **kw)


def manifest_cases():
    r = Repo()
    try:
        m, errs = S.manifest()
        ok(not errs and S.verify() == [], "the fixture's manifest verifies: %s" % (errs or S.verify()))
        ok([b["id"] for b in m["raw"]["batches"]] == ["B1", "B2"] and m["items"][KA][:2] == ("register", "B1")
           and m["items"][KC][:2] == ("register", "B2") and m["items"][KE][:2] == ("disposition", "B2") and KK not in m["items"] and KG not in m["items"],
           "the partition: B1 one.py (a, b), B2 two.py (c, d; e's disposition); k and the ghost aren't items: %s" % m["items"])
        ok(m["raw"]["inputs"]["test/limit-sites.json"] == hashlib.sha256(r.files["test/limit-sites.json"].encode()).hexdigest(), "the manifest records its inputs' sha256 at M")
        # the working tree changes (a registration, an edited line): the rebuild from M is the same bytes
        r.reg(lambda g: g.__setitem__(KA, {"class": "none", "owner": "python"}))
        r.write("lib/one.py", ONE + "    q = LIMIT_Q\n")
        r.write("test/limit-sites-baseline.txt", "".join(h + "\n" for h in sorted(L.short(k) for k in (KA, KB, KK, KC, KG))))
        ok(S.verify() == [], "the rebuild from M ignores the working tree (its registry, a file, its baseline): %s" % S.verify())
        text = r.read("test/limit-sweep/manifest.json")
        r.git("add", "-A")
        r.git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "N")
        ok(S.build_manifest("HEAD", S.rules_bytes()) != text, "built from another revision, the manifest differs")
        # removing, moving or duplicating an item fails, naming its key
        doc = json.loads(text)
        for what, edit, words in [
            ("removed", lambda its: [it for it in its if it[0] != KB], ["missing"]),
            ("moved", lambda its: [[k, kind, "B2" if k == KB else b, s] for k, kind, b, s in its], ["the manifest has"]),
            ("duplicated", lambda its: its + [it for it in its if it[0] == KB], ["twice"]),
        ]:
            r.write("test/limit-sweep/manifest.json", json.dumps(dict(doc, items=edit(doc["items"]))))
            errs = S.verify()
            ok(names(errs, KB, *words), "a manifest item %s: verify names it: %s" % (what, errs))
        # a builder that leaves an item out (both its manifest and its rebuild): the independent coverage check names it
        real = S.build_manifest
        try:
            S.build_manifest = lambda rev, rb: "\n".join(l for l in real(rev, rb).split("\n") if "budget_e" not in l).replace("],\n ]", "]\n ]")
            r.write("test/limit-sweep/manifest.json", S.build_manifest(r.M, S.rules_bytes()))
            errs = S.verify()
            ok(names(errs, KE, "a disposition item at", "0 times"), "a builder that drops e: coverage names e: %s" % errs)
        finally:
            S.build_manifest = real
        r.write("test/limit-sweep/manifest.json", text)
        r.write("test/limit-sweep/rules.json", json.dumps(dict(RULES, target=4), indent=1) + "\n")
        ok(any("reviewed migration" in e for e in S.verify()), "rules.json changed: verify asks for a migration")
    finally:
        r.close()


def membership_cases():
    # astra2's a/b/k: a batch registers a and b but deletes k's entry, k's hash in the seed baseline: the count is unchanged, k is named
    r = Repo()
    try:
        ok(r.sweep() == [], "the fixture is clean at M: %s" % r.sweep())
        r.reg(lambda g: (g.__setitem__(KA, {"class": "1", "owner": "python"}), g.__setitem__(KB, {"class": "none", "owner": "python"}), g.pop(KK)))
        S.recount()
        c = L.check()
        ok(c["active_baseline"] == 3 and names(c["problems"]["sweep"], KK, "isn't one of the manifest's to register"),
           "a/b/k: k deregistered while a and b are registered (active 4 -> 3, as before k's loss counted): k is named: %s" % c["problems"]["sweep"])
    finally:
        r.close()
    # deleting an old registered baseline entry alone: named, and the count no longer matches
    r = Repo()
    try:
        r.reg(lambda g: g.pop(KK))
        errs = r.sweep()
        ok(names(errs, KK, "isn't one of the manifest's") and any("active_baseline is 4, the tree's 5" in e for e in errs),
           "an old registered baseline entry deleted: named, and the count differs: %s" % errs)
    finally:
        r.close()
    # a seed-baseline line absent at M reappearing
    r = Repo()
    try:
        r.write("lib/two.py", TWO + "    ghost = limit_ghost\n")
        S.recount()
        errs = r.sweep()
        ok(names(errs, KG, "isn't one of the manifest's"), "a seed line absent at M reappears: named: %s" % errs)
    finally:
        r.close()
    # a key reactivating in a done batch while another batch lowers the count
    r = Repo()
    try:
        ok(S.apply(r.worksheet("B1", [reg_row(KA, "1", disposition={"1": "shared"}), reg_row(KB, "coverage")])) == [], "B1 applies")
        st = json.loads(r.read("test/limit-sweep/batches.json"))
        ok(st["done"] == ["B1"] and st["active_baseline"] == 2, "B1 is done, the count 2: %s" % st)
        r.reg(lambda g: g.pop(KA))
        ok(S.apply(r.worksheet("B2", [reg_row(KC, "none")])) == [], "B2's c applies (the count goes down)")
        errs = r.sweep()
        ok(names(errs, KA, "B1, which is done"), "a done batch's key reactivated while B2 lowered the count: named: %s" % errs)
    finally:
        r.close()
    # two concurrent, independent registrations on two branches, merged either way round: both kept, the
    # count the merged tree's, the same files; a no-op merge keeps a real count; a conflict writes nothing
    results = []
    for into, other in (("b1", "b2"), ("b2", "b1")):
        r = Repo()
        try:
            commit = lambda m: (r.git("add", "-A"), r.git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", m))
            commit("B0")
            r.git("branch", "b2")
            r.git("checkout", "-q", "-b", "b1")
            ok(S.apply(r.worksheet("B1", [reg_row(KA, "coverage"), reg_row(KB, "coverage")])) == [], "branch 1: B1")
            os.remove(r.path("ws-B1.json"))
            commit("B1")
            r.git("checkout", "-q", "b2")
            ok(S.apply(r.worksheet("B2", [reg_row(KC, "none"), reg_row(KD, "none"),
                                          {"key": KE, "kind": "disposition", "disposition": {"2": {"route": "memguard"}}}])) == [], "branch 2: B2")
            os.remove(r.path("ws-B2.json"))
            commit("B2")
            r.git("checkout", "-q", into)
            # (git's own text merge of the files, conflicted or not, then the sweep's)
            subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", "merge", "-q", "--no-commit", other], cwd=r.root, capture_output=True)
            errs = S.merge(other)
            c = L.check()
            st = json.loads(r.read("test/limit-sweep/batches.json"))
            ok(errs == [] and all(k in r.reg() for k in (KA, KB, KC, KD)) and c["active_baseline"] == 0 and c["problems"]["sweep"] == [] and st["done"] == ["B1", "B2"] and st["active_baseline"] == 0,
               "concurrent registrations merged into %s: all kept, both done, the count recounted (0): %s %s" % (into, errs, c["problems"]))
            results.append((r.read("test/limit-sites.json"), r.read("test/limit-sweep/batches.json"), r.read("test/limit-sweep/followups.json")))
            commit("merged")
            before = (r.read("test/limit-sites.json"), r.read("test/limit-sweep/batches.json"))
            ok(S.merge("HEAD") == [] and (r.read("test/limit-sites.json"), r.read("test/limit-sweep/batches.json")) == before and json.loads(before[1])["active_baseline"] == 0,
               "a no-op merge (of HEAD itself) changes nothing and keeps a real count")
            if into == "b1":
                # a conflict: the same key classified differently on two branches: refused, nothing written
                r.git("checkout", "-q", "-b", "x1", "b2")
                r.reg(lambda g: g.__setitem__(KC, dict(g[KC], reason="one")))
                commit("x1")
                r.git("checkout", "-q", "-b", "x2", "b2")
                r.reg(lambda g: g.__setitem__(KC, dict(g[KC], reason="two")))
                commit("x2")
                before = (r.read("test/limit-sites.json"), r.read("test/limit-sweep/batches.json"), r.read("test/limit-sweep/followups.json"))
                errs = S.merge("x1")
                ok(names(errs, KC, "changed differently") and (r.read("test/limit-sites.json"), r.read("test/limit-sweep/batches.json"), r.read("test/limit-sweep/followups.json")) == before,
                   "a conflicting merge is refused, naming the key, with nothing written: %s" % errs)
        finally:
            r.close()
    ok(len(results) == 2 and results[0] == results[1], "merged either way round, the three files are the same")


def write_cases():
    """apply's write is all or nothing (astra2, #181): a failure at any staging step or forward move leaves the
    old registry and batches whole with no stray file; a failed rollback keeps every saved old text and says so."""
    import errno

    def stray(r):
        return sorted(f for d, _, fs in os.walk(r.root) if ".git" not in d for f in fs if ".sweep-" in f)

    def attempt(r, fail):
        """apply B1 with `fail` = {name: set of call numbers to fail with ENOSPC}; (error, stray files)"""
        real = {"stage": S._stage, "move": os.replace, "back": S._put_back}
        n = {k: 0 for k in real}

        def wrap(name):
            def f(*a):
                n[name] += 1
                if n[name] in fail.get(name, ()) or "all" in fail.get(name, ()):
                    raise OSError(errno.ENOSPC, "No space left on device (injected, %s %d)" % (name, n[name]))
                return real[name](*a)
            return f
        S._stage, S.os.replace, S._put_back = wrap("stage"), wrap("move"), wrap("back")
        try:
            S.apply(r.worksheet("B1", [reg_row(KA, "coverage"), reg_row(KB, "coverage")]))
            err = None
        except OSError as e:
            err = e
        finally:
            S._stage, S.os.replace, S._put_back = real["stage"], real["move"], real["back"]
        return err

    def state(r):
        return r.read("test/limit-sites.json"), r.read("test/limit-sweep/batches.json")

    # a failure at each staging step (the registry's new and old texts, then batches.json's): nothing replaced, nothing left
    for k in (1, 2, 3, 4):
        r = Repo()
        try:
            before = state(r)
            os.remove(r.path("ws-B1.json")) if os.path.exists(r.path("ws-B1.json")) else None
            err = attempt(r, {"stage": {k}})
            ok(err is not None and state(r) == before and stray(r) == [], "a failure at staging step %d of 4: the old state whole, no stray file (%s, %s)" % (k, err, stray(r)))
        finally:
            r.close()
    # ENOSPC at forward move k, the rollback working: the old state whole, no stray file
    for k in (1, 2):
        r = Repo()
        try:
            before = state(r)
            err = attempt(r, {"move": {k}})
            ok(err is not None and not isinstance(err, S.WriteIncomplete) and state(r) == before and stray(r) == [],
               "ENOSPC at move %d of 2: rolled back, the old state whole, no stray file (%s, %s)" % (k, err, stray(r)))
        finally:
            r.close()
    # ENOSPC at forward move k AND at every rollback step: k = 1 has nothing to roll back; k = 2 can't put the
    # registry back, so its saved old text is kept, named, and never deleted
    for k in (1, 2):
        r = Repo()
        try:
            before = state(r)
            err = attempt(r, {"move": {k}, "back": {"all"}})
            if k == 1:
                ok(err is not None and not isinstance(err, S.WriteIncomplete) and state(r) == before and stray(r) == [],
                   "ENOSPC at move 1 and at any rollback: nothing was replaced, the old state whole (%s, %s)" % (err, stray(r)))
            else:
                kept = getattr(err, "kept", [])
                saved = r.path("test/limit-sites.json.sweep-old")
                ok(isinstance(err, S.WriteIncomplete) and kept == [(L.REGISTRY, L.REGISTRY + ".sweep-old")] and os.path.exists(saved)
                   and open(saved).read() == before[0] and r.read("test/limit-sweep/batches.json") == before[1] and stray(r) == ["limit-sites.json.sweep-old"],
                   "ENOSPC at move 2 and at the rollback: WriteIncomplete, the registry's old text kept and named, batches.json unchanged (%s, %s)" % (err, stray(r)))
        finally:
            r.close()


def partition_cases():
    rules = dict(RULES, target=400, tail=50)
    got = S.partition({"lib/large.py": [500, 500, 0], "lib/tail.py": [20, 0, 0]}, rules)
    ok(got == [("python", ["lib/large.py"], 500), ("python", ["lib/tail.py"], 20)],
       "an oversize single file keeps its own batch: a tail doesn't join it (astra2, #181): %s" % got)
    got = S.partition({"lib/a.py": [300, 300, 0], "lib/tail.py": [20, 0, 0]}, rules)
    ok(got == [("python", ["lib/a.py", "lib/tail.py"], 320)], "a tail under 50 still joins a batch under the target: %s" % got)
    got = S.partition({"lib/a.py": [300, 300, 0], "lib/b.py": [200, 0, 0], "lib/tail.py": [20, 0, 0]}, rules)
    ok(got == [("python", ["lib/a.py"], 300), ("python", ["lib/b.py", "lib/tail.py"], 220)], "files whole, cut at the target: %s" % got)


FU = {"id": "FU-B2-1", "status": "open", "what": "c's cutoff", "owner": "python"}


def followup_cases():
    def setup(r, keys, status="open", point=True, **kw):
        r.followups([dict(FU, keys=keys, status=status, **kw)])
        if point:
            r.reg(lambda g: g.__setitem__(KC, {"class": "3", "owner": "python", "batch": "B2", "disposition": {"3": {"followup": "FU-B2-1"}}}))
        S.recount()

    for what, keys, status, point, kw, want in [
        ("an open item with only historical keys", ["lib/two.py :: g :: c = budget_old #0"], "open", False, {}, ("FU-B2-1", "no active key")),
        ("an open item with no keys", [], "open", False, {}, ("FU-B2-1", "no active key")),
        ("an active key pointing to a fixed item", [KC], "fixed", True, {"fixed_by": {"pr": 9, "commit": "a" * 40}}, (KC, "which is fixed")),
        ("an active key pointing to an item that doesn't list it", [KD], "open", True, {}, (KC, "doesn't list it")),
    ]:
        r = Repo()
        try:
            if what.endswith("doesn't list it"):
                r.reg(lambda g: g.__setitem__(KD, {"class": "3", "owner": "python", "batch": "B2", "disposition": {"3": {"followup": "FU-B2-1"}}}))
            setup(r, keys, status, point, **kw)
            errs = r.sweep()
            ok(names(errs, *want), "%s fails, naming it: %s" % (what, errs))
        finally:
            r.close()
    # the last active key removed by an edit, with no migration or status change: fails; a migration, or a fix in the same change, passes
    r = Repo()
    try:
        setup(r, [KC])
        ok(r.sweep() == [], "an open item with its active key is clean: %s" % r.sweep())
        r.write("lib/two.py", TWO.replace("budget_c", "budget_c2"))
        r.reg(lambda g: g.pop(KC))
        new = "lib/two.py :: g :: c = budget_c2 #0"
        c = L.check()["problems"]
        ok(names(c["sweep"], "FU-B2-1", "no active key") and c["unregistered"] == [new],
           "the last active key edited away, unmigrated: the item is named (and the new line is unregistered): %s" % c)
        r.reg(lambda g: g.__setitem__(new, {"class": "3", "owner": "python", "disposition": {"3": {"followup": "FU-B2-1"}}}))
        r.followups([dict(FU, keys=[KC, new])])
        S.recount()
        ok(r.sweep() == [], "migrated (the new key registered and listed, the old kept as historical): clean: %s" % r.sweep())
        r.reg(lambda g: g.__setitem__(new, {"class": "none", "owner": "python", "reason": "the cutoff is gone"}))
        r.followups([dict(FU, keys=[KC, new], status="fixed", fixed_by={"pr": 12, "commit": "b" * 40})])
        ok(r.sweep() == [], "fixed in the same change (its key no longer points to it): clean: %s" % r.sweep())
        r.followups([dict(FU, keys=[KC], status="fixed", fixed_by={"pr": 12, "commit": "short"})])
        ok(names(r.sweep(), "FU-B2-1", "full sha"), "fixed needs the merge commit's full sha")
        r.followups([dict(FU, keys=[KC], status="withdrawn")])
        ok(names(r.sweep(), "FU-B2-1", "withdrawn_because"), "withdrawn needs its reason")
    finally:
        r.close()


def apply_cases():
    r = Repo()
    try:
        before = r.read("test/limit-sites.json"), r.read("test/limit-sweep/batches.json")
        cases = [
            ("a key not in the batch", "B1", [reg_row(KC, "none")], (KC, "isn't an item of B1")),
            ("a duplicated key", "B1", [reg_row(KA, "none"), reg_row(KA, "none")], (KA, "again")),
            ("two classifications of one key", "B1", [reg_row(KA, "none"), reg_row(KA, "coverage")], (KA, "classified differently")),
            ("a wrong owner", "B1", [reg_row(KA, "none", owner="magma")], (KA, "owner")),
            ("an unknown class", "B1", [reg_row(KA, "4")], (KA, "isn't one of")),
            ("a missing disposition", "B1", [reg_row(KA, "1+2")], (KA, "needs a disposition for 1 and 2")),
            ("an unknown route", "B1", [reg_row(KA, "2", disposition={"2": {"route": "nope"}})], (KA, "not a memory route")),
            ("an unknown _limits key", "B1", [reg_row(KA, "3", disposition={"3": {"limits": "ff.nope"}})], (KA, "not a key of lib/_limits.py")),
            ("an unknown follow-up id", "B1", [reg_row(KA, "3", disposition={"3": {"followup": "FU-B1-9"}})], (KA, "FU-B1-9")),
            ("a none refusal-signal site without a reason", "B1", [reg_row(KA, "none")], (KA, "needs a one-line reason")),
            ("one lawful component excusing no other", "B1", [reg_row(KA, "1+3", disposition={"1": "shared"})], (KA, "exactly the class's components")),
            ("an invalid last row", "B1", [reg_row(KA, "coverage"), reg_row(KB, "1+2", disposition={"1": "shared"})], (KB, "components")),
        ]
        for what, batch, rows, want in cases:
            errs = S.apply(r.worksheet(batch, rows))
            ok(names(errs, *want), "apply refuses %s, naming it: %s" % (what, errs))
            ok((r.read("test/limit-sites.json"), r.read("test/limit-sweep/batches.json")) == before, "apply refusing %s writes nothing" % what)
        # a wrong owner for the whole worksheet
        p = r.path("ws-owner.json")
        with open(p, "w") as f:
            json.dump({"batch": "B1", "owner": "sage", "rows": [reg_row(KA, "coverage")]}, f)
        ok(any("isn't B1's" in e for e in S.apply(p)), "apply refuses a worksheet with another batch's owner")
        # a key registered meanwhile (stale for the worksheet)
        r.reg(lambda g: g.__setitem__(KA, {"class": "coverage", "owner": "python"}))
        ok(names(S.apply(r.worksheet("B1", [reg_row(KA, "coverage")])), KA, "no longer an active baseline site"), "apply refuses an already registered key")
        r.reg(lambda g: g.pop(KA))
        # and a lawful one writes owner, batch and the disposition, marking the batch done
        ok(S.apply(r.worksheet("B1", [reg_row(KA, "1+2", disposition={"1": "shared", "2": {"route": "memguard"}}), reg_row(KB, "none", reason="a message, not a cap")])) == [], "a lawful B1 applies")
        g = r.reg()
        ok(g[KA] == {"class": "1+2", "owner": "python", "batch": "B1", "disposition": {"1": "shared", "2": {"route": "memguard"}}}
           and g[KB]["reason"] == "a message, not a cap", "apply writes class, owner, batch, disposition and reason: %s" % g.get(KA))
        ok(json.loads(r.read("test/limit-sweep/batches.json")) == {"v": 1, "done": ["B1"], "active_baseline": 2}, "B1 done, the count 2")
        # a partial worksheet applies its rows and leaves the batch open
        ok(S.apply(r.worksheet("B2", [reg_row(KC, "3", disposition={"3": {"limits": "ff.work"}}), reg_row(KD, "")])) == [] and json.loads(r.read("test/limit-sweep/batches.json"))["done"] == ["B1"]
           and r.reg()[KC]["disposition"] == {"3": {"limits": "ff.work"}},
           "a partial worksheet: its rows applied (a _limits key read from lib/_limits.py's TABLE), the batch not done")
        # a disposition-only entry left without one in a done batch is named
        ok(S.apply(r.worksheet("B2", [reg_row(KD, "none"), {"key": KE, "kind": "disposition", "disposition": {"2": {"route": "memguard"}}}])) == [], "B2 completes")
        r.reg(lambda g: g[KE].pop("disposition"))
        ok(names(r.sweep(), KE, "needs a disposition for 2"), "a done batch's entry losing its disposition is named")
        r.reg(lambda g: g[KE].pop("batch"))
        ok(names(r.sweep(), KE, "needs a disposition for 2"), "...and losing its batch too: still named, as the done batch's item")
        out, n = S.worksheet("B2", r.path("w.json"))
        rows = json.load(open(out))["rows"]
        ok(n == 3 and {x["key"] for x in rows} == {KC, KD, KE} and all(x["line"] for x in rows), "worksheet B2 lists its three items with their lines")
    finally:
        r.close()


def after_m_cases():
    # an entry registered after M is no batch's item: its disposition is needed at once (daybreak2, #181)
    import contextlib
    import io
    r = Repo()
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            new = "lib/one.py :: f :: n2 = LIMIT_NEW #0"
            r.write("lib/one.py", ONE + "    n2 = LIMIT_NEW\n")
            ok(L.main(["--register", "2", "python", "--key", new]) == 0, "--register a new class-2 site without a disposition writes it")
            ok(names(r.sweep(), new, "needs a disposition for 2"), "a class-2 entry registered after M without its disposition is named: %s" % r.sweep())
            ok(L.main(["--register", "2", "python", "--key", new, "--disposition", '{"2": {"route": "memguard"}}']) == 0 and r.sweep() == [],
               "...and registered with its disposition (--disposition): clean: %s" % r.sweep())
            ok(r.reg()[new] == {"class": "2", "owner": "python", "disposition": {"2": {"route": "memguard"}}}, "--register writes the disposition: %s" % r.reg()[new])
            ok(L.main(["--register", "none", "python", "--key", new, "--reason", "a name"]) == 0 and r.reg()[new] == {"class": "none", "owner": "python", "reason": "a name"} and r.sweep() == [],
               "--reason is written; a none entry after M needs no disposition")
            ok(L.main(["--register", "2", "python", "--key", new, "--disposition", "{"]) == 2, "--disposition must be JSON")
    finally:
        r.close()


def route_cases():
    r = Repo()
    try:
        for what, rows, want in [
            ("a memory route naming no function", [{"id": "memguard", "kind": "memory", "where": "lib/_memguard.py::nope"}], "names no function"),
            ("a route in a file that doesn't exist", [{"id": "memguard", "kind": "memory", "where": "lib/nope.py::memory_guard"}], "names no function"),
            ("a host route without its unarmed default", [{"id": "memguard", "kind": "memory", "where": "lib/_memguard.py::memory_guard"}, {"id": "grading", "kind": "host", "where": "lib/_memguard.py::memory_guard"}], "default-unarmed"),
            ("a repeated id", [{"id": "memguard", "kind": "memory", "where": "lib/_memguard.py::memory_guard"}] * 2, "repeated"),
            ("an unknown kind", [{"id": "memguard", "kind": "cpu", "where": "lib/_memguard.py::memory_guard"}], "kind must be"),
        ]:
            r.write("test/limit-sweep/routes.json", json.dumps({"v": 1, "routes": rows}))
            errs = r.sweep()
            ok(any(want in e for e in errs), "routes.json: %s is named: %s" % (what, errs))
        r.write("test/limit-sweep/routes.json", json.dumps({"v": 1, "routes": [{"id": "memguard", "kind": "memory", "where": "lib/_memguard.py::memory_guard"},
                                                                              {"id": "grading", "kind": "host", "where": "lib/_memguard.py::memory_guard", "default": "lib/_memguard.py::memory_guard"}]}))
        ok(r.sweep() == [], "lawful memory and host routes resolve: %s" % r.sweep())
    finally:
        r.close()


def merge_cases():
    e = lambda c: {"class": c, "owner": "python"}
    base = {"x": e("none"), "y": e("1"), "z": e("2"), "w": e("3")}
    got, c = S.merge3(base, dict(base, a=e("none"), y=dict(e("1"), note="kept")), {k: v for k, v in dict(base, b=e("none")).items() if k != "z"})
    ok(c == [] and got == {"x": e("none"), "y": dict(e("1"), note="kept"), "w": e("3"), "a": e("none"), "b": e("none")},
       "merge: independent additions, a one-sided edit (its metadata kept) and a one-sided delete: %s %s" % (got, c))
    got, c = S.merge3(base, dict(base, y=e("2")), dict(base, y=e("2")))
    ok(c == [] and got["y"] == e("2"), "merge: an equal change on both sides")
    for what, o, t, word in [
        ("a delete against a modify", {k: v for k, v in base.items() if k != "y"}, dict(base, y=e("2")), "deleted on one side"),
        ("two different additions", dict(base, n=e("1")), dict(base, n=e("2")), "added differently"),
        ("two different edits", dict(base, y=e("2")), dict(base, y=e("3")), "changed differently"),
    ]:
        got, c = S.merge3(base, o, t)
        ok(len(c) == 1 and word in c[0] and (c[0].startswith("y:") or c[0].startswith("n:")), "merge: %s is a conflict naming the key: %s" % (what, c))


for case in (manifest_cases, membership_cases, followup_cases, apply_cases, after_m_cases, route_cases, merge_cases, write_cases, partition_cases):
    try:
        case()
    except Exception as exc:  # (a case that crashes is a failure, named)
        import traceback
        failures.append("%s crashed: %s" % (case.__name__, traceback.format_exc()))
if failures:
    print("\n".join("FAIL " + f for f in failures))
    print("%d of %d checks failed" % (len(failures), checks))
    sys.exit(1)
print("ok: the sweep's tooling, %d checks" % checks)
