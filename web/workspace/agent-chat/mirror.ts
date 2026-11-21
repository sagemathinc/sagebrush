// The log mirror, the page's side (M2, design r4): the uploader, the reader and the reconcile. Headless: the site's
// fetch, the pairing and where the cursors are kept are the host's, passed in.
//
// Uploader (§2). The page can't mirror what it draws (the person's own messages reach it numbered only in a replay), so
// it reads the agent's log itself, from its own cursor, with a chat.resume tagged "mirror"; the agent gives the tag back
// on its chat.replay, and the display (ChatSession) never sees those replays. It normalizes what it reads with the
// allowlist (mirror-format.ts), cuts it into segments and appends them. Only from an agent whose hello says
// chat.resume.tag: without it the page doesn't mirror at all.
//
// Reader (§3). Another device lists the account's conversations and reads their streams back, segment by segment: a
// segment the site can't verify is a gap, never part of it. What it reads is inert: records to show, never a thread
// the session runs (no composer, no cards, nothing ever sent to an agent).
//
// Reconcile (§4). On pairing, every stream of a conversation the runner holds is compared with the runner's log. The
// runner wins: a stream of another run, or one that differs from it, is marked stale in the account's object from the
// first position that isn't confirmed. The marks only widen; the reconcile reads the runner, never writes to it.
import type { AgentPairing } from "../agent-pair";
import { LOG_INSTANCE, STALE_REASONS, canonical, normalize, segments, type LogEntry, type MirrorBody, type MirrorDraft, type MirrorEntry, type StaleReason } from "./mirror-format";

/** Every mirror request's tag starts with this; the rest is 10 random lowercase letters, one tag per request, so a
 *  replay is matched to the exact request it answers (agent 0.7.6+ gives a tag back as it came: 1 to 16 of a-z). */
export const MIRROR_TAG = "mirror";
const TAG_RE = /^mirror[a-z]{10}$/;
/** A fresh request tag: "mirror" and 10 letters from the CSPRNG (rejection sampling, so each letter is uniform). */
export function requestTag(): string {
  let t = MIRROR_TAG;
  const b = new Uint8Array(1);
  while (t.length < 16) {
    crypto.getRandomValues(b);
    if (b[0] < 234) t += String.fromCharCode(97 + (b[0] % 26)); // (234 = 9 * 26: no modulo bias)
  }
  return t;
}
export const MIRROR_FEATURE = "chat.resume.tag";
export { STALE_REASONS, type StaleReason };
const MIRROR_TYPE = "application/vnd.sagebrush.mirror+json";
const API = "/api/mirror/v1";
/** a tagged replay's wait for its next part (each part restarts it) */
const REPLAY_MS = 20_000;
/** after a part that says more is to come (done: false), how long nothing else may arrive before the caller takes what
 *  came as a partial answer (the agent stopped early, or its next part is slow); the request then drains */
const QUIET_MS = 3000;
/** a request whose caller has its answer or gave up is kept, its later parts discarded, until it ends (done) or this
 *  long passes without a part. Each request has its own tag, so a part of an older one is never read as a newer one's
 *  whatever its timing; the drain only spares the agent overlapping requests */
const DRAIN_MS = 10_000;
/** the reconcile wants the whole log: it waits longer for a next part before taking what came as partial (fewer
 *  requests, and less of the log sent twice, over a slow link) */
const WHOLE_QUIET_MS = 15_000;
/** an agent that gives no answer this many times running is asked again only on the next real trigger */
const MAX_MISSES = 3;
/** the most requests one reconcile reads a conversation's log in */
const RECONCILE_PAGES = 50;
/** the most segments one stream is read in (each at most MIRROR_CAPS.entries entries) */
const READ_MAX = 5000;

/** Where the uploader is in one conversation: the account's locator for it, the run (log instance) it follows, the
 *  agent's last number it has read and the next mirror position. Local and non-secret. */
export interface Cursor {
  locator?: string;
  instance?: string;
  seq: number;
  n: number;
  /** the stream's chain digest at the site, as last taken with next_n and last_seq (a reload takes all three) */
  digest?: string;
  /** uploads of this run stopped: another history holds the range (conflict), or the agent's log no longer has what
   *  comes after the cursor (reset), so going on would leave a hole the reader couldn't show */
  blocked?: "conflict" | "reset";
}

export interface MirrorStatus {
  available: boolean;
  state?: string;
  bytes?: number;
  quota?: number;
  pending?: number;
  conversations?: number;
}

export interface RemoteStream {
  log_instance: string;
  next_n: number;
  last_seq: number;
  last_digest: string;
  stale_from: number | null;
  stale_reason: string | null;
}
export interface RemoteConversation {
  conversation: string;
  locator: string;
  streams: RemoteStream[];
}

/** One stream read back: its entries in order, the positions that couldn't be read, and its stale mark. */
export interface Section {
  log_instance: string;
  entries: MirrorEntry[];
  gaps: { first_n: number; last_n: number }[];
  stale_from: number | null;
  stale_reason: string | null;
}

