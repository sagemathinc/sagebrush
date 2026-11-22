// ci: web-sync.1 order=22 chrome
// Tests for the support Worker (web/cloud/support/), in Miniflare with a real D1 and rate-limit simulation, a fake
// Turnstile siteverify and a fake CoCalc at its HTTP boundary (plan-support-requests r12 §3.4).
//
//   node web/cloud/support/test-support.mjs     (after `cd web/site && npm ci`: Miniflare comes from web/site's install)
// In CI it runs in web-sync.1 (its ci: header), from the repository's root, with Miniflare from web/site's install
// (the current directory's).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { dispatch } from "../../miniflare-dispatch.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const siteDir = [join(process.cwd(), "web/site"), join(here, "../../site")].find((d) => existsSync(join(d, "node_modules/miniflare")));
if (!siteDir) throw new Error("no web/site install with Miniflare (cd web/site && npm ci)");
// (the Workers' sources the cookie checks read: this repository's web/, where web/share and web/cloud/ sit beside
// web/sync, web/site and web/files)
const webDir = [join(process.cwd(), "web"), join(here, "../..")].find((d) => existsSync(join(d, "cloud/share/server.ts")));
if (!webDir) throw new Error("no web/cloud/share/server.ts (run from the repository's root)");
const require = createRequire(join(siteDir, "package.json"));
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");

const ORIGIN = "https://support-dev.sagebrush.space";
const PROD_ORIGIN = "https://support.sagebrush.space";
const INTAKE = "https://lite4b.cocalc.ai/api/v2/support/sagebrush-intake";
const PROD_INTAKE = "https://cocalc.ai/api/v2/support/sagebrush-intake";
const KEY = "K".repeat(43);
const SECRET = "turnstile-secret";
const SITE_KEY = "0x4AAAAAAA-site-key";

let failures = 0;
let count = 0;
function ok(cond, what) {
  count++;
  if (!cond) {
    failures++;
    console.log("FAIL", what);
  }
}

// ---- the fakes: siteverify (by token) and CoCalc (by mode); every call recorded
const fake = { verify: [], cocalc: [], mode: "ok", gate: null, verifyCalls: 0, used: new Set() };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function outbound(req) {
  const u = new URL(req.url);
  if (u.href === "https://challenges.cloudflare.com/turnstile/v0/siteverify") {
    fake.verifyCalls++;
    const form = await req.formData();
    const fields = [...form.keys()].sort();
    const token = form.get("response");
    fake.verify.push({ fields, secret: form.get("secret"), token });
    const now = Date.now();
    const base = { success: true, hostname: new URL(fake.host ?? ORIGIN).hostname, action: "support", challenge_ts: new Date(now - 1000).toISOString() };
    // (Turnstile's own rule: a token verifies once; a second use is "timeout-or-duplicate")
    if (token.startsWith("once-")) {
      if (fake.used.has(token)) return Response.json({ success: false, "error-codes": ["timeout-or-duplicate"] });
      fake.used.add(token);
    }
    switch (token) {
      case "future-1s": return Response.json({ ...base, challenge_ts: new Date(now + 1000).toISOString() });
      case "old-1s": return Response.json({ ...base, challenge_ts: new Date(now - 1000).toISOString() });
      case "bad": return Response.json({ success: false, "error-codes": ["invalid-input-response"] });
      case "wrong-host": return Response.json({ ...base, hostname: "support-dev.sagebrush.space.example" });
      case "wrong-action": return Response.json({ ...base, action: "login" });
      case "stale": return Response.json({ ...base, challenge_ts: new Date(now - 301_000).toISOString() });
      case "future": return Response.json({ ...base, challenge_ts: new Date(now + 120_000).toISOString() });
      case "no-ts": return Response.json({ ...base, challenge_ts: "yesterday" });
      case "non-json": return new Response("<html>", { status: 200 });
      case "500": return new Response("down", { status: 500 });
      case "big": return new Response(JSON.stringify({ ...base, pad: "x".repeat(20_000) }));
      case "slow": await sleep(6_000); return Response.json(base);
      default: return Response.json(base);
    }
  }
  if (u.href === INTAKE || u.href === PROD_INTAKE) {
    const body = await req.text();
    fake.cocalc.push({ url: u.href, headers: Object.fromEntries(req.headers), body });
    if (fake.gate) await fake.gate;
    switch (fake.mode) {
      case "ok": return Response.json({ ok: true });
      case "ok-extra": return Response.json({ ok: true, url: "https://sagemathcloud.zendesk.com/requests/1", key: KEY });
      case "400-ratelike": return Response.json({ error: "rate-limited" }, { status: 400 });
      case "401": return Response.json({ error: "unauthorized" }, { status: 401 });
      case "429": return Response.json({ error: "rate-limited" }, { status: 429 });
      case "500": return new Response("oops", { status: 500 });
      case "302": return new Response(null, { status: 302, headers: { location: "https://evil.example/" } });
      case "big": return new Response(JSON.stringify({ ok: true, pad: "x".repeat(20_000) }));
      case "non-json": return new Response("ok", { status: 200 });
      case "stall": {
        // (headers now, the body never: the 10 s deadline must end it)
        const stream = new ReadableStream({ start() {} });
        return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
      }
    }
  }
  return new Response("unexpected outbound fetch", { status: 599 });
}

