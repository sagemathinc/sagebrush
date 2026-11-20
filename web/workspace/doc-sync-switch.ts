// The switch for notebooks' contents (sync 2c-3's DocSync on the account connection, web/workspace/doc-sync.ts), on
// DEV since Oct and on PROD since Nov 1 (William's GO: his account first; the server's allowlist decides who).
// It fails closed: on only if ALL of these hold, checked in this order on every page load and never cached:
//   1. this page's origin is exactly one of DOC_SYNC_ORIGINS (DEV's and PROD's own), or, for any other origin, the
//      site's own server states it: its status (below, the same one request) answers, unredirected and from this very
//      origin, with `public_url` equal to this origin byte for byte.  A self-hosted site's server takes public_url only
//      from its deployment's configuration (its canonical SITE_ORIGIN), never from the request, and refuses any other
//      Host; so any origin running a conforming self-host server may opt itself in, and nothing a page, a URL or
//      storage holds can;
//   2. the server says this account may sync: GET /api/sync/v1/status answers 200 with `available: true` (the
//      allowlist: SYNC_ACCOUNTS, on each site its own);
//   3. this page's sync client runs (signed in, sync on for this account).
// Only then does the notebook page (index.html) turn the journal on (durable for this browser's workspace: a storage
// upgrade, not a setting, so the Sync panel's note, DOC_SYNC_NOTE, doesn't speak of it; a page that can't go on with it
// says DOC_SYNC_RELOAD), set DOC_SYNC.on and hand a DocSync to the sync owner (enableDocSync); and a
// board page, once the journal is active, hands one to its own owner, so whichever tab holds the account connection
// carries notebooks (followDocSync).  The allowed origins are a frozen constant; tests pass their own list to these
// functions as an argument, so no page, URL or storage can widen it.

/** The origins notebooks' contents sync on: DEV's and PROD's. */
export const DOC_SYNC_ORIGINS: readonly string[] = Object.freeze(["https://dev.sagebrush.space", "https://sagebrush.space"]);

/** Condition 1: `origin` is one of `allowed` exactly (by default DOC_SYNC_ORIGINS). */
export function docSyncOrigin(origin: string, allowed: readonly string[] = DOC_SYNC_ORIGINS): boolean {
  return typeof origin === "string" && allowed.includes(origin);
}

/** Condition 2: the server lets this account sync (status 200, `available: true`); anything else, false. */
export async function docSyncAvailable(origin: string, fetchFn: typeof fetch): Promise<boolean> {
  try {
    const r = await fetchFn(origin + "/api/sync/v1/status", { credentials: "same-origin" });
    if (r.status !== 200) return false;
    const j = (await r.json()) as { available?: unknown } | null;
    return !!j && j.available === true;
  } catch {
    return false;
  }
}

/** Conditions 1 and 2 for an origin not in DOC_SYNC_ORIGINS (a self-hosted site), from one status request to this
 * origin itself: its answer must not be a redirect (a manual redirect is refused, and the final URL must be of this
 * origin exactly; an empty or unparsable one is refused), must be 200 JSON, and must say `available: true` and
 * `public_url` equal to `origin` byte for byte (no case, slash, scheme or port folding).  Anything else, false. */
export async function docSyncSelfHosted(origin: string, fetchFn: typeof fetch): Promise<boolean> {
  return (await selfHostedAnswer(origin, fetchFn)) === "yes";
}
/** The same one request, its answer in three: "yes" (every condition above); "no" (the status answered, unredirected,
 * from this very origin, as a JSON object whose public_url is missing or another origin's: the deployment's own
 * configuration, so it doesn't change from one request to the next); "unknown" (anything else: a failure, a redirect,
 * another status, another origin, no JSON, or this origin's public_url with `available` not true, which can change: a
 * plan service unreachable, an allowlist or a plan changed).  docSyncSelfHosted is its "yes": it fails closed. */