export interface MirrorHost {
  /** the site's fetch (same origin, with the person's session) */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  pairing(): AgentPairing | null;
  loadCursors(): Record<string, Cursor> | null;
  storeCursors(c: Record<string, Cursor>): void;
  /** the status or the list changed: the settings and the thread list draw again */
  changed(): void;
  /** for tests: a tagged replay's waits */
  replayMs?: number;
  quietMs?: number;
  drainMs?: number;
  wholeQuietMs?: number;
}

/** What a tagged request got back: the log's entries after `after`, in order, and whether the agent said some it would
 *  have held are gone (`reset`: dropped at its bounds, or another run). */
interface Answer {
  events: LogEntry[];
  reset: boolean;
  /** the agent said this is all (done, or its highest number reached): not a part cut short */
  complete: boolean;
}
/** The one tagged request in flight for a conversation: its caller (null once its wait ran out: draining), the parts
 *  so far, and its timer. */
type Waiter = { pairing: AgentPairing; instance: string; tag: string; after: number; quiet: number; events: LogEntry[]; reset: boolean; parts: number; caller: { resolve: (a: Answer) => void; reject: (e: Error) => void } | null; timer: ReturnType<typeof setTimeout> | undefined };

const seqOk = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const natOk = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const conversationOk = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 256;
const BUSY = "a request is still in flight";
const NO_REPLY = "no replay";

export class Mirror {
  status: MirrorStatus = { available: false };
  /** an upload didn't fit (507): the settings say so until one does */
  full = false;
  private csrf = "";
  private cursors: Record<string, Cursor>;
  private remoteList: RemoteConversation[] | null = null;
  private readonly waiting = new Map<string, Waiter>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly again = new Set<string>();
  private readonly running = new Set<string>();
  /** conversations whose upload must run again once their request has ended: refused while it drained, given a
   *  partial answer, or given none in time */
  private readonly refused = new Set<string>();
  /** who waits for a conversation's request to end (the reconcile, between its pages) */
  private readonly idle = new Map<string, (() => void)[]>();
  /** answers missed in a row, by conversation, with the pairing they were missed on (an agent that never answers isn't
   *  asked forever by itself; another pairing starts again from none) */
  private readonly misses = new Map<string, { pairing: AgentPairing | null; n: number }>();

  constructor(private readonly host: MirrorHost) {
    const kept = host.loadCursors();
    this.cursors = kept && typeof kept === "object" ? kept : {};
  }

  on(): boolean {
    return this.status.available && this.status.state === "on";
  }

  /** The pairing the mirror may read from: granted, an agent that keeps a log and gives the tag back, and its run. */
  private source(): { pairing: AgentPairing; instance: string } | null {
    const p = this.host.pairing();
    const f = p?.hello?.features;
    const instance = p?.hello?.log?.instance;
    if (!p || p.state !== "granted" || !f?.includes("chat.resume") || !f.includes(MIRROR_FEATURE) || !instance || !LOG_INSTANCE.test(instance)) return null;
    return { pairing: p, instance };
  }
  /** whether the paired agent can be mirrored (the settings say "Update the agent" otherwise) */
  agentCan(): boolean {
    return !!this.source();
  }
  /** Whether uploads are actually under way: the mirror on, and a connected agent that gives the tag back. */
  uploading(): boolean {
    return this.on() && this.agentCan();
  }
  /** The banner's word on where chats are kept: "mirrored" only while uploads are actually under way, else "this
   *  browser only" (ruling, Nov 20 2026: no third wording). */
  keptLine(): string {
    return this.uploading() ? MIRROR_COPY.keptMirrored : MIRROR_COPY.keptHere;
  }

  // ---- the site

  private async call(method: string, path: string, body?: unknown, type = "application/json"): Promise<{ status: number; json: Record<string, unknown> }> {
    const init: RequestInit = { method, credentials: "same-origin", headers: {} };
    if (method !== "GET") {
      (init.headers as Record<string, string>)["x-sb-mirror-csrf"] = this.csrf;
      if (body !== undefined) {
        (init.headers as Record<string, string>)["content-type"] = type;
        init.body = typeof body === "string" ? body : JSON.stringify(body);
      }
    }
    const r = await this.host.fetch(API + path, init);
    let json: Record<string, unknown> = {};
    try {
      const v = await r.json();
      if (v && typeof v === "object" && !Array.isArray(v)) json = v as Record<string, unknown>;
    } catch {}
    return { status: r.status, json };
  }

  /** The account's mirror: available to it, on or off, its size and quota, deletions pending. */
  async refresh(): Promise<MirrorStatus> {
    const r = await this.call("GET", "/status").catch(() => null);
    const j = r?.status === 200 ? r.json : {};
    if (typeof j.csrf === "string") this.csrf = j.csrf;
    this.status = {
      available: j.available === true,
      ...(typeof j.state === "string" ? { state: j.state } : {}),
      ...(natOk(j.bytes) ? { bytes: j.bytes } : {}),
      ...(natOk(j.quota) ? { quota: j.quota } : {}),
      ...(natOk(j.pending) ? { pending: j.pending } : {}),
      ...(natOk(j.conversations) ? { conversations: j.conversations } : {}),
    };
    if (!this.on()) this.remoteList = null;
    this.host.changed();
    return this.status;
  }