const script = execFileSync("bun", ["build", join(here, "test-entry.ts"), "--format", "esm", "--target", "browser"], { encoding: "utf8" });
const logs = [];
function capture(stream) {
  stream.on("data", (b) => logs.push(...b.toString().split("\n").filter(Boolean)));
}
function worker(bindings) {
  return new Miniflare(convertV4MiniflareOptions({
    workers: [{
      name: "support",
      modules: true,
      script,
      compatibilityDate: "2026-10-01",
      d1Databases: ["SUPPORT_DB"],
      ratelimits: { SUPPORT_IP: { namespace_id: "4104", simple: { limit: 3, period: 60 } } },
      bindings: {
        SUPPORT_OPEN: "1",
        SUPPORT_ORIGIN: ORIGIN,
        TURNSTILE_SITE_KEY: SITE_KEY,
        TURNSTILE_SECRET: SECRET,
        COCALC_INTAKE_URL: INTAKE,
        COCALC_INTAKE_KEY: KEY,
        ...bindings,
      },
      outboundService: outbound,
    }],
    handleRuntimeStdio(stdout, stderr) {
      capture(stdout);
      capture(stderr);
    },
  }));
}
async function migrate(mf) {
  const db = await mf.getD1Database("SUPPORT_DB");
  for (const m of readdirSync(join(here, "migrations")).filter((f) => f.endsWith(".sql")).sort())
    for (const s of readFileSync(join(here, "migrations", m), "utf8").replace(/--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean)) await db.prepare(s).run();
  return db;
}

const mf = worker({});
const db = await migrate(mf);

let ipn = 0;
const nextIp = () => `198.51.100.${(++ipn % 250) + 1}`;
const uuid = () => crypto.randomUUID();
const valid = (extra = {}) => JSON.stringify({ kind: "pkg", title: "Please add polars", description: "import polars fails with ModuleNotFoundError.", email: "reader@example.com", ...extra });

async function send({ body = valid(), token = "good", origin = ORIGIN, ip, headers = {}, length, type = "application/json", sid = uuid(), m = mf } = {}) {
  const h = { origin, "content-type": type, "x-turnstile-token": token, "x-submission-id": sid, "cf-connecting-ip": ip ?? nextIp(), ...headers };
  if (typeof body === "string") h["content-length"] = length ?? `${Buffer.byteLength(body)}`;
  for (const [k, v] of Object.entries(h)) if (v === null) delete h[k];
  const r = await dispatch(m, "https://support-dev.sagebrush.space/api/v1/requests", { method: "POST", headers: h, body, ...(typeof body === "string" ? {} : { duplex: "half" }) });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, json, text, headers: r.headers };
}
// (the Worker's log lines since the last pull, appended to logs)
async function pull(m = mf) {
  logs.push(...(await (await dispatch(m, "https://support-dev.sagebrush.space/__test/logs")).json()));
}
const reset = () => {
  fake.verify.length = 0;
  fake.cocalc.length = 0;
  fake.mode = "ok";
  fake.gate = null;
  fake.host = undefined;
};
async function counters() {
  const { results } = await db.prepare("SELECT win, n FROM support_backstop ORDER BY win").all();
  return Object.fromEntries(results.map((r) => [r.win, r.n]));
}
function windows(now = Date.now()) {
  const iso = new Date(now).toISOString();
  return { hour: `h:${iso.slice(0, 13)}`, day: `d:${iso.slice(0, 10)}` };
}
async function setCount(win, n) {
  await db.prepare("INSERT INTO support_backstop (win, n, created) VALUES (?1, ?2, ?3) ON CONFLICT(win) DO UPDATE SET n = ?2").bind(win, n, Math.floor(Date.now() / 1000)).run();
}

