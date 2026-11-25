// ci: web-sync.1 order=13
// Tests for the fleet Worker (web/cloud/fleet/): the execution-lease endpoint mounted over a real D1 (FLEET_DB) in
// Miniflare, the five-statement batch through D1's own transaction, and every lease checked by the host's verifier. The
// first-lease gate's NULL traps are run against SQLite tables WITHOUT the migration's constraints (node:sqlite), since
// the migration itself refuses the NULLs they need. store.ts is bundled with bun (as the Worker is) to test its units.
//   node web/cloud/fleet/test-fleet.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dispatch } from "../../miniflare-dispatch.mjs";
import * as fleetMirror from "../../workspace/fleet/core/index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "../../site/package.json"));
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");

let failures = 0, count = 0;
const ok = (c, what, detail) => { count++; if (!c) { failures++; console.log("FAIL", what, detail === undefined ? "" : JSON.stringify(detail).slice(0, 400)); } };
// (the mirrored core, with WebCrypto and its bundled schemas, as fleet/install.ts installs them for the Worker)
const core = fleetMirror;
core.useCrypto(core.webCrypto());
const SCHEMAS = { "fleet.schema.json": JSON.parse(readFileSync(join(here, "../../workspace/fleet/fleet.schema.json"), "utf8")), "reasons.json": JSON.parse(readFileSync(join(here, "../../workspace/fleet/reasons.json"), "utf8")) };
core.useSchemas((n) => SCHEMAS[n]);
// (store.ts's units, bundled as the Worker bundles them)
const tmp = mkdtempSync(join(tmpdir(), "fleet-store-"));
writeFileSync(join(tmp, "store.mjs"), execFileSync("bun", ["build", join(here, "store.ts"), "--format", "esm", "--target", "node"], { encoding: "utf8" }));
const { DECISIONS, GATE_MARGIN_MS, GATE_OPEN_SQL, ISSUE_SQL, issueLease, readDecision, bucket } = await import(pathToFileURL(join(tmp, "store.mjs")).href);
rmSync(tmp, { recursive: true, force: true });
const AUD = "https://dev.sagebrush.space";
const SITE = "https://fleet.test";
const BOOT = "0f6c2b5e-8d3a-4c1e-9b7f-2a4d6e8f0a1c";
const MIGRATION = readFileSync(join(here, "migrations/0001_fleet_leases.sql"), "utf8");
const TTL = core.LEASE_TTL_MS, MARGIN = core.LEASE_GATE_MARGIN_MS;
let seedN = 1;
const key = () => core.keyFromSeed(new Uint8Array(32).fill(seedN++));

// ---- the fleet: a native device, its chain with a pinned lease key, two hosts, one agent bound to host A
const fleet = core.newId(), agent = core.newId(), hostA = core.newId(), hostB = core.newId(), nId = core.newId(), lId = core.newId();
const N = await key(), R = await key(), L = await key();
const sN = { kind: "device", id: nId, alg: "ed25519", key: N.key };
const entries = [];
let chain = null;
const push = async (op, extra) => {
  const body = { fleet, aud: AUD, seq: chain ? chain.seq + 1 : 0, prev: chain ? chain.head : "", op, at_ms: 1, auth_time_ms: 1, ...extra };
  const bytes = await core.seal("sb.device-chain.v1", sN, body, N);
  chain = (await core.applyChainEntry(chain, bytes, { aud: AUD, fleet })).state;
  entries.push(new TextDecoder().decode(bytes));
};
await push("genesis", { device: { id: nId, alg: "ed25519", key: core.b64(N.raw), name: "mac", tier: "native" }, recovery_key: { alg: "ed25519", key: core.b64(R.raw) } });
await push("lease-key", { lease_key: { id: lId, alg: "ed25519", key: core.b64(L.raw) } });
const hosts = {};
for (const h of [hostA, hostB]) {
  const H = await key();
  hosts[h] = { H, fingerprint: core.b64(await core.hostFingerprint(h, H.raw, new Uint8Array(32).fill(seedN++))) };
}

