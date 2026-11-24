// The 3D view's hooks into the site (web/space, the viewer at /space/), a chunk of its own (sagebrush-space3d.js, built
// by web/build.ts), fetched when one is used, on the hosts that offer them (__SB_SPACE_HOSTS__):
//   - openIn3D: the file browser's Open in 3D (a folder's ⋯, and ⋯ for all files). The folder is shown as rooms, over
//     the page, in a frame of the viewer (/space/?embed=1). The viewer is sent the folder's tree: each file's path below
//     the folder, its length, its kind (a data file, a notebook, a board) and a Python file's imports. A file's contents
//     go to it only when it asks (space-read), only for files of that tree, and within totals per opening. Nothing is
//     written.
//   - mountSpace: a .space.json in the Agents chat, shown in the viewer, which follows the file as the agent writes it.
//     What the person selects there is written to the file as "selected", on the revision read.
// Every message is checked: from the frame's own window, of this origin, version 1.
import type { Entry, Workspace } from "./api";
import { TRASH, nameOf, within } from "./paths";
import { LIMITS, checkSpace, jsonSizeWithin, utf8Bytes } from "../space/src/read.ts";

// (text files whose lines are counted, and whose imports are read; others get a length from their size)
const TEXT = /\.(py|sage|pyx|ts|mts|tsx|js|mjs|rs|m|magma|md|txt|tex|bib|json|toml|ya?ml|sh|html|css|csv|gp|g|jl|r|c|h|cc|cpp|hpp|space\.json)$/i;
// (what Open in 3D reads to draw a folder, and what the viewer may then ask for. To draw it: the files read for their
//  lengths, the largest of them (a text file's bytes, or a notebook's size as JSON, when it is read), and all they
//  come to; a file's imports kept, and all of them. Then: the largest file sent, and per opening, the files and bytes
//  sent in all, and the reads waiting (they are read one at a time); a path's length)
export const SPACE3D_LIMITS = {
  lengths: 2000, lengthBytes: 1 << 20, lengthsBytes: 64 << 20, imports: 200, importsAll: 20000, importName: 256,
  file: 4 << 20, reads: 2000, bytes: 64 << 20, waiting: 64, path: 4096,
};
// (a notebook as read, walked within these before anything of it is copied: its values, depth and each text)
const NB_WALK = { values: LIMITS.values, depth: LIMITS.depth, string: LIMITS.string };
// (for the browser tests only, set by a script of this site's own origin, which could read and write the files itself
//  anyway: `reading`, told when each of this module's reads of the workspace begins (+1, awaited, so a test can change
//  the file just before it is read; with how it is read: readUpTo and its cap, or read) and ends (-1), so a test can
//  count them, see how many run at once and that each is bounded; `copying`, told just before a notebook sent to the
//  view is copied (its cells mapped and serialized), so a test can see an oversized one refused before that; `beforeSelectionWrite`, a pause just before a selection is written, once
//  its text and revision are taken, so a test can write the file meanwhile and see the write refused on the old
//  revision and made again on the new)
type How = { method: "readUpTo"; cap: number } | { method: "read" };
export const SPACE3D_TESTING: {
  reading: null | ((path: string, d: 1 | -1, how?: How) => void | Promise<void>);
  copying: null | ((path: string) => void);
  beforeSelectionWrite: null | (() => Promise<void>);
} = { reading: null, copying: null, beforeSelectionWrite: null };
// (a read of the workspace: a data file's bytes capped (readUpTo), or a document (read), told to the tests' hook)
const readCapped = async (ws: Workspace, path: string, cap: number) => {
  await SPACE3D_TESTING.reading?.(path, 1, { method: "readUpTo", cap });
  try { return await ws.readUpTo(path, cap); } finally { SPACE3D_TESTING.reading?.(path, -1); }
};
// (one notebook read at a time in this page, whichever view asks: held from the read through its walk and its copy
//  or refusal, so no second notebook is read while one is still unchecked. A notebook's record is read whole (the
//  workspace keeps no size for it), as the notebook page does when it opens one; only when the person enters it)
let notebookSlot: Promise<unknown> = Promise.resolve();
const oneNotebookAtATime = <T>(f: () => Promise<T>): Promise<T> => {
  const run = notebookSlot.then(f);
  notebookSlot = run.catch(() => {});
  return run;
};
const readDoc = async (ws: Workspace, path: string) => {
  await SPACE3D_TESTING.reading?.(path, 1, { method: "read" });
  try { return await ws.read(path); } finally { SPACE3D_TESTING.reading?.(path, -1); }
};
const MiB = (n: number) => `${(n / 2 ** 20).toFixed(1)} MiB`;
// (from X import a, b; from X import (a,\n b); import a.b, c)
const PYIMP = /^[ \t]*(?:from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+(?:\(([^)]*)\)|([\w., \t*]+))|import[ \t]+([\w., \t]+))/gm;

