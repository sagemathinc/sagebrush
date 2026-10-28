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
// - Status across tabs: only the lock holder publishes, `holder {ns, epoch, gen}` after each renewal, then `status
//   {ns, epoch, gen, rev, snapshot}` (rev from 1 for each gen), equal snapshots suppressed, at most one per
//   STATUS_PUB.minGapMs, the newest kept for a trailing slot.  A follower orders by (gen, rev) and never rebroadcasts;
//   it asks `status?` once per mount, pageshow and holder message, and the holder's whole state for those requests is
//   one boolean, `forced`: the next slot publishes even an unchanged snapshot (r4, LIMIT-STEP5-R3-1).
import type { Workspace } from "./api";
import { req } from "./db";
import { SyncClient, type ClientOptions, type SyncStatus } from "./sync-client";
import { confirmedIndex } from "./sync-confirmed";
import { accountHash } from "../sync-protocol/protocol";

export const STATUS_PUB = {
  /** status messages at most this often (one slot) */
  minGapMs: 500,
  /** a status message's serialized size at most, UTF-8, its envelope included (its reason shortened to fit) */
  maxBytes: 512,
};
export const OWNER = {
  /** a visible tab reconciles at most this often */
  visibleMs: 60_000,
};

/** The production client: always with the confirmed index (step 4's onIndex), so a namespace's first sync adopts
 * the local tree and other devices' changes are applied (CORR-STEP5-4). */
export function startSync(w: Workspace, opts: ClientOptions = {}): SyncClient {
  return new SyncClient(w, { onIndex: confirmedIndex(w), ...opts });
}

/** What the foot shows: the holder's snapshot, or this page's own client's status. */
export type Snapshot = { state: SyncStatus["state"]; waiting?: number; reason?: string; lastSynced?: number; resumesAt?: number; full?: boolean; limit?: { limit_bytes: number | null; used_bytes: number } };
export type StatusMsg = { t: "status"; ns: string; epoch: number; gen: number; rev: number; snapshot: Snapshot };
type HolderMsg = { t: "holder"; ns: string; epoch: number; gen: number };
type AskMsg = { t: "status?"; ns: string; epoch: number };
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
  /** (tests) what the holder side did */
  readonly stats = { published: 0, asks: 0, suppressed: 0, reconciles: 0 };

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
    if (this.life && h?.snapshot && this.lockHeld && !this.isHolder()) return { from: "holder", s: h.snapshot };
    return { from: "own", s: this.own };
  }
  isHolder() { return this.gen > 0; }

  /** Begins: lifecycle nudges heard, the page's lifecycle followed, and a first reconcile. */
  start(): this {
    this.suspended = false;
    this.openLife();
    if (!this.unhook && typeof addEventListener === "function") {
      const hide = () => this.suspend();
      const show = (ev: Event) => { if ((ev as PageTransitionEvent).persisted) this.resume(); };
      const vis = () => {
        if (document.visibilityState !== "visible" || Date.now() - this.lastVisible < OWNER.visibleMs) return;
        this.lastVisible = Date.now();
        void this.reconcile();
      };
      addEventListener("pagehide", hide);
      addEventListener("pageshow", show);
      document.addEventListener("visibilitychange", vis);
      this.unhook = () => { removeEventListener("pagehide", hide); removeEventListener("pageshow", show); document.removeEventListener("visibilitychange", vis); };
    }
    void this.reconcile();
    return this;
  }
  /** pagehide: the client stopped for good (never reused), channels closed, timers cleared. */
  suspend() {
    this.suspended = true;
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
    owners.delete(this.w);
  }

  /** A lifecycle change made here (after its durable write): every tab told, this one reconciled. */
  nudge(kind: LifeKind) {
    try { this.lifeCh?.postMessage({ kind }); } catch {}
    if (kind !== "on") this.limit = null;
    void this.reconcile();
  }

  /** (sync 2c-3, DEV's switch: web/workspace/doc-sync-switch.ts) notebooks' contents on this page's connection:
   * every client made from now on carries `docs`, and one running now is made again with it (its new connection's
   * welcome then connects it). */
  setDocs(docs: ClientOptions["docs"]) {
    this.opts = { ...this.opts, docs };
    if (this.client) void this.stopClient().then(() => this.reconcile());
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
    this.lifeCh.onmessage = () => void this.reconcile();
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
      } while (this.again && !this.suspended);
    })().finally(() => { this.reconciling = null; });
    return this.reconciling;
  }
  private async reconcileOnce() {
    if (this.suspended) return;
    let d = await this.durable();
    if (d && !(await this.sessionIs(d.ns))) d = null;
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
      this.own = { state: "off" };
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
    this.unStatus = c.onStatus((s) => {
      this.own = snap(s, this.limit);
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
  /** The session's account is the namespace's (its hash, the namespace's first part). */
  private async sessionIs(ns: string): Promise<boolean> {
    try {
      const f = this.opts.fetch ?? globalThis.fetch.bind(globalThis);
      const r = await f((this.opts.origin ?? location.origin) + "/api/share/me", { credentials: "same-origin" });
      if (!r.ok) return false;
      const id = ((await r.json()) as { account_id?: unknown }).account_id;
      return typeof id === "string" && (await accountHash(id)) === ns.split(":")[0];
    } catch {
      // (can't ask now: a client that runs stays (it asks itself on each connection); none is started)
      return !!this.client;
    }
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

const snap = (s: SyncStatus, limit: SyncOwner["limit"]): Snapshot => ({ state: s.state, ...(s.waiting !== undefined ? { waiting: s.waiting } : {}), ...(s.reason ? { reason: s.reason } : {}), ...(s.lastSynced ? { lastSynced: s.lastSynced } : {}), ...(s.resumesAt ? { resumesAt: s.resumesAt } : {}), ...(s.full ? { full: true } : {}), ...(limit ? { limit } : {}) });
const utf8 = (m: unknown) => new TextEncoder().encode(JSON.stringify(m)).length;
/** The status message as published: within STATUS_PUB.maxBytes serialized, UTF-8, the whole message measured, its
 * envelope included (daybreak3's TEST-PR130-2-R2).  The snapshot's reason is shortened by code points (never a half
 * surrogate pair) to the longest that fits; without it every field is bounded, and the message fits. */
export function statusMessage(ns: string, epoch: number, gen: number, rev: number, s: Snapshot): StatusMsg {
  const msg = (snapshot: Snapshot): StatusMsg => ({ t: "status", ns, epoch, gen, rev, snapshot });
  const whole = msg(s);
  if (utf8(whole) <= STATUS_PUB.maxBytes || !s.reason) return whole;
  const { reason, ...rest } = s, cps = Array.from(reason);
  const at = (n: number) => msg(n ? { ...rest, reason: cps.slice(0, n).join("") } : rest);
  let lo = 0, hi = cps.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (utf8(at(mid)) <= STATUS_PUB.maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return at(lo);
}
