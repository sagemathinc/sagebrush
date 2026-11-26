// ci: web-sync.1 order=14
// Tests for the fleet Worker's grant-with-transfers writer and the old host's fence ack (web/cloud/fleet/writers.ts;
// writers design W2 r4.2, W2b), on a real D1 (FLEET_DB) in Miniflare with all three migrations, through the mirrored
// core's own verifiers, and with the lease batch (store.ts) the gate belongs to. Seams run between a writer's
// verification and its batch, so every race is tested in both orders. The writers are bundled with bun (as the Worker is).
//   node web/cloud/fleet/test-fleet-grants.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as core from "../../workspace/fleet/core/index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "../../site/package.json"));
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
core.useCrypto(core.webCrypto());
const SCHEMAS = { "fleet.schema.json": JSON.parse(readFileSync(join(here, "../../workspace/fleet/fleet.schema.json"), "utf8")), "reasons.json": JSON.parse(readFileSync(join(here, "../../workspace/fleet/reasons.json"), "utf8")) };
core.useSchemas((n) => SCHEMAS[n]);
const tmp = mkdtempSync(join(tmpdir(), "fleet-grants-"));
for (const m of ["writers", "store"]) writeFileSync(join(tmp, `${m}.mjs`), execFileSync("bun", ["build", join(here, `${m}.ts`), "--format", "esm", "--target", "node"], { encoding: "utf8" }));
const W = await import(pathToFileURL(join(tmp, "writers.mjs")).href);
const S = await import(pathToFileURL(join(tmp, "store.mjs")).href);
rmSync(tmp, { recursive: true, force: true });

let failures = 0, count = 0;
const ok = (c, what, detail) => { count++; if (!c) { failures++; console.log("FAIL", what, detail === undefined ? "" : JSON.stringify(detail).slice(0, 600)); } };
const codeOf = async (p) => { try { const r = await p; return r.refused ?? r.ignored ?? (r.ok ? "ok" : JSON.stringify(r)); } catch (e) { return e instanceof core.FleetError ? e.code : `threw: ${e.message}`; } };
const AUD = "https://dev.sagebrush.space";
const NOW = 1_800_000_000_000;
const MARGIN = S.GATE_MARGIN_MS, TTL = 600_000;
let seedN = 1;
const key = () => core.keyFromSeed(new Uint8Array(32).fill(seedN++ & 255).map((x, i) => (i === 0 ? (seedN >> 8) & 255 : x)));
const rand = (n) => core.b64(core.random(n));
const text = (b) => new TextDecoder().decode(b);

// ---- the database: all three migrations, applied as the deploy does
const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: "fleet", modules: true, script: "export default { fetch() { return new Response('') } }", compatibilityDate: "2026-10-01", d1Databases: ["FLEET_DB"] }] }));
const db = await mf.getD1Database("FLEET_DB");
const MIGRATIONS = ["0001_fleet_leases.sql", "0002_fleet_writers_chain_hosts.sql", "0003_fleet_writers_grants_transfers.sql", "0004_fleet_request_nonces.sql", "0005_fleet_accounts_and_bytes.sql"];
const statementsOf = (m) => readFileSync(join(here, "migrations", m), "utf8").replace(/--[^\n]*/g, "").split(";").map((s) => s.trim()).filter(Boolean);
for (const m of MIGRATIONS) for (const stmt of statementsOf(m)) await db.prepare(stmt).run();
const all = async (sql, ...v) => (await db.prepare(sql).bind(...v).all()).results;
const exec = (sql, ...v) => db.prepare(sql).bind(...v).run();
const TABLES = ["fleet_chain_entries", "fleet_chain_hashes", "fleet_hosts", "fleet_host_certs", "fleet_revocations", "fleet_agents", "fleet_grants", "fleet_transfers",
  "fleet_transfer_results", "fleet_retired_agents", "fleet_fence_acks", "fleet_host_queue", "fleet_grant_decisions", "lease_pending", "lease_clock", "lease_nonces"];
const snapshot = async () => JSON.stringify(await Promise.all(TABLES.map((t) => all(`SELECT * FROM ${t} ORDER BY 1, 2`))));

// ---- a fleet: a native device N, a browser device B, the service's key S1 pinned; and the entries its app signs
async function fleetOf({ serviceKey = true } = {}) {
  const fleet = core.newId(), N = await key(), nId = core.newId(), R = await key();
  const sN = { kind: "device", id: nId, alg: "ed25519", key: N.key };
  const f = { fleet, N, nId, sN, by: { s: sN, k: N }, seq: 0, head: "", keys: [], account: core.newId() };
  f.body = (op, extra) => ({ fleet, aud: AUD, seq: f.seq, prev: f.head, op, at_ms: NOW, auth_time_ms: NOW, ...extra });
  f.entry = (op, extra, by = f.by) => core.seal("sb.device-chain.v1", by.s, f.body(op, extra), by.k);
  f.append = async (bytes, hooks) => {
    const r = await W.appendChainEntry(db, core, { fleet, aud: AUD, bytes, now: NOW, account: f.account }, hooks);
    if (!r.ok) throw new Error(`append: ${JSON.stringify(r)}`);
    const st = await W.loadChain(db, core, fleet, AUD);
    f.seq = st.head.seq + 1; f.head = st.head.hash;
    return r;
  };
  await f.append(await f.entry("genesis", { device: { id: nId, alg: "ed25519", key: core.b64(N.raw), name: "mac", tier: "native" }, recovery_key: { alg: "ed25519", key: core.b64(R.raw) } }));
  const B = await key(), bId = core.newId();
  await f.append(await core.sealAdd(sN, f.body("add", { device: { id: bId, alg: "ed25519", key: core.b64(B.raw), name: "browser", tier: "browser" } }), N, B));
  f.browser = { s: { kind: "device", id: bId, alg: "ed25519", key: B.key }, k: B, id: bId };
  f.serviceKey = async () => {
    const K = await key(), id = core.newId();
    await f.append(await f.entry("service-key", { service_key: { id, alg: "ed25519", key: core.b64(K.raw) } }));
    const sk = { id, raw: K.raw, sign: (b) => K.sign(b) };
    f.keys.push(sk);
    return sk;
  };
  if (serviceKey) await f.serviceKey();
  return f;
}
/** A paired host: its id, keys, fingerprint and certificate hash. */
async function hostOf(f) {
  const host = core.newId(), H = await key(), encRaw = core.random(32);
  const fingerprint = core.b64(await core.hostFingerprint(host, H.raw, encRaw));
  const bytes = await core.seal("sb.host-cert.v1", f.sN, { fleet: f.fleet, aud: AUD, chain_seq: f.seq - 1, host, sign_key: core.b64(H.raw), enc_key: core.b64(encRaw), fingerprint, name: "box", at_ms: NOW }, f.N);
  const r = await W.pairHost(db, core, { fleet: f.fleet, aud: AUD, bytes });
  if (!r.ok) throw new Error(`pair: ${JSON.stringify(r)}`);
  const cert = (await all("SELECT cert FROM fleet_host_certs WHERE fleet = ?1 AND host = ?2", f.fleet, host))[0].cert;
  return { host, H, fingerprint, cert };
}
const agentEntry = (agent, extra = {}) => ({ agent, name: "worker", client: "claude", root: false, tags: [], workspace: [{ path: "/Algebra", access: "write" }], broker: ["messages"],
  spend_cap_cents: 0, config_schema: 1, config: {}, ...extra });
