// The account's E2E key chain on the server (design/e2e-encryption.md §2, §2.1, §3.4, §11.2; PR 2c), kept in the
// account's sync object (SyncAccount). The server stores the chain and can't forge it: every entry is checked by the
// E2E core (web/workspace/e2e/core) before it is kept, and devices check it all again themselves.
//
// - An entry is kept only with its package (checkTransition: the new epoch's committed keyring and exactly one wrapper
//   per required recipient), all in one transaction that first checks the head hasn't moved. So no reader ever sees an
//   entry without what must travel with it, and a stale append is refused (`conflict`, with the head).
// - Readers get the chain in pages, a recipient's latest wrapper for the current epoch, and the current epoch's keyring.
//   The recovery key's wrapper is found by account only, never by anything a recovery code derives.
// - What is kept: every keyring row (60 bytes an epoch; keyrings are chained, so a device walks back through them to any
//   earlier epoch's secret, and only a signed coverage manifest may ever drop one), and only the current epoch's
//   wrappers (one per recipient, the latest); superseded wrappers go in the append's own transaction. The chain is
//   bounded by entries since the last reset; past the bound a verified removal or recovery still goes in, and a
//   recovery-signed reset at any length: it compacts the chain to itself (a new generation, the recovering device
//   alone), so the person can always recover, whatever a compromised device appended. The replayed state is cached in
//   memory; a restart rebuilds it once, loading a compacted chain under the anchor and checkpoint hash recorded with the
//   reset.
// - The tables are made on first use, so nothing changes for an account while E2E is off.
// - The chain is the account's identity, so it survives "Delete my synced data" (a new sync generation): the chain, the
//   current keyring and the current wrappers stay (E2E_KEEP), and the mailbox goes. A new genesis would conflict with
//   every honest device's pin, and dropping the recovery key's wrapper would break recovery. Deleting the CoCalc account
//   itself deletes every E2E row.
// - Reads never replay: the head, the current epoch and the current devices are a row written in each append's
//   transaction.
// - The enrollment mailbox: short-lived messages by session and phase, each phase written once and only after the one
//   before it, expiring 10 minutes after phase 1. It is untrusted by design (the protocol authenticates every
//   message); these rules only bound what it stores.
//
// Errors are SyncErrors with fixed messages; the E2E core's own code goes in `detail.reason`.

import { SyncError } from "../sync-protocol/protocol.ts";
import * as E from "../workspace/e2e/core/index.mjs";
import { e2eCore } from "../workspace/e2e/core-ready.ts";

export const E2E = Object.freeze({
  /** an entry's bytes, as the core's signed objects are bounded */
  entryBytes: 64 << 10,
  /** wrappers in one append: one per device and the recovery key */
  wrappers: 64,
  /** one wrapper's bytes */
  wrapperBytes: 8 << 10,
  /** a keyring's bytes: one secret, its nonce and tag (chained keyrings: constant, whatever the epoch) */
  keyringBytes: 60,
  /** entries per page of the chain, and its bytes */
  page: 256,
  pageBytes: 1 << 20,
  /** entries in one account's chain: every append replays it (cached), so it is bounded */
  entries: 1024,
  /** past `entries`, room kept for removals and recoveries only: a compromised device that fills the chain with
   * ordinary transitions can't block the person's own removal or recovery (it can only remove, at most the current
   * devices, out of these) */
  reserve: 64,
  /** devices current at once, so an append's package stays bounded */
  devices: 48,
  /** one mailbox message */
  messageBytes: 16 << 10,
  /** live enrollment sessions per account */
  sessions: 16,
  /** an enrollment session's life, from its phase 1 */
  sessionMs: 10 * 60_000,
  phases: 5,
  /** appends a minute, per account: each one replays and checks signatures */
  appendsPerMinute: 30,
  /** mailbox writes and reads a minute, per account */
  mailPerMinute: 240,
  /** verified resets a minute, per account: charged only after a reset's recovery signature and package check, so only
   * the holder of the current recovery code can spend it, and never from the appends' bucket */
  resetsPerMinute: 4,
  /** recovery-signed reset attempts a minute, per account: charged once a claimed reset's outer signature verifies
   * against the current recovery key, before its package is checked; an invalid signature costs one Ed25519 check
   * and draws on nothing, so no other device can spend this */
  resetWorkPerMinute: 30,
});

