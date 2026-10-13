// Tests for the share API and the files Worker (web/share/), in Miniflare
// with a real D1 and R2 simulation, and a fake CoCalc for sign-in and limits.
//
//   node web/share/test-share.mjs
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "../site/package.json"));
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");

const SITE = "https://sagebrush.test";
const FILES = "https://files.test";
const COCALC = "https://cocalc.test";
const SECRET = "client-secret";
const PURGE_KEY = "purge-key";
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

let failures = 0;
let count = 0;
function ok(cond, what) {
  count++;
  if (!cond) {
    failures++;
    console.log("FAIL", what);
  }
}
const sha = (b) => createHash("sha256").update(b).digest("hex");
const b64url = (b) => Buffer.from(b).toString("base64url");

// ---- a fake CoCalc: codes, PKCE, the token endpoint and limits
const fake = { codes: new Map(), limits: new Map(), limitsStatus: 200, tokenCalls: 0, limitsGate: null };
async function cocalc(req) {
  const u = new URL(req.url);
  const basic = req.headers.get("authorization") === "Basic " + Buffer.from("sagebrush:" + SECRET).toString("base64");
  if (u.pathname === "/api/v2/auth/oauth/token" && req.method === "POST") {
    fake.tokenCalls++;
    if (!basic) return Response.json({ error: "invalid_client" }, { status: 401 });
    const f = new URLSearchParams(await req.text());
    const c = fake.codes.get(f.get("code"));
    fake.codes.delete(f.get("code"));
    if (!c || f.get("grant_type") !== "authorization_code" || f.get("redirect_uri") !== c.redirect_uri || b64url(createHash("sha256").update(f.get("code_verifier") ?? "").digest()) !== c.challenge)
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    return Response.json({ account_id: c.account_id, email: c.email, email_verified: c.verified, name: "Test" });
  }
  if (u.pathname === "/api/v2/sagebrush/limits") {
    if (fake.limitsGate) await fake.limitsGate;
    if (!basic) return Response.json({ error: "invalid_client" }, { status: 401 });
    if (fake.limitsStatus !== 200) return new Response("down", { status: fake.limitsStatus });
    const l = fake.limits.get(u.searchParams.get("account_id"));
    return l ? Response.json(l) : Response.json({ error: "no_account" }, { status: 404 });
  }
  return new Response("not found", { status: 404 });
}

// (bundled with bun, which the web build uses too)
const script = execFileSync("bun", ["build", join(here, "test-entry.ts"), "--format", "esm", "--target", "browser"], { encoding: "utf8" });
const bindings = { COCALC_ORIGIN: COCALC, COCALC_CLIENT_SECRET: SECRET, SESSION_KEY: "session-key", PURGE_KEY, FILES_ORIGIN: FILES, SHARE_DEV: "1", DEV_AUTH_TOKEN: "dev-token" };
const mf = new Miniflare(convertV4MiniflareOptions({
  workers: [{
    name: "share",
    modules: true,
    script,
    compatibilityDate: "2026-10-01",
    d1Databases: ["SHARE_DB"],
    r2Buckets: ["SHARE_BUCKET"],
    bindings,
    outboundService: cocalc,
  }],
}));
const db = await mf.getD1Database("SHARE_DB");
const bucket = await mf.getR2Bucket("SHARE_BUCKET");
for (const s of readFileSync(join(here, "migrations/0001_init.sql"), "utf8").replace(/--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean)) await db.prepare(s).run();

const fetchSite = (path, init = {}) => mf.dispatchFetch(SITE + path, { redirect: "manual", ...init });
const sessionOf = (r) => (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).find((c) => c.startsWith("__Host-sb_session="));

async function signIn(account_id, { verified = true, ret = "/x" } = {}) {
  const r = await fetchSite(`/auth/login?return=${encodeURIComponent(ret)}`);
  const to = new URL(r.headers.get("location"));
  const oauth = r.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("__Host-sb_oauth="));
  const code = b64url(Buffer.from(Math.random().toString()));
  fake.codes.set(code, { account_id, email: "a@example.com", verified, redirect_uri: to.searchParams.get("redirect_uri"), challenge: to.searchParams.get("code_challenge") });
  const cb = await fetchSite(`/auth/callback?code=${code}&state=${to.searchParams.get("state")}`, { headers: { cookie: oauth } });
  return { r, to, oauth, cb, session: sessionOf(cb) };
}