// ---- the Worker in Miniflare, with the migration applied
const script = execFileSync("bun", ["build", join(here, "test-entry.ts"), "--format", "esm", "--target", "browser"], { encoding: "utf8" });
const mf = new Miniflare(convertV4MiniflareOptions({
  workers: [{ name: "fleet", modules: true, script, compatibilityDate: "2026-10-01", d1Databases: ["FLEET_DB"],
    bindings: { FLEET_AUD: AUD, LEASE_KEY_ID: lId, LEASE_KEY_SEED: core.b64(new Uint8Array(32).fill(3)) } }],
}));
const db = await mf.getD1Database("FLEET_DB");
// (comments stripped first: a comment may hold a ";")
for (const stmt of MIGRATION.replace(/--[^\n]*/g, "").split(";").map((s) => s.trim()).filter(Boolean)) await db.prepare(stmt).run();
const exec = (sql, ...v) => db.prepare(sql).bind(...v).run();
const all = async (sql, ...v) => (await db.prepare(sql).bind(...v).all()).results;
const reset = async () => {
  for (const t of ["fleet_hosts", "fleet_agents", "fleet_chain_entries", "lease_pending", "lease_nonces", "lease_clock", "fleet_bucket_hits"]) await exec(`DELETE FROM ${t}`);
  for (const [i, e] of entries.entries()) await exec("INSERT INTO fleet_chain_entries (fleet, seq, bytes) VALUES (?1, ?2, ?3)", fleet, i, e);
  for (const h of [hostA, hostB]) await exec("INSERT INTO fleet_hosts (host, fleet, sign_key, fingerprint, revoked) VALUES (?1, ?2, ?3, ?4, 0)", h, fleet, core.b64(hosts[h].H.raw), hosts[h].fingerprint);
  await exec("INSERT INTO fleet_agents (agent, fleet, host, entry_gen, revoked) VALUES (?1, ?2, ?3, 3, 0)", agent, fleet, hostA);
};
// (the lease key's seed is fill(3): the third key made above is R's... so derive the Worker's from its own seed)
const LK = await core.keyFromSeed(new Uint8Array(32).fill(3));
if (core.b64(LK.raw) !== core.b64(L.raw)) {
  // pin the chain's lease key to the Worker's: rebuild the lease-key entry with LK
  entries.length = 1; chain = (await core.replayChain([core.enc(entries[0])], { aud: AUD, fleet }));
  await push("lease-key", { lease_key: { id: lId, alg: "ed25519", key: core.b64(LK.raw) } });
}

/** A host's request: its bytes and the outstanding entry it keeps (the hash computed the host's way). */
let nonceN = 0;
const request = async (h = hostA, extra = {}) => {
  const hs = { kind: "host", id: h, alg: "ed25519", key: hosts[h].H.key };
  const body = { fleet, aud: AUD, agent, host: h, gen: 3, nonce: core.b64(new Uint8Array(16).fill(++nonceN & 255).map((x, i) => (i === 0 ? nonceN >> 8 : x))), boot_id: BOOT, at_ms: Date.now(), ...extra };
  const bytes = await core.seal("sb.lease-request.v1", hs, body, hosts[h].H);
  return { bytes, body, outstanding: { request: await core.sha256b64(core.signedBytes("sb.lease-request.v1", hs, body)), agent, gen: body.gen, nonce: body.nonce, boot_id: BOOT } };
};
const send = (bytes, change) => dispatch(mf, SITE + "/api/fleet/v1/host/lease", { method: "POST", body: bytes,
  headers: { "cf-connecting-ip": "198.51.100.7", ...(change ? { "x-test-before-issue": change } : {}) } });
