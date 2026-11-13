// The one File menu, identical in both editors (design/workspace-files.md
// §3): the same items in the same order, with the same keys; an item that
// means nothing for this document is shown disabled, not hidden.  This
// module draws it (and New ▸, Recent ▸ and Download ▸ as groups that open
// in place, which works the same on a phone); fileopen.ts keeps the list of
// documents opened recently and shows the file browser as the Open… dialog.  What
// each item does is the page's: each page keys the items as its tests and
// handlers know them (the notebook's data-f, the board's data-sbb).
// (no import of the workspace here: the board library draws this menu in
// exported files and frames too; the Open… dialog and Recent are fileopen.ts)

/** New ▸'s items, in the file panel's + order (U0, William Nov 2: one order in every editor and in the file panel). */
export const NEW_ITEMS: FileItem[] = ["newNotebook", "newBoard", "newLatex", "newFolder", "fromExample"];
/** An item's words, the same everywhere it is offered. */
export const fileLabel = (id: FileItem) => LABELS[id];
/** The items, in order; "-" a rule.  New ▸, Recent ▸ and Download ▸ are groups.  Examples… is New ▸ From an
 * example…, also at the top (sim run 12: an agent read the File menu, never saw the word, and wrote a Beamer deck
 * from nothing); it has no key of its own: it clicks From an example…, so the page's handler is the one. */
export type FileItem = "newNotebook" | "newBoard" | "newLatex" | "newFolder" | "fromExample" | "open" | "examples" | "upload" | "saveCopy" | "rename" | "print" | "share" | "delete";
const LABELS: Record<FileItem, string> = {
  newNotebook: "Notebook",
  newBoard: "Board",
  newLatex: "LaTeX document",
  newFolder: "Folder",
  fromExample: "Examples…",
  open: "Open…",
  examples: "Examples…",
  upload: "Upload…",
  saveCopy: "Save a copy…",
  rename: "Rename…",
  print: "Print or save as PDF…",
  share: "Share…",
  delete: "Delete",
};
const TITLES: Partial<Record<FileItem, string>> = {
  open: "Your notebooks, boards and files in this browser",
  examples: "Worked examples (notebooks, boards, LaTeX): open one as your own copy",
  upload: "Files from this computer: notebooks and boards become documents, anything else is kept as a file",
  saveCopy: "A copy of this document, under a name you give",
  delete: "Move this document to Trash (Trash keeps it until you empty it)",
};
/** The keys shown beside items (and handled by the page: fileMenuKey). */
export const FILE_KEYS: Partial<Record<FileItem, string>> = { newNotebook: "Ctrl+Alt+N", open: "Ctrl+O" };

export type FileMenuOptions = {
  /** The attribute each item's key is put in (the page's handlers and tests find items by it). */
  attr: "data-f" | "data-sbb";
  /** Each item's key on this page; an item with no key is drawn disabled. */
  keys: Partial<Record<FileItem, string>>;
  /** Items drawn disabled here (meaning nothing for this document). */
  disabled?: Partial<Record<FileItem, boolean>>;
  /** Why a disabled item is disabled, as its title (a person's and an agent's only clue: run 12, the board's Share…). */
  why?: Partial<Record<FileItem, string>>;
  /** Download ▸: this document's kinds, keyed (one the page can't make here, disabled). */
  downloads: { key: string; label: string; title?: string; disabled?: boolean }[];
  /** Hide what is disabled instead (and a group or rule left with nothing): the board library in
   * another site's page, which offers only what its host gives; Sagebrush's own pages show it disabled. */
  hideDisabled?: boolean;
  /** Recent ▸: the documents opened lately (drawn when the group is opened); none, disabled. */
  recent?: () => Promise<{ label: string; title?: string; open: () => void }[]>;
  /** Called when an item is chosen (the page closes its menu). */
  chosen?: () => void;
  /** Whether this page has the LaTeX editor (New ▸ LaTeX document): without it the item isn't drawn, as it means
   * nothing in such a build (web/latex/boot.ts latexOn) */
  latex?: boolean;
  /** Extra items the page keeps in the menu, at the end of a section (the desktop app's Open file…, Save as…). */
  extra?: { after: FileItem; key: string; label: string; title?: string; hidden?: boolean }[];
};

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}): HTMLElementTagNameMap[K] => Object.assign(document.createElement(tag), props);

