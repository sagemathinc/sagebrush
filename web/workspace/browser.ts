// The file browser (design/workspace-files.md §4): the workspace's tree, in
// both pages: a sidebar (on a phone, a full-screen sheet).  Folders open and
// close; an icon for each kind; Recent at the top; a search; each row's ⋯
// (Open, Open in a new tab, Rename, Duplicate, Download, Copy path, Move to
// Trash); New (notebook, board, folder) and Upload; files dropped on a
// folder are uploaded there; Trash, with Restore and, for the person alone,
// Delete forever and Empty Trash.  Opening is the page's (host.open).
// A data file opens its preview, with its earlier versions; a folder's ⋯
// deletes older versions in it; the foot's meter opens the Storage panel
// (preview.ts, step 2b).
import { Workspace, WorkspaceError, LIMITS, type Entry, type TrashGate } from "./api";
import { TRASH, freePath, join, nameOf, parentOf, splitExt, within, type DocKind } from "./paths";
import { fileHead, openableAsFile } from "./upload";
import { dropFolderVersions, estimate, fmtBytes, openPreview, openStorage } from "./preview";
import { SyncOwner } from "./sync-owner";
import { readNotebooks, sidebarLine, type Notebooks, type ReadUnacked } from "./sync-panel";
import { rowIcons, ROWICON } from "./sync-rows";
import { fileRowMeta, fmtSize, isElsewhere } from "./row-meta";
import { fileLabel, NEW_ITEMS } from "./filemenu";
// (built with __SB_NO_SYNC__ (the board frame and exports, web/build.ts): no sync owner, panel or client is in that
// copy; elsewhere the define is absent or false, and everything is as before)
declare const __SB_NO_SYNC__: boolean | undefined;
// (the LaTeX editor's define: true only in a build with it, web/build.ts; false or absent, its hooks fold away)
declare const __SB_LATEX__: boolean | undefined;
const NO_SYNC = typeof __SB_NO_SYNC__ !== "undefined" && __SB_NO_SYNC__;

export type BrowserHost = {
  ws: Workspace;
  /** The document open in the page, if any: known by its id, wherever it is
   * moved to meanwhile (here, or in another tab). */
  current?: () => { kind: "notebook" | "board"; ref: string } | undefined;
  /** Open an entry: in this page, or in a new tab. */
  open(e: Entry, how: "here" | "tab"): void;
  /** A file the page opens in an editor of its own rather than the file preview (the board page: a .tex file in the
   * LaTeX editor, on the notebook page's /?tex=); true if it took the file. (The notebook page's own hook, __sbTex,
   * is web/latex/boot.ts's.) */
  openFile?(e: Entry, tab: boolean): boolean;
  /** New ▸ LaTeX document, in `folder` (the page's LaTeX editor: web/latex/boot.ts); none: not offered (U0). */
  newLatex?(folder: string): void;
  /** New ▸ From an example… (the page's examples); none: not offered (U0). */
  fromExample?(): void;
  /** A data file of a kind the page recognises opened as a document: a converted copy beside it (upload.ts, design §3); none: not offered. */
  openAs?(e: Entry, as: DocKind): void | Promise<void | string>;
  /** Upload files into a folder (the notebook page tells Python); else the browser writes them itself. */
  upload?(files: File[], folder: string): Promise<void | string>;
  /** An entry about to be renamed here: its rename asked for anywhere else on the page is superseded. */
  renaming?(e: Entry): void;
  /** Whether the page has this document open and retitles it itself (in renamed), saved with its other changes. */
  retitles?(e: Entry): boolean;
  /** An entry renamed or moved here, from `was` (the page retitles what it has open). */
  renamed?(e: Entry, was: string): void;
  /** (tests) the notebooks' count the sync line reads (readNotebooks), else the history database's */
  readUnacked?: ReadUnacked;
  /** Hide the file browser (its ✕); none: no ✕. */
  close?(): void;
  /** The Storage panel's "Export all current files (.zip)" (export plan E1 r2c): where the lazy export chunk's files
   * are, and this tab's open documents saved first; without exportUrl, not offered. */
  exportUrl?: (file: string) => string;
  /** Share folder… on a folder's ⋯ (book links B2): the page's dialog; without it, not offered */
  shareFolder?: (e: Entry) => void;
  saveOpen?: () => Promise<void>;
  /** The document open in the page (e, or inside the folder e) is about to go to Trash: the page saves what it has
   * yet to save, then opens another document in its place. A string: not done, and why (it stays open, nothing is
   * moved). None: the page can't, and an open document isn't moved to Trash. */
  trashing?(e: Entry): Promise<string | void | TrashGate>;
  /** Every Move to Trash of what is open here, once it has settled (moved, refused or failed): `gate` is what trashing
   * returned (none if it refused), `moved` what went to Trash if it did (the page releases its navigation hold, and
   * tells a navigation that waited into it, with `dropped`). */
  trashDone?(gate: TrashGate | undefined, moved?: TrashMoved): void;
};
/** What went to Trash, for a navigation that waited into it (#447 r5c, board's (A)): said as not opened, with Restore
 * and open while it can still be put back (`open` opens the notebook asked for once it is). */
export type TrashMoved = { entry: Entry; dropped(name: string, open: () => Promise<unknown>): void };

const OPEN_KEY = "sagebrush-files-open";
const RECENT = 5;
/** At most this many rows drawn at once; past it, a row says how many more (LIMIT-0B0-2). */
const MAX_ROWS = 1000;

