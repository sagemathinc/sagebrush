// ci: web-sync.1 order=13
// Tests for the fleet Worker's first writers (web/cloud/fleet/writers.ts; writers design W2 r4.2, W2a): the device
// chain's append, host pairing and revocation, on a real D1 (FLEET_DB) in Miniflare with both migrations, through the
// mirrored core's own verifiers. Seams run between a writer's verification and its batch, so every head race is tested
// in both orders. writers.ts is bundled with bun (as the Worker is).
//   node web/cloud/fleet/test-fleet-writers.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as core from "../../workspace/fleet/core/index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "../../site/package.json"));
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
core.useCrypto(core.webCrypto());
const SCHEMAS = { "fleet.schema.json": JSON.parse(readFileSync(join(here, "../../workspace/fleet/fleet.schema.json"), "utf8")), "reasons.json": JSON.parse(readFileSync(join(here, "../../workspace/fleet/reasons.json"), "utf8")) };
core.useSchemas((n) => SCHEMAS[n]);
const tmp = mkdtempSync(join(tmpdir(), "fleet-writers-"));
writeFileSync(join(tmp, "writers.mjs"), execFileSync("bun", ["build", join(here, "writers.ts"), "--format", "esm", "--target", "node"], { encoding: "utf8" }));
const W = await import(pathToFileURL(join(tmp, "writers.mjs")).href);
rmSync(tmp, { recursive: true, force: true });

let failures = 0, count = 0;
const ok = (c, what, detail) => { count++; if (!c) { failures++; console.log("FAIL", what, detail === undefined ? "" : JSON.stringify(detail).slice(0, 400)); } };
const codeOf = async (p) => { try { const r = await p; return r.refused ?? (r.ok ? "ok" : JSON.stringify(r)); } catch (e) { return e instanceof core.FleetError ? e.code : `threw: ${e.message}`; } };
const AUD = "https://dev.sagebrush.space";
const NOW = Date.now();
let seedN = 1;
const key = () => core.keyFromSeed(new Uint8Array(32).fill(seedN++));

// ---- the database: both migrations, applied as the deploy does
const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: "fleet", modules: true, script: "export default { fetch() { return new Response('') } }", compatibilityDate: "2026-10-01", d1Databases: ["FLEET_DB"] }] }));
const db = await mf.getD1Database("FLEET_DB");
for (const m of ["0001_fleet_leases.sql", "0002_fleet_writers_chain_hosts.sql"])
  for (const stmt of readFileSync(join(here, "migrations", m), "utf8").replace(/--[^\n]*/g, "").split(";").map((s) => s.trim()).filter(Boolean)) await db.prepare(stmt).run();
const all = async (sql, ...v) => (await db.prepare(sql).bind(...v).all()).results;
const exec = (sql, ...v) => db.prepare(sql).bind(...v).run();
const snapshot = async () => JSON.stringify(await Promise.all(["fleet_chain_entries", "fleet_chain_hashes", "fleet_hosts", "fleet_host_certs", "fleet_revocations", "fleet_agents"].map((t) => all(`SELECT * FROM ${t} ORDER BY 1, 2`))));

// ---- a fleet: its devices and the entries a person's app would sign
async function fleetOf() {
  const fleet = core.newId(), N = await key(), nId = core.newId(), R = await key();
  const sN = { kind: "device", id: nId, alg: "ed25519", key: N.key };
  const f = { fleet, N, nId, sN, seq: 0, head: "" };
  f.body = (op, extra) => ({ fleet, aud: AUD, seq: f.seq, prev: f.head, op, at_ms: NOW, auth_time_ms: NOW, ...extra });
  f.entry = (op, extra, by = { s: sN, k: N }) => core.seal("sb.device-chain.v1", by.s, f.body(op, extra), by.k);
  f.append = async (bytes, hooks) => {
    const r = await W.appendChainEntry(db, core, { fleet, aud: AUD, bytes, now: NOW }, hooks);
    if (r.ok) { const st = await W.loadChain(db, core, fleet, AUD); f.seq = st.head.seq + 1; f.head = st.head.hash; }
    return r;
  };
  f.genesis = f.entry("genesis", { device: { id: nId, alg: "ed25519", key: core.b64(N.raw), name: "mac", tier: "native" }, recovery_key: { alg: "ed25519", key: core.b64(R.raw) } });
  return f;
}
const certOf = async (f, signer, { host = core.newId(), name = "box", chainSeq } = {}) => {
  const H = await key();
  const enc = new Uint8Array(32).fill(seedN++);
  const body = { fleet: f.fleet, aud: AUD, chain_seq: chainSeq ?? f.seq - 1, host, sign_key: core.b64(H.raw), enc_key: core.b64(enc), fingerprint: core.b64(await core.hostFingerprint(host, H.raw, enc)), name, at_ms: NOW };
  return { host, bytes: await core.seal("sb.host-cert.v1", signer.s, body, signer.k) };
};
const revocationOf = (f, what, id, signer = { s: f.sN, k: f.N }) => core.seal("sb.revocation.v1", signer.s, { fleet: f.fleet, aud: AUD, chain_seq: f.seq - 1, what, id, host: id, gen: 1, at_ms: NOW }, signer.k);