const decode = (c: unknown): string => (typeof c === "string" ? c : c instanceof Uint8Array ? new TextDecoder().decode(c) : c instanceof ArrayBuffer ? new TextDecoder().decode(new Uint8Array(c)) : JSON.stringify(c));
const lineCount = (t: string) => (t.length ? t.split("\n").length - (t.endsWith("\n") ? 1 : 0) : 0);
const frameOf = (title: string) => {
  const frame = document.createElement("iframe");
  frame.src = "/space/?embed=1";
  frame.title = title;
  frame.allow = "fullscreen; xr-spatial-tracking"; // (and a headset, from the viewer's Enter VR)
  return frame;
};

/** A Python file's imports, as [module, ...names taken from it] (resolved to files by the viewer): at most
 *  SPACE3D_LIMITS.imports of them, names of at most SPACE3D_LIMITS.importName characters (longer ones are left out). */
function pyImports(text: string): string[][] {
  const out: string[][] = [], ok = (n: string) => n.length <= SPACE3D_LIMITS.importName;
  for (const m of text.matchAll(PYIMP)) {
    if (out.length >= SPACE3D_LIMITS.imports) break;
    if (m[4]) { for (const name of m[4].split(",")) { const mod = name.trim().split(/\s+/)[0]; if (mod && ok(mod) && out.length < SPACE3D_LIMITS.imports) out.push([mod]); } continue; }
    const names = (m[2] ?? m[3] ?? "").replace(/#.*$/gm, "").split(",").map((s) => s.trim().split(/\s+/)[0]).filter((s) => s && s !== "*" && ok(s)).slice(0, SPACE3D_LIMITS.imports);
    if (ok(m[1])) out.push([m[1], ...names]);
  }
  return out;
}

export async function openIn3D(ws: Workspace, folder: string): Promise<void> {
  const prefix = folder === "/" ? "/" : folder.replace(/\/$/, "") + "/";
  const title = folder === "/" ? "All files" : nameOf(folder);
  // ---- the overlay: a bar (the folder, Close) and the frame
  const box = document.createElement("div");
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", `${title} in the 3D view`);
  box.style.cssText = "position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;background:#0e1116";
  const bar = document.createElement("div");
  bar.style.cssText = "display:flex;align-items:center;gap:10px;padding:6px 10px;font:14px system-ui,sans-serif;color:#e8eef7;background:#161b22;border-bottom:1px solid #2c3442";
  const name = Object.assign(document.createElement("div"), { textContent: `${title} · 3D view` });
  name.style.cssText = "flex:1;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
  const state = Object.assign(document.createElement("span"), { textContent: "reading the folder…" });
  state.style.cssText = "color:#93a1b5;font-size:12px";
  const close = Object.assign(document.createElement("button"), { textContent: "✕ Close", title: "Close the 3D view (Esc)" });
  close.style.cssText = "font:inherit;color:inherit;background:#21262d;border:1px solid #364055;border-radius:6px;padding:4px 12px;cursor:pointer";
  bar.append(name, state, close);
  const frame = frameOf(`${title} in the 3D view`);
  frame.style.cssText = "flex:1;border:0;width:100%;background:#0e1116";
  box.append(bar, frame);
  document.body.append(box);
  let alive = true;
  const done = () => {
    if (!alive) return;
    alive = false;
    removeEventListener("message", onMessage);
    removeEventListener("keydown", onKey, true);
    box.remove();
  };
  close.onclick = done;
  // (Esc here; in the viewer, Esc with nothing open there says space-close)
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); done(); } };
  addEventListener("keydown", onKey, true);

  // ---- the tree: listed, and the text files' lengths and imports read (a large folder: the first of them)
  const allowed = new Map<string, Entry>(); // (a path below the folder, exactly as listed -> its entry: what the viewer may read)
  let space: Record<string, unknown> | null = null, ready = false;
  const send = () => { if (alive && ready && space) frame.contentWindow?.postMessage({ sagebrush: "space-load", version: 1, name: `${title} (3D view)`, space }, location.origin); };
  void (async () => {
    const entries = (await ws.list(folder, { recursive: true })).filter((e) => e.kind !== "folder" && !within(e.path, TRASH) && e.path.startsWith(prefix));
    if (!alive) return;
    // (more files than a space's tree may have: said, and nothing sent)
    if (entries.length > LIMITS.files) { state.textContent = `this folder has more than ${LIMITS.files.toLocaleString("en-US")} files: too many to show`; return; }
    entries.sort((a, b) => a.path.localeCompare(b.path));
    // (first the tree with lengths from sizes, shown at once; then, the text files read (eight at a time), their
    //  lengths and imports, sent again: the viewer keeps where you are)
    const files: [string, number, string][] = entries.map((e) => [e.path.slice(prefix.length), e.kind === "notebook" || e.kind === "board" ? 40 : Math.max(1, Math.round((e.size ?? 0) / 40)), e.kind]);
    const pyimports: Record<string, string[][]> = {};
    entries.forEach((e, k) => allowed.set(files[k][0], e));
    const make = () => ({
      format: "sagebrush-space", version: 1, title: `${title} (your files)`,
      summary: `${files.length} file${files.length === 1 ? "" : "s"} in ${folder === "/" ? "your workspace" : folder}. Enter a folder, a Python, Sage, JavaScript or TypeScript file, or a notebook.`,
      nodes: [], tree: { name: title, commit: null, base: "workspace:", files: files.map((f) => [...f]), imports: [], pyimports: { ...pyimports } },
    });
    const todo = entries.map((_, k) => k).filter((k) => {
      const e = entries[k];
      // (text files only: a notebook keeps its kind's length, as nothing bounds its record before it is read whole)
      return e.kind === "file" && TEXT.test(e.path) && (e.size ?? 0) <= SPACE3D_LIMITS.lengthBytes;
    }).slice(0, SPACE3D_LIMITS.lengths);
    // (the space, checked whole as the viewer will check it, before it is sent: else nothing is sent, and that is said)
    const ship = () => {
      const s = make();
      try { checkSpace(s); } catch (err) { state.textContent = `this folder is too large to show: ${(err as Error).message}`; return false; }
      space = s;
      send();
      return true;
    };
    if (todo.length > 100 && !ship()) return;
    // (eight at a time; each read's largest size reserved from the reading's total before it starts, and a file read
    //  as it is now, its bytes capped (readUpTo), so one that grew since it was listed isn't read whole)
    let next = 0, read = 0, reserved = 0, imports = 0;
    const worker = async () => {
      while (alive && next < todo.length) {
        if (reserved + SPACE3D_LIMITS.lengthBytes > SPACE3D_LIMITS.lengthsBytes) break;
        const k = todo[next++], e = entries[k];
        reserved += SPACE3D_LIMITS.lengthBytes;
        let used = SPACE3D_LIMITS.lengthBytes;
        try {
          {
            const r = await readCapped(ws, e.path, SPACE3D_LIMITS.lengthBytes);
            used = r.content.byteLength;
            const t = decode(r.content);
            files[k][1] = lineCount(t);
            if (/\.(py|sage)$/i.test(e.path) && imports < SPACE3D_LIMITS.importsAll) {
              const found = pyImports(t).slice(0, SPACE3D_LIMITS.importsAll - imports);
              imports += found.length;
              pyimports[files[k][0]] = found;
            }
          }
        } catch { /* (its contents aren't in this browser, or are too large now: its size will do) */ }
        reserved -= SPACE3D_LIMITS.lengthBytes - Math.min(used, SPACE3D_LIMITS.lengthBytes);
        if (++read % 50 === 0) state.textContent = `reading the folder… ${read} of ${todo.length} files`;
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    if (!alive || !ship()) return;
    state.textContent = files.length ? "" : "this folder has no files";
  })().catch((e) => { if (alive) state.textContent = `couldn't read the folder: ${String((e as Error)?.message ?? e)}`; });

  // ---- the viewer's messages: ready (send it the tree), close, and a file's contents (only one of the tree's, within
  //      this opening's totals). Reads are served one at a time, at most SPACE3D_LIMITS.waiting of them waiting; each
  //      reserves what is left of the opening's bytes before it starts (none left: refused, nothing read), and a view
  //      closed meanwhile reads and answers nothing more
  let reads = 0, sent = 0, waiting = 0, queue: Promise<void> = Promise.resolve();
  const serve = async (m: { id: number }, entry: Entry, reply: (x: { text?: string; error?: string }) => void) => {
    if (!alive) return;
    const room = SPACE3D_LIMITS.bytes - sent;
    if (room <= 0) return reply({ error: "too much read in this view: close it and open it again" });
    const cap = Math.min(SPACE3D_LIMITS.file, room), over = () => reply({ error: cap < SPACE3D_LIMITS.file ? "too much read in this view: close it and open it again" : `it's too large to read here (over ${MiB(cap)})` });
    try {
      let text: string;
      if (entry.kind === "notebook") {
        // (a notebook: walked within the cap before anything of it is copied; then its language and cells (code,
        //  kind, outputs), for its room; all of it in the page's one notebook slot)
        const got = await oneNotebookAtATime(async (): Promise<{ text?: string; error?: string } | null> => {
          if (!alive) return null;
          const r = await readDoc(ws, entry.path);
          if (!alive) return null;
          // (past any of the walk's limits (its bytes, values, nesting or a text's length): which one, the walk
          //  doesn't say, so the reply names none)
          try { jsonSizeWithin(r.content, { ...NB_WALK, bytes: cap }); } catch { return { error: "this notebook exceeds the 3D view's limits" }; }
          SPACE3D_TESTING.copying?.(entry.path);
          const raw = Array.isArray(r.content?.cells) ? (r.content.cells as unknown[]) : [];
          const cells = raw.filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
            .map((c) => ({ id: c.id, type: c.type ?? "code", code: String(c.code ?? ""), outputs: Array.isArray(c.outputs) ? c.outputs : [] }));
          return { text: JSON.stringify({ format: "sagebrush-notebook-cells", mode: r.content?.mode ?? "python", cells }) };
        });
        if (!got) return;
        if (got.error !== undefined) return reply({ error: got.error });
        text = got.text!;
      } else {
        // (the file as it is now, its bytes capped: one that grew since it was listed isn't read whole)
        let r;
        try { r = await readCapped(ws, entry.path, cap); } catch (err) { if ((err as { code?: string }).code === "limit") return over(); throw err; }
        text = decode(r.content);
      }
      if (!alive) return;
      const n = utf8Bytes(text);
      if (n > cap) return over();
      sent += n;
      reply({ text });
    } catch (err) {
      reply({ error: String((err as Error)?.message ?? err).slice(0, 300) });
    }
  };
  const onMessage = (e: MessageEvent) => {
    const m = e.data;
    if (e.source !== frame.contentWindow || e.origin !== location.origin || m?.version !== 1) return;
    if (m.sagebrush === "space-ready") { ready = true; send(); return; }
    if (m.sagebrush === "space-close") { done(); return; }
    if (m.sagebrush !== "space-read" || typeof m.path !== "string" || !Number.isSafeInteger(m.id)) return;
    const reply = (x: { text?: string; error?: string }) => { if (alive) frame.contentWindow?.postMessage({ sagebrush: "space-file", version: 1, id: m.id, ...x }, location.origin); };
    // (a path exactly as the tree listed it: nothing else is looked up, so no other spelling of a path reaches a file)
    const entry = m.path.length <= SPACE3D_LIMITS.path ? allowed.get(m.path) : undefined;
    if (!entry) return reply({ error: "not a file of this folder" });
    if (entry.kind === "board") return reply({ error: "a board has no room yet" });
    if (waiting >= SPACE3D_LIMITS.waiting) return reply({ error: "too many files asked for at once: try again" });
    if (++reads > SPACE3D_LIMITS.reads) return reply({ error: "too many files read in this view: close it and open it again" });
    waiting++;
    queue = queue.then(() => serve(m, entry, reply)).finally(() => { waiting--; });
  };
  addEventListener("message", onMessage);
}

/** What the Agents chat keeps of a shown space: its text to copy, and how to let it go. */
export type SpaceHost = { copy: () => string; dispose: () => Promise<void> };

// A .space.json in the Agents chat: the viewer in a frame, sent the file now and again each time it is written (by the
// agent, or in another tab). What the person selects there is written to the file as "selected" (an object's id, or
// null), so the agent reads it with the file; that write alone never redraws the space. The selection is checked first
// (an object of the space shown, or null) and written on the revision read: when the file changed meanwhile, it is
// read again and the selection put on the new text, so an agent's newer write is never overwritten.
// (the pane's layout for it, added to the page once, by this chunk: the page itself carries nothing of the 3D view)
const PANE_CSS = `#artifacts .pane-body:has(> .space-host:not([hidden])) { display: flex; flex-direction: column; overflow: hidden; }
#artifacts .pane-body > .space-host:not([hidden]) { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.space-frame { flex: 1; min-height: 0; width: 100%; border: 0; display: block; background: #0e1116; }`;
export function mountSpace(ws: Workspace, path: string, el: HTMLElement): SpaceHost {
  if (!document.getElementById("sb-space3d-css")) document.head.append(Object.assign(document.createElement("style"), { id: "sb-space3d-css", textContent: PANE_CSS }));
  const mk = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = "") => Object.assign(document.createElement(tag), { className: cls, textContent: text });
  const head = mk("div", "file-path", path + " "), saved = mk("span", "saved");
  head.append(saved);
  const frame = frameOf("The 3D view of " + path);
  frame.className = "space-frame";
  el.replaceChildren(head, frame);
  el.classList.add("space-host");
  let alive = true, ready = false, rev = -1, fid: string | undefined, text = "", space: Record<string, unknown> | null = null, shown = "";
  const say = (s: string) => { if (alive) saved.textContent = s; };
  // (the space without its selection: what the viewer is sent again only when it changes)
  const body = (s: Record<string, unknown>) => JSON.stringify({ ...s, selected: undefined });
  const send = () => {
    if (!alive || !ready || !space || body(space) === shown) return;
    shown = body(space);
    frame.contentWindow?.postMessage({ sagebrush: "space-load", version: 1, name: path, space, selected: space.selected ?? null }, location.origin);
  };
  // (the file as it is now, its bytes capped at what a space may be: a larger one isn't read whole, nor parsed)
  const reread = async () => {
    let r;
    try { r = await readCapped(ws, path, LIMITS.bytes); } catch (err) {
      if ((err as { code?: string }).code !== "limit") throw err;
      space = null;
      return say(`Too large to show (over ${LIMITS.bytes / 2 ** 20} MiB)`);
    }
    const now = r.entry.rev ?? -1;
    if (!alive || now === rev) return;
    rev = now;
    fid = r.entry.fid;
    text = decode(r.content);
    try {
      const s = JSON.parse(text);
      if (!s || typeof s !== "object" || Array.isArray(s)) throw new Error("it isn't an object");
      space = s;
      say("");
    } catch (e) {
      space = null;
      return say(`Not a space yet: ${(e as Error).message}`);
    }
    send();
  };
  void reread().catch((e) => say(`Couldn't read it: ${String((e as Error)?.message ?? e)}`));
  const unwatch = ws.watch((c) => {
    if (c.ops.some((o) => o.path === path || o.to === path)) void reread().catch(() => {});
  });
  // (an object's id in the space shown, or null: anything else isn't written)
  const selectable = (id: unknown): id is string | null =>
    id === null || (typeof id === "string" && id.length <= SPACE_SELECT_ID && Array.isArray(space?.nodes) && (space!.nodes as unknown[]).some((n) => (n as { id?: unknown } | null)?.id === id));
  // (the selection, written a moment after the last click, on the revision read: a conflict rereads and tries again)
  let timer = 0, want: string | null = null;
  const writeSelection = async (tries = 2): Promise<void> => {
    if (!alive || !space || (space.selected ?? null) === want || !selectable(want)) return;
    // (the text and its revision taken together: the write is on that revision, whatever was read since)
    const next = { ...space, selected: want }, base = rev, baseFid = fid;
    const value = JSON.stringify(next, null, 1);
    await SPACE3D_TESTING.beforeSelectionWrite?.();
    if (!alive) return;
    try {
      const r = await ws.write(path, value, { base, ...(baseFid ? { fid: baseFid } : {}) });
      rev = r.rev;
      text = value;
      space = next;
    } catch (e) {
      if ((e as { code?: string }).code === "conflict" && tries > 1) {
        await reread();
        return writeSelection(tries - 1);
      }
      say(`Selection not saved: ${(e as Error).message}`);
    }
  };
  const onMessage = (e: MessageEvent) => {
    const m = e.data;
    if (e.source !== frame.contentWindow || e.origin !== location.origin || m?.version !== 1) return;
    if (m.sagebrush === "space-ready") {
      ready = true;
      shown = "";
      send();
    } else if (m.sagebrush === "space-read" && Number.isSafeInteger(m.id)) {
      // (this page reads no files for a space: said at once, rather than left to the viewer's wait)
      frame.contentWindow?.postMessage({ sagebrush: "space-file", version: 1, id: m.id, error: "only Open in 3D reads your files" }, location.origin);
    } else if (m.sagebrush === "space-select") {
      const id = m.selection === null || m.selection === undefined ? null : m.selection?.id;
      if (!selectable(id)) return;
      want = id;
      clearTimeout(timer);
      timer = window.setTimeout(() => void writeSelection(), 500);
    }
  };
  addEventListener("message", onMessage);
  return {
    copy: () => text,
    dispose: async () => {
      alive = false;
      clearTimeout(timer);
      unwatch();
      removeEventListener("message", onMessage);
    },
  };
}
// (the longest object id a selection may name)
const SPACE_SELECT_ID = 1024;