export async function selfHostedAnswer(origin: string, fetchFn: typeof fetch): Promise<"yes" | "no" | "unknown"> {
  try {
    const r = await fetchFn(origin + "/api/sync/v1/status", { credentials: "same-origin", redirect: "manual" });
    if (r.redirected || r.type === "opaqueredirect" || r.status !== 200) return "unknown";
    let at: string;
    try { at = new URL(r.url).origin; } catch { return "unknown"; }
    if (at !== origin) return "unknown";
    const j = (await r.json()) as { available?: unknown; public_url?: unknown } | null;
    if (!j || typeof j !== "object") return "unknown";
    if (typeof j.public_url !== "string" || j.public_url !== origin) return "no";
    return j.available === true ? "yes" : "unknown";
  } catch {
    return "unknown";
  }
}

/** The gate: conditions 1, 2 and 3 in order; false at the first that fails (and nothing after it asked). */
export async function docSyncAllowed(
  o: { origin: string; fetch: typeof fetch; clientRunning: () => Promise<boolean> },
  allowed: readonly string[] = DOC_SYNC_ORIGINS,
): Promise<boolean> {
  if (typeof o.origin !== "string" || !o.origin || o.origin === "null") return false;
  if (docSyncOrigin(o.origin, allowed)) {
    if (!(await docSyncAvailable(o.origin, o.fetch))) return false;
  } else if (!(await docSyncSelfHosted(o.origin, o.fetch))) return false;
  try {
    return (await o.clientRunning()) === true;
  } catch {
    return false;
  }
}

/** The gate asked again after a load where it failed (signed out, the sync client not yet running, the status not yet
 * saying so): resolves true once `allowed()` (the full gate) says so.  Asked when `onChange` reports a change of the
 * page's own sync, and once right after subscribing (a change during the load's own ask is not lost); nothing polls, so
 * a change on the server alone is seen at the page's next sync change.  Each ask first checks
 * `running()` (this page's client, no wait, no request): while it doesn't run, nothing is requested, and the next change
 * asks again.  Requests at most every `gapMs`, one at a time; a change while one is out is kept and asked after it. */
export function untilAllowed(o: {
  onChange(f: () => void): () => void;
  running(): boolean | Promise<boolean>;
  allowed(): Promise<boolean>;
  gapMs?: number;
  now?: () => number;
  setTimer?: (f: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}): Promise<boolean> {
  const gap = o.gapMs ?? 10_000, now = o.now ?? Date.now;
  const set = o.setTimer ?? ((f: () => void, ms: number) => setTimeout(f, ms)), clear = o.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));
  return new Promise((done) => {
    let asking = false, again = false, over = false, last = -Infinity, timer: unknown = null;
    const ask = async (): Promise<void> => {
      if (over) return;
      if (asking) { again = true; return; }
      asking = true;
      again = false;
      let ok = false;
      try {
        if (!(await o.running())) return;
        const wait = gap - (now() - last);
        if (wait > 0) {
          timer ??= set(() => { timer = null; void ask(); }, wait);
          return;
        }
        last = now();
        ok = (await o.allowed()) === true;
      } catch {
        ok = false;
      } finally {
        asking = false;
      }
      if (ok) {
        over = true;
        off();
        if (timer !== null) clear(timer);
        done(true);
      } else if (again) void ask();
    };
    const off = o.onChange(() => void ask());
    void ask();
  });
}

/** What the Sync panel says of notebooks while the switch is on (DEV and PROD), each sentence as the code does it
 * (William's M9, Nov 3; the facts, with file:line, in the PR): the account's own devices and Sagebrush's server, never
 * peer-to-peer or another account; no outputs on any synced path (journal.js versionedOf, sync-outbox.ts wireOf,
 * gitpush/rules.ts stripOutputs); concurrent edits merged (history.js, db-merge3.ts); a later device pulls the history
 * from its start (doc-sync.ts pull); no clear sent (journal/core.js NO_CLEAR_SYNCED); what stops a notebook
 * (doc-sync.ts refused, its 1 MiB bound); boards' contents not synced (board/journal.ts sync.on false). */
