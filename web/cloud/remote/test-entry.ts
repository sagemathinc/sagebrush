// The Worker that web/remote/test-remote.mjs runs in Miniflare: the share API (for /auth/dev's sessions) and the
// remotes routes, plus test-only hooks: a header that unbinds the remotes (the inert case), one that makes the per-IP
// limiter refuse, /__verify (verifyChallenge, as the relay's upgrade will call it) and /__purge (purgeRemotes);
// /__bindpurge and /__scheduled (web/share's own purge, to its end); /__stream (a route fed a counted body stream);
// /__authtier (authTier() at a given time); x-test-tiers (REMOTE_TIERS, as given); x-test-unbound "cocalc" (no CoCalc);
// and two wrappers of the database (x-test-remotes-fail "schema" also hides the tables from sqlite_master): x-test-barrier (the approval's slot read waits until N requests have made it, so
// a race is deterministic), x-test-at-count (at that same read, with the approval past its session check: mark the
// account deleting, or run an admin purge of it to its end) and x-test-remotes-fail (the remotes' purge batch fails:
// "operational" or "schema"); /__limiter (how often the per-IP limiter was asked).
import { handleShare, bindPurge, scheduled, authTier, type ShareEnv } from "../share/server.ts";
import { handleRemote, verifyChallenge, purgeRemotes, remoteDeletes, body, type RemoteEnv } from "./server.ts";
// (the relay's Durable Object, bound in test-relay.mjs's Miniflare only (test-remote.mjs runs without it: inert))
import { RemoteRelay, type RelayEnv } from "./relay.ts";
import { RemoteAccount, leaseBytes } from "./account.ts";
import type { Kind } from "./relay-caps.ts";
export { RemoteRelay, RemoteAccount };
// (both test objects run on one logical clock, ahead of the real one, so an alarm set from it never fires by itself:
// the tests run alarms through /__alarm)
let clock = Date.UTC(2030, 0, 15, 12, 0, 0);
/** The relay, plus a read-only look at its legs' accounting (GET /__state), its clock (/__clock?ms=), its alarm run now
 * (/__alarm), its leases (/__leases), and its rate: relaxed for the floods that aren't about it, real with /__rate?real=1. */
