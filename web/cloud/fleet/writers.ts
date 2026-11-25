// The fleet Worker's first writers (writers design W2 r4.2, W2a): the device chain's append, host pairing and
// revocation, each ONE D1 batch whose conditions are evaluated inside it. The core verifies every envelope first and is
// passed in (the Worker reaches it only through its installer, in server.ts). A widening batch (an append, a pairing)
// carries the chain head it was verified against and writes nothing if the head has moved (§2.4); the caller then
// re-reads the chain and verifies once more. A revocation only narrows: it needs no head, and nothing ever undoes it.
import type { D1 } from "./store.ts";

/** The parts of the fleet core these writers use (the mirrored core's own functions). */
export interface WriterCore {
  replayChain(entries: Uint8Array[], ctx: { aud: string; fleet: string }): Promise<{ seq: number; head: string; hashes: string[] }>;
  applyChainEntry(state: unknown, bytes: Uint8Array, ctx: Record<string, unknown>): Promise<{ state: { seq: number; head: string } }>;
  verifyHostCert(bytes: Uint8Array, ctx: Record<string, unknown>): Promise<{ body: { host: string; fleet: string; sign_key: string; fingerprint: string }; hash: string }>;
  verifyRevocation(bytes: Uint8Array, ctx: Record<string, unknown>): Promise<{ what: string; id: string; fleet: string }>;
  enc(s: string): Uint8Array;
  refuse(code: string, message?: string): never;
}

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

/** Append one chain entry: the core checks it against the stored chain (auth_time included); one conditional insert. */
export async function appendChainEntry(db: D1, core: WriterCore, input: { fleet: string; aud: string; bytes: Uint8Array; now: number }, hooks: WriterHooks = {}): Promise<{ ok: true; seq: number } | { refused: string }> {
  const chain = await loadChain(db, core, input.fleet, input.aud);
  const next = (await core.applyChainEntry(chain ? chain.state : null, input.bytes, { aud: input.aud, fleet: input.fleet, now: input.now, checkAuthTime: true })).state;
  const prev = chain ? chain.head : { seq: -1, hash: "" };
  if (hooks.beforeBatch) await hooks.beforeBatch(0);
  const res = await db.batch([
    // (the next seq exactly, on the head it was checked against: a concurrent append at that seq wins or loses whole)
    db.prepare("INSERT INTO fleet_chain_entries (fleet, seq, bytes) SELECT ?1, ?2, ?3 WHERE NOT EXISTS (SELECT 1 FROM fleet_chain_entries WHERE fleet = ?1 AND seq >= ?2)" +
      ` AND (?2 = 0 OR (${headCas(1, 4, 5)}))`).bind(input.fleet, next.seq, text(input.bytes), prev.seq, prev.hash),
    db.prepare("INSERT INTO fleet_chain_hashes (fleet, seq, hash) SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM fleet_chain_entries WHERE fleet = ?1 AND seq = ?2 AND bytes = ?4)" +
      " AND NOT EXISTS (SELECT 1 FROM fleet_chain_hashes WHERE fleet = ?1 AND seq = ?2)").bind(input.fleet, next.seq, next.head, text(input.bytes)),
  ]);
  return (res[0]?.meta?.changes ?? 0) === 1 ? { ok: true, seq: next.seq } : { refused: "chain_fork" };
}

/**
 * Pair a host from its person-signed certificate (§4: a host id's keys are immutable; only the byte-identical
 * certificate may be presented again). Verified against the stored chain, then one batch on that head; a moved head
 * is re-read and verified once more, then a 503 (thrown).
 */
export async function pairHost(db: D1, core: WriterCore, input: { fleet: string; aud: string; bytes: Uint8Array }, hooks: WriterHooks = {}): Promise<{ ok: true; host: string; created: boolean } | { refused: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const chain = await loadChain(db, core, input.fleet, input.aud);
    if (!chain) return { refused: "not_granted" };
    const cert = await core.verifyHostCert(input.bytes, { aud: input.aud, fleet: input.fleet, chain: chain.state });
    const b = cert.body, h = chain.head;
    if (hooks.beforeBatch) await hooks.beforeBatch(attempt);
    // ?1 host  ?2 fleet  ?3 sign_key  ?4 fingerprint  ?5 cert hash  ?6 head seq  ?7 head hash
    const res = await db.batch([
      db.prepare("INSERT INTO fleet_hosts (host, fleet, sign_key, fingerprint, revoked)" +
        " SELECT ?1, ?2, ?3, ?4, EXISTS (SELECT 1 FROM fleet_revocations WHERE fleet = ?2 AND kind = 'host' AND id = ?1)" +
        ` WHERE NOT EXISTS (SELECT 1 FROM fleet_hosts WHERE host = ?1) AND ${headCas(2, 6, 7)}`).bind(b.host, input.fleet, b.sign_key, b.fingerprint, cert.hash, h.seq, h.hash),
      db.prepare("INSERT INTO fleet_host_certs (fleet, host, cert) SELECT ?2, ?1, ?5" +
        " WHERE EXISTS (SELECT 1 FROM fleet_hosts WHERE host = ?1 AND fleet = ?2 AND sign_key = ?3 AND fingerprint = ?4)" +
        ` AND NOT EXISTS (SELECT 1 FROM fleet_host_certs WHERE fleet = ?2 AND host = ?1) AND ${headCas(2, 6, 7)}`).bind(b.host, input.fleet, b.sign_key, b.fingerprint, cert.hash, h.seq, h.hash),
      db.prepare("SELECT (SELECT fleet FROM fleet_hosts WHERE host = ?1) AS fleet, (SELECT cert FROM fleet_host_certs WHERE fleet = ?2 AND host = ?1) AS cert," +
        ` (${headCas(2, 3, 4)}) AS head_ok`).bind(b.host, input.fleet, h.seq, h.hash),
    ]);
    const created = (res[0]?.meta?.changes ?? 0) === 1;
    const row = (res[2]?.results?.[0] ?? null) as { fleet: string | null; cert: string | null; head_ok: number } | null;
    if (!row) throw new Error("the pairing's read-back returned no row");
    if (row.fleet !== null && row.fleet === input.fleet && row.cert === cert.hash) return { ok: true, host: b.host, created };
    // (an id already paired with other keys, another certificate or another fleet: never rebound)
    if (row.fleet !== null) return { refused: "bad_form" };
    if (row.head_ok !== 1) continue; // (the head moved between the verification and the batch: verify again)
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
    db.prepare("INSERT OR IGNORE INTO fleet_revocations (fleet, kind, id) VALUES (?1, ?2, ?3)").bind(input.fleet, r.what, r.id),
    r.what === "host"
      ? db.prepare("UPDATE fleet_hosts SET revoked = 1 WHERE host = ?1 AND fleet = ?2").bind(r.id, input.fleet)
      : db.prepare("UPDATE fleet_agents SET revoked = 1 WHERE agent = ?1 AND fleet = ?2").bind(r.id, input.fleet),
  ]);
  return { ok: true, kind: r.what, id: r.id };
}
