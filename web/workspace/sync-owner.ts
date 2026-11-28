// The page's sync owner (sync client step 5, plan-step5-sync-ui r4 §2): one per Workspace, in every page that
// shows the file browser.  It decides whether this page runs a sync client, keeps it to the durable lifecycle, and
// carries the sender's status to the other tabs.
//
// - Eligible: the durable lease `sync:current` is present and not off, and the session's account (/api/share/me)
//   hashes to the lease's namespace.  The owner fences on (ns, epoch, !off), the lifecycle, never on the lease's
//   generation: a connection's own renewal (renewLease) raises the generation and leaves the owner eligible; an off,
//   a sign-out, a delete or another namespace moves the epoch (or sets off) and stops it.
// - The client is made by one factory, startSync (with the confirmed index: step 4), started when eligible and stopped
//   when not; its lock wait, timers and socket go with stop().
// - Lifecycle nudges (`on`, `off`, `deleting`, `signout`) on a BroadcastChannel make every tab reconcile from the
//   durable state; the message's content is never trusted.  pagehide suspends for good (the client stopped, channels
//   closed); pageshow reconciles afresh with a new client.  A visible tab reconciles at most once a minute too.
// - A session that couldn't be asked (offline, a 5xx or a 429 from /api/share/me) is neither yes nor no: with no client
//   running, the owner tries again on a timer, OWNER.retryMs doubling to OWNER.retryMaxMs, and at once when the browser
//   says it is back online; a client starting resets it.  A 401, a 403 or another account is a final no: no retry.
// - Status across tabs: only the lock holder publishes, `holder {ns, epoch, gen}` after each renewal, then `status
//   {ns, epoch, gen, rev, snapshot}` (rev from 1 for each gen), equal snapshots suppressed, at most one per
//   STATUS_PUB.minGapMs, the newest kept for a trailing slot.  A follower orders by (gen, rev) and never rebroadcasts;
//   it asks `status?` once per mount, pageshow and holder message, and the holder's whole state for those requests is
//   one boolean, `forced`: the next slot publishes even an unchanged snapshot (r4, LIMIT-STEP5-R3-1).
// - Changes not sent: while sync is on here, the view carries how many of this browser's changes haven't gone up,
//   the outbox's records and the ops logged past the scan watermark (UNSENT.max at most, then "more"), read again on
//   every change here and every reconcile; the line never says "Synced", nor nothing, while there are any.  A read
//   visits UNSENT.visit op records at most, and goes on after the last one it read the next time (the ops past the
//   watermark are never changed or deleted while it holds): a long tail of the server's own ops is read once, a part
//   a time, the next read scheduled by the last (setTimeout 0) until the end; until then the count is "this many
//   or more".
import type { Workspace } from "./api";
import { req } from "./db";
import { SyncClient, realClock, type ClientOptions, type SyncStatus } from "./sync-client";
import { confirmedIndex } from "./sync-confirmed";
import { accountHash } from "../sync-protocol/protocol";
import { detectOldSync, OLD_SYNC_REASON, UNREADABLE_REASON, type OldSync } from "./sync-old";
import { BLOCKED_LINE, resetSyncHere, type SyncBlocked } from "./sync-reset";

export const STATUS_PUB = {
  /** status messages at most this often (one slot) */
  minGapMs: 500,
  /** a status message's serialized size at most, UTF-8, its envelope included (its reason shortened to fit) */
  maxBytes: 512,
};
/** Changes not sent: counted up to `max`, past it said as "more"; at most `visit` op records read a time. */
export const UNSENT = { max: 1000, visit: 2000 };
export const OWNER = {
  /** a visible tab reconciles at most this often */
  visibleMs: 60_000,
  /** after a session that couldn't be asked, the first try again (then doubling) */
  retryMs: 2000,
  /** …and the longest wait between tries */
  retryMaxMs: 60_000,
  /** how long the session's question may take before it counts as unanswered (a hung request never holds the owner) */
  askMs: 15_000,
};

/** The production client: always with the confirmed index (step 4's onIndex), so a namespace's first sync adopts
 * the local tree and other devices' changes are applied (CORR-STEP5-4). */
