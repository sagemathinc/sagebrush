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
import { IdbOutputCache, MemoryOutputCache, carriedOutputs } from "./outcache";
import { boardFromText, fromMermaid } from "./mermaid";
import { embedded, engineRef, exportHtml, fileOutputs } from "./export";
import { Images } from "./images";
import { BoardHistory, type HistoryModule } from "./history";
import { mountBoard, type BoardHost } from "./mount";
import { answerChannel, type AnswerChannel } from "./channel";
import { IdbPatchStore, openBoardHistoryDb } from "../notebook/stores.js";

const q = new URLSearchParams(location.search);

// Boards made here (New board, Duplicate, and the notebook's New whiteboard
// and Whiteboard) are each a board of their own, `?doc=local:ID`, kept in
// this browser as the edits of the others are, and listed (their title,
// language and when last written) so that the notebook's Whiteboard opens
// its language's latest: `?recent=MODE` (or a new one, if there is none);
// `?new=MODE`, a new one.
const LOCAL_LIST = "sagebrush-boards", MODES = ["python", "sage", "magma", "matlab"];
// (the list's bounds: its newest records, each title cut, HARD-7F9-2)
const LOCAL_MAX = 200, TITLE_MAX = 200;
// (why nothing is kept: said, and no board presented as kept, HARD-7F9-1)
const STORAGE_REFUSED = "this browser's storage for this site is full, or turned off";
type LocalBoard = { id: string; title: string; mode: string; at: number };
const hex = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");
const localKey = (id: string) => "sagebrush-board:local:" + id;
// (the list as found: each record checked, its title cut, one record an id
// (its newest), none from the future, the newest LOCAL_MAX, newest first)
function localBoards(): LocalBoard[] {
  let l: unknown;
  try { l = JSON.parse(localStorage.getItem(LOCAL_LIST) ?? "[]"); } catch { return []; }
  if (!Array.isArray(l)) return [];
  const soon = Date.now() + 864e5, byId = new Map<string, LocalBoard>();
  for (const b of l) {
    if (!b || typeof b !== "object" || typeof b.id !== "string" || !/^[0-9a-f]{12}$/.test(b.id) || !MODES.includes(b.mode) || typeof b.at !== "number" || !Number.isFinite(b.at) || b.at < 0 || b.at > soon) continue;
    const r = { id: b.id, title: typeof b.title === "string" ? b.title.slice(0, TITLE_MAX) : "", mode: b.mode, at: b.at };
    const was = byId.get(r.id);
    if (!was || was.at < r.at) byId.set(r.id, r);
  }
  return [...byId.values()].sort((x, y) => y.at - x.at).slice(0, LOCAL_MAX);
}
const writeList = (l: LocalBoard[]) => { try { localStorage.setItem(LOCAL_LIST, JSON.stringify(l.slice(0, LOCAL_MAX))); return true; } catch { return false; } };
/** This board listed as written now (false: storage refused it) */
function listLocal(id: string, d: BoardDoc): boolean {
  const l = localBoards().filter((b) => b.id !== id);
  l.unshift({ id, title: String(d.title ?? "").slice(0, TITLE_MAX), mode: d.mode ?? "python", at: Date.now() });
  return writeList(l);
}
// (a board of this browser's, as kept: null if it is gone or not a board)
function localDoc(id: string): BoardDoc | null {
  try {
    const d = JSON.parse(localStorage.getItem(localKey(id)) ?? "null");
    return isBoard(d) ? d : null;
  } catch {
    return null;
  }
}
/** A new board of this browser's, written, listed, and read back as written:
 * its id; null if storage refused any of it (and nothing of it left) */
