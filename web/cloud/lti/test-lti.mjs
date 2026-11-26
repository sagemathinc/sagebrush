// ci: web-sync.8 order=10
// Tests for the LTI tool, stages A and B (plan-lti-r5 §3.6, §4, §5, §7.1, §15.1, §17.1), in
// Miniflare with real Durable Objects (SQLite) and D1, against a synthetic
// platform (outboundService).  Synthetic data only.
//   node web/cloud/lti/test-lti.mjs
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { createHash, createHmac, generateKeyPairSync, createSign, createVerify, randomUUID } from "node:crypto";
import { dispatch } from "../../miniflare-dispatch.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "../../site/package.json"));
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");

let failures = 0, count = 0;
function ok(cond, what) {
  count++;
  if (!cond) {
    failures++;
    console.log("FAIL", what);
  }
}

const TOOL = "https://lti.vmtest";
const LMS = "https://lms.vmtest";
const LTI_KEY = "lti-test-key";

// ---- the synthetic platform's signing key
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
// the tool's own signing key (TOOL_KEY), for deep-link responses
const toolKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const TOOL_KEY = JSON.stringify({ ...toolKeys.privateKey.export({ format: "jwk" }), kid: "tool1" });
const b64u = (b) => Buffer.from(b).toString("base64url");
function signJwt(payload, header = { alg: "RS256", kid: "k1", typ: "JWT" }) {
  const input = b64u(JSON.stringify(header)) + "." + b64u(JSON.stringify(payload));
  const s = createSign("RSA-SHA256");
  s.update(input);
  return input + "." + b64u(s.sign(privateKey));
}

// ---- the synthetic platforms, as the tool's outbound fetches see them
const seen = []; // [url, authorization]
let clients = 0;
const purges = [];
let cocalcDown = false;
// (LIMIT-STAGEA2-1: an over-cap answer, streamed; what was pulled, and whether the reader cancelled)
let cocalcHuge = false;
const mb = { regEndpoint: undefined, redirect: "" };
const huge = { pulled: 0, cancelled: false };
async function platform(req) {
  const u = new URL(req.url);
  seen.push([u.toString(), req.headers.get("authorization")]);
  const cfg = (host, regEndpoint) => Response.json({
    issuer: `https://${host}`, authorization_endpoint: `https://${host}/auth`, token_endpoint: `https://${host}/token`,
    jwks_uri: `https://${host}/jwks`, registration_endpoint: regEndpoint ?? `https://${host}/register`,
  });
  if (u.host === "lms.vmtest") {
    if (u.pathname === "/config") return cfg("lms.vmtest");
    // (each registration gets its own client id: client-1, client-2, …)
    // (the second registration answers its deployment at the top level, as Canvas does)
    if (u.pathname === "/register" && req.method === "POST") {
      const n = ++clients;
      return Response.json(n === 2 ? { client_id: `client-${n}`, deployment_id: "dep-1", "https://purl.imsglobal.org/spec/lti-tool-configuration": {} } : { client_id: `client-${n}`, "https://purl.imsglobal.org/spec/lti-tool-configuration": { deployment_id: "dep-1" } });
    }
    if (u.pathname === "/jwks") return Response.json({ keys: [jwk] });
  }
  // a platform whose registration endpoint is outside the code's bootstrap hosts
  if (u.host === "split.vmtest" && u.pathname === "/config") return cfg("split.vmtest", "https://elsewhere.vmtest/register");
  // a platform whose configuration redirects outside them
  if (u.host === "redir.vmtest" && u.pathname === "/config") return new Response(null, { status: 302, headers: { location: "https://elsewhere.vmtest/config" } });
  if (u.host === "elsewhere.vmtest") return cfg("elsewhere.vmtest");
  // (LIMIT-STAGEA3-1: a platform whose registration endpoint and redirect target the test sets)
  if (u.host === "mb.vmtest") {
    if (u.pathname === "/config") return cfg("mb.vmtest", mb.regEndpoint);
    if (u.pathname === "/config-redirect") return new Response(null, { status: 302, headers: { location: mb.redirect } });
    if (u.pathname === "/register" && req.method === "POST") return Response.json({ client_id: "mb-client", "https://purl.imsglobal.org/spec/lti-tool-configuration": { deployment_id: "mb-dep" } });
    return new Response("not found", { status: 404 });
  }
  // a fake cocalc.ai: purge-person pages, signed, acknowledged unless it's "down"
  if (u.host === "cocalc.vmtest" && u.pathname === "/api/v2/sagebrush/lti/purge-person") {
    const body = await req.text();
    const t = req.headers.get("x-lti-time"), sig = req.headers.get("x-lti-signature");
    const good = sig === createHmac("sha256", LTI_KEY).update(`POST\n${u.pathname}\n${t}\n${body}`).digest("hex");
    purges.push({ good, ...JSON.parse(body) });
    if (cocalcDown) return new Response("down", { status: 503 });
    if (cocalcHuge) {
      huge.pulled = 0, huge.cancelled = false;
      const chunk = new TextEncoder().encode(" ".repeat(4096));
      return new Response(new ReadableStream({ pull(c) { if (huge.pulled >= 1 << 20) return c.close(); huge.pulled += chunk.length; c.enqueue(chunk); }, cancel() { huge.cancelled = true; } }), { headers: { "content-type": "application/json" } });
    }
    return Response.json({ ok: true });
  }
  // the platform's AGS (r5 §5): tokens by client assertion, line items, scores
  if (u.host === "lms.vmtest" && u.pathname === "/token" && req.method === "POST") {
    const f = new URLSearchParams(await req.text());
    const [h, p, sig] = (f.get("client_assertion") ?? "").split(".");
    const good = !!sig && createVerify("RSA-SHA256").update(`${h}.${p}`).verify(toolKeys.publicKey, Buffer.from(sig, "base64url"));
    const payload = good ? JSON.parse(Buffer.from(p, "base64url").toString()) : null;
    agsP.tokenReqs.push({ good, payload, scope: f.get("scope"), grant: f.get("grant_type"), type: f.get("client_assertion_type") });
    if (!good) return Response.json({ error: "invalid_client" }, { status: 401 });
    return Response.json({ access_token: `tok-${++agsP.tokens}`, token_type: "Bearer", expires_in: 3600, scope: f.get("scope") });
  }
  if (u.host === "lms.vmtest" && u.pathname.startsWith("/ags/")) {
    const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
    agsP.hits++;
    if (!/^tok-\d+$/.test(bearer) || agsP.revoked.has(bearer)) return new Response("unauthorized", { status: 401 });
    if (u.pathname === "/ags/lineitems" && req.method === "GET") {
      agsP.queries.push(u.search);
      return Response.json(agsP.lineitems.filter((li) => li.tag === u.searchParams.get("tag")), { headers: { "content-type": "application/vnd.ims.lis.v2.lineitemcontainer+json" } });
    }
    if (u.pathname === "/ags/lineitems" && req.method === "POST") {
      const b = JSON.parse(await req.text());
      const li = { ...b, id: `https://lms.vmtest/ags/lineitems/${agsP.lineitems.length + 1}` };
      agsP.lineitems.push(li);
      agsP.posts.push(b);
      if (agsP.liPost === "lost") return new Response("gateway timeout", { status: 504 });
      return Response.json(li, { status: 201 });
    }
    const m = /^\/ags\/lineitems\/(\d+)\/scores$/.exec(u.pathname);
    if (m && req.method === "POST") {
      const status = agsP.scoreStatus.shift() ?? 200;
      if (status === 200) agsP.scores.push({ li: Number(m[1]), query: u.search, type: req.headers.get("content-type"), bearer, ...JSON.parse(await req.text()) });
      return new Response(null, { status });
    }
  }
  return new Response("not found", { status: 404 });
}
const agsP = { hits: 0, tokens: 0, tokenReqs: [], lineitems: [], posts: [], queries: [], scores: [], scoreStatus: [], revoked: new Set(), liPost: "ok" };

// ---- the Worker
const script = execFileSync("bun", ["build", join(here, "test-entry.ts"), "--format", "esm", "--target", "browser", "--external", "cloudflare:workers"], { encoding: "utf8" });
const objects = { LTI_REG: { className: "LtiReg", useSQLite: true }, LTI_SHARD: { className: "LtiLaunchShard", useSQLite: true }, LTI_COURSE: { className: "LtiCourse", useSQLite: true }, LTI_FLEET: { className: "LtiFleet", useSQLite: true }, LTI_GATE: { className: "LtiContentGate", useSQLite: true } };
const bindings = { LTI_ORIGIN: TOOL, LTI_KEY, TOOL_KEY, LTI_SYNTHETIC_ENTITLEMENT: "1", MAPPING_BACKUP_KEY: "backup-test-key", COCALC_ORIGIN: "https://cocalc.vmtest" };
const mf = new Miniflare(convertV4MiniflareOptions({
  workers: [
    { name: "lti", modules: true, script, compatibilityDate: "2026-10-01", bindings: { ...bindings, ENV: "vm-test" }, d1Databases: ["LTI_DB", "LTI_AUDIT", "LTI_CONTENT"], r2Buckets: ["LTI_BUNDLES"], durableObjects: objects, routes: ["lti.vmtest/*"], outboundService: platform, ratelimits: { LTI_PREAUTH: { namespace_id: "2001", simple: { limit: 100000, period: 60 } } } },
    // the same code as dev: .vmtest names are never fetched there (§2.2)
    { name: "lti-dev", modules: true, script, compatibilityDate: "2026-10-01", bindings: { ...bindings, ENV: "dev", LTI_ORIGIN: "https://lti.devtest.example.org" }, d1Databases: ["LTI_DB_DEV", "LTI_AUDIT_DEV"].map((n) => n), durableObjects: objects, routes: ["lti.devtest.example.org/*"], outboundService: platform, ratelimits: { LTI_PREAUTH: { namespace_id: "2002", simple: { limit: 100000, period: 60 } } } },
    // no per-IP limit bound: off
    { name: "lti-off", modules: true, script, compatibilityDate: "2026-10-01", bindings: { ...bindings, ENV: "vm-test" }, d1Databases: ["LTI_DB", "LTI_AUDIT", "LTI_CONTENT"], r2Buckets: ["LTI_BUNDLES"], durableObjects: objects, routes: ["off.vmtest/*"] },
  ],
}));

function splitSql(sql) {
  const out = [];
  let cur = [], inTrigger = false;
  for (const raw of sql.split("\n")) {
    const line = raw.replace(/--.*$/, "").trimEnd();
    if (!line.trim()) continue;
    cur.push(line);
    if (/^\s*CREATE\s+TRIGGER/i.test(line)) inTrigger = true;
    if (inTrigger ? /^\s*END;\s*$/i.test(line) : /;\s*$/.test(line)) {
      out.push(cur.join("\n").replace(/;\s*$/, ""));
      cur = [];
      inTrigger = false;
    }
  }
  return out;
}
async function migrate(db, dir) {
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort())
    for (const s of splitSql(readFileSync(join(dir, f), "utf8"))) await db.prepare(s).run();
}
const db = await mf.getD1Database("LTI_DB", "lti");
await migrate(db, join(here, "migrations"));
await migrate(await mf.getD1Database("LTI_AUDIT", "lti"), join(here, "migrations", "audit"));
const content = await mf.getD1Database("LTI_CONTENT", "lti");
await migrate(content, join(here, "migrations", "content"));

const at = (origin, path, init = {}) => dispatch(mf, origin + path, { redirect: "manual", ...init });
const tool = (path, init) => at(TOOL, path, init);
const sameOrigin = { "sec-fetch-site": "same-origin", origin: TOOL, "content-type": "application/json" };
async function admin(path, body, { key = LTI_KEY, t = Date.now(), origin = TOOL } = {}) {
  const b = JSON.stringify({ request_id: randomUUID().replace(/-/g, ""), ...body });
  const sig = createHmac("sha256", key).update(`POST\n${path}\n${t}\n${b}`).digest("hex");
  return at(origin, path, { method: "POST", headers: { "content-type": "application/json", "x-lti-time": String(t), "x-lti-signature": sig }, body: b });
}
async function adminRaw(path, b, t = Date.now()) {
  const sig = createHmac("sha256", LTI_KEY).update(`POST\n${path}\n${t}\n${b}`).digest("hex");
  return tool(path, { method: "POST", headers: { "content-type": "application/json", "x-lti-time": String(t), "x-lti-signature": sig }, body: b });
}
const j = (r) => r.json();
// PUT /lti/admin/bundle (amendment 3 r15 §2.2): raw bytes, the signed canonical meta header binding them
const sha256hex = (b) => createHash("sha256").update(b).digest("hex");
async function putBundle(owner, body, { sha, size, key = LTI_KEY, t = Date.now(), actor = "a", request_id = randomUUID().replace(/-/g, "") } = {}) {
  const buf = Buffer.from(body);
  // (keys in sorted order: the canonical form)
  const meta = JSON.stringify({ actor_ref: actor, owner_ref: owner, request_id, sha256: sha ?? sha256hex(buf), size: size ?? buf.length });
  const sig = createHmac("sha256", key).update(`PUT\n/lti/admin/bundle\n${t}\n${meta}`).digest("hex");
  return tool("/lti/admin/bundle", { method: "PUT", headers: { "x-lti-time": String(t), "x-lti-signature": sig, "x-lti-meta": meta }, body: buf });
}
/** A held bundle of `owner`'s with distinct synthetic bytes; its sha256. */
async function heldBundle(owner, label = randomUUID()) {
  const body = `synthetic bundle ${label}`;
  const r = await putBundle(owner, body);
  if (r.status !== 200) throw new Error(`bundle upload ${r.status} ${await r.text()}`);
  return sha256hex(Buffer.from(body));
}
const cgate = async (m, ...args) => j(await tool("/__test/cgate", { method: "POST", body: JSON.stringify({ m, args }) }));
// (checkpoints only when a test asks for one: an automatic one would pause issue for ≈ 4 s under some other test)
await cgate("testSeam", { checkpoints: "manual" });

// ================= §17.1: admin calls and owner binding
let r = await admin("/lti/admin/codes", { owner_ref: "ownerA", owner_kind: "license", actor_ref: "adminA", preset: "moodle", bootstrap_hosts: ["lms.vmtest"] });
ok(r.status === 200, "a signed code issuance succeeds");
const codeA = (await j(r)).code;
ok(/^[0-9a-f]{64}$/.test(codeA ?? ""), "the code is 256 random bits");
r = await admin("/lti/admin/codes", { owner_ref: "ownerA", owner_kind: "license", actor_ref: "adminA", preset: "moodle", bootstrap_hosts: ["lms.vmtest"] }, { key: "wrong" });
ok(r.status === 401, "a wrong signature is refused");
r = await admin("/lti/admin/codes", { owner_ref: "ownerA", owner_kind: "license", actor_ref: "adminA", preset: "moodle", bootstrap_hosts: ["lms.vmtest"] }, { t: Date.now() - 10 * 60_000 });
ok(r.status === 401, "a stale signature is refused");
{
  const b = JSON.stringify({ request_id: "replayreplayreplay01", owner_ref: "ownerA", owner_kind: "license", actor_ref: "adminA", preset: "moodle", bootstrap_hosts: ["lms.vmtest"] });
  const r1 = await adminRaw("/lti/admin/codes", b), r2 = await adminRaw("/lti/admin/codes", b);
  ok(r1.status === 200 && r2.status === 409, `a replayed request id is refused (${r1.status}, ${r2.status})`);
}
r = await admin("/lti/admin/codes", { owner_ref: "ownerA", owner_kind: "license", actor_ref: "adminA", preset: "moodle", bootstrap_hosts: ["10.0.0.1"] });
ok(r.status === 400, "an IP literal bootstrap host is refused");
r = await admin("/lti/admin/codes", { owner_ref: "ownerA", owner_kind: "license", actor_ref: "adminA", preset: "canvas-cloud", bootstrap_hosts: ["lms.vmtest"] });
ok(r.status === 400, "a preset without its required hosts is refused");
r = await admin("/lti/admin/codes", { owner_ref: "ownerD", owner_kind: "license", actor_ref: "a", preset: "moodle", bootstrap_hosts: ["lms.vmtest"] }, { origin: "https://lti.devtest.example.org" });
ok(r.status === 404 || r.status === 400, `dev never accepts .vmtest hosts (${r.status})`);

// ================= §7.1: dynamic registration and the bootstrap policy
const reg = (code, config, token = "regtoken") => tool(`/lti/register?code=${code}&openid_configuration=${encodeURIComponent(config)}&registration_token=${token}`);
seen.length = 0;
r = await reg(codeA, `${LMS}/config`);
ok(r.status === 200 && (await r.text()).includes("org.imsglobal.lti.close"), "dynamic registration succeeds and closes the window");
ok(seen.length === 2 && seen.every(([u, a]) => u.startsWith(LMS) && a === "Bearer regtoken"), "the registration token goes only to the two bootstrap URLs");
r = await reg(codeA, `${LMS}/config`);
ok(r.status === 400, "a code is single use");
// another platform's host is refused before any fetch
r = await admin("/lti/admin/codes", { owner_ref: "ownerA", owner_kind: "license", actor_ref: "adminA", preset: "moodle", bootstrap_hosts: ["lms.vmtest"] });
const codeB = (await j(r)).code;
seen.length = 0;
r = await reg(codeB, "https://elsewhere.vmtest/config");
ok(r.status === 400 && seen.length === 0, "a code for platform A fetches nothing from platform B");
r = await reg(codeB, `${LMS}/config`);
ok(r.status === 200, "...and the code still works after that refusal (nothing was consumed)");
{
  // a configuration URL carrying a long registration token in its query, as Canvas sends it
  const rr = await admin("/lti/admin/codes", { owner_ref: "ownerL", owner_kind: "organization", actor_ref: "a", preset: "moodle", bootstrap_hosts: ["lms.vmtest"] });
  const codeL = (await j(rr)).code;
  const longCfg = `${LMS}/config?registration_token=TOKSECRET${"x".repeat(1500)}`;
  const rl = await reg(codeL, longCfg);
  ok(rl.status === 200, "a configuration URL with a 1.5 KiB token in its query registers (Canvas)");
  const r5 = await admin("/lti/admin/codes", { owner_ref: "ownerL", owner_kind: "organization", actor_ref: "a", preset: "moodle", bootstrap_hosts: ["lms.vmtest"] });
  ok((await reg((await j(r5)).code, `${LMS}/config?t=${"x".repeat(5000)}`)).status === 400, "...but not one over 4 KiB");
  // astra's note: the bootstrap URL (its query can carry a credential) is never stored, in pending data, audit or anywhere
  const inReg = (await db.prepare("SELECT count(*) AS n FROM registrations WHERE bootstrap LIKE '%TOKSECRET%' OR policy LIKE '%TOKSECRET%' OR coalesce(iss, '') LIKE '%TOKSECRET%'").first()).n;
  const inAudit = (await (await mf.getD1Database("LTI_AUDIT", "lti")).prepare("SELECT count(*) AS n FROM audit WHERE detail LIKE '%TOKSECRET%'").first()).n;
  const inCodes = (await db.prepare("SELECT count(*) AS n FROM codes WHERE bootstrap LIKE '%TOKSECRET%'").first()).n;
  ok(inReg === 0 && inAudit === 0 && inCodes === 0, "no bootstrap URL or its token is stored in registrations, codes or audit");
}
{
  const d2 = await db.prepare("SELECT d.deployment_id FROM deployments d JOIN registrations r ON r.rid = d.rid WHERE r.client_id = 'client-2'").first();
  ok(d2?.deployment_id === "dep-1", "a deployment_id at the registration answer's top level (Canvas) is recorded");
}
// a registration endpoint outside the bootstrap hosts: nothing posted, no token sent there
r = await admin("/lti/admin/codes", { owner_ref: "ownerA", owner_kind: "license", actor_ref: "adminA", preset: "moodle", bootstrap_hosts: ["split.vmtest"] });
const codeC = (await j(r)).code;
seen.length = 0;
r = await reg(codeC, "https://split.vmtest/config");
ok(r.status === 400 && !seen.some(([u]) => u.includes("elsewhere")), "a registration endpoint outside the bootstrap hosts gets nothing");
// a redirect outside the bootstrap hosts is not followed
r = await admin("/lti/admin/codes", { owner_ref: "ownerA", owner_kind: "license", actor_ref: "adminA", preset: "moodle", bootstrap_hosts: ["redir.vmtest"] });
const codeR = (await j(r)).code;
seen.length = 0;
r = await reg(codeR, "https://redir.vmtest/config");
ok(r.status === 400 && !seen.some(([u]) => u.includes("elsewhere")), "a discovery redirect outside the bootstrap hosts is not followed");

// the owner's list, and another owner's
r = await admin("/lti/admin/registrations", { owner_ref: "ownerA" });
const regs = (await j(r)).registrations;
const mine = regs.filter((x) => x.state === "pending");
ok(mine.length === 2, `owner A sees its two pending registrations (${mine.length})`);
r = await admin("/lti/admin/registrations", { owner_ref: "ownerB" });
ok((await j(r)).registrations.length === 0, "owner B sees none of them");
const R1 = mine[0];
// approval: owner, version and digest
r = await admin("/lti/admin/approve", { owner_ref: "ownerB", rid: R1.rid, policy_version: R1.policy_version, policy_digest: R1.policy_digest, actor_ref: "adminB" });
ok(r.status === 404, "owner B can't approve owner A's registration");
r = await admin("/lti/admin/approve", { owner_ref: "ownerA", rid: R1.rid, policy_version: R1.policy_version, policy_digest: "0".repeat(64), actor_ref: "adminA" });
ok(r.status === 409, "an approval with the wrong digest is refused");
// a staff policy change after review invalidates an approval of the old version
const R2 = mine[1];
r = await admin("/lti/admin/policy", { owner_ref: "ownerA", rid: R2.rid, staff_ref: "staff1", policy: { ...R2.policy, framing_origins: [LMS, "https://extra.vmtest"] } });
const edited = await j(r);
ok(r.status === 200, `a staff policy edit is accepted (${r.status} ${JSON.stringify(edited)})`);
r = await admin("/lti/admin/approve", { owner_ref: "ownerA", rid: R2.rid, policy_version: R2.policy_version, policy_digest: R2.policy_digest, actor_ref: "adminA" });
ok(r.status === 409, "after a policy change, the old version's approval is refused");
r = await admin("/lti/admin/approve", { owner_ref: "ownerA", rid: R2.rid, policy_version: edited.policy_version, policy_digest: edited.policy_digest, actor_ref: "adminA" });
ok(r.status === 403, "an off-preset policy needs staff approval");
r = await admin("/lti/admin/staff-approve", { rid: R2.rid, policy_digest: R2.policy_digest, staff_ref: "staff1" });
ok(r.status === 409, "a staff approval names the current digest only");
r = await admin("/lti/admin/approve", { owner_ref: "ownerA", rid: R1.rid, policy_version: R1.policy_version, policy_digest: R1.policy_digest, actor_ref: "adminA" });
ok(r.status === 200, `a preset-exact policy is approved by the owner's admin (${r.status} ${await r.text()})`);
// the owner can't be changed, even directly
let threw = false;
try {
  await db.prepare("UPDATE registrations SET owner_ref = 'ownerB' WHERE rid = ?").bind(R1.rid).run();
} catch {
  threw = true;
}
ok(threw, "a registration's owner is immutable");

// ================= §15.1: the code quota, by trigger
{
  const live = (await db.prepare("SELECT count FROM quota WHERE scope = 'env' AND kind = 'codes'").first()).count;
  const real = (await db.prepare("SELECT count(*) AS n FROM codes").first()).n;
  ok(live === real, `the codes counter equals the rows (${live}, ${real})`);
  const statuses = [];
  for (let i = live; i < 21; i++) statuses.push((await admin("/lti/admin/codes", { owner_ref: "ownerQ", owner_kind: "organization", actor_ref: "a", preset: "moodle", bootstrap_hosts: ["lms.vmtest"] })).status);
  ok(statuses.slice(0, -1).every((s) => s === 200) && statuses.at(-1) === 429, `the 21st live code is refused (${statuses.join(",")})`);
}

