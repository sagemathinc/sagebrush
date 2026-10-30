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
import { Workspace, WorkspaceError, LIMITS, type Entry } from "./api";
import { TRASH, freePath, join, nameOf, openableAs, parentOf, splitExt, within, type DocKind } from "./paths";
import { dropFolderVersions, estimate, fmtBytes, openPreview, openStorage } from "./preview";
import { SyncOwner } from "./sync-owner";
import { foot as footText } from "./sync-panel";
import { rowIcons, ROWICON } from "./sync-rows";
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
  /** Hide the file browser (its ✕); none: no ✕. */
  close?(): void;
};

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
const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 2 ** 20 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 2 ** 20).toFixed(1)} MB`);
const fmtWhen = (t: number) => {
  const d = Date.now() - t;
  if (d < 60e3) return "just now";
  if (d < 3600e3) return `${Math.floor(d / 60e3)} min`;
  if (d < 864e5) return `${Math.floor(d / 3600e3)} h`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
};
const LANG: Record<string, string> = { sage: "Sage", magma: "Magma", matlab: "MATLAB" };

const STYLE = `
.sbfiles { display: flex; flex-direction: column; min-height: 0; height: 100%; background: var(--sbf-bg, #f6f5f0); color: var(--sbf-fg, #1f2421); font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
.sbfiles .fh { display: flex; gap: 4px; padding: 10px 10px 6px; align-items: center; }
.sbfiles .fh b { flex: 1; }
.sbfiles .ib { border: 0; background: none; padding: 3px 7px; border-radius: 5px; color: #5d645f; font: inherit; font-size: 15px; line-height: 1; cursor: pointer; }
.sbfiles .ib:hover, .sbfiles .ib:focus-visible { background: #e6e5de; }
.sbfiles .fsearch { margin: 0 10px 6px; border: 1px solid #d4d4cb; border-radius: 6px; padding: 5px 8px; font: inherit; font-size: 13px; background: #fff; }
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
.sbfiles .ffoot { border-top: 1px solid #d4d4cb; padding: 7px 12px; font-size: 12px; color: #5d645f; display: flex; gap: 12px; align-items: center; }
.sbfiles .ffoot .sp { flex: 1; }
.sbfiles .fempty { padding: 12px; color: #5d645f; font-size: 13px; }
.sbfiles .ftoast { margin: 6px 10px; padding: 6px 10px; background: #1f2421; color: #fff; border-radius: 6px; font-size: 13px; display: flex; gap: 10px; align-items: center; }
.sbfiles .ftoast button { background: none; border: 0; color: #b9e0a5; font: inherit; cursor: pointer; text-decoration: underline; }
.sbfmenu { position: fixed; z-index: 1000; background: #fff; border: 1px solid #d4d4cb; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.14); padding: 5px; min-width: 190px; font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; color: #1f2421; }
.sbfmenu button { display: block; width: 100%; text-align: left; border: 0; background: none; padding: 6px 10px; border-radius: 5px; font: inherit; cursor: pointer; color: inherit; }
.sbfmenu button:hover, .sbfmenu button:focus-visible { background: #e6eedf; }
.sbfmenu button.danger { color: #b3261e; }
.sbfmenu hr { border: 0; border-top: 1px solid #d4d4cb; margin: 4px; }
@media (prefers-color-scheme: dark) {
  .sbfiles { --sbf-bg: #1d211e; --sbf-fg: #e4e6e1; }
  .sbfiles .fsearch { background: #161917; color: #e4e6e1; border-color: #39403a; }
  .sbfiles .frow:hover { background: #262b27; } .sbfiles .frow.cur { background: #2b3a29; }
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
function popup(at: HTMLElement, items: ([string, () => void, string?] | "-")[]) {
  document.querySelectorAll(".sbfmenu").forEach((m) => m.remove());
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
  setTimeout(() => { addEventListener("pointerdown", away, true); addEventListener("keydown", esc, true); });
  return menu;
}

export type Browser = { el: HTMLElement; refresh(): Promise<void>; destroy(): void; /** A message in the file browser's toast; `sticky`: kept until closed (✕), as an upload's refusals are. */ say(text: string, sticky?: boolean): void };

export function mountBrowser(container: HTMLElement, host: BrowserHost): Browser {
  style();
  const w = host.ws;
  let entries: Entry[] = [], trashView = false, query = "", toast: { text: string; undo?: () => void; sticky?: boolean } | null = null;
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
  const toastEl = h("div");
  const tree = h("div", { className: "ftree", role: "tree" });
  const foot = h("div", { className: "ffoot" });
  const picker = h("input", { type: "file", multiple: true, hidden: true });
  root.append(head, search, toastEl, tree, foot, picker);
  container.append(root);

  const say = (text: string, undo?: () => void, sticky = false) => {
    toast = { text, undo, sticky };
    renderToast();
    if (!sticky) setTimeout(() => { if (toast?.text === text && !toast.sticky) { toast = null; renderToast(); } }, 8000);
  };
  const renderToast = () => {
    toastEl.replaceChildren();
    if (!toast) return;
    const t = h("div", { className: "ftoast", role: "status" }, h("span", { textContent: toast.text }));
    if (toast.undo) { const u = h("button", { textContent: "Undo" }); const f = toast.undo; u.onclick = () => { toast = null; renderToast(); f(); }; t.append(u); }
    if (toast.sticky) { const x = h("button", { textContent: "✕", title: "Close" }); x.setAttribute("aria-label", "Close"); x.onclick = () => { toast = null; renderToast(); }; t.append(x); }
    toastEl.append(t);
  };
  const fail = (e: unknown) => say(e instanceof WorkspaceError ? e.message : String((e as Error)?.message ?? e));

  // (sync, step 5: the foot's line, "Synced · 2 min ago", … (role=status); hidden with sync off and nothing to say)
  const syncEl = h("button", { className: "ib fsync", title: "Sync: opens the Storage panel" });
  syncEl.setAttribute("role", "status");
  syncEl.onclick = () => storage();
  function showSync() {
    if (!NO_SYNC) {
      const v = SyncOwner.of(w).view().s;
      syncEl.hidden = v.state === "off" && !v.reason;
      syncEl.textContent = v.state === "off" ? (v.reason ? `Sync off: ${v.reason}` : "") : footText(v);
    } else syncEl.hidden = true;
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

  /** Another device's, its content not here yet: a data file not fetched yet, or a document with no content here. */
  function elsewhere(e: Entry) {
    if (!e.remote) return false;
    if (e.kind === "file") return true;
    return (e.kind === "notebook" || e.kind === "board") && !!e.ref && !here[e.kind].has(e.ref);
  }
  function metaOf(e: Entry) {
    if (e.missing) return "missing";
    // (P0 #1: another device's, its content not here yet; and this device's own, renamed by the server's index)
    if (elsewhere(e)) return "on another device";
    if (e.renamed?.to === e.path) return "(renamed)";
    if (e.kind === "file") return fmtSize(e.size ?? 0);
    if (e.kind === "folder") return "";
    return LANG[e.mode ?? ""] ?? "";
  }

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
    r.append(chev, ic, name, si, meta, more);
    if (!trashView) drawnRows.push({ e, si });
    r.onclick = (ev) => {
      if ((ev.target as HTMLElement).closest("input")) return;
      if (e.kind === "folder") { toggle(e.path); return; }
      if (trashView) return;
      // (a .tex file: the LaTeX editor, in a build with it and when it is on; web/latex/boot.ts)
      if (typeof __SB_LATEX__ !== "undefined" && __SB_LATEX__ && e.kind === "file" && (globalThis as any).__sbTex?.(e, ev.ctrlKey || ev.metaKey || ev.button === 1)) return;
      if (e.kind === "file") { preview(e); return; }
      host.open(e, ev.ctrlKey || ev.metaKey || ev.button === 1 ? "tab" : "here");
    };
    r.onauxclick = (ev) => {
      // (a middle-click on a .tex file: the editor in a new tab when it takes the file; any other file, nothing, as before)
      if (typeof __SB_LATEX__ !== "undefined" && __SB_LATEX__ && ev.button === 1 && e.kind === "file") { if (!trashView) (globalThis as any).__sbTex?.(e, true); return; }
      if (ev.button === 1 && e.kind !== "folder" && e.kind !== "file") host.open(e, "tab");
    };
    r.onkeydown = (ev) => {
      if (ev.target !== r) return;
      if (ev.key === "Enter") r.click();
      else if (ev.key === "F2" && !trashView) startRename(r, e);
      else if (ev.key === "Delete" && !trashView) toTrash(e);
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

  function toggle(p: string) {
    if (open.has(p)) open.delete(p); else open.add(p);
    saveOpen();
    render();
  }

  // (while a name is being typed in place, the tree isn't drawn again: a
  // change meanwhile, here or elsewhere, would take the half-typed name
  // away; it is drawn once the name is done)
  let renamingNow = false;
  function render() {
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
      if (!entries.length) tree.append(h("div", { className: "fempty", textContent: "Nothing here yet: New makes a notebook or a board, Upload (or a drop) brings files." }));
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
  const storage = () => openStorage(w, { say, fail, showTrash: () => { trashView = true; refresh(); }, emptyTrash: emptyAll }).then(() => meter());
  const ancestors = (p: string) => { const out: string[] = []; for (let a = parentOf(p); a !== "/"; a = parentOf(a)) out.push(a); return out; };

  function rowMenu(at: HTMLElement, e: Entry) {
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
    // (a file it recognises: opened as what it can be, a converted copy made beside it; the original stays)
    const as = e.kind === "file" && host.openAs ? openableAs(nameOf(e.path)) : null;
    if (as) items.push([as === "notebook" ? "Open as a notebook" : "Open as a board", () => void Promise.resolve(host.openAs!(e, as)).then((m) => { if (m) say(m); }, fail)]);
    if (e.kind === "file") items.push(["Preview and versions", () => preview(e)], "-");
    if (e.kind === "folder") items.push(["New notebook here", () => make(e.path, "notebook")], ["New board here", () => make(e.path, "board")], ["New folder here", () => make(e.path, "folder")], ["Upload here…", () => pick(e.path)], "-");
    items.push(["Rename", () => startRename(r, e)]);
    if (e.kind !== "folder") items.push(["Duplicate", () => w.duplicate(e.path).then((x) => say(`Copied as ${nameOf(x.path)}`)).catch(fail).then(refresh)]);
    if (e.kind === "file") items.push(["Download", () => download(e)]);
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
    if (at && within(at, e.path)) return say("That's open here: open something else first");
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
      const t = await w.remove(e.path);
      // (Undo: that entry, put in Trash that time, if it is still there: CORR-0B0-3)
      say(`"${nameOf(e.path)}" moved to Trash`, () => w.restore(t.path, t).catch(fail).then(refresh));
    } catch (err) { fail(err); }
    refresh();
  }

  function startRename(r: HTMLElement, e: Entry) {
    const nameEl = r.querySelector<HTMLElement>(".n");
    if (!nameEl) return;
    const full = nameOf(e.path);
    // (a document keeps its extension: only its name is edited)
    const [base, ext] = e.kind === "notebook" || e.kind === "board" ? splitExt(full) : [full, ""];
    const input = h("input", { value: base });
    input.setAttribute("aria-label", `New name for ${full}`);
    nameEl.replaceWith(input);
    renamingNow = true;
    input.focus();
    input.select();
    let done = false;
    const finish = async (keep: boolean) => {
      if (done) return;
      done = true;
      renamingNow = false;
      const v = input.value.trim();
      if (keep && v && v !== base) {
        host.renaming?.(e);
        try {
          // (a document renamed since the row was drawn, as by its typed
          // title: where it is now; gone, not renamed.  Whatever it is, only
          // that entry: checked holding the lock, never another put at its
          // path meanwhile, CORR-4B2-1)
          const from = (e.kind === "notebook" || e.kind === "board") && e.ref ? await w.pathOf(e.kind, e.ref) : e.path;
          if (!from) say(`"${full}" was moved or deleted meanwhile: not renamed`);
          else host.renamed?.(await w.rename(from, join(parentOf(from), v + ext), { retitle: !host.retitles?.(e), expect: { kind: e.kind, ref: e.ref, fid: e.fid, created: e.created } }), from);
        } catch (err) {
          if (err instanceof WorkspaceError && err.code === "conflict") say(`"${full}" was moved or replaced meanwhile: not renamed`);
          else fail(err);
        }
      }
      refresh();
    };
    input.onkeydown = (ev) => { ev.stopPropagation(); if (ev.key === "Enter") finish(true); else if (ev.key === "Escape") finish(false); };
    input.onblur = () => finish(true);
  }

  async function make(folder: string, kind: "notebook" | "board" | "folder") {
    const taken = new Set(entries.map((x) => x.path));
    const [base, ext] = kind === "notebook" ? ["Untitled", ".ipynb"] : kind === "board" ? ["Untitled board", ".board.json"] : ["New folder", ""];
    const p = freePath(folder, base, ext, (x) => taken.has(x));
    if (!p) return say("No free name here");
    try {
      // (made by the person here, in the file browser's New: provenance "person", design/capabilities.md §6)
      const e = kind === "folder" ? await w.mkdir(p) : await w.createByPerson(p);
      if (folder !== "/") { open.add(folder); saveOpen(); }
      await refresh();
      const r = tree.querySelector<HTMLElement>(`.frow[data-path="${CSS.escape(e.path)}"]`);
      if (r) startRename(r, e);
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

  function dropTarget(el: HTMLElement, folder: string) {
    el.addEventListener("dragover", (ev) => {
      if (!ev.dataTransfer?.types.includes("Files")) return;
      ev.preventDefault();
      ev.stopPropagation();
      tree.querySelectorAll(".drop").forEach((x) => x.classList.remove("drop"));
      el.classList.add("drop");
    });
    el.addEventListener("dragleave", () => el.classList.remove("drop"));
    el.addEventListener("drop", (ev) => {
      if (!ev.dataTransfer?.files.length) return;
      ev.preventDefault();
      ev.stopPropagation();
      el.classList.remove("drop");
      upload([...ev.dataTransfer.files], folder);
    });
  }
  dropTarget(tree, "/");

  newBtn.onclick = () => popup(newBtn, [["Notebook", () => make("/", "notebook")], ["Board", () => make("/", "board")], ["Folder", () => make("/", "folder")]]);
  upBtn.onclick = () => pick("/");
  moreBtn.onclick = () => popup(moreBtn, [[trashView ? "All files" : "Trash", () => { trashView = !trashView; refresh(); }], ["Storage…", () => storage()]]);
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
  };
}