  async enable(): Promise<boolean> {
    const r = await this.call("POST", "/enable");
    await this.refresh();
    return r.status === 200;
  }

  /** Turn it off: uploads stop, and the account's mirrored copy is deleted (keys now, objects after). */
  async disable(): Promise<boolean> {
    const r = await this.call("POST", "/disable", { confirm: "delete" });
    if (r.status === 200) {
      this.cursors = {};
      this.host.storeCursors(this.cursors);
    }
    await this.refresh();
    return r.status === 200;
  }

  /** The account's conversations and their streams, as the site lists them (cached until the next refresh). */
  async remote(force = false): Promise<RemoteConversation[]> {
    if (!this.on()) return [];
    if (this.remoteList && !force) return this.remoteList;
    const r = await this.call("GET", "/conversations");
    // (a list that can't be read now is not an empty one: the last one stays, and the caller learns it failed)
    if (r.status !== 200 || !Array.isArray(r.json.conversations)) throw new Error("the account's conversations can't be read now");
    const list = r.json.conversations;
    this.remoteList = list.flatMap((c: unknown): RemoteConversation[] => {
      const x = c as { conversation?: unknown; locator?: unknown; streams?: unknown } | null;
      if (!x || !conversationOk(x.conversation) || typeof x.locator !== "string" || !/^[0-9a-f]{32}$/.test(x.locator) || !Array.isArray(x.streams)) return [];
      const streams = x.streams.flatMap((s: unknown): RemoteStream[] => {
        const y = s as Record<string, unknown> | null;
        // (a stream's state is taken whole or not at all: its next position, last agent number and chain digest)
        if (!y || typeof y.log_instance !== "string" || !LOG_INSTANCE.test(y.log_instance) || !seqOk(y.next_n) || !natOk(y.last_seq) || typeof y.last_digest !== "string" || !/^[0-9a-f]{64}$/.test(y.last_digest)) return [];
        return [{ log_instance: y.log_instance, next_n: y.next_n, last_seq: y.last_seq, last_digest: y.last_digest, stale_from: seqOk(y.stale_from) ? y.stale_from : null, stale_reason: typeof y.stale_reason === "string" ? y.stale_reason : null }];
      });
      return [{ conversation: x.conversation, locator: x.locator, streams }];
    });
    this.host.changed();
    return this.remoteList;
  }

  /** The list as last read (none before the first read, or while off). */
  cached(): RemoteConversation[] {
    return this.on() ? (this.remoteList ?? []) : [];
  }

  /** Delete one conversation's mirrored copy. */
  async deleteConversation(locator: string): Promise<boolean> {
    if (!/^[0-9a-f]{32}$/.test(locator)) return false;
    const r = await this.call("DELETE", "/conversations/" + locator);
    if (r.status === 200) {
      for (const [k, c] of Object.entries(this.cursors)) if (c.locator === locator) delete this.cursors[k];
      this.host.storeCursors(this.cursors);
      await this.remote(true).catch(() => []);
    }
    return r.status === 200;
  }

  /** Mark a stream stale from a position (monotonic at the site: an earlier position widens it, nothing clears it). */
  async markStale(locator: string, log_instance: string, from_n: number, reason: StaleReason): Promise<boolean> {
    const r = await this.call("POST", "/stale", { locator, log_instance, from_n, reason });
    return r.status === 200;
  }

  // ---- reading the agent's log (tagged replays)

  /**
   * A chat.replay: true when it is the mirror's (it carries a tag), whatever becomes of it; false when it is the
   * display's (no tag). It is taken only from the current pairing, which said chat.resume.tag, as the answer to this
   * page's request in flight for that exact conversation, of the hello's run, with the exact tag; checked whole before
   * anything changes. Any other tagged replay is dropped: it goes to neither reader.
   */
  onReplay(params: unknown, from?: AgentPairing): boolean {
    const p = params as Record<string, unknown> | null;
    if (!p || typeof p !== "object" || !("tag" in p)) return false;
    const src = this.source();
    if (!src || (from !== undefined && from !== src.pairing) || typeof p.tag !== "string" || !TAG_RE.test(p.tag) || !conversationOk(p.conversation)) return true;
    const w = this.waiting.get(p.conversation);
    // (the exact tag of this page's request in flight for that conversation: a part of any other request, however late,
    //  goes nowhere)
    if (!w || p.tag !== w.tag || w.pairing !== src.pairing || p.instance !== src.instance || w.instance !== src.instance) return true;
    if (!natOk(p.last) || typeof p.done !== "boolean" || !Array.isArray(p.events) || ("reset" in p && typeof p.reset !== "boolean")) return true;
    const conv = p.conversation;
    const ok = (e: unknown): e is LogEntry => {
      const x = e as { seq?: unknown; method?: unknown; params?: unknown } | null;
      return !!x && seqOk(x.seq) && typeof x.method === "string" && !!x.params && typeof x.params === "object" && !Array.isArray(x.params) && (x.params as { conversation?: unknown }).conversation === conv;
    };
    if (!p.events.every(ok)) return true;
    clearTimeout(w.timer);
    if (!w.caller) {
      // (a part of a request already answered or given up on: discarded; it ends with its last part, or with quiet)
      if (p.done === true) this.ended(conv, w);
      else this.drain(conv, w);
      return true;
    }
    // (an answer's first part says whether entries it would hold are gone)
    if (w.parts++ === 0 && p.reset === true) w.reset = true;
    // (in the agent's order, each number once and past the request's own: anything not past the highest read is a repeat)
    let high = w.events.length ? w.events[w.events.length - 1].seq : w.after;
    for (const e of p.events as LogEntry[]) {
      if (e.seq <= high) continue;
      w.events.push(e);
      high = e.seq;
    }
    if (p.done === true) return this.settle(conv, w, true), true;
    if (high >= p.last) {
      // (all the request asked for, but not said done: the caller has it whole; the request drains briefly, sparing the
      //  agent an overlapping request (a trailing part of it carries its own tag, and goes nowhere in any case))
      const c = w.caller;
      w.caller = null;
      this.drain(conv, w);
      c.resolve({ events: w.events, reset: w.reset, complete: true });
      return true;
    }
    // (more to come, or the agent stopped early: if nothing more arrives for a moment, the caller takes what came as a
    //  partial answer, and the request drains briefly before the next. Its later parts carry its tag, and go nowhere.
    //  The rest is asked for again from where the caller got to)
    w.timer = setTimeout(() => {
      if (this.waiting.get(conv) !== w || !w.caller) return;
      if (this.host.pairing() !== w.pairing) return this.fail(conv, w, "the pairing changed");
      const c = w.caller;
      w.caller = null;
      this.drain(conv, w);
      c.resolve({ events: w.events, reset: w.reset, complete: false });
    }, w.quiet);
    return true;
  }

