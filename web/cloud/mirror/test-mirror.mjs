// ci: web-sync.1 order=16
// Tests for the log mirror (web/cloud/mirror, plan r7 design B), in Miniflare with the MirrorAccount Durable Object
// (SQLite), a real D1 with every share migration, and R2: one row (or more) per SEC pin of the test contract
// (agent-chat-log-mirror-tests.md: S1-S8, the allowlist, mechanics 1-5) and per amendment (A1: positions and agent
// numbers; A2: the one storage budget, its order and its crash cuts).  Rows read R2, D1 and the object's own tables
// directly to check what is stored.
//
//   node web/cloud/mirror/test-mirror.mjs
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { migrations } from "../share/migrations.mjs";
import { dispatch } from "../../miniflare-dispatch.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, webcrypto } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "../../site/package.json"));
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");

const SITE = "https://sagebrush.test";
const A = "11111111-1111-4111-8111-111111111111"; // entitled (MIRROR_ACCOUNTS)
const B = "22222222-2222-4222-8222-222222222222"; // entitled
const C = "33333333-3333-4333-8333-333333333333"; // signed in, not entitled
const D = "44444444-4444-4444-8444-444444444444"; // entitled; the budget rows
const E = "55555555-5555-4555-8555-555555555555"; // entitled; deletion and the purge
const F = "66666666-6666-4666-8666-666666666666"; // entitled; nonces
const G = "77777777-7777-4777-8777-777777777777"; // entitled; KEK rotation
const H = "88888888-8888-4888-8888-888888888888"; // entitled; crash cuts
const I = "99999999-9999-4999-8999-999999999999"; // entitled; the conversations cap

let failures = 0, count = 0;
function ok(cond, what) {
  count++;
  if (!cond) {
    failures++;
    console.log("FAIL", what);
  }
}
const b64url = (b) => Buffer.from(b).toString("base64url");
const KEK1 = b64url(randomBytes(32)), KEK2 = b64url(randomBytes(32));

// (the pure modules, bundled for node: the format (MIT) and the crypto)
const tmp = mkdtempSync(join(tmpdir(), "mirror-test-"));
const bundle = (src, name) => {
  const out = join(tmp, name);
  writeFileSync(out, execFileSync("bun", ["build", join(here, src), "--format", "esm", "--target", "node"], { encoding: "utf8", maxBuffer: 1 << 26 }));
  return import(pathToFileURL(out).href);
};
const fmt = await bundle("../../workspace/agent-chat/mirror-format.ts", "format.mjs");
const cr = await bundle("crypto.ts", "crypto.mjs");

const script = execFileSync("bun", ["build", join(here, "test-entry.ts"), "--format", "esm", "--target", "browser", "--external", "cloudflare:workers"], { encoding: "utf8", maxBuffer: 1 << 26 });
const bindings = { SESSION_KEY: "session-key", SHARE_DEV: "1", DEV_AUTH_TOKEN: "dev-token", MIRROR_ACCOUNTS: [A, B, D, E, F, G, H, I].join(","), MIRROR_KEK_CURRENT: "1", MIRROR_KEK_V1: KEK1, MIRROR_KEK_V2: KEK2, BUDGET_CLAIMS: "on" };
const mf = new Miniflare(convertV4MiniflareOptions({
  workers: [{ name: "mirror", modules: true, script, compatibilityDate: "2026-10-01", d1Databases: ["SHARE_DB"], r2Buckets: ["SHARE_BUCKET", "MIRROR_BUCKET"], bindings,
    durableObjects: { MIRROR_ACCOUNT: { className: "TestMirrorAccount", useSQLite: true } } }],
}));
const db = await mf.getD1Database("SHARE_DB");
for (const { path: m } of migrations())
  for (const s of readFileSync(m, "utf8").replace(/--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean)) await db.prepare(s).run();
const bucket = await mf.getR2Bucket("MIRROR_BUCKET");

const T0 = Date.now();
const lap = (what) => process.env.MIRROR_TEST_TIMES && console.log(`  ${what}: ${((Date.now() - T0) / 1000).toFixed(1)} s`);
const site = (path, init = {}) => dispatch(mf, SITE + path, { redirect: "manual", ...init });
async function session(account_id) {
  const r = await site("/auth/dev", { method: "POST", headers: { origin: SITE, "content-type": "application/json" }, body: JSON.stringify({ token: "dev-token", account_id }) });
  return (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).find((c) => c.startsWith("__Host-sb_session="));
}
const hashOf = (account) => createHash("sha256").update("sagebrush-account\n" + account).digest("hex");
const asJson = async (r) => ({ status: r.status, cache: r.headers.get("cache-control"), body: await r.json().catch(() => null) });

/** A signed-in page of `account`: its cookie, CSRF token, and the mirror's calls. */
async function page(account) {
  const cookie = await session(account);
  const st = await asJson(await site("/api/mirror/v1/status", { headers: { cookie, origin: SITE } }));
  const csrf = st.body?.csrf;
  const h = (extra = {}) => ({ cookie, origin: SITE, "x-sb-mirror-csrf": csrf, ...extra });
  const post = (path, body, extra = {}) => site(path, { method: "POST", headers: h({ "content-type": "application/json", ...extra }), body: JSON.stringify(body) });
  return {
    account, cookie, csrf, hash: hashOf(account), h,
    status: async () => asJson(await site("/api/mirror/v1/status", { headers: { cookie, origin: SITE } })),
    enable: async (extra) => asJson(await site("/api/mirror/v1/enable", { method: "POST", headers: h(extra) })),
    disable: async () => asJson(await post("/api/mirror/v1/disable", { confirm: "delete" })),
    conv: async (conversation) => asJson(await post("/api/mirror/v1/conversations", { conversation })),
    list: async () => asJson(await site("/api/mirror/v1/conversations", { headers: { cookie, origin: SITE } })),
    del: async (locator) => asJson(await site(`/api/mirror/v1/conversations/${locator}`, { method: "DELETE", headers: h() })),
    /** append a body (an object, or raw text) with its range header (computed from the body unless given) */
    append: async (locator, body, extra = {}, range) => {
      const text = typeof body === "string" ? body : JSON.stringify(body);
      const es = typeof body === "string" ? null : body.entries;
      const rg = range ?? `${body.log_instance} ${es[0].n} ${es.at(-1).n} ${es[0].seq} ${es.at(-1).seq}`;
      return asJson(await site(`/api/mirror/v1/append/${locator}`, { method: "POST", headers: h({ "content-type": "application/vnd.sagebrush.mirror+json", "x-sb-mirror-range": rg, ...extra }), body: text }));
    },
    read: async (locator, inst, after, extra = {}) => asJson(await site(`/api/mirror/v1/read/${locator}/${inst}?after=${after}`, { headers: { cookie, origin: SITE, ...extra } })),
  };
}
const doCall = async (hash, op, q = "", body) => (await site(`/__do/${hash}/${op}${q}`, body ? { method: "POST", body: JSON.stringify(body) } : {})).json();
const state = (hash) => doCall(hash, "__state");
const alarm = (hash) => doCall(hash, "__alarm");
const clock = (hash, ms) => doCall(hash, "__clock", `?ms=${ms}`);
const claimOf = async (account) => (await db.prepare("SELECT bytes FROM budget_claims WHERE account_id = ?1 AND holder = 'mirror'").bind(account).first())?.bytes ?? 0;
const objects = async (prefix) => {
  const out = [];
  let cursor;
  do {
    const l = await bucket.list({ prefix, cursor });
    out.push(...l.objects);
    cursor = l.truncated ? l.cursor : undefined;
  } while (cursor);
  return out;
};

/** A body of `k` user messages from position n, agent numbers from seq stepping by 3 (the agent's numbers jump). */
const INST = "a1b2c3d4e5f60718";
function body(n, k, seq = n * 3, inst = INST, text = (i) => `message ${i}`) {
  return { schema: 1, allowlist: 1, log_instance: inst, entries: Array.from({ length: k }, (_, i) => ({ k: "user", n: n + i, seq: seq + 3 * i, id: `m${n + i}`, text: text(n + i) })) };
}

// ---- smoke: the whole path once
const pa = await page(A);
{
  const st = await pa.status();
  ok(st.status === 200 && st.body.available === true && st.body.state === "off" && typeof pa.csrf === "string", `status: available, off, with a CSRF token (${JSON.stringify(st.body)})`);
  const en = await pa.enable();
  ok(en.status === 200 && en.body.state === "on", `enable (${JSON.stringify(en)})`);
  const c = await pa.conv("c1");
  ok(c.status === 200 && /^[0-9a-f]{32}$/.test(c.body.locator), `a locator (${JSON.stringify(c)})`);
  const a1 = await pa.append(c.body.locator, body(1, 3));
  ok(a1.status === 200 && a1.body.segment === 1, `append (${JSON.stringify(a1)})`);
  const r1 = await pa.read(c.body.locator, INST, 0);
  ok(r1.status === 200 && r1.body.entries?.length === 3 && r1.body.entries[2].text === "message 3" && r1.body.uploaded_by === "page" && r1.body.encryption === "server", `read back (${JSON.stringify(r1).slice(0, 300)})`);
  const r2 = await pa.read(c.body.locator, INST, 3);
  ok(r2.status === 200 && r2.body.end === true, "read: the end after the last segment");
  ok((await claimOf(A)) >= (await state(pa.hash)).held, `right after a commit, the claim covers what is held (${await claimOf(A)})`);
  await alarm(pa.hash);
  ok((await claimOf(A)) > 0 && (await claimOf(A)) === (await state(pa.hash)).held, `the alarm brings the claim down to exactly what the mirror holds (${await claimOf(A)})`);
}

// a counted append: `total` body bytes offered, how many 1 KiB chunks were pulled, and the answer
const stream = async (path, total, headers, length) => (await site("/__stream", { method: "POST", body: JSON.stringify({ path, total, headers, ...(length !== undefined ? { length: String(length) } : {}) }) })).json();
const appendHeaders = (p, extra = {}) => ({ cookie: p.cookie, origin: SITE, "x-sb-mirror-csrf": p.csrf, "content-type": "application/vnd.sagebrush.mirror+json", "x-sb-mirror-range": `${INST} 1 1 1 1`, ...extra });