export const E2E_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS e2e_chain (seq INTEGER PRIMARY KEY, entry TEXT NOT NULL, head TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS e2e_keyrings (epoch INTEGER PRIMARY KEY, generation TEXT NOT NULL, suite INTEGER NOT NULL, prev TEXT NOT NULL, prev_ring TEXT NOT NULL, hash TEXT NOT NULL, bytes BLOB NOT NULL)",
  "CREATE TABLE IF NOT EXISTS e2e_wrappers (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, kind TEXT NOT NULL, rid TEXT NOT NULL, epoch INTEGER NOT NULL, bytes TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS e2e_wrappers_to ON e2e_wrappers (kind, rid, seq)",
  "CREATE TABLE IF NOT EXISTS e2e_head (id INTEGER PRIMARY KEY CHECK (id = 1), seq INTEGER NOT NULL, head TEXT NOT NULL, epoch INTEGER NOT NULL, devices TEXT NOT NULL, base INTEGER NOT NULL, generation TEXT NOT NULL, recovery_sign TEXT NOT NULL, recovery_key TEXT NOT NULL)",
  // (after a reset: the anchor the store loads the compacted chain under, and the hash of the checkpoint state it derived)
  "CREATE TABLE IF NOT EXISTS e2e_checkpoint (id INTEGER PRIMARY KEY CHECK (id = 1), seq INTEGER NOT NULL, hash TEXT NOT NULL, generation TEXT NOT NULL, state_hash TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS e2e_mailbox (session TEXT NOT NULL, phase INTEGER NOT NULL, msg TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY (session, phase))",
];

/** The tables a sync-data purge keeps (the account's identity); the mailbox isn't one of them. */
export const E2E_KEEP = Object.freeze(["e2e_chain", "e2e_keyrings", "e2e_wrappers", "e2e_head", "e2e_checkpoint"]);
/** How long an expired enrollment session's rows stay, refusing its reuse, before they are swept. */
const TOMBSTONE_MS = 24 * 3600_000;

// (the fleet core's one crypto backend, installed once per isolate through the page's one way into the fleet core:
// the same object again is a no-op)
function ready() {
  e2eCore();
}

const ID = /^[a-z2-7]{25}[aeimquy4]$/;
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
/** The account's E2E id: the first 16 bytes of its account hash, in the id form (26 base32 characters). */
export function e2eAccount(hash: string): string {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new SyncError("invalid", "not an account hash");
  let bits = 0, acc = 0, out = "";
  for (let i = 0; i < 32; i += 2) {
    acc = (acc << 8) | parseInt(hash.slice(i, i + 2), 16); bits += 8;
    while (bits >= 5) { out += B32[(acc >>> (bits - 5)) & 31]; bits -= 5; }
    acc &= (1 << bits) - 1;
  }
  return out + B32[(acc << (5 - bits)) & 31];
}
/** The audience a deployment's chain is for. */
export const e2eAud = (dev: boolean) => (dev ? "https://dev.sagebrush.space" : "https://sagebrush.space");

type Sql = { exec(q: string, ...b: unknown[]): { toArray(): unknown[] } };
type Row = Record<string, ArrayBuffer | string | number | null>;
type Ctx = { aud: string; account: string };
type State = { seq: number; head: string; base: number; generation: string; epoch: { n: number; keyring: { hash: string } | null }; devices: Map<string, { removed: number | null }> };

