// ci: web-runner order=160 runner=bun
// A paired agent's checks (agent-schema.ts, agent-grant.ts), without a page: every verb against its schema, and
// the grant's scoping, which is the only guard on what an agent may touch (the server treats a grant as opaque).
//   bun web/workspace/test-agent-grant.mjs
import { checkCall, check, badValue, schemaProblem, SCHEMA_PROBLEM, AGENT_VERBS } from "./agent-schema.ts";
import { authorize, grantFolders, inGrant, norm } from "./agent-grant.ts";
import { BRANCH_LIMITS, BRANCH_TEXT, branchRefusal, hashPages, jsonBytes } from "./branch-rules.ts";

let failures = 0;
const ok = (c, msg) => { console.log((c ? "ok   " : "FAIL ") + msg); if (!c) failures++; };
const refused = (r) => typeof r === "string" && r.length > 0;

// ---- the schema
const good = {
  "workspace.list": { folder: "/A", recursive: true },
  "workspace.stat": { path: "/A/x.txt" },
  "workspace.read": { path: "/A/x.txt" },
  "workspace.write": { path: "/A/x.txt", content: { text: "hi" }, base: 3 },
  "workspace.create": { path: "/A/n.ipynb", content: { json: { cells: [] } }, mode: "python" },
  "workspace.mkdir": { path: "/A/b" },
  "workspace.rename": { from: "/A/x.txt", to: "/A/y.txt" },
  "workspace.duplicate": { path: "/A/x.txt" },
  "workspace.remove": { path: "/A/x.txt" },
  "workspace.restore": { path: "/Trash/x.txt" },
  "workspace.history": { path: "/A/x.txt" },
  "workspace.version": { path: "/A/x.txt", index: 0 },
  "workspace.git_branch": { name: "fix-plots-2" },
};
ok(AGENT_VERBS.size === 13 && Object.keys(good).every((v) => AGENT_VERBS.has(v)), "the schema's 13 verbs");
for (const [v, p] of Object.entries(good)) ok(checkCall(v, p) === null, `${v}: good params pass (${checkCall(v, p) ?? "ok"})`);
const bad = [
  ["workspace.drop", { path: "/A" }, "an unknown verb"],
  ["workspace.ops", {}, "a forAgent method that isn't a verb on the wire (ops)"],
  ["workspace.watch", {}, "nor watch"],
  ["toString", {}, "an object's own property name"],
  ["workspace.read", {}, "a missing required parameter"],
  ["workspace.read", { path: "/A", extra: 1 }, "an extra parameter"],
  ["workspace.read", { path: 5 }, "a path that isn't a string"],
  ["workspace.read", { path: "A/x" }, "a relative path"],
  ["workspace.read", { path: "" }, "an empty path"],
  ["workspace.read", { path: "/" + "a".repeat(1024) }, "a path over 1024 characters"],
  ["workspace.read", { path: "/A/\u0000x" }, "a NUL"],
  ["workspace.read", { path: "/A/\ud800x" }, "a lone surrogate"],
  ["workspace.list", { folder: "/A", recursive: "yes" }, "a boolean that isn't"],
  ["workspace.version", { path: "/A/x", index: -1 }, "an index below 0"],
  ["workspace.version", { path: "/A/x", index: 1.5 }, "an index that isn't an integer"],
  ["workspace.version", { path: "/A/x", index: NaN }, "NaN"],
  ["workspace.version", { path: "/A/x", index: Infinity }, "Infinity"],
  ["workspace.create", { path: "/A/n.ipynb", mode: "cobol" }, "a mode not in the enum"],
  ["workspace.write", { path: "/A/x", content: { text: "a", base64: "YQ==" } }, "content in two forms at once"],
  ["workspace.write", { path: "/A/x", content: {} }, "content in no form"],
  ["workspace.write", { path: "/A/x", content: { base64: "not base64!" } }, "base64 that isn't"],
  ["workspace.write", { path: "/A/x", content: { json: [1] } }, "json that isn't an object"],
  ["workspace.read", null, "params that aren't an object"],
  ["workspace.read", [], "params that are a list"],
  ["workspace.git_branch", {}, "git_branch without a name"],
  ["workspace.git_branch", { name: "Fix" }, "a branch name with a capital"],
  ["workspace.git_branch", { name: "-fix" }, "a branch name starting with -"],
  ["workspace.git_branch", { name: "a".repeat(41) }, "a branch name of 41"],
  ["workspace.git_branch", { name: "a/b" }, "a branch name with a /"],
  ["workspace.git_branch", { name: "x", to: "/A" }, "git_branch with another parameter"],
];
ok(checkCall("workspace.git_branch", { name: "a".repeat(40) }) === null && checkCall("workspace.git_branch", { name: "0" }) === null, "branch names of 1 and 40 pass");
for (const [v, p, what] of bad) ok(refused(checkCall(v, p)), `refused: ${what} (${checkCall(v, p)})`);
let threw = false;
try { check({ type: "string", format: "email" }, "x"); } catch { threw = true; }
ok(threw, "a schema with a keyword the checker doesn't know fails closed");
threw = false;
try { check({ type: "object", additionalProperties: { type: "string" } }, {}); } catch { threw = true; }
ok(threw, "additionalProperties other than false fails closed");
ok(badValue({ a: { b: ["x", { "\u0000k": 1 }] } }) !== null, "a NUL in a key, deep, is found");
// (the schema as a whole: an unknown keyword anywhere in it, even where no request goes, refuses it)
ok(SCHEMA_PROBLEM === null, "schema.json's own schema passes the whole-schema check");
ok(schemaProblem({ type: "object", properties: { optional: { type: "string", format: "email" } }, additionalProperties: false }) !== null, "an unknown keyword under an optional property no request sends is found");
ok(check({ type: "object", properties: { optional: { type: "string", format: "email" } }, additionalProperties: false }, {}) === null, "(that request alone would pass the per-request check: hence the whole-schema one)");
ok(schemaProblem({ oneOf: [{ type: "string" }, { type: "object", properties: { x: { type: "string", if: {} } } }] }) !== null, "an unknown keyword in an unused oneOf alternative is found");
{
  const wrong = [
    { maxLength: "1" }, { pattern: 12 }, { minLength: -1 }, { minLength: 1.5 }, { maxLength: Infinity }, { minLength: 3, maxLength: 2 },
    { minimum: "0" }, { enum: [] }, { enum: [{}] }, { enum: "a" }, { required: ["a", "a"] }, { required: "a" }, { type: ["string"] },
    { description: 1 }, { $schema: {} }, { properties: [] }, { oneOf: {} },
  ];
  for (const w of wrong) {
    const nested = { type: "object", properties: { deep: { oneOf: [{ type: "string" }, { type: "string", ...w }] } }, additionalProperties: false };
    ok(schemaProblem(w) !== null && schemaProblem(nested) !== null, `a known keyword with a wrong value is found, alone and nested in an unused alternative: ${JSON.stringify(w)}`);
  }
  let threw = 0;
  for (const w of [{ type: "string", maxLength: "1" }, { type: "string", pattern: 12 }]) { try { check(w, "anything long"); } catch { threw++; } }
  ok(threw === 2, "check() itself refuses (throws on) maxLength \"1\" and pattern 12 rather than ignoring them");
}
ok(schemaProblem({ type: "number" }) !== null && schemaProblem({ type: "object", additionalProperties: true }) !== null && schemaProblem({ oneOf: [] }) !== null && schemaProblem({ pattern: "(" }) !== null, "a type, additionalProperties, empty oneOf or bad pattern it can't keep is found");
ok(badValue(new Date()) !== null && badValue(Object.create({ x: 1 })) !== null, "an object that isn't plain is refused");

