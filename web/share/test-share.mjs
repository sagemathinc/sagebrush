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
const fake = { codes: new Map(), limits: new Map(), limitsStatus: 200, tokenCalls: 0 };
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
const a = api((await signIn(A)).session);
fake.limits.set(B, { tier: "member", storage_bytes: 10_000, max_file_bytes: 5_000, private_links: false });
const b = api((await signIn(B)).session);
const data = Buffer.from("x,y\n1,2\n3,4\n");
const nb = Buffer.from('{"cells": []}');
let colA;
{
  const bad = await a.put(`/api/share/blob/${sha(data)}`, Buffer.from("not the data"));
  ok(bad.status === 400, "R2 refuses bytes that don't match the hash");
  ok(!(await bucket.head(`b/${sha(data)}`)), "nothing stored after a bad upload");
  const { col, v } = await upload(a, [["data/points.csv", data], ["paper.ipynb", nb]], "Paper");
  colA = col;
  const vj = await v.json();
  ok(v.status === 201 && /^[0-9a-f]{64}$/.test(vj.version) && vj.url === `/s/${col}`, "a version is committed");
  const g = await (await fetchSite(`/api/share/c/${col}`)).json();
  ok(g.manifest.files.length === 2 && g.manifest.files[0].path === "data/points.csv" && g.manifest.collection === col && g.manifest.format === "sagebrush-collection" && g.manifest.license === "CC-BY-4.0", "anyone can read the manifest");
  const text = await (await fetchSite(`/api/share/m/${vj.version}`)).text();
  ok(sha(text) === vj.version, "a manifest's name is the SHA-256 of its bytes");
  const at = await (await fetchSite(`/api/share/c/${col}?at=${vj.version.slice(0, 16)}`)).json();
  ok(at.version === vj.version, "a frozen link finds its version");

  const f = await mf.dispatchFetch(`${FILES}/b/${sha(data)}`);
  ok(f.status === 200 && Buffer.from(await f.arrayBuffer()).equals(data), "the files domain serves the file");
  ok(f.headers.get("content-type") === "application/octet-stream" && /^attachment/.test(f.headers.get("content-disposition")) && f.headers.get("x-content-type-options") === "nosniff" && /sandbox/.test(f.headers.get("content-security-policy")), "served as a sandboxed attachment, never a page");
  ok(f.headers.get("access-control-allow-origin") === "*" && f.headers.get("cross-origin-resource-policy") === "cross-origin", "readable with CORS from an isolated page");
  const part = await mf.dispatchFetch(`${FILES}/b/${sha(data)}`, { headers: { range: "bytes=4-6" } });
  ok(part.status === 206 && (await part.text()) === "1,2" && part.headers.get("content-range") === `bytes 4-6/${data.length}`, "range requests");
  const bad416 = await mf.dispatchFetch(`${FILES}/b/${sha(data)}`, { headers: { range: "bytes=999-" } });
  ok(bad416.status === 416, "an unsatisfiable range is 416");
  ok((await mf.dispatchFetch(`${FILES}/x/${sha(data)}`)).status === 404 && (await mf.dispatchFetch(`${FILES}/b/${sha(data)}`, { method: "POST" })).status === 405, "nothing else on the files domain");
  const me = await (await a.get("/api/share/me")).json();
  ok(me.usage === data.length + nb.length, "usage counts the files");
}

