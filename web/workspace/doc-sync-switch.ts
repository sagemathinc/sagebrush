// The switch for notebooks' contents (sync 2c-3's DocSync on the account connection, web/workspace/doc-sync.ts), on
// DEV since Oct and on PROD since Nov 1 (William's GO: his account first; the server's allowlist decides who).
// It fails closed: on only if ALL of these hold, checked in this order on every page load and never cached:
//   1. this page's origin is exactly one of DOC_SYNC_ORIGINS (DEV's and PROD's own, nothing else: nothing at all is
//      asked or started on any other origin);
//   2. the server says this account may sync: GET /api/sync/v1/status answers 200 with `available: true` (the
//      allowlist: SYNC_ACCOUNTS, on each site its own);
//   3. this page's sync client runs (signed in, sync on for this account).
// Only then does the notebook page (index.html) turn the journal on (durable for this browser's workspace: the Sync
// panel's note, DOC_SYNC_NOTE, says so), set DOC_SYNC.on and hand a DocSync to the sync owner (enableDocSync); and a
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

/** The gate: conditions 1, 2 and 3 in order; false at the first that fails (and nothing after it asked). */
export async function docSyncAllowed(
  o: { origin: string; fetch: typeof fetch; clientRunning: () => Promise<boolean> },
  allowed: readonly string[] = DOC_SYNC_ORIGINS,
): Promise<boolean> {
  if (!docSyncOrigin(o.origin, allowed)) return false;
  if (!(await docSyncAvailable(o.origin, o.fetch))) return false;
  try {
    return (await o.clientRunning()) === true;
  } catch {
    return false;
  }
}

/** What the Sync panel says of notebooks while the switch is on (DEV, until 2c-4 and the PROD gate). */
export const DOC_SYNC_NOTE = [
  "Notebooks sync between your devices here. Outputs are never synced.",
  "If the same cell is changed on two devices before they sync, the later change is kept; the other is in TimeTravel.",
  "TimeTravel shows a notebook's versions since it started syncing on this device.",
  "Clearing TimeTravel isn't available for a synced notebook.",
  "A notebook stops syncing on a device if the server restarts its history (a snapshot or a cleared history) or refuses its changes for good; its changes stay on that device.",
  "Boards don't sync yet: they save in this browser as before.",
  "Turning this on is lasting for this browser: it keeps saving notebooks through sync's journal even if notebook sync is later turned off, and an older copy of this site open in another tab can't save notebooks until it's reloaded. dev.sagebrush.space and sagebrush.space are separate sites, each with its own storage and its own sync; neither affects the other.",
] as const;

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