// §15.1: an oversized encoded value is refused by CHECK; a corrupted counter is repaired by the daily job
{
  let refused = false;
  try {
    await db.prepare("INSERT INTO codes (code_hash, owner_ref, owner_kind, preset, bootstrap, expires, state, size) VALUES (?, 'o', 'license', 'moodle', ?, 0, 'live', 0)").bind("9".repeat(64), "x".repeat(600)).run();
  } catch {
    refused = true;
  }
  ok(refused, "an oversized bootstrap is refused by the table's CHECK");
  const real = (await db.prepare("SELECT count(*) AS n FROM codes").first()).n;
  await db.prepare("UPDATE quota SET count = count + 7 WHERE scope = 'env' AND kind = 'codes'").run();
  const fixed = await j(await tool("/__test/scheduled"));
  const now = (await db.prepare("SELECT count FROM quota WHERE scope = 'env' AND kind = 'codes'").first()).count;
  ok(fixed.some((f) => f.startsWith("env/codes")) && now === real, `the daily reconciliation repairs a corrupted counter (${now} = ${real})`);
  ok((await j(await tool("/__test/scheduled"))).length === 0, "a second run finds nothing to repair");
}
// §15.2 / §15.3: Reg's concurrency, and LaunchShard's cap
{
  const a1 = (await j(await tool(`/__test/reserve?rid=${R1.rid}&kind=dynreg`))).lease;
  const a2 = (await j(await tool(`/__test/reserve?rid=${R1.rid}&kind=dynreg`))).lease;
  ok(!!a1 && a2 === null, "dynamic registration admits one at a time");
  await tool(`/__test/reserve?rid=${R1.rid}&release=${a1}`);
  const a3 = (await j(await tool(`/__test/reserve?rid=${R1.rid}&kind=dynreg`))).lease;
  ok(!!a3, "a released reservation frees the slot");
  await tool(`/__test/reserve?rid=${R1.rid}&release=${a3}`);
  const f = await j(await tool(`/__test/shard-fill?rid=${"0".repeat(32)}&n=2001`));
  ok(f.last && f.last.ok === false && f.last.code === "shard_full" && f.stats.rows === 2000, `a LaunchShard refuses its 2,001st live row (${JSON.stringify(f.stats)})`);
}

