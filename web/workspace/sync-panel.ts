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
import { switchTo } from "./sync-outbox";
import { syncOff } from "./sync-pins";
import { SyncOwner } from "./sync-owner";
import { accountHash } from "../sync-protocol/protocol";
import type { Refusal } from "./sync-client";

export const PANEL = {
  /** the server's delay, clamped to this range */
  minMs: 1000,
  maxMs: 600_000,
  /** without a usable delay: from `first`, doubling to `max`, ±`jitter` */
  backoff: { first: 2000, max: 60_000, jitter: 0.2 },
};

export type Status = { available: boolean; reason?: string; state: string; generation?: number; retry_after?: number; message?: string; limit_bytes?: number | null; used_bytes?: number };
export type Answer = { ok: true; status: Status; account: string | null } | { ok: false; why: "network" | "http"; code?: number; retryAfter?: number };

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
 * are bound to both. */
export async function askStatus(f: Fetch, signal: AbortSignal): Promise<Answer> {
  try {
    const me = await f("/api/share/me", { credentials: "same-origin", signal });
    const id = me.ok ? ((await me.json()) as { account_id?: unknown }).account_id : null;
    const r = await f("/api/sync/v1/status", { credentials: "same-origin", signal });
    if (!r.ok) return { ok: false, why: "http", code: r.status, retryAfter: retryOf(r, null) };
    const status = (await r.json()) as Status;
    return { ok: true, status, account: typeof id === "string" ? await accountHash(id) : null };
  } catch {
    return { ok: false, why: "network" };
  }
}

export type SectionHost = { say(text: string): void; fail(e: unknown): void; usage(): Promise<{ files: { count: number; bytes: number } }>; confirm?: (text: string) => boolean; prompt?: (text: string) => string | null };

