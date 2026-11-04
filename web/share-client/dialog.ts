// The Share dialog's file list and upload (share-ux-plan r2 §1, §3, §4): drawn
// from metadata only (no file is read to open it), virtualized rows in one
// stable order, the files the notebook uses pre-checked as the analysis finds
// them (selection.ts, deps-client.ts), each with why, and an upload of an
// immutable snapshot of the checks, reading only the checked files.
//
// One open belongs to one notebook (#172 r2's review, CORR-172-ASTRA-2): its
// identity is taken when it opens, checked after every wait and at Upload, and
// a switch of notebooks closes the dialog (the page waits for an upload to end
// first: idle(), invalidate()).  While uploading, the dialog can't be closed:
// a close that gets through (a second Esc, a programmatic close) shows it again,
// and opening Share again only shows it (UI-4, UI-B1).
import { Selection, reasonText, type Bounds } from "./selection";
import { startDeps, type WorkerLike } from "../deps/deps-client";
import type { CellKind, Unfollowed } from "../deps/file-deps";
import type { LazyFile } from "./upload";

export interface ShareDialogHost {
  dlg: HTMLDialogElement;
  /** the notebook: its file name in the share, and its bytes */
  notebook: () => { path: string; data: Uint8Array };
  /** which notebook is attached now (an open, and its upload, belong to the one it started with); null
   * while the notebook is changing (until the new one is attached, nothing is bound to it) */
  notebookId: () => string | null;
  /** the workspace's data files, metadata only (no bodies) */
  listFiles: () => Promise<{ path: string; size?: number; fid?: string; rev?: number }[]>;
  /** one file's bytes at upload; throws if it is no longer the file listed (fid) */
  readFile: (f: { path: string; fid?: string }) => Promise<Uint8Array>;
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
  upload: (o: { files: LazyFile[]; title: string; license: string }, progress: (done: number, total: number) => void) => Promise<{ url: string; again: boolean }>;
  fmtSize: (n: number) => string;
}

const ROW_H = 40;
const OVERSCAN = 8;
const $ = (root: ParentNode, sel: string) => root.querySelector(sel) as HTMLElement;
const num = (n: number) => n.toLocaleString("en-US");
const nth = (n: number) => {
  const k = n + 1, s = k % 100 >= 11 && k % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][k % 10] ?? "th";
  return `${k}${s}`;
};
/** A long path shortened in the middle (UI-5); the full path is the title. */
export function middle(s: string, max = 52): string {
  if (s.length <= max) return s;
  const keep = max - 1, head = Math.ceil(keep / 2);
  return s.slice(0, head) + "…" + s.slice(s.length - (keep - head));
}

