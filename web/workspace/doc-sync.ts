// Notebooks' contents on the account socket (sync 2c-3; design-2c3 r1, with sync-docs' server answers and astra's A1-A5).
// DEV-only, behind the docsync switch: the early version, without 2c-4's rebase and conflict copies.
//
// Sending: a started notebook's local patches (its l rows, 2c-2) go up one notebook a batch, its client claimed first
// (`doc_claim`), each batch's rows marked sent with the request that carries them (so an answer is bound to exactly the
// rows it answers), `kind` and `owner` on every batch.  An ack releases them; `order` with `next_cseq` acks those
// below it and resends from it; `unknown_client` claims again; a transient refusal waits; anything final (and a
// parent-only `order`) stops the notebook here, its rows kept, nothing deleted.
// Receiving: `changed` (and every connect) pulls; each page is checked against the chain from the cursor and the
// binding's owner, then applied in one history transaction under a compare and swap of the cursor (journal-rows.js
// applyPage), and told to the notebook's history in every tab; the writer then makes the record the merged value
// (web/notebook/journal.js).  One flight per notebook: a pull and a send of one notebook never overlap here.
import { applyPage, acked, markSent, readCursor, readJournal, recordClaim, syncedKey, unsent } from "../notebook/journal-rows.js";
import { IdbPatchStore, openHistoryDb, tellHistory, tellAcked } from "../notebook/stores.js";
import { makeClientId } from "patchflow";
import { chainStart, hex, fromHex, verifyChainPage, type ChainedBatch, type ChainState } from "../sync-protocol/doc-protocol";
import { toB64, fromB64, LIMITS } from "../sync-protocol/protocol";

/** What the account connection gives document sync: a request and its answer (an `ack`, a `batches`, or an `error`). */
export interface DocLink {
  /** the binding's account hash: `owner` on every message, and checked on every answer */
  owner: string;
  /** the next request id (a batch's rows are marked with it before it is sent) */
  reserve(): number;
  /** send `m` as request `req`; resolves its answer (`ack`, `batches` or `error`) */
  ask(req: number, m: Record<string, unknown>): Promise<Record<string, unknown>>;
}
/** Why a notebook stopped syncing on this device (DEV: until 2c-4), and when. */
export type Stopped = { code: string; detail?: string; at: number };
/** Transient refusals: nothing removed, sent again later (`readonly` at the next connection, not on a timer: the
 * account can't write until its plan or state changes, and the server says so unasked, without a req). */
const TRANSIENT = new Set(["rate", "busy", "storage_full", "readonly", "unavailable"]);
const enc = new TextEncoder(), dec = new TextDecoder();