// ---- inert: without any one binding, every route is 404 and nothing is written
{
  // (the KEK: a current version named but no such secret, or a malformed one)
  for (const [what, hdr] of [["no current KEK secret", { "x-test-kek-current": "9" }], ["the current KEK dropped", { "x-test-kek-drop": "1" }], ["BUDGET_CLAIMS unbound", { "x-test-budget-claims": "off" }]]) {
    const r = await site("/api/mirror/v1/status", { headers: { cookie: pa.cookie, origin: SITE, ...hdr } });
    ok(r.status === 404, `inert: ${what} -> 404 (${r.status})`);
  }
  ok((await site("/api/mirror/v1/status", { headers: { cookie: pa.cookie, origin: SITE, "x-test-preauth": "deny" } })).status === 429, "the per-IP limit comes first (429)");
}

lap('S1: authorit');
// ---- S1: authority and the request boundary
const pb = await page(B);
await pb.enable();
{
  const loc = (await pa.conv("s1-conv")).body.locator;
  // (a) another account or a prefix, named anywhere the page could: never used
  const evil = { ...body(1, 1), account: B };
  const r = await pa.append(loc, evil);
  ok(r.status === 400, `S1a: a body naming an account is refused (${r.status} ${JSON.stringify(r.body)})`);
  const r2 = await pa.append(loc, body(1, 1), { "x-sync-account": pb.hash, "x-sb-account": B, "x-sb-prefix": `acct/${pb.hash}/` });
  ok(r2.status === 200, `S1a: headers naming another account or prefix are ignored (${r2.status})`);
  const q = await site(`/api/mirror/v1/append/${loc}?account=${B}&prefix=acct/${pb.hash}/`, { method: "POST", headers: pa.h({ "content-type": "application/vnd.sagebrush.mirror+json", "x-sb-mirror-range": `${INST} 2 2 6 6` }), body: JSON.stringify(body(2, 1)) });
  ok(q.status === 200, `S1a: a query naming another account is ignored (${q.status})`);
  ok((await objects(`acct/${pb.hash}/`)).length === 0 && (await objects(`acct/${pa.hash}/conv/${loc}/`)).length === 2, "S1a: stored under the session's account only, none under the other's");
  // (b) no session; a session without the entitlement: refused, nothing reserved
  const before = (await state(pa.hash)).meta.find((m) => m.k === "nonce")?.v;
  const anon = await stream(`/api/mirror/v1/append/${loc}`, 4096, { origin: SITE, "content-type": "application/vnd.sagebrush.mirror+json", "x-sb-mirror-range": `${INST} 3 3 9 9` }, 4096);
  ok(anon.status === 401 && anon.pulled === 0, `S1b: no session -> 401, no byte read (${anon.status}, ${anon.pulled})`);
  const pc = await page(C);
  ok((await pc.status()).body.available === false, "S1b: status says not available to an account without the plan");
  const cc = await stream(`/api/mirror/v1/append/${loc}`, 4096, appendHeaders(pc), 4096);
  ok(cc.status === 403 && cc.pulled === 0, `S1b: no entitlement -> 403, no byte read (${cc.status}, ${cc.pulled})`);
  ok((await pc.enable()).status === 403 && (await pc.conv("x")).status === 403, "S1b: nor may it turn the mirror on or allocate");
  ok((await state(pa.hash)).meta.find((m) => m.k === "nonce")?.v === before && (await state(pa.hash)).reservations.length === 0, "S1b: nothing reserved (the nonce counter unmoved)");
  // (c) cross-origin, a missing or wrong CSRF token, a wrong content type, a content encoding: refused before the body (mechanic 1)
  for (const [what, extra, want] of [
    ["a cross-origin POST", { origin: "https://evil.test" }, 403],
    ["no Origin on a POST", { origin: undefined }, 403],
    ["no CSRF token", { "x-sb-mirror-csrf": undefined }, 403],
    ["a wrong CSRF token", { "x-sb-mirror-csrf": pb.csrf }, 403],
    ["another session's token", { "x-sb-mirror-csrf": "A".repeat(43) }, 403],
    ["a wrong content type", { "content-type": "application/json" }, 415],
    ["text/plain", { "content-type": "text/plain" }, 415],
    ["a gzip body", { "content-encoding": "gzip" }, 415],
  ]) {
    const hd = appendHeaders(pa, extra);
    for (const k of Object.keys(hd)) if (hd[k] === undefined) delete hd[k];
    const x = await stream(`/api/mirror/v1/append/${loc}`, 64 * 1024, hd, 64 * 1024);
    ok(x.status === want && x.pulled === 0, `S1c/mechanic 1: ${what} -> ${want} with zero pulls (${x.status}, ${x.pulled})`);
  }
  ok((await site("/api/mirror/v1/conversations", { headers: { cookie: pa.cookie, origin: "https://evil.test" } })).status === 403, "S1c: a cross-origin GET is refused");
  ok((await site("/api/mirror/v1/conversations", { headers: { cookie: pa.cookie } })).status === 403, "S1c: a GET with neither Origin nor Sec-Fetch-Site is refused");
  ok((await site("/api/mirror/v1/conversations", { headers: { cookie: pa.cookie, "sec-fetch-site": "same-origin" } })).status === 200, "S1c: a same-origin GET (Sec-Fetch-Site) is answered");
  // (d) every read answer is private, no-store
  const reads = [await pa.status(), await pa.list(), await pa.read(loc, INST, 0), await pa.read(loc, INST, 2), await pa.read("f".repeat(32), INST, 0), await pc.status()];
  ok(reads.every((x) => x.cache === "private, no-store"), `S1d: Cache-Control private, no-store on every read (${reads.map((x) => x.cache)})`);
  // (e) the R2 key holds nothing derived from the conversation id, and two accounts get unrelated locators
  const la = (await pa.conv("c1")).body.locator, lb = (await pb.conv("c1")).body.locator;
  // (the id itself or its hex as a path segment; its hashes, whole or their first 16 characters, anywhere)
  const hashes = [createHash("sha256").update("c1").digest("hex"), createHash("sha256").update("c1").digest("base64url"), createHash("sha1").update("c1").digest("hex"), createHash("md5").update("c1").digest("hex")];
  const keys = (await objects(`acct/${pa.hash}/conv/${la}/`)).map((o) => o.key);
  ok(keys.length > 0 && keys.every((k) => k.split("/").every((seg) => seg !== "c1" && seg !== Buffer.from("c1").toString("hex")) && hashes.every((d) => !k.includes(d) && !k.includes(d.slice(0, 16)))),
    `S1e: the key has no derivative of "c1" (${keys[0]})`);
  ok(la !== lb && hashes.every((d) => !la.includes(d.slice(0, 16)) && !lb.includes(d.slice(0, 16))) && [...Array(17).keys()].every((i) => !lb.includes(la.slice(i, i + 16))),
    "S1e: two accounts with the same conversation id get unrelated locators (no shared 16-character run)");
}

// ---- mechanic 5: the locator encoder, and allocation with injected randomness
{
  const R = randomBytes(16), R2 = randomBytes(16);
  ok(cr.locatorOf(R) === cr.locatorOf(Uint8Array.from(R)) && cr.locatorOf(R) !== cr.locatorOf(R2) && cr.locatorOf(R) === R.toString("hex"),
    "mechanic 5: the encoder's output depends only on its bytes: the same bytes the same locator, other bytes another");
  // (A takes R; B is offered R first, finds it taken, and commits R2)
  await doCall(pa.hash, "__random", `?hex=${R.toString("hex")}`);
  const ca = (await pa.conv("alloc-A")).body.locator;
  await doCall(pa.hash, "__random", `?hex=${R.toString("hex")},${R2.toString("hex")}`);
  const cb = (await pa.conv("alloc-B")).body.locator;
  ok(ca === R.toString("hex") && cb === R2.toString("hex"), `mechanic 5: B's allocation finds R taken and commits only R2 (${ca.slice(0, 8)} ${cb.slice(0, 8)})`);
  ok((await pa.conv("alloc-A")).body.locator === ca, "mechanic 5: an existing mapping is never overwritten (alloc-A still R)");
  // (two allocations at once, both offered R first: exactly one wins it)
  const R3 = randomBytes(16), R4 = randomBytes(16), R5 = randomBytes(16);
  await doCall(pa.hash, "__random", `?hex=${[R3, R3, R4, R5].map((x) => x.toString("hex")).join(",")}`);
  const [x, y] = await Promise.all([pa.conv("race-1"), pa.conv("race-2")]);
  const got = [x.body.locator, y.body.locator];
  ok(got.filter((l) => l === R3.toString("hex")).length === 1 && got[0] !== got[1], `mechanic 5: two concurrent allocations with the same first candidate: exactly one wins R (${got.map((l) => l.slice(0, 6))})`);
}

