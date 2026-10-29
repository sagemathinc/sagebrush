// The Storage panel's Sync section (sync client step 5, plan-step5-sync-ui r4 §1): the switch, turning sync on and
// off, what the sync left aside, and "Delete my synced data…".
//
// - GET /api/sync/v1/status decides the switch; the page never probes with POST enable.  not_allowlisted: hidden;
//   plan_has_no_sync, cocalc_unreachable, deleted: shown disabled with the server's words (or a plain fallback);
//   deleting: "Deleting…"; a status that can't be read: "unknown", never taken as off or on.
// - One PanelPoll per open panel: at most one request in flight and one timer; the server's delay clamped to
//   [PANEL.minMs, PANEL.maxMs], else a backoff of 2 s doubling to 60 s, ±20 %; closing aborts the request, clears the
//   timer and drops any late answer (DB3-STEP5-1).
// - Delete is offered only where the server enforces the account precondition (its status carries `limit_bytes`,
//   which the same server change adds): the coordinator's decision, Oct 24.  The confirmation is bound to the
//   account and generation it was shown for; every outcome is in the table of r2/r3 §1.4, and nothing is ever POSTed
//   again without a click.
import type { Workspace } from "./api";
import { req } from "./db";
import { switchToIf } from "./sync-outbox";
import { readLife, sameLife, syncOffIf, type LifeMark } from "./sync-pins";
import { SyncOwner } from "./sync-owner";
import { DOC_SYNC_NOTE, docSyncOrigin } from "./doc-sync-switch";
import { accountHash } from "../sync-protocol/protocol";
import type { Refusal } from "./sync-client";

export const PANEL = {
  /** the server's delay, clamped to this range */
  minMs: 1000,
  maxMs: 600_000,
  /** without a usable delay: from `first`, doubling to `max`, ±`jitter` */
  backoff: { first: 2000, max: 60_000, jitter: 0.2 },
};

export type Status = { available: boolean; reason?: string; state: string; generation?: number; retry_after?: number; message?: string; limit_bytes?: number | null; used_bytes?: number; account?: string };
/** A status answer; `life`, the lifecycle of this browser it was read under (the panel's reads: an answer read across
 * a lifecycle change is "stale", never applied: astra3's CORR-PR130-3). */
/** `verified`: the server named the account it computed the answer for (its echo) and it is the session's; an old
 * server names none: the answer is shown, but its limit is not taken and no delete is offered from it.  "mismatch":
 * the echo names another account: never applied, asked again after the poll's backoff (no immediate retry). */
export type Answer = { ok: true; status: Status; account: string | null; life?: LifeMark; verified: boolean } | { ok: false; why: "network" | "http" | "stale" | "mismatch"; code?: number; retryAfter?: number };

/** The server's delay as the panel takes it: a finite safe integer of ms, clamped; anything else, none. */
export function clampDelay(ms: unknown): number | undefined {
  if (typeof ms !== "number" || !Number.isSafeInteger(ms) || ms < 0) return undefined;
  return Math.min(PANEL.maxMs, Math.max(PANEL.minMs, ms));
}

/** One open panel's status requests: one in flight at most, one timer at most; close() ends both and every late
 * answer.  `random` and `after` are the clock's (tests: a fake one). */
