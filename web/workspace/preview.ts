// A data file's preview, with its versions (design/workspace-files.md §4,
// §2.5), and the Storage panel (§6.3): panels over the page, opened from
// the file browser.  A preview shows a table's first rows, a picture, or
// the start of a text; a file's versions can be downloaded or restored
// (restoring keeps what is there now as a version too), and only a person
// deletes older versions, after confirming what it frees.  The Storage
// panel says what this browser holds, whether the browser may clear it,
// and frees old versions.
import { migrationState, type MigrationState } from "./migrator";
import { LIMITS, WorkspaceError, type Entry, type Version, type Workspace } from "./api";
import { TRASH, nameOf, splitExt } from "./paths";
import { notebookFileText, boardFileText, ipynbObject } from "./file-bytes";
import { syncSection } from "./sync-panel";
// (the LaTeX editor's define: true only in a build with it, web/build.ts; false or absent, its hook folds away)
declare const __SB_LATEX__: boolean | undefined;
// (built with __SB_NO_SYNC__ (the board frame and exports, web/build.ts): no sync owner, panel or client is in that
// copy; elsewhere the define is absent or false, and everything is as before)
declare const __SB_NO_SYNC__: boolean | undefined;
const NO_SYNC = typeof __SB_NO_SYNC__ !== "undefined" && __SB_NO_SYNC__;

/** At most this much of a text is shown; of a table, this much read and these many rows and columns.
 * A file is read for its preview only if it is at most readBytes (a text
 * or a table) or imageBytes (a picture), by its size before any read: the
 * workspace keeps a file's bytes as one value, read whole (LIMIT-F85-1). */
export const PREVIEW = { textBytes: 64 * 1024, tableBytes: 256 * 1024, rows: 50, cols: 30, imageBytes: 20 * 2 ** 20, readBytes: 4 * 2 ** 20 };
const IMAGES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml" };
const TEXTS = new Set([".txt", ".md", ".py", ".sage", ".m", ".mag", ".json", ".js", ".ts", ".html", ".css", ".xml", ".yaml", ".yml", ".toml", ".tex", ".log", ".ini", ".cfg", ".r", ".jl", ".c", ".h", ".cpp", ".rs", ".go", ".java", ".sh", ""]);

/** How a file is previewed, by its name. */
export function previewKind(p: string): "table" | "image" | "text" | "none" {
  const ext = splitExt(nameOf(p))[1].toLowerCase();
  if (ext === ".csv" || ext === ".tsv") return "table";
  if (IMAGES[ext]) return "image";
  if (TEXTS.has(ext)) return "text";
  return "none";
}

/** The first `maxRows` rows of a CSV (or with "\t", TSV) text: quoted fields, doubled quotes, newlines inside quotes. */
export function parseDelimited(text: string, sep: string, maxRows: number): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false, i = 0;
  while (i < text.length && rows.length < maxRows) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false;
      } else field += c;
      i++;
      continue;
    }
    if (c === '"' && field === "") quoted = true;
    else if (c === sep) { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      rows.push(row); row = [];
    } else field += c;
    i++;
  }
  if (rows.length < maxRows && (field !== "" || row.length)) { row.push(field); rows.push(row); }
  return rows;
}

const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 2 ** 20 ? `${(n / 1024).toFixed(1)} KB` : n < 2 ** 30 ? `${(n / 2 ** 20).toFixed(1)} MB` : `${(n / 2 ** 30).toFixed(2)} GB`);
const fmtTime = (t: number) => new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
// (who wrote a version, in plain words: an in-page agent writes through window.sagebrush.workspace, as agent:page)
const who = (by: string) => (by === "person" ? "you" : by === "agent:page" ? "an agent in this page" : by.startsWith("agent:") ? `an agent (${by.slice(6)})` : by);