lap('S2: canonica');
// ---- S2: canonical append, concurrent pages, reserve/upload/commit (A1: positions contiguous, agent numbers rising)
{
  const loc = (await pa.conv("s2")).body.locator;
  ok((await pa.append(loc, body(1, 100))).status === 200 && (await pa.append(loc, body(101, 100))).status === 200, "S2a: 1-100 then 101-200 accepted");
  const loc2 = (await pa.conv("s2-b")).body.locator;
  await pa.append(loc2, body(1, 100));
  const gap = await pa.append(loc2, body(102, 49)), over = await pa.append(loc2, body(90, 61));
  const rewrite = await pa.append(loc2, body(1, 100, 3, INST, (i) => `other ${i}`));
  ok(gap.status === 409 && over.status === 409 && rewrite.status === 409, `S2a: a gap, an overlap and a rewrite are rejected (${gap.status} ${over.status} ${rewrite.status})`);
  // (A1: agent numbers must rise across segments and within one)
  const back = await pa.append(loc2, body(101, 2, 10)); // (seq 10 <= the last segment's 300)
  const within = { ...body(101, 2, 400), entries: [{ ...body(101, 1, 500).entries[0] }, { ...body(102, 1, 400).entries[0] }] };
  const w = await pa.append(loc2, within);
  ok(back.status === 409 && w.status === 400, `A1: agent numbers not increasing, across (${back.status}) or within (${w.status}) a segment, are rejected`);
  const st0 = await state(pa.hash);
  const segs0 = st0.segments.filter((s) => s.locator === loc2).length;
  ok(segs0 === 1 && st0.streams.find((s) => s.locator === loc2).next_n === 101, "S2a: one history: one segment, next position 101");
  // (b) the same range and digest again: idempotent
  const again = await pa.append(loc2, body(1, 100));
  const st1 = await state(pa.hash);
  ok(again.status === 200 && again.body.segment === 1 && st1.segments.filter((s) => s.locator === loc2).length === 1 && (await objects(`acct/${pa.hash}/conv/${loc2}/`)).length === 1,
    `S2b: a retry with the same range and digest: one object, one index entry (${again.status})`);
  // (c) two pages racing one cursor with different bodies: exactly one wins, one history
  const p2 = await page(A);
  const [r1, r2] = await Promise.all([pa.append(loc2, body(101, 5, 303, INST, (i) => `page one ${i}`)), p2.append(loc2, body(101, 5, 303, INST, (i) => `page two ${i}`))]);
  const wins = [r1, r2].filter((r) => r.status === 200).length;
  // (the loser, retrying once the winner committed, meets the winner's digest: rejected)
  const loser = r1.status === 200 ? () => p2.append(loc2, body(101, 5, 303, INST, (i) => `page two ${i}`)) : () => pa.append(loc2, body(101, 5, 303, INST, (i) => `page one ${i}`));
  const lr = await loser();
  const st2 = await state(pa.hash);
  ok(wins === 1 && lr.status === 409 && st2.segments.filter((s) => s.locator === loc2).length === 2, `S2c: one wins (${r1.status} ${r2.status}); the other's retry is rejected (${lr.status}); one history`);
  // (d) a reservation abandoned before commit (the Worker stops after its put): collected, the quota restored once
  const claim0 = await claimOf(A);
  const crash = await pa.append(loc2, body(106, 3, 400), { "x-test-crash-after-put": "1" });
  const mid = await state(pa.hash);
  ok(crash.status === 500 && mid.reservations.length === 1 && (await claimOf(A)) >= mid.held && mid.held > claim0 - 4 * 1024 * 1024 - 1, `S2d: crashed after its put: the reservation stands, and the claim covers it (${crash.status}, ${mid.reservations.length})`);
  // (past the reservation's end: collected into the outbox, still claimed; past the late margin: deleted, unclaimed)
  await clock(pa.hash, 200_000);
  await alarm(pa.hash);
  const coll = await state(pa.hash);
  ok(coll.reservations.length === 0 && coll.outbox.length >= 1 && (await claimOf(A)) >= coll.held, `S2d: collected into the outbox, its bytes still claimed until deleted (${coll.outbox.length})`);
  await clock(pa.hash, 400_000);
  await alarm(pa.hash);
  await alarm(pa.hash);
  const after = await state(pa.hash);
  const segBytes = after.segments.reduce((n, s) => n + s.size, 0);
  ok(after.reservations.length === 0 && after.outbox.length === 0 && after.held === segBytes && (await claimOf(A)) === segBytes && (await objects(`acct/${pa.hash}/conv/${loc2}/`)).length === 2,
    `S2d: the object deleted, the claim back to exactly the committed bytes after two alarms (${await claimOf(A)} = ${segBytes})`);
  await clock(pa.hash, 0);
  // (the position was never taken: the same range goes in now; its burned segment id and nonce are not reused)
  const re = await pa.append(loc2, body(106, 3, 400));
  ok(re.status === 200 && re.body.segment === 4, `S2d: the range is free again, under a new segment id (${re.body?.segment})`);
  // (e) a lost commit response, retried: success, no duplicate
  const lost = await pa.append(loc2, body(109, 2, 500), { "x-test-lose-commit": "1" });
  const retry = await pa.append(loc2, body(109, 2, 500));
  const st3 = await state(pa.hash);
  ok(lost.status === 503 && retry.status === 200 && st3.segments.filter((s) => s.locator === loc2 && s.first_n === 109).length === 1,
    `S2e: a lost commit answer, retried: 200, one segment (${lost.status} ${retry.status})`);
  // (f) an object at the key a reservation will use is never overwritten: R2 refuses the write
  const next = st3.convs.find((c) => c.locator === loc2).next_segment;
  const key = `acct/${pa.hash}/conv/${loc2}/${String(next).padStart(12, "0")}`;
  await bucket.put(key, "squatter");
  const f = await pa.append(loc2, body(111, 1, 600));
  ok(f.status === 503 && (await (await bucket.get(key)).text()) === "squatter", `S2f: the put is refused (onlyIf), the existing object untouched (${f.status})`);
  await bucket.delete(key);
  // (g) a commit whose object isn't the sealed one: rejected, the object collected
  const g = await pa.append(loc2, body(111, 1, 600), { "x-test-replace": b64url(Buffer.from("not the sealed object")) });
  const st4 = await state(pa.hash);
  ok(g.status === 409 && g.body.error === "mismatch" && !st4.segments.some((s) => s.locator === loc2 && s.first_n === 111) && st4.outbox.some((o) => o.key.startsWith(`acct/${pa.hash}/conv/${loc2}/`)),
    `S2g: a different object at commit is rejected and scheduled for collection (${g.status} ${g.body?.error})`);
  await clock(pa.hash, 400_000);
  await alarm(pa.hash);
  await clock(pa.hash, 0);
  ok((await objects(`acct/${pa.hash}/conv/${loc2}/`)).every((o) => st4.segments.some((s) => s.locator === loc2 && o.key.endsWith(String(s.segment).padStart(12, "0")))), "S2g: the mismatched object is gone after the alarm");
  // (a new log_instance restarts positions at 1)
  ok((await pa.append(loc2, body(1, 2, 1, "bbbbbbbbbbbbbbbb"))).status === 200, "A1: a new log_instance restarts n at 1");
}

lap('helpers that');
// ---- helpers that open what is stored, as only a holder of the KEK could (the test is one)
const { subtle } = webcrypto;
async function dekOf(account, wrap, kek = KEK1) {
  const k = await subtle.importKey("raw", Buffer.from(kek, "base64url"), "AES-GCM", false, ["decrypt"]);
  const b = Buffer.from(wrap.wrapped, "hex");
  const aad = Buffer.from(fmt.canonical({ purpose: "sagebrush-mirror-dek", v: 1, account, key_id: wrap.key_id, kek: wrap.kek }));
  return Buffer.from(await subtle.decrypt({ name: "AES-GCM", iv: b.subarray(0, 12), additionalData: aad }, k, b.subarray(12)));
}
async function plaintextOf(account, hash, key) {
  const st = await state(hash);
  const kek = { 1: KEK1, 2: KEK2 }[st.wraps[0].kek];
  const raw = await dekOf(account, st.wraps[0], kek);
  const obj = new Uint8Array(await (await bucket.get(key)).arrayBuffer());
  const n = Buffer.from(obj).readUInt32BE(4);
  const h = JSON.parse(Buffer.from(obj.subarray(8, 8 + n)).toString());
  const k = await subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
  return Buffer.from(await subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(h.nonce, "hex"), additionalData: obj.subarray(8, 8 + n) }, k, obj.subarray(8 + n))).toString();
}
const keyOf = (hash, loc, seg) => `acct/${hash}/conv/${loc}/${String(seg).padStart(12, "0")}`;
const readW = async (p, loc, inst, after) => (await site(`/__read/api/mirror/v1/read/${loc}/${inst}?after=${after}`, { headers: { cookie: p.cookie, origin: SITE } })).json();