const b64 = (b: Uint8Array) => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const unb64 = (s: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new SyncError("invalid", "not base64url");
  const t = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(t, (c) => c.charCodeAt(0));
};
const utf8 = (s: string) => new TextEncoder().encode(s);
/** A core refusal as a SyncError: its code in detail.reason; anything else is not ours to name. */
function refused(e: unknown, code: "invalid" | "conflict" = "invalid"): never {
  const reason = (e as { code?: unknown })?.code;
  if (typeof reason === "string" && /^[a-z_]{1,32}$/.test(reason)) throw new SyncError(reason === "chain_fork" ? "conflict" : code, "the key chain refused this", { reason });
  throw e;
}

/**
 * One account's chain store, over its object's SQL storage. `transaction` is the object's transactionSync. The
 * replayed state is cached in memory and rebuilt from storage whenever it isn't the stored head (after a restart, or
 * another append).
 */
export class E2EStore {
  private cache: { seq: number; state: State } | null = null;
  /** how many claimed resets passed the preflight, and how many full transitions (with their packages) were checked */
  counters = { preflights: 0, transitions: 0, replays: 0 };
  /** the bounds this store applies (tests lower them through the object's seam) */
  bounds = { entries: E2E.entries, reserve: E2E.reserve, pageBytes: E2E.pageBytes };
  /** `pause` runs between an append's checks and its transaction: a test seam that lets another append in between. */
  constructor(private sql: Sql, private transaction: <T>(f: () => T) => T, private ctx: Ctx, private pause: () => Promise<void> = async () => {}) {}

  private has(): boolean {
    return this.sql.exec("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'e2e_chain'").toArray().length > 0;
  }
  private storedSeq(): number {
    if (!this.has()) return -1;
    const r = this.sql.exec("SELECT MAX(seq) AS s FROM e2e_chain").toArray()[0] as Row;
    return r.s === null ? -1 : Number(r.s);
  }

  /** The replayed chain at the stored head (null: no chain yet). */
  async state(): Promise<State | null> {
    ready();
    const top = this.storedSeq();
    if (top < 0) return null;
    if (this.cache?.seq === top) return this.cache.state;
    this.counters.replays++;
    const rows = this.sql.exec("SELECT entry FROM e2e_chain ORDER BY seq").toArray() as Row[];
    // (a compacted chain starts at a reset this store verified: it loads under the anchor it recorded then, and the
    // checkpoint state it derives must hash as recorded)
    const cp = this.checkpointRow();
    const anchor = cp ? { account: this.ctx.account, aud: this.ctx.aud, generation: cp.generation, seq: cp.seq, hash: cp.hash } : null;
    let s: State;
    try {
      s = (await E.replayFrom(rows.map((r) => utf8(r.entry as string)), this.ctx, { anchor })) as State;
      if (cp) {
        const first = (await E.loadAnchored(utf8(rows[0].entry as string), this.ctx, anchor)) as State;
        if ((await E.checkpointOf(first)).hash !== cp.state_hash) throw new SyncError("unavailable", "the key chain's checkpoint doesn't verify");
      }
    } catch (e) {
      if (e instanceof SyncError) throw e;
      throw new SyncError("unavailable", "the key chain's stored state doesn't verify", { reason: (e as { code?: string })?.code ?? "error" });
    }
    this.cache = { seq: top, state: s };
    return s;
  }

  private checkpointRow(): { seq: number; hash: string; generation: string; state_hash: string } | null {
    if (this.sql.exec("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'e2e_checkpoint'").toArray().length === 0) return null;
    const r = this.sql.exec("SELECT seq, hash, generation, state_hash FROM e2e_checkpoint WHERE id = 1").toArray()[0] as Row | undefined;
    return r ? { seq: Number(r.seq), hash: r.hash as string, generation: r.generation as string, state_hash: r.state_hash as string } : null;
  }
  /** Entries kept since the last reset (the length bound counts these, not the logical position). */
  private kept(): number {
    const h = this.headRow();
    return h ? h.seq - h.base + 1 : 0;
  }

