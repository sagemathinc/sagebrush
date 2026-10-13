// The board page (web/board/index.html): sagebrush.space as a board's host
// (mount.ts).  /board/?doc=URL shows a board document (web/board/doc.ts);
// /board/ alone, Sagebrush's own architecture (examples/sagebrush.json);
// ?mermaid=TEXT, a Mermaid flowchart; an exported file (export.ts), the
// document it carries; ?items=N&strokes=N, a synthetic board for the
// benchmark (bench.mjs, window.boardBench).  A document's tour steps through
// its items with ← and →, and #N in the address is step N; #p2 is page 2,
// #p2-3 its step 3.
//
// What this host gives the board:
// - store: the document from the address (or the file), and this browser's
//   edits of it, kept in localStorage per source until Revert;
// - images: pictures in this browser's IndexedDB (images.ts);
// - code: the notebook's engine (code.ts), Python in the runner, an
//   opaque-origin sandboxed frame (?runner=0: a plain worker);
// - math: KaTeX (sagebrush-math.js, or an exported file's own copy);
// - history: TimeTravel's versions in this browser's IndexedDB (history.ts,
//   patchflow from sagebrush-history.js);
// - the address's hash, the page's title, the examples, Download as HTML.
// An exported file has no code engine, no TimeTravel and no examples.
//
// window.sagebrush.board is the API for an agent driving the page (in the
// shared browser, say): load(doc), focus(ids), step(n), snapshot(), run(),
// outputs(), versions(), version(i); window.board is the board itself.
import { synthetic } from "./board";
import { isBoard, type BoardDoc } from "./doc";
import { BoardCode } from "./code";
import { boardFromText, fromMermaid } from "./mermaid";
import { embedded, exportHtml } from "./export";
import { Images } from "./images";
import { BoardHistory, type HistoryModule } from "./history";
import { mountBoard, type BoardHost } from "./mount";
import { IdbPatchStore, openBoardHistoryDb } from "../notebook/stores.js";

const q = new URLSearchParams(location.search);
// (?mermaid=TEXT: a flowchart given in the address; an exported file, its own)
const source = embedded() ? "embedded:" + location.pathname : q.get("doc") ?? (q.has("mermaid") ? "mermaid:" + q.get("mermaid") : "examples/sagebrush.json");
const saveKey = "sagebrush-board:" + source;
const bench = q.has("items") || q.has("strokes");
const file = !!embedded();

const host: BoardHost = {
  store: {
    async load() {
      if (bench) return null;
      let notice = "";
      const url = new URL(source.startsWith("mermaid:") || source.startsWith("embedded:") ? "data:," : source, location.href);
      // (JSON, or a Mermaid flowchart, or Markdown with some, or a CoCalc whiteboard)
      const original: BoardDoc = source.startsWith("embedded:") ? JSON.parse(embedded()!.textContent!) : source.startsWith("mermaid:") ? fromMermaid(source.slice(8)) : await fetch(url).then((r) => {
        if (!r.ok) throw new Error(`${url.pathname}: ${r.status} ${r.statusText}`);
        return r.text();
      }).then((t) => boardFromText(t, decodeURIComponent(url.pathname.split("/").pop() ?? ""), (md) => { notice = md; }));
      // (this browser's edits of it, if any)
      let saved: BoardDoc | null = null;
      try { saved = JSON.parse(localStorage.getItem(saveKey) ?? "null"); } catch {}
      return { doc: isBoard(saved) ? saved! : original, original, notice };
    },
    save(d) {
      try { localStorage.setItem(saveKey, JSON.stringify(d)); } catch {}
    },
    revert() {
      try { localStorage.removeItem(saveKey); } catch {}
    },
  },
  // pictures: kept in this browser by name
  images: new Images(),
  // (an exported file carries no interpreter: its code shows, as text)
  code: file ? undefined : () => new BoardCode(new URL("../", import.meta.url), {
    // (Python in the runner, an opaque-origin sandboxed frame, as on the notebook page: design/runner.md)
    runner: q.get("runner") !== "0" && globalThis.crossOriginIsolated === true && !(window as any).__TAURI__,
  }),
  // KaTeX, the notebook's (its stylesheet and fonts beside it); an exported
  // file carries the module as text: imported from a Blob
  math: () => {
    const own = document.getElementById("sb-math")?.textContent;
    return import(own ? URL.createObjectURL(new Blob([own], { type: "text/javascript" })) : new URL("../sagebrush-math.js", import.meta.url).href);
  },
  // TimeTravel: patchflow (in sagebrush-history.js) and a database of its own; not in an exported file
  history: file ? undefined : async () => {
    const [mod, db] = await Promise.all([import(new URL("../sagebrush-history.js", import.meta.url).href) as Promise<HistoryModule>, openBoardHistoryDb()]);
    return db ? new BoardHistory(mod, new IdbPatchStore(db, "board:" + source)).init() : null;
  },
  address: {
    get: () => location.hash,
    set: (hash) => history.replaceState(null, "", location.pathname + location.search + hash),
  },
  title: (t) => { document.title = (t ? t + " — " : "") + "Board — Sagebrush"; },
  home: file ? "https://sagebrush.space/board/" : "/",
  // (an exported file has no examples beside it)
  examples: file ? undefined : {
    async list() {
      const ex = (await (await fetch(new URL("examples/index.json", location.href))).json()) as { file: string; title: string; about: string }[];
      return ex.map((e) => ({ title: e.title, about: e.about, href: `?doc=${encodeURIComponent("examples/" + e.file)}`, current: source === "examples/" + e.file }));
    },
  },
  exportHtml: (d) => exportHtml(d),
};

const mounted = mountBoard(document.getElementById("board")!, host);
if (bench) {
  mounted.board.setItems(synthetic(Number(q.get("items") ?? 2000), Number(q.get("strokes") ?? 20000)));
  mounted.board.setCamera({ x: 0, y: 0, z: 1 });
}
// first paint: the end of the first render after load
requestAnimationFrame(() => requestAnimationFrame(() => { (window as any).firstPaint = performance.now(); }));

// (for tests: mount and unmount boards on this page with its host: test-mount.mjs)
export { mountBoard, host, mounted };

(window as any).board = mounted.board;
(window as any).boardBench = mounted.bench;
(window as any).sagebrush = { ...(window as any).sagebrush, board: mounted.agent };