export function startSync(w: Workspace, opts: ClientOptions = {}): SyncClient {
  return new SyncClient(w, { onIndex: confirmedIndex(w), ...opts });
}

/** What the foot shows: the holder's snapshot, or this page's own client's status. */
export type Snapshot = { state: SyncStatus["state"]; waiting?: number; unsent?: number; unsentMore?: boolean; reason?: string; message?: string; used?: boolean; lastSynced?: number; resumesAt?: number; full?: boolean; limit?: { limit_bytes: number | null; used_bytes: number }; ready?: string[]; stuck?: boolean };
export type StatusMsg = { t: "status"; ns: string; epoch: number; gen: number; rev: number; snapshot: Snapshot };
type HolderMsg = { t: "holder"; ns: string; epoch: number; gen: number };
// (`fresh`: syncReady's token, the holder's client reads the server's log to its end for it: refresh)
type AskMsg = { t: "status?"; ns: string; epoch: number; fresh?: string };
export type LifeKind = "on" | "off" | "deleting" | "signout";

const owners = new WeakMap<Workspace, SyncOwner>();
type Life = { ns: string; epoch: number };

export class SyncOwner {
  /** The owner of `w` (one per Workspace). */
  static of(w: Workspace, opts: ClientOptions = {}): SyncOwner {
    let o = owners.get(w);
    if (!o) owners.set(w, (o = new SyncOwner(w, opts)));
    return o;
  }

  client: SyncClient | null = null;
  private run: Promise<void> | null = null;
  private life: Life | null = null;
  private lifeCh: BroadcastChannel | null = null;
  private statCh: BroadcastChannel | null = null;
  private statNs = "";
  private subs = new Set<() => void>();
  private suspended = false;
  private reconciling: Promise<void> | null = null;
  private again = false;
  private lastVisible = 0;
  private unhook: (() => void) | null = null;
  private unStatus: (() => void) | null = null;
  // (a session that couldn't be asked: the pending try again, and the wait before the next)
  private retry: (() => void) | null = null;
  private retryWait = OWNER.retryMs;
  // (changes not sent: the lease's namespace while sync is on here, the count and whether it reached UNSENT.max, and
  // the recount's single flight)
  private leaseNs: string | null = null;
  private unsent = 0;
  private unsentMore = false;
  private unwatch: (() => void) | null = null;
  private counting: Promise<void> | null = null;
  private countAgain = false;
  // (the next read, scheduled after one that stopped at UNSENT.visit)
  private countOn: ReturnType<typeof setTimeout> | null = null;
  // (the ops past the watermark read so far: up to which seq, and how many of them aren't the server's)
  private opsRead: { ns: string; scanned: number; to: number; n: number } | null = null;
  /** this page's own client's status */
  own: Snapshot = { state: "off" };
  /** the holder's snapshot, as followed here (or published here), with its order */
  holder: { gen: number; rev: number; snapshot: Snapshot | null } | null = null;
  /** whether the namespace's sender lock is held (by any tab), as last checked */
  lockHeld = false;
  /** the account's limit, as GET status gave it (null when unknown), for the snapshot; cleared on a lifecycle change */
  limit: { limit_bytes: number | null; used_bytes: number } | null = null;
  // (the holder's side: its token, its revision, what it last published and when, the one bit for status? requests)
  private gen = 0;
  private rev = 0;
  private lastJson = "";
  private lastAt = -Infinity;
  private forced = false;
  private slot: ReturnType<typeof setTimeout> | null = null;
  // (EXACT-ONLY: this browser's old-sync detection, kept once it has an answer (a read that failed isn't kept))
  private old: OldSync | null = null;
  /** (tests) what the holder side did */
  readonly stats = { published: 0, asks: 0, suppressed: 0, reconciles: 0, retries: 0, unsentReads: 0, unsentVisited: 0, unsentMostRead: 0 };

  private constructor(readonly w: Workspace, private opts: ClientOptions) {}

  /** `f()` whenever what the foot shows may have changed; returns how to stop. */
  onChange(f: () => void): () => void {
    this.subs.add(f);
    return () => this.subs.delete(f);
  }
  private changed() {
    for (const f of this.subs) try { f(); } catch (e) { console.warn("sync owner:", e); }
  }