export class PanelPoll {
  private ac: AbortController | null = null;
  private timer: (() => void) | null = null;
  private gen = 0;
  private wait: number = PANEL.backoff.first;
  closed = false;
  /** (tests) requests made */
  requests = 0;
  constructor(private askOnce: (signal: AbortSignal) => Promise<Answer>, private onAnswer: (a: Answer) => void, private random: () => number = Math.random, private after: (ms: number, f: () => void) => () => void = (ms, f) => { const t = setTimeout(f, ms); return () => clearTimeout(t); }) {}
  get busy() { return !!this.ac; }
  get armed() { return !!this.timer; }
  /** One request now, unless one is in flight (single-flight) or the panel closed. */
  request() {
    if (this.closed || this.ac) return;
    this.timer?.();
    this.timer = null;
    const ac = new AbortController(), g = this.gen;
    this.ac = ac;
    this.requests++;
    this.askOnce(ac.signal).then((a) => {
      if (this.ac === ac) this.ac = null;
      if (g !== this.gen || this.closed) return;
      this.onAnswer(a);
    }, () => { if (this.ac === ac) this.ac = null; });
  }
  /** The next request after the server's delay (clamped) or the backoff's; one timer at most.  Returns the wait. */
  later(serverMs?: number): number | undefined {
    if (this.closed) return undefined;
    this.timer?.();
    const d = clampDelay(serverMs) ?? this.nextBackoff();
    this.timer = this.after(d, () => { this.timer = null; this.request(); });
    return d;
  }
  /** A timer of the panel's own (a Retry's wait, §1.4): it replaces the poll's, one at most. */
  wake(ms: number, f: () => void) {
    if (this.closed) return;
    this.timer?.();
    this.timer = this.after(ms, () => { this.timer = null; if (!this.closed) f(); });
  }
  /** A good answer: the backoff starts again from its first step. */
  good() { this.wait = PANEL.backoff.first; }
  private nextBackoff() {
    const j = PANEL.backoff.jitter, d = Math.round(this.wait * (1 - j + 2 * j * this.random()));
    this.wait = Math.min(PANEL.backoff.max, this.wait * 2);
    return d;
  }
  close() {
    this.closed = true;
    this.gen++;
    this.ac?.abort();
    this.ac = null;
    this.timer?.();
    this.timer = null;
  }
}

type Fetch = typeof fetch;
const fallback: Record<string, string> = {
  plan_has_no_sync: "Sync isn't available for this account",
  cocalc_unreachable: "CoCalc can't be reached right now",
  deleted: "This CoCalc account was deleted",
};
const fmt = (n: number) => (n < 1024 ? `${n} B` : n < 2 ** 20 ? `${(n / 1024).toFixed(1)} KB` : n < 2 ** 30 ? `${(n / 2 ** 20).toFixed(1)} MB` : `${(n / 2 ** 30).toFixed(2)} GB`);
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) (el as any)[k] = v;
  el.append(...kids);
  return el;
}
const btn = (text: string, onclick: () => void, cls = "") => { const b = h("button", { textContent: text, className: cls }); b.onclick = onclick; return b; };

function retryOf(r: Response, body: { retry_after?: unknown } | null): number | undefined {
  if (typeof body?.retry_after === "number") return body.retry_after;
  const v = r.headers.get("retry-after");
  return v && /^\d+$/.test(v) ? Number(v) * 1000 : undefined;
}
/** One status, with the session's account (its hash, from /api/share/me) read with it: the panel's confirmations
 * are bound to both.  The account is read before the status and again after it (its body read): a session that
 * changed across the read (another tab signed in as another account) makes the answer "stale", never applied, and
 * it is asked again (astra3's CORR-PR130-4). */
export async function askStatus(f: Fetch, signal: AbortSignal): Promise<Answer> {
  try {
    const who = async () => {
      const me = await f("/api/share/me", { credentials: "same-origin", signal });
      const id = me.ok ? ((await me.json()) as { account_id?: unknown }).account_id : null;
      return typeof id === "string" ? id : null;
    };
    const id = await who();
    const r = await f("/api/sync/v1/status", { credentials: "same-origin", signal });
    if (!r.ok) return { ok: false, why: "http", code: r.status, retryAfter: retryOf(r, null) };
    const status = (await r.json()) as Status;
    if ((await who()) !== id) return { ok: false, why: "stale" };
    const account = id !== null ? await accountHash(id) : null;
    // (the server's echo: the account it computed this answer for, from the same request's session; a session that
    // went to another account and back across the read (A, B, A) is caught here, astra3's CORR-PR130-4)
    if (typeof status.account === "string" && status.account !== account) return { ok: false, why: "mismatch" };
    return { ok: true, status, account, verified: typeof status.account === "string" && account !== null };
  } catch {
    return { ok: false, why: "network" };
  }
}

