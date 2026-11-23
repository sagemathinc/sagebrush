// ci: web-sync.1 order=23
// Tests for the fleet Worker (web/cloud/fleet/): the browser relay's control plane (relay r2.1 §3 and §5), in Miniflare
// with a real D1 (migrations/), the fleet service's state faked at FleetFacts (test-entry.ts), and the relay's side
// played with the same vendored core the relay runs (signControlRequest, verifyControlAnswer).
//
//   node web/cloud/fleet/test-fleet.mjs     (after `cd web/site && npm ci`: Miniflare comes from web/site's install)
// In CI it runs in web-sync.1 (its ci: header), from the repository's root.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { dispatch } from "../../miniflare-dispatch.mjs";
import { useCrypto } from "./vendor/fleet-core/core/crypto.mjs";
import { webCrypto } from "./vendor/fleet-core/core/webcrypto.mjs";
import { useSchemas } from "./vendor/fleet-core/core/schemas.mjs";
import { b64, idOfBytes, sha256b64, unb64 } from "./vendor/fleet-core/core/bytes.mjs";
import { keyFromSeed } from "./vendor/fleet-core/core/ed25519.mjs";
import { seal } from "./vendor/fleet-core/core/envelope.mjs";
import { requestBytes } from "./vendor/fleet-core/core/request.mjs";
import { COMMIT_ROUTE, commitBody, openTarget } from "./vendor/fleet-core/core/relay.mjs";
import {
  ADMIT_ROUTE, ANSWER_HEADER, AUTH_HEADER, EPOCHS_ROUTE, FEED_MAX, epochsTarget, signControlRequest, verifyControlAnswer,
} from "./vendor/fleet-core/core/control.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const siteDir = [join(process.cwd(), "web/site"), join(here, "../../site")].find((d) => existsSync(join(d, "node_modules/miniflare")));
if (!siteDir) throw new Error("no web/site install with Miniflare (cd web/site && npm ci)");
const require = createRequire(join(siteDir, "package.json"));
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");

const readJson = (f) => JSON.parse(readFileSync(join(here, "vendor/fleet-core", f), "utf8"));
useCrypto(webCrypto());
useSchemas((name) => readJson(`schema/${name}`));

let failures = 0;
let count = 0;
function ok(cond, what) {
  count++;
  if (!cond) {
    failures++;
    console.log("FAIL", what);
  }
}