// ---- S3: AEAD
{
  // (a, mechanic 3) 1,250 appends through the routes, then 10,000 seals, each across 50 conversations at once: every
  // nonce from the account's counter, once.  (The seals take the real reservation and seal, then abandon: a full
  // append costs Miniflare about 20 ms, so 10,000 of them would be minutes; the nonce's path is the same.)
  const PER = 25;
  const pf = await page(F);
  await pf.enable();
  const locs = [];
  for (let i = 0; i < 50; i++) locs.push((await pf.conv("n" + i)).body.locator);
  const t0 = Date.now();
  const { refused } = await (await site("/__burst", { method: "POST", body: JSON.stringify({ cookie: pf.cookie, csrf: pf.csrf, locs, per: PER, inst: INST }) })).json();
  const st = await state(pf.hash);
  const nonces = st.segments.map((s) => s.nonce);
  const counter = Number(st.meta.find((m) => m.k === "nonce").v);
  ok(refused === 0 && st.segments.length === 50 * PER && new Set(nonces).size === 50 * PER && Math.max(...nonces) <= counter && counter === 50 * PER + 50 * Math.floor(PER / 25),
    `S3a: 1,250 concurrent appends, 1,250 distinct nonces from the counter; the 50 abandoned took their own (${refused} refused, counter ${counter}, ${Date.now() - t0} ms)`);
  const t1 = Date.now();
  const seals = await (await site("/__seals", { method: "POST", body: JSON.stringify({ account: F, hash: pf.hash, locs, per: process.env.MIRROR_TEST_QUICK ? 20 : 200 }) })).json();
  const want = process.env.MIRROR_TEST_QUICK ? 1000 : 10_000;
  const counter2 = Number((await state(pf.hash)).meta.find((m) => m.k === "nonce").v);
  const all = new Set([...seals.nonces, ...nonces.map((c) => Buffer.from(cr.nonceOf(c)).toString("hex"))]);
  ok(seals.failed === 0 && seals.nonces.length === want && all.size === want + nonces.length && counter2 === counter + want && (await state(pf.hash)).reservations.length === 0,
    `S3a: ${want} concurrent seals under the account's DEK: ${want} distinct nonces, none an earlier one's, the counter up by exactly ${want}; every one abandoned and burned (${Date.now() - t1} ms)`);
  // (the nonce in every stored header is the record's, and unique across the stored objects of one conversation)
  const objs = await objects(`acct/${pf.hash}/conv/${locs[0]}/`);
  const heads = await Promise.all(objs.map(async (o) => { const b = Buffer.from(await (await bucket.get(o.key)).arrayBuffer()); return JSON.parse(b.subarray(8, 8 + b.readUInt32BE(4)).toString()); }));
  ok(heads.length === PER && new Set(heads.map((h) => h.nonce)).size === PER && heads.every((h) => st.segments.some((s) => s.locator === locs[0] && s.segment === h.segment && Buffer.from(cr.nonceOf(s.nonce)).toString("hex") === h.nonce)),
    "S3a: each stored header carries its record's nonce");
  // (mechanic 3: a reservation abandoned across a restart and an alarm: its value burned, never reused)
  const crashed = await pf.append(locs[1], body(PER + 1, 1, 900), { "x-test-crash-after-put": "1" });
  const burned = Number((await state(pf.hash)).meta.find((m) => m.k === "nonce").v);
  await doCall(pf.hash, "__restart").catch(() => {});
  await clock(pf.hash, 400_000);
  await alarm(pf.hash);
  await alarm(pf.hash);
  await clock(pf.hash, 0);
  const next = await pf.append(locs[1], body(PER + 1, 1, 900));
  const st2 = await state(pf.hash);
  const used = st2.segments.find((s) => s.locator === locs[1] && s.first_n === PER + 1)?.nonce;
  ok(crashed.status === 500 && next.status === 200 && used === burned + 1 && !st2.segments.some((s) => s.nonce === burned), `mechanic 3: after a restart and the alarm, the abandoned value ${burned} is burned; the next seal takes ${used}`);
  // (mechanic 3: the counter's end: one more seal at NONCE_MAX - 1, then refused, never wrapped)
  await doCall(pf.hash, "__nonce", `?set=${Number.MAX_SAFE_INTEGER - 1}`);
  const last = await pf.append(locs[2], body(PER + 1, 1, 900));
  const over = await pf.append(locs[2], body(PER + 2, 1, 903));
  const st3 = await state(pf.hash);
  ok(last.status === 200 && over.status === 507 && over.body.error === "exhausted" && st3.meta.find((m) => m.k === "nonce").v === String(Number.MAX_SAFE_INTEGER) && st3.reservations.length === 0,
    `mechanic 3: at the counter's end, sealing is refused (${last.status} then ${over.status} ${over.body?.error}), never wrapped`);
}
{
  // (b) each AAD field altered in turn: decryption fails
  const key = await subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const h = { v: 1, alg: "A256GCM", schema: 1, account: A, locator: "a".repeat(32), log_instance: INST, segment: 3, first_n: 1, last_n: 2, first_seq: 3, last_seq: 6, prev: "0".repeat(64), key_id: "b".repeat(32), nonce: Buffer.from(cr.nonceOf(7)).toString("hex"), len: 5 };
  const obj = await cr.seal(key, h, Buffer.from("hello"));
  ok(Buffer.from(await cr.open(key, obj, h)).toString() === "hello", "S3b: the sealed segment opens under its own header");
  const n = Buffer.from(obj).readUInt32BE(4);
  const ct = obj.subarray(8 + n);
  const alter = { v: 2, account: B, locator: "c".repeat(32), log_instance: "other", segment: 4, first_n: 2, last_n: 3, first_seq: 4, last_seq: 7, prev: "1".repeat(64), key_id: "d".repeat(32), alg: "A128GCM", nonce: Buffer.from(cr.nonceOf(8)).toString("hex"), len: 6, schema: 2 };
  const bad = [];
  for (const [f, v] of Object.entries(alter)) {
    const h2 = { ...h, [f]: v };
    const head = Buffer.from(fmt.canonical(h2));
    const o2 = Buffer.concat([Buffer.from("SBM1"), Buffer.alloc(4), head, ct]);
    o2.writeUInt32BE(head.length, 4);
    // (the header rewritten with the field changed, the ciphertext kept: whether the reader expects the old header or the new one, nothing opens)
    if ((await cr.open(key, o2, h2)) !== null || (await cr.open(key, o2, h)) !== null || (await cr.open(key, obj, h2)) !== null) bad.push(f);
  }
  ok(bad.length === 0 && Object.keys(alter).length === 15, `S3b: each of the 15 AAD fields altered -> decryption fails (${bad})`);
  // (d) a wrapped DEK under another account's or key_id's AAD doesn't unwrap; (e, unit) a missing KEK neither
  const env = { MIRROR_KEK_CURRENT: "1", MIRROR_KEK_V1: KEK1, MIRROR_KEK_V2: KEK2 };
  const w = await cr.newWrappedDek(env, A);
  ok((await cr.openDek(env, A, [w])) !== null, "S3d: the wrap opens for its own account and key_id");
  ok((await cr.openDek(env, B, [w])) === null && (await cr.openDek(env, A, [{ ...w, key_id: "e".repeat(32) }])) === null && (await cr.openDek(env, A, [{ ...w, kek: "2" }])) === null,
    "S3d: the wrap with its account id, key_id or KEK version swapped doesn't unwrap");
  ok((await cr.openDek({ MIRROR_KEK_CURRENT: "2", MIRROR_KEK_V2: KEK2 }, A, [w])) === null, "S3e: a wrap whose KEK is gone doesn't open");
}
{
  // (c) a stored segment with its last byte flipped: the reader writes one answer, "missing", and no plaintext byte
  const loc = (await pa.conv("s3c")).body.locator;
  await pa.append(loc, body(1, 2, 3, INST, (i) => `secret plaintext ${i}`));
  const st = await state(pa.hash);
  const key = keyOf(pa.hash, loc, st.segments.find((s) => s.locator === loc).segment);
  const good = await readW(pa, loc, INST, 0);
  ok(good.chunks.length === 1 && good.chunks[0].body.includes("secret plaintext 1"), "S3c: the segment reads whole before it is touched");
  const b = Buffer.from(await (await bucket.get(key)).arrayBuffer());
  b[b.length - 1] ^= 1;
  await bucket.put(key, b);
  const r = await readW(pa, loc, INST, 0);
  ok(r.chunks.length === 1 && JSON.parse(r.chunks[0].body).missing === true && !r.chunks[0].body.includes("plaintext") && !("entries" in JSON.parse(r.chunks[0].body)),
    `S3c/S4e/mechanic 2: zero plaintext chunks, one "missing" answer (${r.chunks.map((c) => c.body).join("|")})`);
  // (and through the route: the same)
  const rr = await pa.read(loc, INST, 0);
  ok(rr.body.missing === true && rr.body.reason === "corrupt" && !JSON.stringify(rr.body).includes("plaintext"), "S4e: a corrupt segment reads as missing, never partial");
}
{
  // (e) KEK rotation, end to end: wrapped under v1; read with v2 current (rewrapped under v2); v1 removed: still reads
  const pg = await page(G);
  await pg.enable();
  const loc = (await pg.conv("rot")).body.locator;
  await pg.append(loc, body(1, 2));
  ok((await state(pg.hash)).wraps.map((w) => w.kek).join() === "1", "S3e: wrapped under v1");
  const r2 = await pg.read(loc, INST, 0, { "x-test-kek-current": "2" });
  ok(r2.body.entries?.length === 2 && (await state(pg.hash)).wraps.map((w) => w.kek).join() === "2", `S3e: v2 current: it reads, and is rewrapped under v2 only (${(await state(pg.hash)).wraps.map((w) => w.kek)})`);
  const r3 = await pg.read(loc, INST, 0, { "x-test-kek-current": "2", "x-test-kek-drop": "1" });
  const a3 = await site(`/api/mirror/v1/append/${loc}`, { method: "POST", headers: pg.h({ "content-type": "application/vnd.sagebrush.mirror+json", "x-sb-mirror-range": `${INST} 3 3 9 9`, "x-test-kek-current": "2", "x-test-kek-drop": "1" }), body: JSON.stringify(body(3, 1)) });
  ok(r3.body.entries?.length === 2 && a3.status === 200, `S3e: v1 removed: reads and appends (${a3.status})`);
}

lap('S4: bounds');
// ---- S4: bounds, before buffering
{
  const loc = (await pa.conv("s4")).body.locator;
  const nonce0 = () => state(pa.hash).then((s) => s.meta.find((m) => m.k === "nonce").v);
  const n0 = await nonce0();
  const cap = 320 * 1024;
  const big = await stream(`/api/mirror/v1/append/${loc}`, 1 << 20, appendHeaders(pa), cap + 1);
  ok(big.status === 413 && big.pulled === 0, `S4a: a Content-Length over the cap -> 413, nothing read (${big.status}, ${big.pulled})`);
  const none = await stream(`/api/mirror/v1/append/${loc}`, 1 << 20, appendHeaders(pa));
  ok(none.status === 411 && none.pulled === 0, `S4a: a streamed body without a length -> 411, nothing read (${none.status}, ${none.pulled})`);
  const liar = await stream(`/api/mirror/v1/append/${loc}`, 1 << 20, appendHeaders(pa), 2048);
  ok(liar.status === 400 && liar.pulled <= 3 && liar.cancelled, `S4a: a body longer than its length is cut, not read (${liar.status}, ${liar.pulled} KiB pulled)`);
  // (b) the caps: entries, a field, nesting, a segment
  const many = await stream(`/api/mirror/v1/append/${loc}`, 4096, appendHeaders(pa, { "x-sb-mirror-range": `${INST} 1 2001 1 99999` }), 4096);
  ok(many.status === 400 && many.pulled === 0, `S4b: 2001 entries (the range) -> refused before reading (${many.status})`);
  const longText = await pa.append(loc, body(1, 1, 3, INST, () => "x".repeat(192 * 1024 + 1)));
  const nested = await pa.append(loc, { ...body(1, 1), entries: [{ ...body(1, 1).entries[0], text: undefined, deep: { a: [1] } }] }, {}, `${INST} 1 1 3 3`);
  const huge = await pa.append(loc, body(1, 1100, 3, INST, (i) => "y".repeat(230)));
  ok(longText.status === 400 && nested.status === 400 && huge.status === 413, `S4b: an over-long field (${longText.status}), nesting (${nested.status}), a segment over 256 KiB (${huge.status}) are refused`);
  const s = await state(pa.hash);
  ok(!s.segments.some((x) => x.locator === loc) && s.reservations.length === 0 && (await objects(`acct/${pa.hash}/conv/${loc}/`)).length === 0, "S4b: nothing stored for any of them");
  ok((await nonce0()) !== n0, "(their reservations came first, as designed: the quota before the body)");
  // (b) conversations: at most 500 an account
  const pi = await page(I);
  await pi.enable();
  let lim = null;
  for (let i = 0; i < 600 && !lim; i++) {
    const r = await pi.conv("many-" + i);
    if (r.status !== 200) lim = r;
  }
  ok(lim?.status === 413 && lim.body.error === "limit" && (await state(pi.hash)).convs.length === 500, `S4b: the 501st conversation is refused (${lim?.status})`);
  // (d) a compressed upload: refused (above, S1c); identity is fine
  ok((await pa.append(loc, body(1, 1), { "content-encoding": "identity" })).status === 200, "S4d: Content-Encoding identity is accepted; anything else is 415 (S1c)");
}

