// The file picker of Share and of Download "with its files (.zip)" (share-ux-plan r2 §1, §3, §4; dependencies 2b):
// drawn from metadata only (no file is read to open it), virtualized rows in one stable order (list-view.ts), the
// files the notebook uses checked as the analysis finds them (selection.ts, deps-client.ts), each with why; at the
// action, an immutable snapshot of the checks.  Lifted from dialog.ts, unchanged, so both dialogs pick alike.
//
// One open belongs to one notebook (#172 r2's review, CORR-172-ASTRA-2): its identity is taken when it opens and
// checked after every wait and at the action (take()).
import { Selection, type Bounds } from "./selection";
import { createFileList } from "./list-view";
import { startDeps, type WorkerLike } from "../deps/deps-client";
import type { CellKind, Unfollowed } from "../deps/file-deps";

export interface PickerHost {
  /** the notebook: its file name, and its size */
  notebook: () => { path: string; size: number };
  /** which notebook is attached now (an open, and its action, belong to the one it started with); null
   * while the notebook is changing (until the new one is attached, nothing is bound to it) */
  notebookId: () => string | null;
  /** the workspace's data files, metadata only (no bodies) */
  listFiles: () => Promise<{ path: string; size?: number; fid?: string; rev?: number }[]>;
  /** one .py file's bytes, for the analysis (sent on to its worker, not decoded here) */
  readBytes: (path: string) => Promise<Uint8Array>;
  /** the cells, in page order */
  cells: () => { index: number; kind: CellKind; source: string }[];
  /** what each cell's last run read (cell index -> workspace paths) */
  fileReads: () => Map<number, string[]>;
  /** where the notebook's interpreter resolves imports, and its working directory; null if it can't be asked or didn't answer */
  importInfo: () => Promise<{ cwd: string; importPath: { dir: string; workspace: boolean }[]; builtinModules: string[]; externalModules: string[]; packageModules: string[] } | null>;
  createWorker: () => WorkerLike;
  /** (tests: shorter fail-safes) */
  failsafe?: () => { silenceMs: number; sourceBytes: number } | undefined;
  bounds: () => Bounds;
  fmtSize: (n: number) => string;
}

const $ = (root: ParentNode, sel: string) => root.querySelector(sel) as HTMLElement;
const num = (n: number) => n.toLocaleString("en-US");
const nth = (n: number) => {
  const k = n + 1, s = k % 100 >= 11 && k % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][k % 10] ?? "th";
  return `${k}${s}`;
};
/** The picker in dialog `d`, whose elements are `#<id>list`, `#<id>listinner`, `#<id>summary`, `#<id>status`,
 * `#<id>all` and `#<id>none`.  `busy`: the dialog's action is running (the boxes don't change); `drawn`: after each
 * draw, with the summary. */