  /** What the foot shows now: the holder's snapshot for this lifecycle while the lock is held, else this page's own. */
  view(): { from: "holder" | "own"; s: Snapshot } {
    const h = this.holder;
    const v: { from: "holder" | "own"; s: Snapshot } = this.life && h?.snapshot && this.lockHeld && !this.isHolder() ? { from: "holder", s: h.snapshot } : { from: "own", s: this.own };
    // (this browser's changes not sent, whoever's snapshot is shown: the database is the same)
    if (this.unsent > 0 || this.unsentMore) v.s = { ...v.s, unsent: this.unsent, ...(this.unsentMore ? { unsentMore: true } : {}) };
    return v;
  }
  /** Counts this browser's changes not sent (the outbox's records and the ops past the scan watermark), and says so
   * if the count changed.  One at a time; asked again meanwhile, once more after; a read that stopped before the
   * end schedules the next. */
  recount(): Promise<void> {
    if (this.counting) {
      this.countAgain = true;
      return this.counting;
    }
    this.counting = (async () => {
      let rest = false;
      do {
        this.countAgain = false;
        const [n, more, partial] = await this.countUnsent().catch(() => [this.unsent, this.unsentMore, false] as const);
        rest = partial;
        if (n !== this.unsent || more !== this.unsentMore) {
          this.unsent = n;
          this.unsentMore = more;
          this.changed();
        }
      } while (this.countAgain && !this.suspended);
      if (rest && !this.suspended && !this.countOn) this.countOn = setTimeout(() => { this.countOn = null; void this.recount(); }, 0);
    })().finally(() => { this.counting = null; });
    return this.counting;
  }
  /** (tests) whether a count is being read or scheduled */
  countingNow() { return !!this.counting || !!this.countOn; }
  /** [the count (UNSENT.max at most), whether there may be more, whether the read stopped before the end of the ops] */
  private countUnsent(): Promise<readonly [number, boolean, boolean]> {
    const ns = this.leaseNs;
    if (!ns) return Promise.resolve([0, false, false] as const);
    return new Promise((ok, no) => {
      const tx = this.w.ws.transaction(["meta", "ops"], "readonly"), meta = tx.objectStore("meta");
      Promise.all([req(meta.get(`sync:${ns}:outbox`)), req(meta.get(`sync:${ns}:scanned`))]).then(([o, scanned]) => {
        const queued = Math.max(0, (o as { count?: number } | undefined)?.count ?? 0);
        // (before the first scan nothing is past a watermark: what was here then is adopted, not scanned)
        if (typeof scanned !== "number") return ok([Math.min(queued, UNSENT.max), queued > UNSENT.max, false] as const);
        // (on from where the last read of this watermark stopped; a new watermark or namespace, from it)
        const r = this.opsRead?.ns === ns && this.opsRead.scanned === scanned ? this.opsRead : { ns, scanned, to: scanned, n: 0 };
        this.opsRead = r;
        this.stats.unsentReads++;
        let visited = 0;
        const c = tx.objectStore("ops").openCursor(IDBKeyRange.lowerBound(r.to, true));
        c.onsuccess = () => {
          const cur = c.result, n = queued + r.n;
          // (past UNSENT.max, or stopped before the end at UNSENT.visit: this many or more)
          if (!cur || n > UNSENT.max || visited >= UNSENT.visit) {
            this.stats.unsentMostRead = Math.max(this.stats.unsentMostRead, visited);
            return ok([Math.min(n, UNSENT.max), n > UNSENT.max || !!cur, !!cur && n <= UNSENT.max] as const);
          }
          visited++;
          this.stats.unsentVisited++;
          // (an op applied from the server is never sent back)
          if ((cur.value as { origin?: string }).origin !== "server") r.n++;
          r.to = cur.key as number;
          cur.continue();
        };
        c.onerror = () => no(c.error);
      }, no);
    });
  }
  isHolder() { return this.gen > 0; }