  private settle(conv: string, w: Waiter, complete: boolean) {
    clearTimeout(w.timer);
    this.waiting.delete(conv);
    w.caller?.resolve({ events: w.events, reset: w.reset, complete });
    this.retry(conv);
    this.wake(conv);
  }
  /** When the conversation has no request in flight or draining. */
  private whenIdle(conv: string): Promise<void> {
    if (!this.waiting.has(conv)) return Promise.resolve();
    return new Promise((r) => this.idle.set(conv, [...(this.idle.get(conv) ?? []), r]));
  }
  private wake(conv: string) {
    const l = this.idle.get(conv);
    this.idle.delete(conv);
    for (const f of l ?? []) f();
  }
  /** A request no one waits for any more: kept until its parts end or stop. */
  private drain(conv: string, w: Waiter) {
    clearTimeout(w.timer);
    w.timer = setTimeout(() => this.ended(conv, w), this.host.drainMs ?? DRAIN_MS);
  }
  private ended(conv: string, w: Waiter) {
    clearTimeout(w.timer);
    if (this.waiting.get(conv) !== w) return;
    this.waiting.delete(conv);
    this.retry(conv);
    this.wake(conv);
  }
  /** An upload refused while that request was in flight: run now. */
  private retry(conv: string) {
    if (this.refused.delete(conv)) void this.kick(conv);
  }
  /** Run the upload again: once its request ends, or, if it already has, as soon as this run is over. */
  private later(conv: string) {
    if (this.waiting.has(conv)) this.refused.add(conv);
    else this.again.add(conv);
  }
  private fail(conv: string, w: Waiter, why: string) {
    clearTimeout(w.timer);
    this.waiting.delete(conv);
    w.caller?.reject(new Error(why));
    this.wake(conv);
  }
  /** No part in time: the caller is told, and the request drains (its late parts discarded) before another is made. */
  private expire(conv: string, w: Waiter) {
    if (this.waiting.get(conv) !== w) return;
    const c = w.caller;
    w.caller = null;
    this.drain(conv, w);
    c?.reject(new Error(NO_REPLY));
  }

  /** The agent's log of a conversation after `after`, in its run `instance`, through a tagged replay. One request per
   *  conversation at a time: while one is in flight or draining, another is refused (the next trigger tries again). */
  private ask(conversation: string, after: number, src: { pairing: AgentPairing; instance: string }, quiet = this.host.quietMs ?? QUIET_MS): Promise<Answer> {
    return new Promise((resolve, reject) => {
      const old = this.waiting.get(conversation);
      if (old && old.pairing === src.pairing) return reject(new Error(BUSY));
      if (old) this.fail(conversation, old, "the pairing changed");
      const w: Waiter = { pairing: src.pairing, instance: src.instance, tag: requestTag(), after, quiet, events: [], reset: false, parts: 0, caller: { resolve, reject }, timer: undefined };
      w.timer = setTimeout(() => this.expire(conversation, w), this.host.replayMs ?? REPLAY_MS);
      this.waiting.set(conversation, w);
      src.pairing.notify("chat.resume", { conversation, after, instance: src.instance, tag: w.tag });
    });
  }

  /** One thing at a time per conversation: an upload, a reconcile. */
  private serial<T>(conversation: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(conversation) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.chains.set(conversation, next.catch(() => {}));
    return next;
  }

  // ---- the uploader

  private saveCursor(conversation: string, c: Cursor) {
    this.cursors[conversation] = c;
    this.host.storeCursors(this.cursors);
  }