// ---- the vendored core is sagebrush-agent's, byte for byte, at vendor.json's commit (CI checks the sha256s; a
// reviewer re-checks the bytes against a clone with vendor/sync.mjs verify)
{
  const v = readJson("vendor.json");
  ok(/^[0-9a-f]{40}$/.test(v.commit) && v.repository === "https://github.com/sagemathinc/sagebrush-agent", "vendor.json names a commit of sagebrush-agent");
  const walk = (d) => readdirSync(join(here, "vendor/fleet-core", d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
  const files = walk("").filter((f) => f !== "vendor.json").sort();
  ok(JSON.stringify(files) === JSON.stringify(Object.keys(v.files).sort()), `vendor.json lists exactly the vendored files: ${files.length}`);
  for (const [name, f] of Object.entries(v.files)) {
    const sha = createHash("sha256").update(readFileSync(join(here, "vendor/fleet-core", name))).digest("hex");
    ok(sha === f.sha256, `vendor/fleet-core/${name}: sha256 ${sha} is vendor.json's`);
  }
  ok(Object.keys(v.files).filter((n) => n.startsWith("core/")).length >= 18 && v.files["core/control.mjs"] && v.files["schema/fleet.schema.json"] && v.files.LICENSE, "the whole core, its schemas and the licence");
}

// ---- the Worker
const AUD = "https://dev.sagebrush.space";
const ORIGIN = "https://fleet-dev.sagebrush.space";
const KEY_BYTES = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 255);
const KEY = b64(KEY_BYTES);
const OTHER_KEY = new Uint8Array(32).fill(9);
const script = execFileSync("bun", ["build", join(here, "test-entry.ts"), "--format", "esm", "--target", "browser"], { encoding: "utf8" });

// (the runtime's own output, whatever it writes: checked with the Worker's log lines for canaries)
const runtime = [];
const capture = (stream) => stream.on("data", (b) => runtime.push(...b.toString().split("\n").filter(Boolean)));
function worker(bindings = {}) {
  return new Miniflare(convertV4MiniflareOptions({
    workers: [{
      name: "fleet",
      modules: true,
      script,
      compatibilityDate: "2026-10-01",
      d1Databases: ["FLEET_RELAY_DB"],
      // (a binding given as undefined is left out: the Worker without it)
      bindings: Object.fromEntries(Object.entries({ FLEET_RELAY_OPEN: "1", FLEET_AUD: AUD, RELAY_CONTROL_KEY: KEY, ...bindings }).filter(([, v]) => v !== undefined)),
    }],
    handleRuntimeStdio(stdout, stderr) {
      capture(stdout);
      capture(stderr);
    },
  }));
}
async function migrate(mf) {
  const db = await mf.getD1Database("FLEET_RELAY_DB");
  for (const m of readdirSync(join(here, "migrations")).filter((f) => f.endsWith(".sql")).sort())
    for (const s of readFileSync(join(here, "migrations", m), "utf8").replace(/--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean)) await db.prepare(s).run();
  return db;
}
const mf = worker();
const db = await migrate(mf);
const logs = [];
const drainLogs = async (m = mf) => logs.push(...(await (await dispatch(m, `${ORIGIN}/__test/logs`)).json()));
const t = (path, m = mf) => dispatch(m, `${ORIGIN}${path}`, { method: "POST" });

const id22 = () => b64(crypto.getRandomValues(new Uint8Array(16)));
const newId = () => idOfBytes(crypto.getRandomValues(new Uint8Array(16)));
const enc = (s) => new TextEncoder().encode(s);
const canon = (v) => enc(JSON.stringify(sortKeys(v)));
const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);

/** One control call as the relay makes it; returns { status, header, body, call }. */
async function control(method, target, body = new Uint8Array(0), { key = KEY_BYTES, ts = Date.now(), id = id22(), headers = {}, m = mf, sendBody } = {}) {
  const header = await signControlRequest({ key, method, target, body, ts, id });
  const init = { method, headers: { [AUTH_HEADER]: header, ...headers } };
  if (method === "POST") {
    init.body = sendBody ?? body;
    if (!(sendBody instanceof ReadableStream)) init.headers["content-length"] ??= String((sendBody ?? body).length);
    else init.duplex = "half";
  }
  const r = await dispatch(m, `${ORIGIN}${target}`, init);
  return { status: r.status, header: r.headers.get(ANSWER_HEADER), body: new Uint8Array(await r.arrayBuffer()), call: { id, digest: await sha256b64(body) }, init, target };
}
/** The relay's check of an answer to its call. */
const answer = (r, kind) => verifyControlAnswer({ header: r.header, status: r.status, body: r.body }, { key: KEY_BYTES, call: r.call, answer: kind });
const admit = async (req, opts) => {
  const r = await control("POST", ADMIT_ROUTE, canon(req), opts);
  if (r.status !== 200) return { status: r.status, header: r.header };
  return answer(r, "admit");
};
const feed = async (since, opts) => {
  const r = await control("GET", epochsTarget(since), undefined, opts);
  if (r.status !== 200) return { status: r.status, header: r.header };
  return answer(r, "epochs");
};

// ---- a fleet: a native device's chain, two hosts, an agent granted the browser on host A, an account session
const seed = (n) => new Uint8Array(32).fill(n);
const N = await keyFromSeed(seed(1)), REC = await keyFromSeed(seed(2)), HA = await keyFromSeed(seed(3)), HB = await keyFromSeed(seed(4)), STRANGER = await keyFromSeed(seed(5));
const fleet = newId(), hostA = newId(), hostB = newId(), agent = newId(), device = newId();
const signer = { kind: "device", id: device, alg: "ed25519", key: N.key };
const genesis = await seal("sb.device-chain.v1", signer, { fleet, aud: AUD, seq: 0, prev: "", op: "genesis", at_ms: 1, auth_time_ms: 1,
  device: { id: device, alg: "ed25519", key: b64(N.raw), name: "mac", tier: "native" }, recovery_key: { alg: "ed25519", key: b64(REC.raw) } }, N);
