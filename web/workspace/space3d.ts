// Open in 3D (the file browser's ⋯ on a folder, and its ⋯ menu for all files): the folder shown as the whitespace's
// rooms (space/src/treeroom.js), over the page, in a frame of the space viewer (/space/?embed=1).  The viewer is sent
// the folder's tree: each file's path below the folder, its length, its kind (a data file, a notebook, a board) and
// a Python file's imports; a file's contents only when the viewer asks for them (space-read), and only for files in
// that tree.  Nothing is written: this is reading.  (The whitespace prototype only: space/README.md.)
import type { Entry, Workspace } from "./api";
import { TRASH, nameOf, within } from "./paths";

// (text files whose lines are counted, and whose imports are read; others get a length from their size)
const TEXT = /\.(py|sage|pyx|ts|mts|tsx|js|mjs|rs|m|magma|md|txt|tex|bib|json|toml|ya?ml|sh|html|css|csv|gp|g|jl|r|c|h|cc|cpp|hpp|space\.json)$/i;
const MAX_READ = 2000, MAX_BYTES = 1 << 20, MAX_SEND = 4 << 20; // (MAX_SEND: the largest file the viewer is given)
// (from X import a, b; from X import (a,\n b); import a.b, c)
const PYIMP = /^[ \t]*(?:from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+(?:\(([^)]*)\)|([\w., \t*]+))|import[ \t]+([\w., \t]+))/gm;

const decode = (c: unknown): string => (typeof c === "string" ? c : c instanceof Uint8Array ? new TextDecoder().decode(c) : c instanceof ArrayBuffer ? new TextDecoder().decode(new Uint8Array(c)) : JSON.stringify(c));
const lineCount = (t: string) => (t.length ? t.split("\n").length - (t.endsWith("\n") ? 1 : 0) : 0);

