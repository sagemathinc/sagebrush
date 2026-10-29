// Tests for the share API and the files Worker (web/share/), in Miniflare
// with a real D1 and R2 simulation, and a fake CoCalc for sign-in and limits.
//
//   node web/share/test-share.mjs
import { createHash, createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
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
for (const m of readdirSync(join(here, "migrations")).filter((f) => f.endsWith(".sql")).sort())
  for (const s of readFileSync(join(here, "migrations", m), "utf8").replace(/--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean)) await db.prepare(s).run();

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
  // (the response read before anything else is awaited: Miniflare's bodies don't wait)
  const vj = await v.json();
  keyA = await keyOf(A, sha(data));
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
// (and dot segments, which normalize to //host: SEC-SHARE-1)
for (const ret of ["/\t/evil.example/proof", "/\n/evil.example/", "/\r/evil.example/", " /x", "/\\evil.example", "//evil.example", "/%09/evil.example", "https://evil.example/", "/x\u0000", "/%2e%2e//evil.example/proof", "/%2E%2E//evil.example/", "/a/%2e%2e/%2e%2e//evil.example/", "/./..//evil.example/", "/a/..//evil.example/"]) {
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
  {
    // its length, checked before anything else: none or 0 (no body) 411, over 4096 413 (signed, so only the length decides)
    const signedHeaders = (b) => ({ "content-type": "application/json", "x-sagebrush-timestamp": String(ts), "x-sagebrush-signature": sign(ts, "POST", "/api/admin/purge", b) });
    const noLen = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(body)); c.close(); } });
    const r0 = await fetchSite("/api/admin/purge", { method: "POST", headers: signedHeaders(body), body: noLen, duplex: "half" });
    ok(r0.status === 411, "a purge without a content-length gets 411: " + r0.status);
    const r1 = await fetchSite("/api/admin/purge", { method: "POST", headers: signedHeaders("") });
    ok(r1.status === 411, "a purge with no body gets 411: " + r1.status);
    const r2 = await fetchSite("/api/admin/purge", { method: "POST", headers: signedHeaders(""), body: "" });
    ok(r2.status === 411, "an empty body (content-length 0) gets 411: " + r2.status);
    const big = JSON.stringify({ account_id: C, request_id: "9b2d6c1e-0000-4000-8000-000000000001", pad: "x".repeat(4097) });
    const r3 = await fetchSite("/api/admin/purge", { method: "POST", headers: signedHeaders(big), body: big });
    ok(r3.status === 413, "a purge over 4096 bytes gets 413: " + r3.status);
    const edge = JSON.stringify({ account_id: C, request_id: "9b2d6c1e-0000-4000-8000-0000000000ff", pad: "" });
    const at = edge.slice(0, -2) + "x".repeat(4096 - edge.length) + '"}';
    const r4 = await fetchSite("/api/admin/purge", { method: "POST", headers: signedHeaders(at + " "), body: at });
    ok(at.length === 4096 && r4.status === 401, "exactly 4096 bytes passes the length check (and, signed over other bytes here, stops at the signature): " + r4.status);
    ok(!(await db.prepare("SELECT 1 AS x FROM purges WHERE request_id IN ('9b2d6c1e-0000-4000-8000-000000000001', '9b2d6c1e-0000-4000-8000-0000000000ff')").first()), "none of them started a purge");
  }
  {
    // the length predicate itself, for values no HTTP client sends with a real body (a length that
    // isn't the body's: the platform refuses or rewrites those before the Worker), bundled as the Worker is
    const src = execFileSync("bun", ["build", join(here, "server.ts"), "--format", "esm", "--target", "browser"], { encoding: "utf8" });
    const { adminLength } = await import("data:text/javascript;base64," + Buffer.from(src).toString("base64"));
    const cases = [[null, 411], ["", 411], ["0", 411], ["0000000000000", 411], ["+10", 411], ["-1", 411], [" 10", 411], ["10 ", 411], ["1e3", 411], ["0x10", 411], ["١٠", 411], ["10", null], ["0010", null], ["4096", null], ["4097", 413], ["1000000000000", 413], ["9".repeat(400), 413]];
    const wrong = cases.filter(([v, want]) => adminLength(v) !== want).map(([v, want]) => `${JSON.stringify(v)}: ${adminLength(v)}, not ${want}`);
    ok(wrong.length === 0 && Number("9".repeat(400)) === Infinity, "the purge's Content-Length: 411 unless ASCII digits over 0, then 413 over 4096 at any length (Infinity included): " + (wrong.join("; ") || "all " + cases.length));
  }
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
{
  // HARD-SHARE-3: what a signed-in loop can pile up is bounded
  const S = "55555555-5555-4555-8555-555555555555";
  let last;
  for (let i = 0; i < 24; i++) last = (await signIn(S)).session;
  const n = (await db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE account_id = ?1").bind(S).first()).n;
  ok(n === 20 && (await api(last).get("/api/share/me")).status === 200, `at most 20 sessions per account, the newest kept: ${n}`);
  // (20 sessions made in this same second, with the lowest hashes: the new one is still kept, CORR-E55-1)
  const sec = Math.floor(Date.now() / 1000);
  await db.batch(Array.from({ length: 20 }, (_, i) => db.prepare("INSERT INTO sessions (token_hash, account_id, created, expires) VALUES (?1, ?2, ?3, ?4)").bind(i.toString(16).padStart(64, "0"), S, sec, sec + 86400)));
  const tied = (await signIn(S)).session;
  ok((await api(tied).get("/api/share/me")).status === 200, "a session made in the same second as 20 others is the one kept");
  // records of deleted collections: at most 1000 per account, and 30 days
  const hA = sha("sagebrush-account\n" + A);
  const old = Math.floor(Date.now() / 1000) - 40 * 86400;
  const fill = [];
  for (let i = 0; i < 1005; i++) fill.push(db.prepare("INSERT INTO purges (request_id, account_hash, collection, kind, status, collections, bytes, created, finished) VALUES (?1, ?2, 'aaaaaaaaaaaa', 'collection', 'done', 1, 0, ?3, ?3)").bind(`fill-${i}`, hA, old + i));
  await db.batch(fill);
  const col = await (await a.post("/api/share/collections", { title: "gone" })).json();
  ok((await a.del(`/api/share/collections/${col.id}`)).status === 200, "a collection deleted");
  const kept = (await db.prepare("SELECT COUNT(*) AS n FROM purges WHERE kind = 'collection' AND account_hash = ?1").bind(hA).first()).n;
  const newest = await db.prepare("SELECT COUNT(*) AS n FROM purges WHERE kind = 'collection' AND account_hash = ?1 AND collection = ?2").bind(hA, col.id).first();
  ok(kept === 1000 && newest.n === 1, `at most 1000 records of deleted collections per account, the newest kept: ${kept}`);
  // (and finished self-deletions after 30 days, account deletions after a year, HARD-E55-2)
  await db.batch([
    db.prepare("INSERT INTO purges (request_id, account_hash, kind, status, created, finished) VALUES ('old-self', ?1, 'self', 'done', ?2, ?2)").bind(hA, old),
    db.prepare("INSERT INTO purges (request_id, account_hash, kind, status, created, finished) VALUES ('old-admin', ?1, 'admin', 'done', ?2, ?2)").bind(hA, old),
    db.prepare("INSERT INTO purges (request_id, account_hash, kind, status, created, finished) VALUES ('older-admin', ?1, 'admin', 'done', ?2, ?2)").bind(hA, old - 400 * 86400),
  ]);
  await tick();
  const kinds = (await db.prepare("SELECT request_id FROM purges WHERE request_id IN ('old-self', 'old-admin', 'older-admin')").all()).results.map((r) => r.request_id);
  ok(kinds.join() === "old-admin", `finished self-deletions go after 30 days, account deletions after a year: ${kinds.join()}`);
  const stale = (await db.prepare("SELECT COUNT(*) AS n FROM purges WHERE kind = 'collection' AND finished < ?1").bind(Math.floor(Date.now() / 1000) - 30 * 86400).first()).n;
  const fresh = await db.prepare("SELECT COUNT(*) AS n FROM purges WHERE kind = 'collection' AND collection = ?1").bind(col.id).first();
  ok(stale === 0 && fresh.n === 1, `records older than 30 days go with the daily job, newer ones stay: ${stale} old left`);
}
{
  // PRIV-SHARE-2: whether a purged account's row goes is decided with the
  // purge's last write (a tombstone written after its files were found
  // empty still counts)
  const G = "66666666-6666-4666-8666-666666666666";
  const hG = sha("sagebrush-account\n" + G);
  const t = Math.floor(Date.now() / 1000);
  await db.batch([
    db.prepare("INSERT OR REPLACE INTO accounts (account_id, created, last_login, deleting) VALUES (?1, ?2, ?2, ?2)").bind(G, t),
    db.prepare("INSERT INTO purges (request_id, account_hash, account_id, kind, status, created) VALUES ('self-race', ?1, ?2, 'self', 'files', ?3)").bind(hG, G, t),
    db.prepare("INSERT INTO r2_deletes (key, prefix, account_id, created) VALUES (?1, 1, ?2, ?3)").bind(`a/${hG.slice(0, 32)}/`, G, t),
    db.prepare("INSERT INTO tombstones (account_hash, created) VALUES (?1, ?2)").bind(hG, t),
    db.prepare("INSERT INTO purges (request_id, account_hash, account_id, kind, status, created) VALUES ('admin-race', ?1, ?2, 'admin', 'files', ?3)").bind(hG, G, t),
  ]);
  await tick();
  const row = await db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE account_id = ?1").bind(G).first();
  const sts = (await db.prepare("SELECT status FROM purges WHERE request_id IN ('self-race', 'admin-race')").all()).results.map((r) => r.status);
  ok(row.n === 0 && sts.length === 2 && sts.every((s) => s === "done"), `a purge finishing with a tombstone present removes the account row: ${row.n} rows, ${JSON.stringify(sts)}`);
}

// ---- first uploads (plan-upload-leak r3): a share's collection is made by its first version's own
// transaction, with its attempt's receipt; a failed upload leaves nothing, and a retry of the attempt
// gets that share back (never another), or a refusal
{
  const { randomBytes } = await import("node:crypto");
  // (accounts no block above uses)
  const owner = (n) => `c0ffee0${n}-0000-4000-8000-00000000000${n}`;
  const R = owner("1"), R2 = owner("2"), L = owner("3"), Q = owner("4"), D = owner("5"), P = owner("6");
  for (const a of [R, R2, L, D, P]) fake.limits.set(a, { tier: "member", storage_bytes: 1_000_000, max_file_bytes: 50_000, private_links: false });
  fake.limits.set(Q, { tier: "member", storage_bytes: 40, max_file_bytes: 50_000, private_links: false });
  const rows = async (o) => (await db.prepare("SELECT COUNT(*) AS n FROM collections WHERE owner = ?1").bind(o).first()).n;
  const receipts = async (o) => (await db.prepare("SELECT COUNT(*) AS n FROM upload_receipts WHERE owner = ?1").bind(o).first()).n;
  const versions = async (cid) => (await db.prepare("SELECT COUNT(*) AS n FROM versions WHERE collection = ?1").bind(cid).first()).n;
  const att = () => randomBytes(16).toString("hex");
  const blob = async (c, path, text) => { const b = Buffer.from(text); await c.put(`/api/share/blob/${sha(b)}`, b); return { path, sha256: sha(b), size: b.length }; };
  const first = (c, body) => c.post("/api/share/first-upload", body);
  // (requests really at once: each held at CoCalc's limits, which a fresh cache asks for, then all let go
  // together, so each passes its receipt check before any commits; without this the worker finishes one first)
  const atOnce = async (who, reqs) => {
    await db.prepare("DELETE FROM limits_cache WHERE account_id = ?1").bind(who).run();
    let go;
    fake.limitsGate = new Promise((res) => (go = res));
    const out = reqs.map((f) => f());
    await new Promise((res) => setTimeout(res, 300));
    fake.limitsGate = null;
    go();
    return Promise.all(out);
  };
  const served = async (id, v) => { const r = await fetchSite(`/api/share/c/${id}${v ? `?at=${v}` : ""}`); return r.status === 200 ? (await r.json()).manifest.files.map((f) => f.path).sort().join() : r.status; };
  const r = api((await signIn(R)).session);
  const e1 = await blob(r, "a.txt", "first file"), e2 = await blob(r, "private.csv", "a private table"), e3 = await blob(r, "b.txt", "another file");

  // S1
  const a1 = att(), body1 = { title: "S1", license: "MIT", files: [e1, e2], attempt: a1 };
  const s1 = await first(r, body1), j1 = await s1.json();
  const rc1 = await db.prepare("SELECT state, version, collection FROM upload_receipts WHERE owner = ?1").bind(R).first();
  const latest1 = (await db.prepare("SELECT latest FROM collections WHERE id = ?1").bind(j1.collection).first())?.latest;
  ok(s1.status === 201 && j1.url === `/s/${j1.collection}` && latest1 === j1.version && (await rows(R)) === 1 && rc1?.state === "committed" && rc1.version === j1.version && rc1.collection === j1.collection && (await served(j1.collection)) === "a.txt,private.csv",
    "S1 a first upload in one request: 201, one collection whose latest is its version, one committed receipt naming both: " + s1.status);

  // S2: every failure leaves no collection and no receipt
  {
    const c = api((await signIn(R2)).session);
    const f = await blob(c, "x.txt", "R2's file");
    const codes = [];
    codes.push((await first(c, { title: "t", files: [{ ...f, path: "../x" }], attempt: att() })).status);
    codes.push((await first(c, { title: "t", files: [{ path: "y", sha256: sha("never uploaded"), size: 14 }], attempt: att() })).status);
    codes.push((await first(c, { title: "t", files: [f], attempt: "not-hex" })).status);
    codes.push((await first(c, { title: "t", files: [f] })).status);
    codes.push((await first(c, { title: " ", files: [f], attempt: att() })).status);
    codes.push((await first(c, { title: "t", files: [f], attempt: att(), license: "not a license!" })).status);
    const q = api((await signIn(Q)).session);
    const fq = await blob(q, "q.txt", "x".repeat(30));
    codes.push((await first(q, { title: "a title long enough to be over", files: [fq], attempt: att() })).status);
    fake.limits.delete(R2);
    await db.prepare("DELETE FROM limits_cache WHERE account_id = ?1").bind(R2).run();
    codes.push((await first(c, { title: "t", files: [f], attempt: att() })).status);
    fake.limits.set(R2, { tier: "member", storage_bytes: 1_000_000, max_file_bytes: 50_000, private_links: false });
    ok(codes.join() === "400,409,400,400,400,400,413,403" && (await rows(R2)) + (await receipts(R2)) + (await rows(Q)) + (await receipts(Q)) === 0,
      "S2 a bad entry, a file not uploaded, a bad or missing attempt, no title, a bad license, a manifest over quota, no limits: refused, leaving no collection and no receipt: " + codes.join());
  }

  // S3: the collection limit inside the transaction
  {
    const c = api((await signIn(L)).session);
    const f = await blob(c, "l.txt", "L's file");
    const t = Math.floor(Date.now() / 1000);
    await db.prepare("INSERT INTO collections (id, owner, title, created, updated) SELECT printf('l%011d', value), ?1, 'seed', ?2, ?2 FROM json_each(?3)").bind(L, t, JSON.stringify([...Array(999).keys()])).run();
    const both = await atOnce(L, [() => first(c, { title: "x", files: [f], attempt: att() }), () => first(c, { title: "y", files: [f], attempt: att() })]);
    const st = both.map((x) => x.status).sort().join();
    const after = await rows(L);
    const third = (await first(c, { title: "z", files: [f], attempt: att() })).status;
    ok(st === "201,403" && after === 1000 && third === 403 && (await rows(L)) === 1000 && (await receipts(L)) === 1, `S3 at 999 collections, two first uploads at once: one made, one refused (${st}), 1000 collections; at 1000, refused (${third})`);
  }

  // S4: replays
  {
    const v1 = j1.version, c1 = j1.collection;
    const again = await first(r, body1), ja = await again.json();
    ok(again.status === 200 && ja.version === v1 && ja.collection === c1 && (await rows(R)) === 1 && (await versions(c1)) === 1, "S4a a lost response, then the same request: 200 with the receipt's version, still one collection and one version: " + again.status);
    const changed = [{ ...body1, files: [e1] }, { ...body1, files: [e1, e2, e3] }, { ...body1, title: "S1 renamed" }, { ...body1, license: "CC0-1.0" }, { ...body1, license: undefined }];
    const res = [];
    for (const b of changed) { const x = await first(r, b); const j = await x.json(); res.push(x.status === 409 && j.error === "attempt_used" && j.collection === c1 && j.version === v1); }
    ok(res.every(Boolean) && (await rows(R)) === 1 && (await versions(c1)) === 1 && (await served(c1)) === "a.txt,private.csv", "S4b the same attempt with other files, title or license: 409 attempt_used naming the first share, nothing written, and the share still holds the first request's files: " + res.join());
    const a2 = att();
    const race = await atOnce(R, [() => first(r, { title: "S4c", files: [e1], attempt: a2 }), () => first(r, { title: "S4c", files: [e3], attempt: a2 })]);
    const rj = await Promise.all(race.map((x) => x.json()));
    const win = rj.find((_, i) => race[i].status === 201), lose = rj.find((_, i) => race[i].status === 409);
    ok(race.map((x) => x.status).sort().join() === "201,409" && lose?.error === "attempt_used" && lose.version === win?.version && (await served(win.collection)) === (race[0].status === 201 ? "a.txt" : "b.txt") && (await rows(R)) === 2,
      "S4c one attempt, two payloads at once: one 201, one 409 naming the winner's version, and the share holds the winner's files: " + race.map((x) => x.status).join());
    const a3 = att();
    const twins = await atOnce(R, [() => first(r, { title: "S4d", files: [e3], attempt: a3 }), () => first(r, { title: "S4d", files: [e3], attempt: a3 })]);
    const tj = await Promise.all(twins.map((x) => x.json()));
    ok(twins.map((x) => x.status).sort().join() === "200,201" && tj[0].version === tj[1].version && tj[0].collection === tj[1].collection && (await rows(R)) === 3, "S4d one attempt, the same payload at once: one 201 and one 200, naming the same version: " + twins.map((x) => x.status).join());
    const v2 = await r.post(`/api/share/collections/${c1}/versions`, { files: [e1, e3] });
    const v2j = await v2.json();
    const late = await first(r, body1), lj = await late.json();
    ok(v2.status === 201 && v2j.version !== v1 && late.status === 200 && lj.version === v1 && (await served(c1, lj.version)) === "a.txt,private.csv", "S4e a replay after another version became latest: 200 with the first version, not the latest");
    const o = api((await signIn(R2)).session);
    const eo = await blob(o, "a.txt", "first file");
    const other = await first(o, { ...body1, files: [eo, await blob(o, "private.csv", "a private table")] });
    const oj = await other.json();
    ok(other.status === 201 && oj.collection !== c1 && (await rows(R2)) === 1 && (await versions(c1)) === 2, "S4f the same attempt from another account: its own share, the first untouched");
    const extra = await first(r, { ...body1, unknown: "anything" });
    ok(extra.status === 200 && (await extra.json()).version === v1, "S5g the digest is the manifest's fields only: an unknown extra property changes nothing (200)");
  }

  // S5: deletion retires
  {
    const a4 = att(), b4 = { title: "S5", files: [e1], attempt: a4 };
    const j4 = await (await first(r, b4)).json();
    ok((await r.del(`/api/share/collections/${j4.collection}`)).status === 200, "(S5 the share is deleted)");
    const re = await first(r, b4);
    const st4 = (await db.prepare("SELECT state FROM upload_receipts WHERE owner = ?1 AND collection = ?2").bind(R, j4.collection).first())?.state;
    ok(re.status === 410 && (await re.json()).error === "attempt_retired" && (await served(j4.collection)) === 404 && st4 === "retired" && !(await db.prepare("SELECT 1 AS x FROM collections WHERE id = ?1").bind(j4.collection).first()),
      "S5a a lost response, a deletion, then the replay: 410 attempt_retired, the old link still 404, the receipt retired");
    let raced = 0;
    for (let i = 0; i < 20; i++) {
      const a = att(), b = { title: "race", files: [e1], attempt: a };
      const j = await (await first(r, b)).json();
      await Promise.all([first(r, b), r.del(`/api/share/collections/${j.collection}`)]);
      const after = await first(r, b);
      const gone = !(await db.prepare("SELECT 1 AS x FROM collections WHERE id = ?1").bind(j.collection).first()) && (await served(j.collection)) === 404;
      const st = (await db.prepare("SELECT state FROM upload_receipts WHERE owner = ?1 AND collection = ?2").bind(R, j.collection).first())?.state;
      if (gone && st === "retired" && after.status === 410) raced++;
    }
    ok(raced === 20, `S5b a replay racing the deletion (20 times): after both settle, no collection, the link 404 and the receipt retired; a replay started after it gets 410 (${raced}/20)`);
    const d = api((await signIn(D)).session);
    const ed = await blob(d, "d.txt", "D's file");
    const bd = { title: "D", files: [ed], attempt: att() };
    ok((await first(d, bd)).status === 201, "(S5c D shares)");
    const del = await d.post("/api/share/delete-everything", { confirm: "delete" });
    for (let i = 0; i < 50 && (await db.prepare("SELECT 1 AS x FROM accounts WHERE account_id = ?1 AND deleting IS NOT NULL").bind(D).first()); i++) { await tick(); await new Promise((res) => setTimeout(res, 50)); }
    const d2 = api((await signIn(D)).session);
    const ed2 = await blob(d2, "d.txt", "D's file");
    const rd = await first(d2, { ...bd, files: [ed2] });
    ok(del.status === 200 && rd.status === 410 && (await rows(D)) === 0, "S5c after deleting everything and signing in again, an old attempt gets 410, not a new share: " + rd.status);
    const p = api((await signIn(P)).session);
    const ep = await blob(p, "p.txt", "P's file");
    ok((await first(p, { title: "P", files: [ep], attempt: att() })).status === 201 && (await receipts(P)) === 1, "(S5d P shares)");
    ok((await adminPurge(P, "9b2d6c1e-0000-4000-8000-0000000000c5")).status === 202, "(S5d CoCalc purges P)");
    for (let i = 0; i < 50 && (await receipts(P)); i++) await new Promise((res) => setTimeout(res, 50));
    ok((await receipts(P)) === 0, "S5d an account deleted in CoCalc: its receipts go with it");
    await db.prepare("UPDATE upload_receipts SET retired = retired - 31 * 86400 WHERE owner = ?1 AND collection = ?2").bind(R, j4.collection).run();
    await tick();
    const left = await db.prepare("SELECT COUNT(*) AS n FROM upload_receipts WHERE owner = ?1 AND collection = ?2").bind(R, j4.collection).first();
    const anew = await first(r, b4), jn = await anew.json();
    ok(left.n === 0 && anew.status === 201 && jn.collection !== j4.collection && (await served(j4.collection)) === 404, "S5e a retired receipt goes after 30 days; a request carrying its attempt then makes a new share, with a new id, and the deleted link stays dead");
  }

  // S6: the older page's form still works, and still leaves an empty collection when its upload fails (the known leak, until it is removed)
  {
    const c = api((await signIn(R2)).session);
    const before = await rows(R2);
    const legacy = await (await c.post("/api/share/collections", { title: "legacy" })).json();
    const f = await blob(c, "l.txt", "legacy file");
    const v = await c.post(`/api/share/collections/${legacy.id}/versions`, { files: [f] });
    const failed = await (await c.post("/api/share/collections", { title: "legacy, failed" })).json();
    const empty = await db.prepare("SELECT latest FROM collections WHERE id = ?1").bind(failed.id).first();
    ok(v.status === 201 && (await rows(R2)) === before + 2 && empty && empty.latest === null, "S6 the older {title} form: create then commit works; one never committed stays an empty collection (the known leak)");
    // (the older form's path never takes a first upload's form for a {title}: no empty collection from it)
    const n = await rows(R2);
    const wrong = await c.post("/api/share/collections", { title: "t", files: [f], attempt: att() });
    ok(wrong.status === 400 && (await rows(R2)) === n, "S6 a first upload's form sent to the older path is refused (400), making no collection: " + wrong.status);
  }

  // S9 (daybreak3's S1): deleted shares' receipts are bounded per account, however fast shares are made and deleted
  {
    const X = owner("7");
    fake.limits.set(X, { tier: "member", storage_bytes: 1_000_000, max_file_bytes: 50_000, private_links: false });
    const c = api((await signIn(X)).session);
    const t = Math.floor(Date.now() / 1000);
    // (1200 older deletions, seeded: more than the account keeps)
    await db.prepare("INSERT INTO upload_receipts (owner, attempt_hash, request_digest, collection, version, state, created, retired) SELECT ?1, printf('h%06d', value), 'd', printf('x%011d', value), 'v', 'retired', ?2, ?2 + value FROM json_each(?3)").bind(X, t - 3600, JSON.stringify([...Array(1200).keys()])).run();
    const f = await blob(c, "x.txt", "X's file");
    const j = await (await first(c, { title: "X", files: [f], attempt: att() })).json();
    ok((await c.del(`/api/share/collections/${j.collection}`)).status === 200, "(S9 X deletes a share)");
    const kept = await db.prepare("SELECT COUNT(*) AS n, SUM(collection = ?2) AS mine, MIN(retired) AS oldest FROM upload_receipts WHERE owner = ?1 AND state = 'retired'").bind(X, j.collection).first();
    ok(kept.n === 1000 && kept.mine === 1 && kept.oldest === t - 3600 + 201, `S9 at most 1000 deleted shares' receipts per account, the newest (the one just deleted included): ${JSON.stringify(kept)}`);
  }
  // S10: a backlog past its days, larger than a page, drains over scheduled runs; younger receipts stay
  {
    const t = Math.floor(Date.now() / 1000);
    const ids = JSON.stringify([...Array(12_000).keys()]);
    await db.prepare("INSERT INTO upload_receipts (owner, attempt_hash, request_digest, collection, version, state, created, retired) SELECT 'old-' || (value % 3), printf('a%06d', value), 'd', printf('y%011d', value), 'v', 'retired', ?1, ?1 FROM json_each(?2)").bind(t - 31 * 86400, ids).run();
    await db.prepare("INSERT INTO upload_receipts (owner, attempt_hash, request_digest, collection, version, state, created, retired) SELECT 'old-0', printf('b%06d', value), 'd', printf('z%011d', value), 'v', 'retired', ?1, ?1 FROM json_each(?2)").bind(t - 86400, JSON.stringify([0, 1, 2, 3, 4])).run();
    const aged = async () => (await db.prepare("SELECT COUNT(*) AS n FROM upload_receipts WHERE owner LIKE 'old-%' AND retired < ?1").bind(t - 30 * 86400).first()).n;
    const a0 = await aged();
    await tick();
    const a1 = await aged();
    await tick();
    const a2 = await aged();
    const young = (await db.prepare("SELECT COUNT(*) AS n FROM upload_receipts WHERE owner = 'old-0' AND retired >= ?1").bind(t - 30 * 86400).first()).n;
    ok(a0 === 12_000 && a1 === 2000 && a2 === 0 && young === 5, `S10 12,000 receipts past their days: 10,000 removed by one run (20 pages of 500), the rest by the next; 5 younger ones stay (${a0} -> ${a1} -> ${a2}, young ${young})`);
  }

  // S11 (daybreak3's S2): a Worker rolled back to before this change (b06b01b7's share server, from git history),
  // and this change's page client (uploadCollection, bundled as the page is): the upload fails, and the old server
  // never makes an empty collection, as nothing reaches the path that would.  Without that history (a shallow
  // clone, as in CI) it is skipped, saying so; test-upload.mjs's U5 checks the same against the old routes' answers.
  {
    let dir = null;
    try {
      execFileSync("git", ["cat-file", "-e", "b06b01b7^{commit}"], { cwd: here, stdio: "ignore" });
      const { mkdtempSync, writeFileSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      dir = mkdtempSync(join(tmpdir(), "share-old-"));
      for (const f of ["server.ts", "files.ts", "test-entry.ts"]) writeFileSync(join(dir, f), execFileSync("git", ["show", `b06b01b7:web/share/${f}`], { cwd: here }));
    } catch { dir = null; }
    // (and only with this change's page client: in a two-phase rollout's first phase, the page is still the older one)
    const newClient = readFileSync(join(here, "../share-client/upload.ts"), "utf8").includes("/api/share/first-upload");
    if (!newClient) console.log("SKIP S11: the page client here predates /api/share/first-upload (the rollout's server-first phase)");
    else if (!dir) console.log("SKIP S11: no git history for b06b01b7 here (a shallow clone); U5 in test-upload.mjs covers the client against the old routes");
    else {
      const oldScript = execFileSync("bun", ["build", join(dir, "test-entry.ts"), "--format", "esm", "--target", "browser"], { encoding: "utf8" });
      const m3 = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: "old-share", modules: true, script: oldScript, compatibilityDate: "2026-10-01", d1Databases: ["SHARE_DB"], r2Buckets: ["SHARE_BUCKET"], bindings, outboundService: cocalc }] }));
      const d3 = await m3.getD1Database("SHARE_DB");
      for (const m of readdirSync(join(here, "migrations")).filter((f) => f.endsWith(".sql") && f < "0005").sort())
        for (const st of readFileSync(join(here, "migrations", m), "utf8").replace(/--.*$/gm, "").split(";").map((x) => x.trim()).filter(Boolean)) await d3.prepare(st).run();
      const O = owner("8");
      fake.limits.set(O, { tier: "member", storage_bytes: 1_000_000, max_file_bytes: 50_000, private_links: false });
      const dev = await m3.dispatchFetch(SITE + "/auth/dev", { method: "POST", headers: { origin: SITE, "content-type": "application/json" }, body: JSON.stringify({ token: "dev-token", account_id: O }) });
      const cookie = (dev.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).find((c) => c.startsWith("__Host-sb_session="));
      const clientSrc = execFileSync("bun", ["build", join(here, "../share-client/upload.ts"), "--format", "esm", "--target", "browser"], { encoding: "utf8" });
      const { uploadCollection } = await import("data:text/javascript;base64," + Buffer.from(clientSrc).toString("base64"));
      const realFetch = globalThis.fetch, realLocation = globalThis.location;
      const paths = [];
      globalThis.location = { href: SITE + "/" };
      globalThis.fetch = async (u, init = {}) => { const url = new URL(String(u), SITE); paths.push(`${init.method ?? "GET"} ${url.pathname}`); return m3.dispatchFetch(url.href, { ...init, headers: { ...(init.headers ?? {}), cookie, origin: SITE } }); };
      let e = null;
      try { await uploadCollection({ id: null, attempt: "0".repeat(31) + "1", title: "rolled back", files: [{ path: "a.txt", size: 5, read: async () => new TextEncoder().encode("hello") }] }); } catch (x) { e = x; }
      globalThis.fetch = realFetch;
      globalThis.location = realLocation;
      const n = (await d3.prepare("SELECT COUNT(*) AS n FROM collections WHERE owner = ?1").bind(O).first()).n;
      await m3.dispose();
      ok(dev.status === 200 && !!cookie && e instanceof Error && n === 0 && !paths.includes("POST /api/share/collections") && paths.includes("POST /api/share/first-upload"), `S11 this page's client against b06b01b7's server (a rolled-back Worker): the upload fails (${e?.message}), and no collection is made (${n}); requests: ${paths.join(", ")}`);
    }
  }

  // S7: migration 0005, as the post-check reads it
  {
    const objs = (await db.prepare("SELECT type, name, tbl_name FROM sqlite_master WHERE name IN ('upload_receipts', 'upload_receipts_collection', 'upload_receipts_retired', 'collections_empty') ORDER BY name").all()).results.map((o) => `${o.type} ${o.name} ${o.tbl_name}`);
    const cols = (await db.prepare("PRAGMA table_info(upload_receipts)").all()).results;
    const colsOk = cols.map((c) => c.name).join() === "owner,attempt_hash,request_digest,collection,version,state,created,retired" && cols.slice(0, 7).every((c) => c.notnull === 1) && cols[7].notnull === 0 && cols[0].pk === 1 && cols[1].pk === 2;
    const ix = (await db.prepare("PRAGMA index_list(upload_receipts)").all()).results.map((i) => `${i.name}:${i.origin}:${i.partial}`).sort();
    const cx = (await db.prepare("PRAGMA index_list(collections)").all()).results.map((i) => `${i.name}:${i.origin}`).sort();
    ok(objs.join() === "table upload_receipts upload_receipts,index upload_receipts_collection upload_receipts,index upload_receipts_retired upload_receipts" && colsOk && ix.join() === "sqlite_autoindex_upload_receipts_1:pk:0,upload_receipts_collection:c:0,upload_receipts_retired:c:1" && cx.join() === "collections_owner:c,sqlite_autoindex_collections_1:pk",
      "S7a 0005's post-check: the table and its 2 indexes, its columns and key, and collections' indexes unchanged: " + JSON.stringify({ objs, ix, cx }));
    const { Miniflare: M2 } = require("miniflare");
    const m2 = new M2(convertV4MiniflareOptions({ workers: [{ name: "m", modules: true, script: "export default { fetch() { return new Response(null, { status: 404 }); } }", compatibilityDate: "2026-10-01", d1Databases: ["SHARE_DB"] }] }));
    const d2 = await m2.getD1Database("SHARE_DB");
    const run = async (m) => { for (const s of readFileSync(join(here, "migrations", m), "utf8").replace(/--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean)) await d2.prepare(s).run(); };
    for (const m of readdirSync(join(here, "migrations")).filter((f) => f.endsWith(".sql") && f < "0005").sort()) await run(m);
    await d2.prepare("INSERT INTO collections (id, owner, title, created, updated, latest) VALUES ('aaaaaaaaaaaa', 'o', 't', 1, 2, 'h'), ('bbbbbbbbbbbb', 'o', 'u', 3, 4, NULL)").run();
    const before = JSON.stringify((await d2.prepare("SELECT * FROM collections ORDER BY id").all()).results);
    await run("0005_upload_receipts.sql");
    const after = JSON.stringify((await d2.prepare("SELECT * FROM collections ORDER BY id").all()).results);
    await m2.dispose();
    ok(before === after && before.includes("bbbbbbbbbbbb"), "S7b a database at 0004 with collections, then 0005: the collections are unchanged");
  }
}

await mf.dispose();
console.log(`${count - failures}/${count} passed`);
process.exit(failures ? 1 : 0);
