// A paired agent's checks (agent-schema.ts, agent-grant.ts), without a page: every verb against its schema, and
// the grant's scoping, which is the only guard on what an agent may touch (the server treats a grant as opaque).
//   bun web/workspace/test-agent-grant.mjs
import { checkCall, check, badValue, schemaProblem, SCHEMA_PROBLEM, AGENT_VERBS } from "./agent-schema.ts";
import { authorize, grantFolders, inGrant, norm } from "./agent-grant.ts";

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
};
ok(AGENT_VERBS.size === 12 && Object.keys(good).every((v) => AGENT_VERBS.has(v)), "the schema's 12 verbs");
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
];
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
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
