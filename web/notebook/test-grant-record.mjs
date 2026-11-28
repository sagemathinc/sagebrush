// ci: web-runner order=117 runner=bun
// The scoped grant record (web/notebook/permissions.js), in Bun with a localStorage stand-in:
//   - read whole (Codex S14 F2): an entry whose collections aren't arrays of canonical scopes (a string where an array
//     goes, a scope not in its canonical form, null, too many, a malformed denial) grants nothing, while the entries beside
//     it, and an ordinary narrow grant, stay as they were;
//   - "Don't allow file changes" (S14 F4) takes away every write grant, "/" and each folder, stored and once, as its
//     words say, and keeps a denial of "/".
//   bun web/notebook/test-grant-record.mjs
let failures = 0;
const ok = (c, msg, detail) => { console.log((c ? "ok   " : "FAIL ") + msg + (detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 300) : "")); if (!c) failures++; };
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, String(v)), removeItem: (k) => void store.delete(k) };
const { createPermissions, validGrantEntry, GRANT_CAPS } = await import("./permissions.js");
const GRANTS = "sagebrush-grants";
const put = (docs) => { store.clear(); store.set(GRANTS, JSON.stringify({ v: 1, seq: 50, migrated: 1, docs })); };
const J = JSON.stringify;

// ---- F2: malformed entries grant nothing; the ones beside them, and narrow grants, stay
{
  const bad = {
    str: { write: "/", t: 1 },                       // a string: includes("/") would say anywhere
    strFolder: { write: "/home", t: 1 },             // a string whose characters spread into "/", "h", ...
    obj: { write: { 0: "/", length: 1 }, t: 1 },     // array-like, not an array
    notCanon: { write: ["/a/../.."], t: 1 },
    trailing: { write: ["/a/"], t: 1 },
    nonString: { write: [1], t: 1 },
    nullScope: { write: ["/a", null], t: 1 },                  // (canonicalScope(null) is null, so === alone passes it)
    nullDenialScope: { write: ["/a"], denied: [["write", null, 3]], t: 1 },
    tooMany: { write: Array.from({ length: GRANT_CAPS.perKind + 1 }, (_, i) => `/f${i}`), t: 1 },
    badDenial: { write: ["/a"], denied: ["write"], t: 1 },
    badDenialScope: { write: ["/a"], denied: [["write", "a", 3]], t: 1 },
    badT: { write: ["/a"], t: "now" },
    notObject: "write /",
  };
  put({ ...bad, good: { write: ["/proj"], denied: [["write", "/secret", 4]], t: 2 } });
  const p = createPermissions();
  for (const d of Object.keys(bad)) p.provenance(d, "elsewhere");
  p.provenance("good", "elsewhere");
  const wrong = Object.keys(bad).filter((d) => p.may(d, "files") || J(p.writeTrees(d)) !== "[]");
  ok(wrong.length === 0, `each malformed entry (${Object.keys(bad).length} kinds) grants nothing: not anywhere, no folder`, wrong.map((d) => [d, p.may(d, "files"), p.writeTrees(d)]));
  ok(Object.keys(bad).every((d) => J(p.grants(d).write.stored) === "[]"), "…and lists no grant");
  ok(J(p.writeTrees("good")) === '["/proj"]' && !p.may("good", "files") && p.deniedWrite("good", "/secret/x"), "an ordinary narrow grant beside them stays narrow, its denial kept");
  ok(Object.keys(bad).every((d) => !validGrantEntry(bad[d])) && validGrantEntry({ write: ["/proj"], denied: [["write", "/secret", 4]], t: 2 }) && validGrantEntry({}), "validGrantEntry: each malformed one refused, a well-formed one (and an empty one) accepted");
  // (a grant made now keeps the good entry, and leaves out the malformed ones: nothing widened by writing)
  ok(p.grant("good", "write", "/proj2").ok && J(p.writeTrees("good")) === '["/proj","/proj2"]', "a grant made now adds to the good entry");
  const after = JSON.parse(store.get(GRANTS));
  ok(Object.keys(after.docs).every((d) => d === "good") && after.docs.good.denied.length === 1, "…and the record written keeps it (its denial too) and none of the malformed entries", Object.keys(after.docs));
  // (a malformed counter doesn't concatenate)
  store.set(GRANTS, JSON.stringify({ v: 1, seq: "9", migrated: 1, docs: { good: { write: ["/a"], t: 1 } } }));
  ok(createPermissions().grant("good", "write", "/b").ok && Number.isSafeInteger(JSON.parse(store.get(GRANTS)).seq), "a counter that isn't an integer is started again, not concatenated");
}
// ---- F4: "Don't allow file changes" takes away every write grant, stored and once, folders included
{
  put({});
  const p = createPermissions();
  p.provenance("nb", "elsewhere");
  ok(p.grant("nb", "write", "/").ok && p.grant("nb", "write", "/data").ok && p.grant("nb", "write", "/out", { once: true }).ok, "granted: anywhere, a folder, and a folder once");
  ok(p.may("nb", "files") && J(p.writeTrees("nb")) === '["/"]', "…it may change files");
  ok(p.set("nb", "files", false) === true, "Don't allow file changes: kept");
  ok(!p.may("nb", "files") && J(p.writeTrees("nb")) === "[]", "…no file may be changed now: no folder left either", p.writeTrees("nb"));
  const g = p.grants("nb").write;
  ok(J(g.stored) === "[]" && J(g.once) === "[]", "…every write grant gone, stored and once", g);
  const rec = JSON.parse(store.get(GRANTS)).docs.nb;
  ok(J(rec.write) === "[]" && rec.denied.some((x) => x[0] === "write" && x[1] === "/"), "…and the record keeps a denial of \"/\"", rec);
  ok(J(createPermissions().writeTrees("nb")) === "[]", "…as a page opened later reads it");
  // (allowed again later: anywhere, as before)
  ok(p.set("nb", "files", true) === true && p.may("nb", "files"), "Allow file changes again: anywhere");
}
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