export function createPicker(d: HTMLDialogElement, id: string, h: PickerHost, busy: () => boolean, drawn: (s: ReturnType<Selection["summary"]>) => void, visible?: (r: Selection["rows"][number]) => boolean) {
  const list = $(d, `#${id}list`), inner = $(d, `#${id}listinner`), summary = $(d, `#${id}summary`), status = $(d, `#${id}status`);
  let gen = 0, sel: Selection | null = null, run: { stop(): void; running: boolean } | null = null;
  // (an open's own token: closing the dialog or starting the action ends it, so an
  // open still waiting for the file list or the interpreter never starts its analysis)
  let token = 0, analyzing = false;
  // (the notebook the current selection was made for)
  let selNotebook: string | null = null;
  let found = 0, parsed = 0, unfollowed = 0, ranPartial = false, noInterpreter = false;
  let unparsed: string[] = [];

  const view = createFileList({ list, inner, summary, selection: () => sel, busy, bounds: h.bounds, fmtSize: h.fmtSize, drawn, visible });
  const draw = view.draw;

  $(d, `#${id}all`).addEventListener("click", () => {
    sel?.all(true);
    draw();
  });
  $(d, `#${id}none`).addEventListener("click", () => {
    sel?.all(false);
    draw();
  });
  const say = () => {
    if (!sel) return;
    const parts: string[] = [];
    const checked = `Checked ${num(found)} file${found === 1 ? "" : "s"} this notebook uses`;
    if (sel.state === "analyzing") parts.push(`Finding the files this notebook uses: ${num(parsed)} parsed, ${num(found)} checked…`);
    else if (noInterpreter) parts.push("The notebook's interpreter didn't answer (it isn't running, or is busy running a cell), so its code wasn't analyzed.", found ? `${checked}, from what ran; the rest are unchecked.` : "The rest are unchecked.");
    else if (sel.state === "not-analyzed") parts.push("Stopped finding files: the rest are unchecked, not analyzed.", ...(found ? [`${checked}.`] : []));
    else parts.push(`${found ? checked : "Found no other files this notebook uses"} (from its code${ranPartial ? "" : " and from what ran"}; check the list).`);
    if (unparsed.length) {
      const names = unparsed.length <= 3 ? unparsed.join(", ") : `${unparsed.slice(0, 3).join(", ")} and ${num(unparsed.length - 3)} more`;
      parts.push(`${names[0].toUpperCase() + names.slice(1)} couldn't be parsed, so the files ${unparsed.length === 1 ? "it names aren't" : "they name aren't"} pre-checked.`);
    }
    if (unfollowed) parts.push(`${num(unfollowed)} name${unfollowed === 1 ? "" : "s"} in the code couldn't be followed, so ${unfollowed === 1 ? "it isn't" : "they aren't"} pre-checked.`);
    status.textContent = parts.join(" ");
  };
  const where = (u: Unfollowed) => ("cell" in u.where ? `the ${nth(u.where.cell)} cell` : u.where.file.replace(/^\/+/, ""));
  /** The analysis stopped and the list cleared: the dialog closed, or its notebook changed. */
  const reset = () => {
    token++;
    run?.stop();
    run = null;
    analyzing = false;
    sel = null;
    inner.replaceChildren();
  };

  async function open(what: string) {
    const nbId = h.notebookId();
    // (mid-switch there's no notebook to pick for: the page waits for the switch before opening the dialog)
    if (nbId === null) {
      status.textContent = `The notebook is changing: open ${what} again in a moment.`;
      return;
    }
    run?.stop();
    run = null;
    const my = ++gen, mine = ++token;
    // (this open is still the current one, for the notebook it began with)
    const alive = () => mine === token && h.notebookId() === nbId;
    analyzing = true;
    found = 0;
    parsed = 0;
    unfollowed = 0;
    unparsed = [];
    noInterpreter = false;
    const nb = h.notebook();
    const files = await h.listFiles();
    if (!alive()) return;
    sel = new Selection(my, { path: "/" + nb.path, size: nb.size }, files);
    selNotebook = nbId;
    list.scrollTop = 0;
    inner.replaceChildren();
    status.textContent = "Finding the files this notebook uses…";
    draw();
    // what ran: exact, and first
    const reads = h.fileReads();
    ranPartial = reads.size === 0;
    for (const [cell, paths] of reads) for (const p of paths) if (sel.suggest(my, p, { kind: "read", cell })) found++;
    // the code: in the worker, as it goes
    const info = await h.importInfo().catch(() => null);
    if (!alive() || !sel) return;
    const s = sel;
    const finish = (state: "done" | "not-analyzed") => {
      analyzing = false;
      s.state = state;
      draw();
      say();
    };
    if (!info) {
      // Without the interpreter's answer its working directory is unknown, so no name in the code can
      // be resolved: none is guessed (CORR-172-ASTRA-1).  What ran is still pre-checked (UI-B4).
      noInterpreter = true;
      return finish("not-analyzed");
    }
    try {
      run = startDeps({
        gen: my,
        input: {
          cells: h.cells(),
          files: files.map((f) => [f.path, { size: f.size }]),
          cwd: info.cwd,
          importPath: info.importPath,
          builtinModules: info.builtinModules,
          externalModules: info.externalModules,
          packageModules: info.packageModules,
        },
        readBytes: h.readBytes,
        createWorker: h.createWorker,
        failsafe: h.failsafe?.(),
        handlers: {
          onDep: (path, reason) => {
            if (!alive()) return;
            if (s.suggest(my, path, reason)) found++;
            draw();
            say();
          },
          onUnfollowed: (u) => {
            if (!alive()) return;
            // (a cell or file that couldn't be parsed is said by name; the rest are counted, UI-B2)
            if (u.why === "couldn't be parsed") unparsed.push(where(u));
            else unfollowed++;
          },
          onProgress: (p) => {
            if (!alive()) return;
            parsed = p.parsed;
            say();
          },
          onDone: (r) => {
            if (!alive()) return;
            // only a fail-safe or a failure stopped it; a run that finished with a cell it couldn't
            // parse is done, and says so (UI-B2)
            finish(r.stopped ? "not-analyzed" : "done");
          },
        },
      });
    } catch {
      // (the analysis couldn't start: not analyzed, and the action still works, CORR-SHAREB-3)
      run = null;
      return finish("not-analyzed");
    }
    say();
  }

  return {
    open,
    reset,
    draw,
    status,
    /** Whether the selection is this notebook's: the action's first check (never another's bytes with its files,
     * CORR-172-ASTRA-2). */
    mine: () => !!sel && selNotebook !== null && h.notebookId() === selNotebook,
    /** The action's start (after mine()): the analysis stopped and the checks frozen, with whether it was still running. */
    take(): { snap: ReturnType<Selection["snapshot"]>; stillRunning: boolean } {
      const stillRunning = analyzing;
      token++;
      analyzing = false;
      run?.stop();
      run = null;
      if (stillRunning) sel!.state = "not-analyzed";
      return { snap: sel!.snapshot(), stillRunning };
    },
    get selection() {
      return sel;
    },
    get notebook() {
      return selNotebook;
    },
    get analyzing() {
      return analyzing;
    },
    get generation() {
      return gen;
    },
  };
}