/** The Sync section, drawn into `into`; dispose() (the panel's close) ends its poll and its subscription. */
export function syncSection(w: Workspace, into: HTMLElement, host: SectionHost, opts: { fetch?: Fetch; random?: () => number; after?: (ms: number, f: () => void) => () => void } = {}): { dispose: () => void; poll: PanelPoll; refresh: () => void } {
  const f: Fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const confirmFn = host.confirm ?? ((t: string) => confirm(t)), promptFn = host.prompt ?? ((t: string) => prompt(t));
  const owner = SyncOwner.of(w);
  const sec = h("div", { className: "sync" });
  into.append(sec);
  let last: { status: Status; account: string | null } | null = null;
  // (a deletion being followed: its account and generation, until status says off)
  let deleting: { generation: number; account: string } | null = null;
  let note = "";
  let retryAt = 0;
  const poll = new PanelPoll((s) => askStatus(f, s), (a) => answered(a), opts.random, opts.after);
  const unsub = owner.onChange(() => { if (last && !poll.closed) draw(); });

  function answered(a: Answer) {
    if (!a.ok) {
      last = null;
      const signedOut = a.why === "http" && a.code === 401;
      sec.replaceChildren(h("h4", { textContent: "Sync" }), h("p", { className: "note", textContent: signedOut ? "Sign in (Share…) to use sync" : "Can't check sync right now" }));
      // (unknown is never off or on: asked again later; a 401 is said and left)
      if (!signedOut) poll.later(a.retryAfter);
      return;
    }
    poll.good();
    last = { status: a.status, account: a.account };
    const st = a.status;
    if ("limit_bytes" in st) owner.limit = { limit_bytes: st.limit_bytes ?? null, used_bytes: st.used_bytes ?? 0 };
    if (deleting) {
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
    } else sec.append(h("p", { textContent: `Sync is on: ${foot(v.s)}` }), btn("Turn off sync here", () => void off()));
    const lim = owner.limit;
    if (lim && lim.limit_bytes !== null) sec.append(h("p", { className: "note", textContent: `Your plan's storage: ${fmt(lim.used_bytes)} of ${fmt(lim.limit_bytes)} used` }));
    if (on) void details();
    // (delete: only where the server enforces the account precondition (its status carries limit_bytes))
    if (on && "limit_bytes" in st && st.generation) {
      const d = btn("Delete my synced data…", () => void del(), "danger");
      if (Date.now() < retryAt) {
        d.disabled = true;
        d.textContent = `Try again in ${Math.ceil((retryAt - Date.now()) / 1000)} s`;
      }
      sec.append(d);
    }
  }

  async function details() {
    const ns = (await owner.durable())?.ns;
    if (!ns || poll.closed) return;
    const [listed, refused] = await new Promise<[{ count: number; paths: [string, string][] } | undefined, Refusal[] | undefined]>((ok, no) => {
      const meta = w.ws.transaction("meta").objectStore("meta");
      Promise.all([req(meta.get(`sync:${ns}:listed`)), req(meta.get(`sync:${ns}:refused`))]).then((v) => ok(v as any), no);
    });
    if (listed?.count) sec.append(h("details", {}, h("summary", { textContent: `${listed.count} item${listed.count === 1 ? "" : "s"} sync kept aside` }), ...listed.paths.slice(0, 20).map(([p, why]) => h("div", { textContent: `${p} (${why})` }))));
    if (refused?.length) sec.append(h("details", {}, h("summary", { textContent: `${refused.length} change${refused.length === 1 ? "" : "s"} the server refused` }), ...refused.slice(-20).map((r) => h("div", { textContent: `${r.path || "(no path)"}: ${r.code}` }))));
  }

  async function enable() {
    const st = last?.status, bound = last?.account ?? null;
    if (!st) return;
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
    await switchTo(w, `${bound}:${body.generation}:${w.device}`);
    note = "";
    owner.nudge("on");
    host.say("Sync turned on");
    poll.request();
  }

  async function off() {
    await syncOff(w);
    owner.nudge("off");
    host.say("Sync turned off here: this browser's copy stays as it is");
    poll.request();
  }

  async function del() {
    const st = last?.status, account = last?.account;
    if (!st || !account || !st.generation || Date.now() < retryAt) return;
    const typed = promptFn('Delete your synced data? This deletes what sync keeps on the server for your account; this browser\'s copy stays. Type "delete" to confirm.');
    if (typed !== "delete") return;
    const generation = st.generation;
    let r: Response;
    try {
      r = await f("/api/sync/v1/delete", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: "delete", generation, account }) });
    } catch {
      return lost(generation, account);
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
      await syncOff(w);
      owner.nudge("deleting");
      deleting = { generation, account };
      note = "";
      draw();
      poll.later(PANEL.minMs);
      return;
    }
    if (body.state === "stale") {
      note = "Sync was turned on again since; confirm again to delete the current data";
      return poll.request();
    }
    if (body.state === "none") {
      await syncOff(w);
      owner.nudge("off");
      note = "There's no synced data to delete";
      return poll.request();
    }
    return lost(generation, account);
  }
  /** A delete whose answer was lost: one read-only status decides; nothing is POSTed again without a click. */
  async function lost(generation: number, account: string) {
    const a = await askStatus(f, new AbortController().signal);
    if (poll.closed) return;
    note = "Couldn't confirm the deletion";
    if (a.ok && a.account === account) {
      if (a.status.state === "deleting") {
        await syncOff(w);
        owner.nudge("deleting");
        deleting = { generation, account };
      } else if (a.status.state === "off") {
        await syncOff(w);
        owner.nudge("off");
        note = "There's no synced data to delete";
      } else if ((a.status.generation ?? 0) > generation) note = "Sync was turned on again since; confirm again to delete the current data";
      else note = "Couldn't confirm the deletion: Delete again to send it once more";
    }
    answered(a);
  }

  poll.request();
  return { dispose: () => { poll.close(); unsub(); }, poll, refresh: () => poll.request() };
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