  /**
   * Append an entry with its package. Checked by the core first; then, in one transaction, the head must still be the
   * one checked against, and the entry, its keyring and its wrappers are written together. A reset is admitted at any
   * length; it is charged to `chargeReset` only once it has verified, and its transaction replaces every chain row and
   * wrapper with the reset and its package, keeps every keyring row, and records the checkpoint anchor.
   */
  async append(a: { entry: unknown; keyring?: unknown; wrappers?: unknown }, charge: { work?: () => void; verified?: () => void } = {}): Promise<{ seq: number; head: string }> {
    if (typeof a.entry !== "string" || a.entry.length === 0 || utf8(a.entry).length > E2E.entryBytes) throw new SyncError("invalid", "an entry is canonical JSON text, at most 64 KiB");
    const wrappers = a.wrappers ?? [];
    if (!Array.isArray(wrappers) || wrappers.length > E2E.wrappers || wrappers.some((w) => typeof w !== "string" || utf8(w).length > E2E.wrapperBytes)) throw new SyncError("invalid", "wrappers are at most 64 texts of 8 KiB");
    let keyring: Uint8Array | null = null;
    if (a.keyring !== undefined && a.keyring !== null) {
      if (typeof a.keyring !== "string" || a.keyring.length > Math.ceil((E2E.keyringBytes * 4) / 3)) throw new SyncError("invalid", "a keyring is base64url, 60 bytes");
      keyring = unb64(a.keyring);
    }
    // (what the entry claims to be decides only which bound applies before the checks; the checks then decide)
    let claimed: unknown;
    try { claimed = (JSON.parse(a.entry) as { body?: { op?: unknown } })?.body?.op; } catch { claimed = null; }
    const isReset = claimed === "reset";
    // (the hard bound, before any work, for everything but a reset: nothing else goes past entries + reserve)
    if (!isReset && this.kept() + 1 > this.bounds.entries + this.bounds.reserve) throw new SyncError("limit", "the key chain is at its length bound", { max: this.bounds.entries + this.bounds.reserve });
    // (a claimed reset: first its outer signature by the current recovery key, recorded in the head row, so even a cold
    // object does one Ed25519 check and no replay or package work; only then is it charged to the authorized-reset-work
    // bucket, which nobody without the recovery key can reach)
    if (isReset) {
      const h = this.headRow();
      try {
        await E.preflightReset(utf8(a.entry), this.ctx, h ? { sign: unb64(h.recovery_sign), signKey: h.recovery_key } : null);
      } catch (e) {
        refused(e);
      }
      this.counters.preflights++;
      charge.work?.();
    }
    const before = await this.state();
    const at = before ? before.seq : -1;
    this.counters.transitions++;
    let next: State, op: string, row: { epoch: number; generation: string; suite: number; prev: string; prev_ring: string; bytes: Uint8Array } | null;
    try {
      const t = await E.checkTransition({ state: before, ctx: this.ctx, entry: utf8(a.entry), keyring, wrappers: (wrappers as string[]).map(utf8) });
      next = t.state as State;
      op = t.entry.op as string;
      row = t.row as typeof row;
    } catch (e) {
      // (stale: the answer carries the current head, the same shape as the transaction's own stale refusal)
      if ((e as { code?: unknown })?.code === "chain_fork") this.stale();
      refused(e);
    }
    if (op === "reset") charge.verified?.();
    // (past the ordinary bound, only a verified removal or recovery goes on, into the reserve; a reset at any length)
    else if (this.kept() + 1 > this.bounds.entries && op !== "remove" && op !== "recover") throw new SyncError("limit", "the key chain is at its length bound: only removing a device, recovering or a reset goes on", { max: this.bounds.entries });
    if ([...next.devices.values()].filter((d) => d.removed === null).length > E2E.devices) throw new SyncError("limit", "too many devices", { max: E2E.devices });
    const cpHash = op === "reset" ? (await E.checkpointOf(next)).hash : "";
    await this.pause();
    const parsed = (wrappers as string[]).map((w) => JSON.parse(w).body as { id: string; recipient: { kind: string; id: string }; epoch: number });
    let out: { seq: number; head: string };
    try {
      out = this.transaction(() => {
      for (const s of E2E_SCHEMA) this.sql.exec(s);
      // (the head checked against is still the stored one: another append in between makes this one stale)
      if (this.storedSeq() !== at) this.stale();
      // (a reset compacts: the chain's rows and every wrapper go, and the reset and its package take their place)
      if (op === "reset") {
        this.sql.exec("DELETE FROM e2e_chain");
        this.sql.exec("DELETE FROM e2e_wrappers");
      }
      this.sql.exec("INSERT INTO e2e_chain (seq, entry, head) VALUES (?, ?, ?)", next.seq, a.entry, next.head);
      // (every keyring row is kept, whatever the epoch or generation: chained keyrings reach every earlier secret, and
      // only a signed coverage manifest may ever drop one; its prev_ring must be the stored last row's hash)
      // (the stored link: epoch 1 has no predecessor; every later keyring's prev_ring is the stored hash of the row
      // just before it, so the walk the rows promise is intact before anything is published)
      if (row) {
        const last = this.sql.exec("SELECT epoch, hash FROM e2e_keyrings ORDER BY epoch DESC LIMIT 1").toArray()[0] as Row | undefined;
        const linked = row.epoch === 1 ? !last && row.prev_ring === "" : !!last && Number(last.epoch) === row.epoch - 1 && last.hash === row.prev_ring;
        if (!linked) throw new SyncError("invalid", "the key chain refused this", { reason: "bad_package" });
        this.sql.exec("INSERT INTO e2e_keyrings (epoch, generation, suite, prev, prev_ring, hash, bytes) VALUES (?, ?, ?, ?, ?, ?, ?)", row.epoch, row.generation, row.suite, row.prev, row.prev_ring, next.epoch.keyring!.hash, row.bytes);
      }
      // (only the current epoch's wrappers are kept: a new epoch retires the older ones, and a new wrapper to a
      // recipient replaces its last)
      this.sql.exec("DELETE FROM e2e_wrappers WHERE epoch < ?", next.epoch.n);
      parsed.forEach((b, i) => {
        this.sql.exec("DELETE FROM e2e_wrappers WHERE kind = ? AND rid = ?", b.recipient.kind, b.recipient.id);
        this.sql.exec("INSERT INTO e2e_wrappers (id, seq, kind, rid, epoch, bytes) VALUES (?, ?, ?, ?, ?, ?)", b.id, next.seq, b.recipient.kind, b.recipient.id, b.epoch, (wrappers as string[])[i]);
      });
      const current = [...next.devices.entries()].filter(([, d]) => d.removed === null).map(([id]) => id).sort();
      // (a removed device's wrappers go with it)
      this.sql.exec(`DELETE FROM e2e_wrappers WHERE kind = 'device' AND rid NOT IN (${current.map(() => "?").join(",")})`, ...current);
      const rec = (next as unknown as { recovery: { sign: Uint8Array; signKey: string } }).recovery;
      this.sql.exec("INSERT INTO e2e_head (id, seq, head, epoch, devices, base, generation, recovery_sign, recovery_key) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET seq = excluded.seq, head = excluded.head, epoch = excluded.epoch, devices = excluded.devices, base = excluded.base, generation = excluded.generation, recovery_sign = excluded.recovery_sign, recovery_key = excluded.recovery_key",
        next.seq, next.head, next.epoch.n, JSON.stringify(current), next.base, next.generation, b64(rec.sign), rec.signKey);
      if (op === "reset")
        this.sql.exec("INSERT INTO e2e_checkpoint (id, seq, hash, generation, state_hash) VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET seq = excluded.seq, hash = excluded.hash, generation = excluded.generation, state_hash = excluded.state_hash",
          next.seq, next.head, next.generation, cpHash);
      return { seq: next.seq, head: next.head };
      });
    } catch (e) {
      // (an append that didn't commit, or whose commit is uncertain: the cache is rebuilt from storage next time)
      this.cache = null;
      throw e;
    }
    // (published only after the commit)
    this.cache = { seq: next.seq, state: next };
    return out;
  }