function api(session) {
  const h = (extra = {}) => ({ cookie: session, origin: SITE, ...extra });
  return {
    get: (p) => fetchSite(p, { headers: h() }),
    post: (p, body, extra = {}) => fetchSite(p, { method: "POST", headers: h({ "content-type": "application/json", ...extra }), body: JSON.stringify(body) }),
    put: (p, bytes, extra = {}) => fetchSite(p, { method: "PUT", headers: h({ "content-type": "application/octet-stream", ...extra }), body: bytes }),
    del: (p) => fetchSite(p, { method: "DELETE", headers: h() }),
  };
}

async function upload(c, files, title = "T") {
  const col = await (await c.post("/api/share/collections", { title })).json();
  const blobs = files.map(([path, bytes]) => ({ path, sha256: sha(bytes), size: bytes.length, bytes }));
  const ck = await (await c.post("/api/share/check", { blobs: blobs.map(({ sha256, size }) => ({ sha256, size })) })).json();
  for (const b of blobs) if (ck.missing.includes(b.sha256)) await c.put(`/api/share/blob/${b.sha256}`, b.bytes);
  const v = await c.post(`/api/share/collections/${col.id}/versions`, { files: blobs.map(({ path, sha256, size }) => ({ path, sha256, size })), license: "CC-BY-4.0" });
  return { col: col.id, v, blobs };
}

// ---- sign-in
{
  const { r, to, cb, session } = await signIn(A);
  ok(r.status === 302 && to.origin === COCALC && to.pathname === "/auth/oauth/authorize", "login redirects to CoCalc's authorize page");
  ok(to.searchParams.get("client_id") === "sagebrush" && to.searchParams.get("code_challenge_method") === "S256" && to.searchParams.get("redirect_uri") === SITE + "/auth/callback", "authorize parameters");
  ok(cb.status === 302 && cb.headers.get("location") === "/x" && session, "the callback starts a session and returns to the page");
  const setc = cb.headers.getSetCookie().join("\n");
  ok(/HttpOnly/.test(setc) && /Secure/.test(setc) && /SameSite=Lax/.test(setc), "the session cookie is HttpOnly, Secure, SameSite=Lax");
  fake.limits.set(A, { tier: "member", storage_bytes: 10_000, max_file_bytes: 5_000, private_links: false });
  const me = await (await api(session).get("/api/share/me")).json();
  ok(me.account_id === A && me.limits.storage_bytes === 10_000 && me.usage === 0, "me: account, limits from CoCalc, usage");
}
{
  const { cb } = await signIn(A, { ret: "//evil.example/" });
  ok(cb.headers.get("location") === "/", "a return path to another site becomes /");
}
{
  const { cb, session } = await signIn(A, { verified: false });
  ok(cb.status === 403 && !session, "an unverified email can't sign in");
}
{
  const r = await fetchSite("/auth/login");
  const to = new URL(r.headers.get("location"));
  const oauth = r.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("__Host-sb_oauth="));
  const cb = await fetchSite(`/auth/callback?code=x&state=${to.searchParams.get("state")}x`, { headers: { cookie: oauth } });
  ok(cb.status === 400 && !sessionOf(cb), "a state mismatch is refused");
  const cb2 = await fetchSite(`/auth/callback?code=x&state=${to.searchParams.get("state")}`, { headers: { cookie: oauth.replace(/.$/, (c) => (c === "a" ? "b" : "a")) } });
  ok(cb2.status === 400, "a tampered state cookie is refused");
  const calls = fake.tokenCalls;
  const cb3 = await fetchSite(`/auth/callback?error=access_denied&state=${to.searchParams.get("state")}`, { headers: { cookie: oauth } });
  ok(cb3.status === 302 && fake.tokenCalls === calls && !sessionOf(cb3), "Deny at CoCalc returns without a session");
}
{
  const r = await fetchSite("/api/share/me");
  ok(r.status === 401, "no session: 401");
  const d = await fetchSite("/auth/dev", { method: "POST", headers: { origin: SITE, "content-type": "application/json" }, body: JSON.stringify({ token: "wrong", account_id: A }) });
  ok(d.status === 403, "dev sign-in needs the dev token");
}