export function createShareDialog(h: ShareDialogHost) {
  const d = h.dlg;
  const list = $(d, "#sharelist"), inner = $(d, "#sharelistinner"), summary = $(d, "#sharesummary"), status = $(d, "#sharestatus");
  const btn = $(d, "#shareupload") as HTMLButtonElement, prog = $(d, "#shareprogress"), out = $(d, "#shareresult");
  const closeBtn = d.querySelector("form button") as HTMLButtonElement | null;
  const linkBtn = d.querySelector("#sharelink") as HTMLButtonElement | null;
  let gen = 0, sel: Selection | null = null, run: { stop(): void; running: boolean } | null = null, busy = false;
  // (an open's own token: closing the dialog or starting an upload ends it, so an
  // open still waiting for the file list or the interpreter never starts its analysis)
  let token = 0, analyzing = false;
  // (the notebook the current selection was made for)
  let selNotebook: string | null = null;
  let found = 0, parsed = 0, unfollowed = 0, ranPartial = false, noInterpreter = false;
  let unparsed: string[] = [];
  let idleWaiters: (() => void)[] = [];

  const draw = () => {
    if (!sel) return;
    inner.style.height = `${sel.rows.length * ROW_H}px`;
    const first = Math.max(0, Math.floor(list.scrollTop / ROW_H) - OVERSCAN);
    const last = Math.min(sel.rows.length, Math.ceil((list.scrollTop + (list.clientHeight || 300)) / ROW_H) + OVERSCAN);
    const keep = new Set<number>();
    for (let i = first; i < last; i++) keep.add(i);
    for (const el of [...inner.children] as HTMLElement[]) if (!keep.has(Number(el.dataset.i))) el.remove();
    const have = new Set([...inner.children].map((el) => Number((el as HTMLElement).dataset.i)));
    for (const i of keep) if (!have.has(i)) inner.append(rowEl(i));
    for (const el of [...inner.children] as HTMLElement[]) fill(el);
    const s = sel.summary(h.bounds());
    summary.textContent = `${num(s.files)} of ${num(s.of)} files${s.sizesKnown ? `, ${h.fmtSize(s.bytes)}` : ""}${s.over ? ` — ${s.over}` : ""}`;
    btn.disabled = busy || !!s.over;
  };
  const rowEl = (i: number) => {
    const el = document.createElement("div");
    el.className = "sharerow";
    el.dataset.i = String(i);
    el.style.top = `${i * ROW_H}px`;
    el.innerHTML = `<label><input type="checkbox"><span class="name"></span><span class="size"></span></label><div class="why"></div>`;
    const box = el.querySelector("input") as HTMLInputElement;
    box.addEventListener("click", (e) => {
      if (!sel || busy) return e.preventDefault();
      sel.toggle(i, e.shiftKey);
      queueMicrotask(draw);
    });
    box.addEventListener("keydown", (e) => {
      if (e.key !== " " || !sel) return;
      // (Space and Shift+Space: the range from the keyboard, UI-8; the native
      // toggle, on keyup, is cancelled too)
      e.preventDefault();
      if (busy || e.repeat) return;
      sel.toggle(i, e.shiftKey);
      draw();
    });
    box.addEventListener("keyup", (e) => {
      if (e.key === " ") e.preventDefault();
    });
    return el;
  };
  const fill = (el: HTMLElement) => {
    const r = sel!.rows[Number(el.dataset.i)];
    const box = el.querySelector("input") as HTMLInputElement;
    box.checked = r.checked;
    box.disabled = !!r.notebook || busy;
    const name = el.querySelector(".name") as HTMLElement, size = el.querySelector(".size") as HTMLElement, why = el.querySelector(".why") as HTMLElement;
    const shown = r.path.replace(/^\/+/, "");
    name.textContent = " " + middle(shown);
    name.title = shown;
    size.textContent = r.notebook ? "this notebook" : r.size === undefined ? "size unknown" : h.fmtSize(r.size);
    why.textContent = r.reason ? reasonText(r.reason) : r.notebook || r.checked ? "" : sel!.state === "analyzing" ? "still analyzing" : sel!.state === "not-analyzed" ? "not analyzed" : "";
  };
  list.addEventListener("scroll", () => draw(), { passive: true });

  const setBusy = (b: boolean) => {
    busy = b;
    btn.setAttribute("aria-busy", String(b));
    list.setAttribute("aria-busy", String(b));
    btn.classList.toggle("busy", b);
    btn.textContent = b ? "Uploading…" : "Upload";
    for (const id of ["#shareall", "#sharenone", "#sharetitlein", "#sharelicense"]) ($(d, id) as HTMLInputElement).disabled = b;
    // (Copy link closes the dialog: not while uploading, CORR-172-ASTRA-4)
    if (linkBtn) linkBtn.disabled = b;
    if (closeBtn) {
      closeBtn.disabled = b;
      closeBtn.title = b ? "Uploading…" : "Close";
    }
    draw();
    if (!b) for (const f of idleWaiters.splice(0)) f();
  };
  // (closing is refused while uploading, UI-4)
  d.addEventListener("cancel", (e) => {
    if (busy) e.preventDefault();
  });
  d.addEventListener("close", () => {
    // (the browser fires close as a queued task: one that arrives once the dialog is open again
    // belongs to a close before this open, which has already reset everything for itself; acting
    // on it would drop the new open's list, train 4's web-sync)
    if (d.open) return;
    // (a close that got through anyway, a second Esc whose cancel can't be refused, or a
    // programmatic close: shown again, the upload's state as it is, UI-B1)
    if (busy) {
      setTimeout(() => busy && !d.open && d.showModal(), 0);
      return;
    }
    token++;
    run?.stop();
    run = null;
    analyzing = false;
    sel = null;
    inner.replaceChildren();
  });
  $(d, "#shareall").addEventListener("click", () => {
    sel?.all(true);
    draw();
  });
  $(d, "#sharenone").addEventListener("click", () => {
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

  async function open() {
    // (while uploading, Share only shows the dialog, the upload's own state: UI-B1)
    if (busy) {
      if (!d.open) d.showModal();
      return;
    }
    const nbId = h.notebookId();
    // (mid-switch there's no notebook to share: the page waits for the switch before opening Share)
    if (nbId === null) {
      status.textContent = "The notebook is changing: open Share again in a moment.";
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
    out.textContent = "";
    prog.textContent = "";
    const nb = h.notebook();
    const files = await h.listFiles();
    if (!alive()) return;
    sel = new Selection(my, { path: "/" + nb.path, size: nb.data.length }, files);
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
      // (the analysis couldn't start: not analyzed, and Upload still works, CORR-SHAREB-3)
      run = null;
      return finish("not-analyzed");
    }
    say();
  }

  btn.addEventListener("click", async () => {
    if (!sel || busy) return;
    // (the selection is this notebook's: never another's bytes with its files, CORR-172-ASTRA-2)
    if (selNotebook === null || h.notebookId() !== selNotebook) {
      out.textContent = "The notebook changed since Share was opened: open Share again.";
      return;
    }
    // (the notebook as it is now, bounded like any file, CORR-172-ASTRA-3)
    const nb = h.notebook();
    const max = h.bounds().maxFileBytes;
    if (max !== undefined && nb.data.length > max) {
      out.textContent = `This notebook (${h.fmtSize(nb.data.length)}) is larger than your plan's largest file.`;
      return;
    }
    const stillRunning = analyzing;
    token++;
    analyzing = false;
    run?.stop();
    run = null;
    if (stillRunning) sel.state = "not-analyzed";
    const snap = sel.snapshot();
    const title = ($(d, "#sharetitlein") as HTMLInputElement).value;
    const license = ($(d, "#sharelicense") as HTMLSelectElement).value;
    setBusy(true);
    out.textContent = "";
    if (stillRunning) status.textContent = "Finding the files stopped: uploading what you checked.";
    try {
      const files: LazyFile[] = snap.map((r) => (r.notebook ? { path: nb.path, size: nb.data.length, read: async () => nb.data } : { path: r.path.replace(/^\/+/, ""), size: r.size, read: () => h.readFile(r) }));
      const r = await h.upload({ files, title, license }, (done, total) => {
        prog.textContent = total ? `uploading ${h.fmtSize(done)} of ${h.fmtSize(total)}` : "";
      });
      prog.textContent = "";
      // (said only once it is true, UI-B3)
      if (stillRunning) status.textContent = "Finding the files stopped: what you checked was uploaded.";
      const a = Object.assign(document.createElement("a"), { href: r.url, target: "_blank", rel: "noopener", textContent: r.url });
      out.replaceChildren(document.createTextNode(r.again ? "A new version is at " : "Shared at "), a, document.createTextNode(". "));
      try {
        await navigator.clipboard.writeText(r.url);
        out.append("Link copied.");
      } catch {}
    } catch (e: any) {
      prog.textContent = "";
      if (stillRunning) status.textContent = "Finding the files stopped: nothing was shared.";
      out.textContent = "Upload failed: " + (e?.message ?? e);
    } finally {
      sel?.thaw();
      setBusy(false);
    }
  });

  return {
    open,
    /** a switch of notebooks: this notebook's open ends (call after idle()) */
    invalidate() {
      if (busy) return;
      token++;
      run?.stop();
      run = null;
      analyzing = false;
      sel = null;
      inner.replaceChildren();
      if (d.open) d.close();
    },
    /** resolves once no upload is running */
    idle(): Promise<void> {
      return busy ? new Promise((r) => idleWaiters.push(r)) : Promise.resolve();
    },
    get busy() {
      return busy;
    },
    /** the notebook the current selection was made for */
    get notebook() {
      return selNotebook;
    },
    get selection() {
      return sel;
    },
    get analyzing() {
      return analyzing;
    },
    get generation() {
      return gen;
    },
  };
}