export class TestRemoteRelay extends RemoteRelay {
  private realRate = false;
  protected now(): number {
    return clock;
  }
  protected rateOf(kind: Kind): { rate: number; burst: number } {
    return this.realRate ? super.rateOf(kind) : { rate: 1e9, burst: 1e9 };
  }
  private thrown = 0; // (exceptions out of a message handler, counted, then rethrown as before: /__thrown reads them)
  // (b5: every byte the relay consumes from its leases, counted as it consumes (/__consumed): the payable bytes,
  // apart from the queue's admission charge)
  private consumedTotal = 0;
  private revokeGate = { armed: false, at: 0, fired: false };
  private paying = 0;
  private midPay: string | null = null;
  private holdKeys = new Set<string>();
  private holdGen = new Map<string, number>();
  private zeroCredit = false;
  private failSend = false;
  private heldPuts = 0;
  private madeQueues: { frames: unknown[]; bytes: number; draining: boolean }[] = [];
  constructor(ctx: DurableObjectState, env: RelayEnv) {
    super(ctx, env);
    const self = this as unknown as { consume(n: number, l: unknown[]): Promise<void>; queues: Map<WebSocket, unknown> };
    // (every queue ever made, held here too, so /__waiting can see what a dropped one still retains (astra's B5-RETAIN-1))
    const made = this.madeQueues;
    self.queues = new (class extends Map<WebSocket, unknown> {
      set(k: WebSocket, v: unknown) {
        made.push(v as { frames: unknown[]; bytes: number; draining: boolean });
        return super.set(k, v);
      }
    })();
    // (/__holdput?on=1: the relay's writes of its leases wait until on=0 (/__waiting's heldPuts: how many are waiting):
    // a debit write held, so an end can happen during it (B5-CONSUME-CANCEL-1), and every turn behind it waits too)
    const store = ctx.storage;
    const storage = new Proxy(store, {
      get: (t, k) => {
        if (k === "put")
          return async (key: unknown, ...rest: unknown[]) => {
            if (typeof key === "string" && this.holdKeys.has(key)) {
              // (held until its key is let go (on=0), or this one released (release=<key>) while later ones stay held)
              const gen = this.holdGen.get(key) ?? 0;
              this.heldPuts++;
              try {
                while (this.holdKeys.has(key) && (this.holdGen.get(key) ?? 0) === gen) await new Promise((r) => setTimeout(r, 20));
              } finally {
                this.heldPuts--;
              }
            }
            return (store.put as (...a: unknown[]) => Promise<unknown>).call(store, key, ...rest);
          };
        const v = Reflect.get(t, k);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const realCtx = this.ctx;
    Object.defineProperty(this, "ctx", { value: new Proxy(realCtx, { get: (t, k) => (k === "storage" ? storage : (() => { const v = Reflect.get(t, k); return typeof v === "function" ? v.bind(t) : v; })()) }) });
    // (/__midpay?do=drop|revoke: right after a payment reads its credit, inside its leased() turn, every queue is dropped
    // (its leg ended) or a revoke begins: the payment's last checks before consuming must stop it, charging nothing)
    const cr = this as unknown as { credit(): Promise<unknown>; queues: Map<WebSocket, unknown>; drop(ws: WebSocket): void; revoking: boolean };
    const credit = cr.credit.bind(this);
    cr.credit = async () => {
      const c = (await credit()) as { credit: number };
      // (/__zerocredit?on=1: every credit read finds none, as if the leases were spent (B13))
      if (this.zeroCredit) c.credit = 0;
      const what = this.midPay;
      this.midPay = null;
      if (what === "drop") for (const ws of [...cr.queues.keys()]) cr.drop(ws);
      else if (what === "revoke") cr.revoking = true;
      else if (what === "page") {
        // (every page ends, as the relay ends one (replaced, or its peer's close): a frame to it, credit read, not debited)
        const rel = this as unknown as { pages(): WebSocket[]; endPage(p: WebSocket, code: number, reason: string, announce: boolean): void };
        for (const pg of rel.pages()) rel.endPage(pg, 4000, "ended mid-payment", true);
      }
      return c;
    };
    // (/__failsend?on=1: the next application payload the relay sends fails, as a socket's send throwing would (its
    // send() then returns false); controls go on (B5-SEND-ACCOUNT-1))
    const sd = this as unknown as { send(ws: WebSocket | undefined, text: string): boolean };
    const realSend = sd.send.bind(this);
    sd.send = (ws, text) => {
      if (this.failSend && !text.startsWith('{"relay":')) {
        this.failSend = false;
        return false;
      }
      return realSend(ws, text);
    };
    // (payments in flight, counted as they begin and end (/__waiting): a cancelled leg's must end at once (B5-CANCEL-PAY-1))
    const payer = this as unknown as { payFor(...a: unknown[]): Promise<unknown> };
    const pay = payer.payFor.bind(this);
    payer.payFor = async (...args: unknown[]) => {
      this.paying++;
      try {
        return await pay(...args);
      } finally {
        this.paying--;
      }
    };
    const orig = self.consume.bind(this);
    self.consume = async (n, l) => {
      this.consumedTotal += n;
      const r = await orig(n, l);
      // (/__revokegate?on=1: a revoke begins right after this payment is written, before its frame is sent (Q11))
      if (this.revokeGate.armed) {
        this.revokeGate.armed = false;
        (this as unknown as { revoking: boolean }).revoking = true;
        this.revokeGate.fired = true;
      }
      return r;
    };
  }
  private holdClose = false; // (/__holdclose?on=1: a leg's close handler waits until on=0, as a slow close would (Q5))
  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    while (this.holdClose) await new Promise((r) => setTimeout(r, 20));
    return super.webSocketClose(ws, code, reason);
  }
  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    try {
      await super.webSocketMessage(ws, raw);
    } catch (e) {
      this.thrown++;
      throw e;
    }
  }
  async fetch(req: Request): Promise<Response> {
    const u = new URL(req.url);
    if (u.pathname === "/__thrown") return Response.json({ thrown: this.thrown });
    if (u.pathname === "/__consumed") return Response.json({ consumed: this.consumedTotal });
    if (u.pathname === "/__revokegate") {
      Object.assign(this.revokeGate, { armed: u.searchParams.get("on") === "1", at: this.consumedTotal, fired: false });
      return Response.json(this.revokeGate);
    }
    if (u.pathname === "/__revokegatestate") return Response.json(this.revokeGate);
    if (u.pathname === "/__failsend") return Response.json({ on: (this.failSend = u.searchParams.get("on") === "1") });
    if (u.pathname === "/__holdput") {
      // (on=1[&keys=leases,revoked]: hold those keys' writes (leases by default); release=<key>: let the ones held now go,
      // later ones still held; on=0: let all go)
      const rel = u.searchParams.get("release");
      if (rel) this.holdGen.set(rel, (this.holdGen.get(rel) ?? 0) + 1);
      else if (u.searchParams.get("on") === "1") for (const k of (u.searchParams.get("keys") ?? "leases").split(",")) this.holdKeys.add(k);
      else this.holdKeys.clear();
      return Response.json({ hold: [...this.holdKeys] });
    }
    if (u.pathname === "/__zerocredit") return Response.json({ on: (this.zeroCredit = u.searchParams.get("on") === "1") });
    if (u.pathname === "/__midpay") return Response.json({ midPay: (this.midPay = u.searchParams.get("do")) });
    if (u.pathname === "/__holdclose") return Response.json({ hold: (this.holdClose = u.searchParams.get("on") === "1") });
    // (legs whose message waits for a lease, and whether a lease request is out: a schedule observed, not slept on)
    if (u.pathname === "/__waiting") {
      // (b5: the legs with frames queued, all their frames and their charged bytes)
      const self = this as unknown as { queues: Map<WebSocket, { frames: unknown[]; bytes: number }>; fetching: Promise<boolean> | null };
      const qs = [...self.queues.values()].filter((q) => q.frames.length);
      // (and the dropped ones: their frames, bytes and running drains, which a drop must leave at none)
      const live = new Set(self.queues.values());
      const gone = this.madeQueues.filter((q) => !live.has(q as never));
      const fw = (this as unknown as { fetchWaiters: Set<unknown> }).fetchWaiters;
      const lj = (this as unknown as { leaseJobs: unknown[]; leaseBusy: boolean });
      return Response.json({ paying: this.paying, leaseWaiters: fw.size, leaseJobs: lj.leaseJobs.length, leaseBusy: lj.leaseBusy, heldPuts: this.heldPuts, waiting: qs.length, frames: qs.reduce((n, q) => n + q.frames.length, 0), bytes: [...self.queues.values()].reduce((n, q) => n + q.bytes, 0), queues: self.queues.size, fetching: self.fetching !== null,
        detachedFrames: gone.reduce((n, q) => n + q.frames.length, 0), detachedBytes: gone.reduce((n, q) => n + q.bytes, 0), detachedDraining: gone.filter((q) => q.draining).length });
    }
    if (u.pathname === "/__state") return Response.json(this.ctx.getWebSockets().map((w) => w.deserializeAttachment()));
    if (u.pathname === "/__clock") return Response.json({ now: (clock = Number(u.searchParams.get("ms"))) });
    if (u.pathname === "/__rate") return Response.json({ real: (this.realRate = u.searchParams.get("real") === "1") });
    if (u.pathname === "/__noacct") {
      // (this relay without the account's binding, as a deploy that forgot it: /__noacct?on=1, back with on=0)
      const env = this.env as { REMOTE_ACCOUNT?: DurableObjectNamespace; __saved?: DurableObjectNamespace };
      if (u.searchParams.get("on") === "1") { env.__saved ??= env.REMOTE_ACCOUNT; env.REMOTE_ACCOUNT = undefined; }
      else if (env.__saved) env.REMOTE_ACCOUNT = env.__saved;
      return Response.json({ bound: !!env.REMOTE_ACCOUNT });
    }
    if (u.pathname === "/__alarm") {
      await this.alarm();
      return Response.json({ alarm: await this.ctx.storage.getAlarm() });
    }
    if (u.pathname === "/__leases") return Response.json({ paidUnsent: (await this.ctx.storage.get("paidUnsent")) ?? 0, leases: (await this.ctx.storage.get("leases")) ?? [], alarm: await this.ctx.storage.getAlarm() });
    return super.fetch(req);
  }
}
/** The account's object on the same logical clock; /__state and /__budget (the day's granted bytes set directly). */
export class TestRemoteAccount extends RemoteAccount {
  private cap: number | null = 100; // (null: the real cap; /__cap?real=1)
  private hold = false; // (/__hold?on=1: a lease request waits until /__hold?on=0, as an account far away would)
  private holdAcquire = false; // (/__hold?acquire=1: slot requests wait, and /__hold?step=1 lets them go one at a time, in order)
  private tickets = 0;
  private holdSettle = false; // (/__hold?settle=1: settlements wait until settle=0: an account slow to hear one (B5-SETTLE-REFILL-1))
  private leaseCalls = 0; // (/__calls: lease requests received, and those refused)
  private leaseRefused = 0;
  private stepped = 0;
  protected now(): number {
    return clock;
  }
  protected connectedCap(): number {
    return this.cap ?? super.connectedCap();
  }
  async fetch(req: Request): Promise<Response> {
    const u = new URL(req.url);
    if (u.pathname === "/__state") {
      const q = (t: string) => this.ctx.storage.sql.exec(`SELECT * FROM ${t}`).toArray();
      return Response.json({ days: q("days"), leases: q("leases"), slots: q("slots") });
    }
    if (u.pathname === "/__hold") {
      if (u.searchParams.has("settle")) this.holdSettle = u.searchParams.get("settle") === "1";
      else if (u.searchParams.has("acquire")) {
        this.holdAcquire = u.searchParams.get("acquire") === "1";
        if (this.holdAcquire) this.stepped = this.tickets; // (only requests from now on are held)
      }
      else if (u.searchParams.has("step")) this.stepped++;
      else this.hold = u.searchParams.get("on") === "1";
      return Response.json({ hold: this.hold, acquire: this.holdAcquire });
    }
    if (u.pathname === "/__calls") return Response.json({ lease: this.leaseCalls, refused: this.leaseRefused });
    if (u.pathname === "/settle") while (this.holdSettle) await new Promise((r) => setTimeout(r, 20));
    if (u.pathname === "/lease") {
      this.leaseCalls++;
      while (this.hold) await new Promise((r) => setTimeout(r, 20));
      const r = await super.fetch(req);
      if (r.status !== 200) this.leaseRefused++;
      return r;
    }
    if (u.pathname === "/acquire") {
      const ticket = ++this.tickets;
      while (this.holdAcquire && ticket > this.stepped) await new Promise((r) => setTimeout(r, 20));
    }
    if (u.pathname === "/__cap") return Response.json({ real: (this.cap = u.searchParams.get("real") === "1" ? null : 100) === null });
    if (u.pathname === "/__budget") {
      const day = new Date(clock).toISOString().slice(0, 10);
      this.ctx.storage.sql.exec(`INSERT INTO days (day, granted, consumed) VALUES (?, ?, 0) ON CONFLICT(day) DO UPDATE SET granted = excluded.granted`, day, Number(u.searchParams.get("granted")));
      return Response.json({ ok: true });
    }
    return super.fetch(req);
  }
}
// (admissions held between the Worker's checks and the relay, released by /__release: an upgrade authenticated before
// a purge that reaches the relay after it.  The held request polls a shared generation, as share's holdTouch does: a
// promise resolved from another request's context is refused by the runtime.)
let holding = 0;
let releaseGen = 0;
let relayCalls = 0; // (x-test-relay-count: the Worker's requests to relays, counted; /__relaycalls reads and resets)
import { classifyPeer, parseControl, PAGE_OPS, PEER_OPS, RELAY_LIMITS } from "./relay.ts";
import { capsFor, peerWindow, RELAY_CAPS, PEER_WINDOW } from "./relay-caps.ts";

type DB = NonNullable<RemoteEnv["SHARE_DB"]>;
let arrived: { n: number; release: (() => void)[] } = { n: 0, release: [] };
let limiterCalls = 0;
// (/__referrer?policy=P: every page's Referrer-Policy rewritten to P from then on, "" for the page's own: the browser
// suite's control, the pages as they were (no-referrer), refused in a real browser)
let pagePolicy = "";

function wrapDb(db: DB, barrier: number, fail: string | null, atCount: (() => Promise<void>) | null): DB {
  const failing = { failing: true };
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare")
        return (sql: string) => {
          if (fail && sql.startsWith("DELETE FROM remotes ")) return { bind: () => failing };
          // ("schema": a database without 0009 at all, so the remotes tables aren't in sqlite_master either)
          if (fail === "schema" && sql.includes("FROM sqlite_master")) return { first: async () => null, bind: () => ({ first: async () => null }) };
          const st = target.prepare(sql);
          if (!(barrier || atCount) || !sql.startsWith("SELECT COUNT(*) AS n FROM remotes ")) return st;
          return {
            bind: (...a: unknown[]) => {
              const b = st.bind(...a);
              return {
                first: async (...x: unknown[]) => {
                  const v = await (b.first as (...y: unknown[]) => Promise<unknown>)(...x);
                  if (atCount) {
                    const f = atCount;
                    atCount = null; // (once: the 409 path reads the count again)
                    await f();
                    return v;
                  }
                  await new Promise<void>((res) => {
                    setTimeout(res, 5000); // (never a hang: a lone arrival goes on after 5 s, and the race test fails)
                    arrived.release.push(res);
                    if (++arrived.n >= barrier) {
                      for (const r of arrived.release) r();
                      arrived = { n: 0, release: [] };
                    }
                  });
                  return v;
                },
              };
            },
          };
        };
      if (prop === "batch")
        return async (stmts: unknown[]) => {
          if (stmts.includes(failing))
            throw new Error(fail === "schema" ? "D1_ERROR: no such table: remotes: SQLITE_ERROR" : "D1_ERROR: Network connection lost.");
          return target.batch(stmts as Parameters<DB["batch"]>[0]);
        };
      const v = (target as unknown as Record<string | symbol, unknown>)[prop];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

/** A body stream of `total` bytes of "a", in 1 KiB chunks, counting what is pulled and whether it was cancelled. */
function counted(total: number) {
  const seen = { pulled: 0, cancelled: false };
  const chunk = new TextEncoder().encode("a".repeat(1024));
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (seen.pulled * 1024 >= total) return c.close();
      seen.pulled++;
      c.enqueue(chunk);
    },
    cancel() {
      seen.cancelled = true;
    },
  }, { highWaterMark: 0 });
  return { stream, seen };
}