// ---- uploading and reading
const keyOf = async (account, h) => (await db.prepare("SELECT key FROM holdings WHERE account_id = ?1 AND sha256 = ?2").bind(account, h).first())?.key ?? null;
const stored = async (key) => !!key && !!(await bucket.head(key));
const tick = async () => (await mf.getWorker()).scheduled({ cron: "17 3 * * *" });
const fileAt = (col, h, init) => mf.dispatchFetch(`${FILES}/c/${col}/${h}`, init);
const a = api((await signIn(A)).session);
fake.limits.set(B, { tier: "member", storage_bytes: 10_000, max_file_bytes: 5_000, private_links: false });
const b = api((await signIn(B)).session);
const data = Buffer.from("x,y\n1,2\n3,4\n");
const nb = Buffer.from('{"cells": []}');
let colA, keyA;
{
  const bad = await a.put(`/api/share/blob/${sha(data)}`, Buffer.from("not the data"));
  ok(bad.status === 400, "R2 refuses bytes that don't match the hash");
  ok(!(await keyOf(A, sha(data))) && (await bucket.list({ prefix: "a/" })).objects.length === 0, "nothing stored after a bad upload");
  const { col, v } = await upload(a, [["data/points.csv", data], ["paper.ipynb", nb]], "Paper");
  colA = col;
  keyA = await keyOf(A, sha(data));
  const vj = await v.json();
  ok(v.status === 201 && /^[0-9a-f]{64}$/.test(vj.version) && vj.url === `/s/${col}`, "a version is committed");
  const g = await (await fetchSite(`/api/share/c/${col}`)).json();
  ok(g.manifest.files.length === 2 && g.manifest.files[0].path === "data/points.csv" && g.manifest.collection === col && g.manifest.format === "sagebrush-collection" && g.manifest.license === "CC-BY-4.0", "anyone can read the manifest");
  const mk = (await db.prepare("SELECT manifest_key FROM versions WHERE hash = ?1").bind(vj.version).first()).manifest_key;
  ok(sha(await (await bucket.get(mk)).text()) === vj.version, "a version's name is the SHA-256 of its manifest's bytes");
  const at = await (await fetchSite(`/api/share/c/${col}?at=${vj.version.slice(0, 16)}`)).json();
  ok(at.version === vj.version, "a frozen link finds its version");
  ok(keyA.startsWith("a/") && !keyA.includes(sha(data)) && !keyA.includes(A), "stored under the account's prefix, a random name (not the hash, not the account id)");

  const f = await fileAt(col, sha(data));
  ok(f.status === 200 && Buffer.from(await f.arrayBuffer()).equals(data), "the files domain serves a file of the collection");
  ok(f.headers.get("content-type") === "application/octet-stream" && /^attachment/.test(f.headers.get("content-disposition")) && f.headers.get("x-content-type-options") === "nosniff" && /sandbox/.test(f.headers.get("content-security-policy")), "served as a sandboxed attachment, never a page");
  ok(f.headers.get("access-control-allow-origin") === "*" && f.headers.get("cross-origin-resource-policy") === "cross-origin", "readable with CORS from an isolated page");
  ok(/private/.test(f.headers.get("cache-control")), "kept by the browser only, never a shared cache");
  const part = await fileAt(col, sha(data), { headers: { range: "bytes=4-6" } });
  ok(part.status === 206 && (await part.text()) === "1,2" && part.headers.get("content-range") === `bytes 4-6/${data.length}`, "range requests");
  ok((await fileAt(col, sha(data), { headers: { range: "bytes=999-" } })).status === 416, "an unsatisfiable range is 416");
  ok((await mf.dispatchFetch(`${FILES}/b/${sha(data)}`)).status === 404 && (await fileAt(col, sha(data), { method: "POST" })).status === 405, "nothing else on the files domain (no reading by hash alone)");
  const me = await (await a.get("/api/share/me")).json();
  ok(me.usage > data.length + nb.length && me.usage < data.length + nb.length + 1000, "usage counts the files and the manifest: " + me.usage);
}