const STYLE = `
.sbfprev { position: fixed; inset: 0; z-index: 900; background: rgba(20,24,21,.38); display: flex; align-items: center; justify-content: center; font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
.sbfprev .pp { background: var(--sbf-bg, #fbfaf6); color: var(--sbf-fg, #1f2421); border-radius: 10px; box-shadow: 0 16px 48px rgba(0,0,0,.25); width: min(880px, calc(100vw - 32px)); max-height: calc(100vh - 48px); display: flex; flex-direction: column; overflow: hidden; }
.sbfprev .ph { display: flex; align-items: baseline; gap: 10px; padding: 12px 14px 8px; border-bottom: 1px solid #e2e1d9; }
.sbfprev .ph b { font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sbfprev .ph .m { color: #5d645f; font-size: 12px; flex: 1; white-space: nowrap; }
.sbfprev .ph button, .sbfprev .pa button, .sbfprev .pv button { border: 1px solid #d4d4cb; background: #fff; border-radius: 6px; padding: 4px 10px; font: inherit; font-size: 13px; cursor: pointer; color: inherit; }
.sbfprev .ph .x { border: 0; background: none; font-size: 16px; padding: 2px 6px; }
.sbfprev .pb { overflow: auto; padding: 10px 14px; flex: 1; min-height: 80px; }
.sbfprev .pb pre { margin: 0; font: 12.5px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; word-break: break-word; }
.sbfprev .pb table { border-collapse: collapse; font-size: 12.5px; }
.sbfprev .pb th, .sbfprev .pb td { border: 1px solid #e2e1d9; padding: 3px 7px; text-align: left; white-space: nowrap; max-width: 260px; overflow: hidden; text-overflow: ellipsis; }
.sbfprev .pb th { background: #efeee7; position: sticky; top: 0; }
.sbfprev .pb img { max-width: 100%; max-height: 60vh; display: block; margin: 0 auto; background: repeating-conic-gradient(#eee 0 25%, #fff 0 50%) 0 0 / 16px 16px; }
.sbfprev .pb .note, .sbfprev .note { color: #5d645f; font-size: 12.5px; margin: 6px 0; }
.sbfprev .pa { display: flex; gap: 8px; padding: 8px 14px; border-top: 1px solid #e2e1d9; align-items: center; flex-wrap: wrap; }
.sbfprev .pa .sp { flex: 1; }
.sbfprev .pv { border-top: 1px solid #e2e1d9; padding: 8px 14px 12px; max-height: 34vh; overflow: auto; }
.sbfprev .pv h3 { font-size: 13px; margin: 0 0 6px; }
.sbfprev .pv .vr { display: flex; gap: 8px; align-items: center; padding: 3px 0; font-size: 13px; }
.sbfprev .pv .vr span { flex: 1; }
.sbfprev .danger { color: #b3261e !important; }
.sbfprev .meter { height: 8px; border-radius: 4px; background: #e2e1d9; overflow: hidden; margin: 6px 0 2px; }
.sbfprev .meter i { display: block; height: 100%; background: #4a6b49; }
.sbfprev dl { display: grid; grid-template-columns: auto 1fr auto; gap: 6px 14px; align-items: center; margin: 10px 0; font-size: 13.5px; }
.sbfprev dt { color: #5d645f; }
.sbfprev dd { margin: 0; }
@media (max-width: 640px) { .sbfprev .pp { width: 100vw; max-height: 100vh; height: 100vh; border-radius: 0; } }
@media (prefers-color-scheme: dark) {
  .sbfprev .pp { --sbf-bg: #1d211e; --sbf-fg: #e4e6e1; }
  .sbfprev .ph button, .sbfprev .pa button, .sbfprev .pv button { background: #262b27; border-color: #39403a; }
  .sbfprev .pb th { background: #262b27; } .sbfprev .pb th, .sbfprev .pb td { border-color: #39403a; }
}
`;
let styled = false;
function style() {
  if (styled) return;
  styled = true;
  document.head.append(Object.assign(document.createElement("style"), { textContent: STYLE }));
}
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "style") el.setAttribute("style", String(v));
    else (el as any)[k] = v;
  }
  el.append(...kids);
  return el;
}
const button = (text: string, onclick: () => void, cls = "") => { const b = h("button", { textContent: text, className: cls }); b.onclick = onclick; return b; };