  /** The server's state of one stream, all of it together (next_n, last_seq), or null where there is none. */
  private async streamState(locator: string, instance: string): Promise<RemoteStream | null> {
    const list = await this.remote(true);
    return list.find((c) => c.locator === locator)?.streams.find((s) => s.log_instance === instance) ?? null;
  }

  /**
   * Upload what the conversation's log has past the cursor (after a turn ends, a message is sent, a reconnect, and
   * every 30 s of a running turn). At most one run in flight per conversation: a kick during one runs once more after.
   */
  kick(conversation: string): Promise<void> {
    if (!this.on() || !this.source() || !conversationOk(conversation)) return Promise.resolve();
    if (this.running.has(conversation)) {
      this.again.add(conversation);
      return Promise.resolve();
    }
    this.running.add(conversation);
    return this.serial(conversation, async () => {
      try {
        do {
          this.again.delete(conversation);
          await this.upload(conversation).then(
            () => this.misses.delete(conversation),
            (e) => {
              // (refused because a request for it is still in flight or draining, or no answer came in time: run again
              //  once that request has ended; an agent that keeps not answering, only on the next real trigger)
              const why = (e as Error)?.message;
              const p = this.host.pairing();
              if (why === NO_REPLY) {
                const m = this.misses.get(conversation);
                this.misses.set(conversation, { pairing: p, n: m && m.pairing === p ? m.n + 1 : 1 });
              }
              if (why === BUSY || (why === NO_REPLY && this.misses.get(conversation)!.n < MAX_MISSES)) this.later(conversation);
            },
          );
        } while (this.again.has(conversation) && this.on() && this.source());
      } finally {
        this.running.delete(conversation);
      }
    });
  }

  private async upload(conversation: string) {
    for (let round = 0; round < 3; round++) {
      const src = this.source();
      if (!src || !this.on()) return;
      let cur: Cursor = { ...(this.cursors[conversation] ?? { seq: 0, n: 1 }) };
      if (cur.blocked && cur.instance === src.instance) return;
      if (!cur.locator) {
        const r = await this.call("POST", "/conversations", { conversation });
        if (r.status !== 200 || typeof r.json.locator !== "string" || !/^[0-9a-f]{32}$/.test(r.json.locator)) return;
        cur.locator = r.json.locator;
      }
      if (cur.instance !== src.instance) {
        // (another run of the agent: from what the site already holds of that run's stream, if anything)
        const st = await this.streamState(cur.locator, src.instance);
        cur = { locator: cur.locator, instance: src.instance, seq: st?.last_seq ?? 0, n: st?.next_n ?? 1, ...(st ? { digest: st.last_digest } : {}) };
      }
      this.saveCursor(conversation, cur);
      const ans = await this.ask(conversation, cur.seq, src);
      if (this.host.pairing() !== src.pairing) return;
      if (ans.reset && cur.seq > 0) {
        // (entries after the cursor are gone from the agent's log: going on would join what's left to what came
        //  before as if nothing were missing; this run's stream stops here)
        this.saveCursor(conversation, { ...cur, blocked: "reset" });
        return;
      }
      const fresh = ans.events.filter((e) => e.seq > cur.seq);
      if (!fresh.length) return;
      const high = fresh[fresh.length - 1].seq;
      const drafts = fresh.map(normalize).filter((d): d is MirrorDraft => d !== null);
      const { bodies, stuck } = segments(src.instance, cur.n, drafts);
      let reload = false;
      for (const body of bodies) {
        const r = await this.append(cur.locator!, body);
        if (typeof r === "object") {
          const last = body.entries[body.entries.length - 1];
          // (n, seq and the chain digest move together; a digest the answer didn't give isn't kept stale)
          const { digest: _was, ...rest } = cur;
          cur = { ...rest, n: last.n + 1, seq: last.seq, ...(r.ok ? { digest: r.ok } : {}) };
          this.saveCursor(conversation, cur);
          continue;
        }
        if (r === "reload") {
          // (another page moved the stream: its state from the site, all of it together, never n alone)
          const st = await this.streamState(cur.locator!, src.instance);
          const { digest: _old, ...rest } = cur;
          cur = { ...rest, n: st?.next_n ?? 1, seq: st?.last_seq ?? 0, ...(st ? { digest: st.last_digest } : {}) };
          this.saveCursor(conversation, cur);
          reload = true;
          break;
        }
        if (r === "conflict") {
          // (another page holds this range with other entries: this run's uploads stop, and the account's object says so)
          this.saveCursor(conversation, { ...cur, blocked: "conflict" });
          await this.markStale(cur.locator!, src.instance, body.entries[0].n, "conflict");
          await this.remote(true).catch(() => []);
        }
        if (r === "missing") {
          // (the conversation's copy was deleted, here or on another device: forgotten, so the next upload makes it again)
          delete this.cursors[conversation];
          this.host.storeCursors(this.cursors);
        }
        return;
      }
      if (reload) continue;
      // (everything read is uploaded, or left out by the allowlist: the cursor moves past it all; not past an entry
      //  too big for a segment, which stops the stream here)
      if (!stuck) this.saveCursor(conversation, { ...cur, seq: Math.max(cur.seq, high) });
      // (a partial answer: the rest is asked for once this request has ended, or now, if it already has)
      if (!ans.complete && !stuck) this.later(conversation);
      return;
    }
  }