// ---- isolation between accounts (SEC-243-5: a hash is not a capability)
{
  const ck = await (await b.post("/api/share/check", { blobs: [{ sha256: sha(data), size: data.length }] })).json();
  ok(ck.missing.includes(sha(data)), "another account can't learn that a file exists (dedup is per account)");
  const col = await (await b.post("/api/share/collections", { title: "B" })).json();
  const v = await b.post(`/api/share/collections/${col.id}/versions`, { files: [{ path: "stolen.csv", sha256: sha(data), size: data.length }] });
  ok(v.status === 409, "an account can't reference a file it hasn't uploaded");
  ok((await fileAt(col.id, sha(data))).status === 404, "nor read another collection's file through its own");
  const secret = Buffer.from("low entropy secret: yes");
  await a.put(`/api/share/blob/${sha(secret)}`, secret);
  ok(!!(await keyOf(A, sha(secret))) && (await fileAt(colA, sha(secret))).status === 404, "an upload not in any version is not served, even through its owner's collection");
  const v2 = await b.post(`/api/share/collections/${colA}/versions`, { files: [{ path: "x", sha256: sha(data), size: data.length }] });
  ok(v2.status === 404, "an account can't add versions to someone else's collection");
  ok((await b.del(`/api/share/collections/${colA}`)).status === 404, "or delete it");
  const x = await fetchSite("/api/share/collections", { method: "POST", headers: { cookie: (await signIn(B)).session, origin: "https://evil.example", "content-type": "application/json" }, body: "{}" });
  ok(x.status === 403, "a cross-site POST is refused");
  const y = await fetchSite("/api/share/collections", { method: "POST", headers: { cookie: (await signIn(B)).session, origin: SITE, "content-type": "text/plain" }, body: '{"title":"t"}' });
  ok(y.status === 415, "a form-encodable POST is refused");
}

// ---- the sign-in return path (SEC-243-7)
for (const ret of ["/\t/evil.example/proof", "/\n/evil.example/", "/\r/evil.example/", " /x", "/\\evil.example", "//evil.example", "/%09/evil.example", "https://evil.example/", "/x\u0000"]) {
  const { cb } = await signIn(A, { ret });
  const loc = cb.headers.get("location");
  ok(new URL(loc, SITE).origin === SITE && !/[\u0000-\u001f]/.test(loc), `return ${JSON.stringify(ret)} stays on the site: ${JSON.stringify(loc)}`);
}
{
  const { cb } = await signIn(A, { ret: "/s/abc?x=1#y" });
  ok(cb.headers.get("location") === "/s/abc?x=1#y", "an ordinary return path is kept");
}