  /** A stale append's refusal: `conflict`, reason chain_fork, and the current head (or null), never a payload. */
  private stale(): never {
    const h = this.headRow();
    throw new SyncError("conflict", "the key chain moved; read it and try again", { reason: "chain_fork", head: h ? { seq: h.seq, hash: h.head } : null });
  }

  /** The head row: seq, hash, current epoch and current devices (null: no chain). */
  private headRow(): { seq: number; head: string; epoch: number; devices: string[]; base: number; generation: string; recovery_sign: string; recovery_key: string } | null {
    if (this.sql.exec("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'e2e_head'").toArray().length === 0) return null;
    const r = this.sql.exec("SELECT seq, head, epoch, devices, base, generation, recovery_sign, recovery_key FROM e2e_head WHERE id = 1").toArray()[0] as Row | undefined;
    return r ? { seq: Number(r.seq), head: r.head as string, epoch: Number(r.epoch), devices: JSON.parse(r.devices as string) as string[], base: Number(r.base), generation: r.generation as string, recovery_sign: r.recovery_sign as string, recovery_key: r.recovery_key as string } : null;
  }

  /** A page of the chain from `from`, and the head. */
  chain(from: number): { account: string; aud: string; from: number; base: number; entries: string[]; head: { seq: number; hash: string } | null } {
    if (!Number.isSafeInteger(from) || from < 0) throw new SyncError("invalid", "from is a non-negative integer");
    if (!this.has()) return { account: this.ctx.account, aud: this.ctx.aud, from, base: 0, entries: [], head: null };
    const all = this.sql.exec("SELECT entry FROM e2e_chain WHERE seq >= ? ORDER BY seq LIMIT ?", from, E2E.page).toArray() as Row[];
    // (a page ends before the entry that would take it past its bytes; one entry always fits, at most 64 KiB)
    const rows: Row[] = [];
    let bytes = 0;
    for (const r of all) {
      bytes += utf8(r.entry as string).length;
      if (rows.length && bytes > this.bounds.pageBytes) break;
      rows.push(r);
    }
    const h = this.headRow();
    // (base: where the kept chain starts, the last reset or genesis; a client loads a chain starting at a reset only under
    // an anchor of its own, never this server's word)
    return { account: this.ctx.account, aud: this.ctx.aud, from, base: h?.base ?? 0, entries: rows.map((r) => r.entry as string), head: h ? { seq: h.seq, hash: h.head } : null };
  }

