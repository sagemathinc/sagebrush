// A notebook artifact: a workspace .ipynb file shown and run in the artifact pane with the notebook component
// (/sagebrush-notebook.js, loaded on first use; its kernel worker, /sagebrush-worker.js, only on the first Run).
// The artifacts plan (r2 + r2.1): only the person's Run runs code (the component is created non-reactive, the host
// never calls applyEdits); the store is the notebook page's own IdbStore, bound to the document's ref, so a save
// can never reach another document at the same path; under sync's journal, the page's own journal store, with its
// writer lock: the pane writes while it holds it, else follows the tab that does, as another tab of the page would
// (web/page/handover.ts), and an agent's edit asks for it; remote pictures wait for a click whatever the document says.
import { writerHandover } from "../page/handover";
import type { Workspace } from "../workspace/api";
import { canonical, cellForm, preflight, type NotebookEdit } from "../workspace/notebook-edit";
import type { Kept, PageRun } from "../workspace/run-verbs";

// (stores.js's FENCE, the workspace's record in the notebooks store; test-agents-artifacts checks they're equal)
export const FENCE = "__sagebrush-workspace__";
// (the site's root: this page is /agents/agents.js; built as a URL so the bundler leaves the import to the browser)
const SITE = new URL("../", import.meta.url);

export type NotebookUi = {
  /** The pane's saved indicator. */
  saved(text: string): void;
  /** A bar over the notebook (null: none): its text, its kind, and buttons. */
  bar(b: { kind: "conflict" | "refused" | "readonly" | "gone"; text: string; actions?: { label: string; run: () => void }[] } | null): void;
  /** The paired agent's name, for the written-by label. */
  agentName(): string;
  /** A cell started or stopped running (the tab's running mark). */
  running(on: boolean): void;
  /** Said after the notebook closed (its last changes kept as a copy). */
  notice(text: string): void;
};

export type NotebookHost = {
  el: HTMLElement;
  /** Settles when the notebook is shown, or its mount stopped (disposed, or refused: said in its bar). */
  ready: Promise<void>;
  /** Saves made and kept (or an error). */
  flush(): Promise<void>;
  /** Closing (ART-C2 r3): what was edited is saved (CLOSE_SAVE_MS at most), then nothing more is written from here; if
   * the latest content isn't in the store (not saved, refused, let go), it is kept as a copy first. True: closed;
   * false: neither saved nor kept, so the notebook stays, with its bar saying so (the only copy is never dropped). */
  release(): Promise<{ ok: true } | { ok: false; why: string }>;
  /** Closed without keeping anything: detached, stopped, its kernel ended; nothing it started writes afterwards. */
  dispose(): Promise<void>;
  /** After a failed close: the content it kept frozen, as a file to download (.ipynb), or null. */
  download(): { name: string; text: string; type: string } | null;
  isRunning(): boolean;
  /** An agent's edit by cell (A12 step 1): checked whole against what's shown, then applied, then saved once; or
   * refused with nothing changed.  Resolves once the change is saved (or says why not). */
  /** `hold` (a notebook in /Branches: the branches' rule, chat plan PR 3): asked after every wait, right before the
   * synchronous apply, holding the workspace's lock until it is released after the apply; it rejects to refuse. */
  edit(e: NotebookEdit, may: () => boolean, hold?: () => Promise<() => void>): Promise<EditResult>;
  hidden(on: boolean): void;
  interrupt(): void;
  /** A notebook the agent created, run once by itself (workspace/agent-made.ts), admitted in one turn: its Run all, as
   * the person's Run here, if this pane is bound to `ref` and may run it now (attached, saving here, not closing; under
   * sync's journal, the writer) and `ok` holds for what it shows. True if it ran. */
  runCreated(ref: string, ok: (doc: any) => boolean): boolean;
  /** An agent's run_notebook in this notebook (run-verbs.ts's PageRun, as the notebook page's agentPageRun): its cells
   * run here cell by cell as the person's Run is, their outputs shown and saved with it, while this pane is bound to
   * `ref` and may save it (attached, not closing, the writer under sync's journal). Its inputs wait for the mount;
   * `gone` is called if the pane lets the notebook go (closed, disposed) while the run holds it. */
  pageRun(ref: string, path: string, gone: () => void, may: () => boolean): PageRun;
  /** Whether an agent's run of `ref` could run here now (pageRun's own condition), decided synchronously: null while the
   * notebook is still being mounted (not known yet). */
  canRun(ref: string): boolean | null;
  copyText(): string;
};

type Nb = any; // (the component is plain JS: its API is web/notebook/README.md's)
export type EditResult = { ok: true; inserted: string[]; rev?: number } | { ok: false; code: "conflict" | "invalid" | "busy"; why: string; ids?: string[] };

/** The cells the agent wrote, by id: their source when it wrote them (a label shows while a cell still has it and hasn't run). */
export type AgentCells = Map<string, string>;

type Fence = { workspace?: string; generation?: number; phase?: string; quarantined?: boolean } | undefined;