try {
  // ---- the page
  {
    const r = await dispatch(mf, "https://support-dev.sagebrush.space/");
    const html = await r.text();
    ok(r.status === 200, `GET /: ${r.status}`);
    ok(r.headers.get("content-security-policy") === "default-src 'none'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src 'self'; style-src 'self'; img-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'", "the page's CSP is the plan's");
    ok(html.includes(`data-sitekey="${SITE_KEY}"`), "the page carries the site key");
    ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html) && !/\son[a-z]+=/i.test(html), "no inline script or handler");
    ok(html.includes("keeps no copy of your request") && html.includes("kept there for 8 days"), "the privacy text");
    ok(html.includes("To share a file, paste its text, or a link to a shared Sagebrush document."), "the attachments line");
    ok(/<a href="https:\/\/sagebrush.space\/" rel="noopener noreferrer">/.test(html), "the app link is noopener noreferrer");
    for (const k of ["bug", "pkg", "feat", "book", "other"]) ok(html.includes(`<option value="${k}">`), `kind ${k} offered`);
    const js = await dispatch(mf, "https://support-dev.sagebrush.space/support.js");
    const src = await js.text();
    ok(js.status === 200 && js.headers.get("content-type").startsWith("text/javascript"), "the script is served");
    ok(src.includes('action: "support"') && src.includes("turnstile.reset") && src.includes("crypto.randomUUID()"), "the script: action support, a fresh challenge and id per attempt");
    ok(!src.includes("innerHTML"), "the script writes text only");
    const css = await dispatch(mf, "https://support-dev.sagebrush.space/support.css");
    ok(css.status === 200 && css.headers.get("content-type").startsWith("text/css"), "the stylesheet is served");
    ok((await dispatch(mf, "https://support-dev.sagebrush.space/other")).status === 404, "other paths: 404");
    ok((await dispatch(mf, "https://support-dev.sagebrush.space/api/v1/requests")).status === 405, "GET on the API: 405");
  }

  // ---- the app's cookies are host-only (no Domain attribute), so sagebrush.space's session never reaches
  // support.sagebrush.space (plan r12 §2): every Set-Cookie the cloud Workers write, checked in their sources
  {
    const roots = ["share", "cloud", "sync", "lti", "site/src", "files/src"].map((d) => join(webDir, d));
    const files = roots.flatMap((r) => { try { return readdirSync(r, { recursive: true }).map((f) => join(r, String(f))).filter((f) => f.endsWith(".ts")); } catch { return []; } });
    const withDomain = files.filter((f) => /;\s*Domain=/i.test(readFileSync(f, "utf8")));
    ok(files.length > 0 && withDomain.length === 0, `no cloud Worker sets a cookie with a Domain attribute (${files.length} files; ${withDomain})`);
    const shareSrc = readFileSync(join(webDir, "cloud/share/server.ts"), "utf8");
    ok(/const cookie = \(name: string, value: string, maxAge: number\) => `\$\{name\}=\$\{value\}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=\$\{maxAge\}`;/.test(shareSrc), "the site's session cookie is host-only: Path=/; Secure; HttpOnly; SameSite=Lax, no Domain");
  }

  // ---- the operations docs state the body deadline (daybreak3 R-L3b)
  {
    const readme = readFileSync(join(here, "README.md"), "utf8");
    ok(readme.includes("10 s (`BODY_DEADLINE_MS` = 10,000)") && readme.includes("408 `body-timeout`") && readme.includes("cancelled") && /admission slot is\s+released/.test(readme), "README: the 10 s body deadline, 408 body-timeout, cancellation, the slot released");
  }

  // ---- a valid request
  {
    reset();
    const ip = "203.0.113.9";
    const sid = uuid();
    const r = await send({ ip, sid });
    ok(r.status === 200 && JSON.stringify(r.json) === JSON.stringify({ ref: sid.replace(/-/g, "").slice(0, 8) }), `a valid request: 200 {ref} (${r.status} ${r.text})`);
    ok(r.headers.get("cache-control") === "no-store", "no-store");
    ok(fake.verify.length === 1 && JSON.stringify(fake.verify[0].fields) === '["response","secret"]' && fake.verify[0].secret === SECRET && fake.verify[0].token === "good", "siteverify: secret and response only (no idempotency_key, no remoteip)");
    ok(fake.cocalc.length === 1, "one CoCalc call");
    const c = fake.cocalc[0];
    ok(c.url === INTAKE, "the configured CoCalc URL");
    ok(c.body === JSON.stringify({ submission_id: sid, kind: "pkg", title: "Please add polars", description: "import polars fails with ModuleNotFoundError.", email: "reader@example.com" }), `exactly the closed body (${c.body})`);
    ok(c.headers["x-sagebrush-intake-key"] === KEY && c.headers["x-sagebrush-client-ip"] === ip && c.headers["content-type"] === "application/json", "the key, the client IP and the type");
    const allowed = new Set(["content-type", "x-sagebrush-intake-key", "x-sagebrush-client-ip", "content-length"]);
    ok(Object.keys(c.headers).every((h) => allowed.has(h) || h.startsWith("cf-") || h === "accept-encoding" || h === "host" || h === "user-agent" && !c.headers[h].includes("Mozilla")), `no inbound header forwarded [${Object.keys(c.headers)}]`);
    ok(!("cookie" in c.headers) && !("authorization" in c.headers) && !("origin" in c.headers) && !("x-turnstile-token" in c.headers), "no cookie, Authorization, Origin or token forwarded");
    const noEmail = await send({ body: JSON.stringify({ kind: "bug", title: "Plot is blank", description: "plt.show() renders nothing here." }) });
    ok(noEmail.status === 200 && !JSON.parse(fake.cocalc[1].body).hasOwnProperty("email"), "no email: none sent");
  }

  // ---- the client IP
  {
    reset();
    const r = await send({ ip: "203.0.113.10", headers: { "x-sagebrush-client-ip": "192.0.2.66", "x-forwarded-for": "192.0.2.67" } });
    ok(r.status === 200 && fake.cocalc[0].headers["x-sagebrush-client-ip"] === "203.0.113.10" && !("x-forwarded-for" in fake.cocalc[0].headers), "a client's own X-Sagebrush-Client-IP and X-Forwarded-For are ignored; CoCalc gets CF-Connecting-IP");
    for (const bad of ["203.0.113", "203.0.113.10, 198.51.100.1", "example.com", "[2001:db8::1]", "203.0.113.010"]) {
      const b = await send({ ip: bad });
      ok(b.status === 400, `CF-Connecting-IP ${JSON.stringify(bad)}: 400 (${b.status})`);
    }
    ok((await send({ ip: "2001:db8::7" })).status === 200, "an IPv6 client");
  }

  // ---- origin, type and length, before anything else
  {
    reset();
    for (const o of [null, PROD_ORIGIN, "https://support-dev.sagebrush.space.example", ORIGIN + "/", "http://support-dev.sagebrush.space"]) {
      const r = await send({ origin: o });
      ok(r.status === 403 && r.json?.error === "origin", `Origin ${JSON.stringify(o)}: 403 (${r.status})`);
    }
    ok((await send({ type: "text/plain" })).status === 415, "a non-JSON type: 415");
    ok((await send({ body: "x".repeat(131_073) })).status === 413, "a length over 131072: 413");
    const chunked = await send({ body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(valid())); c.close(); } }) });
    ok(chunked.status === 411, `a body without a length (chunked): 411 (${chunked.status})`);
    ok(fake.verify.length === 0 && fake.cocalc.length === 0, "none of these reached siteverify or CoCalc");
  }

  // ---- the submission id and the token, before the body is read
  {
    reset();
    for (const sid of ["", "not-a-uuid", "0f8fad5b-d9cb-169f-a165-70867728950e"]) ok((await send({ sid })).status === 400, `X-Submission-Id ${JSON.stringify(sid)}: 400`);
    ok((await send({ token: null })).status === 403, "no token: 403");
    ok((await send({ token: "t".repeat(2049) })).status === 403, "a token over 2048 bytes: 403");
    ok(fake.verify.length === 0, "none of these reached siteverify");
    // (a bad token with an invalid body: 403, the challenge before the body)
    const early = await send({ token: "bad", body: "not json at all" });
    ok(early.status === 403, `a bad token with an invalid body: 403, the challenge first (${early.status})`);
    for (const t of ["bad", "wrong-host", "wrong-action", "stale", "future", "no-ts", "non-json", "500", "big"]) {
      const r = await send({ token: t });
      ok(r.status === 403 && r.json?.error === "challenge", `siteverify ${t}: 403 (${r.status})`);
    }
    ok(fake.cocalc.length === 0, "no failed challenge reached CoCalc");
    // (S-W1: never in the future, even by a second; a second old is fine)
    ok((await send({ token: "future-1s" })).status === 403, "a challenge 1 s in the future: 403");
    ok((await send({ token: "old-1s" })).status === 200, "a challenge 1 s old: accepted");
    // (S-W2: one token, one request: a replay is refused at siteverify, before its body is read or parsed)
    reset();
    const first = await send({ token: "once-seq" });
    const again = await send({ token: "once-seq", body: "not json at all" });
    ok(first.status === 200 && again.status === 403 && again.json?.error === "challenge", `the same token twice: 200 then 403 before the body (${first.status} ${again.status})`);
    ok(fake.cocalc.length === 1, "the replay reached no CoCalc call");
    reset();
    const pair = await Promise.all([send({ token: "once-par" }), send({ token: "once-par" })]);
    const statuses = pair.map((r) => r.status).sort();
    ok(JSON.stringify(statuses) === "[200,403]" && fake.cocalc.length === 1, `one token in two concurrent requests: exactly one admitted (${statuses})`);
    const t0 = Date.now();
    const slow = await send({ token: "slow" });
    ok(slow.status === 403 && Date.now() - t0 < 5_900, `a siteverify past 5 s: 403 at the deadline (${Date.now() - t0} ms)`);
  }

  // ---- the body
  {
    reset();
    // (the counting reader: a body longer or shorter than declared, and past the cap)
    const read = async (body, declared) => (await (await dispatch(mf, "https://support-dev.sagebrush.space/__test/read", { method: "POST", headers: { "x-declared": `${declared}` }, body })).json()).result;
    ok((await read("x".repeat(100), 95)) === "length-mismatch", "a body longer than declared: length-mismatch");
    ok((await read("x".repeat(100), 105)) === "length-mismatch", "a body shorter than declared: length-mismatch");
    ok((await read("x".repeat(100), 100)) === "ok", "a body of its declared length: read");
    ok((await read("x".repeat(131_073), 131_073)) === "too-large", "a body past 131,072 bytes: too-large");
    const cases = [
      ["not JSON", "hello"],
      ["an array", "[]"],
      ["trailing data", valid() + "x"],
      ["an unknown key", valid({ source: "x" })],
      ["submission_id in the body", valid({ submission_id: uuid() })],
      ["a number", valid({ kind: 1 })],
      ["null", valid({ email: null })],
      ["a nested object", valid({ title: { a: 1 } })],
      ["an unknown kind", valid({ kind: "billing" })],
      ["a title of 4", valid({ title: "abcd" })],
      ["a title of 181", valid({ title: "t".repeat(181) })],
      ["a description of 9", valid({ description: "d".repeat(9) })],
      ["a description of 19001", valid({ description: "d".repeat(19_001) })],
      ["an email over 254 bytes", valid({ email: "e".repeat(245) + "@example.com" })],
      ["a lone surrogate", valid({ title: "abc \ud800 def" })],
      ["a duplicate key", valid().replace("{", '{"title":"Another title",')],
      ["an escaped duplicate key", valid().replace("{", '{"\\u0074itle":"Another title",')],
    ];
    for (const [what, body] of cases) {
      const r = await send({ body });
      ok(r.status === 400 && r.json?.error === "bad-request", `${what}: 400 (${r.status})`);
    }
    ok(fake.cocalc.length === 0, "no invalid body reached CoCalc");
    for (const extra of [{ title: "t".repeat(5) }, { title: "t".repeat(180) }, { description: "d".repeat(10) }, { description: "d".repeat(19_000) }])
      ok((await send({ body: valid(extra) })).status === 200, `at the bound: ${JSON.stringify(Object.keys(extra))} ${Object.values(extra)[0].length}`);
    for (const kind of ["bug", "pkg", "feat", "book", "other"]) {
      const r = await send({ body: valid({ kind, title: "t".repeat(180) }) });
      ok(r.status === 200 && `[sagebrush] ${kind}: ${"t".repeat(180)}`.length <= 200, `kind ${kind} with a 180-unit title: accepted, subject at most 200`);
    }
  }

  // ---- the per-IP flood gate and this isolate's admission
  {
    reset();
    const ip = "192.0.2.200";
    const got = [];
    for (let i = 0; i < 4; i++) got.push((await send({ ip })).status);
    ok(JSON.stringify(got) === "[200,200,200,429]", `SUPPORT_IP: 3 a minute per IP, then 429 (${got})`);
    ok((await send({ ip: "192.0.2.201" })).status === 200, "another IP isn't affected");
    reset();
    let release;
    fake.gate = new Promise((r) => (release = r));
    const pending = [];
    for (let i = 0; i < 8; i++) pending.push(send());
    while (fake.cocalc.length < 8) await sleep(20);
    const ninth = await send();
    ok(ninth.status === 503 && ninth.headers.get("retry-after") === "5", `a ninth request in flight: 503 Retry-After 5 (${ninth.status})`);
    release();
    const done = await Promise.all(pending);
    ok(done.every((r) => r.status === 200), "the eight admitted complete");
    fake.gate = null;
    ok((await send()).status === 200, "admission frees up");
  }

  // ---- the memory bound: eight near-cap bodies held right after their bounded read; the ninth refused before its
  // token or body is touched; the bytes held never past 8 x 131,072; slots and bytes back to zero (daybreak3 L2)
  {
    reset();
    const state = async () => (await dispatch(mf, "https://support-dev.sagebrush.space/__test/state")).json();
    const CAP = 131_072;
    await dispatch(mf, "https://support-dev.sagebrush.space/__test/hold?on=1");
    const pending = [];
    for (let i = 0; i < 8; i++) pending.push(send({ body: "x".repeat(CAP) }));
    for (let t = 0; t < 400 && (await state()).held < 8; t++) await sleep(25);
    const full = await state();
    ok(full.held === 8 && full.inFlight === 8 && full.heldBytes === 8 * CAP, `eight near-cap bodies held: ${JSON.stringify(full)}`);
    const verifies = fake.verifyCalls;
    const ninth = await send({ body: "x".repeat(CAP) });
    ok(ninth.status === 503 && ninth.json?.error === "busy" && ninth.headers.get("retry-after") === "5", `the ninth: 503 busy, Retry-After 5 (${ninth.status})`);
    ok(fake.verifyCalls === verifies, "the ninth was refused before siteverify, so before its body");
    const during = await state();
    ok(during.maxHeldBytes <= 8 * CAP && during.held === 8, `the bytes held never past 8 x 131,072 (${during.maxHeldBytes})`);
    await dispatch(mf, "https://support-dev.sagebrush.space/__test/hold?on=0");
    const done = await Promise.all(pending);
    ok(done.every((r) => r.status === 400), `released, each near-cap body is then refused by the parser (${done.map((r) => r.status)})`);
    const after = await state();
    ok(after.inFlight === 0 && after.held === 0 && after.heldBytes === 0, `slots and bytes back to zero: ${JSON.stringify(after)}`);
    ok((await send()).status === 200, "a request after the release is admitted");
  }

  // ---- S-W3 / L3: eight verified uploads that stall mid-body hold every slot until the body deadline (10 s);
  // the ninth is refused; then each is cancelled with a fixed 408, and slots and bytes are back to zero
  {
    reset();
    const state = async () => (await dispatch(mf, "https://support-dev.sagebrush.space/__test/state")).json();
    const stalled = () => {
      const enc = new TextEncoder();
      const body = new ReadableStream({ start(c) { c.enqueue(enc.encode('{"kind":"bug","title":')); } });
      return send({ body, headers: { "content-length": "4000", "x-witness": "1" } });
    };
    await dispatch(mf, "https://support-dev.sagebrush.space/__test/cancels-reset");
    const t0 = Date.now();
    const parts = [];
    for (let i = 0; i < 8; i++) parts.push(stalled());
    for (let t = 0; t < 200 && (await state()).inFlight < 8; t++) await sleep(25);
    ok((await state()).inFlight === 8, "eight stalled uploads hold the eight slots");
    const ninth = await send();
    ok(ninth.status === 503 && ninth.json?.error === "busy", `the ninth while they stall: 503 busy (${ninth.status})`);
    const ends = await Promise.all(parts);
    const took = Date.now() - t0;
    ok(ends.every((r) => r.status === 408 && r.json?.error === "body-timeout"), `each stalled upload: 408 body-timeout (${ends.map((r) => r.status)})`);
    ok(took >= 9_500 && took < 14_000, `at the 10 s body deadline (${took} ms)`);
    const after = await state();
    ok(after.inFlight === 0 && after.held === 0 && after.heldBytes === 0, `slots and bytes back to zero: ${JSON.stringify(after)}`);
    ok(after.cancels === 8, `each stalled body's stream was cancelled, exactly once each: ${after.cancels} cancel(reason) calls for 8 bodies`);
    ok(fake.cocalc.length === 0, "no stalled upload reached CoCalc");
    ok((await send()).status === 200, "a request after the deadline is admitted");
    await dispatch(mf, "https://support-dev.sagebrush.space/__test/cancels-reset");
    const short = await (await dispatch(mf, "https://support-dev.sagebrush.space/__test/read", { method: "POST", headers: { "x-declared": "1000", "x-deadline": "300", "x-witness": "1" }, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("abc")); } }), duplex: "half" })).json();
    ok(short.result === "timeout", `the reader's deadline gives up on a stalled stream (${short.result})`);
    ok((await state()).cancels === 1, "and cancels it: one cancel(reason) call");
  }

  // ---- CoCalc's answer, by status only
  {
    const table = [
      ["ok-extra", 503], ["400-ratelike", 400], ["401", 503], ["429", 429], ["500", 503], ["302", 503], ["big", 503], ["non-json", 503],
    ];
    for (const [mode, want] of table) {
      reset();
      fake.mode = mode;
      logs.length = 0;
      const r = await send();
      ok(r.status === want, `CoCalc ${mode}: ${want} (${r.status} ${r.text})`);
      ok(!r.text.includes("zendesk") && !r.text.includes(KEY) && !r.text.includes("evil"), `CoCalc ${mode}: nothing of CoCalc's answer reflected`);
      ok(fake.cocalc.length === 1, `CoCalc ${mode}: one call, no redirect followed`);
      await pull();
      if (mode === "401") ok(logs.some((l) => l.includes('"code":"intake-key-rejected"')), "a 401 logs intake-key-rejected");
      else ok(!logs.some((l) => l.includes("intake-key-rejected")), `CoCalc ${mode}: no intake-key-rejected`);
    }
    reset();
    fake.mode = "stall";
    const t0 = Date.now();
    const r = await send();
    ok(r.status === 503 && Date.now() - t0 >= 9_500 && Date.now() - t0 < 11_500, `a stalled answer: 503 at the 10 s deadline (${Date.now() - t0} ms)`);
  }

  // ---- logs: fixed codes only
  {
    await pull();
    const all = logs.join("\n");
    ok(!all.includes("reader@example.com") && !all.includes("203.0.113") && !all.includes("198.51.100") && !all.includes(KEY) && !all.includes(SECRET) && !all.includes("polars"), "no email, IP, key, secret or body text in any log line");
  }

  // ---- the backstop
  {
    reset();
    await db.prepare("DELETE FROM support_backstop").run();
    const w = windows();
    await setCount(w.hour, 598);
    const before = await counters();
    const burst = await Promise.all(Array.from({ length: 5 }, () => send()));
    const okCount = burst.filter((r) => r.status === 200).length;
    const after = await counters();
    ok(okCount === 2 && after[w.hour] === 600 && after[w.day] === (before[w.day] ?? 0) + 2, `concurrency at the hour boundary: exactly 2 of 5 admitted, both counters +2 (${okCount}; ${JSON.stringify(after)})`);
    const refused = burst.find((r) => r.status === 503);
    const s = Math.floor(Date.now() / 1000);
    const ra = Number(refused?.headers.get("retry-after"));
    ok(refused?.json?.error === "busy" && ra >= 1 && ra <= 3600 && Math.abs(ra - (3600 - (s % 3600))) <= 2, `an hour refusal: Retry-After to the next UTC hour (${ra})`);
    await pull();
    ok(logs.some((l) => l.includes('"code":"support-backstop-exhausted"') && l.includes('"window":"hour"')), "an hour refusal logs support-backstop-exhausted (hour)");
    // (both or neither: an hour-full refusal counts nothing)
    const c1 = await counters();
    await send();
    const c2 = await counters();
    ok(JSON.stringify(c1) === JSON.stringify(c2), "an hour-full refusal increments neither counter");
    // (the day)
    await db.prepare("DELETE FROM support_backstop").run();
    await setCount(w.day, 2_999);
    const d1 = await send();
    const d2 = await send();
    const dc = await counters();
    ok(d1.status === 200 && d2.status === 503 && dc[w.day] === 3_000 && dc[w.hour] === 1, `day n = 2,999 admits exactly one; the refusal counts neither (${d1.status} ${d2.status} ${JSON.stringify(dc)})`);
    const dra = Number(d2.headers.get("retry-after"));
    const ds = Math.floor(Date.now() / 1000);
    ok(dra >= 1 && dra <= 86_400 && Math.abs(dra - (86_400 - (ds % 86_400))) <= 2, `a day refusal: Retry-After to the next UTC day (${dra})`);
    // (both full: the refusal is the day's, with a Retry-After to the next UTC day; daybreak3 L1)
    await db.prepare("DELETE FROM support_backstop").run();
    await setCount(w.hour, 600);
    await setCount(w.day, 3_000);
    logs.length = 0;
    const both = await send();
    const bs = Math.floor(Date.now() / 1000);
    const bra = Number(both.headers.get("retry-after"));
    await pull();
    ok(both.status === 503 && Math.abs(bra - (86_400 - (bs % 86_400))) <= 2, `hour and day both full: Retry-After to the next UTC day (${both.status} ${bra})`);
    ok(logs.some((l) => l.includes('"code":"support-backstop-exhausted"') && l.includes('"window":"day"')), "both full: logged as the day's");
    // (the first request of a fresh hour and day)
    await db.prepare("DELETE FROM support_backstop").run();
    ok((await send()).status === 200 && JSON.stringify(await counters()) === JSON.stringify({ [w.day]: 1, [w.hour]: 1 }), "the first request of an hour and a day: both rows at 1");
    // (no refund when CoCalc fails)
    fake.mode = "500";
    await send();
    ok((await counters())[w.hour] === 2, "no refund on a CoCalc failure");
    fake.mode = "ok";
    // (the cron: old hour rows after 2 days, day rows after 30)
    const t = Math.floor(Date.now() / 1000);
    await db.prepare("INSERT INTO support_backstop (win, n, created) VALUES ('h:2000-01-01T00', 5, ?1), ('h:2000-01-02T00', 5, ?2), ('d:2000-01-01', 5, ?3), ('d:2000-01-02', 5, ?4)").bind(t - 3 * 86400, t - 86400, t - 31 * 86400, t - 3 * 86400).run();
    await (await mf.getWorker()).scheduled({ cron: "41 4 * * *" });
    const left = Object.keys(await counters()).filter((k) => k.includes("2000"));
    ok(JSON.stringify(left.sort()) === '["d:2000-01-02","h:2000-01-02T00"]', `the cron removes old windows only (${left})`);
  }
} finally {
  await mf.dispose();
}