const ICONS: Record<string, string> = {
  notebook: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="1.5" width="11" height="13" rx="1.5" fill="none" stroke="#2a6fb0" stroke-width="1.4"/><path d="M5 5h6M5 8h6M5 11h4" stroke="#2a6fb0" stroke-width="1.3"/></svg>',
  board: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="#8a3b8f" stroke-width="1.4"/><rect x="3.5" y="5" width="4" height="3" rx=".6" fill="#8a3b8f"/><rect x="9" y="8.5" width="3.5" height="3" rx=".6" fill="#8a3b8f"/></svg>',
  table: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="1" fill="none" stroke="#0b7a52" stroke-width="1.4"/><path d="M1.5 6h13M1.5 9.5h13M6 2.5v11M10.5 2.5v11" stroke="#0b7a52" stroke-width="1"/></svg>',
  image: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="#975200" stroke-width="1.4"/><circle cx="5.5" cy="6" r="1.4" fill="#975200"/><path d="M2.5 12.5l4-4 3 3 2-2 3 3" fill="none" stroke="#975200" stroke-width="1.2"/></svg>',
  file: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 1.5h6l3 3v10h-9z" fill="none" stroke="#5f665f" stroke-width="1.4"/><path d="M5.5 7.5h5M5.5 10h5M5.5 12.5h3" stroke="#5f665f" stroke-width="1"/></svg>',
  folder: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 4a1 1 0 0 1 1-1h3.5l1.5 1.5h6a1 1 0 0 1 1 1V12.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" fill="#d8cfa8" stroke="#a89a5c" stroke-width="1"/></svg>',
};
const iconOf = (e: Entry) => {
  if (e.kind !== "file") return ICONS[e.kind];
  const ext = splitExt(nameOf(e.path))[1].toLowerCase();
  if ([".csv", ".tsv", ".xlsx", ".xls"].includes(ext)) return ICONS.table;
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(ext)) return ICONS.image;
  return ICONS.file;
};
const fmtWhen = (t: number) => {
  const d = Date.now() - t;
  if (d < 60e3) return "just now";
  if (d < 3600e3) return `${Math.floor(d / 60e3)} min`;
  if (d < 864e5) return `${Math.floor(d / 3600e3)} h`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

const STYLE = `
.sbfiles { display: flex; flex-direction: column; min-height: 0; height: 100%; background: var(--sbf-bg, #f6f5f0); color: var(--sbf-fg, #1f2421); font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
.sbfiles .fh { display: flex; gap: 4px; padding: 10px 10px 6px; align-items: center; }
.sbfiles .fh b { flex: 1; }
.sbfiles .ib { border: 0; background: none; padding: 3px 7px; border-radius: 5px; color: #5d645f; font: inherit; font-size: 15px; line-height: 1; cursor: pointer; }
.sbfiles .ib:hover, .sbfiles .ib:focus-visible { background: #e6e5de; }
/* (U2, William: "Selecting a checkbox MUST NOT move the checkbox or row". The search box and the selection bar share
   one slot, stacked in a grid cell, both always laid out (the bar hidden by visibility, not display): its height never
   changes, so nothing under it moves; while rows are selected the bar covers the search box) */
.sbfiles .ftop { display: grid; margin: 0 10px 6px; }
.sbfiles .ftop > * { grid-area: 1 / 1; min-width: 0; }
.sbfiles.selecting .fsearch { visibility: hidden; }
.sbfiles .fsearch { margin: 0; border: 1px solid #d4d4cb; border-radius: 6px; padding: 5px 8px; font: inherit; font-size: 13px; background: #fff; }
.sbfiles .ftree { flex: 1; overflow: auto; padding: 0 4px 8px; }
.sbfiles .fgrp { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #5d645f; padding: 8px 8px 3px; }
.sbfiles .frow { display: flex; align-items: center; gap: 7px; padding: 3px 4px 3px 8px; border-radius: 6px; white-space: nowrap; cursor: pointer; user-select: none; }
.sbfiles .frow:hover { background: #ecebe4; }
.sbfiles .frow:focus-visible { outline: 2px solid #4a6b49; outline-offset: -2px; }
.sbfiles .frow.cur { background: #e6eedf; font-weight: 600; }
.sbfiles .frow.drop { outline: 2px dashed #4a6b49; background: #eef4ea; }
.sbfiles .frow.missing .n, .sbfiles .frow.elsewhere .n { color: #8a8f8b; font-style: italic; }
.sbfiles .frow .ic { width: 16px; height: 16px; flex: none; display: inline-flex; }
.sbfiles .frow .ic svg { width: 16px; height: 16px; }
.sbfiles .frow .chev { width: 10px; color: #8a8f8b; font-size: 10px; flex: none; }
.sbfiles .frow .n { overflow: hidden; text-overflow: ellipsis; flex: 1; }
.sbfiles .frow .m { color: #5d645f; font-size: 11.5px; }
.sbfiles .frow .si { color: #5d645f; font-size: 11.5px; }
.sbfiles .fsync { font-size: 12px; max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sbfiles .frow .more { visibility: hidden; }
.sbfiles .frow:hover .more, .sbfiles .frow:focus-within .more, .sbfiles .frow.cur .more { visibility: visible; }
.sbfiles .frow input { flex: 1; font: inherit; padding: 1px 4px; border: 1px solid #4a6b49; border-radius: 4px; min-width: 0; }
.sbfiles .frow .extnote { flex: none; font-size: 11.5px; color: #8a5a00; }
/* (B2: a row's checkbox, at its left: shown on the row pointed at or focused, and on every row while any is selected) */
/* (a span with role=checkbox, not an <input>: a row's one input stays its name typed in place) */
.sbfiles .frow .sel { flex: none; box-sizing: border-box; width: 14px; height: 14px; border: 1.5px solid #8a8f8b; border-radius: 3px; display: inline-flex; align-items: center; justify-content: center; font-size: 10px; line-height: 1; color: #fff; cursor: pointer; visibility: hidden; }
.sbfiles .frow .sel[aria-checked=true] { background: #4a6b49; border-color: #4a6b49; }
.sbfiles .frow:hover .sel, .sbfiles .frow:focus-within .sel, .sbfiles.selecting .frow .sel { visibility: visible; }
.sbfiles .frow.picked { background: #e6eedf; }
.sbfiles .fsel { display: flex; gap: 8px; align-items: center; margin: 0; padding: 0 0 0 4px; font-size: 12.5px; color: #5d645f; background: var(--sbf-bg, #f6f5f0); }
.sbfiles .fsel[hidden] { display: flex; visibility: hidden; }
.sbfiles .fsel input { margin: 0; cursor: pointer; }
.sbfiles .fsel .sp { flex: 1; }
.sbfiles .ffoot { border-top: 1px solid #d4d4cb; padding: 7px 12px; font-size: 12px; color: #5d645f; display: flex; gap: 12px; align-items: center; }
.sbfiles .ffoot .sp { flex: 1; }
.sbfiles .fempty { padding: 12px; color: #5d645f; font-size: 13px; }
.sbfiles .ftoastslot { flex: none; }
.sbfiles .ftoast { margin: 6px 10px; padding: 6px 10px; background: #1f2421; color: #fff; border-radius: 6px; font-size: 13px; display: flex; gap: 10px; align-items: center; box-shadow: 0 2px 8px rgba(0,0,0,.12); }
.sbfiles .ftoast span { flex: 1; min-width: 0; }
.sbfiles .ftoast button { background: none; border: 0; color: #b9e0a5; font: inherit; cursor: pointer; text-decoration: underline; }
.sbfiles .ftoast.err { background: #fdecea; color: #7a2418; border: 1px solid #e0897c; font-weight: 500; }
.sbfiles .ftoast.err::before { content: "⚠"; font-weight: 700; }
.sbfiles .ftoast.err button { color: #7a2418; }
.sbfmenu { position: fixed; z-index: 1000; background: #fff; border: 1px solid #d4d4cb; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.14); padding: 5px; min-width: 190px; font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; color: #1f2421; }
.sbfmenu button { display: block; width: 100%; text-align: left; border: 0; background: none; padding: 6px 10px; border-radius: 5px; font: inherit; cursor: pointer; color: inherit; }
.sbfmenu button:hover, .sbfmenu button:focus-visible { background: #e6eedf; }
.sbfmenu button.danger { color: #b3261e; }
.sbfmenu hr { border: 0; border-top: 1px solid #d4d4cb; margin: 4px; }
@media (prefers-color-scheme: dark) {
  .sbfiles { --sbf-bg: #1d211e; --sbf-fg: #e4e6e1; }
  .sbfiles .fsearch { background: #161917; color: #e4e6e1; border-color: #39403a; }
  .sbfiles .frow:hover { background: #262b27; } .sbfiles .frow.cur, .sbfiles .frow.picked { background: #2b3a29; }
  .sbfmenu { background: #1d211e; color: #e4e6e1; border-color: #39403a; } .sbfmenu button:hover { background: #2b3a29; }
}
`;
let styled = false;
function style() {
  if (styled) return;
  styled = true;
  document.head.append(Object.assign(document.createElement("style"), { textContent: STYLE }));
}
// (an element: its properties set, "style" as text, its children)
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "style") el.setAttribute("style", String(v));
    else (el as any)[k] = v;
  }
  el.append(...kids);
  return el;
}