const COOKIE = "canary-cookie-" + "c".repeat(30);
const FACTS = {
  fleet, account: "acct-1", aud: AUD, genesis: b64(genesis),
  hosts: [{ id: hostA, signKey: b64(HA.raw), gen: 3, revoked: false }, { id: hostB, signKey: b64(HB.raw), gen: 1, revoked: false }],
  agent: { id: agent, host: hostA, browser: true, revoked: false, notAfterMs: Date.now() + 3_600_000 },
  sessions: { [COOKIE]: { account: "acct-1", session: "sess-1", expiresMs: Date.now() + 7_200_000 }, "other-account": { account: "acct-2", session: "sess-2", expiresMs: Date.now() + 7_200_000 },
    expired: { account: "acct-1", session: "sess-3", expiresMs: Date.now() - 1 } },
};
const setFacts = (f) => dispatch(mf, `${ORIGIN}/__test/facts`, { method: "POST", body: JSON.stringify(f) });
const facts = (patch = {}) => setFacts({ ...FACTS, ...patch });
await facts();

async function hostSig(target, { key = HA, host = hostA, gen = 3, ts = Date.now(), method = "GET", body = new Uint8Array(0), agentField = "-" } = {}) {
  const f = { host, agent: agentField, cap: "-", gen: String(gen), ts: String(ts), nonce: id22(), idem: "-", op: "-" };
  const sig = await key.sign(requestBytes(AUD, method, target, await sha256b64(body), f));
  return { header: `v1 host=${f.host}; agent=${f.agent}; cap=-; gen=${f.gen}; ts=${f.ts}; nonce=${f.nonce}; idem=-; op=-; sig=${b64(sig)}`, nonce: f.nonce };
}
const session = newId();
const fields = (role, extra = {}) => ({ role, fleet, session, agent, browser_gen: 2, host_gen: 3, resume_n: 0, ...extra });
async function record(extra = {}) {
  const now = Date.now();
  return seal("sb.browser-session.v1", signer, { fleet, aud: AUD, at_ms: now - 1000, not_before_ms: now - 1000, not_after_ms: now + 1_800_000, session, host: hostA, agent,
    browser_gen: 2, host_gen: 3, chain_seq: 0, app_session_pub: b64(new Uint8Array(32).fill(9)), account_origins_manifest_sha256: b64(new Uint8Array(32).fill(1)),
    exceptions_sha256: b64(new Uint8Array(32).fill(2)), ...extra }, N);
}
const hostReq = async (o = {}, target = openTarget(fields("host"))) => { const s = await hostSig(target, o); return { req: { v: 1, kind: "host", target, sig: s.header }, nonce: s.nonce }; };
const appReq = async (extra = {}, target = openTarget(fields("app")), cookie = COOKIE) => ({ v: 1, kind: "app", target, record: b64(await record(extra)), request: id22(), cookie });
async function commitReq(o = {}, c = {}) {
  const body = commitBody({ fleet, session, agent, browser_gen: 2, resume_n: 0, host_nonce: id22(), app_request: id22(), ...c });
  const s = await hostSig(COMMIT_ROUTE, { method: "POST", body, ...o });
  return { v: 1, kind: "commit", target: COMMIT_ROUTE, sig: s.header, body: b64(body) };
}

