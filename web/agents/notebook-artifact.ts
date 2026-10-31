// A notebook artifact: a workspace .ipynb file shown and run in the artifact pane with the notebook component
// (/sagebrush-notebook.js, loaded on first use; its kernel worker, /sagebrush-worker.js, only on the first Run).
// The artifacts plan (r2 + r2.1): only the person's Run runs code (the component is created non-reactive, the host
// never calls applyEdits); the store is the notebook page's own IdbStore, bound to the document's ref, so a save
// can never reach another document at the same path; under sync's journal the pane is read-only; remote pictures
// wait for a click whatever the document says.
import type { Workspace } from "../workspace/api";

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
};

export type NotebookHost = {
  el: HTMLElement;
  /** Saves made and kept (or an error). */
  flush(): Promise<void>;
  /** Detached, stopped, its kernel ended; nothing it started writes afterwards. */
  dispose(): Promise<void>;
  isRunning(): boolean;
  hidden(on: boolean): void;
  interrupt(): void;
  copyText(): string;
};

type Nb = any; // (the component is plain JS: its API is web/notebook/README.md's)

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

export async function mountNotebook(ws: Workspace, path: string, box: HTMLElement, ui: NotebookUi, agentCellsOf: Promise<AgentCells | null>, wanted: () => boolean = () => true): Promise<NotebookHost> {
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

  let alive = true;
  let nb: Nb = null;
  let kernel: any = null;
  let unwatch: (() => void) | null = null;
  let running = 0;
  let bound = false;
  const fail = (text: string) => {
    ui.bar({ kind: "refused", text });
    return host;
  };
  const host: NotebookHost = {
    el,
    async flush() {
      if (!nb || !bound) return;
      nb.flush(); // (its pending save goes out now, the notebook still attached)
      await nb.saved(); // (and is made, or said why not)
    },
    async dispose() {
      unwatch?.();
      unwatch = null;
      if (nb && bound && alive) {
        nb.flush();
        await nb.saved().catch(() => {});
      }
      alive = false;
      bound = false;
      if (nb) {
        nb.detach();
        await nb.mayLeave().catch(() => {});
        nb.destroy();
      }
      // (destroy leaves the page's one plot tooltip, shared by every notebook here: hidden, not removed)
      for (const t of document.querySelectorAll<HTMLElement>(".sbnb-tip")) t.hidden = true;
      kernel?.close();
      kernel = null;
      nb = null;
      el.remove();
    },
    isRunning: () => running > 0,
    hidden(on) {
      el.hidden = on;
      // (the notebook's popups belong to the document body: a hidden notebook's are closed)
      if (on) for (const p of document.querySelectorAll<HTMLElement>(".sbnb-pop:not(dialog)")) p.hidden = true;
      else nb?.resize();
    },
    interrupt: () => nb?.interrupt(),
    copyText: () => (nb ? nb.cells().map((c: any) => c.ta.value).join("\n\n") : ""),
  };

  const entry = await ws.stat(path).catch(() => undefined);
  if (!alive || !wanted()) return host; // (closed while it opened: nothing more is made)
  if (!entry || entry.kind !== "notebook" || !entry.ref) return fail("This notebook isn't in this browser's workspace.");
  const db = ws.main;
  if (!db) return fail("This browser has no storage for notebooks.");
  const ref = entry.ref;
  // A copy beside it (a new file, never over another): "name (copy).ipynb", "name (copy 2).ipynb", ...
  const keepCopy = async (doc: { mode?: string; cells?: unknown[] }) => {
    const stem = path.replace(/\.ipynb$/i, "");
    for (let i = 1; ; i++) {
      const name = `${stem} (copy${i > 1 ? ` ${i}` : ""}).ipynb`;
      try {
        await ws.create(name, { content: { mode: doc.mode, cells: doc.cells }, mode: doc.mode });
        return name;
      } catch (e) {
        if ((e as { code?: string }).code !== "exists" || i >= 50) throw e;
      }
    }
  };
  const fence0 = await fenceOf(db);
  const journal = fence0?.phase === "journal";

  const mod: any = await import(new URL("sagebrush-notebook.js", SITE).href);
  if (!alive || !wanted()) return host; // (closed while it opened: nothing more is made)
  // The interpreter starts on the first Run, not before: its worker is made when the component first asks it to
  // execute (the code was taken from the cell at the person's click, before this). Until then nothing else starts it
  // (a completion waits for the first Run).
  kernel = new mod.WorkerKernel({ createWorker: () => new Worker(new URL("sagebrush-worker.js", SITE), { type: "module" }) });
  const execute = kernel.execute.bind(kernel);
  kernel.execute = (code: string, o: unknown, sink: unknown) => {
    if (!kernel.worker) kernel.start();
    return execute(code, o, sink);
  };
  nb = mod.createNotebook(nbRoot, { kernel, assetBase: SITE.href, reactive: false, remotePictures: "click", readOnly: journal });

  // Running: the tab's mark (a cell element is .running while its code runs)
  const watchRunning = new MutationObserver(() => {
    const n = nbRoot.querySelectorAll(".cell.running, .cell.queued").length;
    if ((n > 0) !== (running > 0)) ui.running(n > 0);
    running = n;
  });
  watchRunning.observe(nbRoot, { subtree: true, attributes: true, attributeFilter: ["class"] });

  if (journal) {
    // (sync's journal is this workspace's writer: shown, not edited or run here)
    const r = await ws.read(path).catch(() => null);
    if (!alive) return host;
    if (r?.content) nb.load(r.content);
    nb.setReadOnly(true);
    for (const b of nbRoot.querySelectorAll<HTMLButtonElement>("button")) b.disabled = true;
    ui.saved("Read only here");
    ui.bar({ kind: "readonly", text: "This workspace saves notebooks through sync: open it in Sagebrush to run and edit it.", actions: [{ label: "Open in Sagebrush", run: () => open(`/w${path}`, "_blank", "noopener") }] });
    return host;
  }

  // The store, bound to this document while the pane shows it: once it lets go (gone, dispose), a save that was
  // pending or comes late is refused here, never made, whatever document is now at the path.
  const inner = new mod.IdbStore(db, ref);
  bound = true;
  const store = {
    load: () => inner.load(),
    save: (doc: unknown, o?: unknown) => (bound && alive ? inner.save(doc, o) : Promise.resolve("not saved: this notebook was let go by the pane")),
    subscribe: (f: (d: unknown) => void) => inner.subscribe(f),
  };
  const mine = store; // (callbacks check they still belong to this store)
  await nb.attach(store);
  if (!alive || !wanted() || !bound || nb?.store !== mine) {
    bound = false;
    nb?.detach(); // (a late attach after dispose or a switch: let go at once)
    return host;
  }
  ui.saved("Saved");
  nb.on("dirty", () => alive && nb?.store === mine && ui.saved("Editing…"));
  // (a save the store refused: shown as it says; if the workspace's fence moved (a reset, sync), the pane lets go)
  nb.on("saved", (t: unknown) => {
    if (!alive || nb?.store !== mine) return;
    const refused = typeof t === "string" && t.startsWith("not saved");
    ui.saved(refused ? (t as string) : "Saved");
    if (refused) void checkFence();
  });
  nb.on("remote", () => alive && nb?.store === mine && ui.saved("Updated from elsewhere"));
  // (a save of this notebook made after it was let go met a change made elsewhere: what it had is kept as a copy)
  nb.onDetachedConflict(async (doc: any) => {
    const name = await keepCopy(doc);
    if (alive) ui.bar({ kind: "conflict", text: `Changed elsewhere (another tab, or Open in Sagebrush): your last changes here were kept as ${name}, not saved over it.` });
  });

  // The file moved, went to Trash, was replaced, or the workspace was reset: stop saving here, keep what's shown.
  const gone = (why: string) => {
    if (!alive || !nb || nb.store !== mine) return;
    bound = false; // (first: the pending save detach flushes is refused)
    nb.detach();
    nb.setReadOnly(true);
    ui.saved("Not saved");
    ui.bar({
      kind: "gone",
      text: `${why} What's shown here isn't saved anymore.`,
      actions: [{ label: "Save as a copy…", run: () => void saveCopy() }],
    });
  };
  const saveCopy = async () => {
    const snap = nb?.snapshot?.();
    if (!snap) return;
    try {
      ui.bar({ kind: "readonly", text: `Saved as ${await keepCopy(snap)}.` });
    } catch (e) {
      ui.bar({ kind: "refused", text: `Couldn't save a copy: ${(e as Error).message}` });
    }
  };
  const checkFence = async () => {
    const f = await fenceOf(db);
    if (!alive || nb?.store !== mine) return;
    if (fenceMoved(f, fence0)) gone("This workspace changed how it saves notebooks (sync, a reset, or a recovery).");
  };
  unwatch = ws.watch(async () => {
    const e = await ws.stat(path).catch(() => undefined);
    if (!alive || nb?.store !== mine) return;
    if (!e) return gone("This notebook was moved or removed.");
    if ((e as any).trashed) return gone("This notebook went to Trash.");
    if (e.ref !== ref) return gone("Another notebook replaced this one at the same path.");
    await checkFence();
  });

  // Written by the agent: a text label on each cell it wrote, while the cell still has that source and hasn't run.
  const agentCells = await agentCellsOf.catch(() => null);
  if (!alive || nb?.store !== mine) return host;
  if (agentCells?.size) {
    for (const c of nb.cells()) {
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
  }
  return host;
}