export default {
  async fetch(req: Request, env: RemoteEnv, ctx: { waitUntil(p: Promise<unknown>): void }) {
    const url = new URL(req.url);
    const fail = req.headers.get("x-test-remotes-fail");
    const barrier = Number(req.headers.get("x-test-barrier") ?? "0");
    let e: RemoteEnv = { ...env, REMOTE_PREAUTH: { limit: async () => (limiterCalls++, { success: req.headers.get("x-test-preauth") !== "deny" }) } };
    const at = req.headers.get("x-test-at-count");
    let atCount: (() => Promise<void>) | null = null;
    if (at) {
      const [what, account, rid] = at.split(" ");
      atCount = what === "deleting"
        ? async () => void (await env.SHARE_DB!.prepare("UPDATE accounts SET deleting = 1 WHERE account_id = ?1").bind(account).run())
        : what === "expire"
        ? async () => void (await env.SHARE_DB!.prepare("UPDATE sessions SET expires = 1 WHERE account_id = ?1").bind(account).run())
        : async () => {
          // (an admin purge, or a self purge, run to its end; after a self purge, the account signs in again)
          await bindPurge(env as ShareEnv, account, rid, what === "selfpurge" ? "self" : "admin");
          await scheduled(env as ShareEnv);
          if (what === "selfpurge")
            await handleShare(new Request(url.origin + "/auth/dev", { method: "POST", headers: { origin: url.origin, "content-type": "application/json" }, body: JSON.stringify({ token: "dev-token", account_id: account }) }), env, ctx);
        };
    }
    if (barrier || fail || atCount) e = { ...e, SHARE_DB: wrapDb(env.SHARE_DB!, barrier, fail, atCount) };
    if (req.headers.get("x-test-unbound") === "chal") e = { ...e, REMOTE_CHAL_KEY: undefined };
    // (b4b: the key's configuration, as a deploy would set it: REMOTE_CHAL_DERIVE's value, a configured key's value
    // (empty included), no SESSION_KEY; each a copy of this request's env, the bindings themselves untouched)
    // (the values JSON-encoded, so an empty one or one with spaces arrives exact: HTTP trims and drops those)
    if (req.headers.has("x-test-derive")) e = { ...e, REMOTE_CHAL_DERIVE: JSON.parse(req.headers.get("x-test-derive")!) };
    if (req.headers.has("x-test-chal-key")) e = { ...e, REMOTE_CHAL_KEY: JSON.parse(req.headers.get("x-test-chal-key")!) };
    if (req.headers.get("x-test-no-session") === "1") e = { ...e, SESSION_KEY: undefined };
    if (req.headers.has("x-test-session-key")) e = { ...e, SESSION_KEY: JSON.parse(req.headers.get("x-test-session-key")!) };
    if (req.headers.get("x-test-unbound") === "accounts") e = { ...e, REMOTE_ACCOUNTS: undefined };
    if (req.headers.has("x-test-tiers")) e = { ...e, REMOTE_TIERS: JSON.parse(req.headers.get("x-test-tiers")!) };
    if (req.headers.get("x-test-unbound") === "cocalc") e = { ...e, COCALC_ORIGIN: undefined, COCALC_CLIENT_SECRET: undefined } as RemoteEnv;
    if (req.headers.get("x-test-unbound") === "preauth") e = { ...e, REMOTE_PREAUTH: undefined };
    if (req.headers.get("x-test-unbound") === "relay") e = { ...e, REMOTE_RELAY: undefined };
    if (req.headers.get("x-test-hold-admission") && env.REMOTE_RELAY) {
      const real = e.REMOTE_RELAY!;
      e = { ...e, REMOTE_RELAY: { idFromName: (n: string) => real.idFromName(n), get: (id: DurableObjectId) => ({ fetch: async (u: string | Request, init?: RequestInit) => {
        const g = releaseGen;
        holding++;
        try {
          while (releaseGen === g) await new Promise((r) => setTimeout(r, 20));
        } finally {
          holding--;
        }
        return real.get(id).fetch(u as string, init);
      } }) } as unknown as DurableObjectNamespace };
    }
    if (url.pathname === "/__held") return Response.json({ holding });
    if (url.pathname === "/__relaycalls") {
      const n = relayCalls;
      relayCalls = 0;
      return Response.json({ n });
    }
    if (req.headers.get("x-test-relay-count") && env.REMOTE_RELAY) {
      const real = e.REMOTE_RELAY!;
      e = { ...e, REMOTE_RELAY: { idFromName: (n: string) => real.idFromName(n), get: (id: DurableObjectId) => ({ fetch: (u: string | Request, init?: RequestInit) => (relayCalls++, real.get(id).fetch(u as string, init)) }) } as unknown as DurableObjectNamespace };
    }
    // (the relay's own page admission, reached directly with the headers given: its checks behind the Worker's)
    if (url.pathname === "/__dopage" && env.REMOTE_RELAY) {
      const q = url.searchParams;
      return env.REMOTE_RELAY.get(env.REMOTE_RELAY.idFromName(q.get("remote")!)).fetch("https://relay/page", {
        headers: { upgrade: "websocket", "x-r-account": q.get("account")!, "x-r-remote": q.get("remote")!, "x-r-kind": q.get("kind")!, "x-r-chan": q.get("chan")! },
      });
    }
    if (url.pathname === "/__remotedeletes" && req.method === "POST") {
      try {
        const n = (await remoteDeletes(e as ShareEnv, ((await req.json()) as { account: string }).account)).length;
        return Response.json({ ok: true, n });
      } catch (x) {
        return Response.json({ ok: false, error: String((x as Error).message) }, { status: 500 });
      }
    }
    if (url.pathname === "/__release") {
      const n = holding;
      releaseGen++;
      return Response.json({ released: n });
    }
    if (url.pathname === "/__state" && env.REMOTE_RELAY) {
      const rid = url.searchParams.get("remote")!;
      return env.REMOTE_RELAY.get(env.REMOTE_RELAY.idFromName(rid)).fetch("https://relay/__state");
    }
    // (the b2b hooks: a remote's relay (/__relay/<op>?remote=) or an account's object (/__account/<op>?account=))
    const rm = /^\/__relay(\/__[a-z]+)$/.exec(url.pathname);
    if (rm && env.REMOTE_RELAY) {
      const rid = url.searchParams.get("remote")!;
      return env.REMOTE_RELAY.get(env.REMOTE_RELAY.idFromName(rid)).fetch("https://relay" + rm[1] + url.search);
    }
    const am = /^\/__account(\/__[a-z]+)$/.exec(url.pathname);
    if (am && env.REMOTE_ACCOUNT) {
      const acct = url.searchParams.get("account")!;
      return env.REMOTE_ACCOUNT.get(env.REMOTE_ACCOUNT.idFromName(acct)).fetch("https://account" + am[1] + url.search);
    }
    if (req.headers.get("x-test-relay-fail") && env.REMOTE_RELAY) {
      // (the relay unreachable for revokes: a purge must not delete a remote it couldn't revoke)
      const real = env.REMOTE_RELAY;
      e = { ...e, REMOTE_RELAY: { idFromName: (n: string) => real.idFromName(n), get: (id: DurableObjectId) => ({ fetch: async (u: string | Request, init?: RequestInit) =>
        String(typeof u === "string" ? u : u.url).endsWith("/revoke") ? new Response("down", { status: 503 }) : real.get(id).fetch(u as string, init) }) } as unknown as DurableObjectNamespace };
    }
    if (url.pathname === "/__authtier" && req.method === "POST") {
      // (authTier() judged at a time of the test's choosing: LIMITS_TTL's edge, without waiting for it)
      const b = (await req.json()) as { id: string; at: number };
      return Response.json({ tier: await authTier(e as ShareEnv, { id: b.id, session: "" }, b.at) });
    }
    if (url.pathname === "/__verify" && req.method === "POST") {
      const b = (await req.json()) as { c: unknown; sig: unknown };
      return Response.json(await verifyChallenge(e, b.c, b.sig));
    }
    if (url.pathname === "/__purge" && req.method === "POST") {
      try {
        await purgeRemotes(e as ShareEnv, ((await req.json()) as { account: string }).account);
        return Response.json({ ok: true });
      } catch (x) {
        return Response.json({ ok: false, error: String((x as Error).message) }, { status: 500 });
      }
    }
    if (url.pathname === "/__caps" && req.method === "POST") {
      const b = (await req.json()) as { kind: string; chan: string };
      return Response.json({ r: capsFor(b.kind, b.chan), w: peerWindow(b.kind) });
    }
    if (url.pathname === "/__classify" && req.method === "POST") {
      // (the relay's grammar, the same functions its Durable Object uses: {side: "peer" | "page", text})
      const b = (await req.json()) as { side: string; text: string };
      return Response.json(b.side === "peer" ? { r: classifyPeer(b.text) } : { r: parseControl(b.text, PAGE_OPS) });
    }
    if (url.pathname === "/__control" && req.method === "POST") {
      // (parseControl itself with a table the test gives: the grammar's key order for ops of two fields, which neither
      // table has yet (grader's A2))
      const b = (await req.json()) as { text: string; ops: Record<string, string[]> };
      return Response.json({ r: parseControl(b.text, b.ops) });
    }
    if (url.pathname === "/__limits") {
      // (the tables the relay reads, as it reads them: the op tables, its limits, every receiver's window (grader's H16))
      return Response.json({ ops: { peer: PEER_OPS, page: PAGE_OPS }, limits: RELAY_LIMITS, caps: RELAY_CAPS, peerWindow: PEER_WINDOW,
        leases: { runner: leaseBytes("runner"), agent: leaseBytes("agent") } });
    }
    if (url.pathname === "/__limiter") return Response.json({ calls: limiterCalls });
    if (url.pathname === "/__bindpurge" && req.method === "POST") {
      const b = (await req.json()) as { account: string; rid: string; kind?: "admin" | "self" };
      return Response.json({ r: await bindPurge(e as ShareEnv, b.account, b.rid, b.kind ?? "self") });
    }
    if (url.pathname === "/__scheduled" && req.method === "POST") {
      await scheduled(e as ShareEnv);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/__stream" && req.method === "POST") {
      // {path, total, length?, cookie?}: that route (or "body", the JSON reader itself) fed a counted stream
      const b = (await req.json()) as { path: string; total: number; length?: string; cookie?: string };
      const { stream, seen } = counted(b.total);
      const headers: Record<string, string> = { origin: url.origin, "content-type": b.path === "/remote/activate" ? "application/x-www-form-urlencoded" : "application/json" };
      if (b.length !== undefined) headers["content-length"] = b.length;
      if (b.cookie) headers.cookie = b.cookie;
      const inner = new Request(url.origin + (b.path === "body" ? "/" : b.path), { method: "POST", headers, body: stream, duplex: "half" } as RequestInit);
      let status = 0;
      if (b.path === "body") status = (await body(inner)) === null ? 400 : 200;
      else status = (await handleRemote(inner, e, ctx))!.status;
      return Response.json({ status, ...seen });
    }
    if (url.pathname === "/__referrer") {
      pagePolicy = url.searchParams.get("policy") ?? "";
      return Response.json({ policy: pagePolicy });
    }
    const remote = await handleRemote(req, e, ctx);
    if (remote && pagePolicy && remote.headers.has("referrer-policy")) {
      const h = new Headers(remote.headers);
      h.set("referrer-policy", pagePolicy);
      return new Response(remote.body, { status: remote.status, headers: h });
    }
    return remote ?? (await handleShare(req, e, ctx)) ?? new Response("not the API", { status: 404 });
  },
};