  /** Begins: lifecycle nudges heard, the page's lifecycle followed, and a first reconcile. */
  start(): this {
    this.suspended = false;
    this.openLife();
    if (!this.unwatch) this.unwatch = this.w.watch(() => void this.recount());
    if (!this.unhook && typeof addEventListener === "function") {
      const hide = () => this.suspend();
      const show = (ev: Event) => { if ((ev as PageTransitionEvent).persisted) this.resume(); };
      const vis = () => {
        if (document.visibilityState !== "visible" || Date.now() - this.lastVisible < OWNER.visibleMs) return;
        this.lastVisible = Date.now();
        void this.reconcile();
      };
      // (back online: a try that was waiting goes at once)
      const online = () => {
        if (!this.retry) return;
        this.clearRetry();
        void this.reconcile();
      };
      addEventListener("pagehide", hide);
      addEventListener("pageshow", show);
      addEventListener("online", online);
      document.addEventListener("visibilitychange", vis);
      this.unhook = () => { removeEventListener("pagehide", hide); removeEventListener("pageshow", show); removeEventListener("online", online); document.removeEventListener("visibilitychange", vis); };
    }
    void this.reconcile();
    return this;
  }
  /** pagehide: the client stopped for good (never reused), channels closed, timers cleared. */
  suspend() {
    this.suspended = true;
    this.clearRetry();
    this.retryWait = OWNER.retryMs;
    if (this.countOn) clearTimeout(this.countOn);
    this.countOn = null;
    void this.stopClient();
    this.closeStatus();
    try { this.lifeCh?.close(); } catch {}
    this.lifeCh = null;
  }
  /** pageshow from the back/forward cache: everything afresh. */
  resume() {
    this.suspended = false;
    this.openLife();
    void this.reconcile();
  }
  /** Ends it (tests, the page closing the workspace): suspended and unhooked. */
  destroy() {
    this.suspend();
    this.unhook?.();
    this.unhook = null;
    this.unwatch?.();
    this.unwatch = null;
    owners.delete(this.w);
  }

  /** A lifecycle change made here (after its durable write): every tab told, this one reconciled. */
  nudge(kind: LifeKind) {
    try { this.lifeCh?.postMessage({ kind }); } catch {}
    if (kind !== "on") this.limit = null;
    void this.reconcile();
  }

  /** The account's keys when its sync is end to end: the sealing module's key provider this owner's clients are made
   * with, or null (a page's document keys, doc-keys.ts pageDocKeys). */
  e2eKeys(): NonNullable<ClientOptions["e2e"]>["keys"] | null {
    return this.opts.e2e?.keys ?? null;
  }
  /** (sync 2c-3, DEV's switch: web/workspace/doc-sync-switch.ts) notebooks' contents on this page's connection:
   * every client made from now on carries `docs`, and one running now is made again with it (its new connection's
   * welcome then connects it). */
  setDocs(docs: ClientOptions["docs"]) {
    this.opts = { ...this.opts, docs };
    if (this.client) void this.stopClient().then(() => this.reconcile());
  }
  /** The notebooks this page's document sync stopped (2c-3: they won't send until 2c-4), none if it has no document
   * sync here (another tab's page holds it). */
  stoppedDocs(): string[] {
    const s = (this.opts.docs as { stopped?: ReadonlyMap<string, unknown> } | undefined)?.stopped;
    return s instanceof Map ? [...s.keys()] : [];
  }
  /** Whether this page's sync client runs, waiting up to `ms` for one to start (the switch's third condition). */
  clientRunning(ms = 20_000): Promise<boolean> {
    if (this.client) return Promise.resolve(true);
    return new Promise((ok) => {
      const t = setTimeout(() => { off(); ok(!!this.client); }, ms);
      const off = this.onChange(() => {
        if (!this.client) return;
        clearTimeout(t);
        off();
        ok(true);
      });
    });
  }

  private openLife() {
    if (this.lifeCh || typeof BroadcastChannel !== "function") return;
    this.lifeCh = new BroadcastChannel("sagebrush-sync-life:" + this.w.ws.name);
    // (an old answer kept here is read again: another tab's reset may have cleared it)
    this.lifeCh.onmessage = () => {
      this.old = null;
      void this.reconcile();
    };
  }