function makeLocal(d: BoardDoc): string | null {
  const id = hex(6), key = localKey(id), text = JSON.stringify(d);
  try {
    localStorage.setItem(key, text);
    localStorage.setItem(key + "#here", "1");
    if (localStorage.getItem(key) !== text || !listLocal(id, d) || !localBoards().some((b) => b.id === id)) throw new Error(STORAGE_REFUSED);
    return id;
  } catch {
    try {
      localStorage.removeItem(key);
      localStorage.removeItem(key + "#here");
    } catch {}
    return null;
  }
}
// (the newest board of this language that is there: records of boards gone
// or not boards dropped, of another language now put right, HARD-7F9-2)
function latestLocal(mode: string): string | null {
  const l = localBoards();
  let changed = false, found: string | null = null;
  for (const b of [...l]) {
    const d = localDoc(b.id);
    if (!d) {
      l.splice(l.indexOf(b), 1);
      changed = true;
    } else if ((d.mode ?? "python") !== b.mode) {
      b.mode = d.mode ?? "python";
      changed = true;
    }
    if (d && !found && b.mode === mode) found = b.id;
  }
  if (changed) writeList(l);
  return found;
}
const blankBoard = (mode: string): BoardDoc => ({ title: "Untitled board", ...(mode !== "python" ? { mode: mode as BoardDoc["mode"] } : {}), seed: hex(32), nodes: [] });
const openLocal = (id: string) => location.assign(location.pathname + "?doc=local:" + id);
// ?new=MODE and ?recent=MODE: one of them says both what and in which
// language: new if it is there, else recent; the first value of either
// (CORR-7F9-3).  A new board storage refused: shown, as not kept, the
// address as it was (a reload tries again)
let unsaved: string | null = null;
{
  const made = q.getAll("new"), recent = !made.length, asked = (recent ? q.getAll("recent") : made)[0];
  if (asked !== undefined && !embedded()) {
    const mode = MODES.includes(asked) ? asked : "python";
    const id = (recent ? latestLocal(mode) : null) ?? makeLocal(blankBoard(mode));
    if (id) {
      q.delete("new");
      q.delete("recent");
      q.set("doc", "local:" + id);
      history.replaceState(null, "", location.pathname + "?" + q.toString().replace("local%3A", "local:") + location.hash);
    } else unsaved = mode;
  }
}
// (?mermaid=TEXT: a flowchart given in the address; an exported file, its own)
const source = unsaved ? "unsaved:" + unsaved : embedded() ? "embedded:" + location.pathname : q.get("doc") ?? (q.has("mermaid") ? "mermaid:" + q.get("mermaid") : "examples/sagebrush.json");
const saveKey = "sagebrush-board:" + source;
const local = /^local:[0-9a-f]{12}$/.test(source);
// (a document's history in this browser: by its source and its name beside it)
const historyKey = (id: string | null) => "board:" + source + (id ? ":" + id : "");
const bench = q.has("items") || q.has("strokes");
const file = !!embedded();
// (the frame other sites show a board in, /frame/board/ (export.ts
// frameHtml, design/frame.md): an exported page whose document its parent
// posts, its engine the one it was built with, from the site it is served
// from, which exporting it again names too)
const fromParent = embedded()?.dataset.sbFrom === "parent";
if (fromParent && OWN_ENGINE && !document.getElementById("sb-engine-ref")) {
  const r = document.createElement("script");
  r.type = "application/json";
  r.id = "sb-engine-ref";
  r.textContent = JSON.stringify({ site: new URL("/", location.href).href, id: OWN_ENGINE.id });
  document.head.append(r);
}
// (an exported file: the engine its code runs with, and the site it comes from)
const ref = file ? engineRef() : null;