  private async append(locator: string, body: MirrorBody): Promise<{ ok: string | null } | "reload" | "conflict" | "missing" | "stop"> {
    const first = body.entries[0], last = body.entries[body.entries.length - 1];
    const init: RequestInit = {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": MIRROR_TYPE, "x-sb-mirror-csrf": this.csrf, "x-sb-mirror-range": `${body.log_instance} ${first.n} ${last.n} ${first.seq} ${last.seq}` },
      body: canonical(body),
    };
    const r = await this.host.fetch(`${API}/append/${locator}`, init).catch(() => null);
    if (!r) return "stop";
    let j: { error?: unknown; message?: unknown } = {};
    try {
      j = (await r.json()) ?? {};
    } catch {}
    if (r.status === 200) {
      if (this.full) {
        this.full = false;
        this.host.changed();
      }
      // (the appended segment's digest: the stream's chain digest now)
      return { ok: typeof (j as { digest?: unknown }).digest === "string" && /^[0-9a-f]{64}$/.test((j as { digest: string }).digest) ? (j as { digest: string }).digest : null };
    }
    if (r.status === 507) {
      // (no room: the cursor stays, and the next trigger tries again; each append checks the quota as it is then)
      this.full = true;
      this.host.changed();
      return "stop";
    }
    if (r.status === 404 && j.error === "missing") return "missing";
    if (r.status === 409 && j.error === "conflict") return typeof j.message === "string" && /another history/.test(j.message) ? "conflict" : "reload";
    if (r.status === 403) await this.refresh();
    return "stop";
  }

  // ---- the reader

  /** One stream read back from position 1: its entries, its gaps (segments the site couldn't verify), its stale mark. */
  async readStream(locator: string, log_instance: string): Promise<Section> {
    const s: Section = { log_instance, entries: [], gaps: [], stale_from: null, stale_reason: null };
    let after = 0;
    for (let i = 0; i < READ_MAX; i++) {
      const r = await this.call("GET", `/read/${locator}/${log_instance}?after=${after}`);
      const j = r.json;
      if (r.status !== 200) {
        s.gaps.push({ first_n: after + 1, last_n: after + 1 });
        break;
      }
      s.stale_from = seqOk(j.stale_from) ? j.stale_from : null;
      s.stale_reason = typeof j.stale_reason === "string" ? j.stale_reason : null;
      if (j.end === true) break;
      const fn = j.first_n, ln = j.last_n;
      if (!seqOk(fn) || !seqOk(ln) || fn !== after + 1 || ln < fn) {
        s.gaps.push({ first_n: after + 1, last_n: after + 1 });
        break;
      }
      if (j.missing === true) s.gaps.push({ first_n: fn, last_n: ln });
      else {
        const es = Array.isArray(j.entries) ? (j.entries as MirrorEntry[]) : [];
        if (es.length !== ln - fn + 1 || es.some((e, k) => !e || e.n !== fn + k)) s.gaps.push({ first_n: fn, last_n: ln });
        else s.entries.push(...es);
      }
      after = ln;
    }
    return s;
  }

  /** A conversation from the mirror, every stream of it, each a separately labeled section. */
  async readConversation(conversation: string): Promise<{ locator: string; sections: Section[] } | null> {
    const c = (await this.remote(true)).find((x) => x.conversation === conversation);
    if (!c) return null;
    const sections: Section[] = [];
    for (const st of c.streams) if (st.next_n > 1) sections.push(await this.readStream(c.locator, st.log_instance));
    return { locator: c.locator, sections };
  }

  // ---- the reconcile

  /**
   * Compare every mirrored stream of every conversation the runner holds with the runner's log, and mark what it doesn't
   * confirm. The runner's run wins: a stream of another run is stale from position 1 (other_run); a stream of the same
   * run is stale from its first position that differs (differs) or that the runner doesn't have (missing_on_runner).
   * Reads the runner only.
   */
  async reconcile(): Promise<void> {
    const src = this.source();
    if (!src || !this.on()) return;
    const list = await this.remote(true);
    let marked = false;
    for (const c of list) {
      const streams = c.streams.filter((s) => s.next_n > 1);
      if (!streams.length) continue;
      marked = (await this.serial(c.conversation, () => this.reconcileOne(c, streams, src)).catch(() => false)) || marked;
      if (this.host.pairing() !== src.pairing) return;
    }
    if (marked) await this.remote(true);
  }