  /** The latest wrapper to a recipient for the current epoch: a current device by its id, or the recovery key (by the
   * account alone: a caller's id for it is refused). Null if there is none. */
  wrapper(kind: unknown, id: unknown): { wrapper: string; seq: number; epoch: number } | null {
    if (kind === "recovery") {
      if (id !== undefined && id !== null) throw new SyncError("invalid", "the recovery key's wrapper is found by account alone");
      id = this.ctx.account;
    } else if (kind !== "device" || typeof id !== "string" || !ID.test(id)) throw new SyncError("invalid", "kind is device (with its id) or recovery");
    const h = this.headRow();
    if (!h || (kind === "device" && !h.devices.includes(id as string))) return null;
    const r = this.sql.exec("SELECT bytes, seq, epoch FROM e2e_wrappers WHERE kind = ? AND rid = ? AND epoch = ? ORDER BY seq DESC LIMIT 1", kind, id, h.epoch).toArray()[0] as Row | undefined;
    return r ? { wrapper: r.bytes as string, seq: Number(r.seq), epoch: Number(r.epoch) } : null;
  }

  /** An epoch's keyring, base64url, or null (only the current epoch's is kept). */
  /** Any epoch's keyring row, its bytes base64url: a device walks back through them (chained keyrings). */
  keyring(epoch: number): { epoch: number; generation: string; suite: number; prev: string; prev_ring: string; keyring: string } | null {
    if (!Number.isSafeInteger(epoch) || epoch < 1) throw new SyncError("invalid", "an epoch from 1 on");
    if (this.sql.exec("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'e2e_keyrings'").toArray().length === 0) return null;
    const r = this.sql.exec("SELECT epoch, generation, suite, prev, prev_ring, bytes FROM e2e_keyrings WHERE epoch = ?", epoch).toArray()[0] as Row | undefined;
    return r ? { epoch: Number(r.epoch), generation: r.generation as string, suite: Number(r.suite), prev: r.prev as string, prev_ring: r.prev_ring as string, keyring: b64(new Uint8Array(r.bytes as ArrayBuffer)) } : null;
  }

