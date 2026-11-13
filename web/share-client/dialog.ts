// The Share dialog's file list and upload (share-ux-plan r2 §1, §3, §4): drawn
// from metadata only (no file is read to open it), virtualized rows in one
// stable order, the files the notebook uses pre-checked as the analysis finds
// them (picker.ts, shared with Download's), each with why, and an upload of an
// immutable snapshot of the checks, reading only the checked files.
//
// One open belongs to one notebook (#172 r2's review, CORR-172-ASTRA-2): its
// identity is taken when it opens, checked after every wait and at Upload, and
// a switch of notebooks closes the dialog (the page waits for an upload to end
// first: idle(), invalidate()).  While uploading, the dialog can't be closed:
// a close that gets through (a second Esc, a programmatic close) shows it again,
// and opening Share again only shows it (UI-4, UI-B1).
import { createPicker, type PickerHost } from "./picker";
import type { LazyFile } from "./upload";

export interface ShareDialogHost extends Omit<PickerHost, "notebook"> {
  dlg: HTMLDialogElement;
  /** the notebook: its file name in the share, and its bytes */
  notebook: () => { path: string; data: Uint8Array };
  /** one file's bytes at upload; throws if it is no longer the file listed (fid) */
  readFile: (f: { path: string; fid?: string }) => Promise<Uint8Array>;
  upload: (o: { files: LazyFile[]; title: string; license: string }, progress: (done: number, total: number) => void) => Promise<{ url: string; again: boolean }>;
  /** the notebook's published link, if it has one (its share_id), else null */
  published?: () => string | null;
}

const $ = (root: ParentNode, sel: string) => root.querySelector(sel) as HTMLElement;
export function createShareDialog(h: ShareDialogHost) {
  const d = h.dlg;
  const btn = $(d, "#shareupload") as HTMLButtonElement, prog = $(d, "#shareprogress"), out = $(d, "#shareresult");
  const closeBtn = d.querySelector("form button") as HTMLButtonElement | null;
  const linkBtn = d.querySelector("#sharelink") as HTMLButtonElement | null;
  let busy = false;
  let idleWaiters: (() => void)[] = [];
  // (the link this open published, until the notebook's own record of it is read at the next open)
  let publishedNow: string | null = null;
  const link = () => publishedNow ?? h.published?.() ?? null;
  // (one button: "Publish link", and once the notebook has a link, "Publish again", a new version at the same link)
  const label = () => (link() ? "Publish again" : "Publish link");
  // (the notebook's link, shown in the dialog: where it is now, before and after a publish)
  const showLink = (words: string, url: string) => {
    const a = Object.assign(document.createElement("a"), { href: url, target: "_blank", rel: "noopener", textContent: url });
    out.replaceChildren(document.createTextNode(words), a, document.createTextNode(". "));
  };
  const picker = createPicker(d, "share", { ...h, notebook: () => { const nb = h.notebook(); return { path: nb.path, size: nb.data.length }; } }, () => busy, (s) => (btn.disabled = busy || !!s.over));
  const { status, draw } = picker;

  const setBusy = (b: boolean) => {
    busy = b;
    btn.setAttribute("aria-busy", String(b));
    $(d, "#sharelist").setAttribute("aria-busy", String(b));
    btn.classList.toggle("busy", b);
    btn.textContent = b ? "Publishing…" : label();
    for (const id of ["#shareall", "#sharenone", "#sharetitlein", "#sharelicense"]) ($(d, id) as HTMLInputElement).disabled = b;
    // (Copy link closes the dialog: not while uploading, CORR-172-ASTRA-4)
    if (linkBtn) linkBtn.disabled = b;
    if (closeBtn) {
      closeBtn.disabled = b;
      closeBtn.title = b ? "Publishing…" : "Close";
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
    picker.reset();
  });

  async function open() {
    // (while uploading, Share only shows the dialog, the upload's own state: UI-B1)
    if (busy) {
      if (!d.open) d.showModal();
      return;
    }
    if (h.notebookId() !== null) {
      publishedNow = null;
      out.textContent = "";
      prog.textContent = "";
      const now = link();
      if (now) showLink("Published at ", now);
      btn.textContent = label();
    }
    await picker.open("Share");
  }

  btn.addEventListener("click", async () => {
    if (!picker.selection || busy) return;
    // (the selection is this notebook's: never another's bytes with its files, CORR-172-ASTRA-2)
    if (!picker.mine()) {
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
    const { snap, stillRunning } = picker.take();
    const title = ($(d, "#sharetitlein") as HTMLInputElement).value;
    const license = ($(d, "#sharelicense") as HTMLSelectElement).value;
    setBusy(true);
    out.textContent = "";
    if (stillRunning) status.textContent = "Finding the files stopped: publishing what you checked.";
    try {
      const files: LazyFile[] = snap.map((r) => (r.notebook ? { path: nb.path, size: nb.data.length, read: async () => nb.data } : { path: r.path.replace(/^\/+/, ""), size: r.size, read: () => h.readFile(r) }));
      const r = await h.upload({ files, title, license }, (done, total) => {
        prog.textContent = total ? `uploading ${h.fmtSize(done)} of ${h.fmtSize(total)}` : "";
      });
      prog.textContent = "";
      // (said only once it is true, UI-B3)
      if (stillRunning) status.textContent = "Finding the files stopped: what you checked was published.";
      publishedNow = r.url;
      showLink(r.again ? "Published again at " : "Published at ", r.url);
      try {
        await navigator.clipboard.writeText(r.url);
        out.append("Link copied.");
      } catch {}
    } catch (e: any) {
      prog.textContent = "";
      if (stillRunning) status.textContent = "Finding the files stopped: nothing was published.";
      // (a message that says what happened and what to do next (`plain`: a share deleted, its link let go) stands alone)
      out.textContent = e?.plain ? String(e.message) : "Publishing failed: " + (e?.message ?? e);
    } finally {
      picker.selection?.thaw();
      setBusy(false);
    }
  });

  return {
    open,
    /** a switch of notebooks: this notebook's open ends (call after idle()) */
    invalidate() {
      if (busy) return;
      picker.reset();
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
      return picker.notebook;
    },
    get selection() {
      return picker.selection;
    },
    get analyzing() {
      return picker.analyzing;
    },
    get generation() {
      return picker.generation;
    },
  };
}