  private async reconcileOne(c: RemoteConversation, streams: RemoteStream[], src: { pairing: AgentPairing; instance: string }): Promise<boolean> {
    // (the streams of this run first, then the runner's log: an entry another page appends meanwhile is then in the
    //  runner's log too, never taken for one the runner doesn't have)
    const mine = new Map<string, Section>();
    for (const st of streams) if (st.log_instance === src.instance) mine.set(st.log_instance, await this.readStream(c.locator, st.log_instance));
    // (the runner's whole log of the conversation, request by request: each from the highest number read, once the
    //  one before has ended; a partial answer is never taken as the whole, so what it lacks is never taken for what
    //  the runner lacks)
    const ans: Answer = { events: [], reset: false, complete: false };
    for (let page = 0; page < RECONCILE_PAGES && !ans.complete; page++) {
      await this.whenIdle(c.conversation);
      if (this.host.pairing() !== src.pairing || !this.on()) return false;
      const after = ans.events.length ? ans.events[ans.events.length - 1].seq : 0;
      const got = await this.ask(c.conversation, after, src, this.host.wholeQuietMs ?? WHOLE_QUIET_MS);
      // (entries gone between two pages: the runner's log can't be read whole now)
      if (page > 0 && got.reset) return false;
      if (page === 0) ans.reset = got.reset;
      for (const e of got.events) if (e.seq > (ans.events.length ? ans.events[ans.events.length - 1].seq : 0)) ans.events.push(e);
      ans.complete = got.complete;
      if (!got.complete && !got.events.length) return false;
    }
    // (a conversation this runner doesn't hold: nothing to compare with, nothing marked)
    if (!ans.events.length || !ans.complete || this.host.pairing() !== src.pairing) return false;
    // (by the agent's number, not by position: each uploaded entry against the runner's entry of that number, after the
    //  same normalization. Where the agent's log has dropped its oldest entries (reset), numbers before what it still
    //  holds can't be confirmed or refuted, and are left as they are)
    const runner = new Map<number, MirrorDraft>();
    for (const e of ans.events) {
      const d = normalize(e);
      if (d) runner.set(e.seq, d);
    }
    const covers = ans.reset ? ans.events[0].seq : 0;
    let marked = false;
    for (const st of streams) {
      let at: number | null = null, reason: StaleReason = "differs";
      if (st.log_instance !== src.instance) {
        at = 1;
        reason = "other_run";
      } else {
        const sec = mine.get(st.log_instance)!;
        const gapAt = (n: number) => sec.gaps.some((g) => g.first_n <= n && n <= g.last_n);
        const seqs = [...runner.keys()]; // (ascending: the agent's order)
        let j = 0;
        let prev: MirrorEntry | null = null;
        for (const e of sec.entries) {
          const r = runner.get(e.seq);
          if (!r) {
            if (e.seq >= covers) {
              at = e.n;
              reason = "missing_on_runner";
              break;
            }
          } else if (canonical({ ...r, n: e.n }) !== canonical(e)) {
            at = e.n;
            break;
          }
          // (an entry of the runner's, after the previous uploaded one and before this one, that the stream skipped:
          //  the stream differs from here; across a gap the skipped entries are unknown, so nothing is said)
          if (prev) {
            while (j < seqs.length && seqs[j] <= prev.seq) j++;
            if (prev.n === e.n - 1 && !gapAt(e.n - 1) && j < seqs.length && seqs[j] < e.seq && seqs[j] >= covers) {
              at = e.n;
              break;
            }
          }
          prev = e;
        }
      }
      if (at !== null && (st.stale_from === null || at < st.stale_from)) marked = (await this.markStale(c.locator, st.log_instance, at, reason)) || marked;
    }
    return marked;
  }
}

// ---- the words (design §5; pinned in a test for COPY)

export const MIRROR_COPY = {
  switch: "Keep your agent conversations in your Sagebrush account",
  off: "Your conversations live on the computer that runs your agent. With this on, they're also uploaded to your account while this page is open and connected to your agent, so you can read them on your other devices. It counts toward your account's storage.",
  on: "Uploaded by your pages: your messages, the agent's replies, and a short record of each turn and tool. Tool output, files and command output aren't uploaded. Sagebrush and Cloudflare can read your mirrored history. Anything you paste into a message is uploaded as written.",
  confirmOff: "Turn off and delete your mirrored history? This stops uploads and starts deleting your mirrored copy. Your conversations stay on your agent's computer.",
  confirmOffButton: "Turn off and delete",
  deleting: "Deleting mirrored history…",
  deleted: "Mirrored history deleted",
  deleteOne: "Delete this conversation's mirrored copy",
  storage: (size: string, quota: string | null) => (quota ? `Mirror: ${size} of your ${quota}` : `Mirror: ${size}`),
  full: "There isn't enough free storage to mirror new messages. Mirroring will resume when there's room.",
  updateAgent: "Update the agent to mirror this conversation",
  section: "Uploaded by your page",
  otherRun: "Uploaded by your page; not confirmed by your agent",
  unconfirmed: "Not confirmed by your agent",
  gap: "Part of this conversation couldn't be read",
  readOnly: "This is the copy in your account, and it's read-only. To continue this conversation, connect the agent that has it.",
  badge: "mirror",
  viewCopy: "View the mirrored copy",
  keptMirrored: "Chats are kept in this browser and mirrored to your Sagebrush account.",
  keptHere: "Chats are kept in this browser only.",
  untitled: "Mirrored conversation",
  reasons: {
    differs: "it differs from your agent's history",
    missing_on_runner: "your agent doesn't have it",
    other_run: "it's from another run of your agent",
    conflict: "another page uploaded something different here",
  } as Record<StaleReason, string>,
} as const;