// ---- validation and limits
{
  const col = await (await b.post("/api/share/collections", { title: "V" })).json();
  for (const p of ["../x", "/abs", "a//b", "a/./b", "a\\b", "", "a\u0000b"]) {
    const v = await b.post(`/api/share/collections/${col.id}/versions`, { files: [{ path: p, sha256: sha(data), size: 1 }] });
    ok(v.status === 400, `path ${JSON.stringify(p)} is refused`);
  }
  const big = await b.post("/api/share/check", { blobs: [{ sha256: sha("big"), size: 6000 }] });
  ok(big.status === 413, "a file over max_file_bytes is refused");
  const over = await b.post("/api/share/check", { blobs: [{ sha256: sha("1"), size: 4000 }, { sha256: sha("2"), size: 4000 }, { sha256: sha("3"), size: 4000 }] });
  ok(over.status === 413, "uploads over the storage limit are refused");
  const lie = await b.put(`/api/share/blob/${sha("6000")}`, Buffer.alloc(6000));
  ok(lie.status === 413, "a PUT over max_file_bytes is refused without check");
  const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2, 3])); c.close(); } });
  const nolen = await fetchSite(`/api/share/blob/${sha(Buffer.from([1, 2, 3]))}`, { method: "PUT", headers: { cookie: (await signIn(B)).session, origin: SITE }, body: stream, duplex: "half" });
  ok(nolen.status === 411 || nolen.status === 200, "a PUT without a length is refused (or sized by the platform): " + nolen.status);
}
{
  // SEC-243-1: concurrent uploads can't all pass one quota check
  const Q = "55555555-5555-4555-8555-555555555555";
  fake.limits.set(Q, { tier: "member", storage_bytes: 10, max_file_bytes: 100, private_links: false });
  const q = api((await signIn(Q)).session);
  const files = Array.from({ length: 8 }, (_, i) => Buffer.from(`file ${i}!`));
  const rs = await Promise.all(files.map((f) => q.put(`/api/share/blob/${sha(f)}`, f)));
  const accepted = rs.filter((r) => r.status === 200).length;
  const used = (await (await q.get("/api/share/me")).json()).usage;
  ok(accepted === 1 && used <= 10, `eight concurrent 8-byte uploads under a 10-byte limit: ${accepted} accepted, ${used} bytes used`);
  // SEC-243-6: manifests are counted (a 0-byte file can't back unlimited metadata)
  const empty = Buffer.alloc(0);
  ok((await q.put(`/api/share/blob/${sha(empty)}`, empty)).status === 200, "a 0-byte file is uploaded");
  const col = await (await q.post("/api/share/collections", { title: "M" })).json();
  const many = Array.from({ length: 50 }, (_, i) => ({ path: `p${i}`, sha256: sha(empty), size: 0 }));
  ok((await q.post(`/api/share/collections/${col.id}/versions`, { files: many })).status === 413, "a manifest over the storage limit is refused");
  ok((await q.post(`/api/share/collections/${col.id}/versions`, { files: [{ path: "e", sha256: sha(empty), size: 0 }] })).status === 413, "even a small one, when the quota is used up");
}
{
  // CoCalc down: the cached limits hold; with nothing cached, no uploads
  await db.prepare("UPDATE limits_cache SET fetched = 0").run();
  fake.limitsStatus = 503;
  const r = await b.post("/api/share/check", { blobs: [{ sha256: sha("q"), size: 10 }] });
  ok(r.status === 200, "CoCalc unreachable: the cached limits are used");
  await db.prepare("DELETE FROM limits_cache").run();
  const r2 = await b.post("/api/share/check", { blobs: [{ sha256: sha("q"), size: 10 }] });
  ok(r2.status === 403, "CoCalc unreachable and nothing cached: no uploads (never read as quota 0 or unlimited)");
  fake.limitsStatus = 200;
}