  /** The durable lifecycle now: (ns, epoch) if sync is on here, else null. */
  async durable(): Promise<Life | null> {
    return new Promise((ok, no) => {
      const tx = this.w.ws.transaction("meta", "readonly"), meta = tx.objectStore("meta");
      Promise.all([req(meta.get("sync:current")), req(meta.get("sync:epoch"))]).then(([cur, e]) => {
        const c = cur as { ns: string; off?: boolean } | undefined;
        ok(c && !c.off ? { ns: c.ns, epoch: (e as number | undefined) ?? 0 } : null);
      }, no);
    });
  }
  /** Sync off here: whether it was used here (turned off, its lease kept), and why, for the sidebar's line. */
  private async offView(): Promise<Snapshot> {
    const cur = await new Promise<{ off?: boolean; why?: string } | undefined>((ok) => {
      const r = this.w.ws.transaction("meta", "readonly").objectStore("meta").get("sync:current");
      r.onsuccess = () => ok(r.result as { off?: boolean; why?: string } | undefined);
      r.onerror = () => ok(undefined);
    }).catch(() => undefined);
    if (!cur?.off) return { state: "off" };
    return { state: "off", used: true, ...(cur.why === "deleted" ? { reason: "your synced data was deleted" } : {}) };
  }
  /** Whether `l` is still the durable lifecycle (the client's fence). */
  private async holds(l: Life): Promise<boolean> {
    if (this.suspended) return false;
    const d = await this.durable();
    return !!d && d.ns === l.ns && d.epoch === l.epoch;
  }