export class DocSync {
  private link: DocLink | null = null;
  private hdb: IDBDatabase | null = null;
  private flights = new Map<string, Promise<void>>();
  private again = new Set<string>();
  // (each connect and disconnect raises it: a flight's requests belong to the connection it began on, and nothing it
  // learns after that connection is gone (a `busy` for the drop) holds or stops a notebook)
  private conn = 0;
  /** the notebooks held after a transient refusal, each by its hold's token: no request for them until their timer
   * (that same hold's: an older timer never lifts a newer hold) or, for `readonly`, the next connection */
  readonly held = new Map<string, number>();
  private holds = 0;
  /** the notebooks stopped here, and why (the Sync panel's per-document state) */
  readonly stopped = new Map<string, Stopped>();
  /** what happened, for tests and the driver: acks, refusals, applied pages */
  readonly events: Record<string, unknown>[] = [];
  constructor(private opts: { now?: () => number; retryMs?: number; askMs?: number } = {}) {}
  // (a request and its answer, or, if none comes in time (a lost answer on a live socket), a transient `busy`: the
  // flight never waits for good, and what it sent is sent again later (its rows stay until an ack))
  private ask(link: DocLink, req: number, m: Record<string, unknown>): Promise<Record<string, unknown>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<Record<string, unknown>>((r) => { timer = setTimeout(() => r({ t: "error", code: "busy", detail: { message: "no answer in time" } }), this.opts.askMs ?? 30_000); });
    return Promise.race([link.ask(req, m), late]).finally(() => clearTimeout(timer));
  }

  private async db(): Promise<IDBDatabase> {
    this.hdb ??= await openHistoryDb();
    return this.hdb;
  }
  // (one history write through a journal store of the notebook's synced key: the workspace's word and the fence checked
  // in its transaction, as every journal write is)
  private async tx<T>(id: string, n: number, fn: (st: IDBObjectStore) => Promise<T>): Promise<T> {
    const store = new IdbPatchStore(await this.db(), syncedKey(id, n), { journal: {} });
    let out: T | undefined, err: unknown;
    const r = await store.journalTx(async (st: IDBObjectStore) => { try { out = await fn(st); return { j: 0 }; } catch (e) { err = e; throw e; } });
    if (r?.j === undefined) throw err ?? Object.assign(new Error(r?.refused ?? "not written"), { refusal: r?.refused });
    return out as T;
  }

  /** The account connection is up: every started notebook pulled, then its unsent patches sent. */
  async connected(link: DocLink) {
    this.link = link;
    this.conn++;
    this.held.clear();
    await this.kickStarted();
  }
  /** Every notebook whose synced history has started here kicked: a connect does it, and so does a page holding the
   * connection when another page says it turned the switch on (a notebook's synced history may have started there
   * since this connected, its start told to no one: doc-sync-switch.ts followDocSync, #266 r5's case 14). */
  async kickStarted() {
    for (const id of await this.started()) this.kick(id);
  }
  disconnected() { this.link = null; this.conn++; }
  /** Another device changed `doc` (`changed {owner, doc, head}`): pulled (and started here if it wasn't). */
  changed(m: Record<string, unknown>) {
    if (!this.link || m.owner !== this.link.owner || typeof m.doc !== "string") return;
    this.kick(m.doc, true);
  }
  /** A notebook's local patches or the server's head moved: one flight for it, run again if asked meanwhile. */
  kick(id: string, startHere = false) {
    if (this.flights.has(id)) { this.again.add(id); return; }
    const run = (async () => {
      do {
        this.again.delete(id);
        const link = this.link, conn = this.conn;
        if (!link) return;
        try {
          // (each request admitted by live(): a pull that held or stopped the notebook, or a dropped connection, ends
          // the flight before anything more is asked (astra's CORR-2C3-1))
          if (await this.pull(id, startHere, link, conn)) await this.send(id, link, conn);
        } catch (e) {
          // (a failure of a flight whose connection is gone (a write that failed after a reconnect) is that flight's: the
          // newer connection's flight is not stopped by it (astra's r2 CORR-2C3-1))
          this.stop(id, "invalid", (e as Error)?.message ?? String(e), conn);
        }
      } while (this.again.has(id));
    })().finally(() => this.flights.delete(id));
    this.flights.set(id, run);
  }
  // (a request of a flight may go: its connection still the live one, its notebook neither held nor stopped)
  private live(id: string, conn: number) {
    return this.link !== null && conn === this.conn && !this.stopped.has(id) && !this.held.has(id);
  }
  /** Settled: every flight done (tests). */
  async idle() { while (this.flights.size) await Promise.allSettled([...this.flights.values()]); }

  // (false: what a flight's pull returns for a stop.  `conn`: the flight's connection; a stop learned on one that is
  // gone is dropped, so nothing an older connection answers or fails at stops the notebook for the newer one)
  private stop(id: string, code: string, detail?: string, conn?: number): false {
    if (conn !== undefined && conn !== this.conn) return false;
    this.stopped.set(id, { code, detail: detail?.slice(0, 300), at: (this.opts.now ?? Date.now)() });
    this.events.push({ t: "stopped", doc: id, code, detail });
    return false;
  }
  // (the notebooks whose synced history has started here)
  private async started(): Promise<string[]> {
    const hdb = await this.db();
    const regs = await new Promise<{ time: string }[]>((ok, no) => {
      const r = hdb.transaction("history").objectStore("history").getAll(IDBKeyRange.bound(["\u0001s:", "d:local:"], ["\u0001s:", "d:local:￿"]));
      r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error);
    });
    const out: string[] = [];
    for (const r of regs) {
      const id = r.time.slice("d:local:".length);
      if ((await readJournal(hdb, id)).start) out.push(id);
    }
    return out;
  }

  // ---- sending

  private async send(id: string, link: DocLink, conn: number) {
    for (let round = 0; round < 64; round++) {
      const js = await readJournal(await this.db(), id);
      if (!js.start || !js.slot) return;
      const slot = js.slot, epoch = js.cursor?.epoch ?? 1;
      const rows = (await unsent(await this.db(), id, { max: LIMITS.batchPatches, maxBytes: LIMITS.batchBytes })).filter((r: any) => r.gen === slot.gen && r.client === slot.client);
      if (!rows.length) return;
      // (claimed first, for this epoch and this client: the answer recorded only for the client it was asked for)
      if (slot.claimed?.epoch !== epoch || slot.claimed?.client !== slot.client) {
        if (!this.live(id, conn)) return;
        const req = link.reserve();
        const a = await this.ask(link, req, { t: "doc_claim", owner: link.owner, doc: id, epoch, client: slot.client });
        if (a.t === "error") { this.refused(id, a, conn); return; }
        const c = a.claim as { client?: string; fgen?: number; next_cseq?: number } | undefined;
        if (!c || c.client !== slot.client || !Number.isSafeInteger(c.fgen)) return this.stop(id, "invalid", "a claim's answer", conn);
        await this.tx(id, js.start.n, (st) => recordClaim(st, id, { gen: slot.gen, client: slot.client, epoch, fgen: c.fgen }));
        continue;
      }
      // (the batch: the patches' envelopes and their payloads, each the stored patch without its time and parents)
      const key = syncedKey(id, js.start.n), hdb = await this.db();
      const stored = await Promise.all(rows.map((r: any) => new Promise<any>((ok, no) => {
        const g = hdb.transaction("history").objectStore("history").get([key, r.time]);
        g.onsuccess = () => ok(g.result); g.onerror = () => no(g.error);
      })));
      const parts: Uint8Array[] = [], envs: Record<string, unknown>[] = [];
      let bytes = 0;
      for (let i = 0; i < rows.length; i++) {
        const env = stored[i]?.env;
        if (!env) return this.stop(id, "invalid", "an unsent patch isn't stored", conn);
        const { time: _t, parents, ...payload } = env;
        const b = enc.encode(JSON.stringify(payload));
        if (bytes + b.length > LIMITS.batchBytes && envs.length) break;
        if (b.length > LIMITS.batchBytes) return this.stop(id, "limit", "a patch over 1 MiB (blobs are 2c-4's)", conn);
        bytes += b.length;
        parts.push(b);
        envs.push({ cseq: rows[i].cseq, id: rows[i].time, parents: parents ?? [], size: b.length });
      }
      const body = new Uint8Array(bytes);
      let at = 0;
      for (const p of parts) { body.set(p, at); at += p.length; }
      if (!this.live(id, conn)) return;
      const upTo = envs[envs.length - 1].cseq as number, req = link.reserve();
      await this.tx(id, js.start.n, (st) => markSent(st, id, { gen: slot.gen, client: slot.client, upTo, fgen: slot.fgen, epoch, req }));
      // (admitted again after the write: the connection may have gone, or the notebook been held or stopped, while it
      // committed; the marked rows are sent again by a later flight (astra's r2 CORR-2C3-1))
      if (!this.live(id, conn)) return;
      const a = await this.ask(link, req, { t: "batch", owner: link.owner, doc: id, epoch, kind: "notebook", patches: envs, body: toB64(body), fgen: { [slot.client]: slot.fgen } });
      if (a.t === "ack") {
        const n = await this.tx(id, js.start.n, (st) => acked(st, id, { gen: slot.gen, client: slot.client, upTo, epoch, req }));
        // (debt released: the writer's history, paused for want of room, resumes (astra's CORR-2C3-3))
        if (n) tellAcked(key);
        this.events.push({ t: "ack", doc: id, patch: envs[envs.length - 1].id, seq: (a.batch as any)?.seq, n });
        continue;
      }
      const code = String(a.code ?? "");
      const detail = (a.detail && typeof a.detail === "object" ? a.detail : {}) as { next_cseq?: number; client?: string };
      if (code === "order" && Number.isSafeInteger(detail.next_cseq)) {
        // (the rows of this request below next_cseq were accepted: acknowledged, and the rest resent from it)
        if (detail.next_cseq! > 1 && (await this.tx(id, js.start.n, (st) => acked(st, id, { gen: slot.gen, client: slot.client, upTo: detail.next_cseq! - 1, epoch, req })))) tellAcked(key);
        continue;
      }
      if (code === "unknown_client") {
        // (the claim forgotten (no epoch), so the next round claims again; idempotent on the server)
        await this.tx(id, js.start.n, (st) => recordClaim(st, id, { gen: slot.gen, client: slot.client, epoch: null, fgen: slot.fgen }));
        continue;
      }
      this.refused(id, a, conn, envs[envs.length - 1].id as string);
      return;
    }
  }
  // (a refusal: transient ones hold the notebook (each hold its own token); final ones (and a parent-only `order`)
  // stop it.  One that came after its connection was gone (the drop's `busy`) does neither: the next connection asks
  // again)
  private refused(id: string, a: Record<string, unknown>, conn: number, patch = "") {
    const code = String(a.code ?? "");
    this.events.push({ t: "refused", doc: id, patch, code });
    if (conn !== this.conn) return;
    if (TRANSIENT.has(code)) {
      const token = ++this.holds;
      this.held.set(id, token);
      if (code !== "readonly") setTimeout(() => { if (this.held.get(id) !== token) return; this.held.delete(id); this.kick(id); }, this.opts.retryMs ?? 30_000);
      return;
    }
    this.stop(id, code, JSON.stringify(a.detail ?? {}).slice(0, 200));
  }

  // ---- receiving

  // (true: the flight goes on to send; false: the notebook was held or stopped, or the connection is gone)
  private async pull(id: string, startHere: boolean, link: DocLink, conn: number): Promise<boolean> {
    for (let page = 0; page < 1000; page++) {
      const { cursor, start } = await this.read(id);
      if (!start && !startHere) return true;
      if (!this.live(id, conn)) return false;
      const epoch = cursor?.epoch ?? 1, after = cursor?.after ?? 0;
      const req = link.reserve();
      const a = await this.ask(link, req, { t: "pull", owner: link.owner, doc: id, epoch, after, limit: 100 });
      if (a.t === "error") {
        // (not on the server yet (its first claim makes it): nothing to pull)
        if (a.code === "unknown_doc") return true;
        this.refused(id, a, conn);
        return false;
      }
      if (a.t !== "batches" || a.owner !== link.owner || a.doc !== id || !Array.isArray(a.items)) return this.stop(id, "invalid", "a pull's answer", conn);
      // (a snapshot: keeping the local root, debt and mark across one needs 2c-4: stopped here on DEV (astra's A5))
      if (a.snapshot) return this.stop(id, "snapshot", "a snapshot start is 2c-4's", conn);
      const items = a.items as Record<string, unknown>[];
      if (!items.length) return true;
      const from: ChainState = cursor ? { seq: cursor.after, recv: cursor.recv, chain: fromHex(cursor.chain) } : chainStart(link.owner, id, epoch);
      const page: ChainedBatch[] = items.map((b) => ({ seq: b.seq as number, recv: b.recv as number, epoch, author: String(b.author), writer: String(b.writer), envs: JSON.stringify(b.patches), body: fromB64(b.body, LIMITS.batchBytes), chain: String(b.chain) }));
      const v = verifyChainPage({ epoch }, from, page);
      if (!v.ok) return this.stop(id, "chain", `${v.why} at seq ${v.at}`, conn);
      // (each patch: its envelope and its payload slice, the stored patch again; one that carries its own time or
      // parents is refused, as sync-server §5.2 says)
      const rows: { time: string; env: Record<string, unknown> }[] = [];
      for (let i = 0; i < items.length; i++) {
        let at = 0;
        for (const e of items[i].patches as { id: string; parents: string[]; size: number }[]) {
          const payload = JSON.parse(dec.decode(page[i].body.subarray(at, at + e.size)));
          at += e.size;
          if (payload && ("time" in payload || "parents" in payload)) return this.stop(id, "invalid", "a payload with its own time or parents", conn);
          rows.push({ time: e.id, env: { ...payload, time: e.id, parents: e.parents } });
        }
      }
      const next = { epoch, after: v.state.seq, recv: v.state.recv, chain: hex(v.state.chain) };
      const out = await this.tx(id, start?.n ?? 1, (st) => applyPage(st, id, { expect: cursor, next, rows, start: start ? undefined : { client: makeClientId() } }));
      for (const r of rows) tellHistory(syncedKey(id, start?.n ?? 1), r.env);
      this.events.push({ t: "page", doc: id, through: next.after, applied: out.applied });
      if (!a.more) return true;
    }
    return true;
  }
  private async read(id: string): Promise<{ cursor: { epoch: number; after: number; recv: number; chain: string } | null; start: { n: number } | null }> {
    const hdb = await this.db();
    return new Promise((ok, no) => {
      const tx = hdb.transaction("history", "readonly");
      let out: any;
      readCursor(tx.objectStore("history"), id).then((r: any) => { out = r; }, no);
      tx.oncomplete = () => ok(out);
      tx.onerror = () => no(tx.error);
    });
  }
}
