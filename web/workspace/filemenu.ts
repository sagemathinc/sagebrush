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

/** The items, in order; "-" a rule.  New ▸, Recent ▸ and Download ▸ are groups. */
export type FileItem = "newNotebook" | "newBoard" | "newFolder" | "fromExample" | "open" | "upload" | "saveCopy" | "rename" | "print" | "share" | "delete";
const LABELS: Record<FileItem, string> = {
  newNotebook: "Notebook",
  newBoard: "Board",
  newFolder: "Folder",
  fromExample: "From an example…",
  open: "Open…",
  upload: "Upload…",
  saveCopy: "Save a copy…",
  rename: "Rename…",
  print: "Print or save as PDF…",
  share: "Share…",
  delete: "Delete",
};
const TITLES: Partial<Record<FileItem, string>> = {
  open: "Your notebooks, boards and files in this browser",
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
  /** Download ▸: this document's kinds, keyed. */
  downloads: { key: string; label: string; title?: string }[];
  /** Recent ▸: the documents opened lately (drawn when the group is opened); none, disabled. */
  recent?: () => Promise<{ label: string; title?: string; open: () => void }[]>;
  /** Called when an item is chosen (the page closes its menu). */
  chosen?: () => void;
  /** Extra items the page keeps in the menu, at the end of a section (the desktop app's Open file…, Save as…). */
  extra?: { after: FileItem; key: string; label: string; title?: string; hidden?: boolean }[];
};

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}): HTMLElementTagNameMap[K] => Object.assign(document.createElement(tag), props);

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
    if (!key || o.disabled?.[id]) { b.disabled = true; b.setAttribute("aria-disabled", "true"); }
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
  const group = (label: string, name: string, fill: (box: HTMLElement) => void | Promise<void>, disabled = false) => {
    const b = el("button", { textContent: label + " ▸" });
    b.setAttribute("role", "menuitem");
    b.setAttribute("aria-haspopup", "true");
    b.setAttribute("aria-expanded", "false");
    b.dataset.group = name;
    const box = el("div", { hidden: true });
    box.className = "fmgroup";
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", label);
    box.style.paddingLeft = "12px";
    if (disabled) { b.disabled = true; b.setAttribute("aria-disabled", "true"); }
    b.onclick = async (ev) => {
      ev.stopPropagation();
      const open = box.hidden;
      box.hidden = !open;
      b.setAttribute("aria-expanded", String(open));
      b.textContent = label + (open ? " ▾" : " ▸");
      if (open) await fill(box);
    };
    menu.append(b, box);
    return box;
  };
  // (New's items and Download's are in the page from the start, though their
  // group is closed: the page's handlers and tests find them)
  const nw = group("New", "new", () => {});
  for (const id of ["newNotebook", "newBoard", "newFolder", "fromExample"] as FileItem[]) item(id, nw);
  item("open", menu);
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
    dl.append(b);
  }
  item("print", menu);
  item("share", menu);
  menu.append(el("hr"));
  item("delete", menu);
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
