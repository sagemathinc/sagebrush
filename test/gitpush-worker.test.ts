import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// web/gitpush/worker.mjs: the github.com-only git smart-HTTP proxy for "Push project to GitHub" (Stage A MVP, M1).
const dir = join(__dirname, "..", "..", "web", "gitpush");
const w = require(join(dir, "worker.mjs"));
const ORIGIN = "https://dev.sagebrush.space";
const P = "https://gitpush.example";
const TOKEN = "Basic eC1hY2Nlc3MtdG9rZW46Z2l0aHViX3BhdF9TRUNSRVQ=";
const limiter = (ok = true) => { const keys: string[] = []; return { keys, limit: async ({ key }: { key: string }) => { keys.push(key); return { success: ok }; } }; };
const env = (over: Record<string, unknown> = {}) => ({ ALLOWED_ORIGINS: ORIGIN, LIMITER: limiter(), ...over });
const req = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
  new Request(P + path, { method: init.method ?? "GET", headers: { origin: ORIGIN, authorization: TOKEN, ...(init.headers ?? {}) }, body: init.body });
const REFS = "/github.com/octo/notes.git/info/refs?service=git-receive-pack";
const RECEIVE = "/github.com/octo/notes.git/git-receive-pack";
const upstream = (status = 200, headers: Record<string, string> = { "content-type": "application/x-git-receive-pack-advertisement" }) => {
  const calls: { url: string; init: any }[] = [];
  const f = async (url: string, init: any) => { calls.push({ url, init }); return new Response("ok", { status, headers }); };
  return { calls, f };
};

test("route: only the two push endpoints, on github.com, with exact names", () => {
  assert.deepEqual(w.route("GET", P + REFS), { owner: "octo", repo: "notes", endpoint: "refs" });
  assert.deepEqual(w.route("POST", P + RECEIVE), { owner: "octo", repo: "notes", endpoint: "receive" });
  assert.deepEqual(w.route("GET", P + "/github.com/a-b_c/d.e-f.git/info/refs?service=git-receive-pack"), { owner: "a-b_c", repo: "d.e-f", endpoint: "refs" });
  for (const [method, path] of [
    ["GET", "/github.com/octo/notes.git/info/refs?service=git-upload-pack"], // pull is not in M1
    ["POST", "/github.com/octo/notes.git/git-upload-pack"],
    ["GET", "/github.com/octo/notes.git/info/refs"],
    ["GET", "/github.com/octo/notes.git/info/refs?service=git-receive-pack&x=1"],
    ["POST", RECEIVE + "?a=1"],
    ["POST", REFS], ["GET", RECEIVE], ["PUT", RECEIVE],
    ["GET", "/gitlab.com/octo/notes.git/info/refs?service=git-receive-pack"],
    ["GET", "/evil.test/octo/notes.git/info/refs?service=git-receive-pack"],
    ["GET", "/github.com.evil.test/octo/notes.git/info/refs?service=git-receive-pack"],
    ["GET", "/github.com/octo/notes/info/refs?service=git-receive-pack"],
    ["GET", "/github.com/octo/notes.git.git/info/refs?service=git-receive-pack"],
    ["GET", "/github.com/.hidden/notes.git/info/refs?service=git-receive-pack"],
    ["GET", "/github.com/octo/%2e%2e.git/info/refs?service=git-receive-pack"],
    ["GET", "/github.com/octo%2Fx/notes.git/info/refs?service=git-receive-pack"],
    ["GET", "/github.com/octo/x/notes.git/info/refs?service=git-receive-pack"],
    ["GET", "/github.com//notes.git/info/refs?service=git-receive-pack"],
    ["GET", "/github.com/" + "a".repeat(101) + "/notes.git/info/refs?service=git-receive-pack"],
    ["GET", "/github.com/octo/notes.git/objects/info/packs"],
    // (dot segments: the URL parser resolves literal ones before route sees them, so these are already off the
    // pattern; the encoded and the dot-led forms reach SEGMENT and fail there)
    ["GET", "/github.com/../notes.git/info/refs?service=git-receive-pack"],
    ["GET", "/github.com/./notes.git/info/refs?service=git-receive-pack"],
    ["GET", "/github.com/octo/...git/info/refs?service=git-receive-pack"],
    ["GET", "/github.com/%2e%2e/notes.git/info/refs?service=git-receive-pack"],
    ["GET", "/github.com/%2E/notes.git/info/refs?service=git-receive-pack"],
    ["GET", "/github.com/..x/notes.git/info/refs?service=git-receive-pack"],
  ]) assert.equal(w.route(method, P + path), null, `${method} ${path}`);
  for (const s of [".", "..", "...", ".git", "%2e", "a/b", "a%2fb", "", "a b"]) assert.equal(w.SEGMENT.test(s), false, s);
  for (const s of ["a", "a.b", "a..b", "_x", "-x", "x.git"]) assert.equal(w.SEGMENT.test(s), true, s);
});