/** A grant for host h at gen listing `agents` (entries): { bytes, hash }. */
async function grantOf(f, h, gen, agents, { by = f.by, ...extra } = {}) {
  const body = { fleet: f.fleet, aud: AUD, host: h.host, gen, cert: h.cert, chain_seq: f.seq - 1, at_ms: NOW - 1000, not_before_ms: NOW - 1000, not_after_ms: NOW + 3_600_000,
    auth_time_ms: NOW, agents, tags: [], subscriptions: [], offline: { revocation_check_s: 900, horizon_s: 3600 }, ...extra };
  return { bytes: await core.seal("sb.host-grant.v1", by.s, body, by.k), hash: await core.sha256b64(core.signedBytes("sb.host-grant.v1", by.s, body)), body };
}
/** A transfer of `agent` from `from` to `to` (hosts), naming grant g (to's) at its gen. */
async function transferOf(f, agent, from, to, g, { by = f.by, ...extra } = {}) {
  const body = { fleet: f.fleet, aud: AUD, agent, from_host: from.host, to_host: to.host, to_host_key: to.fingerprint, gen: g.body.gen, grant: g.hash, nonce: rand(16),
    chain_seq: f.seq - 1, at_ms: NOW, not_after_ms: NOW + 600_000, auth_time_ms: NOW, ...extra };
  return { bytes: await core.seal("sb.agent-transfer.v1", by.s, body, by.k), hash: await core.sha256b64(core.signedBytes("sb.agent-transfer.v1", by.s, body)), body };
}
const apply = (f, g, transfers = [], { now = NOW, hooks, dbx = db, keys = f.keys } = {}) =>
  W.applyGrant(dbx, core, { fleet: f.fleet, aud: AUD, grant: g.bytes, transfers: transfers.map((t) => t.bytes), now, serviceKeys: keys }, hooks);
const binding = async (agent) => (await all("SELECT fleet, host, entry_gen, revoked, entry FROM fleet_agents WHERE agent = ?1", agent))[0] ?? null;
const pending = async (agent) => (await all("SELECT from_host, to_host, transfer, acked FROM lease_pending WHERE agent = ?1", agent))[0] ?? null;
/** The lease batch (W1's issueLease), as the lease endpoint calls it. */
const lease = (f, agent, h, gen, now) => S.issueLease(db, { fleet: f.fleet, agent, host: h.host, host_key: h.fingerprint, gen, nonce: rand(16), request: rand(32), lease_id: core.newId(), ttl_ms: TTL, now });
const leaseCode = async (...a) => { const r = await lease(...a); return r.ok ? "ok" : r.refused; };
/** The old host's fence ack for a transfer. */
async function ackOf(f, from, t, { gen, at_ms = NOW + 1, proven_empty = true, signer = from } = {}) {
  const body = { fleet: f.fleet, aud: AUD, agent: t.body.agent, host: from.host, gen, transfer: t.hash, boot_id: "0f6c2b5e-8d3a-4c1e-9b7f-2a4d6e8f0a1c", proven_empty, at_ms };
  return core.seal("sb.agent-fence-ack.v1", { kind: "host", id: from.host, alg: "ed25519", key: signer.H.key }, body, signer.H);
}
const ack = (f, bytes, dbx = db) => W.recordFenceAck(dbx, core, { fleet: f.fleet, aud: AUD, bytes });
/** A fleet with hosts A, B, C and agent X granted on A at gen 1. */
async function world() {
  const f = await fleetOf();
  const A = await hostOf(f), B = await hostOf(f), C = await hostOf(f);
  const X = core.newId();
  const gA = await grantOf(f, A, 1, [agentEntry(X)]);
  const r = await apply(f, gA);
  if (!r.ok) throw new Error(`world: ${JSON.stringify(r)}`);
  return { f, A, B, C, X, gA };
}

// ---- G-1: a grant on its own: the generation rule, the binding and entry_gen (§3.2, §3.7.1)
{
  const { f, A, X, gA } = await world();
  const b = await binding(X);
  ok(b?.host === A.host && b.entry_gen === 1 && b.fleet === f.fleet && b.entry.length === 43, "G-1: a new agent is bound to the grant's host at its gen, with its entry's digest", b);
  ok((await all("SELECT gen, hash FROM fleet_grants WHERE fleet = ?1 AND host = ?2", f.fleet, A.host)).map((r) => `${r.gen}:${r.hash}`).join() === `1:${gA.hash}`, "G-1: the grant row");
  let before = await snapshot();
  const again = await apply(f, gA);
  ok(again.ok && again.reapply && (await snapshot()) === before, "G-1: the byte-identical re-apply: accepted, nothing changed", again);
  const other = await grantOf(f, A, 1, [agentEntry(X)], { at_ms: NOW - 999 });
  ok((await codeOf(apply(f, other))) === "stale_generation" && (await snapshot()) === before, "G-1: other bytes at the accepted gen: stale_generation, nothing written");
  ok((await codeOf(apply(f, await grantOf(f, A, 1, [agentEntry(X)], { gen: 0 })))) === "bad_form", "G-1: gen 0 is the schema's");
  // entry_gen: X unchanged, Y new at 2; then X changed at 3, Y unchanged
  const Y = core.newId();
  ok((await codeOf(apply(f, await grantOf(f, A, 2, [agentEntry(X), agentEntry(Y)])))) === "ok", "G-1: gen 2 adds Y");
  ok((await binding(X)).entry_gen === 1 && (await binding(Y)).entry_gen === 2, "G-1: X unchanged keeps entry_gen 1; Y new gets 2");
  ok((await codeOf(apply(f, await grantOf(f, A, 3, [agentEntry(X, { name: "renamed" }), agentEntry(Y)])))) === "ok", "G-1: gen 3 changes X");
  ok((await binding(X)).entry_gen === 3 && (await binding(Y)).entry_gen === 2, "G-1: X changed moves to 3; Y unchanged keeps 2");
  ok((await leaseCode(f, X, A, 3, NOW)) === "ok" && (await leaseCode(f, Y, A, 2, NOW)) === "ok", "G-1: renewals at those generations succeed");
  ok((await leaseCode(f, X, A, 1, NOW)) === "stale_generation" && (await leaseCode(f, Y, A, 3, NOW)) === "stale_generation", "G-1: and fail at the other's");
  ok((await codeOf(apply(f, await grantOf(f, A, 2, [agentEntry(X)])))) === "stale_generation", "G-1: a lower generation: stale_generation");
  // an agent bound to another host, listed without its transfer
  const B = await hostOf(f);
  before = await snapshot();
  ok((await codeOf(apply(f, await grantOf(f, B, 1, [agentEntry(X)])))) === "not_granted" && (await snapshot()) === before, "G-1: an agent bound elsewhere, with no transfer: not_granted, nothing written");
  // the host: unpaired, revoked, another certificate
  const ghost = { host: core.newId(), cert: rand(32), fingerprint: rand(32) };
  ok((await codeOf(apply(f, await grantOf(f, ghost, 1, [agentEntry(core.newId())])))) === "unknown_host", "G-1: a grant for an unpaired host: unknown_host");
  ok((await codeOf(apply(f, await grantOf(f, { ...B, cert: rand(32) }, 1, [agentEntry(core.newId())])))) === "not_granted", "G-1: a grant naming another certificate: not_granted");
  await W.revoke(db, core, { fleet: f.fleet, aud: AUD, bytes: await core.seal("sb.revocation.v1", f.sN, { fleet: f.fleet, aud: AUD, chain_seq: f.seq - 1, what: "host", id: B.host, host: B.host, gen: 1, at_ms: NOW }, f.N) });
  ok((await codeOf(apply(f, await grantOf(f, B, 1, [agentEntry(core.newId())])))) === "host_revoked", "G-1: a grant for a revoked host: host_revoked");
  // the tier: with require_native_for_widening on, a browser-signed widening grant is refused
  await f.append(await f.entry("policy", { policy: { require_native_for_widening: true } }));
  ok((await codeOf(apply(f, await grantOf(f, A, 4, [agentEntry(X, { name: "renamed" }), agentEntry(Y), agentEntry(core.newId())], { by: f.browser })))) === "device_tier", "G-1: a browser-signed widening grant under the native policy: device_tier");
  ok((await codeOf(apply(f, await grantOf(f, A, 4, [agentEntry(X, { name: "renamed" }), agentEntry(core.newId())])))) === "ok", "G-1: the native device's: ok");
}