const errorOf = async (r) => { const t = await r.text(); try { return JSON.parse(t).error; } catch { return `status ${r.status} ${t.slice(0, 80)}`; } };
const hostAccepts = async (r, q, h = hostA) => {
  if (r.status !== 200) return `status ${r.status} ${await r.text()}`;
  try { await core.verifyExecutionLease(new Uint8Array(await r.arrayBuffer()), { aud: AUD, fleet, chain, host: h, hostKey: hosts[h].fingerprint, outstanding: q.outstanding }); return "ok"; }
  catch (e) { return e.code ?? String(e); }
};
const rows = async () => ({ nonces: (await all("SELECT COUNT(*) n FROM lease_nonces"))[0].n, clock: await all("SELECT agent, host, expires_at, gen FROM lease_clock ORDER BY host"), pending: (await all("SELECT COUNT(*) n FROM lease_pending"))[0].n });

// ---- F-0: the Worker reaches the fleet core only through its installer, from server.ts; nothing else here names it
{
  const { readdirSync } = await import("node:fs");
  const named = readdirSync(here).filter((f) => /\.(?:ts|mjs)$/.test(f) && !/^test-/.test(f))
    .filter((f) => /fleet\/(?:core|install)/.test(readFileSync(join(here, f), "utf8").replace(/\/\/[^\n]*/g, "")));
  ok(JSON.stringify(named) === '["server.ts"]', "F-0: only server.ts imports the fleet core, and only through fleet/install.ts", named);
  ok(/import \{ fleetCore \} from "\.\.\/\.\.\/workspace\/fleet\/install\.ts";/.test(readFileSync(join(here, "server.ts"), "utf8")) && !/fleet\/core/.test(readFileSync(join(here, "server.ts"), "utf8")), "F-0: server.ts's one core import is the installer");
}

// ---- F-1: a renewal, verified by the host; the clock is the decision's time + ttl
await reset();
{
  const q = await request(), before = Date.now();
  ok((await hostAccepts(await send(q.bytes), q)) === "ok", "F-1: a renewal through the real batch: the host's own verifier accepts the lease");
  const r = await rows();
  ok(r.nonces === 1 && r.clock.length === 1 && r.clock[0].expires_at >= before + TTL && r.clock[0].expires_at <= Date.now() + TTL, "F-1: one nonce spent, the grant clock at the issue time + ttl", r);
  // a copy of the same request: the ordinary replay, nothing else written
  ok((await errorOf(await send(q.bytes))) === "replay", "F-2: the same request again is replay");
  ok(JSON.stringify(await rows()) === JSON.stringify(r), "F-2: and writes nothing", await rows());
}

// ---- F-3: two concurrent copies: one lease, one replay, one clock update
await reset();
{
  const q = await request();
  const rs = await Promise.all([send(q.bytes), send(q.bytes)]);
  ok(rs.map((r) => r.status).sort().join() === "200,409", "F-3: two concurrent copies: one 200, one 409", rs.map((r) => r.status));
  ok((await rows()).clock.length === 1, "F-3: one clock row");
}

// ---- F-4: the transaction's refusals: each leaves only its nonce (SEC H1, H2; revocation, generation)
const refusals = [
  ["H1: no agent row", async () => exec("DELETE FROM fleet_agents"), "not_granted"],
  ["H2: the host now in another fleet", async () => exec("UPDATE fleet_hosts SET fleet = ?1 WHERE host = ?2", core.newId(), hostA), "unknown_host"],
  ["H2: the agent of another fleet", async () => exec("UPDATE fleet_agents SET fleet = ?1", core.newId()), "not_granted"],
  ["the agent revoked", async () => exec("UPDATE fleet_agents SET revoked = 1"), "agent_revoked"],
  ["the agent bound elsewhere", async () => exec("UPDATE fleet_agents SET host = ?1", hostB), "not_granted"],
  ["a stale generation", async () => exec("UPDATE fleet_agents SET entry_gen = 4"), "stale_generation"],
];
for (const [name, set, code] of refusals) {
  await reset();
  await set();
  const q = await request();
  const got = await errorOf(await send(q.bytes));
  // (a host in another fleet is refused before the batch too, by the handler's own read: no nonce then)
  const r = await rows();
  ok(got === code, `F-4 ${name}: ${code}`, got);
  ok(r.clock.length === 0 && r.pending === 0 && r.nonces <= 1, `F-4 ${name}: only the nonce row, if any`, r);
}