/** The reason's words, or none for one this page doesn't know. */
export const reasonText = (r: string | null): string | null => (r !== null && Object.hasOwn(MIRROR_COPY.reasons, r) ? MIRROR_COPY.reasons[r as StaleReason] : null);

// ---- what a section shows: inert records (§6: no cards, no artifact actions, no queue; text only)

export type InertPart =
  | { k: "text"; text: string; truncated: boolean }
  | { k: "tool"; tool: string; summary?: string; status: string; duration_ms?: number }
  | { k: "approval"; kind: string; title?: string; state: "open" | "approved" | "denied" }
  | { k: "artifact"; kind: string; title?: string }
  | { k: "error"; code: string };
export type InertBlock = { n: number; last_n: number; unconfirmed: boolean } & (
  | { k: "user"; text: string; steer: boolean }
  | { k: "turn"; parts: InertPart[]; outcome?: "completed" | "interrupted" | "error" }
  | { k: "gap"; first_n: number }
);

/**
 * A section's entries as blocks to draw, in position order: the person's messages, the agent's turns (their text,
 * tools, approvals and artifacts as plain records), and the gaps. From the stream's stale_from on, every block is
 * unconfirmed. Nothing here can be answered, opened or sent.
 */
export function present(sec: Section): InertBlock[] {
  const out: InertBlock[] = [];
  const turns = new Map<string, Extract<InertBlock, { k: "turn" }>>();
  const messages = new Map<string, { part: Extract<InertPart, { k: "text" }>; revision: number }>();
  const tools = new Map<string, Extract<InertPart, { k: "tool" }>>();
  const stale = (n: number) => sec.stale_from !== null && n >= sec.stale_from;
  const turnOf = (id: string, n: number) => {
    let t = turns.get(id);
    if (!t) {
      t = { k: "turn", n, last_n: n, unconfirmed: stale(n), parts: [] };
      turns.set(id, t);
      out.push(t);
    }
    t.last_n = n;
    if (stale(n)) t.unconfirmed = true;
    return t;
  };
  // (entries and gaps in position order; a gap ends the blocks it falls in, so what follows it starts afresh, drawn
  //  after the gap line, never joined to what came before it)
  const items: ({ gap: Section["gaps"][number]; n: number } | { e: MirrorEntry; n: number })[] = [...sec.gaps.map((gap) => ({ gap, n: gap.first_n })), ...sec.entries.map((e) => ({ e, n: e.n }))].sort((a, b) => a.n - b.n);
  for (const it of items) {
    if ("gap" in it) {
      out.push({ k: "gap", n: it.gap.first_n, first_n: it.gap.first_n, last_n: it.gap.last_n, unconfirmed: stale(it.gap.first_n) });
      turns.clear();
      messages.clear();
      tools.clear();
      continue;
    }
    const e = it.e;
    if (e.k === "user") out.push({ k: "user", n: e.n, last_n: e.n, unconfirmed: stale(e.n), text: e.text, steer: e.steer === true });
    else if (e.k === "receipt") continue;
    else {
      const t = turnOf(e.turn, e.n);
      const key = e.turn + "\u0000" + ("message" in e ? e.message : "call" in e ? e.call : "");
      if (e.k === "message_revised") {
        const m = messages.get(key);
        if (m) {
          m.revision = e.revision;
          m.part.text = "";
          m.part.truncated = false;
        } else {
          const part = { k: "text" as const, text: "", truncated: false };
          messages.set(key, { part, revision: e.revision });
          t.parts.push(part);
        }
      } else if (e.k === "text") {
        let m = messages.get(key);
        if (!m) {
          m = { part: { k: "text", text: "", truncated: false }, revision: e.revision };
          messages.set(key, m);
          t.parts.push(m.part);
        }
        if (m.revision === e.revision) m.part.text += e.text;
      } else if (e.k === "message_truncated") {
        const m = messages.get(key);
        if (m) m.part.truncated = true;
      } else if (e.k === "tool_started") {
        const p = { k: "tool" as const, tool: e.tool, status: "running", ...(e.summary ? { summary: e.summary } : {}) };
        tools.set(key, p);
        t.parts.push(p);
      } else if (e.k === "tool_finished") {
        const p = tools.get(key);
        if (p) Object.assign(p, { status: e.status, duration_ms: e.duration_ms }, e.summary ? { summary: e.summary } : {});
      } else if (e.k === "approval") t.parts.push({ k: "approval", kind: e.kind, state: e.state, ...(e.title ? { title: e.title } : {}) });
      else if (e.k === "artifact") t.parts.push({ k: "artifact", kind: e.kind, ...(e.title ? { title: e.title } : {}) });
      else if (e.k === "turn_error") t.parts.push({ k: "error", code: e.code });
      else if (e.k === "turn_finished") t.outcome = e.outcome;
    }
  }
  return out;
}

/** A title for a mirrored conversation: its first message's first line, or a general one. */
export function mirrorTitle(sections: Section[]): string {
  for (const s of sections) for (const e of s.entries) if (e.k === "user" && e.text.trim()) return e.text.trim().split("\n")[0].slice(0, 48);
  return MIRROR_COPY.untitled;
}