// ---- G-2: a transfer applied, its receipt, its stored result, and the exact retry (§2.0, §2.1)
{
  const { f, A, B, X } = await world();
  const fromGen = (await binding(X)).entry_gen;
  const gB = await grantOf(f, B, 1, [agentEntry(X)]);
  const t = await transferOf(f, X, A, B, gB);
  const r = await apply(f, gB, [t]);
  ok(r.ok && !r.replayed && r.pairs.length === 1 && r.pairs[0].transfer === text(t.bytes), "G-2: applied: one pair, the person's envelope as sent", r);
  const st = await W.loadChain(db, core, f.fleet, AUD);
  const v = await core.verifyTransferReceipt({ transfer: core.enc(r.pairs[0].transfer), receipt: core.enc(r.pairs[0].receipt) }, { aud: AUD, fleet: f.fleet, chain: st.state });
  ok(v.transferHash === t.hash && v.receipt.chain_seq === st.head.seq && v.receipt.at_ms === NOW, "G-2: the new host's own check accepts the receipt, signed at the verified head", v.receipt);
  const b = await binding(X);
  ok(b.host === B.host && b.entry_gen === 1, "G-2: X is bound to B at the grant's gen", b);
  const tr = (await all("SELECT * FROM fleet_transfers WHERE fleet = ?1 AND nonce = ?2", f.fleet, t.body.nonce))[0];
  ok(tr?.from_gen === fromGen && tr.from_host === A.host && tr.applied_ms === NOW && tr.transfer === t.hash && tr.receipt === r.pairs[0].receipt, "G-2: the transfer row: from_gen read before the rebinding, applied_ms the batch's time, the exact receipt", tr);
  ok(JSON.stringify(await pending(X)) === JSON.stringify({ from_host: A.host, to_host: B.host, transfer: t.hash, acked: 0 }), "G-2: the pending first lease", await pending(X));
  ok((await all("SELECT 1 FROM fleet_host_queue WHERE fleet = ?1 AND host = ?2 AND kind = 'transfer' AND ref = ?3", f.fleet, A.host, t.hash)).length === 1, "G-2: queued for the old host");
  ok((await leaseCode(f, X, A, fromGen, NOW)) === "not_granted", "G-2: the old host's renewal is refused");
  ok((await all("SELECT * FROM fleet_grant_decisions")).length === 0, "G-2: no decision row outlives its batch");
  // the exact retry, after the window and the sign-in horizon and an unrelated head advance: the stored bytes, no effect
  await f.append(await f.entry("policy", { policy: { require_native_for_widening: false } }));
  let before = await snapshot();
  const late = NOW + 7 * 24 * 3_600_000;
  const again = await apply(f, gB, [t], { now: late });
  ok(again.ok && again.replayed && JSON.stringify(again.pairs) === JSON.stringify(r.pairs) && (await snapshot()) === before, "G-2: the exact retry a week later: the stored pairs byte for byte, nothing changed", again);
  // a rotation of the service key since: still the stored bytes, never a new signature
  await f.serviceKey();
  before = await snapshot();
  const rotated = await apply(f, gB, [t], { now: late, keys: [f.keys[1]] });
  ok(rotated.ok && rotated.replayed && rotated.pairs[0].receipt === r.pairs[0].receipt && (await snapshot()) === before, "G-2: after a service-key rotation: the stored receipt, unchanged");
  // the same transfers with a changed grant: inside the window, replay (spent nonces, before any binding or grant
  // check); after it, the window's refusal. Never the stored success
  const gB2 = await grantOf(f, B, 2, [agentEntry(X)]);
  before = await snapshot();
  let got = await codeOf(apply(f, gB2, [t]));
  ok(got === "replay" && (await snapshot()) === before, "G-2: the same lookup key, changed grant, inside the window: replay, nothing written", got);
  got = await codeOf(apply(f, gB2, [t], { now: late }));
  ok((got === "grant_expired" || got === "stale_auth") && (await snapshot()) === before, "G-2: the same, after expiry: the full path's time refusal, nothing written", got);
  ok((await codeOf(apply(f, await grantOf(f, B, 1, [agentEntry(X)], { at_ms: NOW - 5 }), [t]))) === "stale_generation" && (await snapshot()) === before, "G-2: the same, changed grant at the accepted gen: stale_generation, nothing written");
  // old, expired bytes for a request never applied: the window's refusal
  const Q = await hostOf(f);
  const gQ = await grantOf(f, Q, 1, [agentEntry(X)]);
  const tQ = await transferOf(f, X, B, Q, gQ);
  const b5 = await snapshot();
  got = await codeOf(apply(f, gQ, [tQ], { now: late }));
  ok((got === "grant_expired" || got === "stale_auth") && (await snapshot()) === b5, "G-2: expired bytes never applied: the time refusal, nothing written", got);
  // the same bytes after the signer's removal: refused, even as an exact retry
  {
    const h = await fleetOf();
    const D = await key(), dId = core.newId();
    await h.append(await core.sealAdd(h.sN, h.body("add", { device: { id: dId, alg: "ed25519", key: core.b64(D.raw), name: "laptop", tier: "native" } }), h.N, D));
    const by = { s: { kind: "device", id: dId, alg: "ed25519", key: D.key }, k: D };
    const P = await hostOf(h), R = await hostOf(h), Y = core.newId();
    await apply(h, await grantOf(h, P, 1, [agentEntry(Y)]));
    const gR = await grantOf(h, R, 1, [agentEntry(Y)], { by });
    const tR = await transferOf(h, Y, P, R, gR, { by });
    ok((await codeOf(apply(h, gR, [tR]))) === "ok", "G-2: a request signed by device D: applied");
    await h.append(await h.entry("remove", { remove: dId, regrants: [] }));
    const b6 = await snapshot();
    ok((await codeOf(apply(h, gR, [tR]))) === "device_removed" && (await snapshot()) === b6, "G-2: its exact bytes after D's removal: device_removed, nothing served");
  }
  // another fleet: step 1's fleet
  const g = await fleetOf();
  ok((await codeOf(W.applyGrant(db, core, { fleet: g.fleet, aud: AUD, grant: gB.bytes, transfers: [t.bytes], now: NOW, serviceKeys: g.keys }))) !== "ok", "G-2: the exact retry presented for another fleet: refused");
}