// ================= §3: launch, cookie mode
const iss = LMS, client = "client-1", dep = "dep-1";
const M = "http://purl.imsglobal.org/vocab/lis/v2/membership";
async function login(extra = "") {
  const r = await tool(`/lti/login?iss=${encodeURIComponent(iss)}&login_hint=u1&target_link_uri=${encodeURIComponent(TOOL + "/lti/app")}&client_id=${client}&lti_deployment_id=${dep}${extra}`);
  return r;
}
function claims(state, nonce, over = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss, aud: client, sub: "student-1", nonce, iat: now, exp: now + 300,
    "https://purl.imsglobal.org/spec/lti/claim/deployment_id": dep,
    "https://purl.imsglobal.org/spec/lti/claim/target_link_uri": TOOL + "/lti/app",
    "https://purl.imsglobal.org/spec/lti/claim/message_type": "LtiResourceLinkRequest",
    "https://purl.imsglobal.org/spec/lti/claim/version": "1.3.0",
    "https://purl.imsglobal.org/spec/lti/claim/roles": [`${M}#Learner`],
    "https://purl.imsglobal.org/spec/lti/claim/context": { id: "course-1" },
    "https://purl.imsglobal.org/spec/lti/claim/resource_link": { id: "rl-1" },
    ...over,
  };
}
const launchPost = (idt, state, cookie) => tool("/lti/launch", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) }, body: new URLSearchParams({ id_token: idt, state }).toString() });
async function cookieLogin() {
  let r = await login();
  // (this file launches more than a registration's 600 a minute: refill its bucket, as a minute's wait would)
  if (!r.headers.get("location") && typeof R1 !== "undefined") {
    await tool(`/__test/refill?rid=${R1.rid}&kind=launch`);
    r = await login();
  }
  const loc = new URL(r.headers.get("location"));
  const state = loc.searchParams.get("state"), nonce = loc.searchParams.get("nonce");
  const c = r.headers.get("set-cookie") ?? "";
  return { r, loc, state, nonce, cookie: c.split(";")[0] };
}
{
  const { r, loc, state, nonce, cookie } = await cookieLogin();
  ok(r.status === 302 && loc.origin === LMS && loc.searchParams.get("response_mode") === "form_post" && loc.searchParams.get("prompt") === "none", "login redirects to the platform's auth endpoint");
  ok(/SameSite=None/.test(r.headers.get("set-cookie") ?? "") && /Partitioned/.test(r.headers.get("set-cookie") ?? "") && /HttpOnly/.test(r.headers.get("set-cookie") ?? ""), "the frame cookie is SameSite=None, Partitioned, HttpOnly");
  // every §3.6 refusal, each with a correct signature, before any state changes
  const bad = {
    "a different allowed target": { "https://purl.imsglobal.org/spec/lti/claim/target_link_uri": TOOL + "/lti/deeplink" },
    "an unregistered deployment": { "https://purl.imsglobal.org/spec/lti/claim/deployment_id": "dep-other" },
    "an extra audience": { aud: [client, "other"] },
    "a mismatched azp": { azp: "other" },
    "a missing context": { "https://purl.imsglobal.org/spec/lti/claim/context": undefined },
    "a missing resource link": { "https://purl.imsglobal.org/spec/lti/claim/resource_link": undefined },
    "a deep-link request carrying a resource link": { "https://purl.imsglobal.org/spec/lti/claim/message_type": "LtiDeepLinkingRequest", "https://purl.imsglobal.org/spec/lti-dl/claim/deep_linking_settings": {} },
    "the wrong claim type": { "https://purl.imsglobal.org/spec/lti/claim/roles": "Learner" },
    "a future iat": { iat: Math.floor(Date.now() / 1000) + 120 },
    "a wrong nonce": { nonce: "f".repeat(64) },
    "a wrong version": { "https://purl.imsglobal.org/spec/lti/claim/version": "1.1" },
  };
  for (const [what, over] of Object.entries(bad)) {
    const x = await launchPost(signJwt(claims(state, nonce, over)), state, cookie);
    ok(x.status >= 400 && x.status < 500, `${what} is refused (${x.status})`);
  }
  const forged = signJwt(claims(state, nonce), { alg: "RS256", kid: "k1", typ: "JWT" }).replace(/\.[^.]+$/, ".AAAA");
  ok((await launchPost(forged, state, cookie)).status === 401, "a bad signature is refused");
  // the transaction survived all of that: the valid launch now works, once
  const good = await launchPost(signJwt(claims(state, nonce)), state, cookie);
  const html = await good.text();
  const ticket = /open\("([0-9a-f]{32}:[0-9a-f]:[0-9a-f]{32})"\)/.exec(html)?.[1];
  ok(good.status === 200 && !!ticket, "after the refusals, the valid launch gets a ticket");
  ok(/frame-ancestors https:\/\/lms\.vmtest/.test(good.headers.get("content-security-policy") ?? ""), "frame-ancestors is the approved framing origin");
  const again = await launchPost(signJwt(claims(state, nonce)), state, cookie);
  ok(!/open\("/.test(await again.text()), "a replayed launch gets no ticket");
  const s1 = await tool("/lti/session", { method: "POST", headers: sameOrigin, body: JSON.stringify({ ticket }) });
  const sess = await j(s1);
  ok(s1.status === 200 && /^[0-9a-f]{32}\.[0-9a-f]{32}$/.test(sess.token ?? "") && sess.role === "learner", "the ticket redeems for a learner session");
  const s2 = await tool("/lti/session", { method: "POST", headers: sameOrigin, body: JSON.stringify({ ticket }) });
  ok(s2.status === 400, "a ticket is single use");
  const cross = await tool("/lti/session", { method: "POST", headers: { ...sameOrigin, "sec-fetch-site": "cross-site" }, body: JSON.stringify({ ticket }) });
  ok(cross.status === 403, "a cross-site session request is refused");
  const rn = await tool("/lti/session/renew", { method: "POST", headers: { ...sameOrigin, authorization: `Bearer ${sess.token}` }, body: "{}" });
  ok(rn.status === 200, "a session renews");
}
// amendment 2 r1: login bounds in decoded UTF-8 bytes, before any reservation; the exact row admitted; leases released
{
  const st = async () => j(await tool(`/__test/launch-state?rid=${R1.rid}`));
  const loginPost = (over) => tool("/lti/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ iss, login_hint: "u1", target_link_uri: TOOL + "/lti/app", client_id: client, lti_deployment_id: dep, ...over }).toString() });
  const refusedClean = async (over, code, what) => {
    const before = await st();
    const r = await loginPost(over);
    const body = await r.text();
    const after = await st();
    ok(r.status === 400 && body.includes(code) && after.rows === before.rows && after.bucket.updated === before.bucket.updated && after.bucket.leases === 0, `${what}: refused with ${code}, nothing reserved or stored`);
  };
  const admitted = async (over, what) => {
    const before = await st();
    const r = await loginPost(over);
    const after = await st();
    ok(r.status === 302 && after.rows === before.rows + 1, `${what}: admitted (${r.status})`);
  };
  await admitted({ lti_message_hint: "a".repeat(1024) }, "a 1,024 B ASCII message hint");
  await refusedClean({ lti_message_hint: "a".repeat(1025) }, "message_hint_too_long", "a 1,025 B ASCII message hint");
  await admitted({ lti_message_hint: "€".repeat(341) + "a" }, "a 1,024 B multibyte message hint (342 code units)");
  await refusedClean({ lti_message_hint: "€".repeat(342) }, "message_hint_too_long", "a 1,026 B multibyte message hint of only 342 code units");
  await admitted({ login_hint: "a".repeat(255) }, "a 255 B login hint");
  await refusedClean({ login_hint: "a".repeat(256) }, "login_hint_too_long", "a 256 B login hint");
  await refusedClean({ login_hint: "€".repeat(86) }, "login_hint_too_long", "a 258 B multibyte login hint of 86 code units");
  await admitted({ lti_message_hint: "a".repeat(1024), login_hint: "b".repeat(255) }, "maximal hints together (the row fits 2 KiB)");
  // within the parameter bounds, but JSON escaping makes the serialized row too large: refused atomically, lease given back
  for (const [hint, what] of [['"'.repeat(1000), "quotes"], ["\\".repeat(1000), "backslashes"], ["\u0001".repeat(300), "control characters"]]) {
    const before = await st();
    const r = await loginPost({ lti_message_hint: hint });
    const body = await r.text();
    const after = await st();
    ok(r.status === 400 && body.includes("too_large") && after.rows === before.rows && after.bucket.leases === 0 && after.bucket.tokens >= before.bucket.tokens - 1e-6, `a hint of ${what} escaping past 2 KiB: refused, no row, the lease released`);
  }
}

// a missing cookie: the fresh top-level path
{
  const { state, nonce } = await cookieLogin();
  const x = await launchPost(signJwt(claims(state, nonce)), state, null);
  const html = await x.text();
  ok(/Open in a new tab/.test(html) && /sb_top=1/.test(html), "with the cookie blocked, the page offers a fresh top-level login");
  const top = await tool(`/lti/login?iss=${encodeURIComponent(iss)}&login_hint=u1&target_link_uri=${encodeURIComponent(TOOL + "/lti/app")}&client_id=${client}&sb_top=1`);
  const c = top.headers.get("set-cookie") ?? "";
  ok(top.status === 302 && /SameSite=None/.test(c) && !/Partitioned/.test(c), "the top-level login's cookie is first-party SameSite=None");
  ok(new URL(top.headers.get("location")).searchParams.get("state") !== state, "with a new state: the old transaction is never redeemed");
}
// roles (CORR-LTI2-1)
async function launchAs(roles) {
  const { state, nonce, cookie } = await cookieLogin();
  const x = await launchPost(signJwt(claims(state, nonce, { "https://purl.imsglobal.org/spec/lti/claim/roles": roles })), state, cookie);
  const html = await x.text();
  const ticket = /open\("([0-9a-f]{32}:[0-9a-f]:[0-9a-f]{32})"\)/.exec(html)?.[1];
  if (!ticket) return { html, role: null };
  const s = await j(await tool("/lti/session", { method: "POST", headers: sameOrigin, body: JSON.stringify({ ticket }) }));
  return { html, role: s.role ?? null, staff: s.staff, token: s.token };
}
for (const [roles, want] of [
  [[`${M}#Mentor`], null], [[`${M}#ContentDeveloper`], null], [[`${M}#TeachingAssistant`], null], [["http://example.org/x#Instructor"], null],
  [[`${M}/Instructor#TeachingAssistant`], "instructor"], [[`${M}#Mentor`, `${M}#Instructor`], "instructor"], [["Instructor"], "instructor"],
]) {
  const x = await launchAs(roles);
  ok(x.role === want && (want !== null || /nothing for your role/.test(x.html)), `roles ${JSON.stringify(roles)} give ${want ?? "guest"} (${x.role})`);
}
// amendment 5 r5 §1-§2: staff (a TA or a full instructor) and the session handle
{
  const TA = `${M}/Instructor#TeachingAssistant`;
  for (const [roles, role, staff] of [
    [[TA], "instructor", "ta"],
    [[TA, `${M}#Learner`], "instructor", "ta"],
    [[TA, `${M}#Instructor`], "instructor", "instructor"],
    [[TA, `${M}#Administrator`], "instructor", "instructor"],
    [[TA, "Instructor"], "instructor", "instructor"],
    [[`${M}#Instructor`], "instructor", "instructor"],
    [["Instructor"], "instructor", "instructor"],
    [[`${M}#Learner`], "learner", null],
    [[`${M}#TeachingAssistant`], null, undefined],
    [[`${M}#TeachingAssistant`, `${M}#Learner`], "learner", null],
  ]) {
    const x = await launchAs(roles);
    ok(x.role === role && x.staff === staff, `amend5 §1: roles ${JSON.stringify(roles)} give role ${role}, staff ${staff} (${x.role}, ${x.staff})`);
  }
  // Course.check returns staff and a handle; the handle is random, 16 B, distinct per session, and not the sid
  const ns = await mf.getDurableObjectNamespace("LTI_COURSE", "lti");
  const views = [];
  // (upgrades only, so no launch here revokes another: learner, then TA, then instructor)
  for (const roles of [[`${M}#Learner`], [TA], [`${M}#Instructor`]]) {
    const x = await launchAs(roles);
    const [course, sid] = x.token.split(".");
    const c = await ns.get(ns.idFromName(course)).check(sid);
    views.push({ c, sid, course });
  }
  ok(views.every(({ c }) => c.ok && /^[0-9a-f]{32}$/.test(c.value.handle)), "amend5 §2: Course.check returns a 16 B handle for every session");
  ok(views[1].c.value.staff === "ta" && views[2].c.value.staff === "instructor" && views[0].c.value.staff === null, "amend5 §1: Course.check returns staff: ta, instructor, null for a learner");
  ok(new Set(views.map(({ c }) => c.value.handle)).size === 3 && views.every(({ c, sid }) => c.value.handle !== sid && !sid.includes(c.value.handle) && !c.value.handle.includes(sid.slice(0, 8))), "amend5 §2: handles are distinct and unrelated to the sid");
  const again = await ns.get(ns.idFromName(views[1].course)).check(views[1].sid);
  ok(again.ok && again.value.handle === views[1].c.value.handle, "amend5 §2: a session's handle is stable across checks");
  const renewed = await ns.get(ns.idFromName(views[1].course)).renew(views[1].sid);
  ok(renewed.ok && renewed.value.handle === views[1].c.value.handle && renewed.value.staff === "ta", "amend5 §2: renewal keeps the handle and staff");
}
// storage mode (§3.3)
{
  const r = await login("&lti_storage_target=_parent");
  const html = await r.text();
  const state = /put\("sb_state_" \+ K, "([0-9a-f]{64})"\)/.exec(html)?.[1], nonce = /put\("sb_nonce_" \+ K, "([0-9a-f]{64})"\)/.exec(html)?.[1];
  ok(r.status === 200 && state && nonce, "storage-mode login answers the put_data page");
  ok(/postMessage\(\{ subject: "lti\.put_data"/.test(html) && html.includes(`const O = "${LMS}"`), "the page posts to the storage origin, never *");
  const v = await launchPost(signJwt(claims(state, nonce)), state, null);
  const vh = await v.text();
  const corr = /corr: "([^"]+)"/.exec(vh)?.[1];
  ok(v.status === 200 && corr && !/open\("[0-9a-f]{32}:/.test(vh), "the launch answers a verify page with corr and no ticket");
  const post = (body, headers = sameOrigin) => tool("/lti/launch/verify", { method: "POST", headers, body: JSON.stringify(body) });
  ok((await post({ corr, state, nonce }, { ...sameOrigin, "sec-fetch-site": "cross-site" })).status === 403, "a cross-site verify is refused");
  ok((await post({ corr, state, nonce: "a".repeat(64) })).status === 400, "a wrong nonce at verify is refused");
  const v1 = await post({ corr, state, nonce });
  ok(v1.status === 200 && !!(await j(v1)).ticket, "verify with corr, state and nonce gives a ticket");
  ok((await post({ corr, state, nonce })).status === 400, "a duplicate verify is refused");
}
// the storage page's fallback to cookie mode, server-side
{
  const r = await login("&lti_storage_target=_parent");
  const html = await r.text();
  const fb = /go\("([^"]+\/lti\/login\/fallback[^"]+)"\)|"(https:\/\/lti\.vmtest\/lti\/login\/fallback[^"]+)"/.exec(html);
  const url = (fb?.[1] ?? fb?.[2] ?? "").replace(TOOL, "");
  ok((await tool(url)).status === 403, "the fallback refuses a cross-site navigation");
  const f = await tool(url, { headers: { "sec-fetch-site": "same-origin" } });
  ok(f.status === 302 && /Partitioned/.test(f.headers.get("set-cookie") ?? ""), "the fallback switches to cookie mode, server-side");
}
// sessions: the instructor's 1 h absolute end, and revocation by generation (§3.4)
{
  const course = "c".repeat(32), member = "e".repeat(32);
  const s = await j(await tool("/__test/session", { method: "POST", body: JSON.stringify({ course, rid: R1.rid, sub: "t1", member, role: "instructor", ago_ms: 3600_000 - 1500 }) }));
  ok(s.ok, "an instructor session near its absolute end is made");
  const renew = (sid) => tool("/lti/session/renew", { method: "POST", headers: { ...sameOrigin, authorization: `Bearer ${course}.${sid}` }, body: "{}" });
  ok((await renew(s.value.sid)).status === 200, "it renews before the end");
  await new Promise((r) => setTimeout(r, 2000));
  ok((await renew(s.value.sid)).status === 401, "an instructor session can't renew past 1 h from its launch");
  const l = await j(await tool("/__test/session", { method: "POST", body: JSON.stringify({ course, rid: R1.rid, sub: "s2", member, role: "learner", ago_ms: 0 }) }));
  ok((await renew(l.value.sid)).status === 200, "a learner session renews");
  await tool("/__test/bump", { method: "POST", body: JSON.stringify({ course, member }) });
  ok((await renew(l.value.sid)).status === 401, "a member generation bump ends the member's sessions");
}
// ================= amendment 1 r6: handles, holds, recovery, erasure
function dkey(kind, ...fields) {
  const parts = [Buffer.from("sb-lti-v1")];
  for (const f of [kind, ...fields]) {
    const b = Buffer.from(f, "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(b.length);
    parts.push(len, b);
  }
  return createHash("sha256").update(Buffer.concat(parts)).digest("hex").slice(0, 32);
}
const reg1 = async () => j(await tool(`/__test/reg?rid=${R1.rid}`));
async function sessionFor(sub, context) {
  const { state, nonce, cookie } = await cookieLogin();
  const x = await launchPost(signJwt(claims(state, nonce, { sub, "https://purl.imsglobal.org/spec/lti/claim/context": { id: context } })), state, cookie);
  const ticket = /open\("([0-9a-f]{32}:[0-9a-f]:[0-9a-f]{32})"\)/.exec(await x.text())?.[1];
  if (!ticket) return { status: 0 };
  const r = await tool("/lti/session", { method: "POST", headers: sameOrigin, body: JSON.stringify({ ticket }) });
  return { status: r.status, ...(await j(r)) };
}
{
  const before = await reg1();
  const a = await sessionFor("amy", "course-1");
  ok(a.status === 200, `a launch issues handles and opens a session (${a.status} ${a.error ?? ""})`);
  const m1 = await reg1();
  const w = await db.prepare("SELECT mapping_epoch, mapping_seq FROM registrations WHERE rid = ?").bind(R1.rid).first();
  ok(m1.mapping?.witnessed === 1 && w.mapping_epoch === m1.mapping.epoch_id, "the first epoch is witnessed in D1 before any handle escapes");
  ok(m1.persons === before.persons + 1 && m1.person_courses === before.person_courses + 1, "one person and one membership are issued");
  await sessionFor("amy", "course-1");
  ok((await reg1()).persons === m1.persons, "a second launch gets the same handles (get-or-create)");
  await sessionFor("amy", "course-2");
  const m2 = await reg1();
  ok(m2.persons === m1.persons && m2.person_courses === m1.person_courses + 1, "a second course: same person, a new membership");
  // the restore procedure's hold, then a release
  r = await admin("/lti/admin/mapping-hold", { rid: R1.rid, staff_ref: "staff1" });
  ok(r.status === 200, "mapping-hold is accepted");
  ok((await sessionFor("bob", "course-1")).status === 503, "under the hold, no handle is issued");
  r = await admin("/lti/admin/mapping-release", { rid: R1.rid, staff_ref: "staff1", epoch_id: "0".repeat(32), reported_seq: 0 });
  ok(r.status === 409, "release with the wrong epoch is refused");
  r = await admin("/lti/admin/mapping-release", { rid: R1.rid, staff_ref: "staff1", epoch_id: m2.mapping.epoch_id, reported_seq: m2.mapping.seq + 5 });
  ok(r.status === 200 && (await j(r)).seq > m2.mapping.seq + 5, "release sets the next seq above every reported one");
  ok((await sessionFor("bob", "course-1")).status === 200, "after release, issuance resumes");
  // a rollback (D1's mark above Reg's seq) is detected and holds
  const m3 = await reg1();
  await db.prepare("UPDATE registrations SET mapping_seq = ? WHERE rid = ?").bind(m3.mapping.seq + 100, R1.rid).run();
  ok((await sessionFor("cat", "course-1")).status === 503, "a Reg seq below D1's high-water mark holds the registration");
  r = await admin("/lti/admin/mapping-release", { rid: R1.rid, staff_ref: "staff1", epoch_id: m3.mapping.epoch_id, reported_seq: 0 });
  ok(r.status === 200 && (await sessionFor("cat", "course-1")).status === 200, "release after review lifts it");
}
// a lost store, lost handles, and the operator's decisions (CORR-LTI5A-4)
{
  r = await admin("/lti/admin/manual", { owner_ref: "ownerM", owner_kind: "organization", staff_ref: "staff1", client_id: "manual-client", deployments: ["dep-1"], policy: { ...R1.policy, issuer: "https://lms.vmtest/m" } });
  const RM = (await j(r)).rid;
  ok(r.status === 200 && !!RM, "a manual registration for the recovery tests");
  const iss2 = "https://lms.vmtest/m";
  async function sessionM(sub) {
    const lr = await tool(`/lti/login?iss=${encodeURIComponent(iss2)}&login_hint=u&target_link_uri=${encodeURIComponent(TOOL + "/lti/app")}&client_id=manual-client`);
    const loc = new URL(lr.headers.get("location"));
    const state = loc.searchParams.get("state"), nonce = loc.searchParams.get("nonce"), cookie = (lr.headers.get("set-cookie") ?? "").split(";")[0];
    const x = await launchPost(signJwt(claims(state, nonce, { iss: iss2, aud: "manual-client", sub })), state, cookie);
    const ticket = /open\("([0-9a-f]{32}:[0-9a-f]:[0-9a-f]{32})"\)/.exec(await x.text())?.[1];
    if (!ticket) return { status: 0 };
    const sr = await tool("/lti/session", { method: "POST", headers: sameOrigin, body: JSON.stringify({ ticket }) });
    return { status: sr.status, ...(await j(sr)) };
  }
  // D1 says an epoch exists, but this Reg holds nothing: lost, never a new registration
  await db.prepare("UPDATE registrations SET mapping_epoch = ?, mapping_seq = 10 WHERE rid = ?").bind("e".repeat(32), RM).run();
  ok((await sessionM("dan")).status === 503, "an empty Reg while D1 has an epoch holds; nothing is issued");
  const P1 = "a1".repeat(16);
  r = await admin("/lti/admin/reported-handles", { rid: RM, staff_ref: "staff1", handles: [{ seq: 11, handle: P1, kind: "person" }] });
  ok(r.status === 200 && (await j(r)).lost === 1, "a reported handle with no owner here becomes a lost handle");
  r = await admin("/lti/admin/mapping-release", { rid: RM, staff_ref: "staff1", epoch_id: "e".repeat(32), reported_seq: 11 });
  ok(r.status === 409 && (await j(r)).error === "lost_unresolved", "numeric catch-up alone never releases while a lost handle is unresolved");
  r = await admin("/lti/admin/lost-handle", { rid: RM, staff_ref: "staff1", seq: 11, handle: P1, kind: "member", decision: "bind", sub: "dan", deployment: "dep-1", context: "course-1" });
  ok(r.status === 409 && (await j(r)).error === "mismatch", "a bind naming the wrong kind is refused (astra's kind check)");
  r = await admin("/lti/admin/lost-handle", { rid: RM, staff_ref: "staff1", seq: 12, handle: P1, kind: "person", decision: "bind", sub: "dan" });
  ok(r.status === 409, "a bind naming the wrong seq is refused");
  r = await admin("/lti/admin/lost-handle", { rid: RM, staff_ref: "staff1", seq: 11, handle: P1, kind: "person", decision: "bind", sub: "dan" });
  ok(r.status === 200, "the operator binds the lost handle to its subject");
  r = await admin("/lti/admin/mapping-release", { rid: RM, staff_ref: "staff1", epoch_id: "e".repeat(32), reported_seq: 11 });
  ok(r.status === 200, "with nothing unresolved, release succeeds");
  const sd = await sessionM("dan");
  const mm = await j(await tool(`/__test/reg?rid=${RM}`));
  ok(sd.status === 200 && mm.persons === 1, "dan's next launch reuses the bound handle: no second identity");
}
// erasure (§4.1): manifest, Course by old member_ref, cocalc.ai pages, journal, receipt
{
  const before = await reg1();
  purges.length = 0;
  // (cocalc.ai held down at first, so the job is observably in progress: the alarm runs at once)
  cocalcDown = true;
  const E1 = "erase-amy-000000001";
  r = await admin("/lti/admin/erase", { owner_ref: "ownerA", rid: R1.rid, sub: "amy", erase_id: E1, issued_at: Date.now(), actor_ref: "adminA" });
  const st = await j(r);
  ok(r.status === 200 && st.state === "courses" && /^[0-9a-f]{32}$/.test(st.person_ref ?? ""), "an erasure starts with the fence and the manifest");
  const P1 = st.person_ref;
  ok((await sessionFor("amy", "course-1")).status === 403, "during the erasure, amy's launch is refused (removed)");
  const sealed0 = (await reg1()).erasures.find((e) => e.erase_id === E1)?.sealed;
  ok(!!sealed0, "the job is in progress, with its sealed journal payload fixed");
  cocalcDown = false;
  for (let i = 0; i < 6; i++) await tool(`/__test/reg?rid=${R1.rid}&op=step&due=1`);
  const after = await reg1();
  ok(after.receipts === before.receipts + 1 && !after.erasures.some((e) => e.erase_id === E1), "the erasure completes with a receipt");
  ok(after.persons === before.persons - 1 && after.person_courses === before.person_courses - 2, "amy's person and both memberships are gone");
  const pg = purges.filter((p) => p.erase_id === E1);
  ok(pg.length >= 1 && pg.every((p) => p.good && p.person_ref === P1) && pg.some((p) => p.member_refs.length === 2) && new Set(pg.flatMap((p) => p.member_refs)).size === 2, "cocalc.ai got signed pages with the person and both member handles");
  const jr = await (await mf.getD1Database("LTI_AUDIT", "lti")).prepare("SELECT sealed FROM erase_journal WHERE erase_id = ?").bind(E1).first();
  ok(jr && jr.sealed === sealed0, "the journal holds the sealed payload fixed at the start");
  const c1 = dkey("course", R1.rid, "dep-1", "course-1");
  ok((await j(await tool(`/__test/course?course=${c1}`))).members >= 1, "other members of the course remain");
  // the retry and a new incarnation
  r = await admin("/lti/admin/erase", { owner_ref: "ownerA", rid: R1.rid, sub: "amy", erase_id: E1, issued_at: Date.now(), actor_ref: "adminA" });
  const re = await j(r);
  ok(re.state === "completed" && re.person_ref === P1, "a retry of the same erase_id answers completed for P1");
  ok((await sessionFor("amy", "course-1")).status === 200, "amy can launch again: a new identity, explicitly");
  r = await admin("/lti/admin/erase", { owner_ref: "ownerA", rid: R1.rid, sub: "amy", erase_id: E1, issued_at: Date.now(), actor_ref: "adminA" });
  ok((await j(r)).person_ref === P1 && (await reg1()).persons === after.persons + 1, "retrying P1's erase never touches P2");
  r = await admin("/lti/admin/erase", { owner_ref: "ownerA", rid: R1.rid, sub: "amy", erase_id: "erase-stale-0000001", issued_at: Date.now() - 26 * 86400_000, actor_ref: "adminA" });
  ok(r.status === 400, "an erase issued over 25 days ago is refused as stale");
  r = await admin("/lti/admin/erase", { owner_ref: "ownerB", rid: R1.rid, sub: "amy", erase_id: "erase-other-000001", issued_at: Date.now(), actor_ref: "adminB" });
  ok(r.status === 404, "another owner can't erase in this registration");
  // Course.eraseMember is keyed by the exact old handle: an unknown one changes nothing
  const n0 = (await j(await tool(`/__test/course?course=${c1}`))).members;
  const er = await j(await tool(`/__test/course?course=${c1}&op=erase&ref=${"f".repeat(32)}`));
  ok(er.ok && (await j(await tool(`/__test/course?course=${c1}`))).members === n0, "eraseMember with an unknown handle answers done and deletes nothing");
  // cocalc.ai down: the job waits, keeps its identical payload, and finishes when cocalc.ai is back
  cocalcDown = true;
  const E2 = "erase-amy-000000002";
  r = await admin("/lti/admin/erase", { owner_ref: "ownerA", rid: R1.rid, sub: "amy", erase_id: E2, issued_at: Date.now(), actor_ref: "adminA" });
  const s2 = (await reg1()).erasures.find((e) => e.erase_id === E2);
  for (let i = 0; i < 4; i++) await tool(`/__test/reg?rid=${R1.rid}&op=step&due=1`);
  const mid = (await reg1()).erasures.find((e) => e.erase_id === E2);
  ok(mid && mid.state === "external" && mid.attempts > 0 && mid.sealed === s2.sealed && mid.nonce === s2.nonce, "with cocalc.ai down, the job waits in 'external' with the same sealed payload and nonce");
  cocalcDown = false;
  for (let i = 0; i < 4; i++) await tool(`/__test/reg?rid=${R1.rid}&op=step&due=1`);
  ok(!(await reg1()).erasures.some((e) => e.erase_id === E2), "when cocalc.ai is back, the erasure completes");
  // a journal row that doesn't read back the same is not an acknowledgement: fail closed
  await sessionFor("eve", "course-1");
  const E3 = "erase-eve-000000003";
  await (await mf.getD1Database("LTI_AUDIT", "lti")).prepare("INSERT INTO erase_journal (erase_id, rid, sealed, completed) VALUES (?, ?, 'tampered', 0)").bind(E3, R1.rid).run();
  r = await admin("/lti/admin/erase", { owner_ref: "ownerA", rid: R1.rid, sub: "eve", erase_id: E3, issued_at: Date.now(), actor_ref: "adminA" });
  for (let i = 0; i < 6; i++) await tool(`/__test/reg?rid=${R1.rid}&op=step&due=1`);
  const j3 = (await reg1()).erasures.find((e) => e.erase_id === E3);
  ok(j3 && j3.state === "journal_pending", "a journal row that doesn't read back identically keeps the job in journal_pending, with everything kept");
}

// the three paths @sagebrush asked to cover: collisions, concurrent first launches, erasure admission
{
  const seam = (op) => tool("/__test/seam", { method: "POST", body: JSON.stringify({ rid: R1.rid, op }) });
  const m0 = await reg1();
  const existing = m0.person_refs[0];
  ok(/^[0-9a-f]{32}$/.test(existing ?? ""), "a handle to collide with");
  // three collisions in a row: fail closed, nothing half-issued
  await seam({ force: [existing, existing, existing] });
  const z1 = await sessionFor("zed-1", "course-1");
  const m1 = await reg1();
  ok(z1.status === 503 && z1.error === "collision" && m1.persons === m0.persons && m1.person_courses === m0.person_courses, `three injected collisions fail closed with nothing issued (${z1.status} ${z1.error})`);
  // one collision: retried, and the next value is used
  const F1 = "c1".repeat(16), F2 = "c2".repeat(16);
  await seam({ force: [existing, F1, F2] });
  const z2 = await sessionFor("zed-2", "course-1");
  const m2 = await reg1();
  ok(z2.status === 200 && m2.persons === m0.persons + 1, "an injected collision is retried, and the launch succeeds");
  // two first launches for the same new subject at once: exactly one handle
  const [t1, t2] = await Promise.all([sessionFor("twin", "course-9"), sessionFor("twin", "course-9")]);
  const m3 = await reg1();
  ok(t1.status === 200 && t2.status === 200 && m3.persons === m2.persons + 1 && m3.person_courses === m2.person_courses + 1, `two concurrent first launches give one person and one membership (${m3.persons - m2.persons}, ${m3.person_courses - m2.person_courses})`);
  // erasure admission: the day's limit, the receipt cap (visible refusal), and compaction
  await seam({ admits: 200 });
  r = await admin("/lti/admin/erase", { owner_ref: "ownerA", rid: R1.rid, sub: "zed-2", erase_id: "erase-cap-00000001", issued_at: Date.now(), actor_ref: "adminA" });
  ok(r.status === 503 && (await j(r)).error === "erasure_capacity", "the 201st erasure of the day is refused visibly");
  await seam({ admits: 0, receipts: { n: 10000, age_ms: 0 } });
  r = await admin("/lti/admin/erase", { owner_ref: "ownerA", rid: R1.rid, sub: "zed-2", erase_id: "erase-cap-00000002", issued_at: Date.now(), actor_ref: "adminA" });
  ok(r.status === 503 && (await j(r)).error === "erasure_capacity", "with the receipt table full of fresh receipts, an erasure is refused visibly");
  await seam({ receipts: { n: 10000, age_ms: 31 * 86400_000 } });
  r = await admin("/lti/admin/erase", { owner_ref: "ownerA", rid: R1.rid, sub: "zed-2", erase_id: "erase-cap-00000003", issued_at: Date.now(), actor_ref: "adminA" });
  const e3 = await j(r);
  ok(r.status === 200 && (await reg1()).receipts < 10000, "with old receipts, compaction makes room and the erasure goes ahead");
  ok(e3.person_ref === F1, "zed-2's person handle is the value chosen after the injected collision");
  await seam({ receipts: { n: 0, age_ms: 0 } });
}

// ================= CORR-LTIA-1 (astra): a lower-role relaunch revokes the elevated session; a delayed older launch can't restore it
{
  const ticketOf = async (roles) => {
    const { state, nonce, cookie } = await cookieLogin();
    const html = await (await launchPost(signJwt(claims(state, nonce, { "https://purl.imsglobal.org/spec/lti/claim/roles": roles, sub: "ltia-1" })), state, cookie)).text();
    return { ticket: /open\("([0-9a-f]{32}:[0-9a-f]:[0-9a-f]{32})"\)/.exec(html)?.[1] ?? null, html };
  };
  const redeem = (ticket) => tool("/lti/session", { method: "POST", headers: sameOrigin, body: JSON.stringify({ ticket }) });
  const renewTok = (tok) => tool("/lti/session/renew", { method: "POST", headers: { ...sameOrigin, authorization: `Bearer ${tok}` }, body: "{}" });
  const I = [`${M}#Instructor`], L = [`${M}#Learner`], G = [`${M}#Mentor`];
  let si = await j(await redeem((await ticketOf(I)).ticket));
  ok((await renewTok(si.token)).status === 200, "(an instructor session renews)");
  let sl = await j(await redeem((await ticketOf(L)).ticket));
  ok(sl.role === "learner" && (await renewTok(si.token)).status === 401, "CORR-LTIA-1: a learner relaunch revokes the member's instructor session");
  ok((await renewTok(sl.token)).status === 200, "CORR-LTIA-1: the new learner session works");
  si = await j(await redeem((await ticketOf(I)).ticket));
  const g = await ticketOf(G);
  ok(g.ticket === null && /nothing for your role/.test(g.html) && (await renewTok(si.token)).status === 401, "CORR-LTIA-1: a guest relaunch revokes the member's instructor session");
  let older = (await ticketOf(I)).ticket;
  await new Promise((r) => setTimeout(r, 5));
  sl = await j(await redeem((await ticketOf(L)).ticket));
  let late = await redeem(older);
  ok(late.status === 403 && (await j(late)).error === "stale_launch" && (await renewTok(sl.token)).status === 200, "CORR-LTIA-1: an older instructor launch redeemed after a newer learner launch is refused (stale_launch)");
  older = (await ticketOf(I)).ticket;
  await new Promise((r) => setTimeout(r, 5));
  await ticketOf(G);
  late = await redeem(older);
  ok(late.status === 403 && (await j(late)).error === "stale_launch", "CORR-LTIA-1: an older instructor launch redeemed after a newer guest launch is refused");
  sl = await j(await redeem((await ticketOf(L)).ticket));
  si = await j(await redeem((await ticketOf(I)).ticket));
  ok(si.role === "instructor" && (await renewTok(sl.token)).status === 200 && (await renewTok(si.token)).status === 200, "a learner session survives the member's later instructor launch");
  const sl2 = await j(await redeem((await ticketOf(L)).ticket));
  const sl3 = await j(await redeem((await ticketOf(L)).ticket));
  ok((await renewTok(sl2.token)).status === 200 && (await renewTok(sl3.token)).status === 200 && (await renewTok(si.token)).status === 401, "two learner tabs both live; the instructor session before them is revoked");
}
// ================= CORR-LTIA-2 (astra): a policy edit in flight can't undo a revocation
{
  await tool("/__test/gate", { method: "POST", body: JSON.stringify({ name: "policy_update", on: true }) });
  const edit = admin("/lti/admin/policy", { owner_ref: "ownerA", rid: R2.rid, staff_ref: "staff1", policy: { ...R2.policy, framing_origins: [LMS, "https://extra2.vmtest"] } });
  await new Promise((r) => setTimeout(r, 150));
  const rv = await admin("/lti/admin/revoke", { owner_ref: "ownerA", rid: R2.rid, actor_ref: "adminA" });
  await tool("/__test/gate", { method: "POST", body: JSON.stringify({ name: "policy_update", on: false }) });
  const er = await edit;
  const st = (await db.prepare("SELECT state FROM registrations WHERE rid = ?").bind(R2.rid).first()).state;
  ok(rv.status === 200 && er.status === 409 && st === "revoked", `CORR-LTIA-2: the held edit after a revoke is refused and the registration stays revoked (${rv.status}, ${er.status}, ${st})`);
  let threw = false;
  try {
    await db.prepare("UPDATE registrations SET state = 'pending' WHERE rid = ?").bind(R2.rid).run();
  } catch {
    threw = true;
  }
  ok(threw && (await db.prepare("SELECT state FROM registrations WHERE rid = ?").bind(R2.rid).first()).state === "revoked", "CORR-LTIA-2: revoked is terminal for every write path (trigger)");
}
// ================= daybreak3's stage-A limits (LIMIT-STAGEA1-1..3), at the caps, against the charge errata
{
  // codes: 16,384 B fixed + 1,536 B a row, by the trigger's byte predicate; the 21st maximum-width code is refused
  const q = async () => db.prepare("SELECT count, bytes, cap_bytes FROM quota WHERE scope = 'env' AND kind = 'codes'").first();
  let c = await q();
  ok(c.bytes === 16384 + c.count * 1536 && c.cap_bytes === 47104, `codes are charged 16,384 B + 1,536 B a row (${JSON.stringify(c)})`);
  await db.prepare("DELETE FROM codes").run();
  const wide = { owner_ref: "o".repeat(64), owner_kind: "organization", actor_ref: "a", preset: "moodle", bootstrap_hosts: ["lms.vmtest"] };
  const st = [];
  for (let i = 0; i < 21; i++) st.push((await admin("/lti/admin/codes", wide)).status);
  c = await q();
  ok(st.slice(0, 20).every((s) => s === 200) && st[20] === 429 && c.count === 20 && c.bytes === 16384 + 20 * 1536, `20 maximum-width codes fit, the 21st is refused (${st.join(",")}; ${c.bytes} B)`);
  await db.prepare("DELETE FROM codes WHERE code_hash IN (SELECT code_hash FROM codes LIMIT 1)").run();
  await db.prepare("UPDATE quota SET cap_bytes = bytes + 1535 WHERE scope = 'env' AND kind = 'codes'").run();
  ok((await admin("/lti/admin/codes", wide)).status === 429, "the byte predicate binds on its own: 1 B short of a row's charge is refused");
  await db.prepare("UPDATE quota SET cap_bytes = 47104 WHERE scope = 'env' AND kind = 'codes'").run();
  // sessions: 20,000 accepted, the 20,001st refused; the store's growth stays inside the allocation
  const cs = "1".repeat(32);
  const before = await j(await tool("/__test/fill", { method: "POST", body: JSON.stringify({ course: cs }) }));
  const full = await j(await tool("/__test/fill", { method: "POST", body: JSON.stringify({ course: cs, sessions: 19999 }) }));
  const mk = (sub, member) => tool("/__test/session", { method: "POST", body: JSON.stringify({ course: cs, rid: R1.rid, sub, member, role: "learner", ago_ms: 0 }) });
  const s20000 = await j(await mk("s-a", "2".repeat(32)));
  const s20001 = await j(await mk("s-b", "3".repeat(32)));
  const after = await j(await tool("/__test/fill", { method: "POST", body: JSON.stringify({ course: cs }) }));
  ok(full.sessions === 19999 && s20000.ok && !s20001.ok && s20001.code === "sessions_full" && after.sessions === 20000, `the 20,000th session is made and the 20,001st refused (${after.sessions})`);
  console.log(`(20,000 maximum-width sessions: the store grew ${after.size - before.size} B)`);
  ok(after.size - before.size <= 16384 + 20000 * 200 + 16384 + 2 * 200, `20,000 maximum-width sessions (with amendment 5's handle) grow the store by ${after.size - before.size} B ≤ the allocation (charge errata r3: 200 B a row)`);
  // members: the 5,000th accepted, the 5,001st refused
  const cm = "4".repeat(32);
  await tool("/__test/fill", { method: "POST", body: JSON.stringify({ course: cm, members: 4999 }) });
  const mk2 = (member) => tool("/__test/session", { method: "POST", body: JSON.stringify({ course: cm, rid: R1.rid, sub: "x", member, role: "learner", ago_ms: 0 }) });
  const m5000 = await j(await mk2("5".repeat(32)));
  const m5001 = await j(await mk2("6".repeat(32)));
  ok(m5000.ok && !m5001.ok && m5001.code === "course_full", `the 5,000th member is admitted and the 5,001st refused (${JSON.stringify(m5001)})`);
  // shard tombstones are charged their measured size
  let cn = 0, cb = 0, un = 0, ub = 0;
  for (const d of "0123456789abcdef") {
    const ts = await j(await tool("/__test/shard-stats", { method: "POST", body: JSON.stringify({ name: `${R1.rid}:${d}` }) }));
    for (const r of ts.tx) if (r.status === "consumed") (cn += r.n), (cb += r.bytes);
    for (const r of ts.tickets) if (r.used === 1) (un += r.n), (ub += r.bytes);
  }
  ok(cn > 0 && cb === cn * 208, `every consumed transaction is charged 208 B (${cn} rows, ${cb} B)`);
  ok(un > 0 && ub === un * 112, `every used ticket is charged 112 B (${un} rows, ${ub} B)`);
}
// ================= CORR-LTIA-1, r2 (astra on 7d748910): every downward change is fenced, the strongest fence at one time
{
  const renewTok = (tok) => tool("/lti/session/renew", { method: "POST", headers: { ...sameOrigin, authorization: `Bearer ${tok}` }, body: "{}" });
  // astra's case 1: learner, then a guest relaunch, through real launches: the learner session ends
  const tk = async (roles) => {
    const { state, nonce, cookie } = await cookieLogin();
    const html = await (await launchPost(signJwt(claims(state, nonce, { "https://purl.imsglobal.org/spec/lti/claim/roles": roles, sub: "ltia-r2" })), state, cookie)).text();
    return /open\("([0-9a-f]{32}:[0-9a-f]:[0-9a-f]{32})"\)/.exec(html)?.[1] ?? null;
  };
  const sl = await j(await tool("/lti/session", { method: "POST", headers: sameOrigin, body: JSON.stringify({ ticket: await tk([`${M}#Learner`]) }) }));
  ok((await renewTok(sl.token)).status === 200, "(a learner session renews)");
  await tk([`${M}#Mentor`]);
  ok((await renewTok(sl.token)).status === 401, "CORR-LTIA-1 r2 (astra 1): a guest relaunch revokes the member's learner session");
  // the pairwise downgrades, with exact launch times: each ends the higher session, and an older higher launch is refused after it
  const course = "ab".repeat(16);
  let n = 0;
  const mem = () => (++n).toString(16).padStart(32, "d");
  const sess = (member, role, at) => tool("/__test/session", { method: "POST", body: JSON.stringify({ course, rid: R1.rid, sub: "p", member, role, at }) });
  const lowerAt = (member, at) => tool("/__test/lower", { method: "POST", body: JSON.stringify({ course, member, at }) });
  const renewS = (sid) => tool("/lti/session/renew", { method: "POST", headers: { ...sameOrigin, authorization: `Bearer ${course}.${sid}` }, body: "{}" });
  const T = Date.now();
  for (const [hi, lo] of [["instructor", "learner"], ["instructor", "guest"], ["learner", "guest"]]) {
    const m = mem();
    const a = await j(await sess(m, hi, T));
    const b = lo === "guest" ? await j(await lowerAt(m, T + 10)) : await j(await sess(m, lo, T + 10));
    const older = await j(await sess(m, hi, T + 5));
    ok(a.ok && b.ok && (await renewS(a.value.sid)).status === 401 && !older.ok && older.code === "stale_launch", `CORR-LTIA-1 r2: ${hi} -> ${lo} ends the ${hi} session, and an older ${hi} launch is refused after it`);
    if (lo !== "guest") ok((await renewS(b.value.sid)).status === 200, `(the ${lo} session lives)`);
  }
  // astra's case 2: learner then guest at the SAME time: the guest's (lower) fence holds, so a delayed same-time learner is refused
  {
    const m = mem();
    const L = await j(await sess(m, "learner", T));
    await lowerAt(m, T);
    const again = await j(await sess(m, "learner", T));
    const later = await j(await sess(m, "learner", T + 1));
    ok(L.ok && (await renewS(L.value.sid)).status === 401 && !again.ok && again.code === "stale_launch" && later.ok, `CORR-LTIA-1 r2 (astra 2): a guest at the same time as a learner fences the learner rank; a later learner launch is fine (${JSON.stringify(again)})`);
  }
  // the reverse order at one time: guest then learner, same timestamp: the lower fence still wins
  {
    const m = mem();
    await lowerAt(m, T);
    const L = await j(await sess(m, "learner", T));
    ok(!L.ok && L.code === "stale_launch", "CORR-LTIA-1 r2: guest then learner at one time: the guest's fence holds");
  }
  // upward changes and same-rank launches revoke nothing
  {
    const m = mem();
    const g = await j(await lowerAt(m, T));
    const L1 = await j(await sess(m, "learner", T + 1));
    const I = await j(await sess(m, "instructor", T + 2));
    const L2 = await j(await sess(m, "learner", T + 3));
    const L3 = await j(await sess(m, "learner", T + 4));
    ok(g.ok && L1.ok && I.ok && (await renewS(I.value.sid)).status === 401 && (await renewS(L2.value.sid)).status === 200 && (await renewS(L3.value.sid)).status === 200, "upgrades revoke nothing, a downgrade revokes the generation, same-rank launches after it revoke nothing");
  }
}
// ================= amendment 1's erasure: astra's CORR-LTIMAP-1..5 and daybreak3's LIMIT-STAGEA2-1..3
{
  const gate = (name, on) => tool("/__test/gate", { method: "POST", body: JSON.stringify({ name, on }) });
  const step = () => tool(`/__test/reg?rid=${R1.rid}&op=step&due=1`);
  const eraseAll = async (sub, id) => {
    const r = await admin("/lti/admin/erase", { owner_ref: "ownerA", rid: R1.rid, sub, erase_id: id, issued_at: Date.now(), actor_ref: "adminA" });
    for (let i = 0; i < 20 && (await reg1()).erasures.some((e) => e.erase_id === id); i++) await step();
    return r;
  };
  const ticketFor = async (sub, context) => {
    const { state, nonce, cookie } = await cookieLogin();
    const x = await launchPost(signJwt(claims(state, nonce, { sub, "https://purl.imsglobal.org/spec/lti/claim/context": { id: context } })), state, cookie);
    return /open\("([0-9a-f]{32}:[0-9a-f]:[0-9a-f]{32})"\)/.exec(await x.text())?.[1];
  };
  const redeem = (ticket) => tool("/lti/session", { method: "POST", headers: sameOrigin, body: JSON.stringify({ ticket }) });
  // CORR-LTIMAP-1 (a): a launch held after Reg's issue; the erasure runs to completion; the continuation resumes
  ok((await sessionFor("erz-1", "course-e")).status === 200, "(erz-1 has a session in course-e)");
  let t = await ticketFor("erz-1", "course-e");
  await gate("session_after_issue", true);
  let held = redeem(t);
  await new Promise((r) => setTimeout(r, 200));
  await eraseAll("erz-1", "erase-ltimap1-a-0001");
  await gate("session_after_issue", false);
  let late = await held;
  ok(late.status === 403 && (await j(late)).error === "erased", `CORR-LTIMAP-1: a continuation held after issue, resumed after the erasure completes, is refused (${late.status})`);
  // (b): held between setMember and create
  ok((await sessionFor("erz-2", "course-e")).status === 200, "(erz-2 has a session)");
  t = await ticketFor("erz-2", "course-e");
  await gate("session_before_create", true);
  held = redeem(t);
  await new Promise((r) => setTimeout(r, 200));
  await eraseAll("erz-2", "erase-ltimap1-b-0001");
  await gate("session_before_create", false);
  late = await held;
  ok(late.status === 403 && (await j(late)).error === "erased", `CORR-LTIMAP-1: a continuation held before create is refused (${late.status})`);
  // (c): a completed erasure, then a fresh launch: a new incarnation, with new handles
  const fresh = await sessionFor("erz-1", "course-e");
  ok(fresh.status === 200, `CORR-LTIMAP-1: after a completed erasure, a fresh launch opens a new incarnation (${fresh.status} ${fresh.error ?? ""})`);
  // CORR-LTIMAP-2: the completed journal decrypts from the backup key alone, after Reg's job state is gone
  const jr = await (await mf.getD1Database("LTI_AUDIT", "lti")).prepare("SELECT sealed FROM erase_journal WHERE erase_id = ?").bind("erase-ltimap1-a-0001").first();
  const env = /^v1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]+)$/.exec(jr?.sealed ?? "");
  let plain = null;
  if (env) {
    const { createDecipheriv, createHash } = await import("node:crypto");
    const ct = Buffer.from(env[2], "base64url");
    const d = createDecipheriv("aes-256-gcm", createHash("sha256").update("backup-test-key").digest(), Buffer.from(env[1], "base64url"));
    d.setAuthTag(ct.subarray(ct.length - 16));
    try { plain = JSON.parse(Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]).toString()); } catch {}
  }
  ok(!(await reg1()).erasures.some((e) => e.erase_id === "erase-ltimap1-a-0001") && plain && /^[0-9a-f]{32,64}$/.test(plain.person_int ?? ""), `CORR-LTIMAP-2: the journal envelope carries its nonce and decrypts with the backup key alone (${JSON.stringify(plain)?.slice(0, 40)})`);
  // CORR-LTIMAP-3: an absent-person erasure doesn't delete the memberships of an incarnation issued while it ran
  await gate("erase_journal", true);
  let r = await admin("/lti/admin/erase", { owner_ref: "ownerA", rid: R1.rid, sub: "ghost-1", erase_id: "erase-ltimap3-0000001", issued_at: Date.now(), actor_ref: "adminA" });
  ok(r.status === 200 && (await j(r)).person_ref === null, "(an erasure of a subject with no handles yet)");
  const g = await sessionFor("ghost-1", "course-g");
  const before3 = await reg1();
  await gate("erase_journal", false);
  for (let i = 0; i < 20 && (await reg1()).erasures.some((e) => e.erase_id === "erase-ltimap3-0000001"); i++) await step();
  const after3 = await reg1();
  ok(g.status === 200 && after3.person_courses === before3.person_courses && after3.persons === before3.persons, `CORR-LTIMAP-3: the later incarnation keeps its person and membership (${before3.person_courses} -> ${after3.person_courses})`);
  // CORR-LTIMAP-4: a replayed journal insert charges once, and a duplicate stays acknowledgeable at the cap
  const au = await mf.getD1Database("LTI_AUDIT", "lti");
  const jq = () => au.prepare("SELECT count, bytes, cap_count FROM quota WHERE scope = 'env' AND kind = 'erase_journal'").first();
  const q0 = await jq();
  const ins = (id) => au.prepare("INSERT INTO erase_journal (erase_id, rid, sealed, completed) VALUES (?, ?, 'v1.x', 0) ON CONFLICT (erase_id) DO NOTHING").bind(id, R1.rid).run();
  await ins("replay-journal-000001");
  await ins("replay-journal-000001");
  const q1 = await jq();
  const rows = (await au.prepare("SELECT count(*) AS n FROM erase_journal WHERE erase_id = 'replay-journal-000001'").first()).n;
  ok(rows === 1 && q1.count === q0.count + 1 && q1.bytes === q0.bytes + 160, `CORR-LTIMAP-4: a replayed insert adds one row and one charge (${q0.count} -> ${q1.count})`);
  await au.prepare("UPDATE quota SET cap_count = count WHERE scope = 'env' AND kind = 'erase_journal'").run();
  let dupOk = true, newRefused = false;
  try { await ins("replay-journal-000001"); } catch { dupOk = false; }
  try { await ins("replay-journal-000002"); } catch { newRefused = true; }
  ok(dupOk && newRefused && (await jq()).count === q1.count, "CORR-LTIMAP-4: at the cap, a duplicate is still acknowledged and a new row is refused");
  await au.prepare("UPDATE quota SET cap_count = 700000 WHERE scope = 'env' AND kind = 'erase_journal'").run();
  // CORR-LTIMAP-5: reconciliation concurrent with inserts and deletes never leaves a wrong counter
  await db.prepare("DELETE FROM codes").run();
  const ops = [];
  for (let i = 0; i < 6; i++) ops.push(admin("/lti/admin/codes", { owner_ref: "ownerR", owner_kind: "organization", actor_ref: "a", preset: "moodle", bootstrap_hosts: ["lms.vmtest"] }));
  ops.push(tool("/__test/scheduled"), tool("/__test/scheduled"));
  await Promise.all(ops);
  await db.prepare("DELETE FROM codes WHERE code_hash IN (SELECT code_hash FROM codes LIMIT 2)").run();
  await tool("/__test/scheduled");
  const cq = await db.prepare("SELECT count, bytes FROM quota WHERE scope = 'env' AND kind = 'codes'").first();
  const real = (await db.prepare("SELECT count(*) AS n FROM codes").first()).n;
  ok(cq.count === real && cq.bytes === 16384 + 1536 * real, `CORR-LTIMAP-5: with reconciliation racing inserts and deletes, the counter equals the rows (${cq.count}, ${real})`);
  // LIMIT-STAGEA2-1: a refused admission makes no fetch; an over-cap answer is cancelled at the cap
  ok((await sessionFor("lim-1", "course-l")).status === 200, "(lim-1 has handles)");
  // (the bucket deep in debt, so no refill can land during the steps: deterministic)
  await tool(`/__test/bucket?rid=${R1.rid}&kind=entitlement&spent=1`);
  const n0 = purges.length;
  await admin("/lti/admin/erase", { owner_ref: "ownerA", rid: R1.rid, sub: "lim-1", erase_id: "erase-limit-a2-00001", issued_at: Date.now(), actor_ref: "adminA" });
  for (let i = 0; i < 4; i++) await step();
  ok(purges.length === n0 && (await reg1()).erasures.some((e) => e.erase_id === "erase-limit-a2-00001" && e.state === "external"), `LIMIT-STAGEA2-1: with the entitlement bucket spent, the purge page isn't fetched (${purges.length - n0} calls)`);
  await tool(`/__test/bucket?rid=${R1.rid}&kind=entitlement&spent=0`);
  cocalcHuge = true;
  await step();
  cocalcHuge = false;
  ok((await reg1()).erasures.some((e) => e.erase_id === "erase-limit-a2-00001" && e.state === "external"), "LIMIT-STAGEA2-1: a 1 MiB answer isn't an acknowledgement");
  // (the reader itself, in the Worker, on a stream it can watch: Miniflare's outbound service buffers upstream bodies)
  const rc = await j(await tool("/__test/read-capped"));
  ok(rc.result === null && rc.cancelled && rc.pulled <= 16 * 1024 + 4096, `LIMIT-STAGEA2-1: readCapped cancels a 1 MiB body at the 16 KiB cap (pulled ${rc.pulled} B)`);
  ok(rc.small === "x".repeat(16384), "readCapped returns a body of exactly 16 KiB");
  for (let i = 0; i < 20 && (await reg1()).erasures.some((e) => e.erase_id === "erase-limit-a2-00001"); i++) await step();
  // LIMIT-STAGEA2-2: the caps are counters kept with the rows, not count(*)
  const tl = (await reg1()).tallies, mm = await reg1();
  ok(tl.persons === mm.persons && tl.person_courses === mm.person_courses, `LIMIT-STAGEA2-2: the counters equal the rows (${JSON.stringify(tl)})`);
  await tool("/__test/seam", { method: "POST", body: JSON.stringify({ rid: R1.rid, op: { tallies: { persons: 200000 } } }) });
  const full = await sessionFor("cap-new-person", "course-1");
  await tool("/__test/seam", { method: "POST", body: JSON.stringify({ rid: R1.rid, op: { tallies: { persons: tl.persons } } }) });
  ok(full.status === 429 && full.error === "registration_full", `LIMIT-STAGEA2-2: at the persons cap (by its counter) a new person is refused (${full.status} ${full.error})`);
  await tool("/__test/seam", { method: "POST", body: JSON.stringify({ rid: R1.rid, op: { tallies: { lost_handles: 1201000 - 100 } } }) });
  const page = Array.from({ length: 200 }, (_, i) => ({ seq: 900000 + i, handle: (i + 1).toString(16).padStart(32, "a"), kind: "person" }));
  const lostR = await j(await tool(`/__test/reconcile?rid=${R1.rid}`, { method: "POST", body: JSON.stringify({ handles: page }) }));
  const lostAfter = (await reg1()).lost.length;
  await tool("/__test/seam", { method: "POST", body: JSON.stringify({ rid: R1.rid, op: { tallies: { lost_handles: lostAfter } } }) });
  ok(lostR.ok === false && lostR.code === "lost_full" && lostAfter === mm.lost.length, `LIMIT-STAGEA2-2: a 200-handle page past the lost cap is refused whole, before any write (${JSON.stringify(lostR)})`);
  // LIMIT-STAGEA2-3: long-lived member churn in one course stays bounded
  const cc = "7".repeat(32);
  const { createHash: ch } = await import("node:crypto");
  const refOf = (member) => ch("sha256").update("member_ref:" + member).digest("hex").slice(0, 32);
  for (let i = 0; i < 300; i++) {
    const member = i.toString(16).padStart(32, "0");
    await tool("/__test/session", { method: "POST", body: JSON.stringify({ course: cc, rid: R1.rid, sub: "c", member, role: "learner", ago_ms: 0 }) });
    await tool(`/__test/course?course=${cc}&op=erase&ref=${refOf(member)}`);
  }
  const churn = await j(await tool("/__test/fill", { method: "POST", body: JSON.stringify({ course: cc }) }));
  ok(churn.members === 0 && churn.erased === 300 && churn.sessions === 0, `LIMIT-STAGEA2-3: 300 create/erase cycles leave no member rows or sessions, only the bounded tombstones (${JSON.stringify(churn)})`);
  {
  // CORR-LTIMAP-1 (astra on 23bec044): no tombstone is evicted early, even hours old; a full table refuses (fail closed)
  const ce = "6".repeat(32);
  const victim = "c0ffee".padEnd(32, "0");
  await tool("/__test/session", { method: "POST", body: JSON.stringify({ course: ce, rid: R1.rid, sub: "v", member: victim, role: "learner", ago_ms: 0 }) });
  const before5 = await j(await tool("/__test/fill", { method: "POST", body: JSON.stringify({ course: ce, erased: 4999, erasedAgeMs: 2 * 3600_000 }) }));
  const ev = await j(await tool(`/__test/course?course=${ce}&op=erase&ref=${refOf(victim)}`));
  const fullE = await j(await tool(`/__test/course?course=${ce}&op=erase&ref=${"9".repeat(32)}`));
  const late = await j(await tool("/__test/session", { method: "POST", body: JSON.stringify({ course: ce, rid: R1.rid, sub: "v", member: victim, role: "learner", ago_ms: 0 }) }));
  const after5 = await j(await tool("/__test/fill", { method: "POST", body: JSON.stringify({ course: ce }) }));
  ok(ev.ok && !fullE.ok && fullE.code === "erasure_busy" && after5.erased === 5000, `CORR-LTIMAP-1: at 5,000 tombstones (4,999 of them 2 h old) a new erasure is refused, and none is evicted (${JSON.stringify(fullE)}, ${after5.erased})`);
  ok(!late.ok && late.code === "erased", `CORR-LTIMAP-1: a late setMember and create for the erased ref, hours later, is refused (${JSON.stringify(late)})`);
  ok(after5.size - before5.size <= 336384 && after5.erased === 5000, `LIMIT-STAGEA2-3: 5,000 maximum-width tombstones are inside their 336,384 B charge (the store grew ${after5.size - before5.size} B from 4,999 + session rows)`);
  // only past 400 days does a tombstone go, making room
  const cc2 = "8".repeat(32);
  const f0 = await j(await tool("/__test/fill", { method: "POST", body: JSON.stringify({ course: cc2 }) }));
  const f1 = await j(await tool("/__test/fill", { method: "POST", body: JSON.stringify({ course: cc2, erased: 5000, erasedAgeMs: 401 * 86400_000 }) }));
  console.log(`(5,000 maximum-width tombstones: the store grew ${f1.size - f0.size} B)`);
  ok(f1.size - f0.size <= 336384, `LIMIT-STAGEA2-3: 5,000 tombstones grow a real DO by ${f1.size - f0.size} B ≤ 336,384 B (errata r3 addendum)`);
  const room = await j(await tool(`/__test/course?course=${cc2}&op=erase&ref=${"9".repeat(32)}`));
  const after4 = await j(await tool("/__test/fill", { method: "POST", body: JSON.stringify({ course: cc2 }) }));
  ok(room.ok === true && after4.erased <= 5000, `tombstones past 400 days are swept, making room (${after4.erased})`);
  // CORR-LTIMAP-6 (astra's repro): 101 concurrent erasures of distinct subjects against the 100-open-job cap
  await tool("/__test/gate", { method: "POST", body: JSON.stringify({ name: "erase_journal", on: true }) });
  const open0 = (await reg1()).erasures.length;
  const calls = Array.from({ length: 101 }, (_, i) => admin("/lti/admin/erase", { owner_ref: "ownerA", rid: R1.rid, sub: `race-${i}`, erase_id: `erase-race-${String(i).padStart(10, "0")}`, issued_at: Date.now(), actor_ref: "adminA" }));
  const res = await Promise.all(calls);
  const admitted = res.filter((r) => r.status === 200).length;
  const open1 = (await reg1()).erasures.length;
  ok(open1 === 100 && admitted === 100 - open0, `CORR-LTIMAP-6: 101 concurrent erasures leave exactly 100 open jobs (${open0} before, ${admitted} admitted, ${open1} open)`);
  await tool("/__test/gate", { method: "POST", body: JSON.stringify({ name: "erase_journal", on: false }) });
  for (let i = 0; i < 10 && (await reg1()).erasures.length; i++) await step();
  // the day's cap: at cap-1, three concurrent calls admit exactly one
  await tool("/__test/seam", { method: "POST", body: JSON.stringify({ rid: R1.rid, op: { admits: 199 } }) });
  const day = await Promise.all([0, 1, 2].map((i) => admin("/lti/admin/erase", { owner_ref: "ownerA", rid: R1.rid, sub: `day-${i}`, erase_id: `erase-daycap-${String(i).padStart(7, "0")}`, issued_at: Date.now(), actor_ref: "adminA" })));
  ok(day.filter((r) => r.status === 200).length === 1, `CORR-LTIMAP-6: at the day's cap - 1, three concurrent erasures admit exactly one (${day.map((r) => r.status)})`);
  await tool("/__test/seam", { method: "POST", body: JSON.stringify({ rid: R1.rid, op: { admits: 0 } }) });
  for (let i = 0; i < 10 && (await reg1()).erasures.length; i++) await step();
  // LIMIT-STAGEA2-2 r3: an open job holds the receipt it will write, so receipts + open jobs stay ≤ 10,000
  await tool("/__test/seam", { method: "POST", body: JSON.stringify({ rid: R1.rid, op: { receipts: { n: 0, age_ms: 0 } } }) });
  const g0 = await reg1();
  await tool("/__test/seam", { method: "POST", body: JSON.stringify({ rid: R1.rid, op: { receipts: { n: 9999 - g0.receipts - g0.erasures.length, age_ms: 0 } } }) });
  await tool("/__test/gate", { method: "POST", body: JSON.stringify({ name: "erase_journal", on: true }) });
  const near = await Promise.all(Array.from({ length: 20 }, (_, i) => admin("/lti/admin/erase", { owner_ref: "ownerA", rid: R1.rid, sub: `near-${i}`, erase_id: `erase-near-${String(i).padStart(10, "0")}`, issued_at: Date.now(), actor_ref: "adminA" })));
  const g1 = await reg1();
  ok(near.filter((r) => r.status === 200).length === 1 && g1.receipts + g1.erasures.length === 10000, `LIMIT-STAGEA2-2: with receipts + open jobs at 9,999, 20 concurrent erasures admit exactly 1 (${g1.receipts} receipts + ${g1.erasures.length} open)`);
  // completions concurrent with more starts: a completion trades its open row for its receipt, and nothing else gets in
  await tool("/__test/gate", { method: "POST", body: JSON.stringify({ name: "erase_journal", on: false }) });
  let peak = 0;
  for (let i = 0; i < 10; i++) {
    const [, ...more] = await Promise.all([step(), ...Array.from({ length: 3 }, (_, k) => admin("/lti/admin/erase", { owner_ref: "ownerA", rid: R1.rid, sub: `mix-${i}-${k}`, erase_id: `erase-mix-${String(i * 3 + k).padStart(11, "0")}`, issued_at: Date.now(), actor_ref: "adminA" }))]);
    const g = await reg1();
    peak = Math.max(peak, g.receipts + g.erasures.length);
    if (more.some((r) => r.status === 200)) peak = Infinity;
  }
  const g2 = await reg1();
  ok(peak === 10000 && g2.receipts <= 10000, `LIMIT-STAGEA2-2: starts during completions are all refused; receipts + open jobs peak at ${peak}, receipts end at ${g2.receipts}`);
  await tool("/__test/seam", { method: "POST", body: JSON.stringify({ rid: R1.rid, op: { admits: 0, receipts: { n: 0, age_ms: 0 } } }) });
  }
}
// ================= LIMIT-STAGEA3-1 (daybreak3): the 4 KiB bootstrap bounds are UTF-8 bytes, at every step
{
  await db.prepare("DELETE FROM codes").run();
  const code = async () => (await j(await admin("/lti/admin/codes", { owner_ref: "ownerM", owner_kind: "organization", actor_ref: "a", preset: "moodle", bootstrap_hosts: ["mb.vmtest"] }))).code;
  const enc = new TextEncoder();
  const fill = (base, bytes) => { const room = bytes - enc.encode(base).length; return base + "é".repeat(Math.floor(room / 2)) + "a".repeat(room % 2); };
  const fetched = (path) => seen.some(([u]) => u.startsWith(`https://mb.vmtest${path}`));
  // the configuration URL
  let u = fill("https://mb.vmtest/config?x=", 4097);
  ok(enc.encode(u).length === 4097 && u.length < 2100, "(a 4,097-byte URL of about 2,060 UTF-16 units)");
  seen.length = 0;
  let r = await reg(await code(), u);
  ok(r.status === 400 && !fetched("/config"), "LIMIT-STAGEA3-1: a 4,097-byte multibyte configuration URL is refused before any fetch");
  // as sent: a multibyte URL inside 4 KiB as given is about three times that percent-encoded, and is refused too
  const small = fill("https://mb.vmtest/config?x=", 2100);
  ok(enc.encode(small).length === 2100 && enc.encode(new URL(small).href).length > 4096, "(a 2,100-byte URL whose serialized form is over 4 KiB)");
  seen.length = 0;
  r = await reg(await code(), small);
  ok(r.status === 400 && !fetched("/config"), "LIMIT-STAGEA3-1: a URL over 4 KiB as serialized is refused before any fetch");
  seen.length = 0;
  await reg(await code(), "https://mb.vmtest/config?x=" + "a".repeat(4096 - 27));
  ok(fetched("/config"), "LIMIT-STAGEA3-1: a 4,096-byte one is fetched");
  seen.length = 0;
  r = await reg(await code(), "https://mb.vmtest/config?x=" + "a".repeat(4097 - 27));
  ok(r.status === 400 && !fetched("/config"), "and a 4,097-byte ASCII one is refused");
  // the registration token
  seen.length = 0;
  r = await reg(await code(), "https://mb.vmtest/config", encodeURIComponent("é".repeat(2049)));
  ok(r.status === 400 && !fetched("/config"), "LIMIT-STAGEA3-1: a 4,098-byte multibyte registration token is refused before any fetch");
  seen.length = 0;
  r = await reg(await code(), "https://mb.vmtest/config", "t".repeat(4097));
  ok(r.status === 400 && !fetched("/config"), "LIMIT-STAGEA3-1: a 4,097-byte token is refused");
  seen.length = 0;
  await reg(await code(), "https://mb.vmtest/config", "t".repeat(4096));
  ok(fetched("/config"), "a 4,096-byte token is accepted");
  // the registration endpoint from the configuration's answer
  mb.regEndpoint = fill("https://mb.vmtest/register?x=", 4097);
  seen.length = 0;
  r = await reg(await code(), "https://mb.vmtest/config");
  ok(fetched("/config") && !fetched("/register"), "LIMIT-STAGEA3-1: a 4,097-byte multibyte registration endpoint is refused before the POST");
  mb.regEndpoint = fill("https://mb.vmtest/register?x=", 2100);
  seen.length = 0;
  await reg(await code(), "https://mb.vmtest/config");
  ok(fetched("/config") && !fetched("/register"), "LIMIT-STAGEA3-1: a registration endpoint over 4 KiB as serialized is refused before the POST");
  mb.regEndpoint = "https://mb.vmtest/register?x=" + "a".repeat(4096 - 29);
  seen.length = 0;
  await reg(await code(), "https://mb.vmtest/config");
  ok(enc.encode(mb.regEndpoint).length === 4096 && fetched("/register"), "a 4,096-byte registration endpoint is posted to");
  mb.regEndpoint = undefined;
  // a redirect target
  mb.redirect = "https://mb.vmtest/config?x=" + "a".repeat(4097 - 27);
  seen.length = 0;
  r = await reg(await code(), "https://mb.vmtest/config-redirect");
  ok(enc.encode(mb.redirect).length === 4097 && fetched("/config-redirect") && !seen.some(([x]) => x.startsWith("https://mb.vmtest/config?")), "LIMIT-STAGEA3-1: a 4,097-byte redirect target isn't followed");
  mb.redirect = "https://mb.vmtest/config?x=" + "a".repeat(4096 - 27);
  seen.length = 0;
  await reg(await code(), "https://mb.vmtest/config-redirect");
  ok(seen.some(([x]) => x.startsWith("https://mb.vmtest/config?")), "a 4,096-byte redirect target is followed");
}
// ================= #6 carry-forward (CORR-LTIA-1 with amendment 5's ranks): instructor > TA > learner > guest, every downgrade fenced
{
  const course = "cd".repeat(16);
  let n = 0;
  const mem = () => (++n).toString(16).padStart(32, "e");
  const sess = (member, role, staff, at) => tool("/__test/session", { method: "POST", body: JSON.stringify({ course, rid: R1.rid, sub: "p", member, role, staff, at }) });
  const lowerAt = (member, at) => tool("/__test/lower", { method: "POST", body: JSON.stringify({ course, member, at }) });
  const renewS = (sid) => tool("/lti/session/renew", { method: "POST", headers: { ...sameOrigin, authorization: `Bearer ${course}.${sid}` }, body: "{}" });
  const T = Date.now();
  const R = { instructor: ["instructor", "instructor"], ta: ["instructor", "ta"], learner: ["learner", null] };
  for (const [hi, lo] of [["instructor", "ta"], ["ta", "learner"], ["ta", "guest"]]) {
    const m = mem();
    const a = await j(await sess(m, ...R[hi], T));
    const b = lo === "guest" ? await j(await lowerAt(m, T + 10)) : await j(await sess(m, ...R[lo], T + 10));
    const older = await j(await sess(m, ...R[hi], T + 5));
    ok(a.ok && a.value.staff === R[hi][1] && b.ok && (await renewS(a.value.sid)).status === 401 && !older.ok && older.code === "stale_launch", `#6: ${hi} -> ${lo} ends the ${hi} session, and an older ${hi} launch is refused after it`);
    if (lo !== "guest") ok((await renewS(b.value.sid)).status === 200 && b.value.staff === R[lo][1], `(the ${lo} session lives, staff ${R[lo][1]})`);
  }
  // upward: TA, then a full instructor launch, revokes nothing; same-time TA then guest: the guest's fence holds
  const m = mem();
  const ta = await j(await sess(m, ...R.ta, T));
  const ins = await j(await sess(m, ...R.instructor, T + 1));
  ok(ta.ok && ins.ok && (await renewS(ta.value.sid)).status === 200 && (await renewS(ins.value.sid)).status === 200, "#6: TA then instructor (an upgrade) revokes nothing");
  const m2 = mem();
  await j(await sess(m2, ...R.ta, T));
  await lowerAt(m2, T);
  const again = await j(await sess(m2, ...R.ta, T));
  ok(!again.ok && again.code === "stale_launch", "#6: a TA and a guest at one time: the guest's fence holds");
}
// ================= stage B: deep linking (r5 §4)
{
  const { createVerify } = await import("node:crypto");
  const shaA = await heldBundle("ownerA"), shaA2 = await heldBundle("ownerA"), shaB = await heldBundle("ownerB");
  const mkA = async (owner, title, visibility, max_points = 10, sha = owner === "ownerB" ? shaB : shaA) => (await j(await admin("/lti/admin/assignment", { owner_ref: owner, actor_ref: "a", title, runtime_policy: "either", max_points, visibility, bundle_sha: sha, ...(visibility === "public" ? { staff_ref: "staff1" } : {}) }))).aid;
  const A1 = await mkA("ownerA", "Limits worksheet", "institution");
  const A2 = await mkA("ownerA", "Public primer", "public", 0);
  const A3 = await mkA("ownerB", "B's private quiz", "institution");
  ok([A1, A2, A3].every((a) => /^[0-9a-f]{32}$/.test(a ?? "")), "assignments are created by the admin call");
  r = await admin("/lti/admin/assignment", { owner_ref: "ownerB", actor_ref: "a", aid: A1, expected_rev: 1, title: "x", runtime_policy: "either", max_points: 1, visibility: "institution", bundle_sha: shaB });
  ok(r.status === 404, "another owner can't revise an assignment");
  r = await admin("/lti/admin/assignment", { owner_ref: "ownerA", actor_ref: "a", aid: A1, expected_rev: 1, title: "Limits worksheet", runtime_policy: "either", max_points: 10, visibility: "institution", bundle_sha: shaA2 });
  ok((await j(r)).rev === 2, "a revision bumps rev");
  const settings = (over = {}) => ({ deep_link_return_url: `${LMS}/dl/return`, accept_types: ["ltiResourceLink"], accept_presentation_document_targets: ["iframe", "window"], accept_multiple: true, accept_lineitem: true, data: "opaque-xyz", ...over });
  async function dlLaunch(over = {}, roles = [`${M}#Instructor`]) {
    await tool(`/__test/refill?rid=${R1.rid}&kind=launch`);
    const lr = await tool(`/lti/login?iss=${encodeURIComponent(iss)}&login_hint=u1&target_link_uri=${encodeURIComponent(TOOL + "/lti/deeplink")}&client_id=${client}&lti_deployment_id=${dep}`);
    const loc = new URL(lr.headers.get("location"));
    const state = loc.searchParams.get("state"), nonce = loc.searchParams.get("nonce"), cookie = (lr.headers.get("set-cookie") ?? "").split(";")[0];
    const c = claims(state, nonce, {
      "https://purl.imsglobal.org/spec/lti/claim/target_link_uri": TOOL + "/lti/deeplink",
      "https://purl.imsglobal.org/spec/lti/claim/message_type": "LtiDeepLinkingRequest",
      "https://purl.imsglobal.org/spec/lti/claim/resource_link": undefined,
      "https://purl.imsglobal.org/spec/lti/claim/roles": roles,
      "https://purl.imsglobal.org/spec/lti-dl/claim/deep_linking_settings": settings(over),
    });
    const x = await launchPost(signJwt(c), state, cookie);
    const html = await x.text();
    const ticket = /open\("([0-9a-f]{32}:[0-9a-f]:[0-9a-f]{32})"\)/.exec(html)?.[1];
    if (!ticket) return { status: x.status, html };
    const sj = await j(await tool("/lti/session", { method: "POST", headers: sameOrigin, body: JSON.stringify({ ticket }) }));
    return { status: x.status, html, dl: sj.deep_link };
  }
  const form = (path, fields) => tool(path, { method: "POST", headers: { "sec-fetch-site": "same-origin", origin: TOOL, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
  const parseResponse = (html) => {
    const action = /<form id="f" method="post" action="([^"]+)"/.exec(html)?.[1]?.replace(/&amp;/g, "&");
    const jwt = /name="JWT" value="([^"]+)"/.exec(html)?.[1];
    if (!jwt) return null;
    const [h, p, sg] = jwt.split(".");
    const v = createVerify("RSA-SHA256");
    v.update(h + "." + p);
    return { action, header: JSON.parse(Buffer.from(h, "base64url")), payload: JSON.parse(Buffer.from(p, "base64url")), valid: v.verify(toolKeys.publicKey, Buffer.from(sg, "base64url")) };
  };
  const ITEMS = "https://purl.imsglobal.org/spec/lti-dl/claim/content_items", DATA = "https://purl.imsglobal.org/spec/lti-dl/claim/data";
  // the normal path: picker lists own + public, never another institution's private one
  const d1 = await dlLaunch();
  ok(/^[0-9a-f]{32}:[0-9a-f]:[0-9a-f]{32}$/.test(d1.dl ?? ""), "an instructor's deep-link launch opens a deep-link transaction");
  const pk = await (await form("/lti/deeplink/pick", { dl: d1.dl })).text();
  ok(pk.includes("Limits worksheet") && pk.includes("Public primer") && !pk.includes("B's private quiz"), "the picker lists the institution's and public assignments only");
  // the browser tries to edit the return URL and deployment: ignored, the response is built from the transaction
  const resp = await (await form("/lti/deeplink/respond", { dl: d1.dl, aid: A1, target: "window", return_url: "https://evil.vmtest/steal", deployment: "dep-other" })).text();
  const pr = parseResponse(resp);
  ok(pr && pr.valid && pr.header.kid === "tool1" && pr.header.alg === "RS256", "the response JWT is signed with TOOL_KEY (RS256, kid)");
  ok(pr && pr.action === `${LMS}/dl/return` && pr.payload["https://purl.imsglobal.org/spec/lti/claim/deployment_id"] === dep, "a browser-edited return URL and deployment never reach the signed response");
  const it = pr?.payload[ITEMS]?.[0];
  ok(pr && pr.payload.iss === client && JSON.stringify(pr.payload.aud) === JSON.stringify([iss]) && pr.payload["https://purl.imsglobal.org/spec/lti/claim/message_type"] === "LtiDeepLinkingResponse" && pr.payload["https://purl.imsglobal.org/spec/lti/claim/version"] === "1.3.0", "iss, aud, message type and version are as §4.4 says");
  ok(it && it.type === "ltiResourceLink" && it.url === TOOL + "/lti/app" && it.custom.sb_assignment === A1 && it.custom.sb_rev === "2" && /^[0-9a-f]{32}$/.test(it.custom.sb_item ?? "") && it.window && it.lineItem?.scoreMaximum === 10 && it.lineItem.resourceId === A1, "the item pins (aid, rev), opens in a window, and has its line item");
  ok(pr && pr.payload[DATA] === "opaque-xyz", "the request's data is echoed exactly");
  const dlPin = await content.prepare("SELECT aid, rev FROM pins WHERE kind = 'dl' AND rid = ? AND item = ?").bind(R1.rid, it?.custom.sb_item ?? "").first();
  ok(dlPin && dlPin.aid === A1 && dlPin.rev === 2, "amend3 §7: the deep link writes a pin, at the current rev, before the response is signed");
  r = await form("/lti/deeplink/respond", { dl: d1.dl, aid: A1, target: "window" });
  ok(r.status === 400, "a deep-link transaction is single use");
  // the deep-link pin cap (amendment 3 §4): an item over it is refused before anything is signed
  const qdl = await content.prepare("SELECT count FROM quota WHERE scope = ? AND kind = 'dl_pins'").bind(R1.rid).first();
  await content.prepare("UPDATE quota SET cap_count = ? WHERE scope = ? AND kind = 'dl_pins'").bind(qdl.count, R1.rid).run();
  const dcap = await dlLaunch();
  const rcap = await form("/lti/deeplink/respond", { dl: dcap.dl, aid: A1, target: "window" });
  const rcapText = await rcap.text();
  ok(rcap.status === 429 && rcapText.includes("Too many") && !parseResponse(rcapText), `deep-link pins: over the cap, the item is refused and nothing is signed (${rcap.status})`);
  await content.prepare("UPDATE quota SET cap_count = 10000 WHERE scope = ? AND kind = 'dl_pins'").bind(R1.rid).run();
  // refusals that never reach a signed response
  const d2 = await dlLaunch();
  ok((await form("/lti/deeplink/respond", { dl: d2.dl, aid: A3, target: "iframe" })).status === 400, "another institution's private assignment is refused");
  ok((await form("/lti/deeplink/respond", { dl: d2.dl, aid: "9".repeat(32), target: "iframe" })).status === 400, "a missing assignment is refused the same way");
  const d3 = await dlLaunch({ accept_multiple: false });
  ok((await form("/lti/deeplink/respond", { dl: d3.dl, aid: [A1, A2].join(), target: "iframe" })).status === 400, "a malformed assignment list is refused");
  const d3b = new URLSearchParams([["dl", d3.dl], ["aid", A1], ["aid", A2], ["target", "iframe"]]);
  ok((await tool("/lti/deeplink/respond", { method: "POST", headers: { "sec-fetch-site": "same-origin", origin: TOOL, "content-type": "application/x-www-form-urlencoded" }, body: d3b.toString() })).status === 400, "accept_multiple: false refuses two items");
  const d4 = await dlLaunch({ accept_presentation_document_targets: ["window"] });
  ok((await form("/lti/deeplink/respond", { dl: d4.dl, aid: A1, target: "iframe" })).status === 400, "a window-only placement refuses the iframe target");
  const r4 = parseResponse(await (await form("/lti/deeplink/respond", { dl: d4.dl, aid: A2, target: "window" })).text());
  ok(r4 && r4.valid && !r4.payload[ITEMS][0].lineItem, "a window-only request works, and a 0-point assignment gets no line item");
  const d5 = await dlLaunch({ accept_types: ["file", "html"] });
  ok((await (await form("/lti/deeplink/pick", { dl: d5.dl })).text()).includes("can't take Sagebrush"), "an unsupported accept_types is told plainly");
  ok((await form("/lti/deeplink/respond", { dl: d5.dl, aid: A1, target: "iframe" })).status === 400, "...and can't be answered with an item");
  const d6 = await dlLaunch({ data: undefined, accept_lineitem: undefined });
  const r6 = parseResponse(await (await form("/lti/deeplink/respond", { dl: d6.dl, aid: A1, target: "iframe" })).text());
  ok(r6 && r6.valid && !(DATA in r6.payload) && !r6.payload[ITEMS][0].lineItem && r6.payload[ITEMS][0].iframe, "absent data is absent in the response; absent accept_lineitem means no line item");
  const d7 = await dlLaunch();
  const r7res = await form("/lti/deeplink/respond", { dl: d7.dl, cancel: "1" });
  const r7 = parseResponse(await r7res.text());
  ok(r7 && r7.valid && Array.isArray(r7.payload[ITEMS]) && r7.payload[ITEMS].length === 0, "a cancel answers an empty content_items");
  ok(/form-action 'self' https:\/\/lms\.vmtest/.test(r7res.headers.get("content-security-policy") ?? ""), "the auto-submit page may post only to the return URL's origin");
  ok((await form("/lti/deeplink/respond", { dl: d7.dl, aid: A1, target: "iframe" })).status === 400, "...and consumes the transaction");
  const dl8 = await dlLaunch({}, [`${M}#Learner`]);
  ok(!dl8.dl && /nothing for your role/.test(dl8.html), "a learner's deep-link request gets the guest page");
  const d9 = await dlLaunch({ deep_link_return_url: "https://evil.vmtest/return" });
  ok(!d9.dl && d9.status === 400, "a return URL outside the registration's origins is refused at launch");
  ok((await tool("/lti/deeplink/pick", { method: "POST", headers: { "sec-fetch-site": "cross-site", origin: "https://evil.vmtest", "content-type": "application/x-www-form-urlencoded" }, body: `dl=${d2.dl}` })).status === 403, "the picker refuses a cross-site POST");
}