/** A panel over the page: closed by ✕, Esc, or a click outside it; `cleanup` runs once when it closes. */
function panel(label: string): { root: HTMLElement; box: HTMLElement; close: () => void; onClose: (f: () => void) => void } {
  style();
  document.querySelectorAll(".sbfprev").forEach((p) => (p as any).sbClose?.());
  const root = h("div", { className: "sbfprev" });
  const box = h("div", { className: "pp", tabIndex: -1 });
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-label", label);
  root.append(box);
  const cleanups: (() => void)[] = [];
  const close = () => {
    if (!root.isConnected) return;
    root.remove();
    removeEventListener("keydown", esc, true);
    for (const f of cleanups) try { f(); } catch {}
  };
  const esc = (ev: KeyboardEvent) => { if (ev.key === "Escape" && !document.querySelector(".sbfmenu")) { ev.stopPropagation(); close(); } };
  root.onpointerdown = (ev) => { if (ev.target === root) close(); };
  addEventListener("keydown", esc, true);
  (root as any).sbClose = close;
  document.body.append(root);
  return { root, box, close, onClose: (f) => cleanups.push(f) };
}

/** Bytes downloaded as a file named `name`. */
export function downloadBytes(bytes: Uint8Array, name: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
  const a = h("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** What `bytes` (a file named `name`) looks like: an element for the preview's body, and how to let go of what it holds. */
export function renderPreview(name: string, bytes: Uint8Array): { el: HTMLElement; dispose: () => void } {
  const kind = previewKind(name), ext = splitExt(name)[1].toLowerCase();
  const note = (text: string) => h("p", { className: "note", textContent: text });
  if (kind === "image") {
    if (bytes.length > PREVIEW.imageBytes) return { el: note(`This picture is too large to preview here (${fmtSize(bytes.length)}): download it.`), dispose: () => {} };
    // (an <img>, never inline: an SVG's scripts don't run in one)
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: IMAGES[ext] }));
    const img = h("img", { src: url, alt: name });
    return { el: img, dispose: () => URL.revokeObjectURL(url) };
  }
  if (kind === "none") return { el: note("No preview for this kind of file: download it, or open it from code."), dispose: () => {} };
  const limit = kind === "table" ? PREVIEW.tableBytes : PREVIEW.textBytes;
  const part = bytes.subarray(0, limit);
  // (binary, whatever its name: not shown as text)
  let zeros = 0;
  for (let i = 0; i < Math.min(part.length, 4096); i++) if (part[i] === 0) zeros++;
  if (zeros > 0) return { el: note("This file isn't text: download it to see it."), dispose: () => {} };
  const text = new TextDecoder().decode(part);
  const cut = bytes.length > limit;
  if (kind === "table") {
    const rows = parseDelimited(text, ext === ".tsv" ? "\t" : ",", PREVIEW.rows + 1);
    if (!rows.length) return { el: note("This table is empty."), dispose: () => {} };
    const cols = Math.min(PREVIEW.cols, Math.max(...rows.map((r) => r.length)));
    const table = h("table");
    const [head, ...body] = rows;
    table.append(h("thead", {}, h("tr", {}, ...Array.from({ length: cols }, (_, j) => h("th", { textContent: head[j] ?? "", title: head[j] ?? "" })))));
    const tb = h("tbody");
    for (const r of body.slice(0, PREVIEW.rows)) tb.append(h("tr", {}, ...Array.from({ length: cols }, (_, j) => h("td", { textContent: r[j] ?? "", title: r[j] ?? "" }))));
    table.append(tb);
    const wrap = h("div", {}, table);
    const more = body.length > PREVIEW.rows || cut ? `The first ${Math.min(body.length, PREVIEW.rows)} rows` : `${body.length} row${body.length === 1 ? "" : "s"}`;
    wrap.append(note(more + (Math.max(...rows.map((r) => r.length)) > cols ? `, the first ${cols} columns` : "") + "."));
    return { el: wrap, dispose: () => {} };
  }
  let shown = text;
  if (ext === ".json" && !cut) try { shown = JSON.stringify(JSON.parse(text), null, 2); } catch {}
  const wrap = h("div", {}, h("pre", { textContent: shown }));
  if (cut) wrap.append(note(`The first ${fmtSize(limit)} of ${fmtSize(bytes.length)}.`));
  return { el: wrap, dispose: () => {} };
}

