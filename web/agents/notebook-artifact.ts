// A notebook artifact: a workspace .ipynb file shown and run in the artifact pane with the notebook component
// (/sagebrush-notebook.js, loaded on first use; its kernel worker, /sagebrush-worker.js, only on the first Run).
// The artifacts plan (r2 + r2.1): only the person's Run runs code (the component is created non-reactive, the host
// never calls applyEdits); the store is the notebook page's own IdbStore, bound to the document's ref, so a save
// can never reach another document at the same path; under sync's journal the pane is read-only; remote pictures
// wait for a click whatever the document says.
import type { Workspace } from "../workspace/api";
import { canonical, cellForm, preflight, type NotebookEdit } from "../workspace/notebook-edit";

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
  edit(e: NotebookEdit, may: () => boolean): Promise<EditResult>;
  hidden(on: boolean): void;
  interrupt(): void;
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

/** Whether the fence moved since `seen` in a way the stores refuse (stores.js fenceRefusal, for an "ok" writer). */
export function fenceMoved(f: Fence, seen: Fence): boolean {
  if (!f) return !!seen;
  if (f.quarantined || (f.phase ?? "ok") !== "ok") return true;
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
  let readOnlyHere = false; // (sync's journal writes this workspace: shown read only, never edited here)
  let docRef: string | null = null; // (the document this pane is bound to, once attached and editable: an agent's edit must name it)
  // (observed from the start, so a move, Trash or replacement while the mount reads and loads isn't missed: before
  // attach it is caught by the check after it, ART-C2)
  const unwatch = ws.watch(() => void check());
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
      watchRunning.disconnect();
      const comp = nb;
      alive = false;
      bound = false;
      if (comp) {
        comp.detach();
        comp.destroy();
      }
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
    async edit(e, may) {
      // (the agent's authority: the same grant, in force, and the turn the edit came from still the chat's running
      // one; checked once, after the last wait and right before the change, so a loss at any wait reaches it; C1)
      const no = { ok: false as const, code: "busy" as const, why: "the grant or the turn changed while this edit waited: nothing changed" };
      await host.ready;
      const comp = nb;
      // (today's guards: only a pane that may save this document takes an edit, never one closing, let go, read only)
      if (readOnlyHere) return { ok: false, code: "busy", why: "this notebook is read only here (sync saves it: open it in Sagebrush to change it)" };
      if (!alive || !comp || !attached || !bound || frozen || guard !== "open" || docRef === null || !stored) return { ok: false, code: "busy", why: "this notebook is closing, or isn't saved here now" };
      if (e.ref !== docRef) return { ok: false, code: "conflict", why: "another notebook is at this path now (read it again)" };
      const usable = () => alive && nb === comp && attached && bound && !frozen && guard === "open" && docRef === e.ref;
      const closing = { ok: false as const, code: "busy" as const, why: "this notebook is closing, or isn't saved here now" };
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
      if (!usable()) return closing;
      const rec0 = await stored().catch(() => null);
      if (!usable()) return closing;
      if (!keptAsShown(rec0)) return { ok: false, code: "busy", why: "not applied: the person's changes here couldn't be saved first (the store refused them); nothing changed" };
      // (the revision this pane's next save is made from: kept for a rollback, so that save still conflicts with another
      // tab's change instead of writing over it; astra's C3)
      const baseRev = rec0.rev;
      const seen = comp.snapshot();
      const read = await ws.read(path).catch(() => null);
      if (!usable()) return closing;
      if (!read || (read.entry as any)?.ref !== docRef) return { ok: false, code: "conflict", why: "another notebook is at this path now (read it again)" };
      const checked = preflight(e, (read.content as any)?.cells ?? [], { hashes: true });
      if (!checked.ok) return { ok: false, code: "conflict", why: checked.why, ...(checked.ids ? { ids: checked.ids } : {}) };
      // (2) then, in one synchronous stretch (no await): the authority, nothing shown changed since that save,
      // the edit fits what is shown, and the change is made; what the person does can't come between the check and it
      if (!may()) return no;
      const before = comp.snapshot();
      if (canonical(before) !== canonical(seen)) return { ok: false, code: "conflict", why: "the notebook changed while this edit was checked (read it again)" };
      const pre = preflight(e, before.cells, { hashes: false });
      if (!pre.ok) return { ok: false, code: "conflict", why: pre.why, ...(pre.ids ? { ids: pre.ids } : {}) };
      let inserted: string[] = [];
      try {
        const apply = (globalThis as any).__sbTestApplyEdits && /^(127\.0\.0\.1|localhost)$/.test(location.hostname) ? (globalThis as any).__sbTestApplyEdits : null;
        // (run: false: an edit runs nothing; applyEdits mutates synchronously, its promise settles at once)
        const r = apply ? apply(comp, pre.edits) : comp.applyEdits(pre.edits, { run: false });
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
    if (journal) {
      // Sync's journal is this workspace's writer: shown here, never edited or run. No interpreter at all: no gesture
      // (button, keyboard, command mode) can start one (ART-C1).
      const comp = (nb = mod.createNotebook(nbRoot, { kernel: null, assetBase: SITE.href, reactive: false, remotePictures: "click", readOnly: true }));
      const r = await ws.read(path).catch(() => null);
      if (!alive) return;
      if (r?.content) comp.load(r.content);
      comp.setReadOnly(true);
      readOnlyHere = true;
      for (const b of nbRoot.querySelectorAll<HTMLButtonElement>("button")) b.disabled = true;
      ui.saved("Read only here");
      ui.bar({ kind: "readonly", text: "This workspace saves notebooks through sync: open it in Sagebrush to run and edit it.", actions: [{ label: "Open in Sagebrush", run: () => open(`/w${path}`, "_blank", "noopener") }] });
      return;
    }
    const k = (kernel = lazyKernel(mod, () => frozen));
    const comp = (nb = mod.createNotebook(nbRoot, { kernel: k, assetBase: SITE.href, reactive: false, remotePictures: "click" }));

    // The store, bound to this document while the pane shows it. The database it writes through refuses every write
    // transaction once the pane lets go (gone, dispose), so a save already on its way (past this wrapper, waiting for
    // the workspace's lock) is refused where it would write, not only before it starts (ART-C2).
    const guarded = new Proxy(db, {
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
    const inner = new mod.IdbStore(guarded, ref);
    stored = () => inner.loadRecord();
    const store = {
      load: () => inner.load(),
      save: (doc: unknown, o?: unknown) => {
        // (a test's refusal of a save, as the store answers one: loopback pages only, test-agents-artifacts.mjs)
        const hook = (globalThis as any).__sbTestStoreSave;
        const refused = typeof hook === "function" && /^(127\.0\.0\.1|localhost)$/.test(location.hostname) ? hook(doc) : null;
        if (typeof refused === "string") return Promise.resolve(refused);
        return bound && alive ? inner.save(doc, o) : Promise.resolve("not saved: this notebook was let go by the pane");
      },
      subscribe: (f: (d: unknown) => void) => inner.subscribe(f),
    };
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
    comp.onDetachedConflict(async (doc: any) => {
      const name = await keepCopy!(doc);
      if (alive) ui.bar({ kind: "conflict", text: `Changed elsewhere (another tab, or Open in Sagebrush): your last changes here were kept as ${name}, not saved over it.` });
    });

    // The file moved, went to Trash, was replaced, or the workspace was reset: stop saving here, keep what's shown.
    const gone = (why: string) => {
      if (!owned()) return;
      bound = false; // (first: the pending save detach flushes is refused)
      comp.detach();
      comp.setReadOnly(true);
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