export const DOC_SYNC_NOTE = [
  "Your notebooks sync between your own browsers and devices, through Sagebrush's server, signed in with your account. Not peer-to-peer, and not shared with other people.",
  "Only cells' code and text sync. Outputs never leave this browser: not to the server, not into TimeTravel, not in a push to GitHub.",
  "If the same cell is edited on two devices before they sync, the edits are merged, as in CoCalc. Both are kept.",
  "TimeTravel shows every version since the notebook first synced, on every device, including ones added later.",
  "Clearing TimeTravel isn't available yet for a synced notebook.",
  "If a notebook can't sync (the server refuses its changes, or a change is too large), the Sync panel says so, and its changes stay in this browser.",
  "Boards don't sync yet. A board made on another device is listed here, but can't be opened until boards sync.",
] as const;

/** The Turn on sync confirmation's sentence on notebooks and boards (sync-panel.ts enable), said before sync is on:
 * where notebooks' contents sync (docSyncOrigin, or a self-hosted site docSyncSelfHosted admits), their code and text
 * do (doc-sync.ts) and their outputs don't; anywhere else only files sync (index.html's sync owner runs on every
 * origin).  Boards' contents don't sync yet anywhere (board/journal.ts sync.on false). */
export const SYNC_CONFIRM_DOCS = "Your notebooks' code and text sync too, but not their outputs. Boards are listed; their contents don't sync yet.";
export const SYNC_CONFIRM_FILES_ONLY = "Your notebooks and boards are listed; their contents don't sync on this site.";
export const SYNC_CONFIRM_MAYBE = "Your notebooks' code and text may also sync, depending on this site's server; their outputs never do. Boards are listed; their contents don't sync yet.";
/** How long syncConfirmDocs waits for a site's status. */
export const SYNC_CONFIRM_MS = 4000;
/** Which this origin is told: DEV's and PROD's own, notebooks' contents sync, with no request; another, its status
 * asked within SYNC_CONFIRM_MS: they sync if it says so, files only if it says not, and if it can't be told (a failure,
 * no answer by then), that they may: notebook sync asks again later, and may then begin. */
export async function syncConfirmDocs(origin: string, fetchFn: typeof fetch, allowed: readonly string[] = DOC_SYNC_ORIGINS, ms = SYNC_CONFIRM_MS): Promise<string> {
  if (docSyncOrigin(origin, allowed)) return SYNC_CONFIRM_DOCS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"unknown">((r) => { timer = setTimeout(() => r("unknown"), ms); });
  const timed: typeof fetch = (u, init) => fetchFn(u, { ...init, signal: AbortSignal.timeout(ms) });
  try {
    const a = await Promise.race([selfHostedAnswer(origin, timed), late]);
    return a === "yes" ? SYNC_CONFIRM_DOCS : a === "no" ? SYNC_CONFIRM_FILES_ONLY : SYNC_CONFIRM_MAYBE;
  } finally { clearTimeout(timer); }
}

/** Said on the notebook page when the journal's activation began (it can't go back) but this page couldn't go on with
 * it: the notebook stays read-only here until a reload, which opens it through the journal. */
export const DOC_SYNC_RELOAD = "Notebook sync was turned on for this browser, but this page couldn't switch to it: reload this page to edit the notebook.";

/** The channel the pages of one workspace use for document sync (a notebook saved here; the switch on here). */
export const docSyncChannel = (wsName: string) => "sagebrush-docsync:" + wsName;
type Channel = { postMessage(m: unknown): void; onmessage: ((ev: { data: unknown }) => void) | null };
type Docs = { kick(id: string, startHere?: boolean): void; kickStarted?(): Promise<void>; stopped?: ReadonlyMap<string, { code: string }> };
// (a message on the channel: a notebook saved in some tab (`kick`), one a page asks to have pulled and started here (`pull`:
// a notebook listed by sync whose history this device hasn't yet), or the switch turned on in some tab (`on`))
const kickOf = (data: unknown) => { const k = (data as { kick?: unknown } | null)?.kick; return typeof k === "string" ? k : null; };
const onOf = (data: unknown) => (data as { on?: unknown } | null)?.on === true;
const pullOf = (data: unknown) => { const p = (data as { pull?: unknown } | null)?.pull; return typeof p === "string" ? p : null; };