// ---- W-1: the chain append
{
  const f = await fleetOf();
  ok((await codeOf(f.append(await f.genesis))) === "ok", "W-1: genesis is appended");
  const D2 = await key(), d2Id = core.newId();
  const add = await core.sealAdd(f.sN, f.body("add", { device: { id: d2Id, alg: "ed25519", key: core.b64(D2.raw), name: "laptop", tier: "native" } }), f.N, D2);
  ok((await codeOf(f.append(add))) === "ok", "W-1: an add is appended at seq 1");
  const st = await W.loadChain(db, core, f.fleet, AUD);
  ok(st.head.seq === 1 && JSON.stringify((await all("SELECT hash FROM fleet_chain_hashes WHERE fleet = ?1 ORDER BY seq", f.fleet)).map((r) => r.hash)) === JSON.stringify(st.state.hashes), "W-1: the stored hashes are the replay's own");
  // (an entry for a seq already taken: the core's own refusal)
  const stale = await core.seal("sb.device-chain.v1", f.sN, { ...f.body("policy", { policy: { require_native_for_widening: true } }), seq: 1, prev: (await all("SELECT hash FROM fleet_chain_hashes WHERE fleet = ?1 AND seq = 0", f.fleet))[0].hash }, f.N);
  ok((await codeOf(f.append(stale))) === "chain_fork", "W-1: an entry for a taken seq: chain_fork");
  ok((await codeOf(f.append(await core.seal("sb.device-chain.v1", f.sN, { ...f.body("policy", { policy: { require_native_for_widening: true } }), auth_time_ms: NOW - 5 * 60_000 - 1 }, f.N)))) === "stale_auth", "W-1: a sign-in older than 5 minutes: stale_auth");
  // the batch's own head CAS: another entry lands between this one's verification and its batch
  const before = await snapshot();
  const mine = await f.entry("policy", { policy: { require_native_for_widening: true } });
  const theirs = await f.entry("policy", { policy: { require_native_for_widening: true } });
  const r = await f.append(mine, { beforeBatch: async () => { await W.appendChainEntry(db, core, { fleet: f.fleet, aud: AUD, bytes: theirs, now: NOW }); } });
  ok(r.refused === "chain_fork", "W-1: an append raced by another at its seq: chain_fork", r);
  const st2 = await W.loadChain(db, core, f.fleet, AUD);
  ok(st2.head.seq === 2 && before !== (await snapshot()), "W-1: exactly the other one landed");
  const ents = await all("SELECT bytes FROM fleet_chain_entries WHERE fleet = ?1 AND seq = 2", f.fleet);
  ok(ents.length === 1 && ents[0].bytes === new TextDecoder().decode(theirs), "W-1: and ours wrote nothing");
}

// ---- W-2: pairing (a host id's keys are immutable)
{
  const f = await fleetOf();
  await f.append(await f.genesis);
  const signer = { s: f.sN, k: f.N };
  const c = await certOf(f, signer);
  const r = await W.pairHost(db, core, { fleet: f.fleet, aud: AUD, bytes: c.bytes });
  ok(r.ok && r.created && r.host === c.host, "W-2: a new host is paired", r);
  const row = (await all("SELECT fleet, revoked FROM fleet_hosts WHERE host = ?1", c.host))[0];
  ok(row?.fleet === f.fleet && row.revoked === 0, "W-2: its row", row);
  const before = await snapshot();
  const again = await W.pairHost(db, core, { fleet: f.fleet, aud: AUD, bytes: c.bytes });
  ok(again.ok && again.created === false && (await snapshot()) === before, "W-2: the byte-identical certificate again: accepted, nothing changed", again);
  const other = await certOf(f, signer, { host: c.host, name: "other" });
  ok((await codeOf(W.pairHost(db, core, { fleet: f.fleet, aud: AUD, bytes: other.bytes }))) === "bad_form", "W-2: another certificate for a paired id: refused");
  ok((await snapshot()) === before, "W-2: and the row is never rebound");
  const g = await fleetOf();
  await g.append(await g.genesis);
  const cross = await certOf(g, { s: g.sN, k: g.N }, { host: c.host });
  ok((await codeOf(W.pairHost(db, core, { fleet: g.fleet, aud: AUD, bytes: cross.bytes }))) === "bad_form", "W-2: the same host id in another fleet: refused");
  ok((await codeOf(W.pairHost(db, core, { fleet: core.newId(), aud: AUD, bytes: c.bytes }))) === "not_granted", "W-2: a fleet with no chain: not_granted");
}