/** The workspace's fence record (the notebook page's storeFor and the stores read the same one). */
export async function fenceOf(db: IDBDatabase): Promise<Fence> {
  return new Promise((resolve) => {
    try {
      const r = db.transaction("notebooks", "readonly").objectStore("notebooks").get(FENCE);
      r.onsuccess = () => resolve(r.result ?? undefined);
      r.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

/** Whether the fence moved since `seen` in a way the stores refuse (stores.js fenceRefusal): for a writer that
 * mounted under "ok", or under sync's "journal", any other phase, or a change of phase. */
export function fenceMoved(f: Fence, seen: Fence): boolean {
  if (!f) return !!seen;
  const phase = f.phase ?? "ok";
  if (f.quarantined || (phase !== "ok" && phase !== "journal") || phase !== (seen?.phase ?? "ok")) return true;
  return !!seen && (f.workspace !== seen.workspace || f.generation !== seen.generation);
}

/** The interpreter, started on the first Run, not before: its worker is made when the component first asks it to
 * execute (the code was taken from the cell at the person's click, before this). Until then nothing else starts it
 * (a completion waits for the first Run). */
function lazyKernel(mod: any, closing: () => boolean = () => false) {
  const k = new mod.WorkerKernel({ createWorker: () => new Worker(new URL("sagebrush-worker.js", SITE), { type: "module" }) });
  const execute = k.execute.bind(k);
  k.execute = (code: string, o: unknown, sink: any) => {
    // (a notebook closing runs nothing, by whatever path a Run came: ART-C2b r4)
    if (closing()) return sink?.stopped?.("\nNot run: this notebook is closing.\n");
    if (!k.worker) k.start();
    return execute(code, o, sink);
  };
  return k;
}

/** A host's state while it closes: "open" (nothing stopped), "closing" (every gesture stopped: the content kept is the
 * content shown, ART-C2b), "kept" (a close that couldn't save or keep it: readable, selectable and copyable by hand,
 * nothing that would change or run it, BAC-8). */
export type Guard = "open" | "closing" | "kept";
const MUTATING_INPUT = new Set(["beforeinput", "input", "paste", "drop", "cut", "keypress"]);
const KEPT_KEYS = new Set(["Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);
/** Whether `e` may go on in `state` (a gesture inside a host's content). */
export function gestureAllowed(e: Event, state: Guard): boolean {
  if (state === "open") return true;
  if (state === "closing") return false;
  if (MUTATING_INPUT.has(e.type)) return false;
  if (e.type === "click" || e.type === "dblclick") return !(e.target instanceof Element && e.target.closest("button, select, input, [role=menuitem]"));
  if (e.type === "keydown") {
    // (an allowlist, not a blocklist (ART-r5, @sagebrush's ruling): reading and copying keys only; any other key, a
    // shortcut of today's or of a future editor's, is stopped)
    const k = e as KeyboardEvent;
    if (k.key === "Control" || k.key === "Meta" || k.key === "Shift") return true; // (a chord's first key)
    if (k.ctrlKey || k.metaKey) return !k.altKey && (k.key === "c" || k.key === "C" || k.key === "a" || k.key === "A"); // (copy, select all)
    if (k.altKey) return false;
    return KEPT_KEYS.has(k.key); // (Tab, Shift+Tab, Escape; arrows, Home, End, PageUp/Down, with Shift or not)
  }
  return true; // (mousedown and the rest: selecting)
}
/** Gestures inside `root` stopped (capture phase, before the content's own handlers) as `state()` says. */
export function guardGestures(root: HTMLElement, state: () => Guard) {
  for (const type of ["click", "dblclick", "mousedown", "keydown", "keypress", "beforeinput", "input", "paste", "drop", "cut"])
    root.addEventListener(type, (e) => {
      if (gestureAllowed(e, state())) return;
      e.stopImmediatePropagation();
      e.preventDefault();
    }, true);
}

/** How long closing waits for a pending save before it keeps the notebook's content as a copy instead. */
export const CLOSE_SAVE_MS = 3000;
/** How long closing waits for that copy (the workspace busy) before it gives up and keeps the notebook open. */
export const CLOSE_COPY_MS = 5000;
/** How long an agent's edit waits for another tab of this browser to hand the notebook over (sync's journal). */
export const TAKE_MS = 10_000;

// What the store keeps beside a notebook's content, for itself (ART-C2a r4): left out when "is this what the store
// has" is asked, and when content is kept as a copy. Everything else is the content: the mode, the document's
// metadata (seed, autorun, ...) and each cell whole (its metadata, attachments, outputs, counts and times).
const BOOKKEEPING = ["id", "rev", "updated", "baseRev", "name", "j", "hash", "unjournaled"];
const contentOf = (doc: any) => Object.fromEntries(Object.entries(doc ?? {}).filter(([k]) => !BOOKKEEPING.includes(k)));
// (a stable form to compare: keys sorted at every depth, so the store's key order and the snapshot's don't matter)
const stable = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(stable).join(",")}]`
    : v && typeof v === "object"
      ? `{${Object.keys(v).filter((k) => (v as any)[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stable((v as any)[k])}`).join(",")}}`
      : JSON.stringify(v ?? null);
const sameContent = (a: any, b: any) => stable(contentOf(a)) === stable(contentOf(b));

/**
 * A notebook artifact, mounted into `box`. The handle is returned at once and owns everything the mount makes, so it
 * can be disposed at any point, even while the mount is still reading or loading (ART-C2); `ready` settles when the
 * notebook is shown (or the mount stopped).
 */
export function mountNotebook(ws: Workspace, path: string, box: HTMLElement, ui: NotebookUi, agentCellsOf: Promise<AgentCells | null>): NotebookHost {
  const el = document.createElement("div");
  el.className = "nb-artifact";
  box.append(el);
  const notice = document.createElement("div");
  notice.className = "nb-notice";
  notice.textContent =
    "Runs here when you click Run, with this browser workspace's full notebook access: the code can read and change any file in your workspace, not only the folders you gave the agent. An agent allowed to read this folder can read the outputs.";
  const nbRoot = document.createElement("div");
  nbRoot.className = "nb-root";
  el.append(notice, nbRoot);

  let alive = true; // (false once disposed: every continuation of the mount stops at its next check)
  let bound = false; // (true while the pane may save this document: set at attach, false at let-go and dispose)
  let attached = false;
  let nb: Nb = null;
  let kernel: any = null;
  let running = 0;
  let check: () => Promise<void> = async () => {}; // (the path, ref and fence checked again: set once attached)
  let keepCopy: ((doc: any, signal?: AbortSignal) => Promise<string>) | null = null;
  let releasing: Promise<{ ok: true } | { ok: false; why: string }> | null = null; // (one release at a time)
  let frozen = false; // (closing, or a close that couldn't keep the content: no edit, no Run, ever again here)
  let guard: Guard = "open";
  let kept: any = null; // (the content a failed close kept frozen, for Download a copy)
  let toIpynb: ((doc: any) => string) | null = null;
  // (gestures inside the notebook stopped at its root, before any cell's own handler, as the guard says: inert alone
  // doesn't stop a script's click() in every browser)
  guardGestures(nbRoot, () => guard);
  let stored: (() => Promise<any>) | null = null; // (the record the store has now, read beside the page's writes)
  // (under sync's journal: the journal's store, the focus takeover with the page's other tabs, the page's controls for
  // the store, and whether the takeover's reload is under way)
  let jstore: any = null, handover: ReturnType<typeof writerHandover> | null = null, takingOver = false;
  let controlsOf: (st: any) => { readOnly: boolean; bar: string | null } = () => ({ readOnly: false, bar: null });
  let docRef: string | null = null; // (the document this pane is bound to, once attached and editable: an agent's edit must name it)
  // (under sync's journal, this pane still the notebook's writer: the lock held, its load done, no hand-over begun
  // (yieldLock's `yielding`, set as the hand-over starts), not let go, and no takeover's reload under way; without the
  // journal, always. One test for an agent's edit and for an agent's notebook's run by itself)
  const owns = (comp: Nb) => !jstore || (!!jstore.writer && !!jstore.ready && !jstore.yielding && !jstore.released && !takingOver && comp.store === jstore);
  // (observed from the start, so a move, Trash or replacement while the mount reads and loads isn't missed: before
  // attach it is caught by the check after it, ART-C2)
  const unwatch = ws.watch(() => void check());
  // (an agent's runs in this notebook (pageRun), told when the pane lets it go)
  const pageRuns = new Set<() => void>();
  const endRuns = () => { for (const g of [...pageRuns]) g(); pageRuns.clear(); };
  const watchRunning = new MutationObserver(() => {
    const n = nbRoot.querySelectorAll(".cell.running, .cell.queued").length;
    if ((n > 0) !== (running > 0)) ui.running(n > 0);
    running = n;
  });
  watchRunning.observe(nbRoot, { subtree: true, attributes: true, attributeFilter: ["class"] });

  const host: NotebookHost = {
    el,
    ready: Promise.resolve(),
    async flush() {
      if (!nb || !bound || !attached) return;
      nb.flush(); // (its pending save goes out now, the notebook still attached)
      await nb.saved(); // (and is made, or said why not)
    },
    release() {
      // (one at a time: a Close, a thread switch and a Try again share the one under way)
      releasing ??= doRelease().finally(() => (releasing = null));
      return releasing;
    },
    async dispose() {
      if (!alive) return;
      unwatch();
      endRuns();
      watchRunning.disconnect();
      const comp = nb;
      alive = false;
      bound = false;
      if (comp) {
        comp.detach();
        comp.destroy();
      }
      // (the journal's writer lock and its place in the lock's queue let go: another tab can write the notebook; the
      // takeover's channel, timers and listeners removed)
      void jstore?.release();
      handover?.dispose();
      handover = null;
      // (destroy leaves the page's one plot tooltip, shared by every notebook here: hidden, not removed)
      for (const t of document.querySelectorAll<HTMLElement>(".sbnb-tip")) t.hidden = true;
      kernel?.close();
      kernel = null;
      nb = null;
      el.remove();
    },
    download: () => (kept && toIpynb ? { name: `${path.split("/").pop()!.replace(/\.ipynb$/i, "")} (copy).ipynb`, text: toIpynb(kept), type: "application/x-ipynb+json" } : null),
    isRunning: () => running > 0,
    hidden(on) {
      el.hidden = on;
      // (the notebook's popups belong to the document body: a hidden notebook's are closed)
      if (on) for (const p of document.querySelectorAll<HTMLElement>(".sbnb-pop:not(dialog)")) p.hidden = true;
      else nb?.resize();
    },
    interrupt: () => nb?.interrupt(),
    runCreated(ref, ok) {
      const comp = nb;
      if (!alive || !comp || !attached || !bound || frozen || guard !== "open" || docRef !== ref || !owns(comp)) return false;
      if (!ok(comp.snapshot())) return false;
      comp.runAll();
      return true;
    },
    async edit(e, may, hold) {
      // (the agent's authority: the same grant, in force, and the turn the edit came from still the chat's running
      // one; checked once, after the last wait and right before the change, so a loss at any wait reaches it; C1)
      const no = { ok: false as const, code: "busy" as const, why: "the grant or the turn changed while this edit waited: nothing changed" };
      await host.ready;
      const comp = nb;
      // (today's guards: only a pane that may save this document takes an edit, never one closing or let go)
      if (!alive || !comp || !attached || !bound || frozen || guard !== "open" || docRef === null || !stored) return { ok: false, code: "busy", why: "this notebook is closing, or isn't saved here now" };
      if (e.ref !== docRef) return { ok: false, code: "conflict", why: "another notebook is at this path now (read it again)" };
      // (under sync's journal, a pane that follows another tab: the edit is a use of the pane, which asks that tab for the
      // writer lock and waits for it, the takeover's reload included; within TAKE_MS, else refused, nothing changed)
      if (jstore && !(await writable())) {
        return { ok: false, code: "busy", why: "another tab of this browser is changing this notebook and didn't hand it over: nothing changed (try again)" };
      }
      const lost = { ok: false as const, code: "busy" as const, why: "another tab of this browser took this notebook over while the edit waited: nothing changed (try again)" };
      const usable = () => alive && nb === comp && attached && bound && !frozen && guard === "open" && docRef === e.ref && owns(comp);
      const closing = () => (jstore && alive && nb === comp && attached && bound && !frozen && guard === "open" && docRef === e.ref && !owns(comp) ? lost : { ok: false as const, code: "busy" as const, why: "this notebook is closing, or isn't saved here now" });
      // (tests: a wait held at `stage`, loopback pages only, test-agents-artifacts.mjs)
      const pause = async (stage: string) => {
        const f = (globalThis as any).__sbTestEditPause;
        if (typeof f === "function" && /^(127\.0\.0\.1|localhost)$/.test(location.hostname)) await f(stage);
      };
      // (the store's record, in the notebook's form, equals what is shown: a save the store refused ("not saved: ...")
      // still resolves saved(), so it is checked here, positively; astra's C2)
      const keptAsShown = (rec: any) => !!rec && Array.isArray(rec.cells) && canonical(rec.cells.map(cellForm)) === canonical(comp.snapshot().cells.map(cellForm));
      // (1) what the person typed, saved first, and seen to be kept; then the document as stored, the form the agent
      // read it in: each named cell's hash checked against that (three-way: the cells it doesn't name aren't looked at)
      comp.flush();
      try {
        await comp.saved();
      } catch (err) {
        return { ok: false, code: "busy", why: `not applied: this notebook couldn't be saved first (${(err as Error).message})` };
      }
      await pause("saved");
      if (!usable()) return closing();
      const rec0 = await stored().catch(() => null);
      await pause("stored");
      if (!usable()) return closing();
      if (!keptAsShown(rec0)) return { ok: false, code: "busy", why: "not applied: the person's changes here couldn't be saved first (the store refused them); nothing changed" };
      // (the revision this pane's next save is made from: kept for a rollback, so that save still conflicts with another
      // tab's change instead of writing over it; astra's C3)
      const baseRev = rec0.rev;
      const seen = comp.snapshot();
      const read = await ws.read(path).catch(() => null);
      await pause("read");
      if (!usable()) return closing();
      if (!read || (read.entry as any)?.ref !== docRef) return { ok: false, code: "conflict", why: "another notebook is at this path now (read it again)" };
      const checked = preflight(e, (read.content as any)?.cells ?? [], { hashes: true });
      if (!checked.ok) return { ok: false, code: "conflict", why: checked.why, ...(checked.ids ? { ids: checked.ids } : {}) };
      // (the branches' rule, last of the waits: its lock then held through the change below, so no branch moves
      //  between that check and it; released however this ends)
      let release: (() => void) | null = null, inserted: string[] = [];
      if (hold) {
        try { release = await hold(); } catch (err) { return { ok: false, code: "invalid", why: String((err as Error)?.message ?? err) }; }
        await pause("hold");
        if (!usable()) { release(); return closing(); }
      }
      try {
        // (2) then, in one synchronous stretch (no await): the authority, nothing shown changed since that save,
        // the edit fits what is shown, and the change is made; what the person does can't come between the check and it
        if (!may()) return no;
        // (and, in the same synchronous stretch as the change, this pane still the writer: a hand-over begun or the lock
        // lost since the last wait refuses it here, nothing changed)
        if (!usable()) return closing();
        const before = comp.snapshot();
        if (canonical(before) !== canonical(seen)) return { ok: false, code: "conflict", why: "the notebook changed while this edit was checked (read it again)" };
        const pre = preflight(e, before.cells, { hashes: false });
        if (!pre.ok) return { ok: false, code: "conflict", why: pre.why, ...(pre.ids ? { ids: pre.ids } : {}) };
        try {
          const apply = (globalThis as any).__sbTestApplyEdits && /^(127\.0\.0\.1|localhost)$/.test(location.hostname) ? (globalThis as any).__sbTestApplyEdits : null;
          // (run: false: an edit runs nothing; applyEdits mutates synchronously, its promise settles at once)
          const r = apply ? apply(comp, pre.edits) : comp.applyEdits(pre.edits, { run: false });
          // (its save asked for at once, in the same synchronous stretch as the change: a hand-over that begins after it
          // waits for this save (its quiesce awaits the notebook's saves), so the change is saved before this pane lets go)
          comp.flush();
          inserted = (await r)?.ids ?? [];
        } catch (err) {
          // (put back as it was, with the revision it was saved at: loaded, which saves nothing, and the next save is made
          // from that revision, so it conflicts with a change made elsewhere meanwhile rather than writing over it)
          comp.load({ ...before, rev: baseRev });
          return { ok: false, code: "invalid", why: `not applied, nothing changed: ${(err as Error).message}` };
        }
        // (an edit that changed nothing (each set to what it was): answered ok, with nothing to save)
        if (canonical(comp.snapshot()) === canonical(before)) return { ok: true, inserted };
        // (a code cell whose source the agent changed keeps its old output, marked as from before the change until it is
        // run or edited here: this pane's notebook isn't reactive, so the component marks nothing itself)
        for (const c of pre.edits.set) {
          const cell = c.code !== undefined ? comp.cells().find((x: any) => x.id === c.id) : null;
          if (cell && cell.type === "code" && cell.out?.childNodes.length > 0) markCell(cell, `Changed by ${ui.agentName()}: the output below is from before the change`, "nb-edit-mark");
        }
      } finally {
        // (let go before the save below, which takes the workspace's lock too)
        release?.();
      }
      // (one save for the whole edit, awaited, and seen kept: the edit is answered ok only once the store has it)
      comp.flush();
      try {
        await comp.saved();
      } catch (err) {
        return { ok: false, code: "busy", why: `applied here but not saved: ${(err as Error).message}` };
      }
      const rec1 = await stored().catch(() => null);
      if (!keptAsShown(rec1) || !(rec1.rev > baseRev)) return { ok: false, code: "busy", why: "applied here but not saved: the store refused it" };
      return { ok: true, inserted };
    },
    canRun(ref) {
      if (!alive) return false;
      if (!nb || !attached) return docRef === null && guard === "open" && !frozen ? null : false;
      return bound && !frozen && guard === "open" && docRef === ref && owns(nb);
    },
    pageRun(ref, path, gone, may) {
      let comp: Nb = null;
      // (this pane's notebook, the one the run started in, still bound to `ref` and saving here; and the call's chat
      //  and turn still the page's (`may`))
      const here = () => may() && alive && !!comp && nb === comp && attached && bound && !frozen && guard === "open" && docRef === ref && owns(comp);
      let told = false;
      const tell = () => { if (!told) { told = true; pageRuns.delete(tell); gone(); } };
      pageRuns.add(tell);
      const text = (v: unknown) => (Array.isArray(v) ? v.join("") : typeof v === "string" ? v : "");
      const inputsOf = (d: any) => JSON.stringify((d?.cells ?? []).map((c: any) => [String(c.id), c.type ?? "code", String(c.code ?? "")]));
      return {
        // (the notebook as shown, caught up first: the person's edits saved, and the workspace's copy (an agent's write
        //  just made in it) applied here as any change from elsewhere is, so the run is of what both have)
        inputs: async () => {
          await host.ready;
          comp = nb;
          if (!here()) return null;
          comp.flush();
          try { await comp.saved(); } catch {}
          const r = here() ? await ws.read(path).catch(() => null) : null;
          if (!here()) return null;
          const e = r?.entry as any;
          if (r && e?.kind === "notebook" && e.ref === ref && inputsOf(r.content) !== inputsOf(comp.snapshot())) {
            comp.applyRemote({ ...(r.content as any), rev: r.rev });
            await new Promise((go) => setTimeout(go, 0));
          }
          if (!here()) return null;
          const s = comp.snapshot();
          return { mode: typeof s.mode === "string" ? s.mode : "python", cells: s.cells.map((c: any) => ({ id: String(c.id), type: c.type ?? "code", code: String(c.code ?? "") })) };
        },
        current: here,
        cell: async (id: string, out: Kept) => {
          const images = { count: 0, bytes: 0 };
          const c = here() ? comp.cells().find((x: any) => x.id === id && (x.type ?? "code") === "code") : null;
          if (!c) return { status: "stopped" as const, images };
          const ran = await comp.runCells([id], { budget: 0 });
          const r = Array.isArray(ran) ? ran[0] : ran;
          if (!here() || !r) return { status: "stopped" as const, images };
          for (const o of comp.snapshot().cells.find((x: any) => x.id === id)?.outputs ?? []) {
            if (o.output_type === "stream") out.add(text(o.text));
            else if (o.output_type === "error") out.add(text(o.traceback?.join?.("\n")) || `${o.ename}: ${o.evalue}\n`);
            else {
              for (const [k, v] of Object.entries(o.data ?? {})) if (k.startsWith("image/") && typeof v === "string") { images.count++; images.bytes += v.length; }
              const t = text(o.data?.["text/plain"]);
              if (t) out.add(t.endsWith("\n") ? t : t + "\n");
            }
          }
          // (a plain notebook's run says ok or stopped; the reactive scheduler's report, whether it ran, failed or was left
          //  stale (interrupted); either, the cell's own state, as the notebook page reads it)
          const has = (k: string) => Array.isArray(r[k]) && r[k].includes(id);
          const stopped = r.stopped || r.interrupted || has("stale") || has("cancelled") || (Array.isArray(r.ran) && !r.ran.includes(id) && !has("failed"));
          const failed = r.ok === false || has("failed") || c.el.classList.contains("error");
          return { status: stopped ? ("stopped" as const) : failed ? ("error" as const) : ("ok" as const), images };
        },
        // (saved only if the workspace's copy has the shown code cells and their outputs: a save can end in a refusal it
        //  only says)
        save: async () => {
          if (!here()) return false;
          comp.flush();
          try { await comp.saved(); } catch { return false; }
          const r = here() ? await ws.read(path).catch(() => null) : null;
          const outs = (d: any) => JSON.stringify((d?.cells ?? []).filter((c: any) => (c.type ?? "code") === "code").map((c: any) => [c.id, String(c.code ?? ""), c.outputs ?? []]));
          const e = r?.entry as any;
          return here() && e?.kind === "notebook" && e.ref === ref && outs(r!.content) === outs(comp.snapshot());
        },
        stop: () => { if (comp && nb === comp) comp.interrupt(); },
        close: () => { told = true; pageRuns.delete(tell); },
      };
    },
    copyText: () => (nb ? nb.cells().map((c: any) => c.ta.value).join("\n\n") : ""),
  };
  // A label on a cell (the agent wrote it, or changed it since its output): text, for assistive technology too, until the
  // person edits the cell or it runs.
  function markCell(c: any, text: string, cls = "nb-agent-mark") {
    c.el.querySelector(`.${cls}`)?.remove();
    const label = document.createElement("div");
    label.className = `nb-agent-mark ${cls}`;
    label.id = `${cls}-${c.id}`;
    label.textContent = text;
    // (under "Written by", when the cell has it: the two read in the order they happened)
    const written = c.el.querySelector(":scope > .nb-agent-mark:not(.nb-edit-mark)");
    if (written) written.after(label);
    else c.el.prepend(label);
    c.ta.setAttribute("aria-describedby", [c.ta.getAttribute("aria-describedby"), label.id].filter(Boolean).join(" "));
    const clear = () => {
      label.remove();
      c.ta.setAttribute("aria-describedby", (c.ta.getAttribute("aria-describedby") ?? "").split(" ").filter((x: string) => x && x !== label.id).join(" "));
      c.ta.removeEventListener("input", clear);
      ranObserver.disconnect();
    };
    c.ta.addEventListener("input", clear);
    const ranObserver = new MutationObserver(() => c.el.classList.contains("running") && clear());
    ranObserver.observe(c.el, { attributes: true, attributeFilter: ["class"] });
    return clear;
  }

  // Under sync's journal (as the notebook page's showWriter and takeOver, web/page/session.ts): read only while another
  // tab writes the notebook (it follows that tab, quietly, showing every change), and the writer once it is granted
  // the lock, reloaded then (the same component, the same store).
  function showWriter(comp: Nb) {
    if (!jstore || !alive || nb !== comp) return;
    handover ??= writerHandover({
      view: nbRoot,
      quiesce: () => comp.saved(),
      hold: () => comp.setReadOnly(true),
      follow: () => showWriter(comp),
      keyOf: (f) => (f.closest(".cell") as any)?.cell?.id ?? null,
      fieldFor: (k) => comp.cells().find((c: any) => c.id === k)?.ta ?? null,
      hasKey: (k) => comp.cells().some((c: any) => c.id === k),
      notApplied: (n) => ui.bar({ kind: "refused", text: `${n} input action${n === 1 ? "" : "s"} made here while it was taking over the notebook from another tab ${n === 1 ? "wasn't" : "weren't"} applied: enter that input again.` }),
    });
    handover.bind(jstore);
    const c = controlsOf(jstore);
    comp.setReadOnly(c.readOnly || frozen);
    if (c.bar) ui.bar({ kind: "readonly", text: c.bar });
    if (c.readOnly && jstore.onTakeover) jstore.onTakeover(() => void takeOver(comp));
  }
  async function takeOver(comp: Nb) {
    if (!jstore || !alive || nb !== comp || comp.store !== jstore) return;
    takingOver = true;
    try {
      await comp.attach(jstore);
    } catch (e) {
      // (it couldn't be reopened as the writer here: the lock let go at once, so another tab can take it, and said)
      console.warn("notebook:", e);
      takingOver = false;
      await jstore.release();
      const lost = handover?.failed() ?? 0;
      if (alive) ui.bar({ kind: "refused", text: `This notebook couldn't be opened for changes here: ${(e as Error).message}${lost ? ` (${lost} input action${lost === 1 ? "" : "s"} not applied)` : ""}` });
      return;
    }
    takingOver = false;
    if (!alive || nb !== comp) return;
    showWriter(comp);
    handover?.taken(jstore);
  }
  // (this pane writes the notebook now: the journal's lock held, its reload done; else asked for, as a use of the pane,
  // and waited for, TAKE_MS at most)
  function writable(): Promise<boolean> {
    const now = () => alive && !!jstore?.writer && !!jstore.ready && !takingOver && nb?.store === jstore;
    if (now()) return Promise.resolve(true);
    handover?.use();
    return new Promise((done) => {
      const t0 = Date.now();
      const tick = setInterval(() => {
        if (now()) { clearInterval(tick); done(true); }
        else if (!alive || Date.now() - t0 > TAKE_MS) { clearInterval(tick); done(false); }
      }, 50);
    });
  }

  host.ready = mount().catch((e) => {
    if (alive) ui.bar({ kind: "refused", text: `Couldn't open this notebook: ${(e as Error).message}` });
  });
  return host;

  // Closing (NotebookHost.release): frozen, then saved, or kept as a copy, or (false) neither, and then it stays.
  async function doRelease(): Promise<{ ok: true } | { ok: false; why: string }> {
    if (!alive) return { ok: true };
    const comp = nb;
    if (!comp || !attached || !keepCopy || !stored) {
      await host.dispose();
      return { ok: true };
    }
    // (0) frozen first, before anything is awaited: no edit and no Run from here (ART-C2b r4), so the content kept
    // below is the content shown; if it can't be kept, it stays frozen, with Try again / Close without keeping
    freeze(comp);
    endRuns(); // (an agent's run in it ends now: closing runs nothing more)
    // (1) what was edited is saved, while this pane may still save: CLOSE_SAVE_MS at most
    if (bound) {
      comp.flush();
      await Promise.race([comp.saved().catch(() => {}), new Promise((r) => setTimeout(r, CLOSE_SAVE_MS))]);
    }
    // (2) from here nothing is written to the document: a save still waiting is refused at its write transaction
    bound = false;
    // (3) is the content shown what the store has, all of it (ART-C2a r4)? (a save may have been refused with a
    // resolved "not saved", the pane may have let go with an edit pending, a save may still be waiting): if not, it
    // is kept as a copy first, whole
    const snap = comp.snapshot();
    const rec = await stored().catch(() => undefined);
    if (!rec || !sameContent(rec, snap)) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), CLOSE_COPY_MS);
      try {
        const name = await keepCopy(snap, ctl.signal);
        ui.notice(`${path}: your last changes weren't saved there; they were kept as ${name}.`);
      } catch (e) {
        // (not kept: the notebook stays open, frozen, its content in it, and says so; nothing is dropped)
        const why = ctl.signal.aborted ? "the workspace is busy" : (e as Error).message;
        ui.saved("Not saved");
        kept = snap;
        keptReadable();
        return { ok: false, why: `Your last changes to ${path} couldn't be saved or kept as a copy (${why}).` };
      } finally {
        clearTimeout(timer);
      }
    }
    await host.dispose();
    return { ok: true };
  }
  // (no edits and no Run while it closes: the notebook inert (no focus, no input, no click) and read only, its popups
  // closed, and it says so)
  // (a close that couldn't keep the content: readable again (not inert: a screen reader reads it, it can be selected and
  // copied by hand), still nothing that edits or runs it, BAC-8)
  function keptReadable() {
    guard = "kept";
    nbRoot.inert = false;
  }
  function freeze(comp: Nb) {
    frozen = true;
    guard = "closing";
    nbRoot.inert = true;
    el.classList.add("closing");
    comp.setReadOnly(true);
    for (const p of document.querySelectorAll<HTMLElement>(".sbnb-pop:not(dialog)")) p.hidden = true;
    ui.saved("Closing…");
  }

  async function mount() {
    const fail = (text: string) => ui.bar({ kind: "refused", text });
    const entry = await ws.stat(path).catch(() => undefined);
    if (!alive) return;
    if (!entry || entry.kind !== "notebook" || !entry.ref) return fail("This notebook isn't in this browser's workspace.");
    const db = ws.main;
    if (!db) return fail("This browser has no storage for notebooks.");
    const ref = entry.ref;
    // A copy beside it (a new file, never over another): "name (copy).ipynb", "name (copy 2).ipynb", ...
    keepCopy = async (doc, signal) => {
      const stem = path.replace(/\.ipynb$/i, "");
      for (let i = 1; ; i++) {
        const name = `${stem} (copy${i > 1 ? ` ${i}` : ""}).ipynb`;
        try {
          await ws.create(name, { content: contentOf(doc), mode: doc.mode, ...(signal ? { signal } : {}) });
          return name;
        } catch (e) {
          if ((e as { code?: string }).code !== "exists" || i >= 50) throw e;
        }
      }
    };
    const fence0 = await fenceOf(db);
    if (!alive) return;
    const journal = fence0?.phase === "journal";

    const mod: any = await import(new URL("sagebrush-notebook.js", SITE).href);
    if (!alive) return;
    toIpynb = mod.toIpynb;
    // (sync's journal writes this workspace's notebooks: its module, the notebook page's TimeTravel bundle, and the
    // history's storage, as the page's storeFor takes them)
    const hist: any = journal ? await import(new URL("sagebrush-history.js", SITE).href) : null;
    const hdb: IDBDatabase | null = journal ? await mod.openHistoryDb() : null;
    if (!alive) return;
    if (journal && !hdb) return fail("This browser saves notebooks through sync, which needs storage that isn't available here.");
    const k = (kernel = lazyKernel(mod, () => frozen));
    const comp = (nb = mod.createNotebook(nbRoot, { kernel: k, assetBase: SITE.href, reactive: false, remotePictures: "click" }));

    // The store, bound to this document while the pane shows it. The database it writes through refuses every write
    // transaction once the pane lets go (gone, dispose), so a save already on its way (past this wrapper, waiting for
    // the workspace's lock) is refused where it would write, not only before it starts (ART-C2).
    const guardOf = (base: IDBDatabase) => new Proxy(base, {
      get(t, p) {
        if (p === "transaction")
          return (names: string | string[], mode?: IDBTransactionMode, o?: IDBTransactionOptions) => {
            if (mode === "readwrite" && !(bound && alive)) throw new Error("this notebook was let go by the pane");
            return t.transaction(names, mode, o);
          };
        const v = Reflect.get(t, p, t);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const guarded = guardOf(db);
    // (under the journal: the page's JournalStore over this page's own stores (one copy of stores.js, its gate and its
    // queues: notebook/journal.js journalClasses), attached itself, its save guarded as the plain store's is below)
    if (journal) {
      jstore = new (hist.journalClasses({ IdbStore: mod.IdbStore, IdbPatchStore: mod.IdbPatchStore }).JournalStore)(guarded, guardOf(hdb!), ref, undefined, hist);
      controlsOf = hist.pageControls;
      // (tests, loopback pages only: this pane's journal store, to put it in a hand-over's state, test-agents-artifacts.mjs J10)
      if (/^(127\.0\.0\.1|localhost)$/.test(location.hostname)) (globalThis as any).__sbTestPaneJournal = () => jstore;
    }
    const inner = jstore ?? new mod.IdbStore(guarded, ref);
    stored = () => inner.loadRecord();
    const plain = {
      load: () => inner.load(),
      save: (doc: unknown, o?: unknown) => {
        // (a test's refusal of a save, as the store answers one: loopback pages only, test-agents-artifacts.mjs)
        const hook = (globalThis as any).__sbTestStoreSave;
        const refused = typeof hook === "function" && /^(127\.0\.0\.1|localhost)$/.test(location.hostname) ? hook(doc) : null;
        if (typeof refused === "string") return Promise.resolve(refused);
        return bound && alive ? save(doc, o) : Promise.resolve("not saved: this notebook was let go by the pane");
      },
      subscribe: (f: (d: unknown) => void) => inner.subscribe(f),
    };
    const save = jstore ? jstore.save.bind(jstore) : (doc: unknown, o?: unknown) => inner.save(doc, o);
    if (jstore) jstore.save = plain.save;
    const store = jstore ?? plain;
    const mine = store; // (callbacks check they still belong to this store)
    bound = true;
    await comp.attach(store);
    if (!alive || !bound || comp.store !== mine) {
      bound = false;
      comp.detach(); // (a late attach after dispose or a let-go: let go at once)
      return;
    }
    attached = true;
    docRef = ref;
    const owned = () => alive && nb === comp && comp.store === mine;
    ui.saved("Saved");
    if (jstore) showWriter(comp);
    comp.on("dirty", () => owned() && ui.saved("Editing…"));
    // (a save the store refused: shown as it says; if the workspace's fence moved (a reset, sync), the pane lets go)
    comp.on("saved", (t: unknown) => {
      if (!owned()) return;
      const refused = typeof t === "string" && t.startsWith("not saved");
      ui.saved(refused ? (t as string) : "Saved");
      if (refused) void check();
    });
    comp.on("remote", () => owned() && ui.saved("Updated from elsewhere"));
    // (a save of this notebook made after it was let go met a change made elsewhere: what it had is kept as a copy)
    // (or, `why`, a save refused or failed when sent again: said as that, not as a change made elsewhere)
    comp.onDetachedConflict(async (doc: any, _theirs: unknown, _key: unknown, why?: { refused: boolean; message: string } | null) => {
      const name = await keepCopy!(doc);
      if (alive) ui.bar({ kind: "conflict", text: why ? `Not saved (the save ${why.refused ? "was refused" : "failed"}: ${why.message}): your last changes here were kept as ${name}.` : `Changed elsewhere (another tab, or Open in Sagebrush): your last changes here were kept as ${name}, not saved over it.` });
    });

    // The file moved, went to Trash, was replaced, or the workspace was reset: stop saving here, keep what's shown.
    const gone = (why: string) => {
      if (!owned()) return;
      bound = false; // (first: the pending save detach flushes is refused)
      endRuns(); // (an agent's run in it ends now, not when its cell does)
      comp.detach();
      comp.setReadOnly(true);
      void jstore?.release();
      handover?.bind(null);
      ui.saved("Not saved");
      ui.bar({ kind: "gone", text: `${why} What's shown here isn't saved anymore.`, actions: [{ label: "Save as a copy…", run: () => void saveCopy() }] });
    };
    const saveCopy = async () => {
      const snap = alive && nb === comp ? comp.snapshot?.() : null;
      if (!snap) return;
      try {
        const name = await keepCopy!(snap);
        if (alive) ui.bar({ kind: "readonly", text: `Saved as ${name}.` });
      } catch (e) {
        if (alive) ui.bar({ kind: "refused", text: `Couldn't save a copy: ${(e as Error).message}`, actions: [{ label: "Save as a copy…", run: () => void saveCopy() }] });
      }
    };
    check = async () => {
      if (!owned()) return;
      const e = await ws.stat(path).catch(() => undefined);
      const f = await fenceOf(db);
      if (!owned()) return;
      if (!e) return gone("This notebook was moved or removed.");
      if ((e as any).trashed) return gone("This notebook went to Trash.");
      if (e.ref !== ref) return gone("Another notebook replaced this one at the same path.");
      if (fenceMoved(f, fence0)) gone("This workspace changed how it saves notebooks (sync, a reset, or a recovery).");
    };
    // (what changed while the mount read and loaded: checked now)
    await check();

    // Written by the agent: a text label on each cell it wrote, while the cell still has that source and hasn't run.
    // (not awaited by the mount: a slow read here never holds the notebook or its closing)
    void agentCellsOf.catch(() => null).then((agentCells) => {
      if (!owned() || !agentCells?.size) return;
      for (const c of comp.cells()) {
        if (agentCells.get(c.id) !== c.ta.value) continue;
        const label = document.createElement("div");
        label.className = "nb-agent-mark";
        label.id = `nb-mark-${c.id}`;
        label.textContent = `Written by ${ui.agentName()}`;
        c.el.prepend(label);
        c.ta.setAttribute("aria-describedby", [c.ta.getAttribute("aria-describedby"), label.id].filter(Boolean).join(" "));
        const clear = () => {
          label.remove();
          agentCells.delete(c.id);
          c.ta.setAttribute("aria-describedby", (c.ta.getAttribute("aria-describedby") ?? "").split(" ").filter((x: string) => x && x !== label.id).join(" "));
          c.ta.removeEventListener("input", clear);
          ranObserver.disconnect();
        };
        c.ta.addEventListener("input", clear);
        const ranObserver = new MutationObserver(() => c.el.classList.contains("running") && clear());
        ranObserver.observe(c.el, { attributes: true, attributeFilter: ["class"] });
      }
    });
  }
}