lap('A2 and S4c');
// ---- A2 and S4c: the one storage budget
const limitsRow = (account, storage_bytes) => db.prepare("INSERT INTO limits_cache (account_id, limits, fetched) VALUES (?1, ?2, ?3) ON CONFLICT(account_id) DO UPDATE SET limits = ?2, fetched = ?3")
  .bind(account, JSON.stringify({ tier: "member", storage_bytes, max_file_bytes: 1 << 20, private_links: false }), Math.floor(Date.now() / 1000)).run();
const RES = 256 * 1024 + 2072; // (what one append reserves: a segment's cap, sealed)
async function invariant(p, L, what) {
  const st = await state(p.hash);
  // (an object a live reservation will commit is paid for by that reservation: counted once)
  const pending = new Set(st.reservations.map((r) => keyOf(p.hash, r.locator, r.segment)));
  const actual = (await objects(`acct/${p.hash}/`)).filter((o) => !pending.has(o.key)).reduce((n, o) => n + o.size, 0);
  const live = st.reservations.filter((r) => r.state !== "raising").reduce((n, r) => n + r.bytes, 0);
  const claim = await claimOf(p.account);
  const sharing = (await db.prepare("SELECT (SELECT COALESCE(SUM(size), 0) FROM holdings WHERE account_id = ?1) + (SELECT COALESCE(SUM(bytes), 0) FROM reservations WHERE account_id = ?1) AS n").bind(p.account).first()).n;
  const sync = (await db.prepare("SELECT COALESCE(SUM(claim_bytes), 0) AS n FROM sync_accounts WHERE account_hash = ?1").bind(p.hash).first()).n;
  const others = (await db.prepare("SELECT COALESCE(SUM(bytes), 0) AS n FROM budget_claims WHERE account_id = ?1 AND holder <> 'mirror'").bind(p.account).first()).n;
  ok(actual + live <= claim && (L === null || claim + sharing + sync + others <= L), `A2 invariant (${what}): actual ${actual} + reservations ${live} <= claim ${claim}; claims ${claim + sharing + sync + others} <= ${L}`);
}
const pd = await page(D);
{
  await pd.enable();
  const loc = (await pd.conv("budget")).body.locator;
  // (S4c) a full account: refused at the reservation, nothing read, nothing sealed
  await limitsRow(D, RES - 1);
  const n0 = (await state(pd.hash)).meta.find((m) => m.k === "nonce")?.v;
  const full = await stream(`/api/mirror/v1/append/${loc}`, 4096, appendHeaders(pd), 4096);
  ok(full.status === 507 && full.pulled === 0 && (await objects(`acct/${pd.hash}/`)).length === 0 && (await claimOf(D)) === 0, `S4c: a full quota -> 507 at the reservation, before any read, seal or upload (${full.status}, ${full.pulled})`);
  ok((await state(pd.hash)).meta.find((m) => m.k === "nonce")?.v !== n0, "(its nonce was taken and burned)");
  // (the budget counts sync's claim and other holders, not only sharing)
  await limitsRow(D, 10 << 20);
  await db.prepare("INSERT INTO sync_accounts (account_hash, prefix, generation, state, created, claim_bytes) VALUES (?1, substr(?1, 1, 32), 1, 'active', 0, ?2)").bind(pd.hash, (10 << 20) - RES + 1).run();
  ok((await pd.append(loc, body(1, 1))).status === 507, "A2: sync's claim counts: no room left -> 507");
  await db.prepare("UPDATE sync_accounts SET claim_bytes = 0 WHERE account_hash = ?1").bind(pd.hash).run();
  await db.prepare("INSERT INTO budget_claims (account_id, holder, bytes) VALUES (?1, 'other', ?2)").bind(D, (10 << 20) - RES + 1).run();
  ok((await pd.append(loc, body(1, 1))).status === 507, "A2: another holder's claim counts too");
  await db.prepare("DELETE FROM budget_claims WHERE account_id = ?1 AND holder = 'other'").bind(D).run();
  ok((await pd.append(loc, body(1, 1))).status === 200, "A2: with room, it goes in");
  await invariant(pd, 10 << 20, "after an append");
  // (the race: a sharing upload and a mirror append, each fitting alone, not both: at most the budget wins.  The mirror
  // holds its claim (it stops after its put) so the race is at the claim, not after the commit lowered it)
  let both = 0, neither = 0;
  for (let i = 0; i < 6; i++) {
    await alarm(pd.hash); // (the claim down to what is held: the edge is computed from that)
    const used = (await claimOf(D)) + (await db.prepare("SELECT COALESCE(SUM(size), 0) AS n FROM holdings WHERE account_id = ?1").bind(D).first()).n;
    const S = 3000;
    const L = used + RES + S - 1;
    await limitsRow(D, L);
    const blob = randomBytes(S);
    const sha = createHash("sha256").update(blob).digest("hex");
    const [m, s] = await Promise.all([
      pd.append(loc, body(2 + i, 1, 100 + i), { "x-test-crash-after-put": "1" }),
      site(`/api/share/blob/${sha}`, { method: "PUT", headers: { cookie: pd.cookie, origin: SITE, "content-length": String(S) }, body: blob }),
    ]);
    const mw = m.status === 500, sw = s.status === 200;
    if (mw && sw) { both++; console.log("both:", i, JSON.stringify(m.body), await s.text(), L, used, await claimOf(D)); }
    if (!mw && !sw) neither++;
    await invariant(pd, L, `race ${i}: mirror ${m.status}, sharing ${s.status}`);
    await clock(pd.hash, 400_000);
    await alarm(pd.hash);
    await alarm(pd.hash);
    await clock(pd.hash, 0);
  }
  ok(both === 0 && neither === 0, `A2: racing sharing at the edge, exactly one wins each time (both ${both}, neither ${neither})`);
  // (counting is one way: with BUDGET_CLAIMS unbound after claims exist (a rollback of the binding), sharing, core's and
  // this directory's, still counts the mirror's claim; the mirror itself is then inert)
  await alarm(pd.hash);
  const c = await claimOf(D);
  const shared = (await db.prepare("SELECT COALESCE(SUM(size), 0) AS n FROM holdings WHERE account_id = ?1").bind(D).first()).n;
  ok(c > 0, `(the mirror holds a claim: ${c})`);
  const S = 2000;
  await limitsRow(D, shared + c + S - 1);
  for (const [who, hdr] of [["this directory's sharing", {}], ["core's sharing", { "x-test-core": "1" }]]) {
    const blob = randomBytes(S);
    const sha = createHash("sha256").update(blob).digest("hex");
    const r = await site(`/api/share/blob/${sha}`, { method: "PUT", headers: { cookie: pd.cookie, origin: SITE, "content-length": String(S), "x-test-budget-claims": "off", ...hdr }, body: blob });
    ok(r.status === 413, `A2/gate: BUDGET_CLAIMS off after a claim exists: ${who} still counts it, and refuses what wouldn't fit (${r.status})`);
  }
  ok((await site("/api/mirror/v1/status", { headers: { cookie: pd.cookie, origin: SITE, "x-test-budget-claims": "off" } })).status === 404, "A2/gate: and the mirror, the claim's only writer, is inert without it");
  await limitsRow(D, 10 << 20);
  // (a cap that comes down: headroom admitted under the old cap is never spent past the new one)
  await alarm(pd.hash);
  const st0 = (await state(pd.hash)).streams.find((x) => x.locator === loc);
  const nx = st0.next_n, sq = st0.last_seq + 3;
  const big = await pd.append(loc, body(nx, 1, sq));
  const cBig = await claimOf(D), sBig = await state(pd.hash);
  ok(big.status === 200 && cBig >= sBig.held + 4 * 1024 * 1024, `downgrade: an append under 10 MiB took its headroom (${big.status}; claim ${cBig}, held ${sBig.held})`);
  await limitsRow(D, RES - 1); // (below the claim, and below what one more append reserves)
  const objs0 = (await objects(`acct/${pd.hash}/`)).length;
  const down = await stream(`/api/mirror/v1/append/${loc}`, 4096, appendHeaders(pd, { "x-sb-mirror-range": `${INST} ${nx + 1} ${nx + 1} ${sq + 3} ${sq + 3}` }), 4096);
  ok(down.status === 507 && down.pulled === 0 && (await objects(`acct/${pd.hash}/`)).length === objs0 && !(await state(pd.hash)).segments.some((s) => s.locator === loc && s.first_n === nx + 1),
    `downgrade: an append the old headroom would cover is refused under the lower cap: ${down.status}, ${down.pulled} pulled, no new object`);
  await invariant(pd, null, "after the downgrade");
  // (a cap cycle: headroom admitted at 10 MiB; the cap rises to 20 MiB and another holder grows; the cap comes down to
  // 15 MiB, still above the cap the headroom was admitted under: the append is refused all the same)
  await limitsRow(D, 10 << 20);
  await alarm(pd.hash);
  const st1 = (await state(pd.hash)).streams.find((x) => x.locator === loc);
  const h1 = await pd.append(loc, body(st1.next_n, 1, st1.last_seq + 3));
  const c1 = await claimOf(D), held1 = (await state(pd.hash)).held;
  ok(h1.status === 200 && c1 >= held1 + 4 * 1024 * 1024, `cap cycle: headroom admitted under 10 MiB (${h1.status}; claim ${c1})`);
  await limitsRow(D, 20 << 20);
  const sharedNow = (await db.prepare("SELECT COALESCE(SUM(size), 0) AS n FROM holdings WHERE account_id = ?1").bind(D).first()).n;
  const other = (15 << 20) - sharedNow - held1 - RES + 1; // (with it, one more append can't fit 15 MiB, however the mirror's claim shrinks)
  await db.prepare("INSERT INTO budget_claims (account_id, holder, bytes) VALUES (?1, 'other', ?2)").bind(D, other).run();
  await limitsRow(D, 15 << 20);
  const objs1 = (await objects(`acct/${pd.hash}/`)).length;
  const cyc = await stream(`/api/mirror/v1/append/${loc}`, 4096, appendHeaders(pd, { "x-sb-mirror-range": `${INST} ${st1.next_n + 1} ${st1.next_n + 1} ${st1.last_seq + 6} ${st1.last_seq + 6}` }), 4096);
  ok(cyc.status === 507 && cyc.pulled === 0 && (await objects(`acct/${pd.hash}/`)).length === objs1, `cap cycle: 10 -> 20 MiB, another holder grows, 15 MiB: refused (${cyc.status}, ${cyc.pulled} pulled, no new object)`);
  // (and 10 -> 20 -> 10: the cap back where the headroom was admitted)
  await limitsRow(D, 10 << 20);
  const cyc2 = await stream(`/api/mirror/v1/append/${loc}`, 4096, appendHeaders(pd, { "x-sb-mirror-range": `${INST} ${st1.next_n + 1} ${st1.next_n + 1} ${st1.last_seq + 6} ${st1.last_seq + 6}` }), 4096);
  ok(cyc2.status === 507 && cyc2.pulled === 0 && (await objects(`acct/${pd.hash}/`)).length === objs1, `cap cycle: 10 -> 20 -> 10 MiB with another holder grown: refused (${cyc2.status}, ${cyc2.pulled} pulled)`);
  await db.prepare("DELETE FROM budget_claims WHERE account_id = ?1 AND holder = 'other'").bind(D).run();
}
{
  // (crash cuts on both sides of the raise and the lowering: only ever an overclaim, repaired by the alarm)
  const ph = await page(H);
  await ph.enable();
  await limitsRow(H, 50 << 20);
  const loc = (await ph.conv("cuts")).body.locator;
  await ph.append(loc, body(1, 1));
  await doCall(ph.hash, "__cut", "?at=after-raise");
  const r1 = await ph.append(loc, body(2, 1));
  const s1 = await state(ph.hash);
  ok(r1.status === 503 && (await claimOf(H)) > s1.held, `A2 cut after the raise: refused, an overclaim (${await claimOf(H)} > ${s1.held})`);
  await invariant(ph, 50 << 20, "cut after the raise");
  await alarm(ph.hash);
  ok((await claimOf(H)) === (await state(ph.hash)).held, "A2: the alarm repairs that overclaim, with no write from the page");
  const r2 = await ph.append(loc, body(2, 1), { "x-test-crash-after-put": "1" });
  await invariant(ph, 50 << 20, "cut after the put");
  await doCall(ph.hash, "__cut", "?at=before-lower");
  await clock(ph.hash, 400_000);
  await alarm(ph.hash).catch(() => {});
  await invariant(ph, 50 << 20, "cut before the alarm's lowering");
  await alarm(ph.hash);
  await clock(ph.hash, 0);
  ok(r2.status === 500 && (await claimOf(H)) === (await state(ph.hash)).held, "A2: collected after the put's crash, the claim exact again");
  // (a commit leaves its lowering to the alarm: an overclaim until then; and a crash before that lowering keeps it so)
  const r3 = await ph.append(loc, body(2, 1));
  const s3 = await state(ph.hash);
  ok(r3.status === 200 && (await claimOf(H)) > s3.held, `A2: after a commit, an overclaim until the alarm lowers it (${await claimOf(H)} > ${s3.held})`);
  await doCall(ph.hash, "__cut", "?at=before-lower");
  await alarm(ph.hash);
  ok((await claimOf(H)) > s3.held, "A2 cut before the lowering: still an overclaim, never under");
  await invariant(ph, 50 << 20, "cut before the commit's lowering");
  await alarm(ph.hash);
  ok((await claimOf(H)) === (await state(ph.hash)).held, "A2: repaired by the alarm");
  // (one alarm, consumed as the runtime does, whose lowering fails, after a normal commit (nothing else pending): it
  // leaves a future alarm, and that one repairs the claim, with no page append in between)
  // (the object's clock an hour ahead: its alarms are then an hour off in real time, so only this row fires them)
  await clock(ph.hash, 3_600_000);
  const r4 = await ph.append(loc, body(3, 1));
  const s4 = await state(ph.hash);
  ok(r4.status === 200 && s4.reservations.length === 0 && (await claimOf(H)) > s4.held, `(after a commit: an overclaim, nothing else pending)`);
  await doCall(ph.hash, "__cut", "?at=before-lower");
  const f1 = await doCall(ph.hash, "__fire");
  const s5 = await state(ph.hash);
  ok(f1.alarm !== null && s5.reservations.length === 0 && s5.outbox.length === 0 && (await claimOf(H)) > s5.held, `A2: a consumed alarm whose lowering fails leaves a future alarm (${f1.alarm})`);
  const f2 = await doCall(ph.hash, "__fire");
  ok((await claimOf(H)) === (await state(ph.hash)).held && f2.alarm === null, `A2: that alarm repairs the claim, no page traffic needed (${await claimOf(H)}); then none is left`);
  await clock(ph.hash, 0);
}