// ---- W-3: revocation, durable and never undone
{
  const f = await fleetOf();
  await f.append(await f.genesis);
  const signer = { s: f.sN, k: f.N };
  // revoke, then pair: born revoked
  const c1 = await certOf(f, signer);
  ok((await codeOf(W.revoke(db, core, { fleet: f.fleet, aud: AUD, bytes: await revocationOf(f, "host", c1.host) }))) === "ok", "W-3: a revocation of an id never seen is recorded");
  await W.pairHost(db, core, { fleet: f.fleet, aud: AUD, bytes: c1.bytes });
  ok((await all("SELECT revoked FROM fleet_hosts WHERE host = ?1", c1.host))[0]?.revoked === 1, "W-3: revoke then pair: the host is born revoked");
  // pair, revoke, pair the same bytes again: stays revoked
  const c2 = await certOf(f, signer);
  await W.pairHost(db, core, { fleet: f.fleet, aud: AUD, bytes: c2.bytes });
  await W.revoke(db, core, { fleet: f.fleet, aud: AUD, bytes: await revocationOf(f, "host", c2.host) });
  await W.pairHost(db, core, { fleet: f.fleet, aud: AUD, bytes: c2.bytes });
  ok((await all("SELECT revoked FROM fleet_hosts WHERE host = ?1", c2.host))[0]?.revoked === 1, "W-3: pair, revoke, pair again: stays revoked");
  // an agent's revocation sets its row's flag
  const agent = core.newId();
  await exec("INSERT INTO fleet_agents (agent, fleet, host, entry_gen, revoked) VALUES (?1, ?2, ?3, 1, 0)", agent, f.fleet, c2.host);
  await W.revoke(db, core, { fleet: f.fleet, aud: AUD, bytes: await revocationOf(f, "agent", agent) });
  ok((await all("SELECT revoked FROM fleet_agents WHERE agent = ?1", agent))[0]?.revoked === 1, "W-3: an agent's revocation sets its flag");
  // fleet scoping: the same id revoked in two fleets is two rows; one fleet's doesn't touch the other's
  const g = await fleetOf();
  await g.append(await g.genesis);
  const id = core.newId();
  await W.revoke(db, core, { fleet: f.fleet, aud: AUD, bytes: await revocationOf(f, "agent", id) });
  ok((await all("SELECT fleet FROM fleet_revocations WHERE id = ?1", id)).length === 1, "W-3: a revocation in one fleet only");
  await W.revoke(db, core, { fleet: g.fleet, aud: AUD, bytes: await revocationOf(g, "agent", id) });
  ok((await all("SELECT fleet FROM fleet_revocations WHERE id = ?1", id)).length === 2, "W-3: the same id in another fleet is its own row");
  ok((await codeOf(W.revoke(db, core, { fleet: f.fleet, aud: AUD, bytes: await revocationOf(f, "package", id) }))) === "bad_form", "W-3: a package's revocation isn't these writers'");
}