  /** Reconciled from the durable state and the session: a client for the lifecycle that holds, none otherwise.  One
   * at a time; asked again meanwhile, once more after. */
  reconcile(): Promise<void> {
    if (this.reconciling) {
      this.again = true;
      return this.reconciling;
    }
    this.reconciling = (async () => {
      do {
        this.again = false;
        this.stats.reconciles++;
        await this.reconcileOnce().catch((e) => console.warn("sync owner: reconcile", e));
        void this.recount();
      } while (this.again && !this.suspended);
    })().finally(() => { this.reconciling = null; });
    return this.reconciling;
  }
  /** EXACT-ONLY: whether this browser holds sync state from a build before the cutover (sync-old.ts), read afresh;
   * found old, sync is off here and stays off, said in the snapshot (reconciled). */
  async checkOld(): Promise<OldSync> {
    const o = await this.detectOld();
    if (o.old) void this.reconcile();
    return o;
  }
  /** Why sync can't be turned on in this browser, or null when it can: old sync state here (a reset offered), or its
   * sync data unreadable (no reset: reload).  Read afresh. */
  async blocked(): Promise<SyncBlocked | null> {
    const o = await this.detectOld();
    if (!o.old) return null;
    const why = o.unreadable ? "unreadable" : "old-format";
    return { why, canReset: why === "old-format", line: BLOCKED_LINE[why] };
  }
  /** Reset sync on this browser (sync-reset.ts), then every tab told and this one reconciled: blocked() is then null.
   * Re-runnable.  Only for older sync data: sync data that couldn't be read is refused (nothing written; reload), and a
   * browser that isn't blocked has nothing to reset. */
  async resetHere(): Promise<void> {
    const b = await this.blocked();
    if (!b) return;
    if (!b.canReset) throw new Error(b.line);
    await this.stopClient();
    await resetSyncHere(this.w);
    this.old = null;
    this.nudge("off");
    await this.reconcile();
  }
  // (an answer kept, except one from a read that failed (old, failing closed): read again next time)
  private async detectOld(): Promise<OldSync> {
    const o = await detectOldSync(this.w);
    this.old = o.unreadable ? null : o;
    return o;
  }
  private async reconcileOnce() {
    if (this.suspended) return;
    let d = await this.durable();
    this.leaseNs = d?.ns ?? null;
    // (old sync state here: no client, whatever the lease says.  Old is kept; clean is read again while a lease is
    // live, which is one read (this build's enable writes the marker with the lease), so an old build's lease is seen)
    const old = this.old && (this.old.old || !d) ? this.old : await this.detectOld();
    if (old.old) {
      if (this.client) await this.stopClient();
      this.life = null;
      this.limit = null;
      this.holder = null;
      this.own = { state: "off", used: true, reason: old.unreadable ? UNREADABLE_REASON : OLD_SYNC_REASON };
      this.changed();
      return;
    }
    if (d) {
      const who = await this.sessionIs(d.ns);
      // (couldn't ask: a client that runs stays (it asks itself on each connection); with none, try again later, and
      // show sync as off until then.  A final answer, either way, ends any waiting try)
      if (who === "unknown" && !this.client) {
        this.later();
        d = null;
      } else {
        this.clearRetry();
        if (who === "no") d = null;
      }
    } else this.clearRetry();
    const same = !!d && !!this.life && d.ns === this.life.ns && d.epoch === this.life.epoch;
    if (same && this.client) return;
    // (another lifecycle, or none: what ran stops; the snapshot's limit and the followed holder go with it)
    if (this.client) await this.stopClient();
    if (!same) {
      this.limit = null;
      this.holder = null;
    }
    this.life = d;
    this.openStatus();
    if (!d || this.suspended) {
      this.own = await this.offView();
      this.changed();
      return;
    }
    const l = d;
    const c = startSync(this.w, {
      ...this.opts,
      lifecycle: { ns: l.ns, epoch: l.epoch, fence: () => this.holds(l) },
      onLease: (lease) => this.becameHolder(l, lease.gen),
      onRelease: () => this.demote(),
    });
    this.client = c;
    this.retryWait = OWNER.retryMs;
    this.unStatus = c.onStatus((s) => {
      this.own = snap(s, this.limit);
      // (the client's progress moves the outbox and the scan watermark: counted again)
      void this.recount();
      if (this.isHolder()) this.publish(false);
      void this.checkLock();
      this.changed();
    });
    this.run = c.start().catch((e) => console.warn("sync owner: client", e)).finally(() => {
      if (this.client === c) {
        this.gen = 0;
        this.client = null;
        this.unStatus?.();
        this.unStatus = null;
        // (the client ended by itself (signed out, fenced, sync off for the account, said in its status): nothing
        // restarts it until a nudge, a pageshow or the visible tab's reconcile, so an ending never loops)
        this.changed();
      }
    });
    this.ask();
  }
  /** Whether the session's account is the namespace's (its hash, the namespace's first part): "unknown" when it
   * couldn't be asked (the fetch threw, a 5xx, a 429); a 401, a 403 or another account is a final "no". */
  private async sessionIs(ns: string): Promise<"yes" | "no" | "unknown"> {
    // (a request that hangs, its answer or its body, is given up after OWNER.askMs: unanswered, so tried again later,
    // never waited on for good)
    const ac = new AbortController();
    const cancel = (this.opts.clock ?? realClock).after(OWNER.askMs, () => ac.abort());
    try {
      const f = this.opts.fetch ?? globalThis.fetch.bind(globalThis);
      const r = await f((this.opts.origin ?? location.origin) + "/api/share/me", { credentials: "same-origin", signal: ac.signal });
      if (r.status >= 500 || r.status === 429) return "unknown";
      if (!r.ok) return "no";
      const id = ((await r.json()) as { account_id?: unknown }).account_id;
      return typeof id === "string" && (await accountHash(id)) === ns.split(":")[0] ? "yes" : "no";
    } catch {
      // (offline, aborted, or an answer cut off on the way: asked again)
      return "unknown";
    } finally {
      cancel();
    }
  }
  /** Tries again after the current wait (doubling it, to OWNER.retryMaxMs): one waiting try at most, none once
   * suspended. */
  private later() {
    if (this.retry || this.suspended) return;
    const ms = this.retryWait;
    this.retryWait = Math.min(ms * 2, OWNER.retryMaxMs);
    this.retry = (this.opts.clock ?? realClock).after(ms, () => {
      this.retry = null;
      this.stats.retries++;
      void this.reconcile();
    });
  }
  private clearRetry() {
    this.retry?.();
    this.retry = null;
  }
  private async stopClient() {
    const c = this.client, run = this.run;
    this.client = null;
    this.run = null;
    this.gen = 0;
    this.unStatus?.();
    this.unStatus = null;
    if (this.slot) clearTimeout(this.slot);
    this.slot = null;
    if (c) {
      await c.stop();
      await run;
    }
  }

  // ---- status across tabs