/** A popup menu at an element: [label, action] pairs, "-" a rule; closes on a choice, Esc or a click elsewhere. */
type Item = [string, () => void, string?] | "-";
function popup(at: HTMLElement, items: Item[]) {
  // (one open before closed as it closes itself, its listeners too: else its Escape, still listening, took a later
  //  key, a name being typed in place's)
  document.querySelectorAll(".sbfmenu").forEach((m) => ((m as any).sbClose ?? (() => m.remove()))());
  const menu = h("div", { className: "sbfmenu", role: "menu" });
  for (const it of items) {
    if (it === "-") { menu.append(h("hr")); continue; }
    const [label, act, cls] = it;
    const b = h("button", { role: "menuitem", textContent: label, className: cls ?? "" });
    b.onclick = (ev) => { ev.stopPropagation(); close(); act(); };
    menu.append(b);
  }
  // (inside the window, measured: below the element, else above it; scrolling if the window is too short: LIMIT-0B0-3)
  menu.style.maxHeight = `${Math.max(80, innerHeight - 8)}px`;
  menu.style.overflowY = "auto";
  menu.style.visibility = "hidden";
  document.body.append(menu);
  const r = at.getBoundingClientRect(), m = menu.getBoundingClientRect();
  const left = Math.max(4, Math.min(r.left, innerWidth - m.width - 4));
  const below = r.bottom + 2, above = r.top - 2 - m.height;
  const top = below + m.height <= innerHeight - 4 ? below : above >= 4 ? above : Math.max(4, innerHeight - 4 - m.height);
  menu.style.left = left + "px";
  menu.style.top = top + "px";
  menu.style.visibility = "";
  (menu.querySelector("button") as HTMLElement | null)?.focus();
  const close = () => { menu.remove(); removeEventListener("pointerdown", away, true); removeEventListener("keydown", esc, true); };
  const away = (ev: Event) => { if (!menu.contains(ev.target as Node)) close(); };
  const esc = (ev: KeyboardEvent) => { if (ev.key === "Escape") { close(); at.focus(); } };
  (menu as any).sbClose = close;
  setTimeout(() => { if (menu.isConnected) { addEventListener("pointerdown", away, true); addEventListener("keydown", esc, true); } });
  return menu;
}

export type Browser = { el: HTMLElement; refresh(): Promise<void>; destroy(): void; /** A message in the file browser's toast; `sticky`: kept until closed (✕), as an upload's refusals are. */ say(text: string, sticky?: boolean): void;
  /** "Export all current files (.zip)": the Storage panel, its export started (File ▸ Download ▸ Everything) */ exportAll(): void };