/** What turning the switch on needs from the notebook page (index.html), each a seam the tests replace. */
export interface EnableDeps {
  /** the history bundle (sagebrush-history.js): its DOC_SYNC */
  loadHistory(): Promise<{ DOC_SYNC: { on: boolean; saved: ((id: string) => void) | null; pull?: ((id: string) => void) | null; stoppedOf?: ((id: string) => { code: string } | null) | null } }>;
  /** a DocSync, and the workspace's channel (docSyncChannel; null where there is none) */
  makeDocs(): Docs;
  makeChannel(): Channel | null;
  /** the journal's writers registered (both kinds: activation needs them) */
  register(kind: "notebooks" | "boards"): void;
  /** the notebook owned by the switch until it is done (it waits while the page recreates a session, which then
   * waits for the switch): resolves the release */
  own(): Promise<() => void>;
  /** the open notebook read-only, or not; what holds for it now (no store attached, another tab writing it, a
   * quarantined workspace, a session being recreated: read-only) */
  setReadOnly(ro: boolean): void;
  readOnlyNow(): boolean;
  /** the open notebook's pending saves written */
  flush(): void;
  saved(): Promise<unknown>;
  /** the journal turned on, durably (api.ts activateJournal); whether its activation has begun (or is done) */
  activate(): Promise<boolean>;
  begun(): Promise<boolean>;
  /** the open notebook opened again through the journal, its old store and any failed new one let go: whether it is
   * (true when there is none to reopen) */
  reopen(): Promise<boolean>;
  /** document sync on the sync owner's connection (SyncOwner.setDocs) */
  setDocs(docs: Docs): void;
  /** DOC_SYNC_RELOAD said (the page's bar) */
  needReload(): void;
  warn(...a: unknown[]): void;
}
/** How the switch ended on a page: `on`; `off`, nothing lasting changed; `reload`, the journal's activation began (it
 * can't go back) but this page couldn't go on: DOC_SYNC off and no DocSync here, the notebook read-only, said. */
export type Enabled = "on" | "off" | "reload";

/**
 * The switch turned on in the notebook page, once the gate allowed (astra's DEVSW-2, daybreak3's review of #266):
 *   1. what can fail and changes nothing (the history bundle, the DocSync, the channel): a failure, `off`;
 *   2. the notebook owned (after a session's recreation, astra's DEVSW-2-R2), read-only, its saves written (a failure,
 *      `off`); then the journal's activation, the one lasting step:
 *      refused or failed, `off` if it never began, else `reload`;
 *   3. DOC_SYNC on (the reopened notebook's load starts its synced history from it), the notebook reopened through the
 *      journal: a failure, DOC_SYNC off again and `reload`;
 *   4. only then the hooks, the channel's listener and the owner's DocSync, and the other tabs told (`on`).
 * The notebook's read-only is set back in a `finally` on every return and throw, from what holds then (never editable
 * with no store attached), and kept on for `reload`; only then is the notebook released.  A throw anywhere after activation was asked is `reload` if it
 * began (asked again, and if that can't be told, assumed).
 */
