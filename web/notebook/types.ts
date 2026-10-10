// The notebook's contract (web/notebook/notebook.js): its document, and its
// two plug-in points, the Kernel that runs code and the Store that keeps the
// document.  Implementations: WorkerKernel (worker-kernel.js), MemoryStore and
// IdbStore (stores.js); a CoCalc project kernel and a CoCalc syncdb store
// implement the same interfaces.

/** Jupyter's output records, as in .ipynb files. */
export type Output =
  | { output_type: "stream"; name: "stdout" | "stderr"; text: string }
  | { output_type: "display_data" | "execute_result"; data: Record<string, string>; metadata?: object; execution_count?: number }
  | { output_type: "error"; ename?: string; evalue?: string; traceback: string[] };

export interface Cell {
  /** Stable across sessions and devices: matching remote changes uses it (nbformat 4.5 cell id). */
  id: string;
  /** "raw": nbformat's raw cell, text kept as it is and never run. */
  type?: "code" | "markdown" | "raw";
  code: string;
  outputs?: Output[];
  /** The execution count, the n of the prompt [n]:. */
  n?: number | string | null;
  attachments?: Record<string, Record<string, string>> | null;
  /** nbformat's cell metadata (tags, ...), kept as it is. */
  metadata?: Record<string, unknown> | null;
}

export interface NotebookDoc {
  mode: "python" | "sage" | "magma";
  cells: Cell[];
  /** Anything else (name, id, updated, ...) is kept as it is. */
  [key: string]: unknown;
}

/** What happens to code that runs: the kernel calls these. */
export interface OutputSink {
  start?(): void;
  out(text: string, isError: boolean): void;
  /** A MIME bundle: image/svg+xml, image/png, text/latex, application/vnd.sagebrush.scene3d+json, text/plain, ... */
  display(bundle: Record<string, string>): void;
  /** Controls of an @interact (Sagebrush's protocol). */
  interact(spec: object): void;
  clear(): void;
  done(ms: number): void;
  /** Interrupted or restarted: `message` says which. */
  stopped(message: string): void;
  /** Never ran (an earlier cell was interrupted). */
  skipped?(): void;
}

export interface Kernel {
  /** Increases with each new interpreter: what an older one made (interact controls) is stale. */
  readonly generation: number;
  execute(code: string, opts: { mode: string; repl?: boolean }, sink: OutputSink): void;
  /** Questions: {complete: line} -> {matches, prefix}; {check: source} -> {more}.  `fallback` if it restarts. */
  ask(msg: object, mode: string, fallback: unknown): Promise<any>;
  interrupt(message?: string): void;
  restart(message?: string): void;
  /** Optional: rerun an @interact's function with new values. */
  interact?(id: number, values: object, sink: OutputSink): void;
  /** Set by the notebook: where output addressed to an @interact goes. */
  targetSink?: (target: number) => Pick<OutputSink, "out" | "display" | "interact" | "clear"> | null;
  on(event: "status" | "restart" | "ready", f: (...args: any[]) => void): () => void;
}

export interface Store {
  load(): Promise<NotebookDoc>;
  /** Called half a second after the last change, only if the document changed; resolves to a status ("saved in this browser"),
   *  or, for a store with revisions (stores.js), {saved, rev} or {conflict: the stored document} when doc.baseRev is not the stored revision. */
  save(doc: NotebookDoc): Promise<string | void | { saved?: string; rev?: number; conflict?: NotebookDoc }> | string | void;
  /** Changes made elsewhere; returns an unsubscribe function. */
  subscribe?(f: (doc: NotebookDoc) => void): () => void;
}

export interface Notebook {
  readonly root: HTMLElement;
  readonly mode: NotebookDoc["mode"];
  cells(): any[];
  addCell(code?: string, where?: { before?: Element; after?: Element; first?: boolean } | null, focus?: boolean, type?: "code" | "markdown" | "raw"): any;
  run(cell: any): Promise<void>;
  runAll(): Promise<unknown>;
  interrupt(): void;
  restart(): void;
  setMode(mode: NotebookDoc["mode"]): void;
  setInput(cell: any, text: string): void;
  load(doc: NotebookDoc): void;
  snapshot(): NotebookDoc;
  applyRemote(doc: NotebookDoc): void;
  /** Like applyRemote, but a change made here: saved and recorded (reverting to an old version). */
  replace(doc: NotebookDoc): void;
  attach(store: Store): Promise<NotebookDoc>;
  detach(): void;
  setMeta(patch: object): void;
  /** change: the document changed here (a snapshot); remote: a change from elsewhere was applied; saved: the store's status; dirty: an edit, not yet saved; mode: the language changed; conflict: a cell changed here and elsewhere ({id, copy}: this side's text is in the new cell copy). */
  on(event: "change" | "remote" | "saved" | "dirty" | "mode" | "conflict", f: (...args: any[]) => void): () => void;
  setReadOnly(readOnly: boolean): void;
  /** Measure every editor again (after the notebook was hidden). */
  resize(): void;
  destroy(): void;
}