// ---- 1 the control plane: the switch and the key, the two calls only, the body, the MAC, the call id once
{
  const closed = worker({ FLEET_RELAY_OPEN: "0" });
  await migrate(closed);
  ok((await control("GET", epochsTarget(0), undefined, { m: closed })).status === 503, "the kill switch closed: 503");
  for (const [why, key] of [["no key", undefined], ["a short key", KEY.slice(0, 42)], ["an all-zero key", b64(new Uint8Array(32))]]) {
    const m = worker({ RELAY_CONTROL_KEY: key });
    await migrate(m);
    const r = await control("GET", epochsTarget(0), undefined, { m });
    ok(r.status === 503 && r.header === null, `${why}: 503, unsigned`);
    await m.dispose();
  }
  await closed.dispose();
  ok((await control("GET", "/api/fleet/v1/relay/other")).status === 404, "another path under the relay's prefix: 404");
  ok((await control("GET", ADMIT_ROUTE)).status === 405, "GET admit: 405");
  ok((await control("POST", epochsTarget(0), enc("{}"))).status === 405, "POST epochs: 405");
  ok((await control("POST", `${ADMIT_ROUTE}?x=1`, enc("{}"))).status === 404, "admit with a query: 404");
  for (const bad of [`${EPOCHS_ROUTE}?since=01`, `${EPOCHS_ROUTE}?since=1&x=2`, `${EPOCHS_ROUTE}?cursor=1`, EPOCHS_ROUTE])
    ok((await control("GET", bad)).status === 404, `the epochs target ${bad.slice(EPOCHS_ROUTE.length) || "(none)"}: 404`);
  ok((await dispatch(mf, `${ORIGIN}/`)).status === 404, "any other path: 404");

  const big = new Uint8Array(128 * 1024 + 1).fill(32);
  ok((await control("POST", ADMIT_ROUTE, big)).status === 413, "a body over 128 KiB: 413");
  // (a declared length over the cap is refused before any byte is read: a body that never ends gets 413 at once)
  const stalled = new ReadableStream({ start(c) { c.enqueue(enc("{")); } });
  const t0 = Date.now();
  const over = await control("POST", ADMIT_ROUTE, enc("{}"), { sendBody: stalled, headers: { "content-length": String(128 * 1024 + 1) } });
  ok(over.status === 413 && Date.now() - t0 < 3000, `a declared length over 128 KiB: 413 before reading (${over.status}, ${Date.now() - t0} ms)`);
  const stream = new ReadableStream({ start(c) { c.enqueue(enc("{}")); c.close(); } });
  ok((await control("POST", ADMIT_ROUTE, enc("{}"), { sendBody: stream })).status === 411, "no Content-Length: 411");

  const r = await control("GET", epochsTarget(0), undefined, { key: OTHER_KEY });
  ok(r.status === 401 && r.header === null && r.body.length === 0, "another key: 401, unsigned, no body");
  ok((await control("GET", epochsTarget(0), undefined, { ts: Date.now() - 61_000 })).status === 401, "a timestamp 61 s behind: 401");
  ok((await control("GET", epochsTarget(0), undefined, { ts: Date.now() + 61_000 })).status === 401, "a timestamp 61 s ahead: 401");
  ok((await control("GET", epochsTarget(0), undefined, { ts: Date.now() - 50_000 })).status === 200, "a timestamp 50 s behind: answered");
  // (signed for one target, sent to another; signed for one body, sent with another)
  const header = await signControlRequest({ key: KEY_BYTES, method: "GET", target: epochsTarget(1), ts: Date.now(), id: id22() });
  ok((await dispatch(mf, `${ORIGIN}${epochsTarget(2)}`, { headers: { [AUTH_HEADER]: header } })).status === 401, "a MAC for another target: 401");
  const h2 = await signControlRequest({ key: KEY_BYTES, method: "POST", target: ADMIT_ROUTE, body: enc('{"a":1}'), ts: Date.now(), id: id22() });
  ok((await dispatch(mf, `${ORIGIN}${ADMIT_ROUTE}`, { method: "POST", headers: { [AUTH_HEADER]: h2, "content-length": "7" }, body: '{"a":2}' })).status === 401, "a MAC for another body: 401");
  ok((await dispatch(mf, `${ORIGIN}${epochsTarget(0)}`)).status === 401, "no auth header: 401");

  // the call id, consumed once: the same signed call again is 409 and unsigned, and so is a concurrent copy
  const once = await control("GET", epochsTarget(0));
  ok(once.status === 200 && once.header !== null, "a call: answered and signed");
  const again = await dispatch(mf, `${ORIGIN}${epochsTarget(0)}`, once.init);
  ok(again.status === 409 && again.headers.get(ANSWER_HEADER) === null, "the same call replayed: 409, unsigned");
  const twin = await signControlRequest({ key: KEY_BYTES, method: "GET", target: epochsTarget(0), ts: Date.now(), id: id22() });
  const both = await Promise.all([0, 1, 2, 3].map(() => dispatch(mf, `${ORIGIN}${epochsTarget(0)}`, { headers: { [AUTH_HEADER]: twin } })));
  ok(both.filter((x) => x.status === 200).length === 1 && both.filter((x) => x.status === 409).length === 3, `four concurrent copies of one call: exactly one answered (${both.map((x) => x.status)})`);
  const adm = await hostReq();
  const first = await control("POST", ADMIT_ROUTE, canon(adm.req));
  const replay = await dispatch(mf, `${ORIGIN}${ADMIT_ROUTE}`, { ...first.init, body: canon(adm.req) });
  ok(first.status === 200 && replay.status === 409, "an admit call replayed: 409");
  ok((await db.prepare("SELECT COUNT(*) AS n FROM relay_calls").first()).n >= 4, "the consumed ids are in D1");

  // the answer is the call's: the relay refuses it for another call, and as the other endpoint's
  const a = await control("GET", epochsTarget(0));
  ok((await answer(a, "epochs")).result === "ok", "the relay verifies the answer");
  let refusedOther = false;
  try { await verifyControlAnswer({ header: a.header, status: a.status, body: a.body }, { key: KEY_BYTES, call: { ...a.call, id: id22() }, answer: "epochs" }); } catch { refusedOther = true; }
  ok(refusedOther, "the same answer, for another call: refused by the relay");
}