// ---- F-5: the first-lease gate after a move, strict, through the real batch
// (through the Worker its own clock decides, so the boundary is approached by seconds here; the exact -1 / 0 / +1 ms
// boundary is F-9's, on the very fragment the batch runs)
for (const [dt, want] of [[-5000, "not_granted"], [5000, "ok"]]) {
  await reset();
  const q0 = await request();
  await send(q0.bytes);
  const [{ expires_at: e }] = await all("SELECT expires_at FROM lease_clock");
  // the move A -> B, applied (its own batch, by the transfer writer; written directly here)
  await exec("UPDATE fleet_agents SET host = ?1, entry_gen = 7", hostB);
  await exec("INSERT INTO lease_pending (agent, from_host, to_host, transfer, acked) VALUES (?1, ?2, ?3, ?4, 0)", agent, hostA, hostB, core.b64(new Uint8Array(32).fill(5)));
  // (the clock row is moved so that the batch's now is about expires_at + MARGIN + dt)
  await exec("UPDATE lease_clock SET expires_at = ?1 WHERE host = ?2", Date.now() - MARGIN - dt, hostA);
  const q = await request(hostB, { gen: 7 });
  const r = await send(q.bytes);
  const got = r.status === 200 ? await hostAccepts(r, q, hostB) : await errorOf(r);
  ok(got === want, `F-5 the gate at expires_at + 5 min ${dt > 0 ? "+" : ""}${dt} ms: ${want}`, got);
  if (want === "ok") ok((await rows()).pending === 0, "F-5: the first lease ends the pending gate");
}

// ---- F-6: step 5's strict reading (SEC H4)
const L1 = core.newId(), L2 = core.newId();
ok(JSON.stringify(readDecision([{ lease_id: L1, decided: "ok" }], L1)) === '{"ok":true}', "F-6: our row, ok");
ok(JSON.stringify(readDecision([{ lease_id: L2, decided: "ok" }], L1)) === '{"refused":"replay"}', "F-6: another lease_id is the ordinary replay");
ok(JSON.stringify(readDecision([{ lease_id: L1, decided: "stale_generation" }], L1)) === '{"refused":"stale_generation"}', "F-6: our row, refused");
for (const [name, rs] of [["no row", []], ["two rows", [{ lease_id: L1, decided: "ok" }, { lease_id: L1, decided: "ok" }]], ["a NULL decision", [{ lease_id: L1, decided: null }]],
  ["an unknown decision", [{ lease_id: L1, decided: "maybe" }]], ["a malformed lease_id", [{ lease_id: "x", decided: "ok" }]], ["not an array", null]]) {
  let threw = false;
  try { readDecision(rs, L1); } catch { threw = true; }
  ok(threw, `F-6: ${name} throws (the handler answers 503, unsigned)`);
}
ok(JSON.stringify(DECISIONS) === JSON.stringify(["ok", "unknown_host", "host_revoked", "agent_revoked", "not_granted", "stale_generation"]), "F-6: the closed decision set");

