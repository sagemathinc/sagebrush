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
import { published, when } from "./versions";

export interface ShareDialogHost extends Omit<PickerHost, "notebook"> {
  dlg: HTMLDialogElement;
  /** the notebook: its file name in the share, and its bytes */
  notebook: () => { path: string; data: Uint8Array };
  /** one file's bytes at upload; throws if it is no longer the file listed (fid) */
  readFile: (f: { path: string; fid?: string }) => Promise<Uint8Array>;
  upload: (o: { files: LazyFile[]; title: string; license: string; author: string }, progress: (done: number, total: number) => void) => Promise<{ url: string; again: boolean; frozen?: string; version?: string }>;
  /** the notebook's edit history as a file to publish with it (a .sbreplay, up to now), or null where it has none */
  history?: () => Promise<{ path: string; data: Uint8Array; versions: number } | null>;
  /** (tests only) every row of the file list shown, and the list open */
  allFiles?: () => boolean;
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
  // (edit history: off unless checked, each open; said plainly either way, with what checking it adds; William, Nov 13)
  const hist = d.querySelector("#sharehist") as HTMLInputElement | null, histNote = d.querySelector("#sharehistnote") as HTMLElement | null;
  let histFile: Promise<{ path: string; data: Uint8Array; versions: number } | null> | null = null;
  // (unchecked: no line, the empty box says it)
  const NO_HISTORY = "";
  if (hist && histNote) {
    if (!h.history) hist.closest("label")!.hidden = histNote.hidden = true;
    hist.addEventListener("change", async () => {
      histNote.hidden = !hist.checked;
      if (!hist.checked) { histNote.textContent = NO_HISTORY; return; }
      histNote.textContent = "History up to this version is included. It can contain text you later deleted.";
      const f = await (histFile ??= h.history!().catch(() => null));
      if (!hist.checked) return;
      histNote.textContent = f
        ? `History up to this version is included (${f.versions} versions). It can contain text you later deleted. Adds ${h.fmtSize(f.data.length)}.`
        : "This notebook has no edit history here to include.";
    });
  }
  // (the Link tab, one screen: one link card, one status line, and one button, shown only when there is something to
  // publish; William, Nov 13: every publish is a version, the link always shows the latest)
  const card = { link: $(d, "#sharecardlink") as HTMLAnchorElement, none: $(d, "#sharecardnone"), copy: $(d, "#sharecardcopy") as HTMLButtonElement, more: $(d, "#sharecardmore") as HTMLButtonElement, menu: $(d, "#sharecardmenu"), version: $(d, "#shareversionlink") as HTMLButtonElement };
  const state = $(d, "#sharestate"), optsum = $(d, "#shareoptsum"), filesum = $(d, "#sharefilesum");
  let pubOpen = 0, count = 0, upToDate = false, optsTouched = false, frozenNow: string | null = null;
  const label = () => (link() ? (count ? `Publish version ${count + 1}` : "Publish new version") : "Publish link");
  // (the button shows unless the share is up to date and nothing in Options was changed)
  const showButton = () => { btn.hidden = !busy && !!link() && upToDate && !optsTouched; btn.textContent = busy ? "Publishing…" : label(); };
  const cardBox = $(d, "#sharecard"), who = $(d, "#sharewho"), stateRow = $(d, ".sharestaterow");
  const setCard = (url: string | null) => {
    cardBox.hidden = !url;
    card.link.hidden = card.copy.hidden = card.more.hidden = !url;
    card.none.hidden = !!url;
    // (the line on who can see it: in the card once there is a link; before, under the button, saying "once")
    who.firstChild!.textContent = url ? "Anyone with the link can view, run and copy it. " : "Once published, anyone with the link can view, run and copy it. ";
    who.classList.toggle("under", !url);
    if (url) cardBox.append(who); else stateRow.after(who);
    card.menu.hidden = true;
    card.more.setAttribute("aria-expanded", "false");
    if (url) { card.link.href = url; card.link.textContent = url.replace(/^https?:\/\//, ""); }
  };
  const copyTo = async (text: string, b: HTMLButtonElement, done = "Copied") => {
    try { await navigator.clipboard.writeText(text); b.textContent = done; } catch { b.textContent = "Couldn't copy"; }
    setTimeout(() => (b.textContent = b === card.copy ? "Copy" : "Copy a link to this version only"), 2000);
  };
  card.copy.addEventListener("click", () => { const u = link(); if (u) void copyTo(u, card.copy); });
  card.more.addEventListener("click", () => { card.menu.hidden = !card.menu.hidden; card.more.setAttribute("aria-expanded", String(!card.menu.hidden)); });
  card.version.addEventListener("click", () => { if (frozenNow) void copyTo(frozenNow, card.version, "Copied: this version only"); card.menu.hidden = true; });
  // (the published state, in one line: which version and when, and whether it has changed since)
  const showPublished = async (url: string) => {
    const me = ++pubOpen, id = new URL(url).pathname.match(/^\/s\/([a-z2-7]{12})/)?.[1];
    setCard(url);
    state.textContent = "Published";
    if (!id) return;
    const p = await published(id, h.notebook()).catch(() => null);
    if (me !== pubOpen || !p) return;
    count = p.count;
    frozenNow = p.latest ? new URL(`/s/${id}@${p.latest.slice(0, 16)}`, url).href : null;
    upToDate = p.changed === "";
    const at = `Version ${p.count} · ${when(p.latestMs)}`;
    state.textContent = p.changed === "" ? `${at} · up to date` : p.changed ? `You've changed it since version ${p.count}: ${p.changed}` : at;
    showButton();
  };
  // (Options, folded, said in one line: title · license · history · files)
  const licenseIn = $(d, "#sharelicense") as HTMLSelectElement, titleField = $(d, "#sharetitlein") as HTMLInputElement;
  const summarize = () => {
    const n = picker?.selection?.summary(h.bounds()).files ?? 1;
    const lic = licenseIn.selectedOptions[0]?.textContent ?? "";
    filesum.textContent = n <= 1 ? "This notebook" : `This notebook and ${n - 1} more file${n === 2 ? "" : "s"}`;
    optsum.textContent = [titleField.value.trim() || "untitled", licenseIn.value ? lic : "no license", hist?.checked ? "with history" : "no history", n === 1 ? "1 file" : `${n} files`].join(" · ");
  };
  const touched = () => { optsTouched = true; summarize(); showButton(); };
  for (const el of ["#sharetitlein", "#shareauthor"]) $(d, el).addEventListener("input", touched);
  for (const el of ["#sharelicense", "#sharehist"]) $(d, el).addEventListener("change", touched);
  // (Add files…: the picker opens only on demand, the notebook and the files it uses shown; the rest by search)
  const pickerBox = $(d, "#sharepicker"), addFiles = $(d, "#shareaddfiles") as HTMLButtonElement, search = $(d, "#sharesearch") as HTMLInputElement;
  let query = "";
  addFiles.addEventListener("click", () => { pickerBox.hidden = !pickerBox.hidden; addFiles.setAttribute("aria-expanded", String(!pickerBox.hidden)); if (!pickerBox.hidden) { draw(); search.focus(); } });
  search.addEventListener("input", () => { query = search.value.trim().toLowerCase(); $(d, "#sharelist").scrollTop = 0; draw(); });
  // (License's ⓘ: one sentence on "None given" and the policies, in place)
  const licInfo = $(d, "#sharelicinfo"), licPop = $(d, "#sharelicpop");
  licInfo.addEventListener("click", () => { licPop.hidden = !licPop.hidden; licInfo.setAttribute("aria-expanded", String(!licPop.hidden)); });
  // (the tabs: Link, Download, Quick link; one shown at a time)
  const tabs = [["#sharetab-link", "#shareup"], ["#sharetab-dl", "#sharepanel-dl"], ["#sharetab-quick", "#sharepanel-quick"]].map(([t, p]) => [$(d, t), $(d, p)] as const);
  const showTab = (k: number) => tabs.forEach(([t, p], i) => { t.setAttribute("aria-selected", String(i === k)); p.hidden = i !== k; });
  tabs.forEach(([t], k) => t.addEventListener("click", () => showTab(k)));
  const picker = createPicker(d, "share", { ...h, notebook: () => { const nb = h.notebook(); return { path: nb.path, size: nb.data.length }; } }, () => busy, (s) => {
    btn.disabled = busy || !!s.over;
    // (under the list, what will be shared: the checked files, not the list's length)
    $(d, "#sharecount").textContent = `Sharing ${s.files} file${s.files === 1 ? "" : "s"}${s.sizesKnown ? ` · ${h.fmtSize(s.bytes)}` : ""}${s.over ? ` — ${s.over}` : ""}`;
    summarize();
  },
    (r) => !!(h.allFiles?.() || r.notebook || r.checked || r.reason || (query && r.path.toLowerCase().includes(query))));
  const { status, draw } = picker;

  const setBusy = (b: boolean) => {
    busy = b;
    btn.setAttribute("aria-busy", String(b));
    $(d, "#sharelist").setAttribute("aria-busy", String(b));
    btn.classList.toggle("busy", b);
    showButton();
    for (const id of ["#shareall", "#sharenone", "#sharetitlein", "#shareauthor", "#sharelicense", "#shareaddfiles", "#sharesearch"]) ($(d, id) as HTMLInputElement).disabled = b;
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
      count = 0; upToDate = false; optsTouched = false; frozenNow = null;
      showTab(0);
      licPop.hidden = true; licInfo.setAttribute("aria-expanded", "false");
      if (histNote) histNote.hidden = true;
      (d.querySelector("#shareopts") as HTMLDetailsElement).open = false;
      pickerBox.hidden = true; addFiles.setAttribute("aria-expanded", "false"); search.value = ""; query = "";
      if (h.allFiles?.()) { (d.querySelector("#shareopts") as HTMLDetailsElement).open = true; pickerBox.hidden = false; }
      if (now) void showPublished(now);
      else { setCard(null); state.textContent = "Not published yet"; }
      showButton();
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
        // (only over the page's default, the notebook's name, or nothing: never over a title typed or set meanwhile)
        const untouched = titleIn.value === "" || titleIn.value === titleIn.dataset.nameDefault;
        if (me === authorOpen && !titleIn.dataset.typed && untouched && typeof c?.manifest?.title === "string" && c.manifest.title) { titleIn.value = c.manifest.title; titleIn.dataset.published = "1"; }
      }, () => {});
    }
    await picker.open("Share");
    // (the summary once the page has set the title: the notebook's name, or the published title read back)
    setTimeout(summarize, 0);
    setTimeout(summarize, 600);
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
    if (stillRunning) status.textContent = state.textContent = "Finding the files stopped: publishing what you checked.";
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
      // (said once it is true, in the one status line: this version's number, and the link (the latest) copied; this
      // version's own link is in the card's ⋯ menu and under Your shares, never piled up here)
      const n = r.again ? (count ? count + 1 : 0) : 1;
      let copied = false;
      try { await navigator.clipboard.writeText(r.url); copied = true; } catch {}
      setCard(r.url);
      count = n; upToDate = true; optsTouched = false; frozenNow = r.frozen ?? null;
      state.textContent = `${n ? `Published version ${n}` : "Published"} · ${copied ? "link copied" : "copy the link above"}`;
      // (the same outcome, with the link, kept out of sight and out of the live announcement (the status line says
      // it): what scripts and tests read back after a publish)
      const sr = document.createElement("span");
      sr.className = "sharesr";
      sr.setAttribute("aria-hidden", "true");
      sr.append(r.again && n > 1 ? `Published version ${n}. ` : "Published. ", copied ? "Link copied: " : "Link: ", Object.assign(document.createElement("a"), { href: r.url, textContent: r.url, tabIndex: -1 }));
      out.replaceChildren(sr);
      // (and the count read back: a publish from another device meanwhile corrects it)
      void showPublished(r.url).then(() => { if (state.textContent?.endsWith("up to date")) state.textContent = `${n ? `Published version ${count}` : "Published"} · ${copied ? "link copied" : "copy the link above"}`; });
    } catch (e: any) {
      prog.textContent = "";
      if (stillRunning) status.textContent = state.textContent = "Finding the files stopped: nothing was published.";
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