lap('S5: keys');
// ---- S5: keys and deletion (mechanic 4)
const pe = await page(E);
{
  await pe.enable();
  const l1 = (await pe.conv("e1")).body.locator, l2 = (await pe.conv("e2")).body.locator;
  await pe.append(l1, body(1, 3));
  await pe.append(l1, body(4, 2));
  await pe.append(l2, body(1, 2));
  // (d) delete one conversation: its objects go, the other still reads
  ok((await pe.del(l1)).status === 200, "S5d: delete a conversation");
  await clock(pe.hash, 400_000);
  await alarm(pe.hash);
  await alarm(pe.hash);
  await clock(pe.hash, 0);
  ok((await objects(`acct/${pe.hash}/conv/${l1}/`)).length === 0 && (await pe.read(l2, INST, 0)).body.entries?.length === 2 && (await pe.read(l1, INST, 0)).status === 404,
    "S5d: its objects are deleted (run twice), the other conversation still reads");
  // (b) turning it off
  await pe.append(l2, body(3, 1));
  const before = await state(pe.hash);
  const off = await pe.disable();
  const st = await state(pe.hash);
  ok(off.status === 200 && st.wraps.length === 0 && st.convs.length === 0 && st.segments.length === 0 && st.streams.length === 0 && st.reservations.length === 0 && (st.outbox.length >= 1 || (await objects(`acct/${pe.hash}/`)).length === 0),
    `S5b: off: every wrapped DEK, the index and the reservations are gone at once, the objects scheduled (or, Miniflare's own alarm having run, already gone) (${st.outbox.length})`);
  ok((await pe.read(l2, INST, 0)).status === 409 && (await pe.list()).status === 409, "S5b: a read right after: nothing");
  await clock(pe.hash, 400_000);
  await alarm(pe.hash);
  await alarm(pe.hash);
  await clock(pe.hash, 0);
  ok((await objects(`acct/${pe.hash}/`)).length === 0 && (await state(pe.hash)).outbox.length === 0, "mechanic 4: the deletion run to its end, twice: nothing listed under the account's prefix");
  // (c) the tombstone: a stale retry, a re-enabled account, a restored index
  ok((await pe.append(l2, body(4, 1))).status === 409, "S5c: a stale upload after off is refused");
  await pe.enable();
  ok((await pe.append(l2, body(4, 1))).status === 404, "S5c: after turning on again, the old conversation is gone (its locator tombstoned)");
  await doCall(pe.hash, "__restore", "", { convs: before.convs, segments: before.segments, streams: before.streams, wraps: before.wraps });
  const rr = await pe.read(l2, INST, 0);
  ok(rr.status === 404 && !JSON.stringify(rr.body).includes("message"), `S5c: a restored index reads nothing: the old locator and key are tombstoned (${rr.status})`);
  // (the purge: the mirror unreachable keeps it running; then its data goes first, its claim last)
  await doCall(pe.hash, "__restore", "", { convs: [], segments: [], streams: [], wraps: [] });
  const l3 = (await pe.conv("e3")).body.locator;
  ok((await pe.append(l3, body(1, 2))).status === 200, "(a fresh conversation after turning on again)");
  const rid = "purge-" + randomBytes(4).toString("hex");
  await site("/__bindpurge", { method: "POST", body: JSON.stringify({ account: E, rid, kind: "self" }) });
  await site("/__scheduled", { method: "POST", headers: { "x-test-mirror-down": "1" } });
  const p1 = await db.prepare("SELECT status FROM purges WHERE request_id = ?1").bind(rid).first();
  ok(p1?.status !== "done" && (await claimOf(E)) > 0 && (await objects(`acct/${pe.hash}/`)).length > 0, `purge: with the mirror unreachable, it stays (${p1?.status}), the claim and objects too`);
  await db.prepare("UPDATE purges SET lease = 0 WHERE request_id = ?1").bind(rid).run();
  await site("/__scheduled", { method: "POST" });
  const p2 = await db.prepare("SELECT status FROM purges WHERE request_id = ?1").bind(rid).first();
  ok(p2?.status !== "done" && (await state(pe.hash)).wraps.length === 0, `purge: the mirror erased (keys now); the purge waits for its objects (${p2?.status})`);
  await clock(pe.hash, 400_000);
  await alarm(pe.hash);
  await alarm(pe.hash);
  await clock(pe.hash, 0);
  await site("/__scheduled", { method: "POST" });
  const p3 = await db.prepare("SELECT status FROM purges WHERE request_id = ?1").bind(rid).first();
  ok(p3?.status === "done" && (await objects(`acct/${pe.hash}/`)).length === 0 && (await db.prepare("SELECT COUNT(*) AS n FROM budget_claims WHERE account_id = ?1").bind(E).first()).n === 0,
    `purge: done once the mirror's objects are gone; its budget row deleted last (${p3?.status})`);
}