// ---- F-7: the safe-integer bound, checked before any batch, without a rounded sum
{
  let batches = 0;
  const fake = { prepare: () => ({ bind: () => ({}) }), batch: async () => { batches++; return []; } };
  const d = (now, ttl_ms) => ({ fleet, agent, host: hostA, host_key: "x", gen: 3, nonce: "n", request: "r", lease_id: L1, ttl_ms, now });
  let threw = false;
  try { await issueLease(fake, d(Number.MAX_SAFE_INTEGER - TTL + 1, TTL)); } catch { threw = true; }
  ok(threw && batches === 0, "F-7: now = MAX_SAFE - ttl + 1 is refused before the batch");
  try { await issueLease(fake, d(Number.MAX_SAFE_INTEGER - TTL, TTL)); } catch { /* (the fake's empty result: step 5 throws) */ }
  ok(batches === 1, "F-7: now = MAX_SAFE - ttl reaches the batch");
}

// ---- F-8: the migration refuses NULLs, coerced types and out-of-range values
await reset();
for (const [name, sql, v] of [
  ["acked NULL", "INSERT INTO lease_pending (agent, from_host, to_host, transfer, acked) VALUES (?1, ?2, ?3, ?4, NULL)", [agent, hostA, hostB, core.b64(new Uint8Array(32))]],
  ["acked 2", "INSERT INTO lease_pending (agent, from_host, to_host, transfer, acked) VALUES (?1, ?2, ?3, ?4, 2)", [agent, hostA, hostB, core.b64(new Uint8Array(32))]],
  ["expires_at NULL", "INSERT INTO lease_clock (agent, host, expires_at, lease_id, gen, request) VALUES (?1, ?2, NULL, ?3, 1, ?4)", [agent, hostA, L1, core.b64(new Uint8Array(32))]],
  // (STRICT converts a text like '5' losslessly to the integer 5, which is not corruption; a non-number is refused)
  ["expires_at as a non-numeric text", "INSERT INTO lease_clock (agent, host, expires_at, lease_id, gen, request) VALUES (?1, ?2, 'soon', ?3, 1, ?4)", [agent, hostA, L1, core.b64(new Uint8Array(32))]],
  ["expires_at past 2^53 - 1", "INSERT INTO lease_clock (agent, host, expires_at, lease_id, gen, request) VALUES (?1, ?2, 9007199254740992, ?3, 1, ?4)", [agent, hostA, L1, core.b64(new Uint8Array(32))]],
  ["revoked NULL", "UPDATE fleet_hosts SET revoked = NULL", []],
  ["a decision outside the set", "INSERT INTO lease_nonces (host, nonce, lease_id, decided, created_ms) VALUES (?1, ?2, ?3, 'maybe', 1)", [hostA, core.b64(new Uint8Array(16)), L1]],
]) {
  let threw = false;
  try { await exec(sql, ...v); } catch { threw = true; }
  ok(threw, `F-8: the migration refuses ${name}`);
}