// ---- G-3: each refusal of §3.7.2 refuses the whole request, with ALL durable state unchanged
{
  const { f, A, B, C, X } = await world();
  const Z = core.newId();
  await apply(f, await grantOf(f, A, 2, [agentEntry(X), agentEntry(Z)]));
  const gB = await grantOf(f, B, 1, [agentEntry(X), agentEntry(Z)]);
  const good = await transferOf(f, Z, A, B, gB);
  const cases = [
    ["to_host = from_host", () => transferOf(f, X, B, B, gB), "bad_form"],
    ["not bound to from_host", () => transferOf(f, X, C, B, gB), "not_granted"],
    ["to_host_key isn't B's fingerprint", () => transferOf(f, X, A, B, gB, { to_host_key: rand(32) }), "not_granted"],
    ["naming another grant", () => transferOf(f, X, A, B, gB, { grant: rand(32) }), "not_granted"],
    ["at another gen", () => transferOf(f, X, A, B, gB, { gen: 2 }), "stale_generation"],
    ["to another host than the grant's", () => transferOf(f, X, A, { ...C, fingerprint: C.fingerprint }, gB), "not_granted"],
    ["a sign-in 5 minutes and 1 ms old", () => transferOf(f, X, A, B, gB, { auth_time_ms: NOW - 300_001 }), "stale_auth"],
    ["at not_after_ms", () => transferOf(f, X, A, B, gB, { at_ms: NOW - 1000, not_after_ms: NOW }), "grant_expired"],
    ["at_ms more than 5 minutes ahead", () => transferOf(f, X, A, B, gB, { at_ms: NOW + 300_001, not_after_ms: NOW + 600_000, auth_time_ms: NOW }), "grant_expired"],
    ["living over 10 minutes", () => transferOf(f, X, A, B, gB, { not_after_ms: NOW + 600_001 }), "bad_form"],
    ["signed by the browser device under the native policy", null, "device_tier"],
  ];
  for (const [what, mk, code] of cases) {
    if (!mk) continue;
    const bad = await mk();
    for (const set of [[bad], [good, bad], [bad, good]]) {
      const before = await snapshot();
      const got = await codeOf(apply(f, gB, set));
      ok(got === code && (await snapshot()) === before, `G-3: ${what}${set.length > 1 ? " (with a good transfer)" : ""}: ${code}, nothing written`, got);
    }
  }
  // a listed agent of the grant not moved by any transfer here, bound elsewhere
  const before = await snapshot();
  ok((await codeOf(apply(f, gB, [good]))) === "not_granted" && (await snapshot()) === before, "G-3: the grant lists X, bound to A, with no transfer for X: not_granted");
  // a reused nonce: replay before the binding check
  const t1 = await transferOf(f, X, A, B, gB);
  ok((await codeOf(apply(f, gB, [t1, good]))) === "ok", "G-3: both moved together: ok");
  const reuse = await transferOf(f, X, B, C, await grantOf(f, C, 1, [agentEntry(X)]), { nonce: t1.body.nonce });
  const b2 = await snapshot();
  ok((await codeOf(apply(f, await grantOf(f, C, 1, [agentEntry(X)]), [reuse]))) === "replay" && (await snapshot()) === b2, "G-3: a nonce reused in this fleet: replay (before the gate or the binding), nothing written");
  // two transfers in one request sharing a nonce; one agent twice
  const gC = await grantOf(f, C, 1, [agentEntry(X), agentEntry(Z)]);
  const n = rand(16);
  ok((await codeOf(apply(f, gC, [await transferOf(f, X, B, C, gC, { nonce: n }), await transferOf(f, Z, B, C, gC, { nonce: n })]))) === "replay", "G-3: one nonce twice in one request: replay");
  ok((await codeOf(apply(f, gC, [await transferOf(f, X, B, C, gC), await transferOf(f, X, B, C, gC)]))) === "bad_form", "G-3: one agent moved twice in one request: bad_form");
  // the browser device under the native policy
  await f.append(await f.entry("policy", { policy: { require_native_for_widening: true } }));
  const gC2 = await grantOf(f, C, 1, [agentEntry(X)]);
  const b3 = await snapshot();
  ok((await codeOf(apply(f, gC2, [await transferOf(f, X, B, C, gC2, { by: f.browser })]))) === "device_tier" && (await snapshot()) === b3, "G-3: a browser-signed transfer under the native policy: device_tier");
  // a fleet whose chain pins no service key the Worker holds: no receipt can be signed, nothing written
  const g = await fleetOf({ serviceKey: false });
  const gA2 = g;
  const P = await hostOf(g), Q = await hostOf(g), Y = core.newId();
  await apply(g, await grantOf(g, P, 1, [agentEntry(Y)]));
  const gQ = await grantOf(g, Q, 1, [agentEntry(Y)]);
  const b4 = await snapshot();
  ok((await codeOf(apply(gA2, gQ, [await transferOf(g, Y, P, Q, gQ)], { keys: f.keys }))) === "not_granted" && (await snapshot()) === b4, "G-3: no service key in force at the head: not_granted, nothing written");
}

// ---- G-4: chained moves through the real batches: the pending gate refuses the next move (§2.3)
{
  const { f, A, B, C, X } = await world();
  ok((await leaseCode(f, X, A, 1, NOW)) === "ok", "G-4: A holds a live lease");
  const expires = NOW + TTL;
  const gB = await grantOf(f, B, 1, [agentEntry(X)]);
  ok((await codeOf(apply(f, gB, [await transferOf(f, X, A, B, gB)]))) === "ok", "G-4: A -> B applied while A's lease is live");
  // B -> C at the gate's boundary: the grant the transfer names, both dated at that time
  const at = async (d) => {
    const now = expires + MARGIN + d;
    const gC = await grantOf(f, C, 1, [agentEntry(X)], { at_ms: now - 1000, not_before_ms: now - 1000, not_after_ms: now + 3_600_000, auth_time_ms: now });
    const tC = await transferOf(f, X, B, C, gC, { at_ms: now, not_after_ms: now + 600_000, auth_time_ms: now });
    return { gC, tC, now };
  };
  for (const d of [-1, 0]) {
    const { gC, tC, now } = await at(d);
    const before = await snapshot();
    ok((await codeOf(apply(f, gC, [tC], { now }))) === "in_progress" && (await snapshot()) === before, `G-4: B -> C at expiry + margin ${d}: in_progress, nothing written`);
  }
  const { gC, tC, now } = await at(1);
  ok((await codeOf(apply(f, gC, [tC], { now }))) === "ok", "G-4: B -> C one ms past it: applied");
  ok((await leaseCode(f, X, C, 1, now)) === "ok", "G-4: C's first lease: granted at once (B never held one)");
  // after A's verified ack instead of the wait
  const w = await world();
  await lease(w.f, w.X, w.A, 1, NOW);
  const gB2 = await grantOf(w.f, w.B, 1, [agentEntry(w.X)]);
  const tB = await transferOf(w.f, w.X, w.A, w.B, gB2);
  await apply(w.f, gB2, [tB]);
  const gC2 = await grantOf(w.f, w.C, 1, [agentEntry(w.X)]);
  ok((await codeOf(apply(w.f, gC2, [await transferOf(w.f, w.X, w.B, w.C, gC2)]))) === "in_progress", "G-4: B -> C before A's ack: in_progress");
  ok((await codeOf(ack(w.f, await ackOf(w.f, w.A, tB, { gen: 1 })))) === "ok", "G-4: A's verified ack");
  ok((await codeOf(apply(w.f, gC2, [await transferOf(w.f, w.X, w.B, w.C, gC2)]))) === "ok", "G-4: B -> C after it: applied");
}