  private openStatus() {
    const ns = this.life?.ns ?? "";
    if (ns === this.statNs && (this.statCh || !ns)) return;
    this.closeStatus();
    this.statNs = ns;
    if (!ns || typeof BroadcastChannel !== "function") return;
    this.statCh = new BroadcastChannel(`sagebrush-sync-status:${this.w.ws.name}:${ns}`);
    this.statCh.onmessage = (ev) => this.heard(ev.data as StatusMsg | HolderMsg | AskMsg);
  }
  private closeStatus() {
    if (this.slot) clearTimeout(this.slot);
    this.slot = null;
    try { this.statCh?.close(); } catch {}
    this.statCh = null;
    this.statNs = "";
  }
  private post(m: StatusMsg | HolderMsg | AskMsg) {
    try { this.statCh?.postMessage(m); } catch {}
  }
  /** (syncReady) The server's log read to its end for `token` by whichever tab holds the connection: this page's
   * client if it holds it, else the holder asked, for this lifecycle (its answer: the token in its status's `ready`). */
  refresh(token: string) {
    if (this.isHolder() && this.client) return this.client.refresh(token);
    this.client?.refresh(token);
    if (this.life) this.post({ t: "status?", ns: this.life.ns, epoch: this.life.epoch, fresh: token });
  }
  /** The lifecycle this owner follows now ((ns, epoch); null when sync is off here). */
  lifecycle(): Life | null { return this.life ? { ...this.life } : null; }
  /** The holder's generation as followed here (this page's own when it holds it), 0 when none is known. */
  holderGen(): number { return this.isHolder() ? this.gen : this.holder?.gen ?? 0; }
  /** A follower's one request for the holder's snapshot (once per mount, pageshow and holder message). */
  private ask() {
    if (this.life) this.post({ t: "status?", ns: this.life.ns, epoch: this.life.epoch });
  }
  private heard(m: StatusMsg | HolderMsg | AskMsg) {
    const l = this.life;
    if (!l || !m || m.ns !== l.ns) return;
    // (another epoch: the durable state read again, rather than the message dropped for ever)
    if (m.epoch !== l.epoch) return void this.reconcile();
    if (m.t === "status?") {
      if (!this.isHolder()) return;
      this.stats.asks++;
      if (typeof m.fresh === "string") this.client?.refresh(m.fresh);
      this.forced = true;
      this.publish(true);
      return;
    }
    // (a holder newer than this page's own token: this page holds no longer)
    if ((m.t === "holder" || m.t === "status") && this.isHolder() && m.gen > this.gen) this.demote();
    if (m.t === "holder") {
      if (m.gen > (this.holder?.gen ?? 0) && m.gen !== this.gen) {
        this.holder = { gen: m.gen, rev: 0, snapshot: null };
        this.ask();
        void this.checkLock();
      }
      return;
    }
    if (m.t === "status") {
      const h = this.holder;
      if (m.gen === this.gen && this.isHolder()) return;
      if (h && (m.gen < h.gen || (m.gen === h.gen && m.rev <= h.rev))) return;
      this.holder = { gen: m.gen, rev: m.rev, snapshot: m.snapshot };
      void this.checkLock();
      this.changed();
    }
  }
  /** No longer the holder (the lock let go, or a newer holder announced): its token and pending publication dropped, so
   * nothing more is published under it, and the foot follows the current holder (astra3's CORR-PR130-2).  The client
   * stays: it may take the lock again, through its lifecycle fence. */
  private demote() {
    if (!this.gen) return;
    this.gen = 0;
    this.forced = false;
    if (this.slot) clearTimeout(this.slot);
    this.slot = null;
    void this.checkLock();
    this.changed();
  }
  /** This page's connection renewed the lease: it is the holder, its token `gen`; announced, then its status. */
  private becameHolder(l: Life, gen: number) {
    this.gen = gen;
    this.rev = 0;
    this.lastJson = "";
    this.holder = null;
    this.post({ t: "holder", ns: l.ns, epoch: l.epoch, gen });
    this.forced = true;
    this.publish(true);
  }
  /** The holder's publication, through one slot: at most one message per STATUS_PUB.minGapMs, the newest snapshot
   * kept for a trailing slot; an equal snapshot is not sent again unless `forced` (a status? asked meanwhile). */
  private publish(now: boolean) {
    if (!this.isHolder() || !this.life || this.suspended) return;
    const wait = this.lastAt + STATUS_PUB.minGapMs - Date.now();
    if (wait > 0 || this.slot) {
      if (!this.slot) this.slot = setTimeout(() => { this.slot = null; this.publish(true); }, Math.max(0, wait));
      return;
    }
    void now;
    const msg = statusMessage(this.life.ns, this.life.epoch, this.gen, this.rev + 1, { ...this.own, ...(this.limit ? { limit: this.limit } : {}) });
    const json = JSON.stringify(msg.snapshot);
    if (json === this.lastJson && !this.forced) {
      this.stats.suppressed++;
      return;
    }
    this.forced = false;
    this.lastJson = json;
    this.lastAt = Date.now();
    this.rev++;
    this.stats.published++;
    this.post(msg);
  }
  /** Whether the namespace's sender lock is held by any tab (asked when something changes; never on a timer). */
  private async checkLock() {
    const ns = this.life?.ns, locks = (globalThis.navigator as any)?.locks;
    if (!ns || !locks?.query) return;
    try {
      const q = await locks.query();
      const held = (q.held ?? []).some((h: { name?: string }) => h.name === "sagebrush-sync:" + ns);
      if (held !== this.lockHeld) {
        this.lockHeld = held;
        this.changed();
      }
    } catch {}
  }
}

