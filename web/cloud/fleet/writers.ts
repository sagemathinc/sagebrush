// The fleet Worker's writers (writers design W2 r4.2): the device chain's append, host pairing and revocation (W2a), a
// host's grant with the transfers of the agents it adds, and the old host's fence ack (W2b). Each decision is ONE D1
// batch whose conditions are evaluated inside it. The core verifies every envelope first and is passed in (the Worker
// reaches it only through its installer, in server.ts). A widening batch (an append, a pairing, a grant) carries the
// chain head it was verified against and writes nothing if the head has moved (§2.4); the caller then re-reads the chain
// and verifies once more. A revocation only narrows: it needs no head, and nothing ever undoes it.
import { GATE_OPEN_SQL, type D1 } from "./store.ts";

/** The parts of the fleet core these writers use (the mirrored core's own functions). */
export interface WriterCore {
  replayChain(entries: Uint8Array[], ctx: { aud: string; fleet: string }): Promise<{ seq: number; head: string; hashes: string[] }>;
  applyChainEntry(state: unknown, bytes: Uint8Array, ctx: Record<string, unknown>): Promise<{ state: { seq: number; head: string } }>;
  verifyHostCert(bytes: Uint8Array, ctx: Record<string, unknown>): Promise<{ body: { host: string; fleet: string; sign_key: string; fingerprint: string }; hash: string }>;
  verifyRevocation(bytes: Uint8Array, ctx: Record<string, unknown>): Promise<{ what: string; id: string; fleet: string }>;
  enc(s: string): Uint8Array;
  refuse(code: string, message?: string): never;
  // (W2b)
  openByDevice(bytes: Uint8Array, ctx: Record<string, unknown>, type: string, schema: string): Promise<{ body: any; signed: Uint8Array; device: unknown }>;
  verifyGrant(bytes: Uint8Array, ctx: Record<string, unknown>): Promise<{ body: Grant; reapply: boolean; widens: boolean; hash: string }>;
  verifyAgentTransfer(bytes: Uint8Array, ctx: Record<string, unknown>): Promise<{ body: Transfer; hash: string }>;
  verifyFenceAck(bytes: Uint8Array, ctx: Record<string, unknown>): Promise<{ body: FenceAck; hash: string }>;
  serviceKeyAt(state: unknown, signer: Signer, chainSeq: number): Uint8Array;
  signedBytes(type: string, signer: Signer, body: unknown): Uint8Array;
  bodyValidator(name: string): (body: unknown) => void;
  canonText(value: unknown, max?: number): string;
  parseCanonical(bytes: Uint8Array, max?: number): any;
  sha256b64(bytes: Uint8Array): Promise<string>;
  keyId(alg: string, raw: Uint8Array): Promise<string>;
  b64(bytes: Uint8Array): string;
  unb64(s: string, n: number): Uint8Array;
  newId(): string;
}

type Signer = { kind: string; id: string; alg: string; key: string };
type GrantAgent = { agent: string } & Record<string, unknown>;
type Grant = { fleet: string; host: string; gen: number; agents: GrantAgent[] } & Record<string, unknown>;
type Transfer = { fleet: string; aud: string; agent: string; from_host: string; to_host: string; to_host_key: string; gen: number; grant: string; nonce: string;
  chain_seq: number; at_ms: number; not_after_ms: number; auth_time_ms: number };
type FenceAck = { fleet: string; agent: string; host: string; gen: number; transfer: string; proven_empty: boolean; at_ms: number };

export interface Head { seq: number; hash: string }
/** Test seams (the tests only; the Worker passes none): runs after the verification, immediately before the batch. */
export interface WriterHooks { beforeBatch?: (attempt: number) => Promise<void> }
type Chain = { state: Awaited<ReturnType<WriterCore["replayChain"]>>; head: Head } | null;

/** The chain-head CAS, with its three parameters at ?F, ?S, ?H of the statement it is placed in (§2.4). */
export const headCas = (f: number, s: number, h: number) =>
  `EXISTS (SELECT 1 FROM fleet_chain_hashes WHERE fleet = ?${f} AND seq = ?${s} AND hash = ?${h})` +
  ` AND NOT EXISTS (SELECT 1 FROM fleet_chain_hashes WHERE fleet = ?${f} AND seq > ?${s})`;

/** A fleet's chain as stored, replayed by the core; its stored hashes must be the replay's own (else: corrupt). */
export async function loadChain(db: D1, core: WriterCore, fleet: string, aud: string): Promise<Chain> {
  const rows = (await db.prepare("SELECT e.seq AS seq, e.bytes AS bytes, h.hash AS hash FROM fleet_chain_entries e LEFT JOIN fleet_chain_hashes h ON h.fleet = e.fleet AND h.seq = e.seq WHERE e.fleet = ?1 ORDER BY e.seq")
    .bind(fleet).all<{ seq: number; bytes: string; hash: string | null }>()).results;
  if (rows.length === 0) return null;
  const state = await core.replayChain(rows.map((r) => core.enc(r.bytes)), { aud, fleet });
  rows.forEach((r, i) => { if (r.seq !== i || r.hash !== state.hashes[i]) throw new Error("the stored chain's hashes aren't its own"); });
  return { state, head: { seq: state.seq, hash: state.head } };
}