// ---- G-5: no carried ack (the gate owner's condition): the new pending row's acked is 0
{
  const { f, A, B, C, X } = await world();
  const gB = await grantOf(f, B, 1, [agentEntry(X)]);
  const tB = await transferOf(f, X, A, B, gB);
  await apply(f, gB, [tB]);
  await ack(f, await ackOf(f, A, tB, { gen: 1 }));
  ok((await pending(X)).acked === 1, "G-5: A -> B acked by A");
  // B holds a live clock row from an earlier stay
  await exec("INSERT INTO lease_clock (agent, host, expires_at, lease_id, gen, request) VALUES (?1, ?2, ?3, ?4, 1, ?5)", X, B.host, NOW + TTL, core.newId(), rand(32));
  const gC = await grantOf(f, C, 1, [agentEntry(X)]);
  const tC = await transferOf(f, X, B, C, gC);
  ok((await codeOf(apply(f, gC, [tC]))) === "ok", "G-5: B -> C applied (A's gate is open)");
  ok(JSON.stringify(await pending(X)) === JSON.stringify({ from_host: B.host, to_host: C.host, transfer: tC.hash, acked: 0 }), "G-5: the new pending row reads acked 0", await pending(X));
  ok((await leaseCode(f, X, C, 1, NOW + TTL + MARGIN)) === "not_granted", "G-5: C's first lease waits for B's expiry plus the margin");
  ok((await leaseCode(f, X, C, 1, NOW + TTL + MARGIN + 1)) === "ok", "G-5: and is granted 1 ms past it");
}

// ---- G-6: fence acks: every failing condition ignored with no write; a replay changes nothing (§3)
{
  const { f, A, B, C, X } = await world();
  await lease(f, X, A, 1, NOW);
  const gB = await grantOf(f, B, 1, [agentEntry(X)]);
  const tB = await transferOf(f, X, A, B, gB);
  await apply(f, gB, [tB]);
  const D = await hostOf(f);
  const cases = [
    ["at a wrong gen", () => ackOf(f, A, tB, { gen: 2 })],
    ["at_ms at the apply's time", () => ackOf(f, A, tB, { gen: 1, at_ms: NOW })],
    ["at_ms before it", () => ackOf(f, A, tB, { gen: 1, at_ms: NOW - 1 })],
    ["from another host", () => ackOf(f, D, tB, { gen: 1 })],
    ["from the new host", () => ackOf(f, B, tB, { gen: 1 })],
    ["signed by another host's key", () => ackOf(f, A, tB, { gen: 1, signer: D })],
    ["naming another transfer", async () => ackOf(f, A, { ...tB, hash: rand(32) }, { gen: 1 })],
  ];
  for (const [what, mk] of cases) {
    const before = await snapshot();
    const got = await codeOf(ack(f, await mk()));
    ok(got !== "ok" && (await snapshot()) === before, `G-6: an ack ${what}: ignored, nothing written`, got);
  }
  const before = await snapshot();
  ok((await codeOf(ack(f, await ackOf(f, A, tB, { gen: 1, proven_empty: false })))) !== "ok" && (await snapshot()) === before, "G-6: proven_empty false: ignored");
  const good = await ackOf(f, A, tB, { gen: 1 });
  ok((await codeOf(ack(f, good))) === "ok" && (await pending(X)).acked === 1, "G-6: the valid ack: accepted, the gate opens");
  const after = await snapshot();
  ok((await codeOf(ack(f, good))) === "not_accepted" && (await snapshot()) === after && (await pending(X)).acked === 1, "G-6: its replay: ignored, nothing changed, the gate stays open");
  ok((await leaseCode(f, X, B, 1, NOW + 1)) === "ok", "G-6: B's first lease, at once");
  // a revoked old host can never ack
  const w = await world();
  const gB2 = await grantOf(w.f, w.B, 1, [agentEntry(w.X)]);
  const tB2 = await transferOf(w.f, w.X, w.A, w.B, gB2);
  await apply(w.f, gB2, [tB2]);
  await W.revoke(db, core, { fleet: w.f.fleet, aud: AUD, bytes: await core.seal("sb.revocation.v1", w.f.sN, { fleet: w.f.fleet, aud: AUD, chain_seq: w.f.seq - 1, what: "host", id: w.A.host, host: w.A.host, gen: 1, at_ms: NOW }, w.f.N) });
  const b2 = await snapshot();
  ok((await codeOf(ack(w.f, await ackOf(w.f, w.A, tB2, { gen: 1 })))) === "host_revoked" && (await snapshot()) === b2, "G-6: from a revoked old host: ignored");
  void C;
}

// ---- G-7: the fence ack's source is the transfer's stored from_gen (the gate owner's row)
{
  const { f, A, B, X } = await world();
  await apply(f, await grantOf(f, A, 2, [agentEntry(X, { name: "v2" })]));
  ok((await binding(X)).entry_gen === 2, "G-7: X's entry_gen on A is 2");
  const gB = await grantOf(f, B, 1, [agentEntry(X)]);
  const tB = await transferOf(f, X, A, B, gB);
  await apply(f, gB, [tB]);
  // a grant on B raises X's entry_gen there
  await apply(f, await grantOf(f, B, 2, [agentEntry(X, { name: "on-b" })]));
  ok((await binding(X)).entry_gen === 2 && (await binding(X)).host === B.host, "G-7: X's entry_gen on B is now 2 as well");
  ok((await codeOf(ack(f, await ackOf(f, A, tB, { gen: 1 })))) === "not_accepted", "G-7: an ack at a generation that isn't A's last: ignored");
  ok((await codeOf(ack(f, await ackOf(f, A, tB, { gen: 2 })))) === "ok" && (await pending(X)).acked === 1, "G-7: A's ack at its last generation (from_gen, 2): accepted after B's grant");
  const w = await world();
  const gB2 = await grantOf(w.f, w.B, 1, [agentEntry(w.X)]);
  const tB2 = await transferOf(w.f, w.X, w.A, w.B, gB2);
  await apply(w.f, gB2, [tB2]);
  await apply(w.f, await grantOf(w.f, w.B, 2, [agentEntry(w.X, { name: "on-b" })]));
  ok((await codeOf(ack(w.f, await ackOf(w.f, w.A, tB2, { gen: 2 })))) === "not_accepted", "G-7: an ack at B's new generation (2), not A's (1): ignored");
}