  // ---- the enrollment mailbox

  /** Post a phase's message. Phase 1 opens the session; each later phase needs the one before; each is written once. */
  post(session: unknown, phase: unknown, msg: unknown, now = Date.now()): { expires: number } {
    if (typeof session !== "string" || !ID.test(session)) throw new SyncError("invalid", "not a session id");
    if (!Number.isSafeInteger(phase) || (phase as number) < 1 || (phase as number) > E2E.phases) throw new SyncError("invalid", "a phase is 1 to 5");
    if (typeof msg !== "string" || msg.length === 0 || utf8(msg).length > E2E.messageBytes) throw new SyncError("invalid", "a message is text, at most 16 KiB");
    return this.transaction(() => {
      for (const s of E2E_SCHEMA) this.sql.exec(s);
      // (an expired session's rows stay a day, so its id can't be opened again, then are swept)
      this.sql.exec("DELETE FROM e2e_mailbox WHERE expires <= ?", now - TOMBSTONE_MS);
      const first = this.sql.exec("SELECT expires FROM e2e_mailbox WHERE session = ? AND phase = 1", session).toArray()[0] as Row | undefined;
      if (first && Number(first.expires) <= now) throw new SyncError("missing", "that session has expired");
      if (this.sql.exec("SELECT 1 AS x FROM e2e_mailbox WHERE session = ? AND phase = ?", session, phase).toArray().length) throw new SyncError("exists", "that phase was posted already");
      let expires: number;
      if (phase === 1) {
        const live = Number((this.sql.exec("SELECT COUNT(DISTINCT session) AS n FROM e2e_mailbox WHERE expires > ?", now).toArray()[0] as Row).n);
        if (live >= E2E.sessions) throw new SyncError("limit", "too many enrollments at once", { max: E2E.sessions });
        expires = now + E2E.sessionMs;
      } else {
        if (!first) throw new SyncError("missing", "no such session");
        if (!this.sql.exec("SELECT 1 AS x FROM e2e_mailbox WHERE session = ? AND phase = ?", session, (phase as number) - 1).toArray().length) throw new SyncError("order", "the phase before hasn't been posted");
        expires = Number(first.expires);
      }
      this.sql.exec("INSERT INTO e2e_mailbox (session, phase, msg, expires) VALUES (?, ?, ?, ?)", session, phase, msg, expires);
      return { expires };
    });
  }

  /** Read a phase's message, or null (not posted, or expired). */
  read(session: unknown, phase: unknown, now = Date.now()): { msg: string; expires: number } | null {
    if (typeof session !== "string" || !ID.test(session)) throw new SyncError("invalid", "not a session id");
    if (!Number.isSafeInteger(phase) || (phase as number) < 1 || (phase as number) > E2E.phases) throw new SyncError("invalid", "a phase is 1 to 5");
    if (this.sql.exec("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'e2e_mailbox'").toArray().length === 0) return null;
    const r = this.sql.exec("SELECT msg, expires FROM e2e_mailbox WHERE session = ? AND phase = ? AND expires > ?", session, phase, now).toArray()[0] as Row | undefined;
    return r ? { msg: r.msg as string, expires: Number(r.expires) } : null;
  }
}