const text = (b: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(b);
/** The reads scope r4 §3.1: at most this many hosts in a fleet, enforced inside the pairing batch. */
export const HOSTS_MAX = 64;

/**
 * Append one chain entry under the person's `account` (the reads scope r4 §1): the core checks it against the stored
 * chain (auth_time included), then ONE batch. A genesis binds the fleet to the account in that batch, only if neither
 * is bound yet; every entry (genesis or later) is inserted only while the fleet is bound to exactly this account. The
 * read-back decides: ok, or not_found (another account's fleet: the same answer as for any fleet that isn't yours),
 * not_granted (this account already has another fleet), or chain_fork (this account's own conflicting entry).
 */
export async function appendChainEntry(db: D1, core: WriterCore, input: { fleet: string; aud: string; bytes: Uint8Array; now: number; account: string }, hooks: WriterHooks = {}): Promise<{ ok: true; seq: number } | { refused: string }> {
  // (a later entry is judged only for the fleet's own account, before its chain is read)
  const owner = await db.prepare("SELECT account FROM fleet_accounts WHERE fleet = ?1").bind(input.fleet).first<{ account: string }>();
  if (owner && owner.account !== input.account) return { refused: "not_found" };
  // (the entry's own seq, before the core reads anything: a later entry for a fleet nobody owns is no fleet of yours,
  // and this account's own second genesis is a fork of its chain)
  let seq: unknown = null;
  try { seq = core.parseCanonical(input.bytes)?.body?.seq; } catch { /* (the core refuses the form below) */ }
  if (!owner && typeof seq === "number" && seq !== 0) return { refused: "not_found" };
  if (owner && seq === 0) return { refused: "chain_fork" };
  const chain = owner ? await loadChain(db, core, input.fleet, input.aud) : null;
  const next = (await core.applyChainEntry(chain ? chain.state : null, input.bytes, { aud: input.aud, fleet: input.fleet, now: input.now, checkAuthTime: true })).state;
  const prev = chain ? chain.head : { seq: -1, hash: "" };
  if (hooks.beforeBatch) await hooks.beforeBatch(0);
  // ?1 fleet  ?2 seq  ?3 text  ?4 prev seq  ?5 prev hash  ?6 account
  const bound = "EXISTS (SELECT 1 FROM fleet_accounts WHERE fleet = ?1 AND account = ?6)";
  const res = await db.batch([
    db.prepare("INSERT INTO fleet_accounts (fleet, account) SELECT ?1, ?6 WHERE ?2 = 0 AND NOT EXISTS (SELECT 1 FROM fleet_accounts WHERE fleet = ?1 OR account = ?6)")
      .bind(input.fleet, next.seq, null, null, null, input.account),
    // (the next seq exactly, on the head it was checked against: a concurrent append at that seq wins or loses whole)
    db.prepare("INSERT INTO fleet_chain_entries (fleet, seq, bytes) SELECT ?1, ?2, ?3 WHERE NOT EXISTS (SELECT 1 FROM fleet_chain_entries WHERE fleet = ?1 AND seq >= ?2)" +
      ` AND (?2 = 0 OR (${headCas(1, 4, 5)})) AND ${bound}`).bind(input.fleet, next.seq, text(input.bytes), prev.seq, prev.hash, input.account),
    db.prepare("INSERT INTO fleet_chain_hashes (fleet, seq, hash) SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM fleet_chain_entries WHERE fleet = ?1 AND seq = ?2 AND bytes = ?4)" +
      " AND NOT EXISTS (SELECT 1 FROM fleet_chain_hashes WHERE fleet = ?1 AND seq = ?2)").bind(input.fleet, next.seq, next.head, text(input.bytes)),
    db.prepare("SELECT (SELECT account FROM fleet_accounts WHERE fleet = ?1) AS owner, (SELECT fleet FROM fleet_accounts WHERE account = ?2) AS mine")
      .bind(input.fleet, input.account),
  ]);
  if ((res[1]?.meta?.changes ?? 0) === 1) return { ok: true, seq: next.seq };
  const row = (res[3]?.results?.[0] ?? null) as { owner: string | null; mine: string | null } | null;
  if (!row) throw new Error("the append's read-back returned no row");
  if (row.owner !== null && row.owner !== input.account) return { refused: "not_found" };
  if (row.mine !== null && row.mine !== input.fleet) return { refused: "not_granted" };
  return { refused: "chain_fork" };
}

/**
 * Pair a host from its person-signed certificate (§4: a host id's keys are immutable; only the byte-identical
 * certificate may be presented again). Verified against the stored chain, then one batch on that head; a moved head
 * is re-read and verified once more, then a 503 (thrown).
 */
export async function pairHost(db: D1, core: WriterCore, input: { fleet: string; aud: string; bytes: Uint8Array }, hooks: WriterHooks = {}): Promise<{ ok: true; host: string; created: boolean } | { refused: string }> {
  // (at most HOSTS_MAX hosts in a fleet, counted inside the batch: two pairings racing for the last slot get one)
  for (let attempt = 0; attempt < 2; attempt++) {
    const chain = await loadChain(db, core, input.fleet, input.aud);
    if (!chain) return { refused: "not_granted" };
    const cert = await core.verifyHostCert(input.bytes, { aud: input.aud, fleet: input.fleet, chain: chain.state });
    const b = cert.body, h = chain.head;
    if (hooks.beforeBatch) await hooks.beforeBatch(attempt);
    // ?1 host  ?2 fleet  ?3 sign_key  ?4 fingerprint  ?5 cert hash  ?6 head seq  ?7 head hash  ?8 the certificate's text  ?9 HOSTS_MAX
    const res = await db.batch([
      db.prepare("INSERT INTO fleet_hosts (host, fleet, sign_key, fingerprint, revoked)" +
        " SELECT ?1, ?2, ?3, ?4, EXISTS (SELECT 1 FROM fleet_revocations WHERE fleet = ?2 AND kind = 'host' AND id = ?1)" +
        ` WHERE NOT EXISTS (SELECT 1 FROM fleet_hosts WHERE host = ?1) AND (SELECT COUNT(*) FROM fleet_hosts WHERE fleet = ?2) < ?9 AND ${headCas(2, 6, 7)}`)
        .bind(b.host, input.fleet, b.sign_key, b.fingerprint, cert.hash, h.seq, h.hash, null, HOSTS_MAX),
      db.prepare("INSERT INTO fleet_host_certs (fleet, host, cert, bytes) SELECT ?2, ?1, ?5, ?8" +
        " WHERE EXISTS (SELECT 1 FROM fleet_hosts WHERE host = ?1 AND fleet = ?2 AND sign_key = ?3 AND fingerprint = ?4)" +
        ` AND NOT EXISTS (SELECT 1 FROM fleet_host_certs WHERE fleet = ?2 AND host = ?1) AND ${headCas(2, 6, 7)}`)
        .bind(b.host, input.fleet, b.sign_key, b.fingerprint, cert.hash, h.seq, h.hash, text(input.bytes)),
      db.prepare("SELECT (SELECT fleet FROM fleet_hosts WHERE host = ?1) AS fleet, (SELECT cert FROM fleet_host_certs WHERE fleet = ?2 AND host = ?1) AS cert," +
        ` (${headCas(2, 3, 4)}) AS head_ok, (SELECT COUNT(*) FROM fleet_hosts WHERE fleet = ?2) AS hosts`).bind(b.host, input.fleet, h.seq, h.hash),
    ]);
    const created = (res[0]?.meta?.changes ?? 0) === 1;
    const row = (res[2]?.results?.[0] ?? null) as { fleet: string | null; cert: string | null; head_ok: number; hosts: number } | null;
    if (!row) throw new Error("the pairing's read-back returned no row");
    if (row.fleet !== null && row.fleet === input.fleet && row.cert === cert.hash) return { ok: true, host: b.host, created };
    // (an id already paired with other keys, another certificate or another fleet: never rebound)
    if (row.fleet !== null) return { refused: "bad_form" };
    if (row.head_ok !== 1) continue; // (the head moved between the verification and the batch: verify again)
    if (row.hosts >= HOSTS_MAX) return { refused: "limit" };
    throw new Error("the pairing wrote nothing on an unchanged head");
  }
  throw new Error("the chain head moved twice during one pairing");
}

/** Apply a person-signed revocation of a host or an agent: durable for an unknown id, never undone; no head needed. */
export async function revoke(db: D1, core: WriterCore, input: { fleet: string; aud: string; bytes: Uint8Array }): Promise<{ ok: true; kind: string; id: string } | { refused: string }> {
  const chain = await loadChain(db, core, input.fleet, input.aud);
  if (!chain) return { refused: "not_granted" };
  const r = await core.verifyRevocation(input.bytes, { aud: input.aud, fleet: input.fleet, chain: chain.state });
  if (r.what !== "host" && r.what !== "agent") return { refused: "bad_form" }; // (a package's revocation is the sealed-package store's)
  await db.batch([
    // (the first revocation's exact text is kept, for the person's page to verify; a later one changes nothing)
    db.prepare("INSERT OR IGNORE INTO fleet_revocations (fleet, kind, id, bytes) VALUES (?1, ?2, ?3, ?4)").bind(input.fleet, r.what, r.id, text(input.bytes)),
    r.what === "host"
      ? db.prepare("UPDATE fleet_hosts SET revoked = 1 WHERE host = ?1 AND fleet = ?2").bind(r.id, input.fleet)
      : db.prepare("UPDATE fleet_agents SET revoked = 1 WHERE agent = ?1 AND fleet = ?2").bind(r.id, input.fleet),
  ]);
  return { ok: true, kind: r.what, id: r.id };
}


// ---- W2b: a host's grant with the transfers of the agents it adds (§2), and the old host's fence ack (§3)

/** A service key the Worker can sign receipts with: its id, its raw public key, and a signer. */
export interface ServiceKey { id: string; raw: Uint8Array; sign(bytes: Uint8Array): Uint8Array | Promise<Uint8Array> }
/** One applied transfer as handed out: the person's envelope and the service's receipt, each exact text. */
export interface Pair { transfer: string; receipt: string }
export type GrantResult = { ok: true; gen: number; reapply: boolean; replayed: boolean; pairs: Pair[] } | { refused: string };

const TEN_MIN = 600_000, WINDOW_MS = 300_000;
/** A signed write's sign-in is fresh this long (ms): the core's AUTH_MS (its freshAuth), which it doesn't export. */
export const AUTH_MS = 300_000;
/** §1.8: agents in one grant, so transfers in one request. */
export const TRANSFERS_MAX = 64;
/** The stored result's bytes (the JSON of its receipt pairs): the migration's CHECK is the same bound. */
export const RESULT_MAX = 1_048_576;

/**
 * Apply `to_host`'s grant and the transfers of the agents it adds, all or nothing (§2; schemas §3.2, §3.7.2). An exact
 * retry of an applied request is served its stored pairs before any time check (§2.0); everything else is verified in
 * full, its receipts signed at the verified head, and decided in ONE batch. A moved chain head or a newer grant for the
 * host is verified once more, then a 503 (thrown). `now` is the Worker's clock, sampled once by the caller.
 * `serviceKeys` are the keys the Worker holds (the current one, and the next during a rotation): receipts are signed by
 * the one the fleet's chain has in force at the verified head.
 */
export async function applyGrant(db: D1, core: WriterCore, input: { fleet: string; aud: string; grant: Uint8Array; transfers: Uint8Array[]; now: number; serviceKeys: ServiceKey[] },
  hooks: WriterHooks = {}): Promise<GrantResult> {
  const { fleet, aud, now } = input;
  if (input.transfers.length > TRANSFERS_MAX) core.refuse("limit", "transfers in one request");
  for (let attempt = 0; attempt < 2; attempt++) {
    const chain = await loadChain(db, core, fleet, aud);
    if (!chain) return { refused: "not_granted" };
    const ctx = { aud, fleet, chain: chain.state };
    // §2.0 step 1: authenticate every envelope under the CURRENT chain, with no time check (a removed signer refuses here)
    const genv = await core.openByDevice(input.grant, ctx, "sb.host-grant.v1", "host-grant");
    const g = genv.body as Grant, grantHash = await core.sha256b64(genv.signed);
    const ts: { body: Transfer; hash: string; bytes: Uint8Array }[] = [];
    for (const bytes of input.transfers) {
      const e = await core.openByDevice(bytes, ctx, "sb.agent-transfer.v1", "agent-transfer");
      ts.push({ body: e.body as Transfer, hash: await core.sha256b64(e.signed), bytes });
    }
    const transfersList = ts.map((t) => t.hash).join(","), requestKey = ts.map((t) => t.hash).sort().join(",");
    // §2.0 step 2: an exact retry (the grant AND the ordered transfers, in full) is its stored pairs, byte for byte
    if (ts.length) {
      const stored = await storedResult(db, fleet, requestKey, grantHash, transfersList);
      if (stored) return { ok: true, gen: g.gen, reapply: false, replayed: true, pairs: stored };
    }
    // §2.0 step 3: the full path. The grant's own rules, under the host's current certificate and grant
    const host = await db.prepare("SELECT h.revoked AS revoked, c.cert AS cert FROM fleet_hosts h JOIN fleet_host_certs c ON c.fleet = h.fleet AND c.host = h.host WHERE h.host = ?1 AND h.fleet = ?2")
      .bind(g.host, fleet).first<{ revoked: number; cert: string }>();
    if (!host) return { refused: "unknown_host" };
    if (host.revoked) return { refused: "host_revoked" };
    const cur = await db.prepare("SELECT gen, bytes FROM fleet_grants WHERE fleet = ?1 AND host = ?2 ORDER BY gen DESC LIMIT 1").bind(fleet, g.host).first<{ gen: number; bytes: string }>();
    const current = cur ? { gen: cur.gen, bytes: core.enc(cur.bytes), body: core.parseCanonical(core.enc(cur.bytes)).body as Grant } : null;
    const v = await core.verifyGrant(input.grant, { ...ctx, cert: { body: { host: g.host }, hash: host.cert }, current, now, checkAuthTime: true });
    // (§3.2: the byte-identical re-apply of the accepted grant is accepted with no effect. With transfers, only the
    // request's exact retry, served above, may name an accepted generation: anything else goes to the batch, whose
    // nonce check comes first (a reused nonce is a replay, §3.7.2) and whose generation check refuses the rest)
    if (v.reapply && !ts.length) return { ok: true, gen: g.gen, reapply: true, replayed: false, pairs: [] };
    // each transfer: §3.7.2 step 1 (the envelope, the tier, the window and freshness), then the checks needing no rows
    const listed = new Map(g.agents.map((a) => [a.agent, a]));
    const moved = new Set<string>(), nonces = new Set<string>();
    let replayInRequest = false, step3: string | null = null, step5: string | null = null;
    for (const t of ts) {
      const b = (await core.verifyAgentTransfer(t.bytes, ctx)).body;
      if (b.not_after_ms <= b.at_ms || b.not_after_ms - b.at_ms > TEN_MIN) core.refuse("bad_form", "a transfer lives at most 10 minutes");
      if (now < b.at_ms - WINDOW_MS || now >= b.not_after_ms) core.refuse("grant_expired");
      if (!(now - b.auth_time_ms <= AUTH_MS && b.auth_time_ms <= now + AUTH_MS)) core.refuse("stale_auth");
      if (moved.has(b.agent)) core.refuse("bad_form", "one agent moved twice in one request");
      moved.add(b.agent);
      if (nonces.has(b.nonce)) replayInRequest = true;
      nonces.add(b.nonce);
      if (step3 === null && b.to_host === b.from_host) step3 = "bad_form";
      if (step5 === null) {
        if (b.grant !== grantHash || b.to_host !== g.host) step5 = "not_granted";
        else if (b.gen !== g.gen) step5 = "stale_generation";
        else if (!listed.has(b.agent)) step5 = "not_granted";
      }
    }
    // the receipts, signed BEFORE the batch by the service key in force at the verified head (§2.1)
    let sk: ServiceKey | null = null, signer: Signer | null = null;
    for (const k of ts.length ? input.serviceKeys : []) {
      const s: Signer = { kind: "service", id: k.id, alg: "ed25519", key: await core.keyId("ed25519", k.raw) };
      try { core.serviceKeyAt(chain.state, s, chain.head.seq); sk = k; signer = s; break; } catch { /* (not this one) */ }
    }
    if (ts.length && (!sk || !signer)) return { refused: "not_granted" };
    const pairs: Pair[] = [];
    for (const t of ts) {
      const b = t.body;
      const body = { fleet, aud, agent: b.agent, from_host: b.from_host, to_host: b.to_host, to_host_key: b.to_host_key, gen: b.gen, nonce: b.nonce, transfer: t.hash,
        chain_seq: chain.head.seq, at_ms: now };
      core.bodyValidator("agent-transfer-receipt")(body);
      const sig = await sk!.sign(core.signedBytes("sb.agent-transfer-receipt.v1", signer!, body));
      pairs.push({ transfer: text(t.bytes), receipt: core.canonText({ v: 1, type: "sb.agent-transfer-receipt.v1", signer, body, sig: core.b64(sig) }) });
    }
    const result = JSON.stringify(pairs);
    if (core.enc(result).length > RESULT_MAX) core.refuse("limit", "the stored result");
    const dropped = (current?.body.agents ?? []).map((a) => a.agent).filter((a) => !listed.has(a));
    const entries = await Promise.all(g.agents.map(async (a) => ({ agent: a.agent, digest: await core.sha256b64(core.enc(core.canonText(a))) })));
    if (hooks.beforeBatch) await hooks.beforeBatch(attempt);
    const decided = await grantBatch(db, {
      fleet, host: g.host, gen: g.gen, grantHash, grantBytes: text(input.grant), cert: host.cert, curGen: current?.gen ?? 0, head: chain.head, now,
      transfers: ts.map((t, i) => ({ ...t.body, hash: t.hash, receipt: pairs[i].receipt })), entries, dropped, requestKey, transfersList,
      result, replayInRequest, step3, step5, id: core.newId(),
    });
    if (decided === "ok") return { ok: true, gen: g.gen, reapply: false, replayed: false, pairs };
    if (decided === "retry") {
      // (its first apply committed while this one was verified: the stored pairs, never these)
      const stored = await storedResult(db, fleet, requestKey, grantHash, transfersList);
      if (!stored) throw new Error("a retry decision with no stored result");
      return { ok: true, gen: g.gen, reapply: false, replayed: true, pairs: stored };
    }
    if (decided === "moved") continue;
    return { refused: decided };
  }
  throw new Error("the chain head or the host's grant moved twice during one grant");
}

async function storedResult(db: D1, fleet: string, requestKey: string, grantHash: string, transfersList: string): Promise<Pair[] | null> {
  const row = await db.prepare("SELECT grant_hash, transfers, result FROM fleet_transfer_results WHERE fleet = ?1 AND request_key = ?2").bind(fleet, requestKey)
    .first<{ grant_hash: string; transfers: string; result: string }>();
  return row && row.grant_hash === grantHash && row.transfers === transfersList ? (JSON.parse(row.result) as Pair[]) : null;
}

/** §2.3: the agent (?2) has a pending first lease whose gate is still closed at ?8, by the lease batch's own fragment. */
export const PENDING_GATE_CLOSED_SQL = `EXISTS (SELECT 1 FROM lease_pending p WHERE p.agent = ?2 AND NOT ${GATE_OPEN_SQL})`;

const DECIDED = ["ok", "retry", "moved", "replay", "bad_form", "not_granted", "agent_revoked", "unknown_host", "host_revoked", "stale_generation", "in_progress"];

/**
 * The grant's ONE batch (§2.1). A decision row is inserted undecided; each check that fails sets it, in §3.7.2's order,
 * only while it is still undecided (so the first failing check is the answer); the last check sets ok. Every write is
 * conditioned on that row being ok, and the last statements read it and delete it. Conditions are EXISTS / NOT EXISTS
 * only, so a NULL can never pass one.
 */
async function grantBatch(db: D1, d: {
  fleet: string; host: string; gen: number; grantHash: string; grantBytes: string; cert: string; curGen: number; head: Head; now: number;
  transfers: (Transfer & { hash: string; receipt: string })[]; entries: { agent: string; digest: string }[]; dropped: string[];
  requestKey: string; transfersList: string; result: string; replayInRequest: boolean; step3: string | null; step5: string | null; id: string;
}): Promise<string> {
  const S: ReturnType<D1["prepare"]>[] = [];
  const check = (code: string, cond: string, ...v: unknown[]) =>
    S.push(db.prepare(`UPDATE fleet_grant_decisions SET decided = '${code}' WHERE request = ?1 AND decided IS NULL AND (${cond})`).bind(d.id, ...v));
  const OK = "EXISTS (SELECT 1 FROM fleet_grant_decisions WHERE request = ?1 AND decided = 'ok')";
  const write = (sql: string, ...v: unknown[]) => S.push(db.prepare(sql).bind(d.id, ...v));
  const moving = new Set(d.transfers.map((t) => t.agent));
  S.push(db.prepare("INSERT INTO fleet_grant_decisions (request, decided) VALUES (?1, NULL)").bind(d.id));
  // 1. an identical retry whose first apply raced this one: its stored result, and nothing else
  if (d.transfers.length)
    check("retry", "EXISTS (SELECT 1 FROM fleet_transfer_results WHERE fleet = ?2 AND request_key = ?3 AND grant_hash = ?4 AND transfers = ?5)", d.fleet, d.requestKey, d.grantHash, d.transfersList);
  // (the chain head and the host's latest grant this request was verified against, §2.4: else verify again)
  check("moved", `NOT (${headCas(2, 3, 4)}) OR COALESCE((SELECT MAX(gen) FROM fleet_grants WHERE fleet = ?2 AND host = ?5), 0) <> ?6`, d.fleet, d.head.seq, d.head.hash, d.host, d.curGen);
  // 2. each nonce new in this fleet (before the binding, so a reuse is a replay)
  for (const t of d.transfers) check("replay", "EXISTS (SELECT 1 FROM fleet_transfers WHERE fleet = ?2 AND nonce = ?3)", d.fleet, t.nonce);
  if (d.replayInRequest) check("replay", "1");
  // 3. to_host isn't from_host; the agent is bound to from_host now
  if (d.step3) check(d.step3, "1");
  for (const t of d.transfers) check("not_granted", "NOT EXISTS (SELECT 1 FROM fleet_agents WHERE agent = ?2 AND fleet = ?3 AND host = ?4)", t.agent, d.fleet, t.from_host);
  // (a revoked agent never moves: the revocation is re-read here, as the lease batch re-reads it, §4)
  for (const t of d.transfers)
    check("agent_revoked", "EXISTS (SELECT 1 FROM fleet_agents WHERE agent = ?2 AND fleet = ?3 AND revoked = 1) OR EXISTS (SELECT 1 FROM fleet_revocations WHERE fleet = ?3 AND kind = 'agent' AND id = ?2)", t.agent, d.fleet);
  // 4. to_host paired, unrevoked, with the certificate the grant names and the fingerprint each transfer names
  check("unknown_host", "NOT EXISTS (SELECT 1 FROM fleet_hosts WHERE host = ?2 AND fleet = ?3)", d.host, d.fleet);
  check("host_revoked", "EXISTS (SELECT 1 FROM fleet_hosts WHERE host = ?2 AND fleet = ?3 AND revoked = 1)", d.host, d.fleet);
  check("not_granted", "NOT EXISTS (SELECT 1 FROM fleet_host_certs WHERE fleet = ?3 AND host = ?2 AND cert = ?4)", d.host, d.fleet, d.cert);
  for (const t of d.transfers) check("not_granted", "NOT EXISTS (SELECT 1 FROM fleet_hosts WHERE host = ?2 AND fleet = ?3 AND fingerprint = ?4)", d.host, d.fleet, t.to_host_key);
  // 5. the grant each transfer names is this one, at its gen, listing its agent
  if (d.step5) check(d.step5, "1");
  // the grant's own rules (§3.2): a generation above the accepted one; every agent bound here already, or moved here by
  // this request, never bound elsewhere, and never a retired one
  check("stale_generation", "EXISTS (SELECT 1 FROM fleet_grants WHERE fleet = ?2 AND host = ?3 AND gen >= ?4)", d.fleet, d.host, d.gen);
  for (const e of d.entries) {
    if (!moving.has(e.agent)) check("not_granted", "EXISTS (SELECT 1 FROM fleet_agents WHERE agent = ?2 AND NOT (fleet = ?3 AND host = ?4))", e.agent, d.fleet, d.host);
    check("not_granted", "EXISTS (SELECT 1 FROM fleet_retired_agents WHERE fleet = ?2 AND agent = ?3)", d.fleet, e.agent);
  }
  // the pending gate (§2.3): a moved agent whose previous move's first lease still waits refuses the request
  for (const t of d.transfers) check("in_progress", PENDING_GATE_CLOSED_SQL, t.agent, null, null, null, null, null, d.now);
  check("ok", "1");
  // ---- on ok only. The grant
  write(`INSERT INTO fleet_grants (fleet, host, gen, hash, bytes) SELECT ?2, ?3, ?4, ?5, ?6 WHERE ${OK}`, d.fleet, d.host, d.gen, d.grantHash, d.grantBytes);
  for (const t of d.transfers) {
    // (from_gen: the old host's entry_gen, read BEFORE the rebinding below; applied_ms: this batch's time)
    write("INSERT INTO fleet_transfers (fleet, nonce, agent, from_host, from_gen, to_host, gen, transfer, receipt, applied_ms)" +
      ` SELECT ?2, ?3, ?4, ?5, (SELECT entry_gen FROM fleet_agents WHERE agent = ?4 AND fleet = ?2 AND host = ?5), ?6, ?7, ?8, ?9, ?10 WHERE ${OK}`,
      d.fleet, t.nonce, t.agent, t.from_host, t.to_host, t.gen, t.hash, t.receipt, d.now);
    // (every column in the conflict branch, acked included: an ack of an earlier move never carries over, §2.1 step 7)
    write(`INSERT INTO lease_pending (agent, from_host, to_host, transfer, acked) SELECT ?2, ?3, ?4, ?5, 0 WHERE ${OK}` +
      " ON CONFLICT (agent) DO UPDATE SET from_host = excluded.from_host, to_host = excluded.to_host, transfer = excluded.transfer, acked = 0",
      t.agent, t.from_host, t.to_host, t.hash);
    write(`INSERT INTO fleet_host_queue (fleet, host, kind, ref, at_ms) SELECT ?2, ?3, 'transfer', ?4, ?5 WHERE ${OK}`, d.fleet, t.from_host, t.hash, d.now);
  }
  // an agent the host's previous grant listed and this one drops: retired if it is still bound here (its lease_clock and
  // lease_pending rows stay, as the gate's history); nothing, if it has already moved away
  for (const x of d.dropped) {
    write(`INSERT INTO fleet_retired_agents (fleet, agent) SELECT ?2, ?3 WHERE ${OK} AND EXISTS (SELECT 1 FROM fleet_agents WHERE agent = ?3 AND fleet = ?2 AND host = ?4)`, d.fleet, x, d.host);
    write(`DELETE FROM fleet_agents WHERE agent = ?3 AND fleet = ?2 AND host = ?4 AND ${OK}`, d.fleet, x, d.host);
  }
  // every listed agent bound here; entry_gen moves only for an agent new to this host or whose entry changed (§3.7.1);
  // revoked is never lowered (§4)
  for (const e of d.entries)
    write("INSERT INTO fleet_agents (agent, fleet, host, entry_gen, revoked, entry)" +
      ` SELECT ?2, ?3, ?4, ?5, EXISTS (SELECT 1 FROM fleet_revocations WHERE fleet = ?3 AND kind = 'agent' AND id = ?2), ?6 WHERE ${OK}` +
      " ON CONFLICT (agent) DO UPDATE SET" +
      " entry_gen = CASE WHEN fleet_agents.host = excluded.host AND fleet_agents.entry = excluded.entry THEN fleet_agents.entry_gen ELSE excluded.entry_gen END," +
      " host = excluded.host, entry = excluded.entry, revoked = MAX(fleet_agents.revoked, excluded.revoked) WHERE fleet_agents.fleet = excluded.fleet",
      e.agent, d.fleet, d.host, d.gen, e.digest);
  if (d.transfers.length)
    write(`INSERT INTO fleet_transfer_results (fleet, request_key, grant_hash, transfers, result) SELECT ?2, ?3, ?4, ?5, ?6 WHERE ${OK}`,
      d.fleet, d.requestKey, d.grantHash, d.transfersList, d.result);
  const readAt = S.length;
  S.push(db.prepare("SELECT decided FROM fleet_grant_decisions WHERE request = ?1").bind(d.id));
  S.push(db.prepare("DELETE FROM fleet_grant_decisions WHERE request = ?1").bind(d.id));
  const res = await db.batch(S);
  const rows = res[readAt]?.results as { decided?: unknown }[] | undefined;
  if (!Array.isArray(rows) || rows.length !== 1 || typeof rows[0].decided !== "string" || !DECIDED.includes(rows[0].decided)) throw new Error("the grant decision: no closed decision");
  return rows[0].decided;
}

/**
 * The old host's fence ack (§3; schemas §3.7.4): accepted only for a transfer the service applied from that host, at
 * the old host's last entry_gen (from_gen), after the apply, proven empty, once. Anything else is ignored and writes
 * nothing; a replay of an accepted ack changes nothing, and the gate it opened stays open.
 */
export async function recordFenceAck(db: D1, core: WriterCore, input: { fleet: string; aud: string; bytes: Uint8Array }): Promise<{ ok: true } | { ignored: string }> {
  const { fleet, aud } = input;
  let ack: FenceAck;
  try {
    const host = core.parseCanonical(input.bytes)?.body?.host;
    if (typeof host !== "string") return { ignored: "bad_form" };
    const h = await db.prepare("SELECT sign_key, fingerprint, revoked FROM fleet_hosts WHERE host = ?1 AND fleet = ?2").bind(host, fleet)
      .first<{ sign_key: string; fingerprint: string; revoked: number }>();
    if (!h) return { ignored: "unknown_host" };
    if (h.revoked) return { ignored: "host_revoked" };
    ack = (await core.verifyFenceAck(input.bytes, { aud, fleet, cert: { body: { host, fingerprint: h.fingerprint }, signRaw: core.unb64(h.sign_key, 32) } })).body;
  } catch (e) {
    const code = (e as { code?: unknown })?.code;
    if (typeof code === "string") return { ignored: code };
    throw e;
  }
  if (ack.proven_empty !== true) return { ignored: "bad_form" };
  // ?1 fleet  ?2 transfer  ?3 host  ?4 agent  ?5 gen  ?6 at_ms
  const res = await db.batch([
    db.prepare("INSERT INTO fleet_fence_acks (fleet, transfer) SELECT ?1, ?2" +
      " WHERE EXISTS (SELECT 1 FROM fleet_hosts WHERE host = ?3 AND fleet = ?1 AND revoked = 0)" +
      " AND EXISTS (SELECT 1 FROM lease_pending WHERE agent = ?4 AND from_host = ?3 AND transfer = ?2)" +
      " AND EXISTS (SELECT 1 FROM fleet_transfers WHERE fleet = ?1 AND transfer = ?2 AND agent = ?4 AND from_host = ?3 AND from_gen = ?5 AND applied_ms < ?6)" +
      " AND NOT EXISTS (SELECT 1 FROM fleet_fence_acks WHERE fleet = ?1 AND transfer = ?2)").bind(fleet, ack.transfer, ack.host, ack.agent, ack.gen, ack.at_ms),
    db.prepare("UPDATE lease_pending SET acked = 1 WHERE agent = ?4 AND from_host = ?3 AND transfer = ?2 AND EXISTS (SELECT 1 FROM fleet_fence_acks WHERE fleet = ?1 AND transfer = ?2)")
      .bind(fleet, ack.transfer, ack.host, ack.agent),
  ]);
  return (res[0]?.meta?.changes ?? 0) === 1 ? { ok: true } : { ignored: "not_accepted" };
}