// ---- isolation between accounts
{
  const ck = await (await b.post("/api/share/check", { blobs: [{ sha256: sha(data), size: data.length }] })).json();
  ok(ck.missing.includes(sha(data)), "another account can't learn that a file exists (dedup is per account)");
  const col = await (await b.post("/api/share/collections", { title: "B" })).json();
  const v = await b.post(`/api/share/collections/${col.id}/versions`, { files: [{ path: "stolen.csv", sha256: sha(data), size: data.length }] });
  ok(v.status === 409, "an account can't reference a file it hasn't uploaded");
  const v2 = await b.post(`/api/share/collections/${colA}/versions`, { files: [{ path: "x", sha256: sha(data), size: data.length }] });
  ok(v2.status === 404, "an account can't add versions to someone else's collection");
  ok((await b.del(`/api/share/collections/${colA}`)).status === 404, "or delete it");
  const x = await fetchSite("/api/share/collections", { method: "POST", headers: { cookie: (await signIn(B)).session, origin: "https://evil.example", "content-type": "application/json" }, body: "{}" });
  ok(x.status === 403, "a cross-site POST is refused");
  const y = await fetchSite("/api/share/collections", { method: "POST", headers: { cookie: (await signIn(B)).session, origin: SITE, "content-type": "text/plain" }, body: '{"title":"t"}' });
  ok(y.status === 415, "a form-encodable POST is refused");
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
  // A starts another upload, not committed yet
  const pending = Buffer.from("pending upload");
  await a.put(`/api/share/blob/${sha(pending)}`, pending);
  const d = await a.del(`/api/share/collections/${colA}`);
  ok(d.status === 200, "the owner deletes a collection");
  ok((await fetchSite(`/api/share/c/${colA}`)).status === 404, "the collection's link is gone");
  ok(!(await bucket.head(`b/${sha(nb)}`)), "a file nobody else holds is deleted from R2");
  ok(!!(await bucket.head(`b/${sha(data)}`)), "a file B uploaded too stays (B's copy)");
  ok(!!(await bucket.head(`b/${sha(pending)}`)), "A's upload for another collection is not touched");
  const vs = await db.prepare("SELECT COUNT(*) AS n FROM versions WHERE collection = ?").bind(colA).first();
  ok(vs.n === 0, "its versions are gone from D1");
}
{
  // the account-deletion purge, signed by CoCalc
  const C = "33333333-3333-4333-8333-333333333333";
  fake.limits.set(C, { tier: "member", storage_bytes: 10_000, max_file_bytes: 5_000, private_links: false });
  const c = api((await signIn(C)).session);
  const mine = Buffer.from("only C has this");
  const { col } = await upload(c, [["c.txt", mine], ["same.csv", data]], "C");
  const body = JSON.stringify({ account_id: C, request_id: "9b2d6c1e-0000-4000-8000-000000000001" });
  const sign = (ts, method, path, b) => "sha256=" + createHmac("sha256", PURGE_KEY).update(`${ts}\n${method}\n${path}\n${b}`).digest("hex");
  const ts = Math.floor(Date.now() / 1000);
  const post = (headers) => fetchSite("/api/admin/purge", { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  ok((await post({})).status === 401, "an unsigned purge is refused");
  ok((await post({ "x-sagebrush-timestamp": String(ts), "x-sagebrush-signature": sign(ts, "POST", "/api/admin/purge", body + " ") })).status === 401, "a purge signed over other bytes is refused");
  ok((await post({ "x-sagebrush-timestamp": String(ts - 600), "x-sagebrush-signature": sign(ts - 600, "POST", "/api/admin/purge", body) })).status === 401, "an old signature is refused");
  ok((await post({ "x-sagebrush-timestamp": String(ts), "x-sagebrush-signature": sign(ts, "GET", "/api/admin/purge", body) })).status === 401, "the signature binds the method");
  const r = await post({ "x-sagebrush-timestamp": String(ts), "x-sagebrush-signature": sign(ts, "POST", "/api/admin/purge", body) });
  ok(r.status === 202 && (await r.json()).status === "accepted", "a signed purge is accepted");
  let st;
  for (let i = 0; i < 50; i++) {
    const p = "/api/admin/purge/9b2d6c1e-0000-4000-8000-000000000001";
    st = await (await fetchSite(p, { headers: { "x-sagebrush-timestamp": String(ts), "x-sagebrush-signature": sign(ts, "GET", p, "") } })).json();
    if (st.status === "done") break;
    await new Promise((res) => setTimeout(res, 50));
  }
  ok(st.status === "done" && st.collections === 1 && st.bytes === mine.length, "the purge finishes and says what it removed");
  ok((await fetchSite(`/api/share/c/${col}`)).status === 404 && !(await bucket.head(`b/${sha(mine)}`)), "C's collection and files are gone");
  ok(!!(await bucket.head(`b/${sha(data)}`)), "B's copy of a file C also had stays");
  ok((await c.get("/api/share/me")).status === 401, "C's sessions are gone");
  const again = await post({ "x-sagebrush-timestamp": String(ts), "x-sagebrush-signature": sign(ts, "POST", "/api/admin/purge", body) });
  ok(again.status === 202, "a retry with the same request_id is accepted again");
  const none = JSON.stringify({ account_id: "44444444-4444-4444-8444-444444444444", request_id: "9b2d6c1e-0000-4000-8000-000000000002" });
  const r0 = await fetchSite("/api/admin/purge", { method: "POST", headers: { "x-sagebrush-timestamp": String(ts), "x-sagebrush-signature": sign(ts, "POST", "/api/admin/purge", none) }, body: none });
  ok(r0.status === 202, "a purge for an account with no data is a normal 202");
}
{
  // "Delete my shared data"
  const r = await b.post("/api/share/delete-everything", {});
  ok(r.status === 400, "delete-everything needs confirmation");
  const r2 = await b.post("/api/share/delete-everything", { confirm: "delete" });
  ok(r2.status === 200, "delete-everything");
  ok(!(await bucket.head(`b/${sha(data)}`)), "the last holder gone: the file is deleted");
  const left = await db.prepare("SELECT (SELECT COUNT(*) FROM collections WHERE owner = ?1) + (SELECT COUNT(*) FROM holdings WHERE account_id = ?1) + (SELECT COUNT(*) FROM sessions WHERE account_id = ?1) AS n").bind(B).first();
  ok(left.n === 0, "nothing of B's is left in D1");
}
{
  // the daily job drops uploads nobody committed within a day
  const pending = Buffer.from("pending upload");
  await db.prepare("UPDATE holdings SET created = created - 2 * 86400").run();
  const w = await mf.getWorker();
  await w.scheduled({ cron: "0 3 * * *" });
  ok(!(await bucket.head(`b/${sha(pending)}`)), "an upload never committed is dropped after a day");
}

await mf.dispose();
console.log(`${count - failures}/${count} passed`);
process.exit(failures ? 1 : 0);