// ---- the grant
const now = 1_000_000;
const G = (folders, write = true, expires = null) => ({ agent: "Claude Code", client: "claude-code", folders: grantFolders(folders), write, run: false, expires, created: 0, lastUsed: 0 });
const trash = new Map([["/Trash/x.txt", { path: "/Trash/x.txt", trashed: { from: "/A/x.txt", at: 1, id: "t1" } }], ["/Trash/y.txt", { path: "/Trash/y.txt", trashed: { from: "/B/y.txt", at: 1, id: "t2" } }]]);
const from = async (p) => trash.get(p) ?? null;
const az = (m, p, g = G(["/A"])) => authorize(m, p, g, now, from);
const allow = async (m, p, g, what) => { const r = await az(m, p, g); ok(r === null, `allowed: ${what}${r ? " (" + r + ")" : ""}`); };
const deny = async (m, p, g, what) => { const r = await az(m, p, g); ok(refused(r), `refused: ${what} (${r})`); };

await allow("workspace.read", { path: "/A/x.txt" }, undefined, "a read inside the granted folder");
await allow("workspace.read", { path: "/A" }, undefined, "the granted folder itself");
await allow("workspace.write", { path: "/A/b/c/x.txt", content: { text: "" } }, undefined, "a write deep inside");
await deny("workspace.read", { path: "/B/x.txt" }, undefined, "a read in another folder");
await deny("workspace.read", { path: "/AB/x.txt" }, undefined, "/AB is not inside /A");
await deny("workspace.read", { path: "/A/../B/x.txt" }, undefined, "a .. out of the folder (normPath refuses it)");
await deny("workspace.read", { path: "/A/./x.txt" }, undefined, "a . in a path");
await deny("workspace.read", { path: "//A/x.txt" }, undefined, "an empty name");
await deny("workspace.read", { path: "/" }, undefined, "the root");
await deny("workspace.list", { folder: "/" }, undefined, "listing the root (it would name other folders)");
await allow("workspace.list", { folder: "/A", recursive: true }, undefined, "listing the granted folder");
await deny("workspace.list", { folder: "/Trash" }, undefined, "listing Trash (it holds every folder's removed entries)");
await deny("workspace.read", { path: "/Trash/x.txt" }, undefined, "reading in Trash");
await allow("workspace.rename", { from: "/A/x.txt", to: "/A/sub/x.txt" }, undefined, "a rename within the folder");
await deny("workspace.rename", { from: "/A/x.txt", to: "/B/x.txt" }, undefined, "a rename out of the folder");
await deny("workspace.rename", { from: "/B/x.txt", to: "/A/x.txt" }, undefined, "a rename into the folder from outside");
await deny("workspace.rename", { from: "/A", to: "/A2" }, G(["/A", "/A2"]), "moving a granted folder itself");
await deny("workspace.remove", { path: "/A" }, undefined, "removing a granted folder itself");
await allow("workspace.remove", { path: "/A/x.txt" }, undefined, "removing inside (to Trash)");
await allow("workspace.duplicate", { path: "/A/x.txt" }, undefined, "a duplicate beside it, inside");
await deny("workspace.duplicate", { path: "/A/x.txt", to: "/B/x.txt" }, undefined, "a duplicate to outside");
await deny("workspace.duplicate", { path: "/B/x.txt", to: "/A/x.txt" }, undefined, "a duplicate from outside");
await allow("workspace.restore", { path: "/Trash/x.txt" }, undefined, "restoring what came from the folder");
{
  const outArg = {};
  await authorize("workspace.restore", { path: "/Trash/x.txt" }, G(["/A"]), now, from, outArg);
  ok(outArg.expect === trash.get("/Trash/x.txt"), "restore's authorization hands back the very entry it authorized (for Workspace.restore's expect)");
}
await deny("workspace.restore", { path: "/Trash/y.txt" }, undefined, "restoring what came from another folder");
await deny("workspace.restore", { path: "/Trash/none" }, undefined, "restoring nothing");
trash.set("/Trash/A", { path: "/Trash/A", trashed: { from: "/A", at: 1, id: "t3" } });
await deny("workspace.restore", { path: "/Trash/A" }, undefined, "restoring a granted folder itself: it would go back into / (as \"/A (2)\" if /A is taken), outside the grant");
await allow("workspace.restore", { path: "/Trash/A" }, G(["/"]), "the same with everything granted");
await deny("workspace.restore", { path: "/A/x.txt" }, undefined, "restore of a path that isn't in Trash");
await deny("workspace.mkdir", { path: "/B" }, undefined, "a folder made outside");
await deny("workspace.create", { path: "/new.ipynb" }, undefined, "a document made at the top");
const ro = G(["/A"], false);
await allow("workspace.read", { path: "/A/x.txt" }, ro, "read only: a read");
for (const [m, p] of [["workspace.write", { path: "/A/x.txt", content: { text: "" } }], ["workspace.create", { path: "/A/n.txt" }], ["workspace.mkdir", { path: "/A/d" }], ["workspace.rename", { from: "/A/x", to: "/A/y" }], ["workspace.duplicate", { path: "/A/x" }], ["workspace.remove", { path: "/A/x" }], ["workspace.restore", { path: "/Trash/x.txt" }]])
  await deny(m, p, ro, `read only: ${m}`);