// A frame's document: the first its parent posts, as
// { sagebrush: "board", version: 1, text, name? } (a file's contents and
// name: JSON, Mermaid, Markdown, a CoCalc whiteboard or a JSON Canvas, as
// Open… takes).  Only the parent's messages count.  The frame says
// { sagebrush: "ready", version: 1 } when it listens, and
// { sagebrush: "error", version: 1, message } for a text that isn't a board.
// A later board starts the frame afresh, a new page with a new interpreter
// (nothing the first board's code did reaches it: ISO-A75-2), which says
// ready again: its parent answers each ready with the board to show.
// Opened on its own, it shows an empty board that says what it is for.
//
// A host that takes answers (web/board-host-protocol.md) loads the frame
// with a nonce in its address, #sb-nonce=N: the frame removes it from the
// address at once and says it in its first ready, and takes a port only
// with the first board, only if it was given one.  On that port go the
// Submit bar's answers and the questions' requests to decide (channel.ts).
let fromParentDoc: (d: { doc: BoardDoc; notice: string }) => void = () => {};
const parentDoc = new Promise<{ doc: BoardDoc; notice: string }>((r) => (fromParentDoc = r));
let answers: AnswerChannel | null = null;
if (fromParent) {
  // (nothing it says is secret: to any parent; the nonce only once)
  const said = /^#sb-nonce=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(location.hash);
  let nonce: string | null = said ? said[1] : null;
  if (said) try { history.replaceState(null, "", location.pathname + location.search); } catch {}
  const say = (m: { sagebrush: string; message?: string; nonce?: string }) => parent.postMessage({ ...m, version: 1 }, "*");
  if (parent === window) fromParentDoc({ doc: { title: "Board", nodes: [] }, notice: "**This page shows a board another site's page gives it.** To open a board, go to [sagebrush.space/board](https://sagebrush.space/board/)." });
  else {
    let first = true;
    addEventListener("message", (e) => {
      const m = e.data;
      if (e.source !== parent || !m || m.sagebrush !== "board" || m.version !== 1 || typeof m.text !== "string") return;
      let notice = "", doc: BoardDoc;
      try {
        doc = boardFromText(m.text, typeof m.name === "string" ? m.name : undefined, (md) => { notice = md; });
        if (!isBoard(doc)) throw new Error("not a board");
      } catch (err: any) {
        say({ sagebrush: "error", message: String(err?.message ?? err) });
        return;
      }
      if (first) {
        // (its channel: the port given with it, to a frame given a nonce; name and revision echoed as posted)
        const port = e.ports?.[0], revision = m.revision === undefined || m.revision === null ? null : typeof m.revision === "string" && m.revision.length <= 200 ? m.revision : undefined;
        if (port && given && revision !== undefined) answers = answerChannel(port, typeof m.name === "string" ? m.name : null, revision);
        host.answers = answers;
        // (the page gone: what waits for the host settled, the port closed)
        addEventListener("pagehide", () => answers?.close());
        fromParentDoc({ doc, notice });
      } else location.reload();
      first = false;
    });
    const given = nonce !== null;
    say({ sagebrush: "ready", ...(nonce ? { nonce } : {}) });
    nonce = null;
  }
}