// ---- G-8: dropped agents are retired; their clock and pending rows stay (§2.1 step 7)
{
  const { f, A, B, C, X } = await world();
  const Y = core.newId(), Z = core.newId();
  await apply(f, await grantOf(f, A, 2, [agentEntry(X), agentEntry(Y), agentEntry(Z)]));
  await lease(f, X, A, 1, NOW);
  // Y moves away to B first; Z stays
  const gB = await grantOf(f, B, 1, [agentEntry(Y)]);
  await apply(f, gB, [await transferOf(f, Y, A, B, gB)]);
  await exec("INSERT INTO lease_pending (agent, from_host, to_host, transfer, acked) VALUES (?1, ?2, ?3, ?4, 0)", X, C.host, A.host, rand(32));
  const keep = JSON.stringify([await all("SELECT * FROM lease_clock WHERE agent = ?1", X), await all("SELECT * FROM lease_pending WHERE agent = ?1", X)]);
  const yBefore = JSON.stringify([await binding(Y), await pending(Y)]);
  ok((await codeOf(apply(f, await grantOf(f, A, 3, [agentEntry(Z)])))) === "ok", "G-8: a grant dropping X (bound here) and Y (moved away)");
  ok((await binding(X)) === null && (await all("SELECT 1 FROM fleet_retired_agents WHERE fleet = ?1 AND agent = ?2", f.fleet, X)).length === 1, "G-8: X's binding is gone and X is retired");
  ok(JSON.stringify([await all("SELECT * FROM lease_clock WHERE agent = ?1", X), await all("SELECT * FROM lease_pending WHERE agent = ?1", X)]) === keep, "G-8: X's lease_clock and lease_pending rows are byte-unchanged");
  ok(JSON.stringify([await binding(Y), await pending(Y)]) === yBefore && (await all("SELECT 1 FROM fleet_retired_agents WHERE agent = ?1", Y)).length === 0, "G-8: Y, which moved away, is untouched");
  ok((await leaseCode(f, X, A, 1, NOW + 1)) === "not_granted", "G-8: X's next lease: not_granted");
  const gC = await grantOf(f, C, 1, [agentEntry(X)]);
  ok((await codeOf(apply(f, gC, [await transferOf(f, X, A, C, gC)]))) === "not_granted", "G-8: a transfer of X: not_granted");
  ok((await codeOf(apply(f, await grantOf(f, A, 4, [agentEntry(Z), agentEntry(X)])))) === "not_granted", "G-8: a later grant re-adding X: not_granted");
  ok((await codeOf(apply(f, await grantOf(f, C, 1, [agentEntry(X)])))) === "not_granted", "G-8: or adding it on another host: not_granted");
  // fleet scoping: a retired id in F doesn't block G
  const g = await fleetOf();
  const P = await hostOf(g);
  await exec("INSERT INTO fleet_retired_agents (fleet, agent) VALUES (?1, ?2)", g.fleet, core.newId());
  const fresh = core.newId();
  await exec("INSERT INTO fleet_retired_agents (fleet, agent) VALUES (?1, ?2)", f.fleet, fresh);
  ok((await codeOf(apply(g, await grantOf(g, P, 1, [agentEntry(fresh)])))) === "ok", "G-8: an id retired in another fleet doesn't block this one");
}

// ---- G-9: fleet scoping of nonces
{
  const a = await world(), b = await world();
  const n = rand(16);
  const gBa = await grantOf(a.f, a.B, 1, [agentEntry(a.X)]), gBb = await grantOf(b.f, b.B, 1, [agentEntry(b.X)]);
  ok((await codeOf(apply(a.f, gBa, [await transferOf(a.f, a.X, a.A, a.B, gBa, { nonce: n })]))) === "ok", "G-9: a nonce in fleet F");
  ok((await codeOf(apply(b.f, gBb, [await transferOf(b.f, b.X, b.A, b.B, gBb, { nonce: n })]))) === "ok", "G-9: the same nonce in fleet G: accepted");
}