const snap = (s: SyncStatus, limit: SyncOwner["limit"]): Snapshot => ({ state: s.state, ...(s.waiting !== undefined ? { waiting: s.waiting } : {}), ...(s.reason ? { reason: s.reason } : {}), ...(s.message ? { message: s.message } : {}), ...(s.lastSynced ? { lastSynced: s.lastSynced } : {}), ...(s.resumesAt ? { resumesAt: s.resumesAt } : {}), ...(s.full ? { full: true } : {}), ...(limit ? { limit } : {}), ...(s.ready?.length ? { ready: s.ready } : {}), ...(s.stuck ? { stuck: true } : {}) });
const utf8 = (m: unknown) => new TextEncoder().encode(JSON.stringify(m)).length;
/** The status message as published: within STATUS_PUB.maxBytes serialized, UTF-8, the whole message measured, its
 * envelope included (daybreak3's TEST-PR130-2-R2).  The snapshot's reason is shortened by code points (never a half
 * surrogate pair) to the longest that fits; then, if it must, syncReady's answers are dropped oldest first (READY.tokens
 * of them, each 12 characters); without those two every field is bounded, and the message fits. */
export function statusMessage(ns: string, epoch: number, gen: number, rev: number, s: Snapshot): StatusMsg {
  const msg = (snapshot: Snapshot): StatusMsg => ({ t: "status", ns, epoch, gen, rev, snapshot });
  const whole = msg(s);
  if (utf8(whole) <= STATUS_PUB.maxBytes) return whole;
  let out = whole;
  // (the server's sentence first: the foot then says the reason in the table's words)
  if (s.message) {
    const { message: _m, ...rest } = s;
    out = msg(rest);
    if (utf8(out) <= STATUS_PUB.maxBytes) return out;
    s = rest;
  }
  if (s.reason) {
    const { reason, ...rest } = s, cps = Array.from(reason);
    const at = (n: number) => msg(n ? { ...rest, reason: cps.slice(0, n).join("") } : rest);
    let lo = 0, hi = cps.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (utf8(at(mid)) <= STATUS_PUB.maxBytes) lo = mid;
      else hi = mid - 1;
    }
    out = at(lo);
  }
  // (still over, the reason gone: syncReady's answers, oldest first; the newest kept as long as one fits.  A call whose
  // token is dropped here isn't answered by this message; it times out, and never reads "current" from another's)
  let snap = out.snapshot;
  while (snap.ready?.length && utf8(msg(snap)) > STATUS_PUB.maxBytes) {
    const ready = snap.ready.slice(1);
    snap = ready.length ? { ...snap, ready } : (({ ready: _r, ...r }) => r)(snap);
  }
  return msg(snap);
}