/** One menu row that opens its items inline below it.  File's New, Recent and
 * Download groups and the notebook's compact More-menu groups share this
 * exact behavior. */
export function menuGroup(menu: HTMLElement, label: string, name: string,
  fill: (box: HTMLElement) => void | Promise<void> = () => {}, disabled = false,
  before: ChildNode | null = null) {
  const button = el("button", { textContent: label + " ▸" });
  button.setAttribute("role", "menuitem");
  button.setAttribute("aria-haspopup", "true");
  button.setAttribute("aria-expanded", "false");
  button.dataset.group = name;
  const box = el("div", { hidden: true });
  box.className = "fmgroup";
  box.setAttribute("role", "group");
  box.setAttribute("aria-label", label);
  box.style.paddingLeft = "12px";
  if (disabled) { button.disabled = true; button.setAttribute("aria-disabled", "true"); }
  const open = async (on = box.hidden) => {
    box.hidden = !on;
    button.setAttribute("aria-expanded", String(on));
    button.textContent = label + (on ? " ▾" : " ▸");
    if (on) await fill(box);
  };
  button.onclick = (ev) => { ev.stopPropagation(); void open(); };
  menu.insertBefore(button, before);
  menu.insertBefore(box, before);
  return { button, box, open };
}

// (the same look on both pages: items one per line, a key at the right; a group's items under it)
const STYLE = `.sbfilemenu .fmgroup:not([hidden]) { display: flex; flex-direction: column; }
.sbfilemenu [hidden] { display: none !important; }
.sbfilemenu button { display: flex; align-items: center; justify-content: space-between; gap: 18px; width: 100%; text-align: left; }
.sbfilemenu button kbd { margin-left: auto; font-size: 11px; opacity: .7; }
.sbfilemenu button:disabled { opacity: .45; cursor: default; }`;
let styled = false;