await deny("workspace.read", { path: "/A/x.txt" }, G(["/A"], true, now), "an expired grant (expires == now)");
await allow("workspace.read", { path: "/A/x.txt" }, G(["/A"], true, now + 1), "a grant before its expiry");
ok(refused(await authorize("workspace.read", { path: "/A/x" }, null, now, from)), "no grant: nothing");
await allow("workspace.list", { folder: "/Trash" }, G(["/"]), "everything granted: Trash may be listed");
let t2 = false;
try { grantFolders(["/Trash"]); } catch { t2 = true; }
ok(t2, "Trash can't be granted on its own");
t2 = false;
try { grantFolders([]); } catch { t2 = true; }
ok(t2, "a grant names at least one folder");
ok(grantFolders(["/A/", "/A/b", "/A", "/C"]).join() === "/A,/C", "folders normalized, duplicates and nested ones dropped");
ok(!inGrant(norm("/A\u0001"), ["/A"]) && norm("/A\u0001") === null, "a control character makes no path");
ok(refused(await az("workspace.drop", { path: "/A/x" })), "an unknown verb is refused by the grant too");

// ---- git_branch's grant (chat plan PR 3: Q2, no implicit widening) and the branches' ownership rule (P3-2)
ok((await az("workspace.git_branch", { name: "fix" }, G(["/"]))) === null, "git_branch with everything granted");
ok((await az("workspace.git_branch", { name: "fix" }, G(["/A", "/Branches"]))) === null, "git_branch with /Branches among the folders");
ok((await az("workspace.git_branch", { name: "fix" }, G(["/Branches/fix"]))) === null, "git_branch with /Branches/<name> itself granted");
ok((await az("workspace.git_branch", { name: "fix" }, G(["/A"]))) === BRANCH_TEXT.notInGrant, "git_branch without /Branches: refused, said as cleared");
ok((await az("workspace.git_branch", { name: "fix" }, G(["/Branches/other"]))) === BRANCH_TEXT.notInGrant, "git_branch with another branch's folder only: refused");
ok((await az("workspace.git_branch", { name: "fix" }, G(["/"], false))) === BRANCH_TEXT.readOnly, "git_branch read only: refused with its own text");
ok((await az("workspace.git_branch", { name: "fix" }, G(["/"], true, now))) !== null, "git_branch on an expired grant: refused");
{
  const rec = (status, owner = "me", name = "fix") => ({ name, owner, status, entries: 1, bytes: 1, made: 0 });
  const root = { path: "/Branches/fix", kind: "folder", fid: "f1" };
  const at = (op, role, path, o = {}) => ({ op, role, path, entry: "entry" in o ? o.entry : {}, chain: [], ...("branch" in o ? { branch: o.branch } : { branch: { root, record: rec("ready") } }) });
  const T = BRANCH_TEXT;
  const rows = [
    [at("write", "target", "/A/x.txt", { branch: undefined }), "me", null, "outside /Branches: the grant decides"],
    [at("write", "target", "/Branches/fix/x.txt"), "me", null, "its own ready branch: a write inside"],
    [at("create", "target", "/Branches/fix/d/n.ipynb", { entry: undefined }), "me", null, "a create deep inside its own"],
    [at("rename", "destination", "/Branches/fix/y.txt", { entry: undefined }), "me", null, "a rename into its own"],
    [at("write", "target", "/Branches/fix/x.txt"), "other", T.otherConnection, "another grant's branch: a write"],
    [at("remove", "target", "/Branches/fix/x.txt"), "other", T.otherConnection, "another grant's branch: a remove"],
    [at("restore", "destination", "/Branches/fix/x.txt", { entry: undefined }), "other", T.otherConnection, "a restore into another grant's branch"],
    [at("duplicate", "destination", "/Branches/fix/x (2).txt", { entry: undefined }), "other", T.otherConnection, "a duplicate (its computed destination) into another's"],
    [at("duplicate", "source", "/Branches/fix/x.txt"), "other", null, "a duplicate out of another's branch (a read, Q4)"],
    [at("write", "target", "/Branches/fix/x.txt"), null, T.otherConnection, "no grant id (legacy): owns nothing"],
    [at("write", "target", "/Branches/fix/x.txt", { branch: { root, record: rec("making") } }), "me", T.unfinished, "a making branch: refused to its maker"],
    [at("write", "target", "/Branches/fix/x.txt", { branch: { root, record: rec("failed") } }), "me", T.unfinished, "a failed branch: refused to its maker"],
    [at("remove", "target", "/Branches/fix", { branch: { root, record: rec("failed") } }), "me", T.unfinished, "a failed branch's folder: not removed by its maker"],
    [at("write", "target", "/Branches/fix/x.txt", { branch: { root } }), "me", T.notYours, "no record: never adopted"],
    [at("write", "target", "/Branches/fix/x.txt", { branch: { root, record: rec("ready", "me", "old") } }), "me", T.notYours, "a record of another name (renamed within /Branches)"],
    [at("write", "target", "/Branches/gone/x.txt", { entry: undefined, branch: {} }), "me", T.onlyGitBranch, "a path whose /Branches/<x> isn't there (it would be made)"],
    [at("mkdir", "target", "/Branches/new", { entry: undefined, branch: {} }), "me", T.onlyGitBranch, "mkdir /Branches/<x>"],
    [at("create", "target", "/Branches/n.txt", { entry: undefined, branch: {} }), "me", T.onlyGitBranch, "a file made directly in /Branches"],
    [at("rename", "destination", "/Branches/new", { entry: undefined, branch: {} }), "me", T.onlyGitBranch, "a rename to /Branches/<x>"],
    [at("restore", "destination", "/Branches/fix (2)", { entry: undefined, branch: {} }), "me", T.onlyGitBranch, "a restore that would put a folder at /Branches/<x>"],
    [at("remove", "target", "/Branches/fix", { entry: root, branch: { root, record: rec("ready") } }), "me", T.persons, "its own ready branch's folder: not removed"],
    [at("rename", "source", "/Branches/fix", { entry: root, branch: { root, record: rec("ready") } }), "me", T.persons, "its own ready branch's folder: not moved"],
    [at("rename", "source", "/Branches/fix", { entry: root, branch: { root, record: rec("ready") } }), "other", T.otherConnection, "another's branch's folder: not moved"],
    [at("mkdir", "target", "/Branches", { entry: undefined, branch: undefined }), "me", T.onlyGitBranch, "mkdir /Branches"],
    [at("remove", "target", "/Branches", { branch: undefined }), "me", T.persons, "removing /Branches"],
    [at("rename", "source", "/Branches", { branch: undefined }), "me", T.persons, "moving /Branches"],
  ];
  for (const [c, owner, want, what] of rows) { const got = branchRefusal(c, owner); ok(got === want, `branches: ${what} (${got})`); }
}

