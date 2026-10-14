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
// - outputs: slow code items' outputs, kept between visits (outcache.ts);
// - code: the notebook's engine (code.ts), Python in the runner, an
//   opaque-origin sandboxed frame (?runner=0 on a loopback host: a plain worker);
// - math: KaTeX (sagebrush-math.js, or an exported file's own copy);
// - history: TimeTravel's versions in this browser's IndexedDB (history.ts,
//   patchflow from sagebrush-history.js);
// - the address's hash, the page's title, the examples, Download as HTML.
// An exported file has no code engine (its code shows, and a notice says it
// doesn't run), no TimeTravel and no examples.
//
// window.sagebrush.board is the API for an agent driving the page (in the
// shared browser, say): load(doc), focus(ids), step(n), snapshot(), run(),
// outputs(), versions(), version(i); window.board is the board itself.
import { synthetic } from "./board";
import { anyCode, isBoard, type BoardDoc } from "./doc";
import { BoardCode, siteEngine } from "./code";
import { OWN_ENGINE, chooseEngine, fileEngine } from "./engine";
import { IdbOutputCache } from "./outcache";
import { boardFromText, fromMermaid } from "./mermaid";
import { embedded, engineRef, exportHtml } from "./export";
import { Images } from "./images";
import { BoardHistory, type HistoryModule } from "./history";
import { mountBoard, type BoardHost } from "./mount";
import { IdbPatchStore, openBoardHistoryDb } from "../notebook/stores.js";

const q = new URLSearchParams(location.search);
// (?mermaid=TEXT: a flowchart given in the address; an exported file, its own)
const source = embedded() ? "embedded:" + location.pathname : q.get("doc") ?? (q.has("mermaid") ? "mermaid:" + q.get("mermaid") : "examples/sagebrush.json");
const saveKey = "sagebrush-board:" + source;
// (a document's history in this browser: by its source and its name beside it)
const historyKey = (id: string | null) => "board:" + source + (id ? ":" + id : "");
const bench = q.has("items") || q.has("strokes");
const file = !!embedded();
// (an exported file: the engine its code runs with, and the site it comes from)
const ref = file ? engineRef() : null;

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
      const doc = isBoard(saved) ? saved! : original;
      // (an exported file with no engine to run its code: its code shows, and it says so)
      if (file && !ref && anyCode(doc)) notice = "**This file shows its code but doesn't run it.** To run it, download its JSON (⋯) and open that at [sagebrush.space/board](https://sagebrush.space/board/).";
      return { doc, original, notice };
    },
    save(d) {
      try { localStorage.setItem(saveKey, JSON.stringify(d)); } catch {}
    },
    revert() {
      try { localStorage.removeItem(saveKey); } catch {}
    },
    // (whether it was written here, a new board: kept beside it, never in it)
    writtenHere(set) {
      const k = saveKey + "#here";
      try {
        if (set === true) localStorage.setItem(k, "1");
        else if (set === false) localStorage.removeItem(k);
        return localStorage.getItem(k) === "1";
      } catch {
        return false;
      }
    },
    // (its name in this browser, its outputs' cache's and its history's:
    // random, kept beside it; under the key it had as the cache's alone)
    documentId(fresh) {
      const k = saveKey + "#outputs";
      let id: string | null = null;
      try { id = fresh ? null : localStorage.getItem(k); } catch {}
      if (!id || !/^[0-9a-f]{32}$/.test(id)) {
        id = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
        try { localStorage.setItem(k, id); } catch {}
      }
      return id;
    },
  },
  // pictures: kept in this browser by name
  images: new Images(),
  // slow code items' outputs, kept in this browser (outcache.ts); not in an exported file
  outputs: file || bench ? undefined : new IdbOutputCache(OWN_ENGINE?.id),
  // the engine of code items: the site's, Python in the runner, an
  // opaque-origin sandboxed frame, as on the notebook page (design/runner.md);
  // an exported file's, carried in it or fetched from its site, by its id or
  // the latest (engine.ts)
  // (?runner=0 only on a loopback host, for tests: elsewhere a link could add
  // it to someone else's code; only in Chromium, as on the notebook page)
  code: !file ? () => new BoardCode(siteEngine(new URL("../", import.meta.url), !(q.get("runner") === "0" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) && globalThis.crossOriginIsolated === true && "userAgentData" in navigator && !(window as any).__TAURI__))
    : ref ? (d) => new BoardCode(fileEngine(() => chooseEngine(ref, d.engine), { sage: d.mode === "sage", math: document.getElementById("sb-math")?.textContent })) : undefined,
  // KaTeX, the notebook's (its stylesheet and fonts beside it); an exported
  // file carries the module as text: imported from a Blob
  math: () => {
    const own = document.getElementById("sb-math")?.textContent;
    return import(own ? URL.createObjectURL(new Blob([own], { type: "text/javascript" })) : new URL("../sagebrush-math.js", import.meta.url).href);
  },
  // TimeTravel: patchflow (in sagebrush-history.js) and a database of its own; not in an exported file
  // (each document its own: by its name beside it in this browser)
  history: file ? undefined : async (id) => {
    const [mod, db] = await Promise.all([import(new URL("../sagebrush-history.js", import.meta.url).href) as Promise<HistoryModule>, openBoardHistoryDb()]);
    return db ? new BoardHistory(mod, new IdbPatchStore(db, historyKey(id))).init() : null;
  },
  // (a document replaced: its versions, without opening its history)
  dropHistory: file ? undefined : async (id) => {
    const db = await openBoardHistoryDb();
    if (db) await new IdbPatchStore(db, historyKey(id)).drop();
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
  exportHtml: (d, o) => exportHtml(d, o),
  // (the engine's parts, compressed, with the Sage library: every language
  // runs, after the board's is changed too)
  exportPython: () => (OWN_ENGINE ? "8 MB" : null),
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
// (for a host whose documents are kept elsewhere: a copy in this browser first; the tests' fake remote)
export { cachedStore, IdbDocCache, merge3, docHash } from "./cached";

(window as any).board = mounted.board;
(window as any).boardBench = mounted.bench;
(window as any).sagebrush = { ...(window as any).sagebrush, board: mounted.agent };