// ---- 2 admit: host opens
{
  const h = await hostReq();
  const v = await admit(h.req);
  ok(v.result === "ok" && v.role === "host" && v.host === hostA && v.agent === agent && v.fleet === fleet && v.session === session && v.browser_gen === 2 && v.host_gen === 3
    && v.resume_n === 0 && v.nonce === h.nonce && v.account === "acct-1" && v.not_after_ms === FACTS.agent.notAfterMs, "a host open: ok, with its verified facts");
  ok(JSON.stringify(v.epochs) === JSON.stringify({ account: 0, agent: 0, host: 0 }), "its epochs");
  // (the Worker consumes nothing of the relay's: the same open, in a new call, is admitted again)
  ok((await admit(h.req)).result === "ok", "the same host open in a new call: ok again (the relay consumes its nonce)");
  const code = async (req) => { const r = await admit(req); return r.result === "refused" ? r.code : r.result ?? r.status; };
  ok(await code((await hostReq({ key: STRANGER })).req) === "bad_signature", "signed by another key: bad_signature");
  ok(await code((await hostReq({ key: HB, host: hostB, gen: 1 }, openTarget(fields("host", { host_gen: 1 })))).req) === "not_granted", "signed by a host the agent isn't on: not_granted");
  ok(await code((await hostReq({ host: newId() })).req) === "unknown_host", "an unknown host: unknown_host");
  ok(await code((await hostReq({ gen: 2 })).req) === "stale_generation", "a stale gen: stale_generation");
  ok(await code((await hostReq({ ts: Date.now() - 400_000 })).req) === "clock_skew", "a signature 400 s old: clock_skew");
  ok(await code({ ...(await hostReq()).req, target: openTarget(fields("app")) }) === "bad_form", "an app target: bad_form");
  ok(await code((await hostReq({}, openTarget(fields("host", { fleet: newId() })))).req) === "not_granted", "another fleet: not_granted");
  await facts({ hosts: [{ ...FACTS.hosts[0], revoked: true }, FACTS.hosts[1]] });
  ok(await code((await hostReq()).req) === "host_revoked", "a revoked host: host_revoked");
  await facts({ agent: { ...FACTS.agent, revoked: true } });
  ok(await code((await hostReq()).req) === "agent_revoked", "a revoked agent: agent_revoked");
  await facts({ agent: { ...FACTS.agent, browser: false } });
  ok(await code((await hostReq()).req) === "not_granted", "a grant without the browser: not_granted");
  await facts({ agent: { ...FACTS.agent, notAfterMs: Date.now() - 1 } });
  ok(await code((await hostReq()).req) === "grant_expired", "an ended grant: grant_expired");
  await facts({ agent: { ...FACTS.agent, notAfterMs: null } });
  ok((await admit((await hostReq()).req)).not_after_ms === null, "a grant without an end: not_after_ms null");
  await facts({ agent: null });
  ok(await code((await hostReq()).req) === "not_granted", "an agent the fleet doesn't have: not_granted");
  await setFacts(null);
  ok(await code((await hostReq()).req) === "not_granted", "no fleet state (NO_FACTS, as DEV runs today): not_granted");
  await facts();
}