export async function enableDocSync(d: EnableDeps): Promise<Enabled> {
  let mod!: Awaited<ReturnType<EnableDeps["loadHistory"]>>, docs!: Docs, ch: Channel | null = null;
  try {
    mod = await d.loadHistory();
    docs = d.makeDocs();
    ch = d.makeChannel();
  } catch (e) {
    d.warn("sync: notebooks' switch not ready:", e);
    return "off";
  }
  let out: Enabled = "off", asked = false, release: (() => void) | null = null;
  try {
    d.register("notebooks");
    d.register("boards");
    release = await d.own();
    d.setReadOnly(true);
    d.flush();
    await d.saved();
    asked = true;
    if (!(await d.activate())) return (out = (await d.begun().catch(() => true)) ? "reload" : "off");
    mod.DOC_SYNC.on = true;
    if (!(await d.reopen())) {
      mod.DOC_SYNC.on = false;
      return (out = "reload");
    }
    mod.DOC_SYNC.saved = (id) => { docs.kick(id); try { ch?.postMessage({ kick: id }); } catch {} };
    // (a notebook listed here by sync with none of its history yet (the page's openArrived): pulled and started on
    // whichever page holds the connection; a pull of one the server doesn't have yet does nothing (unknown_doc))
    mod.DOC_SYNC.pull = (id) => { docs.kick(id, true); try { ch?.postMessage({ pull: id }); } catch {} };
    // (a notebook this page's DocSync stopped (a snapshot start, a chain, an invalid answer): never "still arriving")
    mod.DOC_SYNC.stoppedOf = (id) => docs.stopped?.get(id) ?? null;
    // (another tab's save kicks this DocSync; another tab's switch turned on kicks every notebook started (its reopened
    // notebook's start was told to no one), whichever tab's connection this is)
    if (ch) ch.onmessage = (ev) => {
      const k = kickOf(ev.data), p = pullOf(ev.data);
      if (k !== null) docs.kick(k);
      else if (p !== null) docs.kick(p, true);
      else if (onOf(ev.data)) void docs.kickStarted?.()?.catch((e) => d.warn("sync: notebooks' switch:", e));
    };
    d.setDocs(docs);
    try { ch?.postMessage({ on: true }); } catch {}
    return (out = "on");
  } catch (e) {
    d.warn("sync: notebooks' switch:", e);
    if (asked && (await d.begun().catch(() => true))) {
      mod.DOC_SYNC.on = false;
      mod.DOC_SYNC.saved = null;
      mod.DOC_SYNC.pull = null;
      mod.DOC_SYNC.stoppedOf = null;
      out = "reload";
    }
    return out;
  } finally {
    // (only by the switch that owns the notebook; released after it, whatever happens)
    if (release) {
      try {
        d.setReadOnly(out === "reload" || d.readOnlyNow());
        if (out === "reload") d.needReload();
      } finally {
        release();
      }
    }
  }
}

/** What a page that isn't the notebook page (a board) needs to carry notebooks' contents while it holds the
 * account connection (astra's DEVSW-1). */
export interface FollowDeps<D extends Docs = Docs> {
  makeDocs(): D;
  makeChannel(): Channel | null;
  /** whether this device's journal is active (api.ts journalActive) */
  journalActive(): Promise<boolean>;
  /** document sync on this page's sync owner's connection (SyncOwner.setDocs) */
  setDocs(docs: D): void;
  warn(...a: unknown[]): void;
}
/**
 * Notebooks' contents on another page's connection, once the gate allowed there (astra's DEVSW-1): the namespace's
 * one connection is whichever tab holds its lock, a board's too, and a notebook page waiting for it would otherwise
 * never send or receive.  The board's owner gets a DocSync once this device's journal is active (now, or when a
 * notebook page says it turned the switch on); notebook saves told on the channel kick it, and a notebook page's `on`
 * kicks every notebook started, the one the switch just reopened among them.  Nothing of boards' own
 * contents: DocSync carries only the notebooks whose synced history started.  Resolves how to stop listening.
 */
export async function followDocSync<D extends Docs>(d: FollowDeps<D>): Promise<() => void> {
  const ch = d.makeChannel();
  let docs: D | null = null, joining: Promise<void> | null = null;
  const join = () =>
    (joining ??= (async () => {
      if (docs || !(await d.journalActive())) return;
      const made = d.makeDocs();
      d.setDocs(made);
      docs = made;
    })()
      .catch((e) => d.warn("sync: notebooks on this page's connection:", e))
      .finally(() => { joining = null; }));
  if (ch) ch.onmessage = (ev) => {
    const k = kickOf(ev.data), p = pullOf(ev.data);
    if (k !== null) docs?.kick(k);
    else if (p !== null) docs?.kick(p, true);
    // (the switch turned on in another page: this page's DocSync joins, or, if it already has, sends what started
    // there since it connected: that notebook's synced history began in the reopen, before any save was told to it)
    else if (onOf(ev.data)) void join().then(() => docs?.kickStarted?.()).catch((e) => d.warn("sync: notebooks on this page's connection:", e));
  };
  await join();
  return () => { if (ch) ch.onmessage = null; };
}