// ---- W-4: the chain head, compared by the pairing batch, in both orders (§2.4)
{
  const f = await fleetOf();
  await f.append(await f.genesis);
  const D2 = await key(), d2Id = core.newId();
  await f.append(await core.sealAdd(f.sN, f.body("add", { device: { id: d2Id, alg: "ed25519", key: core.b64(D2.raw), name: "laptop", tier: "native" } }), f.N, D2));
  const d2 = { s: { kind: "device", id: d2Id, alg: "ed25519", key: D2.key }, k: D2 };
  // the removal of the certificate's signer lands between the verification and the batch: refused, then re-verified
  const c = await certOf(f, d2);
  const removal = await f.entry("remove", { remove: d2Id, regrants: [] });
  let moved = false;
  const got = await codeOf(W.pairHost(db, core, { fleet: f.fleet, aud: AUD, bytes: c.bytes }, { beforeBatch: async (n) => { if (n === 0) { await f.append(removal); moved = true; } } }));
  ok(moved && got === "device_removed", "W-4: a signer removed between verification and batch: the re-verification refuses (device_removed)", got);
  ok((await all("SELECT 1 FROM fleet_hosts WHERE host = ?1", c.host)).length === 0, "W-4: and nothing was paired");
  // the other order: paired first, then the removal: the pairing stands
  const g = await fleetOf();
  await g.append(await g.genesis);
  const E2 = await key(), e2Id = core.newId();
  await g.append(await core.sealAdd(g.sN, g.body("add", { device: { id: e2Id, alg: "ed25519", key: core.b64(E2.raw), name: "laptop", tier: "native" } }), g.N, E2));
  const e2 = { s: { kind: "device", id: e2Id, alg: "ed25519", key: E2.key }, k: E2 };
  const c2 = await certOf(g, e2);
  ok((await codeOf(W.pairHost(db, core, { fleet: g.fleet, aud: AUD, bytes: c2.bytes }))) === "ok", "W-4: paired before the removal");
  await g.append(await g.entry("remove", { remove: e2Id, regrants: [] }));
  ok((await all("SELECT 1 FROM fleet_hosts WHERE host = ?1", c2.host)).length === 1, "W-4: and the removal after it doesn't unpair it");
  // an unrelated head advance between verification and batch: the re-verification passes, and the second batch pairs it
  const c3 = await certOf(g, { s: g.sN, k: g.N });
  const policy = await g.entry("policy", { policy: { require_native_for_widening: true } });
  let attempts = 0;
  const r3 = await W.pairHost(db, core, { fleet: g.fleet, aud: AUD, bytes: c3.bytes }, { beforeBatch: async (n) => { attempts = n + 1; if (n === 0) await g.append(policy); } });
  ok(r3.ok && r3.created && attempts === 2, "W-4: an unrelated head advance: verified again and paired on the second batch", { r3, attempts });
  // moved on both attempts: a 503 (thrown), nothing paired
  const c4 = await certOf(g, { s: g.sN, k: g.N });
  const p1 = await g.entry("policy", { policy: { require_native_for_widening: true } });
  let p2 = null;
  const got4 = await codeOf(W.pairHost(db, core, { fleet: g.fleet, aud: AUD, bytes: c4.bytes }, { beforeBatch: async (n) => { if (n === 0) await g.append(p1); else { p2 = await g.entry("policy", { policy: { require_native_for_widening: true } }); await g.append(p2); } } }));
  ok(got4.startsWith("threw:") && (await all("SELECT 1 FROM fleet_hosts WHERE host = ?1", c4.host)).length === 0, "W-4: the head moving twice: thrown (503), nothing paired", got4);
}

// ---- W-5: a failure inside the pairing batch rolls it back whole
{
  const f = await fleetOf();
  await f.append(await f.genesis);
  const c = await certOf(f, { s: f.sN, k: f.N });
  const before = await snapshot();
  await exec("CREATE TRIGGER t_fail BEFORE INSERT ON fleet_host_certs BEGIN SELECT RAISE(ABORT, 'injected'); END");
  const got = await codeOf(W.pairHost(db, core, { fleet: f.fleet, aud: AUD, bytes: c.bytes }));
  await exec("DROP TRIGGER t_fail");
  ok(got.startsWith("threw:") && (await snapshot()) === before, "W-5: the certificate's insert failing: the host's row is rolled back too", got);
}

// ---- W-6: a failure at EACH statement of each writer's batch rolls the whole batch back (snapshot unchanged)
// (a statement is swapped for one that fails at run time, as the real D1 batch runs it)
const failing = (i) => ({ prepare: (s) => db.prepare(s), batch: (stmts) => { const b = [...stmts]; b[i] = db.prepare("SELECT json_extract('broken', '$')"); return db.batch(b); } });
{
  for (let i = 0; i < 2; i++) {
    const f = await fleetOf();
    await f.append(await f.genesis);
    const e = await f.entry("policy", { policy: { require_native_for_widening: true } });
    const before = await snapshot();
    const got = await codeOf(W.appendChainEntry(failing(i), core, { fleet: f.fleet, aud: AUD, bytes: e, now: NOW }));
    ok(got.startsWith("threw:") && (await snapshot()) === before, `W-6: the append's statement ${i + 1} failing: nothing written (entry and hash together)`, got);
  }
  for (let i = 0; i < 3; i++) {
    const f = await fleetOf();
    await f.append(await f.genesis);
    const c = await certOf(f, { s: f.sN, k: f.N });
    const before = await snapshot();
    const got = await codeOf(W.pairHost(failing(i), core, { fleet: f.fleet, aud: AUD, bytes: c.bytes }));
    ok(got.startsWith("threw:") && (await snapshot()) === before, `W-6: the pairing's statement ${i + 1} failing: nothing written (host and certificate together)`, got);
  }
  for (let i = 0; i < 2; i++) {
    const f = await fleetOf();
    await f.append(await f.genesis);
    const c = await certOf(f, { s: f.sN, k: f.N });
    await W.pairHost(db, core, { fleet: f.fleet, aud: AUD, bytes: c.bytes });
    const before = await snapshot();
    const got = await codeOf(W.revoke(failing(i), core, { fleet: f.fleet, aud: AUD, bytes: await revocationOf(f, "host", c.host) }));
    ok(got.startsWith("threw:") && (await snapshot()) === before, `W-6: the revocation's statement ${i + 1} failing: nothing written (marker and flag together)`, got);
  }
}

await mf.dispose();
console.log(`${count - failures}/${count} passed`);
if (failures) process.exit(1);