// ---- 3 admit: app opens
{
  const req = await appReq();
  const v = await admit(req);
  ok(v.result === "ok" && v.role === "app" && v.host === hostA && v.request === req.request && v.account === "acct-1" && v.account_session === "sess-1"
    && v.account_session_expires_ms === FACTS.sessions[COOKIE].expiresMs && v.signer === device && v.chain_seq === 0 && v.session === session && v.browser_gen === 2,
    "an app open: ok, with its verified facts");
  ok((await admit(req)).result === "ok", "the same app open in a new call: ok again (the relay consumes its request id)");
  const code = async (r) => { const a = await admit(r); return a.result === "refused" ? a.code : a.result ?? a.status; };
  ok(await code(await appReq({}, undefined, "nobody")) === "not_granted", "a cookie with no session: not_granted");
  ok(await code(await appReq({}, undefined, "expired")) === "not_granted", "an expired session: not_granted");
  ok(await code(await appReq({}, undefined, "other-account")) === "not_granted", "another account's session: not_granted");
  ok(await code(await appReq({ session: newId() })) === "bad_form", "a record for another session: bad_form");
  ok(await code(await appReq({ not_after_ms: Date.now() - 1, not_before_ms: Date.now() - 2000, at_ms: Date.now() - 2000 })) === "grant_expired", "a record past its window: grant_expired");
  const tampered = await appReq();
  const raw = unb64(tampered.record); raw[raw.length - 5] ^= 1;
  ok(["bad_form", "bad_signature"].includes(await code({ ...tampered, record: b64(raw) })), "a tampered record: refused");
  await facts({ hosts: [{ ...FACTS.hosts[0], gen: 4 }, FACTS.hosts[1]] });
  ok(await code(await appReq()) === "stale_generation", "the host moved to gen 4: stale_generation");
  await facts({ hosts: [{ ...FACTS.hosts[0], revoked: true }, FACTS.hosts[1]] });
  ok(await code(await appReq()) === "host_revoked", "the record's host revoked: host_revoked");
  await facts({ agent: { ...FACTS.agent, host: hostB } });
  ok(await code(await appReq()) === "not_granted", "the agent now on another host: not_granted");
  await facts({ agent: { ...FACTS.agent, revoked: true } });
  ok(await code(await appReq()) === "agent_revoked", "a revoked agent: agent_revoked");
  await facts();
}

// ---- 4 admit: commits (the broker's replacement authorization)
{
  const req = await commitReq();
  const c = JSON.parse(new TextDecoder().decode(unb64(req.body)));
  const v = await admit(req);
  ok(v.result === "ok" && v.role === "commit" && v.host === hostA && v.host_gen === 3 && v.host_nonce === c.host_nonce && v.app_request === c.app_request
    && v.nonce === req.sig.match(/nonce=([^;]+)/)[1] && v.session === session && v.account === "acct-1", "a commit: ok, with what it names and its own nonce");
  ok((await admit(req)).result === "ok", "the same commit in a new call: ok again (the relay consumes it)");
  const code = async (r) => { const a = await admit(r); return a.result === "refused" ? a.code : a.result ?? a.status; };
  ok(await code(await commitReq({ key: HB, host: hostB, gen: 1 })) === "not_granted", "signed by a host the agent isn't on: not_granted");
  ok(await code(await commitReq({ key: STRANGER })) === "bad_signature", "signed by another key: bad_signature");
  ok(await code({ ...req, body: b64(commitBody({ ...c, resume_n: 1 })) }) === "bad_signature", "another body than signed: bad_signature");
  ok(await code({ ...req, body: b64(enc("null")) }) === "bad_form", "a body that isn't an authorization: bad_form");
  await facts({ agent: { ...FACTS.agent, revoked: true } });
  ok(await code(await commitReq()) === "agent_revoked", "a revoked agent: agent_revoked");
  // (host_gen is the signature's, checked against the host's current gen)
  await facts({ hosts: [{ ...FACTS.hosts[0], gen: 5 }, FACTS.hosts[1]] });
  ok((await admit(await commitReq({ gen: 5 }))).host_gen === 5, "a commit signed at gen 5, the host's current: host_gen 5");
  await facts();
}