lap('S6: reader');
// ---- S6: reader integrity (a-c; d and e are the page's, M2)
{
  const l1 = (await pa.conv("s6-1")).body.locator, l2 = (await pa.conv("s6-2")).body.locator;
  await pa.append(l1, body(1, 2, 3, INST, (i) => `one ${i}`));
  await pa.append(l1, body(3, 2, 30, INST, (i) => `one ${i}`));
  await pa.append(l2, body(1, 2, 3, INST, (i) => `two ${i}`));
  const st = await state(pa.hash);
  const seg = (loc, n) => st.segments.find((s) => s.locator === loc && s.first_n === n).segment;
  // (a) moved under another conversation's path, or another account's
  const k11 = keyOf(pa.hash, l1, seg(l1, 1)), k21 = keyOf(pa.hash, l2, seg(l2, 1));
  const saved = Buffer.from(await (await bucket.get(k21)).arrayBuffer());
  await bucket.put(k21, await (await bucket.get(k11)).arrayBuffer());
  const moved = await readW(pa, l2, INST, 0);
  ok(moved.chunks.length === 1 && JSON.parse(moved.chunks[0].body).missing === true && !moved.chunks[0].body.includes("one 1"), "S6a: a segment moved under another conversation is refused before decrypting");
  await bucket.put(k21, saved);
  const lb = (await pb.conv("s6-b")).body.locator;
  await pb.append(lb, body(1, 2));
  const kb = keyOf(pb.hash, lb, (await state(pb.hash)).segments.find((s) => s.locator === lb).segment);
  await bucket.put(kb, await (await bucket.get(k11)).arrayBuffer());
  const across = await pb.read(lb, INST, 0);
  ok(across.body.missing === true && !JSON.stringify(across.body).includes("one 1"), "S6a: and under another account's path");
  // (c) a broken chain: segment 2 replaced by an older valid one (segment 1)
  const k12 = keyOf(pa.hash, l1, seg(l1, 3));
  await bucket.put(k12, await (await bucket.get(k11)).arrayBuffer());
  const chain = await pa.read(l1, INST, 2);
  ok(chain.body.missing === true && (await pa.read(l1, INST, 0)).body.entries?.length === 2, "S6c: a segment replaced by an older valid one is refused; the one before still reads");
  // (b) a schema violation inside a valid AEAD
  const l3 = (await pa.conv("s6-3")).body.locator;
  for (const [what, pt] of [
    ["an extra field", fmt.canonical({ ...body(1, 1), entries: [{ ...body(1, 1).entries[0], verified: true }] })],
    ["an unknown kind", fmt.canonical({ ...body(1, 1), entries: [{ k: "thinking", n: 1, seq: 3, text: "x" }] })],
    ["not JSON", "not json at all"],
  ]) {
    const loc = (await pa.conv("s6-b-" + what)).body.locator;
    const f = await (await site("/__forge", { method: "POST", body: JSON.stringify({ account: A, hash: pa.hash, locator: loc, log_instance: INST, first_n: 1, last_n: 1, first_seq: 3, last_seq: 3, plaintext: pt }) })).json();
    const r = await pa.read(loc, INST, 0);
    ok(f.c?.ok && r.body.missing === true && r.body.reason === "corrupt", `S6b: ${what} inside a valid AEAD -> refused as corrupt (${JSON.stringify(r.body)})`);
  }
  void l3;
}

lap('S7a, S8');
// ---- S7a, S8, and the allowlist (the Worker's side)
{
  const loc = (await pa.conv("s7")).body.locator;
  const v1 = await pa.append(loc, { ...body(1, 1), entries: [{ ...body(1, 1).entries[0], verified: true }] });
  const v2 = await pa.append(loc, { ...body(1, 1), verified: true });
  const v3 = await pa.append(loc, { ...body(1, 1), entries: [{ ...body(1, 1).entries[0], authenticated_by: "runner" }] });
  ok(v1.status === 400 && v2.status === 400 && v3.status === 400 && !(await state(pa.hash)).segments.some((s) => s.locator === loc), "S7a: an authenticity claim, on an entry or the body, is refused; nothing stored");
  // (S8) the mode is recorded per account, and a B upload checks it
  ok((await pa.status()).body.mode === "B", "S8: the account's mode is recorded (B)");
  await pa.append(loc, body(1, 1));
  await doCall(pa.hash, "__mode", `?conv=${loc}`);
  const c1 = await pa.append(loc, body(2, 1));
  const rd = await pa.read(loc, INST, 0);
  ok(c1.status === 409 && c1.body.error === "mode" && rd.body.entries?.length === 1 && rd.body.encryption === "server", `S8: once C is on for a conversation, a B segment is refused (${c1.status}); its B history still reads, labeled server-readable`);
  const loc2 = (await pa.conv("s8-acct")).body.locator;
  await doCall(pa.hash, "__mode", "?account=C");
  const c2 = await pa.append(loc2, body(1, 1));
  ok(c2.status === 409 && c2.body.error === "mode", "S8: and for the whole account");
  await doCall(pa.hash, "__mode", "?account=B");
  // (the allowlist, at the Worker: each excluded field planted on an allowed entry is refused)
  const loc3 = (await pa.conv("allow")).body.locator;
  const planted = [
    ["user", { args: '{"path":"/etc"}' }], ["tool_started", { input: "{}" }], ["tool_finished", { body: "result body" }], ["tool_finished", { diff: "x" }],
    ["user", { stdout: "x" }], ["user", { env: "HOME=/root" }], ["user", { image: "iVBORw0KGgo" }], ["approval", { detail: "all of it" }], ["approval", { instance: "card-token" }],
    ["artifact", { body: "file contents" }], ["artifact", { path: "/home/user/x.md" }], ["turn_error", { message: "stack trace" }], ["text", { thinking: "x" }],
  ];
  const base = {
    user: { k: "user", id: "u", text: "hi" }, tool_started: { k: "tool_started", turn: "t", call: "c", tool: "Read" }, tool_finished: { k: "tool_finished", turn: "t", call: "c", status: "ok", duration_ms: 5 },
    approval: { k: "approval", turn: "t", id: "a", kind: "egress", state: "approved" }, artifact: { k: "artifact", turn: "t", id: "x", kind: "markdown" }, turn_error: { k: "turn_error", turn: "t", code: "boom" },
    text: { k: "text", turn: "t", message: "m", revision: 0, text: "hi" },
  };
  const refusedAll = [];
  for (const [kind, extra] of planted) {
    const e = { ...base[kind], ...extra, n: 1, seq: 3 };
    const r = await pa.append(loc3, { schema: 1, allowlist: 1, log_instance: INST, entries: [e] });
    if (r.status !== 400) refusedAll.push(kind + ":" + Object.keys(extra)[0]);
  }
  // (summaries and titles that aren't safe: a path, a URL with a query or credentials, a token, a key)
  for (const bad of ["Read /home/user/secret.txt", "Fetch https://x.test/a?token=1", "Fetch https://u:p@x.test/", "Bearer abcdefghijklmnop", "-----BEGIN PRIVATE KEY-----", "ghp_" + "a".repeat(36)]) {
    const r = await pa.append(loc3, { schema: 1, allowlist: 1, log_instance: INST, entries: [{ ...base.tool_started, summary: bad, n: 1, seq: 3 }] });
    if (r.status !== 400) refusedAll.push("summary:" + bad.slice(0, 12));
  }
  const unk = await pa.append(loc3, { schema: 1, allowlist: 1, log_instance: INST, entries: [{ k: "thinking", n: 1, seq: 3, text: "x" }] });
  ok(refusedAll.length === 0 && unk.status === 400 && !(await state(pa.hash)).segments.some((s) => s.locator === loc3), `allowlist b/c (Worker): every excluded field and an unknown kind are refused (${refusedAll})`);
  ok((await pa.append(loc3, { schema: 1, allowlist: 1, log_instance: INST, entries: [{ ...base.tool_started, summary: "Fetch https://example.com/docs", n: 1, seq: 3 }] })).status === 200, "allowlist: a safe summary (a URL without a query) is kept");
}

// ---- the allowlist end to end: the agent's log normalized, uploaded, decrypted and searched (b, c, d at the Worker)
{
  const M = (s) => `PLANTED-${s}-${randomBytes(3).toString("hex")}`;
  const marks = {};
  const mk = (s) => (marks[s] = M(s));
  const log = [
    { method: "chat.message", params: { conversation: "c", author: "person", id: "u1", text: "my key is sk-live-not-redacted (pasted)", extra: mk("msgextra") } },
    { method: "turn.event", params: { turn_id: "t1", event: { type: "turn_started" } } },
    { method: "turn.event", params: { turn_id: "t1", event: { type: "thinking_delta", text: mk("thinking") } } },
    { method: "turn.event", params: { turn_id: "t1", event: { type: "tool_call_started", call: "c1", tool: "Bash", summary: `Run ls /home/${mk("path")}/x`, input: mk("args") } } },
    { method: "turn.event", params: { turn_id: "t1", event: { type: "tool_output", call: "c1", text: mk("stdout") } } },
    { method: "turn.event", params: { turn_id: "t1", event: { type: "tool_call_finished", call: "c1", status: "ok", duration_ms: 12, body: mk("result"), diff: { path: "/x", before: mk("before"), after: "y" } } } },
    { method: "turn.event", params: { turn_id: "t1", event: { type: "attention", id: "a1", kind: "egress", state: "approved", title: "Allow example.com", detail: mk("detail"), instance: mk("instance") } } },
    { method: "turn.event", params: { turn_id: "t1", event: { type: "artifact", id: "x1", kind: "markdown", title: "Notes", body: mk("artbody"), path: `/home/u/${mk("artpath")}` } } },
    { method: "turn.event", params: { turn_id: "t1", event: { type: "text_delta", message: "m1", revision: 0, text: "Here is the answer." } } },
    { method: "turn.event", params: { turn_id: "t1", event: { type: "turn_usage", usage: { input_tokens: 5, output_tokens: 7 } } } },
    { method: "turn.event", params: { turn_id: "t1", event: { type: "turn_error", code: "tool_failed", message: mk("errmsg") } } },
    { method: "turn.event", params: { turn_id: "t1", event: { type: "brand_new_kind", text: mk("unknown") } } },
    { method: "chat.secret", params: { token: mk("unknownmethod") } },
    { method: "chat.receipt", params: { id: "u1", state: "delivered", cookie: mk("cookie") } },
    { method: "turn.event", params: { turn_id: "t1", event: { type: "turn_finished", outcome: "completed" } } },
  ].map((e, i) => ({ seq: 7 + 4 * i, ...e }));
  const drafts = log.map(fmt.normalize).filter(Boolean);
  ok(drafts.length === 10 && drafts.every((d) => !fmt.canonical(d).includes("PLANTED")), `allowlist a: 10 of 15 entries kept, none carrying a planted value (${drafts.map((d) => d.k)})`);
  const { bodies } = fmt.segments(INST, 1, drafts);
  const loc = (await pa.conv("allow-e2e")).body.locator;
  const up = await pa.append(loc, bodies[0]);
  const seg = (await state(pa.hash)).segments.find((s) => s.locator === loc);
  const pt = await plaintextOf(A, pa.hash, keyOf(pa.hash, loc, seg.segment));
  ok(up.status === 200 && Object.values(marks).every((m) => !pt.includes(m)) && !pt.includes("thinking") && !pt.includes("brand_new_kind") && !pt.includes("usage"),
    "allowlist b/c: the stored segment, decrypted here, holds none of the planted values, no unknown kind");
  ok(pt.includes("sk-live-not-redacted (pasted)"), "allowlist d: a secret pasted in visible text is stored as written");
  ok(!pt.includes("/home/"), "allowlist: the unsafe summary (a local path) was left out, the call kept");
}