// (the engine an exported file's code last ran with, as chooseEngine chose it)
let chosen: string | null = null;
const host: BoardHost = {
  store: {
    async load() {
      if (bench) return null;
      if (fromParent) {
        const { doc, notice } = await parentDoc;
        return { doc, original: doc, notice };
      }
      // (a new board storage refused: shown, saying it isn't kept)
      if (unsaved) return { doc: blankBoard(unsaved), original: null, notice: `**This board isn't kept:** ${STORAGE_REFUSED}. Download it (File) to keep what you write, or make room and reload.` };
      // (a board of this browser's: as it was last written here, with no
      // original to go back to; gone, a blank one that says so)
      if (local) {
        const kept = localDoc(source.slice(6));
        return kept ? { doc: kept, original: null } : { doc: blankBoard("python"), original: null, notice: "**This board isn't in this browser** (any more): what you write here is kept as a board of its own." };
      }
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
    // (refused by storage: said, HARD-7F9-1)
    // (a frame keeps nothing, by design, and has no storage to keep it in:
    // its answers are kept while it is open, and sent by Submit; nothing to
    // say, web/board-host-protocol.md "Unsent answers")
    save(d) {
      if (fromParent) return;
      if (unsaved) throw new Error(STORAGE_REFUSED);
      try { localStorage.setItem(saveKey, JSON.stringify(d)); } catch { throw new Error(STORAGE_REFUSED); }
      if (local && !listLocal(source.slice(6), d)) throw new Error(STORAGE_REFUSED);
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
  // slow code items' outputs, kept in this browser (outcache.ts); in an
  // exported file, those it carries (and what runs, until the page closes)
  outputs: bench ? undefined : file ? new MemoryOutputCache(carriedOutputs(fileOutputs())) : new IdbOutputCache(OWN_ENGINE?.id),
  // the engine of code items: the site's, Python in the runner, an
  // opaque-origin sandboxed frame, as on the notebook page (design/runner.md);
  // an exported file's, carried in it or fetched from its site, by its id or
  // the latest (engine.ts)
  // (?runner=0 only on a loopback host, for tests: elsewhere a link could add
  // it to someone else's code; only in Chromium, as on the notebook page)
  code: !file ? () => new BoardCode(siteEngine(new URL("../", import.meta.url), !(q.get("runner") === "0" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) && globalThis.crossOriginIsolated === true && "userAgentData" in navigator && !(window as any).__TAURI__))
    // (a frame's, always the engine it was built with: a posted board can't ask for another, DOC-A75-3)
    // (one for each language the board's items are in: Sage's with its library, item 16)
    : ref ? (d, mode) => new BoardCode(fileEngine(() => chooseEngine(ref, fromParent ? "pinned" : d.engine).then((e) => ((chosen = e.id), e)), { sage: mode === "sage", math: document.getElementById("sb-math")?.textContent })) : undefined,
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
  // (which Sagebrush: the site's /version.json, each field checked, as data;
  // an exported file, or a site without it, the engine that ran its code
  // (the latest, or its own when it fell back: CORR-20A-1), else the one it
  // was built with or carries)
  version: async () => {
    const own = chosen ?? ref?.id ?? OWN_ENGINE?.id, v: { version?: string; build?: string; engine?: string } = {};
    if (!file) {
      try {
        const r = await fetch(new URL("/version.json", location.href), { cache: "no-store" });
        const j = r.ok ? await r.json() : null;
        if (j && typeof j === "object") {
          if (typeof j.version === "string" && /^[\w.+-]{1,40}$/.test(j.version)) v.version = j.version;
          if (typeof j.build === "string" && /^[0-9a-f]{6,64}$/.test(j.build)) v.build = j.build;
          if (typeof j.engine === "string" && /^[0-9a-f]{6,64}$/.test(j.engine)) v.engine = j.engine;
        }
      } catch {}
    }
    v.engine ??= own && /^[0-9a-f]{6,64}$/.test(own) ? own : undefined;
    return v.version || v.build || v.engine ? v : null;
  },
  exportHtml: (d, o) => exportHtml(d, o),
  // (an exported file is itself the saved board: Ctrl/Cmd+S is the browser's, CORR-2C4-1)
  saveKey: !file,
  // (the engine's parts, compressed, with the Sage library: every language
  // runs, after the board's is changed too)
  exportPython: () => (OWN_ENGINE ? "8 MB" : null),
  // (boards of their own here, which this one stays beside; not in an exported file)
  // (made, kept and listed first, or not gone to: HARD-7F9-1)
  newBoard: file ? undefined : (mode) => { const id = makeLocal(blankBoard(mode)); if (!id) throw new Error(STORAGE_REFUSED); openLocal(id); },
  duplicate: file ? undefined : (d) => { const id = makeLocal({ ...JSON.parse(JSON.stringify(d)), title: (d.title || "Untitled board") + " (copy)" }); if (!id) throw new Error(STORAGE_REFUSED); openLocal(id); },
  // (an exported file's or a frame's empty board opens as any other)
  editBlank: !file,
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