// ---- 5 admit: the epochs, and the late-answer read order
{
  const before = (await admit((await hostReq()).req)).epochs;
  for (const [kind, id] of [["agent", agent], ["account", "acct-1"], ["host", hostA]]) await t(`/__test/bump?kind=${kind}&id=${encodeURIComponent(id)}`);
  const after = (await admit((await hostReq()).req)).epochs;
  ok(after.agent === before.agent + 1 && after.account === before.account + 1 && after.host === before.host + 1, "each recorded change raises that epoch in the next answer");
  // (the facts read twice around the epochs: if they name another owner the second time, nothing is admitted)
  await t("/__test/facts-mode?m=flip");
  ok((await admit((await hostReq()).req)).code === "not_granted", "the facts changed between the reads: not_granted");
  await t("/__test/facts-mode?m=throw");
  const failed = await admit((await hostReq()).req);
  ok(failed.status === 503 && failed.header === null, "the fleet state unavailable: 503, unsigned");
  await t("/__test/facts-mode?m=odd");
  const odd = await admit((await hostReq()).req);
  ok(odd.status === 503 && odd.header === null, "a fleet error no refusal names: 503, unsigned");
  await t("/__test/facts-mode?m=ok");
  ok((await admit({ v: 1, kind: "host", target: "/x", sig: "v1 x", extra: 1 })).code === "bad_form", "an admit request outside its schema: a signed bad_form");
}