// ---- F-9: the gate is one fragment, in the decision verbatim, and closed by construction on NULLs
ok(ISSUE_SQL.decide.includes(GATE_OPEN_SQL), "F-9: the decision uses GATE_OPEN_SQL verbatim");
ok(GATE_MARGIN_MS === core.LEASE_GATE_MARGIN_MS, "F-9: the store's margin is the core's");
{
  // (tables WITHOUT the migration's constraints, so the NULL traps can be set up at all)
  const s = new DatabaseSync(":memory:");
  s.run = (sql) => s.exec(sql);
  s.run("CREATE TABLE lease_pending (agent, from_host, to_host, transfer, acked)");
  s.run("CREATE TABLE lease_clock (agent, host, expires_at, lease_id, gen, request)");
  const gate = (now) => s.prepare(`SELECT ${GATE_OPEN_SQL.replaceAll("?8", "?1")} AS open FROM lease_pending p`).get(now)?.open;
  s.run("INSERT INTO lease_pending VALUES ('a', 'A', 'B', 't', NULL)");
  s.run("INSERT INTO lease_clock VALUES ('a', 'A', 1000, 'l', 1, 'r')");
  ok(gate(1000 + MARGIN - 1) === 0, "F-9: acked NULL, a clock row, now = expires_at + margin - 1: closed");
  ok(gate(1000 + MARGIN) === 0, "F-9: at exactly expires_at + margin: closed (strict, never NULL)", gate(1000 + MARGIN));
  ok(gate(1000 + MARGIN + 1) === 1, "F-9: and open 1 ms after the margin");
  s.run("UPDATE lease_clock SET expires_at = NULL");
  ok(gate(1e15) === 0, "F-9: expires_at NULL: closed, at any time", gate(1e15));
  s.run("UPDATE lease_pending SET acked = 1");
  ok(gate(0) === 1, "F-9: a recorded ack opens it");
  s.run("DELETE FROM lease_clock"); s.run("UPDATE lease_pending SET acked = 0");
  ok(gate(0) === 1, "F-9: no clock row (the old host never held a lease): open");
  // the naive form, for contrast: UNKNOWN (NULL) where the fragment says 0
  s.run("INSERT INTO lease_clock VALUES ('a', 'A', 1000, 'l', 1, 'r')"); s.run("UPDATE lease_pending SET acked = NULL");
  const naive = s.prepare("SELECT NOT (p.acked OR (SELECT expires_at FROM lease_clock c WHERE c.agent = p.agent) IS NULL OR ?1 > (SELECT expires_at FROM lease_clock c WHERE c.agent = p.agent) + 300000) AS closed FROM lease_pending p").get(1000)?.closed;
  ok(naive === null, "F-9: (control) the naive NOT(...) form is NULL here, which a WHERE would read as not closed", naive);
}

// ---- F-11: the grant clock keeps the max through the real upsert: a later grant ending earlier never pulls it back
await reset();
{
  const q0 = await request();
  await send(q0.bytes);
  const far = Date.now() + 10 * TTL;
  await exec("UPDATE lease_clock SET expires_at = ?1", far);
  const q = await request();
  ok((await hostAccepts(await send(q.bytes), q)) === "ok", "F-11: a renewal under a longer standing expiry");
  ok((await all("SELECT expires_at FROM lease_clock"))[0].expires_at === far, "F-11: the expiry stays the max", await all("SELECT expires_at FROM lease_clock"));
}

// ---- F-12: state moved AFTER the handler's own reads and BEFORE the batch: the batch's re-reads decide (TESTS),
// each leaving only the nonce
for (const [change, code] of [["host-fleet", "unknown_host"], ["host-revoked", "host_revoked"], ["host-repaired", "not_granted"], ["agent-gone", "not_granted"], ["agent-moved", "not_granted"]]) {
  await reset();
  const q = await request();
  const r = await send(q.bytes, change);
  const got = await errorOf(r);
  const after = await rows();
  ok(got === code, `F-12 ${change} between the handler's read and the batch: ${code}`, got);
  ok(after.nonces === 1 && after.clock.length === 0 && after.pending === 0, `F-12 ${change}: the nonce row only`, after);
}

// ---- F-13: the other order: the batch first, then the change: the lease stands, recorded, and the next renewal is refused
// (a re-pairing replaces the host's signing key with its fingerprint: the old key's requests no longer verify)
const repair = await key();
for (const [sql, code] of [["UPDATE fleet_hosts SET revoked = 1 WHERE host = ?1", "host_revoked"],
  [`UPDATE fleet_hosts SET sign_key = '${core.b64(repair.raw)}', fingerprint = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' WHERE host = ?1`, "bad_signature"]]) {
  await reset();
  const q = await request();
  ok((await hostAccepts(await send(q.bytes), q)) === "ok", "F-13: the renewal before the change is granted");
  await exec(sql, hostA);
  ok((await rows()).clock.length === 1, "F-13: and its grant clock stands");
  const got = await errorOf(await send((await request()).bytes));
  ok(got === code, `F-13: the next renewal after the change: ${code}`, String(got));
}