export type PreviewHost = { say(text: string): void; fail(e: unknown): void };

/** A data file's preview over the page, with Download and its versions. */
export async function openPreview(w: Workspace, e0: Entry, host: PreviewHost): Promise<void> {
  const name = nameOf(e0.path);
  const { box, close, onClose } = panel(`Preview of ${name}`);
  const meta = h("span", { className: "m" });
  const x = button("✕", close, "x");
  x.setAttribute("aria-label", "Close");
  box.append(h("div", { className: "ph" }, h("b", { textContent: name, title: e0.path }), meta, x));
  const body = h("div", { className: "pb" });
  const actions = h("div", { className: "pa" });
  const versions = h("div", { className: "pv" });
  box.append(body, actions, versions);
  x.focus();
  let shown: { dispose: () => void } | null = null;
  onClose(() => shown?.dispose());
  const note = (text: string) => body.replaceChildren(h("p", { className: "note", textContent: text }));
  // (the file as it is now, by its index entry: its id and revision are
  // what Restore and Delete older versions are bound to; its size decides,
  // before any read, whether it is read at all)
  const e = await w.stat(e0.path).catch(() => undefined);
  if (!e || e.kind !== "file") return note("This file isn't here any more.");
  const size = e.size ?? 0, kind = previewKind(e.path);
  meta.textContent = `${fmtSize(size)} · ${fmtTime(e.updated)}`;
  const download = async () => {
    try {
      const r = await w.read(e.path);
      if (r.entry.fid !== e.fid) return host.say(`"${name}" is another file now: open it again`);
      downloadBytes(r.content, name);
    } catch (err) { host.fail(err); }
  };
  actions.append(button("Download", download), h("span", { className: "sp" }));
  // (a .tex file: the LaTeX editor's button, in a build with it and when it is on; web/latex/boot.ts)
  if (typeof __SB_LATEX__ !== "undefined" && __SB_LATEX__) (globalThis as any).__sbTexP?.(e, actions);
  if (kind === "none") note("No preview for this kind of file: download it, or open it from code.");
  else if (kind === "image" && size > PREVIEW.imageBytes) note(`This picture is too large to preview here (${fmtSize(size)}): download it.`);
  else if (kind !== "image" && size > PREVIEW.readBytes) note(`This file is too large to preview here (${fmtSize(size)}): download it.`);
  else {
    try {
      // (read only if it is still at most the limit, checked holding the lock and by the bytes read)
      const r = await w.readUpTo(e.path, kind === "image" ? PREVIEW.imageBytes : PREVIEW.readBytes);
      if (r.entry.fid !== e.fid) return note("This file was replaced while it was opened: open it again.");
      shown = renderPreview(name, r.content);
      body.replaceChildren(shown.el);
    } catch (err) {
      if (err instanceof WorkspaceError && err.code === "limit") note("This file grew too large to preview here: download it.");
      else note(err instanceof WorkspaceError ? err.message : String((err as Error)?.message ?? err));
    }
  }
  await drawVersions(w, e, versions, host, close);
}

// (a version action refused because the file changed since it was shown: said; the preview, now stale, closed)
const stale = (err: unknown, name: string, host: PreviewHost, close: () => void) => {
  if (err instanceof WorkspaceError && (err.code === "conflict" || err.code === "missing")) {
    host.say(`"${name}" changed since it was shown (${err.message}): nothing was done; open it again`);
    close();
  } else host.fail(err);
};