test("the built upstream URL: only https://github.com/<owner>/<repo>.git/<the push endpoint>, never a dot segment", async () => {
  const up = upstream();
  for (const path of ["/github.com/../x.git/info/refs?service=git-receive-pack", "/github.com/%2e%2e/x.git/info/refs?service=git-receive-pack",
    "/github.com/./x.git/info/refs?service=git-receive-pack", "/github.com/octo/%2e.git/info/refs?service=git-receive-pack",
    "/github.com/octo/...git/info/refs?service=git-receive-pack", "/github.com/%2E%2E/%2E%2E.git/git-receive-pack"]) {
    const r = await w.handle(req(path, path.endsWith("pack") ? { method: "POST", body: "x", headers: { "content-length": "1" } } : {}), env(), up.f);
    assert.equal(r.status, 400, path);
  }
  assert.equal(up.calls.length, 0);
  await w.handle(req(REFS), env(), up.f);
  await w.handle(req(RECEIVE, { method: "POST", body: "x", headers: { "content-length": "1" } }), env(), up.f);
  for (const { url } of up.calls) {
    const u = new URL(url);
    assert.equal(u.origin, "https://github.com");
    assert.match(u.pathname + u.search, /^\/octo\/notes\.git\/(info\/refs\?service=git-receive-pack|git-receive-pack)$/);
    assert.ok(!u.pathname.split("/").some((s) => s === "." || s === ".."));
  }
});

test("origin: only the allowed origins, and no CORS header otherwise", async () => {
  const up = upstream();
  for (const origin of [undefined, "https://evil.test", "https://dev.sagebrush.space.evil.test", "null"]) {
    const headers: Record<string, string> = { authorization: TOKEN };
    if (origin) headers.origin = origin;
    const r = await w.handle(new Request(P + REFS, { headers }), env(), up.f);
    assert.equal(r.status, 403);
    assert.equal(r.headers.get("access-control-allow-origin"), null);
  }
  assert.equal((await w.handle(req(REFS), env({ ALLOWED_ORIGINS: "" }), up.f)).status, 403);
  assert.equal(up.calls.length, 0);
  const pre = await w.handle(req(RECEIVE, { method: "OPTIONS" }), env(), up.f);
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), ORIGIN);
  assert.equal(pre.headers.get("access-control-allow-methods"), "GET, POST");
});

test("refusals: no token, no limiter (fail closed), over the rate, no or too large a length", async () => {
  const up = upstream();
  assert.equal((await w.handle(new Request(P + REFS, { headers: { origin: ORIGIN } }), env(), up.f)).status, 401);
  assert.equal((await w.handle(req(REFS), env({ LIMITER: undefined }), up.f)).status, 503);
  const slow = limiter(false);
  assert.equal((await w.handle(req(REFS, { headers: { "cf-connecting-ip": "203.0.113.9" } }), env({ LIMITER: slow }), up.f)).status, 429);
  assert.deepEqual(slow.keys, ["203.0.113.9"]);
  assert.equal((await w.handle(req("/github.com/o/r.git/git-upload-pack", { method: "POST", body: "x" }), env(), up.f)).status, 400);
  const big = new Request(P + RECEIVE, { method: "POST", headers: { origin: ORIGIN, authorization: TOKEN, "content-length": String(w.MAX_BODY + 1) } });
  assert.equal((await w.handle(big, env(), up.f)).status, 413);
  const chunked = new Request(P + RECEIVE, { method: "POST", headers: { origin: ORIGIN, authorization: TOKEN },
    body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); c.close(); } }), duplex: "half" } as any);
  assert.equal((await w.handle(chunked, env(), up.f)).status, 411);
  assert.equal(up.calls.length, 0);
});