// ================= #8: CORR-LTIDL-1 / LIMIT-PR8-1 (the deep link's two rows admitted together) and LIMIT-PR8-2 (no audit for a refusal)
{
  const SHARD_ROWS = 2000, SHARD_BYTES = 4 * 1024 * 1024;
  const settingsDL = { deep_link_return_url: `${LMS}/dl/return`, accept_types: ["ltiResourceLink"], accept_presentation_document_targets: ["iframe", "window"], accept_multiple: true, accept_lineitem: true, data: "d".repeat(300) };
  const dlClaims = (state, nonce) => claims(state, nonce, {
    "https://purl.imsglobal.org/spec/lti/claim/target_link_uri": TOOL + "/lti/deeplink",
    "https://purl.imsglobal.org/spec/lti/claim/message_type": "LtiDeepLinkingRequest",
    "https://purl.imsglobal.org/spec/lti/claim/resource_link": undefined,
    "https://purl.imsglobal.org/spec/lti/claim/roles": [`${M}#Instructor`],
    "https://purl.imsglobal.org/spec/lti/claim/context": { id: "course-dl", title: "T".repeat(200) },
    "https://purl.imsglobal.org/spec/lti-dl/claim/deep_linking_settings": settingsDL,
  });
  // (each login's own shard, by its state's first digit; padding there reaches an exact level)
  const lvlOf = (L) => async (pad = 0, padRows = 0) => j(await tool("/__test/shard-level", { method: "POST", body: JSON.stringify({ name: `${R1.rid}:${L.state[0]}`, pad, padRows }) }));
  // a deep-link login whose transaction lands in shard f; cookie or storage mode
  const loginF = async (storage) => {
    await tool(`/__test/refill?rid=${R1.rid}&kind=launch`);
    for (let i = 0; ; i++) {
      const r = await tool(`/lti/login?iss=${encodeURIComponent(iss)}&login_hint=u1&target_link_uri=${encodeURIComponent(TOOL + "/lti/deeplink")}&client_id=${client}&lti_deployment_id=${dep}${storage ? "&lti_storage_target=_parent" : ""}`);
      let state, nonce, cookie = null;
      if (storage) {
        const html = await r.text();
        state = /put\("sb_state_" \+ K, "([0-9a-f]{64})"\)/.exec(html)?.[1];
        nonce = /put\("sb_nonce_" \+ K, "([0-9a-f]{64})"\)/.exec(html)?.[1];
      } else {
        const at = r.headers.get("location");
        const loc = at ? new URL(at) : null;
        state = loc?.searchParams.get("state"), nonce = loc?.searchParams.get("nonce"), cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
      }
      if (state) return { state, nonce, cookie, jwt: signJwt(dlClaims(state, nonce)) };
      // (the registration's launch bucket, spent by this file's many launches: wait for its refill)
      if (i >= 30) throw new Error(`login ${r.status}`);
      await new Promise((res) => setTimeout(res, 2000));
    }
  };
  // the step that makes the ticket: cookie consume at the launch, or storage mode's verify
  let lastVerify = "";
  const step = async (L, storage) => {
    if (!storage) return /open\("([0-9a-f]{32}:[0-9a-f]:[0-9a-f]{32})"\)/.test(await (await launchPost(L.jwt, L.state, L.cookie)).text());
    if (!L.corr) L.corr = /corr: "([^"]+)"/.exec(await (await launchPost(L.jwt, L.state, null)).text())?.[1];
    const v = await tool("/lti/launch/verify", { method: "POST", headers: sameOrigin, body: JSON.stringify({ corr: L.corr, state: L.state, nonce: L.nonce }) });
    const vb = await v.text();
    lastVerify = `${v.status} ${vb.slice(0, 80)} corr=${!!L.corr}`;
    return v.status === 200 && !!JSON.parse(vb).ticket;
  };
  for (const storage of [false, true]) {
    const mode = storage ? "storage verify" : "cookie consume";
    // the delta of one transition, measured: two rows, and its exact bytes (the ticket here is over 512 B)
    const A = await loginF(storage);
    let lvl = lvlOf(A);
    await lvl();
    if (storage) A.corr = /corr: "([^"]+)"/.exec(await (await launchPost(A.jwt, A.state, null)).text())?.[1];
    const a0 = await lvl();
    ok(await step(A, storage), `(${mode}: a deep link makes its ticket)`);
    const a1 = await lvl();
    const D = a1.bytes - a0.bytes;
    ok(a1.rows - a0.rows === 2, `${mode}: a deep link takes two rows (+${a1.rows - a0.rows}; net ${D} B, the consumed transaction's tombstone included)`);
    // rows: at 1,999 the pair is refused and nothing is written; the retry at 1,998 fills exactly 2,000
    const B = await loginF(storage);
    if (storage) B.corr = /corr: "([^"]+)"/.exec(await (await launchPost(B.jwt, B.state, null)).text())?.[1];
    lvl = lvlOf(B);
    const base = (await lvl()).rows;
    ok((await lvl(0, SHARD_ROWS - 1 - base)).rows === SHARD_ROWS - 1, `(${mode}: the shard at 1,999 rows)`);
    const refused = !(await step(B, storage));
    ok(refused && (await lvl()).rows === base, `CORR-LTIDL-1 (${mode}): at 1,999 rows the deep link's two rows are refused, and nothing is written`);
    await lvl(0, SHARD_ROWS - 2 - base);
    const made = await step(B, storage);
    ok(made && (await lvl(0, SHARD_ROWS - 2 - base)).rows === SHARD_ROWS, `CORR-LTIDL-1 (${mode}): the transaction stayed retryable, and at 1,998 the retry makes both rows: exactly 2,000`);
    // (every padded shard is emptied once its check is done: a full shard left behind, partly swept, could
    // admit a later login's transaction but not its storage-mode launch, and refuse that check by accident)
    await lvl();
    // bytes: one byte over is refused; exactly at the cap is admitted (with the sweep held, so no expiring bucket moves the level)
    await tool("/__test/gate", { method: "POST", body: JSON.stringify({ name: "shard_sweep", on: true }) });
    for (const over of [1, 0]) {
      const C = await loginF(storage);
      if (storage) C.corr = /corr: "([^"]+)"/.exec(await (await launchPost(C.jwt, C.state, null)).text())?.[1];
      lvl = lvlOf(C);
      const c0 = await lvl();
      const c1 = await lvl(SHARD_BYTES - c0.bytes - D + over);
      const made = await step(C, storage);
      const c2 = await lvl(SHARD_BYTES - c0.bytes - D + over);
      ok(over ? !made : made && c2.bytes === SHARD_BYTES, `LIMIT-PR8-1 (${mode}): ${over ? "one byte over the cap is refused" : "exactly at the 4 MiB cap is admitted"} (${c1.bytes} + ${D}; made ${made}, now ${c2.bytes}; verify ${lastVerify})`);
      await lvl();
    }
    await tool("/__test/gate", { method: "POST", body: JSON.stringify({ name: "shard_sweep", on: false }) });
    await lvl();
  }
  // CORR-LTIDL-2 r2 (astra): only SQLite's exact abort forms are confirmed refusals; text that merely mentions the words is not
  const cls = async (message) => (await j(await tool("/__test/classify", { method: "POST", body: JSON.stringify({ message }) }))).refusal;
  const real = {
    "D1_ERROR: quota: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)": "quota",
    "D1_ERROR: owner_immutable: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)": "owner_immutable",
    "D1_ERROR: UNIQUE constraint failed: registrations.iss, registrations.client_id: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)": "exists",
    "D1_ERROR: UNIQUE constraint failed: admin_requests.request_id: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)": "exists",
  };
  const misleading = ["Network connection lost while updating quota", "D1_ERROR: quota", "quota: SQLITE_CONSTRAINT", "D1_ERROR: Network connection lost while checking UNIQUE constraint", "owner_immutable", "D1_ERROR: quota: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER) after the commit", "Network connection lost.", "D1_ERROR: internal error"];
  const realOk = (await Promise.all(Object.entries(real).map(async ([m, want]) => (await cls(m)) === want))).every(Boolean);
  const misOk = (await Promise.all(misleading.map(async (m) => (await cls(m)) === null))).every(Boolean);
  ok(realOk && misOk, `CORR-LTIDL-2 r2: SQLite's exact abort forms (as captured from D1) are refusals; ${misleading.length} misleading or transport messages are not`);
}
// ================= amendment 3 r15 (A3-1): LtiContent, uploads, the gate, pins (§1–§4, §7)
{
  const au = await mf.getD1Database("LTI_AUDIT", "lti");
  const r2 = await mf.getR2Bucket("LTI_BUNDLES", "lti");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rqid = () => randomUUID().replace(/-/g, "");
  // (each gated call here starts with the gate's buckets full, so a refusal is the case under test, not this file's pace)
  const reset = () => cgate("testSeam", { bucket: "reset" });
  const q = (sql, ...p) => content.prepare(sql).bind(...p).first();
  const qa = async (sql, ...p) => (await content.prepare(sql).bind(...p).all()).results;
  const quota = (scope, kind) => q("SELECT count, bytes, cap_count, cap_bytes FROM quota WHERE scope = ? AND kind = ?", scope, kind);
  const setCap = (scope, kind, count, bytes) => content.prepare(`UPDATE quota SET cap_count = ?${bytes === undefined ? "" : ", cap_bytes = ?"} WHERE scope = ? AND kind = ?`).bind(...(bytes === undefined ? [count] : [count, bytes]), scope, kind).run();
  const asg = async (body) => {
    await reset();
    return admin("/lti/admin/assignment", { actor_ref: "a", title: "T", runtime_policy: "either", max_points: 5, visibility: "institution", ...body });
  };
  // (a client's retry on 429 resolving, after its retry_after: shortened here)
  const asgRetry = async (body) => {
    for (let i = 0; ; i++) {
      const r = await asg(body);
      if (r.status !== 429 || i >= 40) return r;
      await new Promise((res) => setTimeout(res, 250));
    }
  };
  const put = async (owner, body, o) => {
    await reset();
    return putBundle(owner, body, o);
  };
  const aborts = async (sql, code, ...p) => {
    try {
      await content.prepare(sql).bind(...p).run();
      return false;
    } catch (e) {
      return String(e?.message).includes(code);
    }
  };
  const auditOf = async (request_id) => (await au.prepare("SELECT action, detail FROM audit WHERE detail LIKE ? ORDER BY id").bind(`%"request_id":"${request_id}"%`).all()).results.map((r) => ({ action: r.action, ...JSON.parse(r.detail) }));
  const gstate = () => cgate("testState");
  const parkedOn = async (name) => {
    for (let i = 0; i < 500 && !(await j(await tool(`/__test/gate?name=${name}`))).parked; i++) await sleep(10);
  };
  const oneShot = (name, on) => tool("/__test/gate", { method: "POST", body: JSON.stringify({ name, on, once: true }) });

  // ---- §2.2 uploads
  const OW = "ownerU";
  const b1 = "synthetic bundle: one";
  const s1 = sha256hex(Buffer.from(b1));
  let res = await put(OW, b1);
  let body = await j(res);
  ok(res.status === 200 && body.deduplicated === false && body.sha256 === s1, `an upload is stored and held (${res.status} ${JSON.stringify(body)})`);
  const row1 = await q("SELECT state, size, refs, token, seen_cycle FROM bundles WHERE owner_ref = ? AND sha = ?", OW, s1);
  const keys0 = (await r2.list({ prefix: "o/" })).objects.map((o) => o.key);
  ok(row1?.state === "held" && row1.size === b1.length && row1.refs === 0 && keys0.some((k) => k.endsWith(`/${s1}/${row1.token}`)), "...its row is held, with its size, and its object is at its own incarnation's key");
  let qo = await quota(OW, "bundles");
  ok(qo.count === 1 && qo.bytes === b1.length, `...charged once, its exact bytes (${JSON.stringify(qo)})`);
  res = await put(OW, b1);
  body = await j(res);
  const qo2 = await quota(OW, "bundles");
  ok(res.status === 200 && body.deduplicated === true && qo2.count === 1 && qo2.bytes === b1.length && (await r2.list({ prefix: "o/" })).objects.length === keys0.length, "a re-upload of a held bundle is deduplicated, with no new charge and no new object");
  // a wrong SHA-256: R2 refuses the bytes; the reservation (and its charge) are the sweep's, after deadline + 1 h (A3-2)
  res = await put(OW, "synthetic bundle: mislabelled", { sha: "0".repeat(64) });
  const mis = await q("SELECT state, deadline, due FROM bundles WHERE owner_ref = ? AND sha = ?", OW, "0".repeat(64));
  ok(res.status === 400 && (await j(res)).error === "bundle_mismatch" && mis?.state === "reserved" && mis.due === mis.deadline + 3600_000, `an upload with a wrong SHA-256 is refused, and its reservation is left for the sweep (${res.status}, ${JSON.stringify(mis)})`);
  res = await put(OW, "synthetic bundle: short", { size: 99 });
  ok(res.status === 400 && !(await q("SELECT 1 AS x FROM bundles WHERE sha = ?", sha256hex(Buffer.from("synthetic bundle: short")))), "an upload whose body isn't its signed size is refused before anything is reserved");
  ok((await put(OW, b1, { key: "wrong" })).status === 401, "an upload with a wrong signature is refused");
  ok((await put(OW, b1, { size: 25 * 1024 * 1024 + 1 })).status === 400, "a bundle over 25 MiB is refused from its signed size");
  // another owner's hash is no bundle of yours
  res = await asg({ owner_ref: "ownerV", bundle_sha: s1 });
  ok(res.status === 404 && (await j(res)).error === "no_bundle" && !(await q("SELECT 1 AS x FROM owners WHERE owner_ref = 'ownerV'")), "another owner's hash is answered no_bundle, and nothing is written");
  // a hold after the deadline fails: the gate's clock set so the upload deadline is 2.5 s away, the hold held past it
  await cgate("testSeam", { skew: -(10 * 60_000 - 2500) });
  await oneShot("bundle_before_hold", true);
  await reset();
  const lateHold = putBundle(OW, "synthetic bundle: late hold");
  await parkedOn("bundle_before_hold");
  await sleep(3000);
  await oneShot("bundle_before_hold", false);
  res = await lateHold;
  await cgate("testSeam", { skew: 0 });
  const lh = await q("SELECT state FROM bundles WHERE owner_ref = ? AND sha = ?", OW, sha256hex(Buffer.from("synthetic bundle: late hold")));
  ok(res.status === 503 && lh?.state === "reserved", `a hold attempt after its deadline fails, and the row stays reserved (${res.status}, ${lh?.state})`);
  // pause between reserve and hold: live stays above 0 until it holds; new tickets are refused meanwhile
  await oneShot("bundle_before_hold", true);
  await reset();
  const pausedUp = putBundle(OW, "synthetic bundle: paused");
  await parkedOn("bundle_before_hold");
  await cgate("setMode", "paused");
  const live1 = await cgate("live");
  const upP = await put(OW, "synthetic bundle: refused while paused");
  const asP = await asg({ owner_ref: OW, bundle_sha: s1 });
  await oneShot("bundle_before_hold", false);
  res = await pausedUp;
  const live2 = await cgate("live");
  ok(live1 >= 1 && upP.status === 503 && asP.status === 503 && res.status === 200 && live2 === 0, `LIMIT-LTI5A3-2 (3): paused, an upload between reserve and hold keeps live > 0 until it holds, and new uploads and assignment writes answer 503 (${live1}, ${upP.status}, ${asP.status}, ${res.status}, ${live2})`);
  await cgate("setMode", "recovering");
  ok((await asg({ owner_ref: OW, bundle_sha: s1 })).status === 503 && (await put(OW, "synthetic bundle: recovering")).status === 503, "in recovering, uploads and assignment writes answer 503");
  await cgate("setMode", "normal");
  // bundle caps: count, owner bytes, environment bytes; the N-th admitted, the N+1-th refused with nothing charged
  qo = await quota(OW, "bundles");
  await setCap(OW, "bundles", qo.count + 1);
  const c1 = await put(OW, "synthetic bundle: cap n");
  const c2 = await put(OW, "synthetic bundle: cap n+1");
  const qc = await quota(OW, "bundles");
  ok(c1.status === 200 && c2.status === 507 && qc.count === qo.count + 1, `per-owner bundles: the N-th is accepted, the N+1-th refused, nothing charged (${c1.status}, ${c2.status})`);
  await setCap(OW, "bundles", 20100);
  const nb = "synthetic bundle: bytes";
  qo = await quota(OW, "bundles");
  await setCap(OW, "bundles", 20100, qo.bytes + nb.length);
  const y1 = await put(OW, nb);
  qo = await quota(OW, "bundles");
  await setCap(OW, "bundles", 20100, qo.bytes + nb.length);
  const y2 = await put(OW, nb + "!");
  ok(y1.status === 200 && y2.status === 507 && (await quota(OW, "bundles")).bytes === qo.bytes, `per-owner bytes: exactly at the cap is accepted, a byte over refused (${y1.status}, ${y2.status})`);
  await setCap(OW, "bundles", 20100, 5368709120);
  const qe = await quota("env", "env_bundles");
  await setCap("env", "env_bundles", 2010000, qe.bytes + 5);
  const e1 = await put(OW, "12345");
  const e2 = await put(OW, "123456");
  ok(e1.status === 200 && e2.status === 507, `environment bytes: at the cap accepted, over it refused (${e1.status}, ${e2.status})`);
  await setCap("env", "env_bundles", 2010000, 536870912000);
  const eo = await quota("env", "owners");
  await setCap("env", "owners", eo.count + 1);
  const o1 = await put("ownerN1", "synthetic bundle: new owner");
  const o2 = await put("ownerN2", "synthetic bundle: one owner too many");
  ok(o1.status === 200 && o2.status === 507 && !(await q("SELECT 1 AS x FROM owners WHERE owner_ref = 'ownerN2'")), `owners: the N-th is accepted, the N+1-th refused (${o1.status}, ${o2.status})`);
  await setCap("env", "owners", 100);

  // ---- §1, §3: creation and revision
  const sA = s1, sA2 = await heldBundle(OW), sA3 = await heldBundle(OW);
  const rq1 = rqid();
  res = await asg({ owner_ref: OW, bundle_sha: sA, request_id: rq1 });
  body = await j(res);
  const aid = body.aid;
  ok(res.status === 200 && body.rev === 1 && (await q("SELECT refs FROM bundles WHERE owner_ref = ? AND sha = ?", OW, sA)).refs === 1, "creation makes rev 1, and its revision holds its bundle");
  // two simultaneous revisions from base 1
  await reset();
  const rev1 = (title, request_id = rqid()) => admin("/lti/admin/assignment", { owner_ref: OW, actor_ref: "a", aid, expected_rev: 1, title, runtime_policy: "either", max_points: 5, visibility: "institution", bundle_sha: sA2, request_id });
  const [x, y] = await Promise.all([rev1("X"), rev1("Y")]);
  ok([x.status, y.status].sort().join() === "200,409", `two simultaneous revisions from base 1: one 200, one 409 (${x.status}, ${y.status})`);
  const snap = async () => JSON.stringify([await q("SELECT rev, revs, title, bundle_sha FROM assignments WHERE aid = ?", aid), await qa("SELECT rev, bundle_sha FROM assignment_revisions WHERE aid = ? ORDER BY rev", aid), await qa("SELECT sha, refs FROM bundles WHERE owner_ref = ? ORDER BY sha", OW)]);
  let before = await snap();
  const rqS = rqid();
  res = await rev1("stale", rqS);
  ok(res.status === 409 && (await j(res)).error === "stale_rev" && (await snap()) === before, "a stale draft when the current rev is exactly expected_rev + 1 (the primary key): 409 stale_rev, nothing written");
  res = await asg({ owner_ref: OW, aid, expected_rev: 2, title: "three", bundle_sha: sA3 });
  ok((await j(res)).rev === 3, "(a third revision)");
  before = await snap();
  res = await rev1("very stale");
  const r7 = await asg({ owner_ref: OW, aid, expected_rev: 7, title: "ahead", bundle_sha: sA3 });
  ok(res.status === 409 && r7.status === 409 && (await j(r7)).error === "stale_rev" && (await snap()) === before, "a stale rev-1 draft after later revisions, and one ahead of the current rev: 409, no revision row, no refs and no assignment change");
  ok((await asg({ owner_ref: OW, aid, title: "x", bundle_sha: sA })).status === 400 && (await asg({ owner_ref: OW, expected_rev: 1, title: "x", bundle_sha: sA })).status === 400, "a revision missing expected_rev, or expected_rev with no aid: 400");
  const rqO = rqid();
  const other1 = await asg({ owner_ref: "ownerA", aid, expected_rev: 3, title: "x", bundle_sha: sA, request_id: rqO });
  const other2 = await asg({ owner_ref: "ownerA", aid, expected_rev: 1, title: "x", bundle_sha: sA });
  ok(other1.status === 404 && other2.status === 404 && (await snap()) === before, "another owner's revision, with any expected_rev: 404");
  const a1 = await auditOf(rq1), aS = await auditOf(rqS), aO = await auditOf(rqO);
  ok(a1.length === 2 && a1[0].action === "assignment.create" && a1[1].action === "assignment.create.outcome" && a1[1].outcome === "ok" && a1[1].rev === 1, `the audit has an intent and its outcome: created (${JSON.stringify(a1)})`);
  ok(aS.length === 2 && aS[0].action === "assignment.revise" && aS[1].outcome === "stale_rev" && aO.length === 2 && aO[1].outcome === "not_found", "...stale and not found, each with its outcome");
  // publication
  res = await asg({ owner_ref: OW, bundle_sha: sA, visibility: "public" });
  ok(res.status === 403 && (await j(res)).error === "staff_required", "an owner admin's public publish without staff_ref is refused");
  const pub0 = (await quota("env", "public_assignments")).count;
  res = await asg({ owner_ref: OW, bundle_sha: sA, visibility: "public", staff_ref: "staff1" });
  const aidP = (await j(res)).aid;
  ok(res.status === 200 && (await quota("env", "public_assignments")).count === pub0 + 1, "...with staff_ref it's accepted, and counted in the public catalog");
  ok((await asg({ owner_ref: OW, aid: aidP, expected_rev: 1, bundle_sha: sA })).status === 403, "a revision of a public assignment without staff_ref is refused");
  res = await asg({ owner_ref: OW, aid: aidP, expected_rev: 1, bundle_sha: sA, staff_ref: "staff1" });
  ok(res.status === 200 && (await quota("env", "public_assignments")).count === pub0, "...and with it, unpublishing is accepted and uncounted");
  // caps: per-owner assignments, the public catalog, per-assignment and per-owner revisions
  const qa0 = await quota(OW, "assignments");
  await setCap(OW, "assignments", qa0.count + 1);
  const n1 = await asg({ owner_ref: OW, bundle_sha: sA }), n2 = await asg({ owner_ref: OW, bundle_sha: sA });
  ok(n1.status === 200 && n2.status === 507 && (await quota(OW, "assignments")).count === qa0.count + 1, `per-owner assignments: the N-th accepted, the N+1-th refused (${n1.status}, ${n2.status})`);
  await setCap(OW, "assignments", 2000);
  const qp = await quota("env", "public_assignments");
  await setCap("env", "public_assignments", qp.count + 1);
  const p1 = await asg({ owner_ref: OW, bundle_sha: sA, visibility: "public", staff_ref: "staff1" }), p2 = await asg({ owner_ref: OW, bundle_sha: sA, visibility: "public", staff_ref: "staff1" });
  ok(p1.status === 200 && p2.status === 507, `the public catalog: the N-th accepted, the N+1-th refused (${p1.status}, ${p2.status})`);
  await setCap("env", "public_assignments", 10000);
  const aidC = (await j(await asg({ owner_ref: OW, bundle_sha: sA }))).aid;
  // (98 more revisions than the one it has: set its count as if it had them, the triggers' own counter)
  await content.prepare("UPDATE assignments SET revs = 99 WHERE aid = ?").bind(aidC).run();
  const v1 = await asg({ owner_ref: OW, aid: aidC, expected_rev: 1, bundle_sha: sA }), v2 = await asg({ owner_ref: OW, aid: aidC, expected_rev: 2, bundle_sha: sA });
  ok(v1.status === 200 && v2.status === 507 && (await q("SELECT rev, revs FROM assignments WHERE aid = ?", aidC)).rev === 2, `per-assignment revisions: the 100th accepted, the 101st refused (${v1.status}, ${v2.status})`);
  const qr = await quota(OW, "revisions");
  await setCap(OW, "revisions", qr.count + 1);
  const w1 = await asg({ owner_ref: OW, bundle_sha: sA }), w2 = await asg({ owner_ref: OW, bundle_sha: sA });
  ok(w1.status === 200 && w2.status === 507, `per-owner revisions: the N-th accepted, the N+1-th refused (${w1.status}, ${w2.status})`);
  await setCap(OW, "revisions", 20000);
  ok(await aborts("UPDATE quota SET cap_count = 2001 WHERE scope = ? AND kind = 'assignments'", "cap_range", OW), "a cap above its hard range is refused");
  // the immutable owner, and the forward-only state
  ok((await aborts("UPDATE owners SET owner_ref = 'zz' WHERE owner_ref = ?", "owner_immutable", OW))
    && (await aborts("UPDATE assignments SET owner_ref = 'ownerA' WHERE aid = ?", "owner_immutable", aid))
    && (await aborts("UPDATE bundles SET owner_ref = 'ownerA' WHERE owner_ref = ? AND sha = ?", "owner_immutable", OW, sA))
    && (await aborts("UPDATE bundles SET size = 1 WHERE owner_ref = ? AND sha = ?", "owner_immutable", OW, sA))
    && (await aborts("UPDATE assignment_revisions SET owner_ref = 'ownerA' WHERE aid = ?", "owner_immutable", aid))
    && (await aborts("UPDATE bundles SET state = 'reserved' WHERE owner_ref = ? AND sha = ?", "bundle_state", OW, sA)), "the owner is immutable on every table, and a bundle's state only moves forward (triggers)");
  // the release rule: the current revision and a pinned one can't go; the last reference makes the bundle releasing at once
  const sD = await heldBundle(OW), sD2 = await heldBundle(OW);
  const aidD = (await j(await asg({ owner_ref: OW, bundle_sha: sD }))).aid;
  await asg({ owner_ref: OW, aid: aidD, expected_rev: 1, bundle_sha: sD2 });
  ok(await aborts("DELETE FROM assignment_revisions WHERE aid = ? AND rev = 2", "pinned", aidD), "deleting the current revision is refused by trigger");
  await content.prepare("INSERT INTO pins (kind, rid, item, aid, rev, created) VALUES ('dl', ?, 'heldbytest', ?, 1, 0)").bind(R1.rid, aidD).run();
  ok(await aborts("DELETE FROM assignment_revisions WHERE aid = ? AND rev = 1", "pinned", aidD), "deleting a pinned revision is refused by trigger");
  await content.prepare("DELETE FROM pins WHERE rid = ? AND item = 'heldbytest'").bind(R1.rid).run();
  const qd = await quota(OW, "bundles");
  await content.prepare("DELETE FROM assignment_revisions WHERE aid = ? AND rev = 1").bind(aidD).run();
  const rd = await q("SELECT state, refs, due FROM bundles WHERE owner_ref = ? AND sha = ?", OW, sD);
  const qd2 = await quota(OW, "bundles");
  ok(rd.state === "releasing" && rd.refs === 0 && rd.due !== null && qd2.count === qd.count && qd2.bytes === qd.bytes, "deleting the last referencing revision makes its bundle releasing in the same transaction; its charge stays until the R2 delete");

  // ---- §2.5: the chain
  const maxSeq = async () => (await q("SELECT max(seq) AS m FROM gate_calls")).m;
  const m0 = await maxSeq();
  ok((await aborts("INSERT INTO gate_calls (seq, kind) VALUES (?, 'probe')", "not_successor", m0 + 5)) && (await maxSeq()) === m0, "a batch whose seq isn't the successor aborts whole, with no write");
  const nA = async (title) => (await q("SELECT count(*) AS n FROM assignments WHERE owner_ref = ? AND title = ?", OW, title)).n;
  // an answer lost after commit: resolved committed (its row is there); the call answers as done, audited once
  await cgate("testSeam", { seam: { op: "drop_answer", count: 1 } });
  const rqD = rqid();
  res = await asg({ owner_ref: OW, bundle_sha: sA, title: "dropped answer", request_id: rqD });
  const aD = await auditOf(rqD);
  ok(res.status === 200 && (await nA("dropped answer")) === 1 && aD.length === 2 && aD[1].outcome === "ok", `an uncertain call whose row is there is resolved committed (${res.status})`);
  // a call held back, tombstoned, then delivered late: never, and its batch aborts when it arrives
  await cgate("testSeam", { seam: { op: "late", count: 1 } });
  res = await asg({ owner_ref: OW, bundle_sha: sA, title: "late batch" });
  const seqLate = (await gstate()).next_seq - 1;
  const ts = await q("SELECT kind FROM gate_calls WHERE seq = ?", seqLate);
  const released = await cgate("testReleaseLate");
  ok(res.status === 503 && ts?.kind === "tombstone" && /^D1_ERROR: (not_successor: SQLITE_CONSTRAINT|UNIQUE constraint failed: gate_calls\.seq)/.test(released?.[0] ?? "") && (await nA("late batch")) === 0, `CORR-LTI5A3-3: an uncertain call is tombstoned (never), and its late batch aborts on arrival, writing nothing (${res.status}, ${ts?.kind}, ${released})`);
  // CORR-LTI5A3-5: a business error is tombstoned before the next call, which commits after it
  let s0 = (await gstate()).next_seq;
  res = await asg({ owner_ref: OW, aid, expected_rev: 1, bundle_sha: sA });
  const tsB = await q("SELECT kind FROM gate_calls WHERE seq = ?", s0);
  res = await asg({ owner_ref: OW, bundle_sha: sA, title: "after a refusal" });
  ok(tsB?.kind === "tombstone" && res.status === 200 && (await q("SELECT kind FROM gate_calls WHERE seq = ?", s0 + 1))?.kind === "write", "CORR-LTI5A3-5: a call failing with a business error is tombstoned before the next is sent, and the next commits");
  // ...and a deadline error: the batch is still on its way when the deadline fires
  await cgate("testSeam", { deadline_ms: 150, seam: { op: "delay", ms: 600, count: 1 } });
  s0 = (await gstate()).next_seq;
  res = await asg({ owner_ref: OW, bundle_sha: sA, title: "past its deadline" });
  await sleep(800);
  await cgate("testSeam", { deadline_ms: 0 });
  const tsD = await q("SELECT kind FROM gate_calls WHERE seq = ?", s0);
  res = await asg({ owner_ref: OW, bundle_sha: sA, title: "after a deadline" });
  ok(tsD?.kind === "tombstone" && (await nA("past its deadline")) === 0 && res.status === 200 && (await q("SELECT kind FROM gate_calls WHERE seq = ?", s0 + 1))?.kind === "write", `CORR-LTI5A3-5: a call past its deadline is tombstoned, its batch aborts when it lands, and the next commits (${tsD?.kind})`);
  // a gate killed with a call outstanding: the next instance resolves it before sending anything
  await cgate("testSeam", { seam: { op: "fail_before_send", count: 2 } });
  const rqK = rqid();
  res = await asg({ owner_ref: OW, bundle_sha: sA, title: "killed", request_id: rqK });
  const kst = await gstate();
  await cgate("testSeam", { restart: true });
  const after = await asgRetry({ owner_ref: OW, bundle_sha: sA, title: "after the restart" });
  const kst2 = await gstate();
  const aK = await auditOf(rqK);
  ok(res.status === 503 && kst.calls.length === 1 && after.status === 200 && kst2.calls.length === 0 && (await q("SELECT kind FROM gate_calls WHERE seq = ?", kst.calls[0].seq))?.kind === "tombstone" && (await nA("killed")) === 0, `a gate killed with a call outstanding: the next instance tombstones it before its own call (${res.status}, ${kst.calls.length}, ${after.status})`);
  ok(aK.length === 1 && aK[0].action === "assignment.create", "...and the audit has its intent with no outcome: not shown as a success");
  // 50 restarts, each with its call outstanding: calls never exceeds 1 row; gate_calls stays ≤ 1,000
  let maxCalls = 0, restartsOk = true;
  const issRetry = async (kind, owner) => {
    for (let i = 0; ; i++) {
      const t = await cgate("issue", kind, owner);
      if (t.ok || t.status !== 429 || t.code === "rate" || i >= 40) return t;
      await sleep(250);
    }
  };
  for (let i = 0; i < 50; i++) {
    await reset();
    const t = await issRetry("assignment", OW);
    await cgate("testSeam", { seam: { op: "fail_before_send", count: 2 } });
    const w = await cgate("write", t.id, [{ sql: "SELECT 1" }]);
    maxCalls = Math.max(maxCalls, (await gstate()).calls.length);
    restartsOk &&= t.ok && !w.ok;
    await cgate("testSeam", { restart: true });
    await cgate("giveBack", t.id);
  }
  await reset();
  const tEnd = await issRetry("assignment", OW);
  ok(restartsOk && tEnd.ok && maxCalls === 1 && (await gstate()).calls.length === 0 && (await q("SELECT count(*) AS n FROM gate_calls")).n <= 1000, `LIMIT-LTI5A3-8: 50 restarts each with a call outstanding: calls ≤ 1 row (${maxCalls}), every one resolved, gate_calls ≤ 1,000`);
  await cgate("giveBack", tEnd.id);

  // ---- §2.5: admission
  const pr = await cgate("probe");
  ok(pr.ok && pr.S > 0 && pr.R >= 1 && pr.R <= 29 && pr.max_ms < 1000, `the probe measures S, and R = min(30, S/2) − 1 (${JSON.stringify(pr)})`);
  const closed = async (probe) => {
    await cgate("testSeam", { probe });
    const t = await cgate("issue", "assignment", OW);
    return !t.ok && t.status === 503 && t.code === "gate_closed";
  };
  ok((await closed({ ok: false, R: 0 })) && (await closed({ ok: true, R: 0.99 })), "issue fails closed after a failed probe, or with R < 1 (a chain slower than 250 ms a call)");
  // (a probe older than 2 h: issue probes again first (#18, after a pause none runs), and stays closed if that one fails)
  await cgate("testSeam", { seam: { op: "delay", ms: 1100, count: 1 } });
  ok(await closed({ ok: true, R: 20, at: Date.now() - 2 * 3600_000 - 1000 }), "with a probe older than 2 h, issue probes again, and fails closed when that probe fails (a call over 1 s)");
  await cgate("testSeam", { seam: { op: "delay", ms: 1100, count: 1 } });
  const slow = await cgate("probe");
  ok(!slow.ok && (await closed({ ok: false, R: 0 })), `a probe call over 1 s fails the probe, and issue closed (${JSON.stringify(slow)})`);
  // a slower chain (every probe call ~190 ms, as a Worker whose D1 is in another region): a good probe, R between 1 and
  // 4, and issue open at that rate; the environment's burst is still an upload's weight, so an upload fits
  await cgate("testSeam", { seam: { op: "delay", ms: 190, count: 20 } });
  const prSlow = await cgate("probe");
  await cgate("testSeam", { clear_seam: true });
  ok(prSlow.ok && prSlow.R >= 1 && prSlow.R < 4 && prSlow.max_ms >= 190 && prSlow.max_ms < 1000, `calls of ~190 ms: the probe is good, R between 1 and 4 (${JSON.stringify(prSlow)})`);
  await cgate("testSeam", { bucket: "reset" });
  const su = await cgate("issue", "upload", "slow1"), sa = await cgate("issue", "assignment", "slow2");
  ok(su.ok && !sa.ok && sa.status === 429 && sa.code === "rate" && sa.retry_after === Math.ceil((1000 * 2) / prSlow.R), `...issue open: an upload takes the environment's burst of 3 (R < 3), and the next write waits for R's refill (${JSON.stringify(sa)})`);
  if (su.ok) await cgate("giveBack", su.id);
  // at R = 2 (below an upload's weight): an owner's refusal gives the environment back its whole burst, so another
  // owner's upload still fits (the gate's clock moved 1.5 s: the environment refilled to 3, the first owner only to 1)
  await cgate("testSeam", { probe: { ok: true, R: 2 }, bucket: "reset" });
  const lo1 = await cgate("issue", "upload", "low1");
  await cgate("testSeam", { skew: 1500 });
  const lo1b = await cgate("issue", "upload", "low1"), lo2 = await cgate("issue", "upload", "low2");
  await cgate("testSeam", { skew: 0 });
  ok(lo1.ok && !lo1b.ok && lo1b.code === "rate" && lo1b.retry_after === Math.ceil((3000 * 3) / 2) && lo2.ok, `R = 2: an owner's upload refused by its own bucket gives the environment back its 3 tokens, and another owner's upload is admitted (${JSON.stringify(lo1b)}, ${JSON.stringify(lo2)})`);
  for (const t of [lo1, lo2]) if (t.ok) await cgate("giveBack", t.id);
  await cgate("testSeam", { probe: { ok: true, R: 1 }, bucket: "reset" });
  const s1u = await cgate("issue", "upload", "slow3");
  ok(s1u.ok, `at the floor, R = 1, an upload is still admitted (${JSON.stringify(s1u)})`);
  if (s1u.ok) await cgate("giveBack", s1u.id);
  // the weighted buckets at R = 4: the environment's 4 tokens, each owner's max(3, R/3) = 3
  await cgate("testSeam", { probe: { ok: true, R: 4 }, bucket: "reset" });
  const iss = (kind, owner) => cgate("issue", kind, owner);
  const held = [];
  const u1 = await iss("upload", "cw1"), u2 = await iss("assignment", "cw1");
  held.push(u1);
  ok(u1.ok && !u2.ok && u2.status === 429 && u2.code === "rate", "an upload costs 3 of an owner's 3 tokens (R = 4 < 9: one upload still fits): the next assignment write is 429");
  await reset();
  const g1 = await iss("assignment", "cw2"), g2 = await iss("pin", "cw2"), g3 = await iss("assignment", "cw3");
  held.push(g1, g3);
  ok(g1.ok && !g2.ok && g2.status === 429 && g3.ok, "an owner above R/3 gets 429 while another owner is admitted (2 tokens each)");
  const g4 = await iss("assignment", "cw4");
  ok(!g4.ok && g4.status === 429, "above the environment's bucket, issue answers 429");
  for (const t of held) if (t.ok) await cgate("giveBack", t.id);
  await cgate("testSeam", { probe: { ok: true, R: pr.R }, bucket: "reset" });
  // the live guard: the oldest queued call waiting > 5 s refuses issue (the gate's clock moved, not waited)
  const lg1 = await iss("assignment", "lg1"), lg2 = await iss("assignment", "lg2");
  await cgate("testSeam", { seam: { op: "delay", ms: 1500, count: 1 } });
  const wa = cgate("write", lg1.id, [{ sql: "SELECT 1" }]), wb = cgate("write", lg2.id, [{ sql: "SELECT 1" }]);
  await sleep(200);
  await cgate("testSeam", { skew: 6000 });
  const busy = await iss("assignment", "lg3");
  await cgate("testSeam", { skew: 0 });
  const [ra, rb] = await Promise.all([wa, wb]);
  ok(!busy.ok && busy.status === 429 && busy.code === "busy" && ra.ok && rb.ok, `the live guard: issue answers 429 while the oldest queued call has waited > 5 s (${JSON.stringify(busy)})`);
  await cgate("giveBack", lg1.id);
  await cgate("giveBack", lg2.id);
  // stored rows: 1,000 crashed holders' rows; 503 while all are live, admitted once expired ones are cleaned up
  await reset();
  await cgate("testSeam", { fill: 1000 });
  const f1 = await iss("upload", "st1");
  await cgate("testSeam", { skew: 61_000 });
  const f2 = await iss("upload", "st1");
  const fst = await gstate();
  await cgate("testSeam", { skew: 0, clear: true });
  ok(!f1.ok && f1.status === 503 && f1.code === "gate_full" && f2.ok && fst.tickets.length <= 981, `with 1,000 stored live rows issue answers 503; once they expire, issue cleans up ≤ 20 and admits (${f1.code}, ${f2.ok}, ${fst.tickets.length})`);
  if (f2.ok) await cgate("giveBack", f2.id);
  // live caps per kind: 200 assignment/pin, 100 uploads, 2 wakes
  const capped = async (fill, fillKind, kind, owner) => {
    await reset();
    await cgate("testSeam", { fill, fillKind });
    const t = await iss(kind, owner);
    await cgate("testSeam", { clear: true });
    if (t.ok) await cgate("giveBack", t.id);
    return !t.ok && t.code === "gate_full";
  };
  ok((await capped(200, "assignment", "pin", "lc1")) && !(await capped(200, "assignment", "upload", "lc1")) && (await capped(100, "upload", "upload", "lc2")) && (await capped(2, "wake", "wake", null)), "live tickets per kind: 200 assignment/pin writes (shared), 100 uploads, 2 wakes");
  // 302 live tickets (every kind at its cap) calling write at once: one in flight, none expires waiting
  await cgate("testSeam", { probe: { ok: true, R: 1000 }, bucket: "reset" });
  const many = [];
  for (let i = 0; i < 100; i++) many.push(await iss("upload", "m302u"));
  for (let i = 0; i < 200; i++) many.push(await iss(i % 2 ? "assignment" : "pin", i < 100 ? "m302a" : "m302b"));
  for (let i = 0; i < 2; i++) many.push(await iss("wake", null));
  const t302 = Date.now();
  const seq302 = (await gstate()).next_seq;
  const outs = await Promise.all(many.map((t) => cgate("write", t.id, [{ sql: "SELECT 1" }])));
  const ms302 = Date.now() - t302;
  const rows302 = await qa("SELECT seq, kind FROM gate_calls WHERE seq >= ? ORDER BY seq", seq302);
  ok(many.every((t) => t.ok) && outs.every((o) => o.ok) && rows302.length === 302 && rows302.every((r, i) => r.seq === seq302 + i && r.kind === "write"), `302 live tickets writing at once: every one admitted and committed, one at a time, in seq order, none expired (${ms302} ms)`);
  for (const t of many) await cgate("giveBack", t.id);
  await cgate("testSeam", { probe: { ok: true, R: pr.R }, bucket: "reset" });
  ok((await cgate("live")) === 0, "(every ticket returned)");
  // ---- #15 review: regressions (daybreak3's LIMIT-PRIVATE15-A3-1-1, -2; auth's SELF-A3-1-1, -3)
  {
    // SELF-A3-1-1 / LIMIT-PRIVATE15-A3-1-1: with a call unresolved, issue answers 429 at once (never waits), and the
    // one coalesced resolution runs at the gate's internal 1 call/s however many issues ask
    await reset();
    const t = await iss("assignment", OW);
    await cgate("testSeam", { seam: { op: "fail_before_send", count: 2 } });
    await cgate("write", t.id, [{ sql: "SELECT 1" }]);
    await cgate("giveBack", t.id);
    await cgate("testSeam", { seam: { op: "fail_before_send", count: 3 } });
    const s0 = (await gstate()).sends, t0 = Date.now();
    const flood = await Promise.all(Array.from({ length: 50 }, () => iss("assignment", "flood")));
    const floodMs = Date.now() - t0;
    ok(flood.every((a) => !a.ok && a.status === 429 && a.code === "resolving" && a.retry_after === 3000) && floodMs < 1500, `SELF-A3-1-1: 50 issues during a resolution each answer 429 resolving at once (${floodMs} ms; ${JSON.stringify(flood[0])})`);
    let left = 1;
    for (let i = 0; i < 60 && left; i++) {
      await sleep(250);
      const got = await iss("assignment", "flood");
      if (got.ok) await cgate("giveBack", got.id);
      left = (await gstate()).calls.length;
    }
    const attempts = (await gstate()).sends - s0, took = Date.now() - t0;
    ok(left === 0 && attempts <= Math.ceil(took / 1000) + 1, `LIMIT-PRIVATE15-A3-1-1: the resolution's attempts stay within 1 call/s while issues keep asking (${attempts} attempts in ${took} ms; resolved ${left === 0})`);
    // CORR-LTI15-1 (astra3): a pause, or recovering, while issue awaits its startup probe admits nothing
    for (const mode of ["paused", "recovering"]) {
      await cgate("testSeam", { unprobe: true, seam: { op: "delay", ms: 400, count: 1 }, bucket: "reset" });
      const pending = iss("upload", "probe-race");
      await sleep(150);
      await cgate("setMode", mode);
      const live0 = await cgate("live");
      const got = await pending;
      const live1 = await cgate("live");
      await cgate("setMode", "normal");
      if (got.ok) await cgate("giveBack", got.id);
      ok(!got.ok && got.code === "paused" && live1 === live0, `CORR-LTI15-1: ${mode} while issue awaits the startup probe: refused, live unchanged (${JSON.stringify(got)}, ${live0} → ${live1})`);
    }
    await cgate("testSeam", { probe: { ok: true, R: pr.R }, bucket: "reset" });
    // CORR-LTI15-2 (astra3): a persisted unknown call of an upload ticket (calls_used 1, spent 0, the instance dead
    // before its answer); the next write on that ticket resolves it first, is then refused as spent, and writes nothing
    await reset();
    const tc = await iss("upload", OW);
    await cgate("testSeam", { seam: { op: "vanish", count: 1 } });
    const vanished = await cgate("write", tc.id, [{ sql: "SELECT 1" }]);
    const crash = await gstate();
    const crashed = crash.tickets.find((x) => x.id === tc.id);
    await cgate("testSeam", { restart: true });
    const after2 = await cgate("write", tc.id, [{ sql: "INSERT INTO owners (owner_ref, created) VALUES ('corr2owner', 0)" }]);
    const leaked = await q("SELECT 1 AS x FROM owners WHERE owner_ref = 'corr2owner'");
    ok(vanished.code === "vanished" && crash.calls.length === 1 && crashed?.calls_used === 1 && crashed.spent === 0 && !after2.ok && after2.code === "ticket_spent" && !leaked && (await gstate()).calls.length === 0, `CORR-LTI15-2: after a crash with the call outstanding, the ticket's next write resolves it, is refused as spent, and commits nothing (${JSON.stringify(after2)}; leaked ${!!leaked})`);
    await cgate("giveBack", tc.id);
    // SELF-A3-1-3: after a failed call, the same ticket's next write is refused (409 ticket_spent)
    await reset();
    const tf = await iss("upload", OW);
    const bad = [{ sql: "INSERT INTO owners (owner_ref, created) VALUES ('', 0)" }];
    const f1 = await cgate("write", tf.id, bad), f2 = await cgate("write", tf.id, [{ sql: "SELECT 1" }]);
    ok(!f1.ok && !f2.ok && f2.status === 409 && f2.code === "ticket_spent", `SELF-A3-1-3: after a failed call, the ticket's next write gets 409 ticket_spent (${f2.code})`);
    await cgate("giveBack", tf.id);
    // ...and a write queued (on arrival within its weight) behind its own ticket's failing call is refused at the front
    await reset();
    const tq = await iss("upload", OW);
    await cgate("testSeam", { seam: { op: "delay", ms: 400, count: 1 } });
    const q1 = cgate("write", tq.id, bad);
    await sleep(100);
    const q2 = cgate("write", tq.id, [{ sql: "SELECT 1" }]);
    const [a1q, a2q] = await Promise.all([q1, q2]);
    ok(!a1q.ok && !a2q.ok && a2q.code === "ticket_spent", `SELF-A3-1-3: a request queued on a ticket that a resolution then spends is refused at the front of the queue (${a2q.code})`);
    await cgate("giveBack", tq.id);
    // LIMIT-PRIVATE15-A3-1-1, remainder (daybreak3's ruling 965f621c, option A): the gate's own calls' tombstones
    // (the probe's here; checkpoints' and wakes' in A3-2) wait on the internal 1/s bucket; a weighted ticket's
    // tombstone is paid by its weight within R and doesn't
    {
      const tb0 = (await gstate()).tombstones, t0p = Date.now();
      for (let i = 0; i < 5; i++) {
        await cgate("testSeam", { seam: { op: "fail_before_send", count: 1 } });
        await cgate("probe");
      }
      const probeTombs = (await gstate()).tombstones - tb0, probeMs = Date.now() - t0p;
      ok(probeTombs === 5 && probeMs >= 3800, `option A: 5 failing probes' tombstones wait on the internal bucket, ≤ 1/s (${probeTombs} in ${probeMs} ms)`);
      await cgate("testSeam", { probe: { ok: true, R: pr.R }, bucket: "reset" });
      const tb1 = (await gstate()).tombstones, t0w = Date.now();
      for (let i = 0; i < 5; i++) {
        await reset();
        const tw = await iss("assignment", `weighted${i}`);
        await cgate("write", tw.id, [{ sql: "INSERT INTO owners (owner_ref, created) VALUES ('', 0)" }]);
        await cgate("giveBack", tw.id);
      }
      const wTombs = (await gstate()).tombstones - tb1, wMs = Date.now() - t0w;
      ok(wTombs === 5 && wMs < 3000, `option A: 5 failing weighted calls' tombstones are paid by their tickets, not the internal bucket (${wTombs} in ${wMs} ms)`);
    }
    // LIMIT-PRIVATE15-A3-1-2: with no ticket rows and nothing unresolved, the alarm waits for the hourly probe; with rows, a minute
    await cgate("testSeam", { alarm: true });
    await sleep(300);
    const idle = await gstate();
    ok(idle.tickets.length === 0 && idle.calls.length === 0 && idle.alarm > Date.now() + 30 * 60_000, `LIMIT-PRIVATE15-A3-1-2: an idle gate's next alarm is the hourly probe's, not a minute (${idle.tickets.length} rows ${JSON.stringify(idle.tickets.map((x) => x.owner))}, alarm in ${Math.round((idle.alarm - Date.now()) / 1000)} s)`);
    const tr = await iss("assignment", "cadence");
    await cgate("testSeam", { alarm: true });
    await sleep(300);
    const withRow = await gstate();
    ok(withRow.alarm > Date.now() && withRow.alarm <= Date.now() + 61_000, `LIMIT-PRIVATE15-A3-1-2: with a ticket row, cleanup runs every minute (alarm in ${Math.round((withRow.alarm - Date.now()) / 1000)} s)`);
    await cgate("giveBack", tr.id);
  }

  // ---- §4: pins and the launch check
  async function sbLaunch(custom, rl, sub = "student-pin") {
    const { state, nonce, cookie } = await cookieLogin();
    const over = { sub, "https://purl.imsglobal.org/spec/lti/claim/resource_link": { id: rl }, ...(custom ? { "https://purl.imsglobal.org/spec/lti/claim/custom": custom } : {}) };
    const x = await launchPost(signJwt(claims(state, nonce, over)), state, cookie);
    const ticket = /open\("([0-9a-f]{32}:[0-9a-f]:[0-9a-f]{32})"\)/.exec(await x.text())?.[1];
    if (!ticket) return { status: x.status };
    const r = await tool("/lti/session", { method: "POST", headers: sameOrigin, body: JSON.stringify({ ticket }) });
    return { status: r.status, body: await r.json().catch(() => null) };
  }
  const plc = (rl) => dkey("placement", R1.rid, dep, "course-1", rl);
  const pinOf = (kind, rid, item) => q("SELECT aid, rev FROM pins WHERE kind = ? AND rid = ? AND item = ?", kind, rid, item);
  const dlPinAt = (rid, item, a, rev) => content.prepare("INSERT INTO pins (kind, rid, item, aid, rev, created) VALUES ('dl', ?, ?, ?, ?, 0)").bind(rid, item, a, rev).run();
  const sP = await heldBundle("ownerA"), sP2 = await heldBundle("ownerA");
  const aidL = (await j(await asg({ owner_ref: "ownerA", bundle_sha: sP, title: "Pinned worksheet" }))).aid;
  await asg({ owner_ref: "ownerA", aid: aidL, expected_rev: 1, bundle_sha: sP2, title: "Pinned worksheet" });
  const J = "a1".repeat(16);
  await dlPinAt(R1.rid, J, aidL, 1);
  const seqL = (await gstate()).next_seq;
  let L = await sbLaunch({ sb_assignment: aidL, sb_rev: "1", sb_item: J }, "rl-pin-1");
  const pin1 = await pinOf("placement", R1.rid, plc("rl-pin-1"));
  ok(L.status === 200 && pin1?.aid === aidL && pin1.rev === 1 && !(await pinOf("dl", R1.rid, J)), `a launch replaces the deep-link pin with a placement pin (${L.status})`);
  ok((await gstate()).next_seq === seqL, "the launch sends the gate nothing");
  L = await sbLaunch({ sb_assignment: aidL, sb_rev: "2" }, "rl-pin-1");
  const pin1b = await pinOf("placement", R1.rid, plc("rl-pin-1"));
  ok(L.status === 200 && pin1b.rev === 1, "a second launch never moves an existing placement pin; an old pinned rev still launches after a new revision");
  // astra's CORR-LTI5A3-4 trace: P pins A/rev2; a stale launch with A/rev1 and deep-link pin J2 inserts and deletes nothing
  await sbLaunch({ sb_assignment: aidL, sb_rev: "2" }, "rl-pin-2");
  const J2 = "b2".repeat(16);
  await dlPinAt(R1.rid, J2, aidL, 1);
  L = await sbLaunch({ sb_assignment: aidL, sb_rev: "1", sb_item: J2 }, "rl-pin-2");
  const pin2 = await pinOf("placement", R1.rid, plc("rl-pin-2")), j2 = await pinOf("dl", R1.rid, J2);
  ok(pin2?.rev === 2 && j2?.rev === 1, `CORR-LTI5A3-4: a stale launch with A/rev1 and J inserts nothing and deletes nothing, so J/A/rev1 stays (${JSON.stringify(pin2)}, ${JSON.stringify(j2)})`);
  // an edited sb_item naming another registration's, or another assignment's, deep-link pin deletes nothing
  const K = "c3".repeat(16), ridX = "f".repeat(32);
  await content.prepare("INSERT OR IGNORE INTO quota (scope, kind, cap_count, cap_bytes) VALUES (?, 'placement_pins', 10000, 0), (?, 'dl_pins', 10000, 0)").bind(ridX, ridX).run();
  await dlPinAt(ridX, K, aidL, 1);
  await sbLaunch({ sb_assignment: aidL, sb_rev: "1", sb_item: K }, "rl-pin-3");
  const aidQ = (await j(await asg({ owner_ref: "ownerA", bundle_sha: sP, title: "Other" }))).aid;
  const J3 = "d4".repeat(16);
  await dlPinAt(R1.rid, J3, aidQ, 1);
  await sbLaunch({ sb_assignment: aidL, sb_rev: "1", sb_item: J3 }, "rl-pin-4");
  ok((await pinOf("dl", ridX, K)) && (await pinOf("dl", R1.rid, J3)) && (await pinOf("placement", R1.rid, plc("rl-pin-3")))?.rev === 1, "an edited sb_item naming another registration's or another assignment's deep-link pin deletes nothing");
  // refusals that store nothing: another institution's private assignment, a missing or malformed rev, a deleted revision
  const sB = await heldBundle("ownerB");
  const aidB = (await j(await asg({ owner_ref: "ownerB", bundle_sha: sB, title: "B private" }))).aid;
  const nothing = async (rl) => !(await pinOf("placement", R1.rid, plc(rl))) && !(await db.prepare("SELECT 1 AS x FROM placements WHERE placement = ?").bind(plc(rl)).first());
  const n403 = async (custom, rl) => {
    const x = await sbLaunch(custom, rl);
    return x.status === 403 && x.body?.error === "not_available" && (await nothing(rl));
  };
  ok(await n403({ sb_assignment: aidB, sb_rev: "1" }, "rl-pin-5"), "a launch naming another institution's private assignment isn't available, and stores no placement, session or pin");
  ok((await n403({ sb_assignment: aidL, sb_rev: "9" }, "rl-pin-6")) && (await n403({ sb_assignment: aidL, sb_rev: "x" }, "rl-pin-7")) && (await n403({ sb_assignment: aidL }, "rl-pin-8")), "...nor one with a non-existent, malformed or missing sb_rev");
  const sR = await heldBundle("ownerA");
  const aidR = (await j(await asg({ owner_ref: "ownerA", bundle_sha: sR, title: "Deleted rev" }))).aid;
  await asg({ owner_ref: "ownerA", aid: aidR, expected_rev: 1, bundle_sha: sP });
  await content.prepare("DELETE FROM assignment_revisions WHERE aid = ? AND rev = 1").bind(aidR).run();
  ok((await n403({ sb_assignment: aidR, sb_rev: "1" }, "rl-pin-9")) && (await aborts("INSERT INTO pins (kind, rid, item, aid, rev, created) VALUES ('dl', ?, 'e5e5', ?, 1, 0)", "no_revision", R1.rid, aidR)), "a pin write after its revision was deleted fails, leaving no pin");
  // usable is derived: a held bundle not seen in the current valid cycle refuses revisions and launches
  await content.prepare("UPDATE meta SET v = 1 WHERE k = 'valid_cycle'").run();
  const u403 = await n403({ sb_assignment: aidL, sb_rev: "2" }, "rl-pin-10");
  const uRev = await asg({ owner_ref: "ownerA", bundle_sha: sP, title: "unusable" });
  const sNew = await heldBundle("ownerA");
  const uNew = await asg({ owner_ref: "ownerA", bundle_sha: sNew, title: "seen" });
  ok(u403 && uRev.status === 404 && (await q("SELECT seen_cycle FROM bundles WHERE owner_ref = 'ownerA' AND sha = ?", sNew)).seen_cycle === 1 && uNew.status === 200, `usable is derived: a launch and a revision refuse a held bundle with seen_cycle < valid_cycle; a new hold sets the current cycle (${uRev.status}, ${uNew.status})`);
  await content.prepare("UPDATE meta SET v = 0 WHERE k = 'valid_cycle'").run();
  // the placement pin cap: the N-th accepted, the N+1-th refused with nothing stored
  const qpp = await quota(R1.rid, "placement_pins");
  await setCap(R1.rid, "placement_pins", qpp.count + 1);
  const cp1 = await sbLaunch({ sb_assignment: aidL, sb_rev: "2" }, "rl-cap-1"), cp2 = await sbLaunch({ sb_assignment: aidL, sb_rev: "2" }, "rl-cap-2");
  ok(cp1.status === 200 && cp2.status === 429 && (await nothing("rl-cap-2")), `placement pins: the N-th accepted, the N+1-th refused, storing nothing (${cp1.status}, ${cp2.status})`);
  await setCap(R1.rid, "placement_pins", 10000);

  // ---- the source check: nothing but gate.ts and content.ts touches LTI_CONTENT beyond a presence check
  const allowed = [/LTI_CONTENT\?: D1;/, /!env\.LTI_CONTENT\b/, /env\.LTI_CONTENT \?/];
  const offenders = [];
  for (const f of readdirSync(here).filter((f) => f.endsWith(".ts") && !["gate.ts", "content.ts"].includes(f))) {
    const src = readFileSync(join(here, f), "utf8");
    for (const line of src.split("\n")) if (line.includes("LTI_CONTENT") && !allowed.some((re) => re.test(line))) offenders.push(`${f}: ${line.trim().slice(0, 100)}`);
  }
  ok(offenders.length === 0, `no LtiContent write outside the gate and content.ts: only presence checks elsewhere (${offenders.join(" | ")})`);
}
// ================= r5 §5: AGS — tokens, line items, the score state and the outbox (§5.3, §15.2)
{
  const AGS = "https://purl.imsglobal.org/spec/lti-ags/claim/endpoint";
  const S = "https://purl.imsglobal.org/spec/lti-ags/scope/";
  const ctxA = "course-ags";
  async function agsLaunch(sub, rl, endpoint) {
    const { state, nonce, cookie } = await cookieLogin();
    const over = { sub, "https://purl.imsglobal.org/spec/lti/claim/context": { id: ctxA }, "https://purl.imsglobal.org/spec/lti/claim/resource_link": { id: rl }, ...(endpoint ? { [AGS]: endpoint } : {}) };
    const x = await launchPost(signJwt(claims(state, nonce, over)), state, cookie);
    const ticket = /open\("([0-9a-f]{32}:[0-9a-f]:[0-9a-f]{32})"\)/.exec(await x.text())?.[1];
    const r = await tool("/lti/session", { method: "POST", headers: sameOrigin, body: JSON.stringify({ ticket }) });
    return r.status;
  }
  const course = dkey("course", R1.rid, dep, ctxA);
  const plA = dkey("placement", R1.rid, dep, ctxA, "rl-ags");
  const memA = dkey("member", R1.rid, dep, ctxA, "student-a");
  let refA = null; // (the member incarnation's ref, once the first launch has made it)
  // (a drain sends as fast as the registration's ags bucket allows, 10 then 1 per 100 ms; back-to-back drains on a
  // fast runner can find it empty and defer everything as "rate": each drain here starts with it refilled)
  const ags = async (op, q = "", init) => {
    if (op === "drain") await tool(`/__test/refill?rid=${R1.rid}&kind=ags`);
    return j(await tool(`/__test/ags?op=${op}&course=${course}${q}`, init));
  };
  const queue = (body) => ags("queue", "", { method: "POST", body: JSON.stringify({ placement: plA, sub: "student-a", member: memA, member_ref: refA, score: 7, max: 10, activity: "Completed", grading: "FullyGraded", source: "attempt", ...body }) });
  const lineitems = `${LMS}/ags/lineitems?type_id=7`;
  ok((await agsLaunch("student-a", "rl-ags", { scope: [S + "lineitem", S + "score", S + "result.readonly"], lineitems })) === 200, "a launch with an AGS claim opens a session");
  refA = await ags("memberref", `&member=${memA}`);
  const prow = await db.prepare("SELECT ags_scope, lineitems, lineitem, resource_link FROM placements WHERE placement = ?").bind(plA).first();
  ok(prow && JSON.parse(prow.ags_scope).sort().join() === "lineitem,result.readonly,score", `the placement records the launch's grant (${prow && prow.ags_scope})`);
  ok(prow && prow.lineitems === lineitems && prow.lineitem === null && prow.resource_link === "rl-ags", "...with its line items URL and resource link");
  // a score, the line item made by query-then-POST, and the score posted
  const q1 = await queue({});
  ok(q1.ok && q1.value.seq === 1, `a score is queued at seq 1 (${JSON.stringify(q1)})`);
  let d = await ags("drain");
  ok(d.left === 0, `the outbox drains (${d.left}, ${JSON.stringify(d.outbox)})`);
  ok(agsP.queries.length === 1 && agsP.posts.length === 1, `the line item: one query, then one POST (${agsP.queries.length}, ${agsP.posts.length})`);
  const q0 = new URLSearchParams(agsP.queries[0]);
  ok(q0.get("resource_link_id") === "rl-ags" && q0.get("tag") === plA.slice(0, 16) && q0.get("type_id") === "7", "the query names the resource link and the placement's tag, keeping the URL's own query");
  ok(agsP.posts[0].tag === plA.slice(0, 16) && agsP.posts[0].resourceLinkId === "rl-ags" && agsP.posts[0].scoreMaximum === 10, "the POST carries the tag, the resource link and scoreMaximum");
  const s1 = agsP.scores.at(-1);
  ok(agsP.scores.length === 1 && s1.userId === "student-a" && s1.scoreGiven === 7 && s1.scoreMaximum === 10 && s1.activityProgress === "Completed" && s1.gradingProgress === "FullyGraded", "the score is posted to the line item's /scores");
  ok(s1.type === "application/vnd.ims.lis.v1.score+json" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s1.timestamp), "as a score+json, with a millisecond ISO timestamp");
  ok(d.state[0].acked_seq === 1, "the ack sets acked_seq");
  ok((await ags("charged", `&rid=${R1.rid}`)) === 0, "and the release empties Reg's charged set");
  // the tokens: client assertions, one per exact scope set, cached
  const tr = agsP.tokenReqs;
  ok(tr.length === 2 && tr.every((t) => t.good && t.grant === "client_credentials" && t.type === "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"), `two token requests, each a signed client assertion (${tr.length})`);
  ok(tr.every((t) => t.payload.iss === client && t.payload.sub === client && t.payload.aud === `${LMS}/token` && t.payload.exp - t.payload.iat === 300 && /^[0-9a-f]{32}$/.test(t.payload.jti)), "iss = sub = client_id, aud the token endpoint, 5 min, a random jti");
  ok(tr[0].scope === S + "lineitem" && tr[1].scope === S + "score", `each names only the operation's scope (${tr.map((t) => t.scope).join(" | ")})`);
  // two changes before a drain: only the newest is sent, with a strictly newer timestamp
  await queue({ score: 8 });
  await queue({ score: 9 });
  d = await ags("drain");
  const sent = agsP.scores.slice(1);
  ok(sent.length === 1 && sent[0].scoreGiven === 9 && d.state[0].seq === 3 && d.state[0].acked_seq === 3, `the outbox holds only the newest update (${sent.map((s) => s.scoreGiven)})`);
  ok(Date.parse(sent[0].timestamp) > Date.parse(s1.timestamp), "with a newer timestamp");
  ok(agsP.tokenReqs.length === 2, "the cached tokens are reused");
  // idempotency (§14.2)
  const idem = "1".repeat(32);
  const i1 = await queue({ score: 5, idem }), i2 = await queue({ score: 6, idem });
  ok(i1.ok && i2.ok && i2.value.repeat && i2.value.seq === i1.value.seq, "a repeated idem answers the first result with no new update");
  d = await ags("drain");
  ok(agsP.scores.at(-1).scoreGiven === 5 && d.state[0].seq === i1.value.seq, "...and only its first update is sent");
  // a 401: the token is dropped, refreshed once and the post retried once
  agsP.revoked.add(agsP.scores.at(-1).bearer);
  const nTok = agsP.tokenReqs.length, nScores = agsP.scores.length;
  await queue({ score: 4 });
  d = await ags("drain");
  ok(agsP.tokenReqs.length === nTok + 1 && agsP.scores.length === nScores + 1 && agsP.scores.at(-1).scoreGiven === 4, `a 401 refreshes the token once and the score arrives (${agsP.tokenReqs.length - nTok})`);
  // a 503: the same update is resent
  agsP.scoreStatus.push(503);
  await queue({ score: 3 });
  d = await ags("drain", "&n=1");
  ok(d.left === 1 && d.outbox[0].st === "charged" && d.outbox[0].tries === 1, `a 503 keeps the update charged, to resend (${JSON.stringify(d.outbox)})`);
  d = await ags("drain");
  const ts3 = agsP.scores.at(-1);
  ok(d.left === 0 && ts3.scoreGiven === 3, "the resend arrives");
  // a 403: the grant is missing until a new launch; nothing is resent meanwhile
  agsP.scoreStatus.push(403);
  await queue({ score: 2 });
  const before403 = agsP.scores.length;
  d = await ags("drain", "&n=3");
  ok(d.left === 1 && agsP.scores.length === before403, "a 403 stops sending for the placement");
  await new Promise((r) => setTimeout(r, 5));
  ok((await agsLaunch("student-a", "rl-ags", { scope: [S + "lineitem", S + "score"], lineitems })) === 200, "a new launch brings a grant");
  d = await ags("drain");
  ok(d.left === 0 && agsP.scores.at(-1).scoreGiven === 2, `...and the held score is sent (${d.left})`);
  // ordering: an old update never overtakes a newer one
  ok(Date.parse(agsP.scores.at(-1).timestamp) > Date.parse(ts3.timestamp), "timestamps only increase");
  // an uncertain line-item POST: the next try queries first and adopts, never a second POST
  const plB = dkey("placement", R1.rid, dep, ctxA, "rl-ags-2");
  ok((await agsLaunch("student-a", "rl-ags-2", { scope: [S + "lineitem", S + "score"], lineitems })) === 200, "a second placement");
  agsP.liPost = "lost";
  const nPosts = agsP.posts.length;
  await ags("queue", "", { method: "POST", body: JSON.stringify({ placement: plB, sub: "student-a", member: memA, member_ref: refA, score: 1, max: 2, activity: "Completed", grading: "FullyGraded", source: "attempt" }) });
  d = await ags("drain", "&n=2");
  agsP.liPost = "ok";
  d = await ags("drain");
  const mine2 = agsP.lineitems.filter((li) => li.tag === plB.slice(0, 16));
  ok(d.left === 0 && agsP.posts.length === nPosts + 1 && mine2.length === 1, `a lost POST's line item is found by the query and adopted: one column (${agsP.posts.length - nPosts}, ${mine2.length}; ${JSON.stringify(d).slice(0, 200)})`);
  ok(agsP.scores.at(-1).li === Number(mine2[0].id.split("/").pop()), "and the score goes to it");
  // a launch's own line item: no query, no POST
  const plC = dkey("placement", R1.rid, dep, ctxA, "rl-ags-3");
  ok((await agsLaunch("student-a", "rl-ags-3", { scope: [S + "score"], lineitem: `${LMS}/ags/lineitems/1?x=1` })) === 200, "a placement with its own line item");
  const nq = agsP.queries.length, np = agsP.posts.length;
  await ags("queue", "", { method: "POST", body: JSON.stringify({ placement: plC, sub: "student-a", member: memA, member_ref: refA, score: 1, max: 1, activity: "Completed", grading: "FullyGraded", source: "attempt" }) });
  d = await ags("drain");
  ok(d.left === 0 && agsP.queries.length === nq && agsP.posts.length === np && agsP.scores.at(-1).li === 1 && agsP.scores.at(-1).query === "?x=1", "its scores go to <lineitem>/scores, keeping the query string");
  // no grant: nothing is queued
  const plD = dkey("placement", R1.rid, dep, ctxA, "rl-ags-4");
  ok((await agsLaunch("student-a", "rl-ags-4", { scope: [S + "lineitem.readonly"], lineitems })) === 200, "a placement without the score scope");
  const nd = await ags("queue", "", { method: "POST", body: JSON.stringify({ placement: plD, sub: "student-a", member: memA, member_ref: refA, score: 1, max: 1, activity: "Completed", grading: "FullyGraded", source: "attempt" }) });
  ok(!nd.ok && nd.code === "no_passback", "has no passback, and nothing is queued");
  ok(!(await ags("queue", "", { method: "POST", body: JSON.stringify({ placement: plA, sub: "student-a", member: memA, member_ref: refA, score: 1, max: 1, activity: "Done", grading: "FullyGraded", source: "x" }) })).ok, "a bad activityProgress is refused");
  // Reg's charged set (§15.2): retry, transfer, stale, release only at or below
  const qid = "f".repeat(32), rq = (op, inc) => tool(`/__test/ags?op=${op}&rid=${R1.rid}&qid=${qid}&inc=${inc}`).then(j);
  ok((await rq("charge", 2)) === "ok" && (await rq("charge", 2)) === "ok" && (await ags("charged", `&rid=${R1.rid}`)) === 1, "a charge, and its retry, count once");
  ok((await rq("charge", 1)) === "stale", "an older incarnation's charge is stale");
  ok((await rq("charge", 3)) === "ok" && (await ags("charged", `&rid=${R1.rid}`)) === 1, "a newer incarnation's charge transfers, with the count unchanged");
  await rq("release", 2);
  ok((await ags("charged", `&rid=${R1.rid}`)) === 1, "a stale release removes nothing");
  await rq("release", 3);
  ok((await ags("charged", `&rid=${R1.rid}`)) === 0, "the current incarnation's release removes it");
  // LIMIT-PR9-1 (daybreak3): every AGS fetch, retries included, takes a day unit and a Fleet unit first, failing closed
  const outday = (n) => tool(`/__test/ags?op=outday&rid=${R1.rid}&n=${n}`).then(j);
  const fleetT = (t) => tool(`/__test/ags?op=fleet&tokens=${t}`).then(j);
  const counts = () => ({ hits: agsP.hits, tokens: agsP.tokenReqs.length, scores: agsP.scores.length });
  await ags("drain");
  let c0 = counts();
  await outday(200_000);
  await queue({ score: 5 });
  d = await ags("drain", "&n=3");
  let c1 = counts();
  ok(c1.hits === c0.hits && c1.tokens === c0.tokens && d.left === 1 && d.outbox[0].last === "rate", `LIMIT-PR9-1: the day's outbound budget spent, no AGS fetch is made (${JSON.stringify(c0)} -> ${JSON.stringify(c1)}; ${d.outbox[0]?.last})`);
  await outday(0);
  d = await ags("drain");
  ok(d.left === 0 && agsP.scores.at(-1).scoreGiven === 5, "...and with the budget back, the held score is sent");
  c0 = counts();
  await fleetT(0);
  await queue({ score: 4 });
  d = await ags("drain", "&n=3");
  c1 = counts();
  ok(c1.hits === c0.hits && c1.tokens === c0.tokens && d.left === 1, `LIMIT-PR9-1: Fleet exhausted, no AGS fetch is made (${JSON.stringify(c0)} -> ${JSON.stringify(c1)})`);
  await fleetT(500);
  d = await ags("drain");
  ok(d.left === 0 && agsP.scores.at(-1).scoreGiven === 4, "...and with Fleet back, the held score is sent");
  // the 401 path: the service request takes the day's last unit; the token refresh and the retry get none, so neither is fetched
  agsP.revoked.add(`tok-${agsP.tokens}`);
  await outday(200_000 - 1);
  c0 = counts();
  await queue({ score: 3 });
  d = await ags("drain", "&n=1");
  c1 = counts();
  ok(c1.hits === c0.hits + 1 && c1.tokens === c0.tokens && c1.scores === c0.scores && d.left === 1, `LIMIT-PR9-1: after a 401 with the budget spent, no token request and no retry are fetched (${JSON.stringify(c0)} -> ${JSON.stringify(c1)})`);
  await outday(0);
  d = await ags("drain");
  ok(d.left === 0 && agsP.scores.at(-1).scoreGiven === 3 && counts().tokens === c0.tokens + 1, "...and with the budget back, one refresh and the retry deliver it");
  // erasure: the member's score keys are released and deleted
  agsP.scoreStatus.push(503);
  await queue({ score: 6 });
  await ags("drain", "&n=1");
  ok((await ags("charged", `&rid=${R1.rid}`)) === 1, "a pending score is charged");
  const ref = await ags("memberref", `&member=${memA}`);
  const er = await j(await tool(`/__test/course?course=${course}&op=erase&ref=${ref}`));
  const after = await ags("inspect");
  ok(er.ok && after.state.length === 0 && after.outbox.length === 0 && (await ags("charged", `&rid=${R1.rid}`)) === 0, `erasing the member releases and deletes their score keys (${JSON.stringify(er)})`);
  // ---- #9's fix round: astra's CORR-AGS-1/-2 probes and daybreak3's LIMIT-PR9-2, as regressions
  const gate = (name, on) => tool("/__test/gate", { method: "POST", body: JSON.stringify({ name, on, once: true }) });
  const parked = async (name) => {
    for (let i = 0; i < 500; i++) {
      if ((await j(await tool(`/__test/gate?name=${name}`))).parked) return true;
      await new Promise((r) => setTimeout(r, 10));
    }
    return false;
  };
  const learner = async (sub) => {
    ok((await agsLaunch(sub, "rl-ags", { scope: [S + "lineitem", S + "score"], lineitems })) === 200, `(${sub} launches)`);
    const member = dkey("member", R1.rid, dep, ctxA, sub), member_ref = await ags("memberref", `&member=${member}`);
    return { member, member_ref, q: (o = {}) => ags("queue", "", { method: "POST", body: JSON.stringify({ placement: plA, sub, member, member_ref, score: 1, max: 10, activity: "Completed", grading: "FullyGraded", source: "attempt", ...o }) }) };
  };
  // CORR-AGS-1: a step paused at its placement lookup while a newer score is queued sends the newest, and acks only it
  const C = await learner("student-c");
  // (score 1 charged, its first send answered 503: the row stays charged, unsent)
  agsP.scoreStatus.push(503, 503, 503);
  await C.q({ score: 1 });
  d = await ags("drain", "&n=2");
  agsP.scoreStatus.length = 0;
  const qidC = d.state.find((r) => r.member === C.member)?.qid;
  const rowC = d.outbox.find((r) => r.qid === qidC);
  ok(rowC?.st === "charged" && rowC.seq === 1 && d.state.find((r) => r.qid === qidC).acked_seq === 0, `(score 1 is charged and unsent: ${JSON.stringify(rowC)})`);
  const n9 = agsP.scores.length;
  await gate("ags_step_placement", true);
  const stepping = ags("drain", "&n=1");
  ok(await parked("ags_step_placement"), "(the step is paused at its placement lookup)");
  const c2 = await C.q({ score: 2 });
  await gate("ags_step_placement", false);
  d = await stepping;
  const stC = d.state.find((r) => r.qid === qidC);
  ok(c2.ok && agsP.scores.length === n9 + 1 && agsP.scores.at(-1).scoreGiven === 2 && stC?.acked_seq === 2, `CORR-AGS-1: the step sends the newest score (2) and acks seq 2 (${agsP.scores.slice(n9).map((x) => x.scoreGiven)}; acked ${stC?.acked_seq})`);
  d = await ags("drain");
  ok(d.left === 0, "(and the key settles)");
  // CORR-AGS-2: a queue paused at its placement lookup while the member is erased is refused, and leaves nothing
  await gate("ags_queue_placement", true);
  const queuing = C.q({ score: 3 });
  ok(await parked("ags_queue_placement"), "(the queue is paused at its placement lookup)");
  const erC = await j(await tool(`/__test/course?course=${course}&op=erase&ref=${C.member_ref}`));
  await gate("ags_queue_placement", false);
  const late = await queuing;
  d = await ags("inspect");
  ok(erC.ok && !late.ok && late.code === "member" && !d.state.some((r) => r.member === C.member) && !d.outbox.some((r) => r.qid === qidC), `CORR-AGS-2: after the erasure, the held queue is refused (${JSON.stringify(late)}) and makes no score or outbox row`);
  // LIMIT-PR9-2: bounded fields
  const D = await learner("student-d");
  ok((await D.q({ sub: "\u20ac".repeat(86) })).code === "bad_sub" && (await D.q({ comment: "x" })).code === "bad_score" && (await D.q({ source: "elsewhere" })).code === "bad_score", "LIMIT-PR9-2: a sub over 255 B, a comment, an unknown source: refused before anything is stored");
  ok((await D.q({ sub: "\u20ac".repeat(85) })).code !== "bad_sub", "...a 255-byte sub is accepted");
  // the caps, each refused at cap with nothing written, while an existing key still updates
  const fillC = async (c, a) => j(await tool(`/__test/ags?op=fill&course=${c}`, { method: "POST", body: JSON.stringify(a) }));
  const SCORE_ROWS = Math.floor((36 * 1024 * 1024 - 16384) / 704);
  ok((await D.q({ score: 1 })).ok, "(D's key)");
  d = await ags("drain");
  const idemOf = (n) => n.toString(16).padStart(32, "a");
  // idempotency: at 30,000 rows of expired days, whole expired days go first and a new idem is admitted
  let f0 = await fillC(course, { idem: 30000, idemExpired: true });
  let r1 = await D.q({ score: 2, idem: idemOf(1) });
  let f1 = await fillC(course, {});
  ok(f0.idem === 30000 && r1.ok && f1.idem <= 30000 - 1000 + 1, `LIMIT-PR9-2: at 30,000 idem rows of expired days, a new idem is admitted once expired days go (${f0.idem} -> ${f1.idem}; the alarm's drain expires more)`);
  // ...at 30,000 live rows, a new idem is refused before anything is written; a live repeat still answers
  await fillC(course, { clearIdem: true });
  ok((await D.q({ score: 3, idem: idemOf(1) })).ok, "(the first idem, recorded again on a cleared table)");
  // (that score's outbox row is drained to the end first: otherwise the Course's own alarm, armed by the queue, can
  // deliver and release it between the two counts below, and the outbox count moves without this request writing)
  const dq = await ags("drain");
  f0 = await fillC(course, { idem: 30000 });
  r1 = await D.q({ score: 3, idem: idemOf(2) });
  f1 = await fillC(course, {});
  const rep1 = await D.q({ score: 9, idem: idemOf(1) });
  ok(dq.left === 0 && f0.idem === 30000 && !r1.ok && r1.code === "course_full" && f1.idem === 30000 && f1.outbox === f0.outbox && rep1.ok && rep1.value.repeat, `LIMIT-PR9-2: at 30,000 live idem rows a new idem is refused, nothing written (${JSON.stringify(r1)}); a repeat answers its first result (drained left ${dq.left}; ${JSON.stringify(f0)} -> ${JSON.stringify(f1)}; repeat ${JSON.stringify(rep1)})`);
  d = await ags("drain");
  // score state: at the progress-budget cap, a new key is refused before anything is written
  f0 = await fillC(course, { score: SCORE_ROWS });
  const newKey = (o = {}) => ags("queue", "", { method: "POST", body: JSON.stringify({ placement: plB, sub: "student-d", member: D.member, member_ref: D.member_ref, score: 1, max: 1, activity: "Completed", grading: "FullyGraded", source: "attempt", ...o }) });
  r1 = await newKey();
  f1 = await fillC(course, {});
  ok(f0.score === SCORE_ROWS && !r1.ok && r1.code === "course_full" && f1.score === f0.score && f1.outbox === f0.outbox, `LIMIT-PR9-2: at ${SCORE_ROWS} score rows (36 MiB of progress budget at 704 B a row), a new key is refused and nothing is written (${JSON.stringify(r1)})`);
  ok((await D.q({ score: 4 })).ok && (await fillC(course, {})).outbox === f0.outbox + 1, "...while an existing key still updates (its new outbox row is admitted)");
  d = await ags("drain");
  // the outbox: at 16,000 rows, an update needing a new outbox row is refused before anything is written
  f0 = await fillC(course, { outbox: 16000 });
  r1 = await D.q({ score: 5 });
  f1 = await fillC(course, {});
  const stD = (await ags("inspect")).state.filter((r) => r.member === D.member);
  ok(f0.outbox === 16000 && !r1.ok && r1.code === "course_full" && f1.outbox === 16000 && stD.every((r) => r.score !== 5), `LIMIT-PR9-2: at 16,000 outbox rows, an update needing a new outbox row is refused, nothing written (${JSON.stringify(r1)})`);
  // the composition (errata r3 + addendum 1 + addendum 2): one fresh Course with every fixed-width table at its
  // cap, maximum-width rows; physical ≤ 0.95 × the sum of their charges, and within the 64 MiB Course budget
  const cc = "71".repeat(16);
  const e0 = await j(await tool("/__test/fill", { method: "POST", body: JSON.stringify({ course: cc }) }));
  await j(await tool("/__test/fill", { method: "POST", body: JSON.stringify({ course: cc, sessions: 20000, members: 5000, erased: 5000 }) }));
  const e1 = await fillC(cc, { score: SCORE_ROWS, outbox: 16000, idem: 30000 });
  const charges = { sessions: 16384 + 200 * 20000, members: 16384 + 136 * 5000, erased: 16384 + 64 * 5000, score: 16384 + 704 * SCORE_ROWS, outbox: 16384 + 512 * 16000, idem: 16384 + 96 * 30000 };
  const charged = Object.values(charges).reduce((x, y) => x + y, 0), grown = e1.size - e0.size;
  console.log(`(the composed Course: ${grown} B physical for ${charged} B charged: ${(grown / charged).toFixed(3)})`);
  ok(grown <= 0.95 * charged && e1.size <= 64 * 1024 * 1024, `LIMIT-PR9-2: every Course table at its cap together: ${grown} B ≤ 0.95 × ${charged} B charged, and ≤ 64 MiB`);

}

// the flag: without the per-IP limit bound, the tool is off
ok((await at("https://off.vmtest", "/lti/jwks")).status === 404, "without LTI_PREAUTH every route is a 404");

await mf.dispose();
console.log(`${count - failures}/${count} passed`);
process.exit(failures ? 1 : 0);