async function drawVersions(w: Workspace, e: Entry, el: HTMLElement, host: PreviewHost, close: () => void) {
  const name = nameOf(e.path);
  let list: Version[];
  try { list = await w.history(e.path); } catch (err) { host.fail(err); return; }
  // (the history read is the file's shown: another put at its path since, nothing of it shown)
  if (list.some((v) => v.fid !== e.fid)) { host.say(`"${name}" is another file now: open it again`); close(); return; }
  el.replaceChildren(h("h3", { textContent: list.length ? `Earlier versions (${list.length})` : "Earlier versions" }));
  if (!list.length) {
    el.append(h("p", { className: "note", textContent: "None yet: when this file is written over, what it had is kept here." }));
    return;
  }
  // (newest first; each by its id, which stays its own while older ones are dropped)
  for (let i = list.length - 1; i >= 0; i--) {
    const v = list[i];
    const r = h("div", { className: "vr" }, h("span", { textContent: `${fmtTime(v.t)} · ${who(v.by)} · ${fmtSize(v.size)}` }));
    r.dataset.version = String(v.id);
    r.append(
      button("Download", async () => {
        try { downloadBytes(await w.versionById(e.path, v.id!), `${splitExt(name)[0]} (${new Date(v.t).toISOString().slice(0, 16).replace(":", "-")})${splitExt(name)[1]}`); } catch (err) { stale(err, name, host, close); }
      }),
      button("Restore", async () => {
        try {
          // (only over the file shown, as it was shown: its id and revision, checked with the write: CORR-F85-2)
          await w.restoreVersion(e.path, v.id!, { fid: e.fid!, rev: e.rev ?? 0 });
          host.say(`"${name}" restored to the version of ${fmtTime(v.t)}`);
          close();
        } catch (err) { stale(err, name, host, close); }
      }),
    );
    el.append(r);
  }
  // (only a person deletes old versions: an agent's workspace has no dropVersions, §2.5)
  if (w.actor === "person") {
    const total = list.reduce((a, v) => a + v.size, 0);
    const del = button(`Delete older versions (${fmtSize(total)})…`, async () => {
      if (!confirm(`Delete the ${list.length} earlier version${list.length === 1 ? "" : "s"} of "${name}" (${fmtSize(total)})? The file as it is now stays. This can't be undone.`)) return;
      try {
        // (only those shown, of the file shown: CORR-F85-1)
        const freed = await w.dropVersions(e.path, { expect: { fid: e.fid, ids: list.map((v) => v.id!) } });
        host.say(`${fmtSize(freed)} of old versions of "${name}" deleted`);
        await drawVersions(w, e, el, host, close);
      } catch (err) { stale(err, name, host, close); }
    }, "danger");
    el.append(h("div", { style: "margin-top:8px" }, del));
  }
}

/** "Delete older versions in this folder" (§2.5): what it frees said and confirmed; only a person. */
export async function dropFolderVersions(w: Workspace, folder: string, host: PreviewHost): Promise<void> {
  try {
    const f = await w.stat(folder), u = await w.versionsUsage(folder);
    if (!u.count) return host.say(`No earlier versions of files in ${folder}`);
    if (!confirm(`Delete the ${u.count} earlier version${u.count === 1 ? "" : "s"} of the files in ${folder} (${fmtSize(u.bytes)})? The files as they are now stay. This can't be undone.`)) return;
    // (only what was confirmed: the same folder, and no version newer than
    // the newest then, kept since: CORR-F85-1, CORR-AC5-1)
    const freed = await w.dropVersions(folder, { expect: { created: f?.created, maxId: u.maxId, seq: u.seq } });
    host.say(`${fmtSize(freed)} of old versions deleted in ${folder}`);
  } catch (err) {
    if (err instanceof WorkspaceError && err.code === "conflict") host.say(`${folder} changed since you confirmed: nothing was deleted; ask again`);
    else host.fail(err);
  }
}