// ---- G-10: races between the verification and the batch, in both orders (§2.4)
{
  // a device removal vs a grant it signed: the batch after the removal re-verifies and refuses
  {
    const f = await fleetOf();
    const D = await key(), dId = core.newId();
    await f.append(await core.sealAdd(f.sN, f.body("add", { device: { id: dId, alg: "ed25519", key: core.b64(D.raw), name: "laptop", tier: "native" } }), f.N, D));
    const A = await hostOf(f);
    const g = await grantOf(f, A, 1, [agentEntry(core.newId())], { by: { s: { kind: "device", id: dId, alg: "ed25519", key: D.key }, k: D } });
    let attempts = 0;
    const got = await codeOf(apply(f, g, [], { hooks: { beforeBatch: async () => { if (attempts++ === 0) await f.append(await f.entry("remove", { remove: dId, regrants: [] })); } } }));
    ok(got === "device_removed" && (await all("SELECT 1 FROM fleet_grants WHERE fleet = ?1", f.fleet)).length === 0, "G-10: a signer removed between verification and batch: re-verified, device_removed, nothing written", got);
    // the other order: applied before the removal stays applied
    const g2 = await fleetOf();
    const D2 = await key(), d2 = core.newId();
    await g2.append(await core.sealAdd(g2.sN, g2.body("add", { device: { id: d2, alg: "ed25519", key: core.b64(D2.raw), name: "laptop", tier: "native" } }), g2.N, D2));
    const A2 = await hostOf(g2);
    ok((await codeOf(apply(g2, await grantOf(g2, A2, 1, [agentEntry(core.newId())], { by: { s: { kind: "device", id: d2, alg: "ed25519", key: D2.key }, k: D2 } })))) === "ok", "G-10: the grant before the removal: applied");
    await g2.append(await g2.entry("remove", { remove: d2, regrants: [] }));
    ok((await all("SELECT 1 FROM fleet_grants WHERE fleet = ?1", g2.fleet)).length === 1, "G-10: and stays applied after it");
  }
  // the native policy turned on vs a browser-signed widening grant
  {
    const f = await fleetOf();
    const A = await hostOf(f);
    let attempts = 0;
    const got = await codeOf(apply(f, await grantOf(f, A, 1, [agentEntry(core.newId())], { by: f.browser }), [], { hooks: { beforeBatch: async () => { if (attempts++ === 0) await f.append(await f.entry("policy", { policy: { require_native_for_widening: true } })); } } }));
    // (the first batch saw the moved head; the second verification refused before any second batch)
    ok(got === "device_tier" && attempts === 1 && (await all("SELECT 1 FROM fleet_grants WHERE fleet = ?1", f.fleet)).length === 0, "G-10: the native policy turned on between verification and batch: device_tier on re-verification, nothing written", { got, attempts });
  }
  // an unrelated head advance (a lease-key rotation): verified again, applied on the second batch
  {
    const { f, B, X, A } = await world();
    const gB = await grantOf(f, B, 1, [agentEntry(X)]);
    const t = await transferOf(f, X, A, B, gB);
    let attempts = 0;
    const r = await apply(f, gB, [t], { hooks: { beforeBatch: async () => { if (attempts++ === 0) { const L = await key(); await f.append(await f.entry("lease-key", { lease_key: { id: core.newId(), alg: "ed25519", key: core.b64(L.raw) } })); } } } });
    const st = await W.loadChain(db, core, f.fleet, AUD);
    const v = r.ok && await core.verifyTransferReceipt({ transfer: core.enc(r.pairs[0].transfer), receipt: core.enc(r.pairs[0].receipt) }, { aud: AUD, fleet: f.fleet, chain: st.state });
    ok(r.ok && attempts === 2 && v.receipt.chain_seq === st.head.seq, "G-10: a lease-key rotation between verification and batch: re-verified, the receipt signed at the new head", r);
  }
  // a service-key rotation between the pre-signing and the batch: the first envelopes discarded, the new key's committed
  {
    const { f, B, X, A } = await world();
    const gB = await grantOf(f, B, 1, [agentEntry(X)]);
    const t = await transferOf(f, X, A, B, gB);
    const next = await key(), nextId = core.newId();
    const nk = { id: nextId, raw: next.raw, sign: (b) => next.sign(b) };
    let attempts = 0;
    const r = await apply(f, gB, [t], { keys: [f.keys[0], nk], hooks: { beforeBatch: async () => { if (attempts++ === 0) await f.append(await f.entry("service-key", { service_key: { id: nextId, alg: "ed25519", key: core.b64(next.raw) } })); } } });
    const env = r.ok && JSON.parse(r.pairs[0].receipt);
    const stored = (await all("SELECT receipt FROM fleet_transfers WHERE fleet = ?1", f.fleet))[0]?.receipt;
    ok(r.ok && attempts === 2 && env.signer.id === nextId && stored === r.pairs[0].receipt, "G-10: a service-key rotation before the batch: re-signed by the new key, and those bytes stored", env?.signer);
  }
  // a revocation of the new host vs the transfer
  {
    const { f, B, X, A } = await world();
    const gB = await grantOf(f, B, 1, [agentEntry(X)]);
    const t = await transferOf(f, X, A, B, gB);
    const rev = await core.seal("sb.revocation.v1", f.sN, { fleet: f.fleet, aud: AUD, chain_seq: f.seq - 1, what: "host", id: B.host, host: B.host, gen: 1, at_ms: NOW }, f.N);
    const before = JSON.stringify(await binding(X));
    const got = await codeOf(apply(f, gB, [t], { hooks: { beforeBatch: async () => { await W.revoke(db, core, { fleet: f.fleet, aud: AUD, bytes: rev }); } } }));
    ok(got === "host_revoked" && JSON.stringify(await binding(X)) === before, "G-10: the new host revoked between verification and batch: host_revoked, X unmoved", got);
  }
  // a renewal vs the transfer: the renewal after the apply is refused; the apply after a renewal waits on its clock
  {
    const { f, B, X, A, C } = await world();
    const gB = await grantOf(f, B, 1, [agentEntry(X)]);
    const t = await transferOf(f, X, A, B, gB);
    ok((await codeOf(apply(f, gB, [t], { hooks: { beforeBatch: async () => { await lease(f, X, A, 1, NOW); } } }))) === "ok", "G-10: a renewal by A just before the transfer's batch: the transfer applies");
    ok((await leaseCode(f, X, B, 1, NOW + 1)) === "not_granted", "G-10: and B's first lease waits on that renewal's clock");
    ok((await leaseCode(f, X, A, 1, NOW + 2)) === "not_granted", "G-10: A's renewal after the apply: not_granted");
    void C;
  }
  // an ack vs a second move: the ack lands between the second move's verification and its batch
  {
    const { f, A, B, C, X } = await world();
    await lease(f, X, A, 1, NOW);
    const gB = await grantOf(f, B, 1, [agentEntry(X)]);
    const tB = await transferOf(f, X, A, B, gB);
    await apply(f, gB, [tB]);
    const gC = await grantOf(f, C, 1, [agentEntry(X)]);
    const ackBytes = await ackOf(f, A, tB, { gen: 1 });
    ok((await codeOf(apply(f, gC, [await transferOf(f, X, B, C, gC)], { hooks: { beforeBatch: async () => { await ack(f, ackBytes); } } }))) === "ok", "G-10: A's ack landing just before B -> C's batch: the move applies (the gate it read is open)");
    ok((await pending(X)).acked === 0 && (await pending(X)).from_host === B.host, "G-10: and the new pending row is unacked");
  }
  // identical requests at once: one applies, the other is its stored result
  {
    const { f, B, X, A } = await world();
    const gB = await grantOf(f, B, 1, [agentEntry(X)]);
    const t = await transferOf(f, X, A, B, gB);
    let inner = null;
    const r = await apply(f, gB, [t], { hooks: { beforeBatch: async (attempt) => { if (attempt === 0 && !inner) inner = await apply(f, gB, [t]); } } });
    ok(inner?.ok && !inner.replayed && r.ok && r.replayed && JSON.stringify(r.pairs) === JSON.stringify(inner.pairs), "G-10: the same request racing its first apply: the stored pairs, no second effect", { inner, r });
    ok((await all("SELECT 1 FROM fleet_transfers WHERE fleet = ?1", f.fleet)).length === 1, "G-10: one transfer row");
  }
  // a newer grant for the host lands between verification and batch: verified again against it
  {
    const { f, A, X } = await world();
    const Y = core.newId();
    let attempts = 0;
    const got = await codeOf(apply(f, await grantOf(f, A, 3, [agentEntry(X)]), [], { hooks: { beforeBatch: async () => { if (attempts++ === 0) await apply(f, await grantOf(f, A, 2, [agentEntry(X), agentEntry(Y)])); } } }));
    ok(got === "ok" && attempts === 2, "G-10: a grant at gen 2 landing before gen 3's batch: gen 3 re-verified and applied", got);
    ok((await binding(Y)) === null && (await all("SELECT 1 FROM fleet_retired_agents WHERE agent = ?1", Y)).length === 1, "G-10: and Y, which gen 2 added and gen 3 drops, is retired");
  }
}

// ---- G-11: the gate's SQL is the lease batch's fragment, and its NULL traps refuse the move
{
  ok(W.PENDING_GATE_CLOSED_SQL.includes(S.GATE_OPEN_SQL), "G-11: the decision's gate contains GATE_OPEN_SQL verbatim");
  // (on unconstrained tables, a NULL acked or a NULL expires_at must keep the gate closed, so the move is refused)
  const lite = new DatabaseSync(":memory:");
  lite.exec("CREATE TABLE lease_pending (agent, from_host, to_host, transfer, acked); CREATE TABLE lease_clock (agent, host, expires_at, lease_id, gen, request)");
  const closed = (now) => lite.prepare(`SELECT ${W.PENDING_GATE_CLOSED_SQL} AS c`).get(null, "x", null, null, null, null, null, now).c;
  const reset = () => lite.exec("DELETE FROM lease_pending; DELETE FROM lease_clock");
  reset();
  lite.exec("INSERT INTO lease_pending VALUES ('x', 'a', 'b', 't', NULL); INSERT INTO lease_clock VALUES ('x', 'a', 1000, 'l', 1, 'r')");
  ok(closed(1000 + MARGIN) === 1 && closed(1000 + MARGIN + 1) === 0, "G-11: an acked NULL counts as not acked (closed at the margin, open past it)");
  reset();
  lite.exec("INSERT INTO lease_pending VALUES ('x', 'a', 'b', 't', 0); INSERT INTO lease_clock VALUES ('x', 'a', NULL, 'l', 1, 'r')");
  ok(closed(9e15) === 1, "G-11: an expires_at NULL never opens the gate");
  reset();
  lite.exec("INSERT INTO lease_pending VALUES ('x', 'a', 'b', 't', 0)");
  ok(closed(0) === 0, "G-11: an old host that never held a lease: open");
  reset();
  ok(closed(0) === 0, "G-11: no pending row: nothing to wait for");
}