// ---- the base hashes' pages (daybreak2's ruling on Option A, astra's DATA amendment): exact JSON bytes
{
  const h = "f".repeat(64), L = BRANCH_LIMITS;
  const pageOk = (pages) => pages.every((p) => jsonBytes(p) <= L.pageBytes);
  const total = (pages) => pages.reduce((n, p) => n + jsonBytes(p), 0);
  const short = Array.from({ length: 2000 }, (_, i) => [`A/f${i}.txt`, h]);
  const sp = hashPages(short);
  ok(sp && sp.flat().length === 2000 && pageOk(sp) && total(sp) < L.hashBytes, `2,000 short paths: ${sp?.length} pages, each <= 32 KiB, ${total(sp ?? [])} bytes in all`);
  ok(sp && sp.every((p, i) => i === sp.length - 1 || jsonBytes([...p, sp[i + 1][0]]) > L.pageBytes), "every page but the last is full (the next entry wouldn't fit)");
  // (paths of JSON bytes summing to exactly 512 KiB: allowed; one byte more: refused)
  const exact = (extra) => { const out = []; let left = L.pathBytes + extra, i = 0; while (left > 0) { const want = Math.min(left, 900); const stem = `d${i++}/`; const name = stem + "x".repeat(Math.max(1, want - 2 - stem.length)); out.push([name, h]); left -= jsonBytes(name); } return out; };
  const at = exact(0), over = exact(1);
  ok(at.reduce((n, e) => n + jsonBytes(e[0]), 0) === L.pathBytes && hashPages(at) !== null, "paths of exactly 512 KiB as JSON: allowed");
  ok(over.reduce((n, e) => n + jsonBytes(e[0]), 0) === L.pathBytes + 1 && hashPages(over) === null, "one byte more: refused");
  const atP = hashPages(at);
  ok(atP && pageOk(atP) && total(atP) < L.hashBytes, `at 512 KiB: every page <= 32 KiB, ${total(atP ?? [])} < 1 MiB in all`);
  // (escapes count as written: a quote or backslash is 2 bytes, an unpaired surrogate 6, a non-ASCII character its UTF-8)
  ok(jsonBytes('a"b') === 6 && jsonBytes("a\\b") === 6 && jsonBytes("\ud800") === 8 && jsonBytes("é") === 4 && jsonBytes("😀") === 6, "JSON bytes: quote, backslash, unpaired surrogate, non-ASCII");
  for (const [what, ch] of [["quotes", '"'], ["backslashes", "\\"], ["unpaired surrogates", "\ud800"], ["non-ASCII", "é"]]) {
    const es = Array.from({ length: 200 }, (_, i) => [`q${i}/` + ch.repeat(150), h]);
    const ps = hashPages(es), sum = es.reduce((n, e) => n + jsonBytes(e[0]), 0);
    ok(sum > L.pathBytes ? ps === null : ps !== null && pageOk(ps) && total(ps) < L.hashBytes && ps.flat().every((e, i, a) => typeof e[0] === "string"), `${what}: counted as JSON writes them (${sum} bytes of paths, ${ps ? ps.length + " pages" : "refused"})`);
    if (ps) ok(JSON.parse(JSON.stringify(ps)).flat().map((e) => e[0]).sort().join("|") === es.map((e) => e[0]).sort().join("|"), `${what}: every path kept whole`);
  }
  ok(hashPages([]) && hashPages([]).length === 0, "no hashed entries: no pages");
  // (the aggregate bound on its own (the paths' limit lifted): the pages' JSON together must be under it)
  const some = Array.from({ length: 300 }, (_, i) => [`B/${i}.txt`, h]);
  const free = { ...L, pathBytes: 1e12, hashBytes: 1e12 };
  const all = total(hashPages(some, free));
  ok(hashPages(some, { ...free, hashBytes: all }) === null, `pages of exactly the aggregate bound (${all} bytes): refused (under it, strictly)`);
  ok(hashPages(some, { ...free, hashBytes: all + 1 }) !== null, "one byte more of bound: allowed");
}
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