// ---- 6 the feed: a cursor on every answer, the changes since, each identity once, pages, expiry
{
  const start = await feed(0);
  ok(start.result === "ok" && start.since === 0 && start.cursor > 0 && start.agents.length + start.accounts.length + start.hosts.length === 0 && start.more === false, "since=0: from now, no changes");
  const quiet = await feed(start.cursor);
  ok(quiet.result === "ok" && quiet.cursor > start.cursor && quiet.agents.length === 0, "a quiet feed: an empty answer whose cursor still advances");
  const quiet2 = await feed(quiet.cursor);
  ok(quiet2.cursor > quiet.cursor, "and again");
  const a2 = newId();
  await t(`/__test/bump?kind=agent&id=${a2}`);
  await t(`/__test/bump?kind=agent&id=${a2}`);
  await t(`/__test/bump?kind=account&id=acct-9`);
  await t(`/__test/bump?kind=host&id=${hostB}`);
  const changed = await feed(quiet2.cursor);
  ok(changed.agents.length === 1 && changed.agents[0].id === a2 && changed.agents[0].epoch === 2, "an agent changed twice: listed once, at its latest epoch");
  ok(changed.accounts.length === 1 && changed.accounts[0].id === "acct-9" && changed.hosts.length === 1 && changed.hosts[0].id === hostB, "the account and the host");
  ok(changed.cursor > quiet2.cursor && changed.more === false, "its cursor ahead");
  const after = await feed(changed.cursor);
  ok(after.agents.length === 0 && after.accounts.length === 0 && after.hosts.length === 0, "the next answer: nothing again");
  // (the feed's refusal: a cursor this Worker never gave)
  const ahead = await feed(after.cursor + 1000);
  ok(ahead.result === "refused" && ahead.code === "cursor_expired" && ahead.since === after.cursor + 1000 && !("cursor" in ahead), "a cursor ahead of the sequence: cursor_expired, with no cursor");
  // (pages: 200 agents change; each answer at most 80 a list, cursors strictly ahead, every agent seen exactly once)
  const ids = Array.from({ length: 200 }, () => newId());
  for (const id of ids) await t(`/__test/bump?kind=agent&id=${id}`);
  const seen = new Map();
  let cur = after.cursor, pages = 0, more = true, last = cur;
  while (more && pages < 10) {
    const p = await feed(cur);
    ok(p.result === "ok" && p.cursor > cur && p.agents.length <= FEED_MAX, `page ${pages}: cursor ahead, at most ${FEED_MAX}`);
    for (const e of p.agents) seen.set(e.id, (seen.get(e.id) ?? 0) + 1);
    more = p.more; last = cur; cur = p.cursor; pages++;
  }
  ok(pages === 3 && ids.every((id) => seen.get(id) === 1) && seen.size === 200, `200 changes in ${pages} pages, each agent exactly once`);
  // (by bytes: 80 accounts with 128-character ids, and 80 each of agents and hosts, pass the counts but not 16 KiB)
  const base = (await feed(cur)).cursor;
  for (let i = 0; i < FEED_MAX; i++) {
    await t(`/__test/bump?kind=account&id=${String(i).padStart(128, "a")}`);
    await t(`/__test/bump?kind=agent&id=${newId()}`);
    await t(`/__test/bump?kind=host&id=${newId()}`);
  }
  const r = await control("GET", epochsTarget(base));
  const big = await answer(r, "epochs");
  ok(big.more === true && r.body.length <= 16 * 1024, `a page cut by bytes: more, ${r.body.length} bytes`);
  let total = big.agents.length + big.accounts.length + big.hosts.length, c2 = big.cursor;
  for (let i = 0; i < 5 && total < 3 * FEED_MAX; i++) { const p = await feed(c2); total += p.agents.length + p.accounts.length + p.hosts.length; c2 = p.cursor; }
  ok(total === 3 * FEED_MAX, `every change delivered across the pages: ${total}`);
  // (retention: after the cleanup at 25 hours, a cursor from before it is cursor_expired; a fresh one isn't)
  await t(`/__test/clean?offset=${25 * 3_600_000}`);
  const old = await feed(start.cursor);
  ok(old.result === "refused" && old.code === "cursor_expired", "a cursor older than the 24 h retention: cursor_expired");
  const fresh = await feed(0);
  ok(fresh.result === "ok" && (await feed(fresh.cursor)).result === "ok", "since=0 again, then on from it");
}

// ---- 7 the cron's cleanup of consumed call ids
{
  await db.prepare("INSERT INTO relay_calls (id, until_ms) VALUES ('old-call', ?1)").bind(Date.now() - 1).run();
  await t("/__test/clean?offset=0");
  ok((await db.prepare("SELECT COUNT(*) AS n FROM relay_calls WHERE id = 'old-call'").first()).n === 0, "a call id past its 10 minutes is removed");
  ok((await db.prepare("SELECT COUNT(*) AS n FROM relay_calls").first()).n > 0, "the others stay");
}

// ---- 8 logs: fixed codes only, never a cookie, record, signature, nonce, id or the key
{
  const h = await hostReq();
  const app = await appReq();
  const commit = await commitReq();
  await admit(h.req);
  await admit(app);
  await admit(commit);
  await control("GET", epochsTarget(0), undefined, { key: OTHER_KEY });
  await drainLogs();
  const text = [...logs, ...runtime].join("\n");
  const canaries = [COOKIE, app.record.slice(0, 40), app.request, h.nonce, h.req.sig.slice(-40), commit.sig.slice(-40), KEY, "acct-1", "sess-1", session, agent, hostA];
  ok(logs.length > 20, `logs were captured: ${logs.length} lines (and ${runtime.length} from the runtime's own output)`);
  for (const c of canaries) ok(!text.includes(c), `no log line carries ${c.slice(0, 12)}…`);
  ok(logs.every((l) => { try { const o = JSON.parse(l); return typeof o.code === "string" && Object.keys(o).every((k) => ["code", "route", "ms", "error"].includes(k)); } catch { return false; } }), "every line is {code, route, ms} (or an internal error's code)");
}

await mf.dispose();
console.log(`${count - failures}/${count} passed`);
if (failures) process.exit(1);