test("forwarding: the fixed upstream URL, only the allowed headers, never a redirect", async () => {
  const up = upstream();
  const r = await w.handle(req(REFS, { headers: { cookie: "s=1", "x-forwarded-for": "1.2.3.4", "git-protocol": "version=2", accept: "*/*", "cf-connecting-ip": "203.0.113.9" } }), env(), up.f);
  assert.equal(r.status, 200);
  assert.equal(up.calls[0].url, "https://github.com/octo/notes.git/info/refs?service=git-receive-pack");
  assert.equal(up.calls[0].init.redirect, "manual");
  assert.equal(up.calls[0].init.body, null);
  const sent = [...(up.calls[0].init.headers as Headers).entries()].map(([k]) => k).sort();
  assert.deepEqual(sent, ["accept", "authorization", "git-protocol", "user-agent"]);
  assert.equal((up.calls[0].init.headers as Headers).get("authorization"), TOKEN);
  const body = "0000PACK";
  const p = await w.handle(req(RECEIVE, { method: "POST", body, headers: { "content-type": "application/x-git-receive-pack-request", "content-length": String(body.length) } }), env(), up.f);
  assert.equal(p.status, 200);
  assert.equal(up.calls[1].url, "https://github.com/octo/notes.git/git-receive-pack");
  assert.equal(up.calls[1].init.method, "POST");
  assert.equal(await new Response(up.calls[1].init.body).text(), body);
});

test("responses: GitHub's status and content type only; redirects and network errors are 502", async () => {
  const leaky = upstream(401, { "content-type": "text/plain", "www-authenticate": "Basic realm=GitHub", "set-cookie": "gh=1", "x-github-request-id": "abc" });
  const r = await w.handle(req(REFS), env(), leaky.f);
  assert.equal(r.status, 401);
  const names = [...r.headers.keys()].sort();
  assert.deepEqual(names, ["access-control-allow-origin", "cache-control", "content-type", "referrer-policy", "vary", "x-content-type-options"]);
  for (const status of [301, 302, 307, 308]) assert.equal((await w.handle(req(REFS), env(), upstream(status, { location: "https://evil.test/" }).f)).status, 502);
  assert.equal((await w.handle(req(REFS), env(), async () => { throw new Error(TOKEN); })).status, 502);
});

test("never echoes or logs the token: every refusal's body is fixed words, and the source has no console", async () => {
  const bodies: string[] = [];
  const cases = [
    w.handle(new Request(P + REFS, { headers: { origin: "https://evil.test", authorization: TOKEN } }), env()),
    w.handle(req("/github.com/" + TOKEN + "/x.git/info/refs?service=git-receive-pack"), env()),
    w.handle(req(REFS), env({ LIMITER: undefined })),
    w.handle(req(REFS), env({ LIMITER: limiter(false) })),
    w.handle(req(REFS), env(), async () => { throw new Error(TOKEN); }),
    w.handle(req(REFS), env(), upstream(302, { location: TOKEN }).f),
  ];
  for (const r of await Promise.all(cases)) bodies.push(await r.text());
  for (const b of bodies) assert.ok(!b.includes("SECRET") && !b.includes(TOKEN) && b.length < 64, b);
  const src = readFileSync(join(dir, "worker.mjs"), "utf8");
  assert.ok(!/\bconsole\s*[.[]/.test(src));
  const conf = readFileSync(join(dir, "wrangler.jsonc"), "utf8");
  assert.match(conf, /"observability":\s*\{\s*"enabled":\s*false\s*\}/);
  assert.match(conf, /"workers_dev":\s*false/);
  assert.doesNotMatch(conf, /"routes"/); // not routed until a deploy GO
});