// ---- other deployments: the kill switch; production's guards
{
  const closed = worker({ SUPPORT_OPEN: "0" });
  try {
    const r = await send({ m: closed });
    ok(r.status === 503 && r.json?.error === "closed", `the kill switch: 503 closed (${r.status})`);
  } finally {
    await closed.dispose();
  }
  // (no site key yet, as the config's placeholder: the page answers 503, never a page with a bogus key)
  const nokey = worker({ TURNSTILE_SITE_KEY: "" });
  try {
    ok((await dispatch(nokey, "https://support-dev.sagebrush.space/")).status === 503, "an empty site key: the page is 503");
  } finally {
    await nokey.dispose();
  }
  // (production with Turnstile's test keys: refused before anything else)
  for (const [k, v] of [["TURNSTILE_SITE_KEY", "1x00000000000000000000AA"], ["TURNSTILE_SECRET", "1x0000000000000000000000000000000AA"], ["TURNSTILE_SECRET", "2x0000000000000000000000000000000AA"]]) {
    reset();
    const p = worker({ TEST_PROD: "1", SUPPORT_ORIGIN: PROD_ORIGIN, COCALC_INTAKE_URL: PROD_INTAKE, [k]: v });
    try {
      logs.length = 0;
      const r = await send({ m: p, origin: PROD_ORIGIN });
      await pull(p);
      ok(r.status === 503 && fake.verify.length === 0 && logs.some((l) => l.includes("support-test-key-in-prod")), `production with test ${k} ${v}: 503, nothing sent (${r.status})`);
    } finally {
      await p.dispose();
    }
  }
  // (production calls exactly cocalc.ai; DEV's URL is refused there)
  {
    reset();
    const p = worker({ TEST_PROD: "1", SUPPORT_ORIGIN: PROD_ORIGIN, COCALC_INTAKE_URL: INTAKE });
    try {
      const r = await send({ m: p, origin: PROD_ORIGIN });
      ok(r.status === 503 && fake.cocalc.length === 0, `production with DEV's CoCalc URL: 503 (${r.status})`);
    } finally {
      await p.dispose();
    }
    const q = worker({ TEST_PROD: "1", SUPPORT_ORIGIN: PROD_ORIGIN, COCALC_INTAKE_URL: PROD_INTAKE });
    try {
      // (no migration yet: the backstop's table is missing, so nothing is admitted or sent)
      reset();
      fake.host = PROD_ORIGIN;
      logs.length = 0;
      const unmigrated = await send({ m: q, origin: PROD_ORIGIN });
      await pull(q);
      ok(unmigrated.status === 503 && fake.cocalc.length === 0 && logs.some((l) => l.includes("support-backstop-unavailable")), `no backstop table: 503, nothing sent (${unmigrated.status})`);
      await migrate(q);
      reset();
      fake.host = PROD_ORIGIN;
      const r = await send({ m: q, origin: PROD_ORIGIN });
      ok(r.status === 200 && fake.cocalc[0]?.url === PROD_INTAKE, `production with real keys and cocalc.ai: 200 (${r.status})`);
    } finally {
      await q.dispose();
    }
  }
  // (DEV's URL allowlist)
  for (const url of ["http://lite4b.cocalc.ai/api/v2/support/sagebrush-intake", "https://evilcocalc.ai/api/v2/support/sagebrush-intake", "https://lite4b.cocalc.ai:8443/api/v2/support/sagebrush-intake", "https://lite4b.cocalc.ai/api/v2/support/create-ticket", "https://lite4b.cocalc.ai/api/v2/support/sagebrush-intake?x=1", "https://u:p@lite4b.cocalc.ai/api/v2/support/sagebrush-intake"]) {
    reset();
    const d = worker({ COCALC_INTAKE_URL: url });
    try {
      const r = await send({ m: d });
      ok(r.status === 503 && fake.cocalc.length === 0, `DEV CoCalc URL ${url}: refused (${r.status})`);
    } finally {
      await d.dispose();
    }
  }
}

// ---- the page's script in a real browser (an agent's #draft= pre-fill; only the person's own Send sends):
// web/cloud/support/test-support-page.mjs, run from here so it is part of this suite (its ci: header)
{
  let rc = 0;
  try { execFileSync("bun", [join(here, "test-support-page.mjs")], { stdio: "inherit" }); } catch (e) { rc = e.status ?? 1; }
  ok(rc === 0, `the page in Chromium: web/cloud/support/test-support-page.mjs (exit ${rc})`);
}

if (failures) console.log(`(log lines captured: ${logs.length}; first: ${JSON.stringify(logs.slice(0, 3))})`);
console.log(`${count - failures}/${count} checks passed`);
process.exit(failures ? 1 : 0);