// ---- F-14: a failure at each statement of the batch rolls the whole batch back: 503, unsigned, nothing written
for (const [name, trigger, setup] of [
  ["the nonce reservation", "CREATE TRIGGER t_fail BEFORE INSERT ON lease_nonces BEGIN SELECT RAISE(ABORT, 'injected'); END", null],
  ["the decision", "CREATE TRIGGER t_fail BEFORE UPDATE ON lease_nonces BEGIN SELECT RAISE(ABORT, 'injected'); END", null],
  ["the clock's insert", "CREATE TRIGGER t_fail BEFORE INSERT ON lease_clock BEGIN SELECT RAISE(ABORT, 'injected'); END", null],
  ["the clock's update", "CREATE TRIGGER t_fail BEFORE UPDATE ON lease_clock BEGIN SELECT RAISE(ABORT, 'injected'); END", "renewed"],
  ["the pending gate's settle", "CREATE TRIGGER t_fail BEFORE DELETE ON lease_pending BEGIN SELECT RAISE(ABORT, 'injected'); END", "moved"],
]) {
  await reset();
  let q = await request();
  if (setup === "renewed") await send((await request()).bytes);
  if (setup === "moved") {
    await exec("UPDATE fleet_agents SET host = ?1, entry_gen = 7", hostB);
    await exec("INSERT INTO lease_pending (agent, from_host, to_host, transfer, acked) VALUES (?1, ?2, ?3, ?4, 1)", agent, hostA, hostB, core.b64(new Uint8Array(32).fill(5)));
    q = await request(hostB, { gen: 7 });
  }
  const before = await rows();
  await exec(trigger);
  const r = await send(q.bytes);
  ok(r.status === 503 && (await r.arrayBuffer()).byteLength === 0, `F-14 a failure at ${name}: 503, unsigned`, r.status);
  await exec("DROP TRIGGER t_fail");
  ok(JSON.stringify(await rows()) === JSON.stringify(before), `F-14 a failure at ${name}: the batch rolled back whole`, { before, after: await rows() });
}

// ---- F-15: any one of the five statements failing, the read included, rolls back nonce, clock and pending: the store
// throws (the handler's 503) and nothing changed. (A statement is swapped for one that fails at run time.)
for (let failAt = 0; failAt < 5; failAt++) {
  await reset();
  await exec("INSERT INTO lease_pending (agent, from_host, to_host, transfer, acked) VALUES (?1, ?2, ?3, ?4, 1)", agent, hostB, hostA, core.b64(new Uint8Array(32)));
  const q = await request();
  const d = { fleet, agent, host: hostA, host_key: hosts[hostA].fingerprint, gen: 3, nonce: q.body.nonce, request: q.outstanding.request, lease_id: core.newId(), ttl_ms: TTL, now: Date.now() };
  const before = JSON.stringify(await rows());
  const injected = { prepare: (s) => db.prepare(s), batch: (stmts) => { const broken = [...stmts]; broken[failAt] = db.prepare("SELECT json_extract('broken', '$')"); return db.batch(broken); } };
  let threw = false;
  try { await issueLease(injected, d); } catch { threw = true; }
  ok(threw && JSON.stringify(await rows()) === before, `F-15: statement ${failAt + 1} failing rolls back nonce, clock and pending`, await rows());
}

// ---- F-10: the rate buckets: exactly the limit in a window, across calls
await reset();
{
  const d1 = await mf.getD1Database("FLEET_DB");
  const got = [];
  for (let i = 0; i < 5; i++) got.push(await bucket(d1, "k", 3, 60_000, 1_000_000 + i, core.newId()));
  ok(JSON.stringify(got) === "[true,true,true,false,false]", "F-10: at most 3 in the window", got);
  ok((await bucket(d1, "k", 3, 60_000, 1_000_000 + 60_000, core.newId())) === true, "F-10: the window slides: the first hit has left it");
}

await mf.dispose();
console.log(`${count - failures}/${count} passed`);
if (failures) process.exit(1);