export type StorageHost = PreviewHost & {
  showTrash(): void;
  emptyTrash(): Promise<void>;
  /** "Export all current files (.zip)" (export plan E1 r2c): the address of a file of the lazy export chunk
   * (sagebrush-export.js, sagebrush-export-worker.js) beside this page; absent, the export isn't offered */
  exportUrl?: (file: string) => string;
  /** this tab's open documents saved, before an export reads them */
  saveOpen?: () => Promise<void>;
};

/** "Last export prepared on this device: …" (E1 r2c §0): set only after an export's file was closed. */
export function exportStatus(last: { at: number; partial: boolean } | undefined, now = Date.now()): string {
  if (!last) return "No export prepared on this device yet";
  const m = Math.floor((now - last.at) / 60_000), d = Math.floor(m / 1440);
  const when = m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.floor(m / 60)} h ago` : d === 1 ? "yesterday" : `${d} days ago`;
  return `Last export prepared on this device: ${when}${last.partial ? " (partial)" : ""}`;
}

/** The browser's estimate of what this site holds, and of what it may: undefined where it can't say. */
export async function estimate(): Promise<{ usage: number; quota: number } | undefined> {
  try {
    const e = await (globalThis.navigator as any)?.storage?.estimate?.();
    return e && typeof e.usage === "number" && typeof e.quota === "number" ? { usage: e.usage, quota: e.quota } : undefined;
  } catch { return undefined; }
}
export const fmtBytes = fmtSize;

/** The Storage panel (§6.3). */
export async function openStorage(w: Workspace, host: StorageHost): Promise<void> {
  const { box, close, onClose } = panel("Storage");
  const x = button("✕", close, "x");
  x.setAttribute("aria-label", "Close");
  box.append(h("div", { className: "ph" }, h("b", { textContent: "Storage in this browser" }), h("span", { className: "m" }), x));
  const body = h("div", { className: "pb" });
  box.append(body);
  x.focus();
  const draw = async () => {
    const [est, use, kept] = await Promise.all([
      estimate(),
      w.usage(),
      (async () => { try { return await (globalThis.navigator as any)?.storage?.persisted?.(); } catch { return undefined; } })(),
    ]);
    body.replaceChildren();
    if (est) {
      body.append(h("div", { className: "use", textContent: `${fmtSize(est.usage)} used of ${fmtSize(est.quota)} this browser allows` }));
      const m = h("div", { className: "meter" }, h("i", { style: `width:${Math.min(100, (100 * est.usage) / Math.max(1, est.quota)).toFixed(1)}%` }));
      body.append(m);
    } else body.append(h("p", { className: "note", textContent: "This browser doesn't say how much it holds." }));
    const dl = h("dl");
    const line = (label: string, value: string, act?: HTMLElement, cls = "") => { const dd = h("dd", { textContent: value }); dd.className = cls; dl.append(h("dt", { textContent: label }), dd, act ?? h("span")); };
    line("Notebooks and boards", String(use.documents));
    line("Data files", `${use.files.count} · ${fmtSize(use.files.bytes)}`);
    let free: HTMLElement | undefined;
    if (use.versions.count && w.actor === "person") {
      free = button(`Free ${fmtSize(use.versions.bytes)} of old versions…`, async () => {
        if (!confirm(`Delete all ${use.versions.count} earlier versions of data files (${fmtSize(use.versions.bytes)})? The files as they are now stay. This can't be undone.`)) return;
        // (none newer than the newest shown, kept since: CORR-AC5-1)
        try { const n = await w.dropVersions("/", { expect: { maxId: use.versions.maxId } }); host.say(`${fmtSize(n)} of old versions deleted`); } catch (err) { host.fail(err); }
        draw();
      }, "danger");
      free.className += " free";
    }
    line("Earlier versions of files", `${use.versions.count} · ${fmtSize(use.versions.bytes)}`, free);
    const trashBtns = h("span", {}, button("Show", () => { close(); host.showTrash(); }));
    if (use.trash.count) trashBtns.append(" ", button("Empty Trash…", async () => { await host.emptyTrash(); draw(); }, "danger"));
    line("Trash", `${use.trash.count} item${use.trash.count === 1 ? "" : "s"}${use.trash.bytes ? ` · ${fmtSize(use.trash.bytes)} of files` : ""}`, trashBtns);
    // (files kept the old way, being moved beside the index: capabilities §2b; read where they are meanwhile)
    const mig = await migrationState(w).catch(() => ({}) as MigrationState);
    if (mig.paused) line("Moving your files' storage", "paused: storage is full. Your files are all still readable; free some space (empty Trash, delete old versions) and it goes on.", undefined, "warn");
    // (names in one folder that look the same, made before that was refused: listed so they can be told apart; capabilities §3)
    if (use.lookalikes.length) line("Names that look the same", use.lookalikes.slice(0, 3).map((g) => g.map((p) => `${p} (${[...nameOf(p)].map((c) => "U+" + c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")).slice(0, 40).join(" ")})`).join(" · ")).join("; ") + (use.lookalikes.length > 3 || use.lookalikesMore.groups ? `; and ${use.lookalikes.length - 3 + use.lookalikesMore.groups} more` : ""), undefined, "warn");
    else if (use.migration.left) line("Moving your files' storage", `${use.migration.left} file${use.migration.left === 1 ? "" : "s"} left (read where they are meanwhile)`);
    body.append(dl);
    const keep = h("p", { className: "keep" });
    if (kept === true) keep.textContent = "Kept: this browser won't clear it when space runs short.";
    else {
      keep.textContent = kept === false ? "This browser may clear it when space runs short. " : "This browser doesn't say whether it keeps it when space runs short. ";
      const ask = button("Ask the browser to keep it", async () => {
        let ok = false;
        try { ok = !!(await (globalThis.navigator as any)?.storage?.persist?.()); } catch {}
        host.say(ok ? "This browser will keep it" : "This browser didn't agree to keep it (it may when the site is used more, or installed)");
        draw();
      });
      keep.append(ask);
    }
    body.append(keep, h("p", { className: "note", textContent: "Nothing of yours is cleared without asking: only caches the page can fetch or compute again. Old versions and Trash go only when you delete them here." }));
    body.append(exportBox, syncBox);
  };
  // (Export all current files: its own section, kept across draw(); its flow is the lazy chunk's, loaded on a click)
  const exportBox = h("div", { className: "export" });
  if (host.exportUrl) {
    const status = h("p", { className: "note" }), flow = h("div");
    const stamp = () => w.lastExport().then((l) => { status.textContent = exportStatus(l); }, () => { status.textContent = ""; });
    let running = false;
    const go = button("Export all current files (.zip)", async () => {
      if (running) return;
      running = true;
      go.disabled = true;
      try {
        const m = await import(host.exportUrl!("sagebrush-export.js"));
        const kit = { notebookFileText, boardFileText, ipynbObject, isMissing: (e: unknown) => e instanceof WorkspaceError && e.code === "missing", maxFileBytes: LIMITS.maxFileBytes, trash: TRASH };
        await m.openExport(w, { say: host.say, fail: host.fail, workerUrl: host.exportUrl!("sagebrush-export-worker.js"), saveOpen: host.saveOpen, stamped: stamp, site: location.host, app: "sagebrush", kit }, flow);
      } catch (err) { host.fail(err); } finally { running = false; go.disabled = false; }
    });
    exportBox.append(go, h("p", { className: "note", textContent: "Includes the current notebooks, boards, data files and folders. TimeTravel, old file versions, Trash, and this device's settings are not included." }), status, flow);
    void stamp();
  }
  // (sync, step 5: its own section, drawn by its own poll, ended with the panel)
  const syncBox = h("div");
  const sync = NO_SYNC ? { dispose() {} } : syncSection(w, syncBox, { say: host.say, fail: host.fail, usage: () => w.usage() });
  onClose(() => sync.dispose());
  await draw();
}
