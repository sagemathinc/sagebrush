// The Share dialog's file list and upload (share-ux-plan r2 §1, §3, §4): drawn
// from metadata only (no file is read to open it), virtualized rows in one
// stable order, the files the notebook uses pre-checked as the analysis finds
// them (selection.ts, deps-client.ts), each with why, and an upload of an
// immutable snapshot of the checks, reading only the checked files.
import { Selection, reasonText, type Bounds } from "./selection";
import { startDeps, type WorkerLike } from "./deps-client";
import type { CellKind } from "./file-deps";
import type { LazyFile } from "./upload";

export interface ShareDialogHost {
  dlg: HTMLDialogElement;
  /** the notebook: its file name in the share, and its bytes */
  notebook: () => { path: string; data: Uint8Array };
  /** the workspace's data files, metadata only (no bodies) */
  listFiles: () => Promise<{ path: string; size?: number; fid?: string; rev?: number }[]>;
  /** one file's bytes at upload; throws if it is no longer the file listed (fid) */
  readFile: (f: { path: string; fid?: string }) => Promise<Uint8Array>;
  /** one .py file's text, for the analysis */
  readText: (path: string) => Promise<string>;
  /** the cells, in page order */
  cells: () => { index: number; kind: CellKind; source: string }[];
  /** what each cell's last run read (cell index -> workspace paths) */
  fileReads: () => Map<number, string[]>;
  /** where the notebook's interpreter resolves imports, or null if it can't be asked */
  importInfo: () => Promise<{ cwd: string; importPath: { dir: string; workspace: boolean }[]; builtinModules: string[]; externalModules: string[] } | null>;
  createWorker: () => WorkerLike;
  bounds: () => Bounds;
  upload: (o: { files: LazyFile[]; title: string; license: string }, progress: (done: number, total: number) => void) => Promise<{ url: string; again: boolean }>;
  fmtSize: (n: number) => string;
}

const ROW_H = 40;
const OVERSCAN = 8;
const $ = (root: ParentNode, sel: string) => root.querySelector(sel) as HTMLElement;
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
  let gen = 0, sel: Selection | null = null, run: { stop(): void; running: boolean } | null = null, busy = false;
  let found = 0, unfollowed = 0, ranPartial = false;

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
    summary.textContent = `${s.files.toLocaleString("en-US")} of ${s.of.toLocaleString("en-US")} files${s.sizesKnown ? `, ${h.fmtSize(s.bytes)}` : ""}${s.over ? ` — ${s.over}` : ""}`;
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
      // (Space and Shift+Space: the range from the keyboard, UI-8)
      e.preventDefault();
      if (busy) return;
      sel.toggle(i, e.shiftKey);
      draw();
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
    if (closeBtn) {
      closeBtn.disabled = b;
      closeBtn.title = b ? "Uploading…" : "Close";
    }
    draw();
  };
  // (closing is refused while uploading, UI-4)
  d.addEventListener("cancel", (e) => {
    if (busy) e.preventDefault();
  });
  d.addEventListener("close", () => {
    run?.stop();
    run = null;
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
    const notes = unfollowed ? ` ${unfollowed.toLocaleString("en-US")} file name${unfollowed === 1 ? "" : "s"} computed when the code runs weren't followed.` : "";
    if (sel.state === "analyzing") status.textContent = `Finding the files this notebook uses: ${found.toLocaleString("en-US")} checked…`;
    else if (sel.state === "not-analyzed") status.textContent = `Stopped finding files: the rest are unchecked, not analyzed. ${found ? `Checked ${found} file${found === 1 ? "" : "s"} it uses.` : ""}${notes}`;
    else status.textContent = `${found ? `Checked ${found.toLocaleString("en-US")} file${found === 1 ? "" : "s"} this notebook uses` : "Found no other files this notebook uses"} (from its code${ranPartial ? "" : " and from what ran"}; check the list).${notes}`;
  };

  async function open() {
    run?.stop();
    run = null;
    const my = ++gen;
    found = 0;
    unfollowed = 0;
    out.textContent = "";
    prog.textContent = "";
    const nb = h.notebook();
    const files = await h.listFiles();
    if (my !== gen) return;
    sel = new Selection(my, { path: "/" + nb.path, size: nb.data.length }, files);
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
    if (my !== gen || !sel) return;
    const s = sel;
    run = startDeps({
      gen: my,
      input: {
        cells: h.cells(),
        files: files.map((f) => [f.path, { size: f.size }]),
        cwd: info?.cwd ?? "/",
        // (without the interpreter's answer, imports aren't followed: never a guess)
        importPath: info?.importPath ?? [],
        builtinModules: info?.builtinModules ?? [],
        externalModules: info?.externalModules ?? [],
      },
      readText: h.readText,
      createWorker: h.createWorker,
      handlers: {
        onDep: (path, reason) => {
          if (s.suggest(my, path, reason)) found++;
          draw();
          say();
        },
        onUnfollowed: () => {
          unfollowed++;
        },
        onProgress: () => say(),
        onDone: (r) => {
          if (my !== gen) return;
          s.state = r.complete ? "done" : "not-analyzed";
          if (!info) s.state = "not-analyzed";
          draw();
          say();
        },
      },
    });
    say();
  }

  btn.addEventListener("click", async () => {
    if (!sel || busy) return;
    const stillRunning = !!run?.running;
    run?.stop();
    run = null;
    if (stillRunning) sel.state = "not-analyzed";
    const snap = sel.snapshot();
    const title = ($(d, "#sharetitlein") as HTMLInputElement).value;
    const license = ($(d, "#sharelicense") as HTMLSelectElement).value;
    setBusy(true);
    out.textContent = "";
    if (stillRunning) status.textContent = "Finding the files stopped: what you checked was uploaded.";
    try {
      const nb = h.notebook();
      const files: LazyFile[] = snap.map((r) => (r.notebook ? { path: nb.path, size: nb.data.length, read: async () => nb.data } : { path: r.path.replace(/^\/+/, ""), size: r.size, read: () => h.readFile(r) }));
      const r = await h.upload({ files, title, license }, (done, total) => {
        prog.textContent = total ? `uploading ${h.fmtSize(done)} of ${h.fmtSize(total)}` : "";
      });
      prog.textContent = "";
      const a = Object.assign(document.createElement("a"), { href: r.url, target: "_blank", rel: "noopener", textContent: r.url });
      out.replaceChildren(document.createTextNode(r.again ? "A new version is at " : "Shared at "), a, document.createTextNode(". "));
      try {
        await navigator.clipboard.writeText(r.url);
        out.append("Link copied.");
      } catch {}
    } catch (e: any) {
      prog.textContent = "";
      out.textContent = "Upload failed: " + (e?.message ?? e);
    } finally {
      sel?.thaw();
      setBusy(false);
    }
  });

  return { open, get selection() { return sel; }, get running() { return !!run?.running; } };
}