lap('S5a: no plai');
// ---- M2: the persisted stale mark (S6d-2): only existing streams, only committed positions, monotonic, on every device
{
  const loc = (await pa.conv("stale")).body.locator;
  await pa.append(loc, body(1, 4));
  await pa.append(loc, body(5, 4));
  const mark = async (b) => asJson(await site("/api/mirror/v1/stale", { method: "POST", headers: pa.h({ "content-type": "application/json" }), body: JSON.stringify(b) }));
  const streamsOf = async () => (await state(pa.hash)).streams.length;
  const n0 = await streamsOf();
  const none = await mark({ locator: loc, log_instance: "nosuchrun", from_n: 1, reason: "other_run" });
  ok(none.status === 404 && none.body.error === "missing" && (await streamsOf()) === n0, `stale: a stream that doesn't exist is missing, and no row is made (${none.status})`);
  let fakes = 0;
  for (let i = 0; i < 40; i++) if ((await mark({ locator: loc, log_instance: "fake" + i, from_n: 1, reason: "differs" })).status === 404) fakes++;
  ok(fakes === 40 && (await streamsOf()) === n0, `stale: 40 made-up instances can't grow the table (${fakes} refused, streams ${await streamsOf()} = ${n0})`);
  const zero = await mark({ locator: loc, log_instance: INST, from_n: 0, reason: "differs" });
  const past = await mark({ locator: loc, log_instance: INST, from_n: 9, reason: "differs" }); // (next_n is 9: nothing committed there)
  const bad = await mark({ locator: loc, log_instance: INST, from_n: 2, reason: "because" });
  const extra = await mark({ locator: loc, log_instance: INST, from_n: 2, reason: "differs", text: "no bodies" });
  ok(zero.status === 400 && past.status === 400 && past.body.error === "invalid" && bad.status === 400 && extra.status === 400, `stale: position 0, a position not committed, an unknown reason, an extra field are refused (${zero.status} ${past.status} ${bad.status} ${extra.status})`);
  const m1 = await mark({ locator: loc, log_instance: INST, from_n: 6, reason: "differs" });
  ok(m1.status === 200 && JSON.stringify(m1.body) === JSON.stringify({ stale_from: 6, stale_reason: "differs" }), `stale: marked from 6, the answer only position and reason (${JSON.stringify(m1.body)})`);
  const m2 = await mark({ locator: loc, log_instance: INST, from_n: 3, reason: "other_run" });
  ok(m2.body.stale_from === 3 && m2.body.stale_reason === "other_run", "stale: an earlier position moves the reason with it");
  const m3 = await mark({ locator: loc, log_instance: INST, from_n: 5, reason: "conflict" });
  const m4 = await mark({ locator: loc, log_instance: INST, from_n: 3, reason: "differs" });
  ok(m3.body.stale_from === 3 && m3.body.stale_reason === "other_run" && m4.body.stale_from === 3 && m4.body.stale_reason === "other_run", "stale: a later or equal position changes neither (never raised, never cleared)");
  // (another device of the account sees it, in the list and on every read answer)
  const other = await page(A);
  const lst = (await other.list()).body.conversations.find((c) => c.locator === loc).streams.find((x) => x.log_instance === INST);
  const r1 = await other.read(loc, INST, 0), r2 = await other.read(loc, INST, 8);
  ok(lst.stale_from === 3 && lst.stale_reason === "other_run" && r1.body.stale_from === 3 && r1.body.entries?.length === 4 && r2.body.end === true && r2.body.stale_from === 3, "stale: a second device's list and reads carry the mark");
  const row = (await state(pa.hash)).streams.find((x) => x.locator === loc);
  ok(Object.keys(row).sort().join(",") === "last_digest,last_seq,locator,log_instance,next_n,stale_from,stale_reason", `stale: the stored mark is a position and a reason, no body or digest of it (${Object.keys(row)})`);
  ok((await site("/api/mirror/v1/audit", { method: "POST", headers: pa.h({ "content-type": "application/json" }), body: "{}" })).status === 404, "stale: the old audit route is gone");
  // (gone with the stream: deleting the conversation removes the mark)
  ok((await pa.del(loc)).status === 200 && !(await state(pa.hash)).streams.some((x) => x.locator === loc), "stale: deleting the conversation removes its streams and their marks");
  // (status says how many deletions are pending: the page's "Deleting mirrored history…")
  const st = await pa.status();
  ok(Number.isSafeInteger(st.body.pending) && st.body.pending >= 0, `status: pending deletions (${st.body.pending})`);
}

// ---- S5a: no plaintext DEK anywhere: the objects' tables, the logs, the answers
{
  const scanned = [];
  for (const p of [pa, pb, pd]) {
    const st = await state(p.hash);
    const raw = await dekOf(p.account, st.wraps[0], { 1: KEK1, 2: KEK2 }[st.wraps[0].kek]);
    const forms = [raw.toString("hex"), raw.toString("base64"), raw.toString("base64url"), raw.toString("latin1")];
    const hay = JSON.stringify(st) + JSON.stringify((await (await site("/__logs")).json()).logs) + JSON.stringify((await pa.status()).body) + JSON.stringify((await pa.list()).body);
    scanned.push(forms.every((f) => !hay.includes(f)));
  }
  ok(scanned.every(Boolean), "S5a: no plaintext DEK (hex, base64, raw) in any object's storage, log line or answer");
  const logs = (await (await site("/__logs")).json()).logs.join("\n");
  ok(!logs.includes("message 1") && !logs.includes("PLANTED") && !logs.includes("secret plaintext"), "no body in any log line");
}

// ---- a database without migration 0016 (production's until it is applied): sharing, core's and this directory's,
// uploads and purges as before, reading no budget_claims; the mirror stays inert even with BUDGET_CLAIMS "on"
{
  const mf0 = new Miniflare(convertV4MiniflareOptions({
    workers: [{ name: "mirror0", modules: true, script, compatibilityDate: "2026-10-01", d1Databases: ["SHARE_DB"], r2Buckets: ["SHARE_BUCKET", "MIRROR_BUCKET"], bindings,
      durableObjects: { MIRROR_ACCOUNT: { className: "TestMirrorAccount", useSQLite: true } } }],
  }));
  const db0 = await mf0.getD1Database("SHARE_DB");
  for (const { path: m, name } of migrations()) {
    if (name.startsWith("0016")) continue;
    for (const s of readFileSync(m, "utf8").replace(/--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean)) await db0.prepare(s).run();
  }
  ok(!(await db0.prepare("SELECT 1 AS x FROM sqlite_master WHERE name = 'budget_claims'").first()), "(no budget_claims in this database)");
  const at0 = (path, init = {}) => dispatch(mf0, SITE + path, { redirect: "manual", ...init });
  for (const [who, hdr, acct] of [["this directory's", {}, A], ["core's", { "x-test-core": "1" }, B]]) {
    const r = await at0("/auth/dev", { method: "POST", headers: { origin: SITE, "content-type": "application/json", ...hdr }, body: JSON.stringify({ token: "dev-token", account_id: acct }) });
    const cookie = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).find((c) => c.startsWith("__Host-sb_session="));
    const blob = randomBytes(1500);
    const sha = createHash("sha256").update(blob).digest("hex");
    const put = await at0(`/api/share/blob/${sha}`, { method: "PUT", headers: { cookie, origin: SITE, "content-length": "1500", ...hdr }, body: blob });
    const me = await at0("/api/share/me", { headers: { cookie, origin: SITE, ...hdr } });
    ok(put.status === 200 && me.status === 200, `no 0016: ${who} sharing uploads (${put.status}) and reports usage (${me.status})`);
    const rid = "p0-" + randomBytes(4).toString("hex");
    await at0("/__bindpurge", { method: "POST", headers: hdr, body: JSON.stringify({ account: acct, rid, kind: "self" }) });
    let st;
    for (let i = 0; i < 5 && st?.status !== "done"; i++) {
      await at0("/__scheduled", { method: "POST", headers: hdr });
      st = await db0.prepare("SELECT status FROM purges WHERE request_id = ?1").bind(rid).first();
    }
    ok(st?.status === "done", `no 0016: ${who} purge runs to its end (${st?.status})`);
  }
  const r0 = await at0("/auth/dev", { method: "POST", headers: { origin: SITE, "content-type": "application/json" }, body: JSON.stringify({ token: "dev-token", account_id: D }) });
  const c0 = (r0.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).find((c) => c.startsWith("__Host-sb_session="));
  ok((await at0("/api/mirror/v1/status", { headers: { cookie: c0, origin: SITE } })).status === 404, "no 0016: the mirror is inert even with BUDGET_CLAIMS on (no table, no claim can be written)");
  await mf0.dispose();
}

console.log(`${count - failures}/${count} mirror tests passed`);
await mf.dispose();
process.exit(failures ? 1 : 0);