export type SectionHost = { say(text: string): void; fail(e: unknown): void; usage(): Promise<{ files: { count: number; bytes: number } }>; confirm?: (text: string) => boolean; prompt?: (text: string) => string | null };

/** The Sync section, drawn into `into`; dispose() (the panel's close) ends its poll and its subscription. */
/** What the details read gives: the listed paths and the refusals of namespace `ns` (a seam for tests). */
type DetailsRead = (ns: string) => Promise<[{ count: number; paths: [string, string][] } | undefined, Refusal[] | undefined]>;
export function syncSection(w: Workspace, into: HTMLElement, host: SectionHost, opts: { fetch?: Fetch; random?: () => number; after?: (ms: number, f: () => void) => () => void; readDetails?: DetailsRead } = {}): { dispose: () => void; poll: PanelPoll; refresh: () => void } {
  const f: Fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const confirmFn = host.confirm ?? ((t: string) => confirm(t)), promptFn = host.prompt ?? ((t: string) => prompt(t));
  const owner = SyncOwner.of(w);
  const sec = h("div", { className: "sync" });
  into.append(sec);
  let last: { status: Status; account: string | null; verified: boolean } | null = null;
  // (a deletion being followed: its account and generation, until status says off)
  let deleting: { generation: number; account: string } | null = null;
  let note = "";
  let retryAt = 0;
  // (each draw's generation: a details read started by an older draw, or after close, never touches the panel:
  // daybreak3's CORR-PR130-1)
  let renderGen = 0;
  const readDetails: DetailsRead = opts.readDetails ?? ((ns) => new Promise((ok, no) => {
    const meta = w.ws.transaction("meta").objectStore("meta");
    Promise.all([req(meta.get(`sync:${ns}:listed`)), req(meta.get(`sync:${ns}:refused`))]).then((v) => ok(v as any), no);
  }));
  // (every status read bound to the lifecycle it started under: one that a lifecycle change overtook is dropped and
  // asked again, never applied (astra3's CORR-PR130-3))
  const boundStatus = async (signal: AbortSignal): Promise<Answer> => {
    const before = await readLife(w);
    const a = await askStatus(f, signal);
    if (!sameLife(await readLife(w), before)) return { ok: false, why: "stale" };
    return a.ok ? { ...a, life: before } : a;
  };
  const poll = new PanelPoll(boundStatus, (a) => answered(a), opts.random, opts.after);
  const unsub = owner.onChange(() => { if (last && !poll.closed) draw(); });

  function answered(a: Answer) {
    if (!a.ok && a.why === "stale") return poll.request();
    if (!a.ok) {
      last = null;
      const signedOut = a.why === "http" && a.code === 401;
      sec.replaceChildren(h("h4", { textContent: "Sync" }), h("p", { className: "note", textContent: signedOut ? "Sign in (Share…) to use sync" : "Can't check sync right now" }));
      // (unknown is never off or on: asked again later; a 401 is said and left)
      if (!signedOut) poll.later(a.retryAfter);
      return;
    }
    poll.good();
    last = { status: a.status, account: a.account, verified: a.verified };
    const st = a.status;
    // (the plan's limit is the account's: kept for this browser's sync only if its namespace is that account's, so no
    // other account's limit is ever published under it)
    if ("limit_bytes" in st && limitIsOurs(a)) owner.limit = { limit_bytes: st.limit_bytes ?? null, used_bytes: st.used_bytes ?? 0 };
    // (a deletion followed to its end only on verified answers: an unverified one never completes or drops it)
    if (deleting && a.verified) {
      if (a.account !== deleting.account) {
        deleting = null;
        note = "Signed in as another account: this deletion isn't followed here any more";
      } else if (st.state === "off") {
        deleting = null;
        note = "Your synced data was deleted. This browser's copy is unchanged.";
      } else if (st.state !== "deleting" && (st.generation ?? 0) > deleting.generation) {
        deleting = null;
        note = "Sync was turned on again since";
      }
    }
    draw();
    if (deleting || st.state === "deleting") poll.later(st.retry_after);
    else if (!st.available && st.reason === "cocalc_unreachable") poll.later(st.retry_after);
  }

  function draw() {
    if (!last) return;
    const st = last.status;
    renderGen++;
    sec.replaceChildren();
    // (off the allowlist: nothing at all)
    if (!st.available && st.reason === "not_allowlisted") return;
    sec.append(h("h4", { textContent: "Sync" }));
    if (note) sec.append(h("p", { className: "note", textContent: note }));
    if (!st.available) {
      const sw = btn("Turn on sync…", () => {});
      sw.disabled = true;
      sec.append(sw, h("p", { className: "note", textContent: st.message ?? fallback[st.reason ?? ""] ?? "Sync isn't available" }));
      return;
    }
    if (deleting || st.state === "deleting") {
      const sw = btn("Deleting your synced data…", () => {});
      sw.disabled = true;
      sec.append(sw);
      return;
    }
    const v = owner.view();
    const on = st.state !== "off";
    const here = owner.client !== null || v.s.state !== "off";
    if (!on || !here) {
      sec.append(btn("Turn on sync…", () => void enable()));
      if (on) sec.append(h("p", { className: "note", textContent: "Sync is on for your account, not in this browser." }));
    } else {
      sec.append(h("p", { textContent: `Sync is on: ${foot(v.s)}` }), btn("Turn off sync here", () => void off()));
      // (DEV's switch for notebooks' contents: what it does and doesn't do yet, and that it lasts in this browser)
      if (docSyncOrigin(location.origin)) sec.append(h("ul", { className: "note" }, ...DOC_SYNC_NOTE.map((t) => h("li", { textContent: t }))));
    }
    const lim = owner.limit;
    if (lim && lim.limit_bytes !== null) sec.append(h("p", { className: "note", textContent: `Your plan's storage: ${fmt(lim.used_bytes)} of ${fmt(lim.limit_bytes)} used` }));
    if (on) {
      // (the details' own container, replaced by the read that belongs to this draw, and only by it)
      const box = h("div", { className: "sync-details" });
      sec.append(box);
      void details(renderGen, box);
    }
    // (delete: only where the server enforces the account precondition (its status carries limit_bytes))
    // (and only from an answer whose account the server named and the session confirmed: never from an old server's)
    if (on && "limit_bytes" in st && st.generation && last.verified) {
      const d = btn("Delete my synced data…", () => void del(), "danger");
      if (Date.now() < retryAt) {
        d.disabled = true;
        d.textContent = `Try again in ${Math.ceil((retryAt - Date.now()) / 1000)} s`;
      }
      sec.append(d);
    }
  }

  /** The details of draw `gen`, into its own container: after each await, nothing is done unless that draw is still
   * the newest, the panel open, and the lifecycle the one it read (no stale, duplicate or late blocks); a failed read
   * is said in the container, never left unhandled. */
  async function details(gen: number, box: HTMLElement) {
    const current = () => gen === renderGen && !poll.closed && box.isConnected;
    try {
      const life = await owner.durable();
      if (!life || !current()) return;
      const [listed, refused] = await readDetails(life.ns);
      if (!current()) return;
      const now = await owner.durable();
      if (!current() || !now || now.ns !== life.ns || now.epoch !== life.epoch) return;
      const parts: HTMLElement[] = [];
      if (listed?.count) parts.push(h("details", {}, h("summary", { textContent: `${listed.count} item${listed.count === 1 ? "" : "s"} sync kept aside` }), ...listed.paths.slice(0, 20).map(([p, why]) => h("div", { textContent: `${p} (${why})` }))));
      if (refused?.length) parts.push(h("details", {}, h("summary", { textContent: `${refused.length} change${refused.length === 1 ? "" : "s"} the server refused` }), ...refused.slice(-20).map((r) => h("div", { textContent: `${r.path || "(no path)"}: ${r.code}` }))));
      box.replaceChildren(...parts);
    } catch {
      if (current()) box.replaceChildren(h("p", { className: "note", textContent: "This browser's sync details can't be read now" }));
    }
  }
  /** syncOff as a compare-and-set against the lifecycle the action saw (astra3's CORR-PR130-1): a late answer never
   * turns off a newer lifecycle.  Returns whether it applied; when it didn't, the note says so. */
  async function offIf(mark: LifeMark, kind: "off" | "deleting"): Promise<boolean> {
    const applied = await syncOffIf(w, mark);
    if (applied) owner.nudge(kind);
    else note = (note ? note + ". " : "") + "This browser's sync changed meanwhile (another tab), so it was left as it is";
    return applied;
  }

  async function enable() {
    const st = last?.status, bound = last?.account ?? null;
    if (!st) return;
    // (the lifecycle this action saw: the answer is applied here only if it is still the one)
    const mark = await readLife(w);
    const use = await host.usage();
    const supported = "limit_bytes" in st;
    const lim = supported && st.limit_bytes !== null && st.limit_bytes !== undefined ? `\nYour plan's storage: ${fmt(st.used_bytes ?? 0)} of ${fmt(st.limit_bytes)} used.` : "";
    const warn = supported ? "" : "\nIf another tab signs in as another account meanwhile, check the account here afterwards.";
    if (!confirmFn(`Turn on sync?\n${use.files.count} data file${use.files.count === 1 ? "" : "s"} (${fmt(use.files.bytes)}) will be uploaded. Your notebooks and boards are listed; their contents sync in a later step.${lim}${warn}`)) return;
    // (without the server's precondition: the account read again just before, and the enable not sent if it moved)
    if (!supported) {
      const again = await askStatus(f, new AbortController().signal);
      if (!again.ok || again.account !== bound) {
        note = "You're now signed in as another account; check again";
        return poll.request();
      }
    }
    let r: Response;
    try {
      r = await f("/api/sync/v1/enable", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(supported && bound ? { account: bound } : {}) });
    } catch {
      note = "Couldn't reach the server: nothing was turned on";
      return poll.request();
    }
    const body = (await r.json().catch(() => ({}))) as { generation?: number; error?: string; message?: string };
    if (r.status === 409 && body.error === "account_mismatch") {
      note = "You're now signed in as another account; check again";
      return poll.request();
    }
    if (!r.ok || !Number.isSafeInteger(body.generation) || !bound) {
      note = body.message ?? body.error ?? `Sync couldn't be turned on (${r.status})`;
      return poll.request();
    }
    const lease = await switchToIf(w, `${bound}:${body.generation}:${w.device}`, mark);
    if (!lease) {
      note = "Sync was turned on for your account, but this browser's sync changed meanwhile (another tab), so it was left as it is";
      return poll.request();
    }
    note = "";
    owner.nudge("on");
    host.say("Sync turned on");
    poll.request();
  }

  async function off() {
    if (await offIf(await readLife(w), "off")) host.say("Sync turned off here: this browser's copy stays as it is");
    poll.request();
  }

  async function del() {
    const st = last?.status, account = last?.account;
    if (!st || !account || !st.generation || Date.now() < retryAt) return;
    const mark = await readLife(w);
    const typed = promptFn('Delete your synced data? This deletes what sync keeps on the server for your account; this browser\'s copy stays. Type "delete" to confirm.');
    if (typed !== "delete") return;
    const generation = st.generation;
    let r: Response;
    try {
      r = await f("/api/sync/v1/delete", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: "delete", generation, account }) });
    } catch {
      return lost(generation, account, mark);
    }
    const body = (await r.json().catch(() => ({}))) as { state?: string; error?: string; message?: string; retry_after?: number };
    if (r.status === 409 && body.error === "account_mismatch") {
      note = "Signed in as another account: nothing was deleted";
      return poll.request();
    }
    if (r.status === 429) {
      const d = clampDelay(retryOf(r, body)) ?? PANEL.backoff.first;
      retryAt = Date.now() + d;
      note = "The server asks to wait before deleting";
      // (the button enabled again when the wait ends: never an automatic POST)
      poll.wake(d, () => { retryAt = 0; draw(); });
      return draw();
    }
    if (!r.ok) {
      note = body.message ?? body.error ?? `The deletion was refused (${r.status})`;
      return draw();
    }
    if (body.state === "deleting") {
      note = "";
      await offIf(mark, "deleting");
      deleting = { generation, account };
      draw();
      poll.later(PANEL.minMs);
      return;
    }
    if (body.state === "stale") {
      note = "Sync was turned on again since; confirm again to delete the current data";
      return poll.request();
    }
    if (body.state === "none") {
      note = "There's no synced data to delete";
      await offIf(mark, "off");
      return poll.request();
    }
    return lost(generation, account, mark);
  }
  /** A delete whose answer was lost: one read-only status decides; nothing is POSTed again without a click. */
  async function lost(generation: number, account: string, mark: LifeMark) {
    const a = await boundStatus(new AbortController().signal);
    if (poll.closed) return;
    note = "Couldn't confirm the deletion";
    // (applied only to the lifecycle the action saw, or to this action's own change of it: when the compare-and-set
    // refuses (another tab changed it meanwhile), or the read was overtaken, the answer is stale: dropped, and the
    // status asked afresh (astra3's CORR-PR130-3))
    const stale = () => {
      note = "Couldn't confirm the deletion. This browser's sync changed meanwhile (another tab), so it was left as it is";
      poll.request();
    };
    let own = false;
    // (only a verified answer (its echo the session's account) may turn sync off here or follow the deletion: an
    // answer without an echo (an old, mixed or rolled-back server) is shown, nothing done (astra3's CORR-PR130-5))
    if (a.ok && !a.verified && a.account === account) note = "Couldn't confirm the deletion: the server didn't say which account its status is for; Delete again to send it once more";
    if (a.ok && a.verified && a.account === account) {
      if (a.status.state === "deleting") {
        if (!(own = await offIf(mark, "deleting"))) return stale();
        deleting = { generation, account };
      } else if (a.status.state === "off") {
        note = "There's no synced data to delete";
        if (!(own = await offIf(mark, "off"))) return stale();
      } else if ((a.status.generation ?? 0) > generation) note = "Sync was turned on again since; confirm again to delete the current data";
      else note = "Couldn't confirm the deletion: Delete again to send it once more";
    }
    if (!own && (!a.ok ? a.why === "stale" : !a.life || !sameLife(a.life, mark))) return stale();
    if (poll.closed) return;
    answered(own && a.ok ? { ...a, life: undefined } : a);
  }
  /** Whether a status answer's limit may be this browser's: sync off here (shown only), or on for that account. */
  function limitIsOurs(a: Answer & { ok: true }): boolean {
    // (an answer whose account the server didn't name (an old server) is shown, its limit not taken)
    if (!a.verified) return false;
    if (!a.life || !a.life.ns || a.life.off) return true;
    return !!a.account && a.life.ns.startsWith(a.account + ":");
  }

  poll.request();
  return { dispose: () => { poll.close(); renderGen++; unsub(); }, poll, refresh: () => poll.request() };
}

/** The foot's words for a snapshot (r2 §2.3). */
export function foot(s: { state: string; waiting?: number; reason?: string; lastSynced?: number; full?: boolean }, now = Date.now()): string {
  const n = s.waiting ?? 0;
  if (s.full) return "too many changes waiting to sync";
  switch (s.state) {
    case "synced": return s.lastSynced ? `Synced · ${ago(now - s.lastSynced)}` : "Synced";
    case "syncing": return `Syncing ${n} change${n === 1 ? "" : "s"}…`;
    case "offline": return `Offline: ${n} change${n === 1 ? "" : "s"} wait`;
    case "paused": return `Paused: ${s.reason ?? "waiting"}`;
    case "connecting": case "waiting": return "Connecting…";
    default: return "Sync off";
  }
}
function ago(ms: number) {
  const m = Math.floor(ms / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ago`;
}