// ---- G-12: receipts: a refused request stores none; a signing failure is a throw with nothing written
{
  const { f, B, X, A } = await world();
  const gB = await grantOf(f, B, 1, [agentEntry(X)]);
  const t = await transferOf(f, X, A, B, gB);
  const before = await snapshot();
  const bad = [{ ...f.keys[0], sign: () => { throw new Error("the signer is down"); } }];
  const got = await codeOf(apply(f, gB, [t], { keys: bad }));
  ok(got.startsWith("threw:") && (await snapshot()) === before, "G-12: a signing failure before the batch: thrown (503), nothing written", got);
  ok((await codeOf(apply(f, gB, [await transferOf(f, X, A, B, gB, { gen: 2 })]))) === "stale_generation" && (await all("SELECT 1 FROM fleet_transfers WHERE fleet = ?1", f.fleet)).length === 0, "G-12: a refused request: no receipt stored");
  // the answer lost after the commit: a retry is served the stored bytes
  const first = await apply(f, gB, [t]);
  const retry = await apply(f, gB, [t]);
  ok(first.ok && retry.replayed && retry.pairs[0].receipt === first.pairs[0].receipt, "G-12: the answer lost: the retry gets the stored receipt");
}

// ---- G-14: revocation and grants, in both orders: nothing ever un-revokes (§4)
{
  const revokeAgent = async (f, id) => W.revoke(db, core, { fleet: f.fleet, aud: AUD, bytes: await core.seal("sb.revocation.v1", f.sN, { fleet: f.fleet, aud: AUD, chain_seq: f.seq - 1, what: "agent", id, host: id, gen: 1, at_ms: NOW }, f.N) });
  // revoke an id never seen, then grant it: born revoked
  const { f, A, B, X } = await world();
  const Y = core.newId();
  await revokeAgent(f, Y);
  ok((await codeOf(apply(f, await grantOf(f, A, 2, [agentEntry(X), agentEntry(Y)])))) === "ok" && (await binding(Y)).revoked === 1, "G-14: revoke, then grant: the binding is born revoked");
  ok((await leaseCode(f, Y, A, 2, NOW)) === "agent_revoked", "G-14: and its lease is refused");
  // grant, revoke, grant again (a changed entry): stays revoked
  await revokeAgent(f, X);
  ok((await codeOf(apply(f, await grantOf(f, A, 3, [agentEntry(X, { name: "again" }), agentEntry(Y)])))) === "ok" && (await binding(X)).revoked === 1, "G-14: grant, revoke, re-grant: stays revoked");
  // a revoked agent never moves, whichever order the revocation came in
  const gB = await grantOf(f, B, 1, [agentEntry(X)]);
  const before = await snapshot();
  ok((await codeOf(apply(f, gB, [await transferOf(f, X, A, B, gB)]))) === "agent_revoked" && (await snapshot()) === before, "G-14: a transfer of a revoked agent: agent_revoked, nothing written");
  const w = await world();
  const gB2 = await grantOf(w.f, w.B, 1, [agentEntry(w.X)]);
  const t = await transferOf(w.f, w.X, w.A, w.B, gB2);
  const b2 = await snapshot();
  const got = await codeOf(apply(w.f, gB2, [t], { hooks: { beforeBatch: async () => { await revokeAgent(w.f, w.X); } } }));
  const b3 = await snapshot();
  ok(got === "agent_revoked" && (await binding(w.X)).host === w.A.host && b3 !== b2, "G-14: revoked between the transfer's verification and its batch: agent_revoked, X unmoved", got);
}

// ---- G-15: the batch's own generation check, and a revocation flag the store already holds
{
  // a FRESH transfer naming a grant the host already accepted: not a retry, and refused by the batch's generation rule
  const { f, A, B, C, X } = await world();
  const gB = await grantOf(f, B, 1, [agentEntry(X)]);
  const tB = await transferOf(f, X, A, B, gB);
  await apply(f, gB, [tB]);
  await ack(f, await ackOf(f, A, tB, { gen: 1 }));
  const gC = await grantOf(f, C, 1, [agentEntry(X)]);
  ok((await codeOf(apply(f, gC, [await transferOf(f, X, B, C, gC)]))) === "ok", "G-15: X moved on to C");
  const before = await snapshot();
  ok((await codeOf(apply(f, gB, [await transferOf(f, X, C, B, gB)]))) === "stale_generation" && (await snapshot()) === before,
    "G-15: a fresh transfer back to B naming B's already-accepted gen 1: stale_generation, nothing written");
  // a binding already flagged revoked (whatever wrote it) is never lowered by a grant
  const w = await world();
  await exec("UPDATE fleet_agents SET revoked = 1 WHERE agent = ?1", w.X);
  ok((await codeOf(apply(w.f, await grantOf(w.f, w.A, 2, [agentEntry(w.X, { name: "changed" })])))) === "ok" && (await binding(w.X)).revoked === 1,
    "G-15: a re-grant over a binding flagged revoked keeps it revoked, with no revocation row behind it");
}

// ---- G-13: a failure at EACH statement of the grant batch and of the ack batch rolls the whole batch back
const failing = (i, seen) => ({ prepare: (s) => db.prepare(s), batch: (stmts) => { seen.n = stmts.length; const b = [...stmts]; if (i < b.length) b[i] = db.prepare("SELECT json_extract('broken', '$')"); return db.batch(b); } });
{
  const { f, A, B, X } = await world();
  await lease(f, X, A, 1, NOW);
  // a request that exercises every statement kind: two transfers, a drop, an unchanged and a new agent
  const Y = core.newId(), Z = core.newId(), V = core.newId();
  await apply(f, await grantOf(f, A, 2, [agentEntry(X), agentEntry(Y)]));
  await apply(f, await grantOf(f, B, 1, [agentEntry(Z), agentEntry(V)]));
  const gB = await grantOf(f, B, 2, [agentEntry(Z), agentEntry(X), agentEntry(Y), agentEntry(core.newId())]);
  const ts = [await transferOf(f, X, A, B, gB), await transferOf(f, Y, A, B, gB)];
  const seen = { n: 0 };
  let i = 0;
  for (;;) {
    const before = await snapshot();
    const got = await codeOf(apply(f, gB, ts, { dbx: failing(i, seen) }));
    if (i >= seen.n) break;
    ok(got.startsWith("threw:") && (await snapshot()) === before, `G-13: the grant batch's statement ${i + 1} of ${seen.n} failing: nothing written`, got);
    i++;
  }
  ok(seen.n > 20 && i === seen.n, "G-13: every statement of the grant batch was faulted", seen);
  const r = await apply(f, gB, ts);
  ok(r.ok && (await binding(V)) === null && (await binding(X)).host === B.host, "G-13: and the same request then applies (V dropped, X moved)", r);
  const b7 = await snapshot();
  ok((await apply(f, gB, ts)).replayed === true && (await snapshot()) === b7, "G-13: its exact retry: the stored pairs");
  ok((await codeOf(apply(f, gB, [ts[1], ts[0]]))) === "replay" && (await snapshot()) === b7, "G-13: the same transfers in another order: not a retry (replay), nothing written");
  for (let j = 0; j < 2; j++) {
    const before = await snapshot();
    const got = await codeOf(ack(f, await ackOf(f, A, ts[0], { gen: 1 }), failing(j, {})));
    ok(got.startsWith("threw:") && (await snapshot()) === before, `G-13: the ack batch's statement ${j + 1} failing: nothing written (the ack and acked together)`, got);
  }
}

await mf.dispose();
console.log(`${count - failures}/${count} passed`);
if (failures) process.exit(1);
