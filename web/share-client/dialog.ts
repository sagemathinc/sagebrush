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
import { AUTHOR_HINT, type LazyFile } from "./upload";
import { published, when, linkWithCopy } from "./versions";

export interface ShareDialogHost extends Omit<PickerHost, "notebook"> {
  dlg: HTMLDialogElement;
  /** the notebook: its file name in the share, and its bytes */
  notebook: () => { path: string; data: Uint8Array };
  /** one file's bytes at upload; throws if it is no longer the file listed (fid) */
  readFile: (f: { path: string; fid?: string }) => Promise<Uint8Array>;
  upload: (o: { files: LazyFile[]; title: string; license: string; author: string }, progress: (done: number, total: number) => void) => Promise<{ url: string; again: boolean; frozen?: string; version?: string }>;
  /** the notebook's edit history as a file to publish with it (a .sbreplay, up to now), or null where it has none */
  history?: () => Promise<{ path: string; data: Uint8Array; versions: number } | null>;
  /** the notebook's published link, if it has one (its share_id), else null */
  published?: () => string | null;
}

const $ = (root: ParentNode, sel: string) => root.querySelector(sel) as HTMLElement;
export function createShareDialog(h: ShareDialogHost) {
  const d = h.dlg;
  const btn = $(d, "#shareupload") as HTMLButtonElement, prog = $(d, "#shareprogress"), out = $(d, "#shareresult");
  const closeBtn = d.querySelector("form button") as HTMLButtonElement | null;
  const linkBtn = d.querySelector("#sharelink") as HTMLButtonElement | null;
  // (who it's by, as typed, shown on the page as "by …": any names, or none; never the account's name.  A notebook
  // published before starts with its latest version's, unless the person types first; William, Nov 12)
  const authorIn = $(d, "#shareauthor") as HTMLInputElement;
  authorIn.placeholder = AUTHOR_HINT;
  authorIn.addEventListener("input", () => (authorIn.dataset.typed = "1"));
  let authorOpen = 0;
  let busy = false;
  let idleWaiters: (() => void)[] = [];
  // (the link this open published, until the notebook's own record of it is read at the next open)
  let publishedNow: string | null = null;
  const link = () => publishedNow ?? h.published?.() ?? null;
  // (one button: "Publish link", and once the notebook has a link, "Publish new version": a new frozen version, and the
  // notebook's link moves to it; William, Nov 13: every publish is a version, the link always shows the latest)
  const label = () => (link() ? "Publish new version" : "Publish link");
  const head = $(d, "#sharehead"), pub = $(d, "#sharepub");
  let pubOpen = 0, count = 0;
  // (edit history: off unless checked, each open; said plainly either way, with what checking it adds; William, Nov 13)
  const hist = d.querySelector("#sharehist") as HTMLInputElement | null, histNote = d.querySelector("#sharehistnote") as HTMLElement | null;
  let histFile: Promise<{ path: string; data: Uint8Array; versions: number } | null> | null = null;
  const NO_HISTORY = "Edit history is not included.";
  if (hist && histNote) {
    if (!h.history) hist.closest("label")!.hidden = histNote.hidden = true;
    hist.addEventListener("change", async () => {
      if (!hist.checked) { histNote.textContent = NO_HISTORY; return; }
      histNote.textContent = "History up to this version is included. It can contain text you later deleted.";
      const f = await (histFile ??= h.history!().catch(() => null));
      if (!hist.checked) return;
      histNote.textContent = f
        ? `History up to this version is included (${f.versions} versions). It can contain text you later deleted. Adds ${h.fmtSize(f.data.length)}.`
        : "This notebook has no edit history here to include.";
    });
  }
  const line = (...parts: (string | Node)[]) => { const e = document.createElement("p"); e.className = "note"; e.append(...parts); return e; };
  // (the published state, said plainly at the top: how many versions and when, what changed since, the link to copy)
  const showPublished = async (url: string) => {
    const me = ++pubOpen, id = new URL(url).pathname.match(/^\/s\/([a-z2-7]{12})/)?.[1];
    head.textContent = "Published";
    pub.hidden = false;
    pub.replaceChildren(line("Link (always the latest version): ", linkWithCopy(url)));
    if (!id) return;
    const p = await published(id, h.notebook()).catch(() => null);
    if (me !== pubOpen || !p) return;
    count = p.count;
    const changed = p.changed === "" ? "No changes since then." : p.changed ? `You've changed it since: ${p.changed}.` : "";
    pub.prepend(line(`Published ${p.count === 1 ? "once" : `${p.count} times`}, latest ${when(p.latestMs)}. ${changed}`));
  };
  const picker = createPicker(d, "share", { ...h, notebook: () => { const nb = h.notebook(); return { path: nb.path, size: nb.data.length }; } }, () => busy, (s) => (btn.disabled = busy || !!s.over));
  const { status, draw } = picker;

  const setBusy = (b: boolean) => {
    busy = b;
    btn.setAttribute("aria-busy", String(b));
    $(d, "#sharelist").setAttribute("aria-busy", String(b));
    btn.classList.toggle("busy", b);
    btn.textContent = b ? "Publishing…" : label();
    for (const id of ["#shareall", "#sharenone", "#sharetitlein", "#shareauthor", "#sharelicense"]) ($(d, id) as HTMLInputElement).disabled = b;
    if (hist) hist.disabled = b;
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
      if (hist && histNote) { hist.checked = false; histNote.textContent = NO_HISTORY; histFile = null; }
      const now = link();
      pubOpen++;
      count = 0;
      if (now) void showPublished(now);
      else { head.textContent = "Publish a link"; pub.hidden = true; pub.replaceChildren(); }
      btn.textContent = label();
      const me = ++authorOpen;
      authorIn.value = "";
      delete authorIn.dataset.typed;
      // (and its title: a notebook published before keeps its published title, unless the person types another;
      // William, Nov 13.  Marked, so the page doesn't put the notebook's name over it)
      const titleIn = $(d, "#sharetitlein") as HTMLInputElement;
      delete titleIn.dataset.published;
      delete titleIn.dataset.typed;
      titleIn.oninput = () => (titleIn.dataset.typed = "1");
      const id = now ? new URL(now).pathname.match(/^\/s\/([a-z2-7]{12})/)?.[1] : null;
      if (id) void fetch(`/api/share/c/${id}`, { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : null)).then((c) => {
        if (me === authorOpen && !authorIn.dataset.typed && typeof c?.manifest?.author === "string") authorIn.value = c.manifest.author;
        if (me === authorOpen && !titleIn.dataset.typed && typeof c?.manifest?.title === "string" && c.manifest.title) { titleIn.value = c.manifest.title; titleIn.dataset.published = "1"; }
      }, () => {});
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
    const author = authorIn.value;
    setBusy(true);
    out.textContent = "";
    if (stillRunning) status.textContent = "Finding the files stopped: publishing what you checked.";
    try {
      const files: LazyFile[] = snap.map((r) => (r.notebook ? { path: nb.path, size: nb.data.length, read: async () => nb.data } : { path: r.path.replace(/^\/+/, ""), size: r.size, read: () => h.readFile(r) }));
      // (the history as it is at this publish, made now: nothing after it)
      if (hist?.checked && h.history) {
        const f = await h.history();
        if (f) files.push({ path: f.path, size: f.data.length, read: async () => f.data });
      }
      const r = await h.upload({ files, title, license, author }, (done, total) => {
        prog.textContent = total ? `uploading ${h.fmtSize(done)} of ${h.fmtSize(total)}` : "";
      });
      prog.textContent = "";
      // (said only once it is true, UI-B3)
      if (stillRunning) status.textContent = "Finding the files stopped: what you checked was published.";
      publishedNow = r.url;
      // (said once it is true: this version's number, the link (latest) copied, and this version's own frozen link)
      out.replaceChildren(line(r.again && count ? `Published version ${count + 1}.` : "Published."));
      try {
        await navigator.clipboard.writeText(r.url);
        out.append(line("Link copied: ", linkWithCopy(r.url)));
      } catch {
        out.append(line("Link: ", linkWithCopy(r.url)));
      }
      if (r.frozen) out.append(line("This version only, never changes: ", linkWithCopy(r.frozen)));
      void showPublished(r.url);
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