// ---- deleting
{
  // B uploads the same bytes as A, for its own collection
  const shared = await upload(b, [["same.csv", data]], "B's copy");
  ok(shared.v.status === 201, "B uploads its own copy of the same file");
  const keyB = await keyOf(B, sha(data));
  ok(keyB && keyB !== keyA, "B's copy is its own object");
  // A starts another upload, not committed yet
  const pending = Buffer.from("pending upload");
  await a.put(`/api/share/blob/${sha(pending)}`, pending);
  const keyNb = await keyOf(A, sha(nb)), keyPending = await keyOf(A, sha(pending));
  const d = await a.del(`/api/share/collections/${colA}`);
  ok(d.status === 200, "the owner deletes a collection");
  ok((await fetchSite(`/api/share/c/${colA}`)).status === 404 && (await fileAt(colA, sha(data))).status === 404, "its link and files stop at once");
  await tick();
  ok(!(await stored(keyNb)) && !(await stored(keyA)), "its files are deleted from R2");
  ok(await stored(keyB), "B's copy of the same bytes stays");
  ok(await stored(keyPending), "A's upload for another collection is not touched");
  const vs = await db.prepare("SELECT COUNT(*) AS n FROM versions WHERE collection = ?").bind(colA).first();
  ok(vs.n === 0 && (await db.prepare("SELECT COUNT(*) AS n FROM r2_deletes").first()).n === 0, "its versions are gone from D1, and the outbox is empty");
}
{
  // SEC-243-4: an object written to R2 whose D1 write never happened is found and deleted
  const orphan = "a/0000000000000000000000000000orph/xyz";
  await bucket.put(orphan, "orphan");
  await db.prepare("INSERT INTO reservations (id, account_id, bytes, key, expires) VALUES ('r1', ?1, 6, ?2, 1)").bind(A, orphan).run();
  // and an outbox row survives a failed delete until R2 confirms it
  await db.prepare("INSERT INTO r2_deletes (key, created) VALUES ('a/0000000000000000000000000000orph/gone', 1)").run();
  await tick();
  ok(!(await stored(orphan)) && !(await db.prepare("SELECT 1 AS x FROM reservations WHERE id = 'r1'").first()), "an expired reservation's unreferenced object is deleted");
  ok(!(await db.prepare("SELECT 1 AS x FROM r2_deletes").first()), "the outbox drains");
}
const sign = (ts, method, path, body) => "sha256=" + createHmac("sha256", PURGE_KEY).update(`${ts}\n${method}\n${path}\n${body}`).digest("hex");
async function adminPurge(account_id, request_id) {
  const body = JSON.stringify({ account_id, request_id });
  const ts = Math.floor(Date.now() / 1000);
  return fetchSite("/api/admin/purge", { method: "POST", headers: { "content-type": "application/json", "x-sagebrush-timestamp": String(ts), "x-sagebrush-signature": sign(ts, "POST", "/api/admin/purge", body) }, body });
}
async function purgeStatus(rid) {
  const ts = Math.floor(Date.now() / 1000);
  const p = `/api/admin/purge/${rid}`;
  return (await fetchSite(p, { headers: { "x-sagebrush-timestamp": String(ts), "x-sagebrush-signature": sign(ts, "GET", p, "") } })).json();
}
{
  // the account-deletion purge, signed by CoCalc
  const C = "33333333-3333-4333-8333-333333333333";
  fake.limits.set(C, { tier: "member", storage_bytes: 10_000, max_file_bytes: 5_000, private_links: false });
  const c = api((await signIn(C)).session);
  const mine = Buffer.from("only C has this");
  const { col } = await upload(c, [["c.txt", mine], ["same.csv", data]], "C");
  const keyC = await keyOf(C, sha(mine));
  const body = JSON.stringify({ account_id: C, request_id: "9b2d6c1e-0000-4000-8000-000000000001" });
  const ts = Math.floor(Date.now() / 1000);
  const post = (headers) => fetchSite("/api/admin/purge", { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  ok((await post({})).status === 401, "an unsigned purge is refused");
  ok((await post({ "x-sagebrush-timestamp": String(ts), "x-sagebrush-signature": sign(ts, "POST", "/api/admin/purge", body + " ") })).status === 401, "a purge signed over other bytes is refused");
  ok((await post({ "x-sagebrush-timestamp": String(ts - 600), "x-sagebrush-signature": sign(ts - 600, "POST", "/api/admin/purge", body) })).status === 401, "an old signature is refused");
  ok((await post({ "x-sagebrush-timestamp": String(ts), "x-sagebrush-signature": sign(ts, "GET", "/api/admin/purge", body) })).status === 401, "the signature binds the method");
  const r = await adminPurge(C, "9b2d6c1e-0000-4000-8000-000000000001");
  ok(r.status === 202 && (await r.json()).status === "accepted", "a signed purge is accepted");
  let st;
  for (let i = 0; i < 50; i++) {
    st = await purgeStatus("9b2d6c1e-0000-4000-8000-000000000001");
    if (st.status === "done") break;
    await new Promise((res) => setTimeout(res, 50));
  }
  ok(st.status === "done" && st.collections === 1 && st.bytes > mine.length + data.length, "the purge finishes and says what it removed: " + JSON.stringify(st));
  ok((await fetchSite(`/api/share/c/${col}`)).status === 404 && !(await stored(keyC)) && (await bucket.list({ prefix: keyC.slice(0, keyC.lastIndexOf("/") + 1) })).objects.length === 0, "C's collection and its whole prefix are gone");
  ok(await stored(await keyOf(B, sha(data))), "B's copy of a file C also had stays");
  ok((await c.get("/api/share/me")).status === 401, "C's sessions are gone");
  const left = await db.prepare("SELECT (SELECT COUNT(*) FROM accounts WHERE account_id = ?1) + (SELECT COUNT(*) FROM purges WHERE account_id = ?1) + (SELECT COUNT(*) FROM limits_cache WHERE account_id = ?1) AS n").bind(C).first();
  ok(left.n === 0, "no row names C's account id any more (the purge record keeps a hash)");
  const back = await signIn(C);
  ok(back.cb.status === 403 && !back.session, "a deleted CoCalc account can't sign in again (a tombstone, by hash)");
  ok((await adminPurge(C, "9b2d6c1e-0000-4000-8000-000000000001")).status === 202, "a retry with the same request_id is accepted again");
  ok((await adminPurge(B, "9b2d6c1e-0000-4000-8000-000000000001")).status === 409, "the same request_id for another account is refused (SEC-243-8)");
  ok((await adminPurge("44444444-4444-4444-8444-444444444444", "9b2d6c1e-0000-4000-8000-000000000002")).status === 202, "a purge for an account with no data is a normal 202");
}
{
  // SEC-243-2: an account being deleted can't write, or sign in, until it is done
  const W = "66666666-6666-4666-8666-666666666666";
  fake.limits.set(W, { tier: "member", storage_bytes: 10_000, max_file_bytes: 5_000, private_links: false });
  const sw = (await signIn(W)).session;
  const w = api(sw);
  const f = Buffer.from("w's file");
  await w.put(`/api/share/blob/${sha(f)}`, f);
  const col = await (await w.post("/api/share/collections", { title: "W" })).json();
  await db.prepare("UPDATE accounts SET deleting = 1 WHERE account_id = ?1").bind(W).run();
  ok((await w.get("/api/share/me")).status === 401, "its sessions stop at once");
  const { cb } = await signIn(W);
  ok(cb.status === 403, "it can't sign in while being deleted");
  const commit = await fetchSite(`/api/share/collections/${col.id}/versions`, { method: "POST", headers: { cookie: sw, origin: SITE, "content-type": "application/json" }, body: JSON.stringify({ files: [{ path: "w", sha256: sha(f), size: f.length }] }) });
  ok(commit.status === 401, "nor commit");
}
{
  // SEC-6DA-1: a request authenticated before a purge can't write after it
  const D = "77777777-7777-4777-8777-777777777777";
  fake.limits.set(D, { tier: "member", storage_bytes: 10_000, max_file_bytes: 5_000, private_links: false });
  const d = api((await signIn(D)).session);
  await db.prepare("DELETE FROM limits_cache WHERE account_id = ?1").bind(D).run();
  let release;
  fake.limitsGate = new Promise((r) => (release = r));
  const creating = d.post("/api/share/collections", { title: "late" });
  await new Promise((r) => setTimeout(r, 200));
  fake.limitsGate = null;
  ok((await adminPurge(D, "9b2d6c1e-0000-4000-8000-0000000000d1")).status === 202, "a purge while a request waits on CoCalc");
  for (let i = 0; i < 50 && (await purgeStatus("9b2d6c1e-0000-4000-8000-0000000000d1")).status !== "done"; i++) await new Promise((r) => setTimeout(r, 50));
  release();
  const late = await creating;
  const rows = await db.prepare("SELECT (SELECT COUNT(*) FROM collections WHERE owner = ?1) + (SELECT COUNT(*) FROM limits_cache WHERE account_id = ?1) + (SELECT COUNT(*) FROM accounts WHERE account_id = ?1) AS n").bind(D).first();
  ok(late.status !== 201 && rows.n === 0, `the request that was waiting writes nothing afterwards: ${late.status}, ${rows.n} rows`);
}
{
  // SEC-6DA-2: an upload whose reservation was reclaimed while it ran is refused, and leaves nothing
  const E = "88888888-8888-4888-8888-888888888888";
  fake.limits.set(E, { tier: "member", storage_bytes: 10_000, max_file_bytes: 5_000, private_links: false });
  const se = (await signIn(E)).session;
  const bytes = Buffer.from("slow upload bytes");
  let go;
  const gate = new Promise((r) => (go = r));
  const body = new ReadableStream({ async start(c) { c.enqueue(bytes.subarray(0, 4)); await gate; c.enqueue(bytes.subarray(4)); c.close(); } });
  const putting = fetchSite(`/api/share/blob/${sha(bytes)}`, { method: "PUT", headers: { cookie: se, origin: SITE, "content-length": String(bytes.length) }, body, duplex: "half" });
  let reserved = null;
  for (let i = 0; i < 50 && !reserved; i++) {
    reserved = await db.prepare("SELECT id, key FROM reservations WHERE account_id = ?1").bind(E).first();
    if (!reserved) await new Promise((r) => setTimeout(r, 20));
  }
  if (reserved) {
    await db.prepare("UPDATE reservations SET expires = 1 WHERE id = ?1").bind(reserved.id).run();
    await tick();
  }
  go();
  const r = await putting;
  const holding = await keyOf(E, sha(bytes));
  ok(!!reserved && r.status !== 200 && !holding && !(await stored(reserved.key)), `a reclaimed upload is refused and leaves no object: ${r.status}, reserved ${!!reserved}, holding ${!!holding}`);
  // and an object no row references is found by the inventory check, two days on
  const stray = "a/0000000000000000000000000000strv/late";
  await bucket.put(stray, "late");
  await tick();
  ok(await stored(stray), "a fresh unreferenced object is left alone (it may be an upload in progress)");
}
{
  // SEC-6DA-3: purges of one account coalesce; an admin deletion dominates
  for (const order of ["admin-admin", "self-admin"]) {
    const F = order === "admin-admin" ? "99999999-9999-4999-8999-999999999991" : "99999999-9999-4999-8999-999999999992";
    fake.limits.set(F, { tier: "member", storage_bytes: 10_000, max_file_bytes: 5_000, private_links: false });
    const f = api((await signIn(F)).session);
    await upload(f, [["f.txt", Buffer.from("f " + order)]], "F");
    const ids = [`9b2d6c1e-0000-4000-8000-0000000f${order === "admin-admin" ? "01" : "11"}01`, `9b2d6c1e-0000-4000-8000-0000000f${order === "admin-admin" ? "01" : "11"}02`];
    if (order === "admin-admin") await Promise.all(ids.map((rid) => adminPurge(F, rid)));
    else await Promise.all([f.post("/api/share/delete-everything", { confirm: "delete" }), adminPurge(F, ids[1])]);
    for (let i = 0; i < 3; i++) await tick();
    const sts = await Promise.all(ids.slice(order === "admin-admin" ? 0 : 1).map(async (rid) => (await purgeStatus(rid)).status));
    const all = await db.prepare("SELECT COUNT(*) AS n FROM purges WHERE account_hash = (SELECT account_hash FROM purges WHERE request_id = ?1) AND status <> 'done'").bind(ids[1]).first();
    const acct = await db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE account_id = ?1").bind(F).first();
    const back = await signIn(F);
    ok(sts.every((x) => x === "done") && all.n === 0 && acct.n === 0 && !back.session, `${order}: every purge finishes, and the account is gone for good: ${JSON.stringify(sts)}, ${all.n} unfinished, ${acct.n} account rows`);
  }
}
{
  // "Delete my shared data"
  const r = await b.post("/api/share/delete-everything", {});
  ok(r.status === 400, "delete-everything needs confirmation");
  const keyB = await keyOf(B, sha(data));
  const r2 = await b.post("/api/share/delete-everything", { confirm: "delete" });
  ok(r2.status === 200, "delete-everything");
  await tick();
  ok(!(await stored(keyB)), "B's files are deleted from R2");
  const left = await db.prepare("SELECT (SELECT COUNT(*) FROM collections WHERE owner = ?1) + (SELECT COUNT(*) FROM holdings WHERE account_id = ?1) + (SELECT COUNT(*) FROM sessions WHERE account_id = ?1) AS n").bind(B).first();
  ok(left.n === 0, "nothing of B's is left in D1");
  const again = await signIn(B);
  ok(!!again.session, "B can sign in and share again afterwards");
}
{
  // the daily job drops uploads nobody committed within a day
  const keyPending = await keyOf(A, sha(Buffer.from("pending upload")));
  await db.prepare("UPDATE holdings SET created = created - 2 * 86400").run();
  await tick();
  ok(!(await stored(keyPending)) && !(await keyOf(A, sha(Buffer.from("pending upload")))), "an upload never committed is dropped after a day");
}

await mf.dispose();
console.log(`${count - failures}/${count} passed`);
process.exit(failures ? 1 : 0);