export function mountBrowser(container: HTMLElement, host: BrowserHost): Browser {
  style();
  const w = host.ws;
  let entries: Entry[] = [], trashView = false, query = "", toast: { text: string; undo?: () => unknown; sticky?: boolean; error?: boolean; label?: string } | null = null;
  const open = new Set<string>(JSON.parse((() => { try { return localStorage.getItem(OPEN_KEY) ?? "[]"; } catch { return "[]"; } })()));
  const saveOpen = () => { try { localStorage.setItem(OPEN_KEY, JSON.stringify([...open].slice(-500))); } catch {} };

  const root = h("aside", { className: "sbfiles" });
  root.setAttribute("aria-label", "Files");
  const head = h("div", { className: "fh" }, h("b", { textContent: "Files" }));
  const newBtn = h("button", { className: "ib", textContent: "＋", title: "New notebook, board or folder" });
  const upBtn = h("button", { className: "ib", textContent: "⇪", title: "Upload files from this computer" });
  const moreBtn = h("button", { className: "ib", textContent: "⋯", title: "Trash, Storage" });
  newBtn.setAttribute("aria-label", "New");
  upBtn.setAttribute("aria-label", "Upload");
  moreBtn.setAttribute("aria-label", "More");
  head.append(newBtn, upBtn, moreBtn);
  if (host.close) {
    const x = h("button", { className: "ib", textContent: "✕", title: "Hide the files" });
    x.setAttribute("aria-label", "Hide the files");
    x.onclick = () => host.close!();
    head.append(x);
  }
  const search = h("input", { className: "fsearch", placeholder: "Search files", type: "search" });
  search.setAttribute("aria-label", "Search files");
  // (the toast at the foot of the files, under the list (board's (d)): a message never moves a row; while it shows the
  // list is that much shorter at its bottom, and what it covers scrolls into view)
  const toastEl = h("div", { className: "ftoastslot" });
  const tree = h("div", { className: "ftree", role: "tree" });
  const foot = h("div", { className: "ffoot" });
  const picker = h("input", { type: "file", multiple: true, hidden: true });
  // (B2, William: rows selected by their checkboxes; a click toggles one, a shift-click the range from the last one
  // clicked, in the order shown; the bar above the list says how many, selects or clears them all, and acts on them.
  // Only rows drawn in the tree are selectable (not Recent's, not Trash's): a row that stops being drawn (its folder
  // closed, a search) leaves the selection, so an action never reaches a row out of sight)
  const selected = new Set<string>();
  let anchor: string | null = null;
  // (U4: the rows being dragged within the list, by path; their drag data's type, which a drop from outside never has)
  let dragging: string[] | null = null;
  const MOVE_TYPE = "application/x-sagebrush-paths";
  const selAll = h("input", { type: "checkbox" });
  selAll.setAttribute("aria-label", "Select all shown");
  const selCount = h("span");
  const selDownload = h("button", { className: "ib", textContent: "Download", title: "Download the selected files", style: "font-size:12.5px" });
  const selClear = h("button", { className: "ib", textContent: "Clear", title: "Clear the selection (Esc)", style: "font-size:12.5px" });
  const selBar = h("div", { className: "fsel", hidden: true }, selAll, selCount, h("span", { className: "sp" }), selDownload, selClear);
  selBar.setAttribute("role", "toolbar");
  selBar.setAttribute("aria-label", "Selected files");
  root.append(head, h("div", { className: "ftop" }, search, selBar), tree, toastEl, foot, picker);
  container.append(root);

  // (a toast that isn't sticky goes after 10 s, but never while it is pointed at or holds the focus: its Undo is still
  // being reached for)
  const hideLater = (t: NonNullable<typeof toast>, ms: number) => setTimeout(() => {
    if (toast !== t) return;
    if (toastEl.matches(":hover") || toastEl.contains(document.activeElement)) return void hideLater(t, 2000);
    toast = null;
    renderToast();
  }, ms);
  const say = (text: string, undo?: () => unknown, sticky = false, error = false, label = "Undo") => {
    toast = { text, undo, sticky, error, label };
    renderToast();
    if (!sticky) hideLater(toast, 10_000);
  };
  // (focus once the toast it was in has gone: the row given, else the current one, else the list's first; never the body)
  const focusList = (path?: string) => {
    const r = (path ? tree.querySelector<HTMLElement>(`.frow[data-path="${CSS.escape(path)}"]`) : null) ?? tree.querySelector<HTMLElement>(".frow.cur") ?? tree.querySelector<HTMLElement>(".frow");
    r?.focus();
  };
  const renderToast = () => {
    toastEl.replaceChildren();
    if (!toast) return;
    // (an error looks like one, and is announced as one: role=alert, kept until closed)
    const t = h("div", { className: toast.error ? "ftoast err" : "ftoast", role: toast.error ? "alert" : "status" }, h("span", { textContent: toast.text }));
    // (Undo: the focus to the list meanwhile, its row after; another action (Restore and open) takes the focus itself)
    if (toast.undo) { const label = toast.label ?? "Undo", u = h("button", { textContent: label }); const f = toast.undo; u.onclick = () => { toast = null; renderToast(); if (label === "Undo") focusList(); void f(); }; t.append(u); }
    if (toast.sticky) { const x = h("button", { textContent: "✕", title: "Dismiss" }); x.setAttribute("aria-label", "Dismiss"); x.onclick = () => { const had = toastEl.contains(document.activeElement); toast = null; renderToast(); if (had) focusList(); }; t.append(x); }
    toastEl.append(t);
  };
  const sayError = (text: string) => say(text, undefined, true, true);
  const fail = (e: unknown) => sayError(e instanceof WorkspaceError ? e.message : String((e as Error)?.message ?? e));

  // (sync, step 5: the foot's line, "Synced · 2 min ago", … (role=status); hidden with sync off and nothing to say)
  const syncEl = h("button", { className: "ib fsync", title: "Sync: opens the Storage panel" });
  syncEl.setAttribute("role", "status");
  syncEl.onclick = () => storage();
  // (the notebooks' words (readNotebooks) as last read, kept while the state is the same, so the line doesn't flicker;
  // a read is drawn only if no newer draw began meanwhile)
  let syncGen = 0, sideNb: { state: string; nb: Notebooks | undefined } | null = null;
  function showSync() {
    if (NO_SYNC) { syncEl.hidden = true; return; }
    const o = SyncOwner.of(w), v = o.view().s, gen = ++syncGen;
    const draw = (nb: Notebooks | undefined) => {
      syncEl.textContent = sidebarLine(v, Date.now(), nb);
      syncEl.hidden = !syncEl.textContent;
    };
    draw(sideNb?.state === v.state ? sideNb.nb : undefined);
    if (v.state === "off") return;
    readNotebooks(o, host.readUnacked).then((nb) => {
      if (gen !== syncGen) return;
      sideNb = { state: v.state, nb };
      draw(nb);
    }, () => {});
  }
  // (the rows drawn by the last render, and that render's icons: an older read never paints a newer render's rows)
  let drawnRows: { e: Entry; si: HTMLElement }[] = [], iconGen = 0;
  function paintIcons() {
    if (!NO_SYNC) {
      const rows = drawnRows, gen = ++iconGen;
      const ids = rows.map((r) => r.e.ident).filter((x): x is string => !!x).slice(0, ROWICON.max);
      if (!rows.length) return;
      rowIcons(w, ids, rows.map((r) => r.e.path)).then((ic) => {
        if (gen !== iconGen) return;
        for (const { e, si } of rows) {
          const marks: string[] = [];
          if (e.ident && ic.up.has(e.ident)) marks.push("↑");
          if (ic.conflict.has(e.path) || (e.ident && ic.tooLarge.has(e.ident))) marks.push("⚠");
          si.textContent = marks.join(" ");
          const why = [e.ident && ic.up.has(e.ident) ? "waiting to go up" : "", ic.conflict.has(e.path) ? "conflict copy" : "", e.ident && ic.tooLarge.has(e.ident) ? "too large to sync yet" : ""].filter(Boolean).join(", ");
          si.title = why;
          si.setAttribute("aria-label", why);
        }
      }, () => {});
    }
  }

  // (each folder's entries, sorted, built once per refresh: LIMIT-0B0-2)
  let byParent = new Map<string, Entry[]>();
  // (P0 #1: the documents whose content is in this browser, read at each refresh, so another device's that hasn't
  // arrived reads "on another device", and stops as soon as it is here)
  let here: { notebook: Set<string>; board: Set<string> } = { notebook: new Set(), board: new Set() };
  async function refresh() {
    try { entries = await w.list(trashView ? TRASH : "/", { recursive: true }); } catch (e) { fail(e); }
    if (entries.some((e) => e.remote && (e.kind === "notebook" || e.kind === "board"))) here = await w.contentIds().catch(() => here);
    byParent = new Map();
    for (const e of entries) {
      const p = parentOf(e.path);
      let l = byParent.get(p);
      if (!l) byParent.set(p, (l = []));
      l.push(e);
    }
    for (const l of byParent.values()) l.sort((a, b) => (a.kind === "folder" ? 0 : 1) - (b.kind === "folder" ? 0 : 1) || a.path.localeCompare(b.path));
    const cur = host.current?.();
    curPath = cur ? entries.find((e) => e.kind === cur.kind && e.ref === cur.ref)?.path : undefined;
    render();
    meter(false);
  }
  const children = (folder: string) => byParent.get(folder) ?? [];
  // (the open document's path, as of the latest refresh)
  let curPath: string | undefined;

  // (P0 #1: the row's words, row-meta.ts: another device's whose content isn't here, and this device's own renamed by
  // the server's index)
  const elsewhere = (e: Entry) => isElsewhere(e, here);
  const metaOf = (e: Entry) => fileRowMeta(e, here);

  function row(e: Entry, depth: number, opts: { recent?: boolean } = {}) {
    const r = h("div", { className: "frow", tabIndex: 0 });
    r.setAttribute("role", "treeitem");
    r.dataset.path = e.path;
    r.style.paddingLeft = 8 + depth * 16 + "px";
    if (curPath === e.path) r.classList.add("cur");
    if (e.missing) r.classList.add("missing");
    if (elsewhere(e)) r.classList.add("elsewhere");
    const isOpen = e.kind === "folder" && (open.has(e.path) || query !== "");
    if (e.kind === "folder") r.setAttribute("aria-expanded", String(isOpen));
    const chev = h("span", { className: "chev", textContent: e.kind === "folder" ? (isOpen ? "▾" : "▸") : "" });
    const ic = h("span", { className: "ic", innerHTML: iconOf(e) });
    const name = h("span", { className: "n", textContent: nameOf(e.path), title: elsewhere(e) ? `${e.path}: on another device; its content arrives once that device syncs it` : e.renamed?.to === e.path ? `${e.path}: renamed from ${nameOf(e.renamed.from)}: another device has one with that name` : e.path });
    const meta = h("span", { className: "m", textContent: opts.recent ? fmtWhen(e.updated) : metaOf(e) });
    const more = h("button", { className: "ib more", textContent: "⋯", title: "More" });
    more.setAttribute("aria-label", `More: ${nameOf(e.path)}`);
    // (its sync icon, painted after the render (sync-rows.ts), as text a screen reader says too)
    const si = h("span", { className: "si" });
    const selectable = !opts.recent && !trashView;
    if (selectable) {
      const on = selected.has(e.path);
      const cb = h("span", { className: "sel", textContent: on ? "✓" : "" });
      cb.setAttribute("role", "checkbox");
      cb.setAttribute("aria-checked", String(on));
      cb.setAttribute("aria-label", `Select ${nameOf(e.path)}`);
      cb.onclick = (ev) => { ev.stopPropagation(); pick1(e.path, !selected.has(e.path), ev.shiftKey); };
      r.dataset.sel = "1";
      if (selected.has(e.path)) r.classList.add("picked");
      r.append(cb);
      // (U4: a row dragged onto a folder moves there; a selected row carries the whole selection)
      r.draggable = true;
      r.addEventListener("dragstart", (ev) => {
        if (renamingNow || !ev.dataTransfer) return void ev.preventDefault();
        dragging = selected.has(e.path) ? [...selected] : [e.path];
        ev.dataTransfer.setData(MOVE_TYPE, JSON.stringify(dragging));
        ev.dataTransfer.effectAllowed = "move";
      });
      r.addEventListener("dragend", () => { dragging = null; tree.querySelectorAll(".drop").forEach((x) => x.classList.remove("drop")); });
    }
    r.append(chev, ic, name, si, meta, more);
    if (!trashView) drawnRows.push({ e, si });
    r.onclick = (ev) => {
      if ((ev.target as HTMLElement).closest("input")) return;
      // (a shift-click on a row while some are selected extends the selection to it, rather than opening it)
      if (ev.shiftKey && selectable && selected.size) { pick1(e.path, true, true); return; }
      if (e.kind === "folder") { toggle(e.path); return; }
      if (trashView) return;
      // (a .tex file: the LaTeX editor, in a build with it and when it is on; web/latex/boot.ts)
      if (typeof __SB_LATEX__ !== "undefined" && __SB_LATEX__ && e.kind === "file" && (globalThis as any).__sbTex?.(e, ev.ctrlKey || ev.metaKey || ev.button === 1)) return;
      // (a code or text file: the code page, where the notebook page has installed it; web/code/boot.ts)
      if (e.kind === "file" && (globalThis as any).__sbCode?.(e, ev.ctrlKey || ev.metaKey || ev.button === 1)) return;
      // (U1: a page with an editor of its own for the file, the board page's .tex)
      if (e.kind === "file" && host.openFile?.(e, ev.ctrlKey || ev.metaKey || ev.button === 1)) return;
      if (e.kind === "file") { preview(e); return; }
      host.open(e, ev.ctrlKey || ev.metaKey || ev.button === 1 ? "tab" : "here");
    };
    r.onauxclick = (ev) => {
      // (a middle-click on a file: in a new tab, the LaTeX editor for a .tex it takes (in a build with it), else the code
      // page for a code or text file (where the notebook page has installed it), else, in a build without the editor,
      // the page's own (a board's .tex); any other file, nothing, as before)
      if (ev.button === 1 && e.kind === "file") {
        if (trashView) return;
        const latex = typeof __SB_LATEX__ !== "undefined" && __SB_LATEX__, g = globalThis as any;
        if (!(latex && g.__sbTex?.(e, true)) && !g.__sbCode?.(e, true) && !latex) host.openFile?.(e, true);
        return;
      }
      if (ev.button === 1 && e.kind !== "folder" && e.kind !== "file") host.open(e, "tab");
    };
    r.onkeydown = (ev) => {
      if (ev.target !== r) return;
      if (ev.key === "Enter") r.click();
      else if (ev.key === "F2" && !trashView) startRename(r, e);
      else if (ev.key === "Delete" && !trashView) toTrash(e);
      else if (ev.key === " " && selectable) { ev.preventDefault(); pick1(e.path, !selected.has(e.path), ev.shiftKey); }
      else if (ev.key === "Escape" && selected.size) clearSel();
      else if (ev.key === "ArrowRight" && e.kind === "folder" && !open.has(e.path)) toggle(e.path);
      else if (ev.key === "ArrowLeft" && e.kind === "folder" && open.has(e.path)) toggle(e.path);
      else if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        const rows = [...tree.querySelectorAll<HTMLElement>(".frow")], i = rows.indexOf(r);
        rows[i + (ev.key === "ArrowDown" ? 1 : -1)]?.focus();
        ev.preventDefault();
      }
    };
    r.oncontextmenu = (ev) => { ev.preventDefault(); rowMenu(r, e); };
    more.onclick = (ev) => { ev.stopPropagation(); rowMenu(more, e); };
    if (e.kind === "folder" && !trashView) dropTarget(r, e.path);
    return r;
  }

  // (B2: the selectable rows as drawn, in order)
  const selRows = () => [...tree.querySelectorAll<HTMLElement>(".frow[data-sel]")];
  // (one row's checkbox set to `on`; with shift, every row from the last one clicked to it, in the order shown)
  function pick1(path: string, on: boolean, shift: boolean) {
    const paths = selRows().map((r) => r.dataset.path!);
    const i = anchor === null ? -1 : paths.indexOf(anchor), j = paths.indexOf(path);
    const range = shift && i >= 0 && j >= 0 ? paths.slice(Math.min(i, j), Math.max(i, j) + 1) : [path];
    for (const p of range) if (on) selected.add(p); else selected.delete(p);
    anchor = path;
    paintSel();
  }
  function clearSel() {
    selected.clear();
    anchor = null;
    paintSel();
  }
  // (the rows' checkboxes and marks, and the bar, from the selection, without drawing the tree again)
  function paintSel() {
    const rows = selRows();
    let shown = 0;
    for (const r of rows) {
      const on = selected.has(r.dataset.path!);
      if (on) shown++;
      r.classList.toggle("picked", on);
      const cb = r.querySelector<HTMLElement>(".sel");
      if (cb) { cb.setAttribute("aria-checked", String(on)); cb.textContent = on ? "✓" : ""; }
    }
    root.classList.toggle("selecting", selected.size > 0);
    selBar.hidden = selected.size === 0;
    selCount.textContent = `${selected.size} selected`;
    selAll.checked = rows.length > 0 && shown === rows.length;
    selAll.indeterminate = shown > 0 && shown < rows.length;
  }
  selAll.onchange = () => {
    if (selAll.checked) for (const r of selRows()) selected.add(r.dataset.path!);
    else selected.clear();
    anchor = null;
    paintSel();
  };
  selClear.onclick = () => { clearSel(); focusList(); };
  selDownload.onclick = async () => {
    const files = entries.filter((e) => selected.has(e.path) && e.kind === "file");
    const skipped = selected.size - files.length;
    if (!files.length) {
      if (host.exportUrl) say("Only files download: no file is selected", () => storage(true), false, false, "Export all (.zip)");
      else say("Only files download: no file is selected");
      return;
    }
    // (one after another: a browser asks once before a page downloads several files)
    for (const e of files) await download(e);
    // (what isn't a file: offered the whole workspace as one .zip, which holds folders, notebooks and boards)
    const text = `${files.length} file${files.length === 1 ? "" : "s"} downloaded` + (skipped ? ` (${skipped} not a file: folders, notebooks and boards have their own export)` : "");
    if (skipped && host.exportUrl) say(text, () => storage(true), false, false, "Export all (.zip)");
    else say(text);
  };

  function toggle(p: string) {
    if (open.has(p)) open.delete(p); else open.add(p);
    saveOpen();
    render();
  }

  // (while a name is being typed in place, the tree isn't drawn again: a
  // change meanwhile, here or elsewhere, would take the half-typed name
  // away; it is drawn once the name is done)
  let renamingNow = false;
  // (a row that had the focus keeps it across a redraw: the same path's new row takes it, so a refresh (a file
  // opened, a change from elsewhere) never drops the focus to the body)
  function render() {
    const a = document.activeElement as HTMLElement | null;
    const fp = a && tree.contains(a) ? a.dataset.path : undefined;
    renderTree();
    if (fp !== undefined && !tree.contains(document.activeElement)) tree.querySelector<HTMLElement>(`.frow[data-path="${CSS.escape(fp)}"]`)?.focus();
  }
  function renderTree() {
    if (renamingNow) return;
    drawnRows = [];
    tree.replaceChildren();
    const q = query.toLowerCase();
    if (trashView) {
      tree.append(h("div", { className: "fgrp", textContent: "Trash" }));
      const top = children(TRASH);
      if (!top.length) tree.append(h("div", { className: "fempty", textContent: "Trash is empty." }));
      for (const e of top) if (!q || nameOf(e.path).toLowerCase().includes(q)) tree.append(row(e, 0));
    } else {
      if (!q) {
        const recent = entries.filter((e) => e.kind !== "folder" && !e.missing).sort((a, b) => b.updated - a.updated).slice(0, RECENT);
        if (recent.length > 1) {
          tree.append(h("div", { className: "fgrp", textContent: "Recent" }));
          for (const e of recent) tree.append(row(e, 0, { recent: true }));
        }
        tree.append(h("div", { className: "fgrp", textContent: "This browser" }));
      }
      const shown = q ? new Set(entries.filter((e) => nameOf(e.path).toLowerCase().includes(q)).flatMap((e) => ancestors(e.path).concat(e.path))) : null;
      let drawn = 0, more = 0;
      const frag = document.createDocumentFragment();
      const walk = (folder: string, depth: number) => {
        for (const e of children(folder)) {
          if (shown && !shown.has(e.path)) continue;
          if (drawn >= MAX_ROWS) { more++; continue; }
          frag.append(row(e, depth));
          drawn++;
          if (e.kind === "folder" && (open.has(e.path) || shown)) walk(e.path, depth + 1);
        }
      };
      walk("/", 0);
      tree.append(frag);
      if (more) tree.append(h("div", { className: "fempty", textContent: `${more} more not shown${q ? ": search for more of the name" : ": close some folders, or search"}` }));
      if (!entries.length) {
        const empty = h("div", { className: "fempty", textContent: "Nothing here yet: New makes a notebook or a board, Upload (or a drop) brings files." });
        // (on a phone, where the panel's own buttons may be out of reach: a LaTeX document and the examples here too)
        if (host.newLatex) empty.append(" ", h("button", { textContent: "New " + fileLabel("newLatex"), onclick: () => host.newLatex!("/") }));
        if (host.fromExample) empty.append(" ", h("button", { textContent: fileLabel("fromExample"), onclick: () => host.fromExample!() }));
        tree.append(empty);
      }
    }
    foot.replaceChildren();
    const trashLink = h("button", { className: "ib", textContent: trashView ? "← All files" : "Trash", style: "font-size:12px" });
    trashLink.onclick = () => { trashView = !trashView; refresh(); };
    foot.append(trashLink, syncEl, h("span", { className: "sp" }));
    paintIcons();
    if (trashView && children(TRASH).length) {
      const empty = h("button", { className: "ib", textContent: "Empty Trash…", style: "font-size:12px;color:#b3261e" });
      empty.onclick = emptyAll;
      foot.append(empty);
    } else foot.append(meterEl);
    // (B2: a selected row no longer drawn (its folder closed, a search, Trash shown, gone) leaves the selection)
    const drawn = new Set(selRows().map((r) => r.dataset.path!));
    for (const p of selected) if (!drawn.has(p)) selected.delete(p);
    if (anchor !== null && !drawn.has(anchor)) anchor = null;
    paintSel();
  }
  async function emptyAll() {
    if (!confirm("Delete everything in Trash for good? This can't be undone: their histories and old versions go too.")) return;
    try { const n = await w.emptyTrash(); say(`${n} item${n === 1 ? "" : "s"} deleted for good`); } catch (e) { fail(e); }
    refresh();
  }
  // (the storage meter, "34 MB used of 2.1 GB": opens the Storage panel; asked again at most every few seconds)
  const meterEl = h("button", { className: "ib fmeter", style: "font-size:12px", title: "Storage in this browser" });
  meterEl.onclick = () => storage();
  let meterAt = 0;
  async function meter(force = true) {
    if (!force && Date.now() - meterAt < 5000) return;
    meterAt = Date.now();
    const est = await estimate();
    meterEl.textContent = est ? `${fmtBytes(est.usage)} of ${fmtBytes(est.quota)}` : "Storage";
  }
  const preview = (e: Entry) => openPreview(w, e, { say, fail }).then(() => meter());
  const storage = (startExport = false) => openStorage(w, { say, fail, showTrash: () => { trashView = true; refresh(); }, emptyTrash: emptyAll, exportUrl: host.exportUrl, saveOpen: host.saveOpen, startExport }).then(() => meter());
  const ancestors = (p: string) => { const out: string[] = []; for (let a = parentOf(p); a !== "/"; a = parentOf(a)) out.push(a); return out; };

  async function rowMenu(at: HTMLElement, e: Entry) {
    if (trashView) {
      popup(at, [
        ["Restore", () => w.restore(e.path).then((x) => say(`Restored to ${x.path}`)).catch(fail).then(refresh)],
        "-",
        ["Delete for good…", () => {
          if (!confirm(`Delete "${nameOf(e.path)}" for good? This can't be undone.`)) return;
          w.emptyTrash([e.path]).then(() => say(`"${nameOf(e.path)}" deleted for good`)).catch(fail).then(refresh);
        }, "danger"],
      ]);
      return;
    }
    const r = tree.querySelector<HTMLElement>(`.frow[data-path="${CSS.escape(e.path)}"]`) ?? at;
    const items: ([string, () => void, string?] | "-")[] = [];
    if (e.kind === "notebook" || e.kind === "board") items.push(["Open", () => host.open(e, "here")], ["Open in a new tab", () => host.open(e, "tab")], "-");
    // (a file it recognises: opened as what it can be, a converted copy made beside it; the original stays; a .md
    //  by its first 4 KiB, read in at most 300 ms, else by its name: a Jupytext MyST one is a notebook)
    const as = e.kind === "file" && host.openAs ? openableAsFile(nameOf(e.path), /\.md$/i.test(e.path) ? await fileHead(w, e.path, LIMITS.maxBoardBytes) : null) : null;
    if (as) items.push([as === "notebook" ? "Open as a notebook" : "Open as a board", () => void Promise.resolve(host.openAs!(e, as)).then((m) => { if (m) say(m); }, fail)]);
    if (e.kind === "file") items.push(["Preview and versions", () => preview(e)], "-");
    if (e.kind === "folder") items.push(["New notebook here", () => make(e.path, "notebook")], ["New board here", () => make(e.path, "board")], ...(host.newLatex ? [["New LaTeX document here", () => host.newLatex!(e.path)] as Item] : []), ["New folder here", () => make(e.path, "folder")], ["Upload here…", () => pick(e.path)], "-");
    items.push(["Rename", () => startRename(r, e)]);
    if (e.kind !== "folder") items.push(["Duplicate", () => w.duplicate(e.path).then((x) => say(`Copied as ${nameOf(x.path)}`)).catch(fail).then(refresh)]);
    if (e.kind === "file") items.push(["Download", () => download(e)]);
    if (e.kind === "folder" && host.shareFolder) items.push(["Share folder…", () => host.shareFolder!(e)]);
    items.push(["Copy path", () => navigator.clipboard?.writeText(e.path).then(() => say("Path copied"), () => say(e.path))]);
    // (only a person deletes old versions, §2.5)
    if (e.kind === "folder" && w.actor === "person") items.push(["Delete older versions in this folder…", () => dropFolderVersions(w, e.path, { say, fail }).then(meter)]);
    items.push("-", ["Move to Trash", () => toTrash(e), "danger"]);
    popup(at, items);
  }

  async function download(e: Entry) {
    try {
      const { content } = await w.read(e.path);
      const url = URL.createObjectURL(new Blob([content]));
      const a = h("a", { href: url, download: nameOf(e.path) });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) { fail(err); }
  }

  async function toTrash(e: Entry) {
    const cur = host.current?.(), at = cur ? await w.pathOf(cur.kind, cur.ref).catch(() => undefined) : undefined;
    // (the document open here, or a folder it is in: the page saves it and opens another in its place first, so what
    // goes to Trash is what was last seen, and Undo opens it again; a page that can't, says so and moves nothing)
    const wasOpen = cur && at && within(at, e.path) ? cur : null;
    // (the page's own condition for the move, checked by the workspace holding its lock (astra's R2 on #447), and its
    // navigation held from then until the move settles, told here once it has, whatever happened (astra3's
    // B1-R4-CODE-1, #447 r5c))
    let gate: TrashGate | undefined, moved: Entry | undefined;
    if (wasOpen) {
      if (!host.trashing) return sayError(`Not moved to Trash: "${nameOf(at!)}" is open on this page, and this page can't close it`);
      const r = await host.trashing(e).catch((err: unknown) => String((err as Error)?.message ?? err));
      if (typeof r === "string") { host.trashDone?.(undefined); return sayError(`Not moved to Trash: ${r}`); }
      gate = r || undefined;
    }
    try { await toTrashGated(e, wasOpen, gate, (t) => (moved = t)); }
    finally {
      if (wasOpen) host.trashDone?.(gate, moved && {
        entry: moved,
        // (a navigation that waited into what went: not opened (board's (A)); Restore and open while it is still there)
        dropped: (name, open) => {
          const text = `“${name}” was moved to Trash, so it wasn't opened.`;
          void w.stat(moved!.path).then((x) => {
            if (!x || x.created !== moved!.created || x.fid !== moved!.fid) return say(text);
            say(text, async () => {
              try { await w.restore(moved!.path, moved!); } catch (err) { await refresh(); return fail(err); }
              await refresh();
              await open();
            }, false, false, "Restore and open");
          }, () => say(text));
        },
      });
    }
  }
  async function toTrashGated(e: Entry, wasOpen: ReturnType<NonNullable<BrowserHost["current"]>> | null, gate: TrashGate | undefined, done: (t: Entry) => void) {
    // (a file too large to move beside the index can't go to Trash: deleted for good, asked first, never read)
    if (e.kind === "file" && e.unmoved) {
      if (!confirm(`"${nameOf(e.path)}" is too large to put in Trash (${fmtSize(e.size ?? 0)}, kept by an older version of Sagebrush). Delete it for good? To keep it, Download it first.`)) return;
      try {
        await w.discard(e.path, e);
        say(`"${nameOf(e.path)}" deleted for good`);
      } catch (err) { fail(err); }
      return refresh();
    }
    try {
      // (by its identity: whatever is at that path now, if not the entry chosen (replaced meanwhile, as across the
      // trashing hook's waits), is refused, astra's R1 on #447)
      const t = await w.remove(e.path, e, undefined, gate ?? {});
      done(t);
      // (Undo: that entry, put in Trash that time, if it is still there: CORR-0B0-3)
      // (and the document that was open, open again where Undo put it back)
      const reopen = async () => {
        if (!wasOpen) return;
        const p = await w.pathOf(wasOpen.kind, wasOpen.ref);
        const back = p ? await w.stat(p) : undefined;
        if (back) host.open(back, "here");
      };
      // (Undo: back where it was, the document open again, and the focus on its row)
      say(`"${nameOf(e.path)}" moved to Trash`, async () => {
        let back: Entry | undefined;
        try { back = await w.restore(t.path, t); await reopen(); } catch (err) { fail(err); }
        await refresh();
        if (back) focusList(back.path);
      });
    } catch (err) { fail(err); }
    refresh();
  }

  // (after: called once the name is settled, with the entry as it is then (renamed or not), or null when it was moved,
  // deleted or not renamed for a conflict meanwhile)
  function startRename(r: HTMLElement, e: Entry, after?: (now: Entry | null) => void) {
    const nameEl = r.querySelector<HTMLElement>(".n");
    if (!nameEl) return;
    const full = nameOf(e.path);
    // (a document keeps its extension: only its name is edited)
    const [base, ext] = e.kind === "notebook" || e.kind === "board" ? splitExt(full) : [full, ""];
    // (U9, William Nov 2: a file's box holds its whole name with only the base selected; a name typed without an
    // extension keeps the old one; a different extension is allowed and said beside the box while it is typed, before
    // Enter (or leaving the box) renames. A folder's name is all name)
    const file = e.kind === "file", fileExt = file ? splitExt(full)[1] : "";
    // (a notebook's or board's name typed with its own extension gets it once, not twice: sage's n8 walkthrough,
    // "chapter1.ipynb.ipynb"; the extension alone is no name, and leaves the old one)
    const stem = (v: string) => (ext && v.toLowerCase().endsWith(ext.toLowerCase()) ? v.slice(0, -ext.length).trimEnd() : v);
    const finalName = (v: string) => (file && fileExt && !splitExt(v)[1] ? v + fileExt : !stem(v) ? full : stem(v) + ext);
    const input = h("input", { value: base });
    input.setAttribute("aria-label", `New name for ${full}`);
    const note = h("span", { className: "extnote" });
    note.setAttribute("role", "status");
    const sayExt = () => {
      const typed = splitExt(input.value.trim())[1];
      note.textContent = file && typed && typed.toLowerCase() !== fileExt.toLowerCase() ? `changes the file type: ${fileExt || "(none)"} → ${typed}` : "";
    };
    input.addEventListener("input", sayExt);
    nameEl.replaceWith(input);
    input.after(note);
    renamingNow = true;
    input.focus();
    if (file && fileExt) input.setSelectionRange(0, full.length - fileExt.length);
    else input.select();
    let done = false;
    const finish = async (keep: boolean) => {
      if (done) return;
      done = true;
      renamingNow = false;
      note.remove();
      const v = input.value.trim();
      let now: Entry | null = e;
      if (keep && v && finalName(v) !== full) {
        host.renaming?.(e);
        try {
          // (a document renamed since the row was drawn, as by its typed
          // title: where it is now; gone, not renamed.  Whatever it is, only
          // that entry: checked holding the lock, never another put at its
          // path meanwhile, CORR-4B2-1)
          const from = (e.kind === "notebook" || e.kind === "board") && e.ref ? await w.pathOf(e.kind, e.ref) : e.path;
          // (gone, or put in Trash meanwhile (another tab, an agent): either way not renamed, and not opened)
          if (!from || within(from, TRASH)) { now = null; say(`"${full}" was moved or deleted meanwhile: not renamed`); }
          else {
            // (the rename first, then the host told: an optional call evaluates nothing, its arguments included, when the
            // host has no `renamed`, as File ▸ Open…'s hasn't (sim run 11, X05: every rename there was silently dropped))
            now = await w.rename(from, join(parentOf(from), finalName(v)), { retitle: !host.retitles?.(e), expect: { kind: e.kind, ref: e.ref, fid: e.fid, created: e.created } });
            host.renamed?.(now, from);
          }
        } catch (err) {
          now = null;
          if (err instanceof WorkspaceError && err.code === "conflict") say(`"${full}" was moved or replaced meanwhile: not renamed`);
          else fail(err);
        }
      }
      refresh();
      after?.(now);
    };
    input.onkeydown = (ev) => { ev.stopPropagation(); if (ev.key === "Enter") finish(true); else if (ev.key === "Escape") finish(false); };
    input.onblur = () => finish(true);
  }

  // (a new notebook or board is opened once its name is settled (Enter, or Esc keeping "Untitled"), as a click on its
  // row opens it: sage's n8 walkthrough found the page left on the notebook before, and typing went there; a folder
  // stays as it is.  mode: a notebook's language, as MATLAB notebook's)
  async function make(folder: string, kind: "notebook" | "board" | "folder", mode?: string) {
    const taken = new Set(entries.map((x) => x.path));
    const [base, ext] = kind === "notebook" ? ["Untitled", ".ipynb"] : kind === "board" ? ["Untitled board", ".board.json"] : ["New folder", ""];
    const p = freePath(folder, base, ext, (x) => taken.has(x));
    if (!p) return say("No free name here");
    try {
      // (made by the person here, in the file browser's New: provenance "person", design/capabilities.md §6)
      const e = kind === "folder" ? await w.mkdir(p) : await w.createByPerson(p, mode ? { mode } : {});
      if (folder !== "/") { open.add(folder); saveOpen(); }
      await refresh();
      const opens = (now: Entry | null) => { if (now && kind !== "folder") host.open(now, "here"); };
      const r = tree.querySelector<HTMLElement>(`.frow[data-path="${CSS.escape(e.path)}"]`);
      if (r) startRename(r, e, opens);
      else opens(e);
    } catch (err) { fail(err); }
  }

  async function upload(all: File[], folder: string) {
    // (as many new names as the folder has room for, counted before any file is read; a name already
    // there is written over and takes no room; the workspace checks again as it writes: LIMIT-0B0-1)
    const here = new Set(children(folder).map((e) => nameOf(e.path)));
    let room = Math.max(0, LIMITS.maxFolderEntries - here.size);
    const files: File[] = [], refused: string[] = [];
    for (const f of all) {
      if (here.has(f.name)) files.push(f);
      else if (room > 0) { room--; here.add(f.name); files.push(f); }
      else refused.push(f.name);
    }
    if (refused.length) say(`${folder === "/" ? "The top folder" : folder} is full (${LIMITS.maxFolderEntries} entries): not added: ${refused.slice(0, 5).join(", ")}${refused.length > 5 ? ` and ${refused.length - 5} more` : ""}`);
    if (!files.length) return;
    // (an upload's summary, its refusals in it, kept until closed)
    if (host.upload) return host.upload(files, folder).then((m) => { if (m) say(m, undefined, /not added/i.test(m)); refresh(); });
    for (const f of files) {
      if (f.size > LIMITS.maxFileBytes) { refused.push(f.name); continue; }
      try { await w.putFile(join(folder, f.name), new Uint8Array(await f.arrayBuffer())); } catch (err) { refused.push(f.name); fail(err); }
    }
    const added = files.length - refused.length + (all.length - files.length);
    say(`${added} file${added === 1 ? "" : "s"} added` + (refused.length ? `; not added: ${refused.slice(0, 5).join(", ")}` : ""));
    if (folder !== "/") { open.add(folder); saveOpen(); }
    refresh();
  }
  let pickFolder = "/";
  const pick = (folder: string) => { pickFolder = folder; picker.click(); };
  picker.onchange = () => { const fs = [...(picker.files ?? [])]; picker.value = ""; if (fs.length) upload(fs, pickFolder); };

  // (U4: of the rows being dragged, those that can move into `folder`: not one already there, not a folder into itself
  // or below itself, and not one inside another being moved (it goes with its folder))
  const movable = (folder: string) => {
    const d = dragging ?? [];
    return d.filter((p) => parentOf(p) !== folder && !within(folder, p) && !d.some((q) => q !== p && within(p, q)));
  };
  // (files dropped from outside: uploaded into the folder; rows of this list dropped: moved into it. `folder` is the
  // folder's path, or for the list itself where the drop lands: a file row's own folder, else the top folder)
  function dropTarget(el: HTMLElement, folder: string | ((ev: DragEvent) => string)) {
    const at = (ev: DragEvent) => (typeof folder === "string" ? folder : folder(ev));
    el.addEventListener("dragover", (ev) => {
      const types = ev.dataTransfer?.types ?? [];
      const rows = types.includes(MOVE_TYPE);
      if (!types.includes("Files") && !rows) return;
      ev.preventDefault();
      ev.stopPropagation();
      tree.querySelectorAll(".drop").forEach((x) => x.classList.remove("drop"));
      if (rows && !movable(at(ev)).length) { ev.dataTransfer!.dropEffect = "none"; return; }
      if (rows) ev.dataTransfer!.dropEffect = "move";
      el.classList.add("drop");
    });
    el.addEventListener("dragleave", () => el.classList.remove("drop"));
    el.addEventListener("drop", (ev) => {
      if (ev.dataTransfer?.types.includes(MOVE_TYPE)) {
        ev.preventDefault();
        ev.stopPropagation();
        el.classList.remove("drop");
        const to = at(ev), paths = movable(to);
        dragging = null;
        if (paths.length) void moveInto(to, paths);
        return;
      }
      if (!ev.dataTransfer?.files.length) return;
      ev.preventDefault();
      ev.stopPropagation();
      el.classList.remove("drop");
      upload([...ev.dataTransfer.files], at(ev));
    });
  }
  dropTarget(tree, (ev) => {
    const r = (ev.target as Element | null)?.closest?.<HTMLElement>(".frow[data-path]");
    return r ? parentOf(r.dataset.path!) : "/";
  });
  // (U4: rows moved into a folder, one at a time, each the way Rename moves one: a document found by its id wherever it
  // is now, checked holding the lock, the page told so it retitles what it has open. A name already taken there, or a
  // move that fails, is said and the rest still move; Undo moves back what moved)
  async function moveInto(folder: string, paths: string[]) {
    const where = folder === "/" ? "the top folder" : `"${nameOf(folder)}"`;
    const moved: { from: string; to: string; e: Entry }[] = [], problems: string[] = [];
    const expect = (e: Entry) => ({ kind: e.kind, ref: e.ref, fid: e.fid, created: e.created });
    for (const p of paths) {
      const e = entries.find((x) => x.path === p);
      if (!e) { problems.push(`"${nameOf(p)}" is gone`); continue; }
      try {
        const from = (e.kind === "notebook" || e.kind === "board") && e.ref ? await w.pathOf(e.kind, e.ref) : e.path;
        if (!from) { problems.push(`"${nameOf(p)}" was moved or deleted meanwhile`); continue; }
        const to = join(folder, nameOf(from));
        if (await w.stat(to)) { problems.push(`${where} already has a "${nameOf(from)}"`); continue; }
        host.renaming?.(e);
        const got = await w.rename(from, to, { retitle: !host.retitles?.(e), expect: expect(e) });
        host.renamed?.(got, from);
        moved.push({ from, to: got.path, e: got });
      } catch (err) {
        problems.push(`"${nameOf(p)}": ${err instanceof WorkspaceError && err.code === "conflict" ? "moved or replaced meanwhile" : String((err as Error)?.message ?? err)}`);
      }
    }
    if (folder !== "/" && moved.length) { open.add(folder); saveOpen(); }
    for (const m of moved) selected.delete(m.from);
    await refresh();
    paintSel();
    const undo = async () => {
      for (const m of [...moved].reverse()) {
        // (as in a rename: the move back made whether or not the host has `renamed`)
        try { host.renaming?.(m.e); const back = await w.rename(m.to, m.from, { retitle: !host.retitles?.(m.e), expect: expect(m.e) }); host.renamed?.(back, m.to); }
        catch (err) { fail(err); break; }
      }
      await refresh();
    };
    const what = moved.length === 1 ? `"${nameOf(moved[0].from)}"` : `${moved.length} items`;
    if (problems.length) sayError(`${moved.length ? `Moved ${what} to ${where}; n` : "N"}ot moved: ${problems.join("; ")}`);
    else if (moved.length) say(`Moved ${what} to ${where}`, undo);
  }

  // (New, in File ▸ New's order and words: filemenu.ts NEW_ITEMS, U0)
  newBtn.onclick = () => popup(newBtn, NEW_ITEMS.flatMap((id): Item[] => {
    const go = id === "newNotebook" ? () => make("/", "notebook") : id === "newBoard" ? () => make("/", "board") : id === "newFolder" ? () => make("/", "folder") : id === "newLatex" ? host.newLatex && (() => host.newLatex!("/")) : host.fromExample;
    return go ? [[fileLabel(id), go]] : [];
  }));
  upBtn.onclick = () => pick("/");
  // (Download everything: the Storage panel's export, offered here too, where a person looks for it)
  moreBtn.onclick = () => popup(moreBtn, [[trashView ? "All files" : "Trash", () => { trashView = !trashView; refresh(); }], ["Storage…", () => storage()], ...(host.exportUrl ? [["Download everything (.zip)…", () => storage(true)] as [string, () => unknown]] : [])]);
  // (the search drawn once typing pauses: LIMIT-0B0-2)
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  search.oninput = () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { searchTimer = null; query = search.value.trim(); render(); }, 150);
  };

  // (changes from this tab, other tabs and agents: shown, at most a few times a second)
  let pending: ReturnType<typeof setTimeout> | null = null;
  const unwatch = w.watch(() => { if (!pending) pending = setTimeout(() => { pending = null; refresh(); }, 150); });
  // (sync, step 5: the foot's line, from the page's sync owner; the rows' icons on its transitions too, at most every
  // ROWICON.minGapMs)
  const owner = NO_SYNC ? null : SyncOwner.of(w);
  let iconTimer: ReturnType<typeof setTimeout> | null = null;
  const unowner = owner ? owner.onChange(() => {
    showSync();
    if (!iconTimer) iconTimer = setTimeout(() => { iconTimer = null; paintIcons(); }, ROWICON.minGapMs);
  }) : () => {};
  showSync();
  refresh();
  return {
    el: root,
    refresh,
    destroy() { unwatch(); unowner(); if (iconTimer) clearTimeout(iconTimer); root.remove(); },
    say: (text: string, sticky?: boolean) => say(text, undefined, !!sticky),
    exportAll: () => { if (host.exportUrl) void storage(true); else say("Export all isn't offered here"); },
  };
}