/** A Python file's imports, as [module, ...names taken from it] (resolved to files by the viewer). */
function pyImports(text: string): string[][] {
  const out: string[][] = [];
  for (const m of text.matchAll(PYIMP)) {
    if (m[4]) { for (const name of m[4].split(",")) { const mod = name.trim().split(/\s+/)[0]; if (mod) out.push([mod]); } continue; }
    const names = (m[2] ?? m[3] ?? "").replace(/#.*$/gm, "").split(",").map((s) => s.trim().split(/\s+/)[0]).filter((s) => s && s !== "*");
    out.push([m[1], ...names]);
  }
  return out;
}

export async function openIn3D(ws: Workspace, folder: string): Promise<void> {
  const prefix = folder === "/" ? "/" : folder.replace(/\/$/, "") + "/";
  const title = folder === "/" ? "All files" : nameOf(folder);
  // ---- the overlay: a bar (the folder, Close) and the frame
  const box = document.createElement("div");
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", `${title} in 3D`);
  box.style.cssText = "position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;background:#0e1116";
  const bar = document.createElement("div");
  bar.style.cssText = "display:flex;align-items:center;gap:10px;padding:6px 10px;font:14px system-ui,sans-serif;color:#e8eef7;background:#161b22;border-bottom:1px solid #2c3442";
  const name = Object.assign(document.createElement("div"), { textContent: `${title} · in 3D` });
  name.style.cssText = "flex:1;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
  const state = Object.assign(document.createElement("span"), { textContent: "reading the folder…" });
  state.style.cssText = "color:#93a1b5;font-size:12px";
  const close = Object.assign(document.createElement("button"), { textContent: "✕ Close", title: "Close the 3D view (Esc)" });
  close.style.cssText = "font:inherit;color:inherit;background:#21262d;border:1px solid #364055;border-radius:6px;padding:4px 12px;cursor:pointer";
  bar.append(name, state, close);
  const frame = document.createElement("iframe");
  frame.src = "/space/?embed=1";
  frame.title = `${title} in 3D`;
  frame.allow = "fullscreen; xr-spatial-tracking"; // (and a headset: the space's Enter VR)
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

  // ---- the tree: listed, and the text files' lengths and imports read (a large folder: the first MAX_READ of them)
  const allowed = new Map<string, Entry>(); // (a path below the folder -> its entry: what the viewer may read)
  let space: Record<string, unknown> | null = null, ready = false;
  const send = () => { if (alive && ready && space) frame.contentWindow?.postMessage({ sagebrush: "space-load", version: 1, name: `${title} (3D)`, space }, location.origin); };
  void (async () => {
    const entries = (await ws.list(folder, { recursive: true })).filter((e) => e.kind !== "folder" && !within(e.path, TRASH) && e.path.startsWith(prefix));
    entries.sort((a, b) => a.path.localeCompare(b.path));
    // (first the tree with lengths from sizes, shown at once; then, the text files read (eight at a time), their
    //  lengths and imports, sent again: the viewer keeps where you are)
    const files: [string, number, string][] = entries.map((e) => [e.path.slice(prefix.length), e.kind === "notebook" || e.kind === "board" ? 40 : Math.max(1, Math.round((e.size ?? 0) / 40)), e.kind]);
    const pyimports: Record<string, string[][]> = {};
    entries.forEach((e, k) => allowed.set(files[k][0], e));
    const make = () => ({
      format: "sagebrush-space", version: 1, title: `${title} (your files)`,
      summary: `${files.length} file${files.length === 1 ? "" : "s"} in ${folder === "/" ? "your workspace" : folder}. Enter a folder, a Python or Sage file, or a notebook.`,
      nodes: [], tree: { name: title, commit: null, base: "workspace:", files: files.map((f) => [...f]), imports: [], pyimports: { ...pyimports } },
    });
    const todo = entries.map((e, k) => k).filter((k) => {
      const e = entries[k];
      return (e.kind === "file" && TEXT.test(e.path) && (e.size ?? 0) <= MAX_BYTES) || e.kind === "notebook";
    }).slice(0, MAX_READ);
    if (todo.length > 100) { space = make(); send(); }
    let next = 0, read = 0;
    const worker = async () => {
      while (alive && next < todo.length) {
        const k = todo[next++], e = entries[k];
        try {
          const r = await ws.read(e.path);
          if (e.kind === "notebook") {
            const cells = Array.isArray(r.content?.cells) ? (r.content.cells as unknown[]) : [];
            files[k][1] = Math.max(1, cells.reduce((s: number, c) => s + lineCount(String((c as { code?: unknown } | null)?.code ?? "")) + 1, 0));
          } else {
            const t = decode(r.content);
            files[k][1] = lineCount(t);
            if (/\.(py|sage)$/i.test(e.path)) pyimports[files[k][0]] = pyImports(t);
          }
        } catch { /* (its contents aren't in this browser: its size will do) */ }
        if (++read % 50 === 0) state.textContent = `reading the folder… ${read} of ${todo.length} files`;
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    if (!alive) return;
    space = make();
    state.textContent = files.length ? "" : "this folder has no files";
    send();
  })().catch((e) => { if (alive) state.textContent = `couldn't read the folder: ${String((e as Error)?.message ?? e)}`; });

  // ---- the viewer's messages: ready (send it the tree), and a file's contents (only one of the tree's)
  const onMessage = async (e: MessageEvent) => {
    const m = e.data;
    if (e.source !== frame.contentWindow || e.origin !== location.origin || m?.version !== 1) return;
    if (m.sagebrush === "space-ready") { ready = true; send(); return; }
    if (m.sagebrush === "space-close") { done(); return; }
    if (m.sagebrush !== "space-read" || typeof m.path !== "string") return;
    const reply = (x: { text?: string; error?: string }) => frame.contentWindow?.postMessage({ sagebrush: "space-file", version: 1, id: m.id, ...x }, location.origin);
    const entry = allowed.get(m.path);
    if (!entry) return reply({ error: "not a file of this folder" });
    if (entry.kind === "file" && (entry.size ?? 0) > MAX_SEND) return reply({ error: `it's too large to read here (${Math.round((entry.size ?? 0) / 2 ** 20)} MB)` });
    try {
      const r = await ws.read(entry.path);
      if (entry.kind === "notebook") {
        // (a notebook: its language and cells (code, kind, outputs), for its room)
        const raw = Array.isArray(r.content?.cells) ? (r.content.cells as unknown[]) : [];
        const cells = raw.filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
          .map((c) => ({ id: c.id, type: c.type ?? "code", code: String(c.code ?? ""), outputs: Array.isArray(c.outputs) ? c.outputs : [] }));
        reply({ text: JSON.stringify({ format: "sagebrush-notebook-cells", mode: r.content?.mode ?? "python", cells }) });
      } else if (entry.kind === "board") reply({ error: "a board has no room yet" });
      else reply({ text: decode(r.content) });
    } catch (err) {
      reply({ error: String((err as Error)?.message ?? err) });
    }
  };
  addEventListener("message", onMessage);
}