/** The File menu drawn into `menu` (its children replaced). */
export function renderFileMenu(menu: HTMLElement, o: FileMenuOptions) {
  if (!styled) { styled = true; document.head.append(Object.assign(document.createElement("style"), { textContent: STYLE })); }
  menu.classList.add("sbfilemenu");
  menu.replaceChildren();
  const item = (id: FileItem, parent: HTMLElement) => {
    const b = el("button", { textContent: LABELS[id] });
    b.setAttribute("role", "menuitem");
    b.dataset.item = id;
    const key = o.keys[id];
    if (key) b.setAttribute(o.attr, key);
    if (TITLES[id]) b.title = TITLES[id]!;
    if (FILE_KEYS[id]) b.append(el("kbd", { textContent: FILE_KEYS[id] }));
    if (!key || o.disabled?.[id]) { b.disabled = true; b.setAttribute("aria-disabled", "true"); if (o.why?.[id]) b.title = o.why[id]!; }
    if (id === "delete") b.classList.add("danger");
    parent.append(b);
    for (const x of o.extra ?? []) if (x.after === id) {
      const e = el("button", { textContent: x.label, hidden: !!x.hidden });
      e.setAttribute("role", "menuitem");
      e.setAttribute(o.attr, x.key);
      if (x.title) e.title = x.title;
      parent.append(e);
    }
    return b;
  };
  // (a group: its button opens it in place, under it)
  const group = (label: string, name: string, fill: (box: HTMLElement) => void | Promise<void>, disabled = false) =>
    menuGroup(menu, label, name, fill, disabled).box;
  // (New's items and Download's are in the page from the start, though their
  // group is closed: the page's handlers and tests find them)
  const nw = group("New", "new", () => {});
  for (const id of NEW_ITEMS) if (id !== "newLatex" || o.latex) item(id, nw);
  item("open", menu);
  // (Examples…: From an example…, clicked; disabled where it is)
  const fromExample = nw.querySelector<HTMLButtonElement>("[data-item=fromExample]")!;
  const ex = el("button", { textContent: LABELS.examples, title: TITLES.examples!, disabled: fromExample.disabled });
  ex.setAttribute("role", "menuitem");
  ex.dataset.item = "examples";
  if (ex.disabled) ex.setAttribute("aria-disabled", "true");
  ex.onclick = (ev) => { ev.stopPropagation(); fromExample.click(); };
  menu.append(ex);
  group("Recent", "recent", async (box) => {
    box.replaceChildren();
    const list = (await o.recent?.().catch(() => [])) ?? [];
    if (!list.length) { const n = el("div", { textContent: "Nothing opened yet" }); n.className = "fmnote"; n.style.cssText = "padding:4px 10px;opacity:.7;font-size:13px"; box.append(n); return; }
    for (const r of list) {
      const b = el("button", { textContent: r.label, title: r.title ?? "" });
      b.setAttribute("role", "menuitem");
      b.dataset.recent = r.title ?? r.label;
      b.onclick = () => { o.chosen?.(); r.open(); };
      box.append(b);
    }
  }, !o.recent);
  item("upload", menu);
  menu.append(el("hr"));
  item("saveCopy", menu);
  item("rename", menu);
  const dl = group("Download", "download", () => {}, !o.downloads.length);
  for (const d of o.downloads) {
    const b = el("button", { textContent: d.label });
    b.setAttribute("role", "menuitem");
    b.setAttribute(o.attr, d.key);
    if (d.title) b.title = d.title;
    if (d.disabled) { b.disabled = true; b.setAttribute("aria-disabled", "true"); }
    dl.append(b);
  }
  item("print", menu);
  item("share", menu);
  menu.append(el("hr"));
  item("delete", menu);
  if (o.hideDisabled) {
    for (const b of menu.querySelectorAll<HTMLButtonElement>("button:disabled")) b.hidden = true;
    // (a group with nothing left to show, and its box; then rules with nothing between them)
    for (const g of menu.querySelectorAll<HTMLButtonElement>("button[data-group]")) {
      const box = g.nextElementSibling as HTMLElement;
      const empty = g.dataset.group === "recent" ? !o.recent : ![...box.children].some((c) => !(c as HTMLElement).hidden);
      if (empty) { g.hidden = true; box.hidden = true; }
    }
    let prevRule = true;
    for (const c of [...menu.children] as HTMLElement[]) {
      if (c.tagName === "HR") { c.hidden = prevRule; prevRule = true; }
      else if (!c.hidden && !c.classList.contains("fmgroup")) prevRule = false;
    }
    const shown = ([...menu.children] as HTMLElement[]).filter((c) => !c.hidden && !c.classList.contains("fmgroup"));
    if (shown.at(-1)?.tagName === "HR") shown.at(-1)!.hidden = true;
  }
  // (an item chosen closes the menu; a group's button doesn't)
  menu.addEventListener("click", (ev) => {
    const b = (ev.target as HTMLElement).closest("button");
    if (b && !b.dataset.group && !b.disabled) o.chosen?.();
  });
}

/** The item a key press asks for (Ctrl+Alt+N, Ctrl+O), or null. */
export function fileMenuKey(e: KeyboardEvent): FileItem | null {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.altKey && (e.key === "n" || e.key === "N" || e.code === "KeyN")) return "newNotebook";
  if (mod && !e.altKey && !e.shiftKey && (e.key === "o" || e.key === "O")) return "open";
  return null;
}
