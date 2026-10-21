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
//
// The workspace (web/workspace/, design/workspace-files.md): boards made
// here are documents of this browser's workspace, `/<title>.board.json`,
// kept in its IndexedDB under their ids (which the address still names,
// ?doc=local:ID, until routing by path comes).  At load, what this browser
// kept before (boards in localStorage) is brought in (migrate: nothing
// deleted).  Each save is also written at once to localStorage as pending
// (`sagebrush-workspace-pending:ID`) until the workspace has it, so a page
// closed mid-write loses nothing: the next load takes the pending copy.
// Where the workspace can't be opened, boards are kept in localStorage as
// before.  window.sagebrush.workspace is the workspace as an agent sees it
// (§8.2), its changes credited to agent:page.
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
import { DOC_INDEX, prepareIndex, type DocEntry } from "../docsearch";
import { answerChannel, type AnswerChannel } from "./channel";
import { IdbPatchStore, openBoardHistoryDb, openHistoryDb, openBlobDb, onHistoryRefused } from "../notebook/stores.js";
import { Workspace, migrate, freePath, nameOf, splitExt, safeName, LIMITS, startMigrator, showReloadNotice, showLossNotice, showBusyNotice, hideBusyNotice, type Entry } from "../workspace/index";
// (TimeTravel not keeping up while another tab holds the workspace's lock: said, notebook/stores.js HISTORY_BACKLOG)
onHistoryRefused((m: string) => showBusyNotice(m));
import { uploadFiles, openableAs, convertCopy, pauseBoard, isPaused, unpause, carryNotice, takeNotice, type DocKind } from "../workspace/upload";
import { readBundle, keepBundle } from "../notebook/bundle.js";
import { openFilesDialog, recentOpened, recentLabel, recordOpened } from "../workspace/fileopen";
import { mountBrowser } from "../workspace/browser";
import { within } from "./idb-open";

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
 * its id; null if storage refused any of it (and nothing of it left).
 * `here`: marked as written here (as makeInWorkspace's: a copy no more
 * than what it copies, CORR-30D-1). */
function makeLocal(d: BoardDoc, here = true): string | null {
  const id = hex(6), key = localKey(id), text = JSON.stringify(d);
  try {
    localStorage.setItem(key, text);
    if (here) localStorage.setItem(key + "#here", "1");
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
// (?workspace=0, on a loopback host only (tests of the fallback, as ?runner=0): boards kept in localStorage as before)
const noWorkspace = q.get("workspace") === "0" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
const localUrl = (id: string) => location.pathname + "?doc=local:" + id + (noWorkspace ? "&workspace=0" : "");
// This browser's workspace, what was kept before brought in (a page that
// keeps nothing, an exported file, a frame or the benchmark: none); none,
// where storage can't be opened in time (boards kept in localStorage as
// before)
// (one owner: a workspace that opens after the page gave up on it is closed
// unused, and the page keeps boards as before for this visit: LIMIT-12C-3)
let wsAbandoned = false;
const ws: Workspace | null = embedded() || q.has("items") || q.has("strokes") || noWorkspace ? null : await within(Workspace.open().then(async (w) => {
  try { await migrate(w, localStorage, { proceed: () => !wsAbandoned }); } catch (e) { console.warn("workspace: bringing in what was kept before:", e); }
  if (wsAbandoned) {
    w.close();
    return null;
  }
  return w;
}).catch((e) => {
  console.warn("workspace:", e);
  // (the workspace can't be opened: said, never taken for a first visit)
  showLossNotice({ durability: { state: "unknown", why: String((e as Error)?.message ?? e) } });
  return null;
}), 5000, null);
if (!ws) wsAbandoned = true;
// (a newer page upgraded the workspace: said, with Reload; and its files moved beside the index, a little at a time)
if (ws) {
  ws.onClosed(() => showReloadNotice());
  if (ws.closed) showReloadNotice();
  // (this browser's copy of the workspace lost, or missing changes: said, with the person's choices; nothing written
  // until then; said again when that changes, another tab's say)
  showLossNotice(ws);
  ws.onDurability(() => showLossNotice(ws!));
  // (a long deletion of old versions: said as it goes, so it never looks stuck)
  ws.onDeleting((done) => (done < 1 ? showBusyNotice(`Deleting old versions… ${Math.floor(done * 100)}%`) : hideBusyNotice()));
  void startMigrator(ws);
}
const PENDING = "sagebrush-workspace-pending:", PENDING_UNREAD = "sagebrush-workspace-pending-unread:";
/** The largest save journaled as pending (characters of JSON): a larger board is kept by the workspace alone, and a pending value larger than this isn't ours to parse (LIMIT-12C-4). */
const PENDING_MAX = 8 * 2 ** 20;
/** A new board in the workspace, `/<title>.board.json` (the first free name): its id.
 * `here`: marked as written here, its notes' remote pictures shown at once
 * (SEC-89C-3); a board made blank here is, and a copy is as trusted as what
 * it copies: a copy the page makes by itself (a conflict's, a closed
 * page's changes) never more (CORR-30D-1). */
/** (`as`: its provenance (design/capabilities.md §6): `person`, made by the person here (New board, a first
 * visit's blank board); `copyOf`, a copy of that board, its provenance; else made from elsewhere) */
async function makeInWorkspace(w: Workspace, d: BoardDoc, here: boolean, signal?: AbortSignal, as: { person?: true; copyOf?: string } = {}): Promise<string> {
  const top = new Set((await w.list("/")).map((e) => e.path));
  const p = freePath("/", safeTitle(d.title), ".board.json", (x) => top.has(x));
  if (!p) throw new Error("no free name for a new board");
  const opts = { content: d, mode: d.mode ?? "python", signal };
  const src = as.copyOf ? await w.pathOf("board", as.copyOf).then((q) => (q ? w.stat(q) : undefined)).catch(() => undefined) : undefined;
  const e = as.person ? await w.createByPerson(p, opts) : src ? await w.createCopyOf(src, p, opts) : await w.create(p, opts);
  if (here) try { localStorage.setItem(hereKey(e.ref!), "1"); } catch {}
  return e.ref!;
}
const hereKey = (id: string) => "sagebrush-board:local:" + id + "#here";
const isHere = (key: string) => { try { return localStorage.getItem(key) === "1"; } catch { return false; } };
const safeTitle = (t: unknown) => String(t ?? "").replace(/[\/\u0000-\u001f\u007f]/g, "-").trim().slice(0, 200).trim() || "Untitled board";
/** The workspace's latest board in this language (not in Trash, not missing): its id. */
async function latestInWorkspace(w: Workspace, mode: string): Promise<string | null> {
  const boards = (await w.list("/", { recursive: true })).filter((e) => e.kind === "board" && !e.missing && (e.mode ?? "python") === mode);
  boards.sort((a, b) => b.updated - a.updated);
  return boards[0]?.ref ?? null;
}
// ?new=MODE and ?recent=MODE: one of them says both what and in which
// language: new if it is there, else recent; the first value of either
// (CORR-7F9-3).  A new board storage refused: shown, as not kept, the
// address as it was (a reload tries again)
let unsaved: string | null = null;
{
  const made = q.getAll("new"), recent = !made.length, asked = (recent ? q.getAll("recent") : made)[0];
  if (asked !== undefined && !embedded()) {
    const mode = MODES.includes(asked) ? asked : "python";
    let id: string | null = null;
    if (ws) {
      try { id = (recent ? await latestInWorkspace(ws, mode) : null) ?? (await makeInWorkspace(ws, blankBoard(mode), true, undefined, { person: true })); } catch (e) { console.warn("workspace:", e); }
    } else id = (recent ? latestLocal(mode) : null) ?? makeLocal(blankBoard(mode));
    if (id) {
      q.delete("new");
      q.delete("recent");
      q.set("doc", "local:" + id);
      history.replaceState(null, "", location.pathname + "?" + q.toString().replace("local%3A", "local:") + location.hash);
    } else unsaved = mode;
  }
}
// (what a conversion said (what it left out), for the board made from it:
// shown when that board opens, once; this tab only)
const CONVERTED = "sagebrush-board-converted:";
function convertedAsBoard(w: Workspace, e: Entry, mode: string): Promise<Entry> {
  let note = "";
  return convertCopy(w, e, "board", { maxBytes: LIMITS.maxBoardBytes, mode, asBoard: (name, text) => boardFromText(text, name, (md) => { note = md; }) }).then((made) => {
    if (note) try { sessionStorage.setItem(CONVERTED + made.ref, note); } catch {}
    // (made from a file the person brought in: its code waits for them)
    pauseBoard(made.ref!);
    return made;
  });
}
function takeConverted(id: string): string {
  try { const md = sessionStorage.getItem(CONVERTED + id) ?? ""; sessionStorage.removeItem(CONVERTED + id); return md; } catch { return ""; }
}
// ?openas=PATH&fid=FID: a data file opened as a board from the notebook
// page or the file browser (design §3, workspace/upload.ts): its converted
// copy, made beside it, opened, the file left as it is; one replaced
// meanwhile (another fid), or that isn't a board, said, nothing made
let openAsFailed = "";
{
  const at = q.get("openas"), fid = q.get("fid");
  if (at !== null && !embedded()) {
    q.delete("openas");
    q.delete("fid");
    try {
      if (!ws) throw new Error("your files aren't open in this browser");
      const e = await ws.stat(at);
      if (!e || e.kind !== "file" || e.fid !== fid) throw new Error(`"${at}" isn't there any more`);
      const made = await convertedAsBoard(ws, e, "python");
      q.set("doc", "local:" + made.ref);
    } catch (err) { openAsFailed = `**"${nameOf(at)}" couldn't be opened as a board:** ${String((err as Error)?.message ?? err)}`; }
    history.replaceState(null, "", location.pathname + (q.toString() ? "?" + q.toString().replace("local%3A", "local:") : "") + location.hash);
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

// Saving a board of the workspace: the document written to localStorage at
// once as pending, then to the workspace, one write at a time, the latest
// only (one written over by a later save is skipped).  A pending copy is
// "<session>:<n>\n<JSON>": this page's session (random, per load) and the
// save's number.  Once the workspace has a save, its pending copy is
// dropped, but only if it is still that save's (another tab's newer save
// is never dropped: CORR-12C-1).  The workspace's record is tagged with the
// session that wrote it, so a later load can tell a pending copy that is
// newer than the record (same session) from one the record has moved past
// (another writer: CORR-12C-2).  A write the workspace refused makes the
// next save say so (thrown, as a refused localStorage write was:
// HARD-7F9-1), and is tried again with it.
const SESSION = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
let wsSeq = 0, wsRev = 0; // (the workspace record's revision this page last loaded or wrote)
let wsWriting: Promise<void> = Promise.resolve(), wsRefused: Error | null = null;
// (the latest save of each view: a save is passed over only for a later
// save of the same view; a save of a newer view never makes an older
// view's save skipped, CORR-105-2)
const wsLatest = new Map<number, BoardDoc>();
// (what happened to the saves, the latest 200: for tests and for finding out why)
const wsLog: { t: number; what: string; title: string; epoch: number; base?: number }[] = [];
const logSave = (what: string, d: BoardDoc, epoch: number, base?: number) => {
  wsLog.push({ t: Date.now(), what, title: String(d?.title ?? ""), epoch, ...(base !== undefined ? { base } : {}) });
  if (wsLog.length > 200) wsLog.shift();
};
// (the view's lineage: one more each time the board is shown a version
// written elsewhere; a save belongs to the view it was made on, and a save
// made on an older view never writes the board, only that conflict's copy:
// CORR-0FC-1)
let wsEpoch = 0, wsCopy: { epoch: number; ref: string; rev: number } | null = null;
function wsSave(id: string, d: BoardDoc) {
  const w = ws!, refused = wsRefused;
  // (the workspace quarantined, being reset, or reset or upgraded elsewhere: nothing kept, not even the pending
  // copy in localStorage, and said: astra's CORR-2A4-2 on 0eefec71)
  if (w.quarantined || w.closed) {
    wsRefused = new Error(w.closed ? "the workspace was reset or upgraded in another tab: reload this page" : "this browser's copy of your workspace was lost, is missing changes, or is being reset: nothing can be changed until that is settled");
    throw wsRefused;
  }
  let journaled = true;
  const text = JSON.stringify(d), header = `${SESSION}:${++wsSeq}:${wsRev}`, epoch = wsEpoch;
  if (text.length > PENDING_MAX) {
    // (too large to journal: the workspace alone keeps it; an older pending copy of this page's dropped, as it is older)
    journaled = false;
    dropPending(id, SESSION + ":");
  } else try { localStorage.setItem(PENDING + id, header + "\n" + text); } catch { journaled = false; }
  wsLatest.set(epoch, d);
  logSave("save", d, epoch, wsRev);
  wsWriting = wsWriting.then(async () => {
    if (wsLatest.get(epoch) !== d) return logSave("passed over", d, epoch);
    try {
      if (epoch !== wsEpoch) {
        // (made on the view before a conflict: into that conflict's copy,
        // never over the board; the copy is a board like any other: written
        // only over its own revision, else a new copy, CORR-105-1)
        const copy = wsCopy?.epoch === epoch ? wsCopy : null;
        let copyPath = copy ? await w.pathOf("board", copy.ref) : undefined;
        if (copy && copyPath) {
          try {
            copy.rev = (await w.write(copyPath, d, { base: copy.rev })).rev;
            logSave("to the copy", d, epoch, copy.rev);
          } catch (e: any) {
            if (e?.code !== "conflict") throw e;
            copyPath = undefined;
          }
        }
        if (!copyPath) {
          wsCopy = { epoch, ref: await makeInWorkspace(w, { ...d, title: safeTitle(d.title) + " (your changes, made while it changed elsewhere)" }, isHere(hereKey(id)), undefined, { copyOf: id }), rev: 1 };
          logSave("to a new copy", d, epoch);
        }
        if (wsLatest.get(epoch) === d) wsLatest.delete(epoch);
        dropPending(id, header + "\n");
        return;
      }
      let path = await w.pathOf("board", id);
      // (a board of this browser's kept before, not brought in: in the workspace now, under its own id)
      if (!path) {
        path = await adoptBoard(w, id, d);
        wsRev = 1;
      }
      // (tagged with this save's session and number: a later load orders the
      // record against a pending copy by them, CORR-2D1-2; and only over the
      // revision this page knows: what someone else wrote since is never
      // written over, CORR-AA2-1)
      // (always with a base: a page that knows no revision writes nothing over anything, it conflicts)
      wsRev = (await w.write(path, d, { tag: header, base: wsRev })).rev;
      logSave("written", d, epoch, wsRev);
      wsRefused = null;
      if (wsLatest.get(epoch) === d) {
        wsLatest.delete(epoch);
        dropPending(id, header + "\n");
      }
    } catch (e: any) {
      if (e?.code === "conflict") {
        logSave("conflict", d, epoch, wsRev);
        await wsConflict(w, id, d, header, epoch);
      }
      else wsRefused = e instanceof Error ? e : new Error(String(e));
    }
  });
  if (refused && !journaled) throw new Error(STORAGE_REFUSED);
}
/** The board changed elsewhere (an agent, another tab) since this page last
 * read or wrote it: both kept.  This page's version becomes a board of its
 * own; only once that is written is its pending copy dropped; then the
 * board shows the other version, saying so (CORR-AA2-1). */
const wsSubs = new Set<(d: BoardDoc, notice?: string) => void | Promise<void>>();
async function wsConflict(w: Workspace, id: string, d: BoardDoc, header: string, epoch: number) {
  try {
    const title = safeTitle(d.title) + " (your changes, made while it changed elsewhere)";
    wsCopy = { epoch, ref: await makeInWorkspace(w, { ...d, title }, isHere(hereKey(id)), undefined, { copyOf: id }), rev: 1 };
    dropPending(id, header + "\n");
    const path = await w.pathOf("board", id);
    const cur = path ? await w.read(path) : null;
    if (!cur || !isBoard(cur.content)) return;
    // (a new view from here, as the board is about to show the other
    // version: saves made on the old one, typed while this was handled,
    // carry the old epoch and go to the copy; only then the new base)
    if (epoch === wsEpoch) wsEpoch++;
    wsRev = cur.rev;
    if (wsLatest.get(epoch) === d) wsLatest.delete(epoch);
    const notice = `**This board was changed elsewhere while you edited it.** Its version is shown; yours is kept as a board of its own, "${title}".`;
    for (const f of wsSubs) await f(cur.content as BoardDoc, notice);
  } catch (e: any) {
    wsRefused = e instanceof Error ? e : new Error(String(e));
  }
}
/** The pending copy of `id` dropped, only if it still starts with `prefix` (its own). */
function dropPending(id: string, prefix: string) {
  try {
    const cur = localStorage.getItem(PENDING + id);
    if (cur !== null && cur.startsWith(prefix)) localStorage.removeItem(PENDING + id);
  } catch {}
}
/** A pending copy as kept: its session and document; null if there is none; "unread" if it can't be read (too large, or not ours). */
function readPending(id: string): { header: string; session: string; n: number; base: number; doc: BoardDoc } | null | "unread" {
  const raw = localStorage.getItem(PENDING + id);
  if (raw === null) return null;
  const m = raw.length <= PENDING_MAX + 64 ? /^(([0-9a-f]{16}):(\d+):(\d+))\n/.exec(raw) : null;
  let doc: unknown = null;
  if (m) try { doc = JSON.parse(raw.slice(m[0].length)); } catch {}
  if (m && isBoard(doc)) return { header: m[1], session: m[2], n: Number(m[3]), base: Number(m[4]), doc: doc as BoardDoc };
  // (set aside, never parsed again, never dropped: LIMIT-12C-4)
  try { localStorage.setItem(PENDING_UNREAD + id, raw); localStorage.removeItem(PENDING + id); } catch {}
  return "unread";
}
const sameDoc = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Every save so far in the workspace (before the page goes elsewhere). */
const wsFlush = () => wsWriting;
/** A board kept before only in localStorage, put in the workspace under its id. */
function adoptBoard(w: Workspace, id: string, d: BoardDoc): Promise<string> {
  return w.locked(async () => {
    const top = new Set((await w.list("/")).map((e) => e.path));
    const p = freePath("/", safeTitle(d.title), ".board.json", (x) => top.has(x));
    if (!p) throw new Error("no free name for this board");
    const e = await w.adopt("/", p.slice(1, -".board.json".length), ".board.json", { kind: "board", ref: id, mode: d.mode ?? "python" }, { at: p, board: { id, doc: d, rev: 1, updated: Date.now() } });
    return e.path;
  });
}

// (the function search's indexes, by language, as fetched)
const docIndexes: Record<string, Promise<DocEntry[] | null>> = {};
// (the engine an exported file's code last ran with, as chooseEngine chose it)
let chosen: string | null = null;
// (a document opened from the file browser or the File menu: a board here, a notebook on its page; this board's saves made first)
function openEntry(e: Entry, how: "here" | "tab") {
  const url = e.kind === "board" ? location.pathname + "?doc=local:" + e.ref : "/?nb=" + encodeURIComponent(e.ref!);
  if (how === "tab") return void window.open(url, "_blank", "noopener");
  if (e.kind === "board" && e.ref === source.slice(6)) return;
  void leaveFor(url, nameOf(e.path));
}
// Leaving this board for another page, whichever way (an open, an upload, the file browser): what
// is being written ended and kept, at the moment of leaving (so what was typed while an upload was
// read is kept too), the saves made, and, one refused, this board stays open, saying why: never left
// behind unsaved (astra's CORR-4B3-2, CORR-BCD-1)
async function leaveFor(url: string, what: string): Promise<boolean> {
  // (not while a departure is under way: it owns the board until it goes or gives up, CORR-BF8-1)
  if (departing) { alert(`"${what}" isn't opened: this board is already going elsewhere (${departing}). Wait for it to finish.`); return false; }
  return go(url, what);
}
async function go(url: string, what: string): Promise<boolean> {
  if (!(await settled(what))) return false;
  location.assign(url);
  return true;
}
/** Leaving for somewhere `work` makes first (a new board, a copy, a notebook; this board to Trash):
 * what is being written kept first; nothing written while it is made (the board frozen); then left
 * through the same boundary.  Made but not left (a save refused), or not made: the board as it was.
 * (astra's CORR-134-1: a check before the work is not a boundary at the leaving) */
// (the workspace's lock waited for at most this long by a departure: another tab may hold it for
// good; the work's lock request is then withdrawn, so it never runs, now or later: daybreak2's
// LIMIT-59D-1)
const DEPART_MS = 10_000;
// (the one departure under way: claimed before anything is awaited, released only by the one that
// claimed it; another asked for meanwhile is refused, saying so, so no departure's end can release
// the board while another still waits to change it: astra's CORR-BF8-1)
let departing: string | null = null;
async function departFor(what: string, work: (signal: AbortSignal) => Promise<string | undefined>) {
  if (departing) throw new Error(`this board is already going elsewhere (${departing}): wait for it to finish`);
  departing = what;
  let left = false;
  try {
    if (!(await settled(what))) return;
    mounted.freeze(true);
    held = true;
    left = await departWork(what, work);
  } finally {
    if (!left) {
      mounted.freeze(false);
      held = false;
      departing = null;
    }
  }
}
// (whether the board is held for a departure now: for tests, which can't tell its wait for the workspace's
// lock from another's, the migrator's say)
let held = false;
/** The departure's work, its lock waited for at most DEPART_MS; then the page goes. Whether it went. */
async function departWork(what: string, work: (signal: AbortSignal) => Promise<string | undefined>): Promise<boolean> {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), DEPART_MS);
  let url: string | undefined;
  try {
    url = await work(ctl.signal);
  } catch (e: any) {
    if (e?.name === "AbortError") throw new Error("your files are busy (another tab is changing them), so nothing was done. Try again in a moment");
    throw e;
  } finally {
    clearTimeout(timer);
  }
  return url ? go(url, what) : false;
}
/** What is being written ended and kept, and every save made, until nothing more is being written
 * (what was typed while the last save was made, kept too); true to go: then the page goes in the
 * same step, with nothing written between.  False, said why: this board stays open. */
async function settled(what: string): Promise<boolean> {
  for (let i = 0; ; i++) {
    try { await mounted.keepWriting(); } catch (err) { alert(`"${what}" isn't opened: what was being written here couldn't be kept (${String((err as Error)?.message ?? err).slice(0, 200)}), so this board stays open.`); return false; }
    // (the saves waited for, but not for good: one that waits on a lock another tab never gives up
    // goes on, and this board stays; LIMIT-59D-1)
    let late: ReturnType<typeof setTimeout> | undefined;
    const saved = await Promise.race([wsFlush().then(() => true), new Promise<boolean>((r) => (late = setTimeout(() => r(false), DEPART_MS)))]);
    clearTimeout(late);
    if (!saved) { alert(`"${what}" isn't opened: this board's last changes are still being saved (your files are busy), so it stays open. Try again in a moment.`); return false; }
    if (local && ws && wsRefused) { alert(`"${what}" isn't opened: this board's last changes aren't kept in your files (${String(wsRefused.message).slice(0, 200)}), so it stays open. Download it (File) to keep them.`); return false; }
    if (!mounted.writing()) return true;
    // (someone writing on and on as the page tries to go: after 10 passes it stays, nothing lost)
    if (i >= 9) return false;
  }
}
// (this board, opened: first in the File menu's Recent, both pages')
if (local && ws) recordOpened({ kind: "board", ref: source.slice(6) });
// Upload… and files dropped on the board (not pictures), with the workspace:
// design §3's rule (workspace/upload.ts), never converting unasked; then one
// document made is opened, and one file it recognises offered as what it can
// be.  Into this board's folder, or the one given.  What to say.
async function uploadToWorkspace(w: Workspace, files: File[], mode: string, folder?: string): Promise<string> {
  if (folder === undefined) {
    const at = local ? await w.pathOf("board", source.slice(6)).catch(() => undefined) : undefined;
    folder = at ? at.slice(0, Math.max(1, at.lastIndexOf("/"))) : "/";
  }
  const r = await uploadFiles(w, files, folder, {
    maxBytes: LIMITS.maxFileBytes,
    docMaxBytes: LIMITS.maxBoardBytes,
    mode,
    replay: async (bytes) => {
      const b = await readBundle(bytes);
      // (the notebook page's databases, opened for this and closed after)
      return { notebook: b.notebook, keep: async (ref) => {
        const hdb = await openHistoryDb(), bdb = await openBlobDb();
        try { await keepBundle(b, ref, { hdb, bdb }); } finally { hdb?.close(); bdb?.close(); }
      } };
    },
  });
  const n = (k: number, one: string) => `${k} ${one}${k === 1 ? "" : "s"}`;
  const said = [r.made.length ? n(r.made.length, "document") + " made" : "", r.kept.length ? n(r.kept.length, "file") + " added" : ""].filter(Boolean).join(", ") || "Nothing added";
  const refused = r.refused.length ? `; not added: ${r.refused.join("; ")}` : "";
  // (a document opened, or a file offered, only for an upload of that one file; what was said carried
  // to the page it opens; a board brought in waits for the person to run its code: astra's CORR-4B3-1)
  const single = files.length === 1;
  if (single && r.made.length === 1 && !r.kept.length) {
    const e = r.made[0];
    if (e.kind === "board") pauseBoard(e.ref!);
    carryNotice(refused ? said + refused : "");
    openEntry(e, "here");
  } else if (single && r.kept.length === 1 && !r.made.length) {
    const e = r.kept[0], as = openableAs(nameOf(e.path)), name = nameOf(e.path);
    if (as && confirm(`Open "${name}" as a ${as}?\n\nA converted copy, "${splitExt(name)[0]}${as === "board" ? ".board.json" : ".ipynb"}", is made beside it; "${name}" stays as it is.`)) {
      const err = await openAsHere(w, e, as, mode);
      if (err) return `${said}${refused}. **"${name}" couldn't be opened as a ${as}:** ${err}`;
    }
  }
  return said + refused;
}
// (a data file opened as a document: its converted copy, made beside it, opened; the original stays; why not, if not)
async function openAsHere(w: Workspace, e: Entry, as: DocKind, mode: string): Promise<string | null> {
  try {
    const made = as === "board" ? await convertedAsBoard(w, e, mode) : await convertCopy(w, e, as, { maxBytes: LIMITS.maxBoardBytes, mode });
    openEntry(made, "here");
    return null;
  } catch (err) { return String((err as Error)?.message ?? err); }
}
const host: BoardHost = {
  // (Sagebrush's board page: the one File menu as the notebook's, what it can't do here disabled)
  fullFileMenu: true,
  // (a board brought in from a file, opened here: its code waits for the person, until they run it)
  codePaused: local && isPaused(source.slice(6)),
  codeResumed: () => { if (local) unpause(source.slice(6)); },
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
      if (local && ws) {
        const id = source.slice(6);
        // (a save the workspace hadn't taken when a page closed)
        const pend = readPending(id);
        let notice = pend === "unread" ? "**A copy of this board left by a page closed while saving couldn't be read.** It's set aside in this browser; the board as last kept is shown." : "";
        // (made just now from a file: what its conversion said, and what its upload said)
        const conv = [takeNotice(), takeConverted(id)].filter(Boolean).join("\n\n");
        if (conv) notice = conv + (notice ? "\n\n" + notice : "");
        const path = await ws.pathOf("board", id);
        if (path) {
          const rec = await ws.read(path).catch(() => null);
          if (rec && isBoard(rec.content)) {
            if (pend && pend !== "unread") {
              // (the record's writer: a session and that session's save number)
              const [tagSession, tagN] = String(rec.tag ?? "").split(":");
              if (rec.rev === pend.base || (tagSession === pend.session && Number(tagN) < pend.n)) {
                // (the record is the one the copy was made on, or an earlier save of the session that left it: the copy is newer)
                wsEpoch++;
                wsRev = rec.rev;
                wsSave(id, pend.doc);
                return { doc: pend.doc, original: null };
              }
              if (sameDoc(rec.content, pend.doc) || (tagSession === pend.session && Number(tagN) >= pend.n)) dropPending(id, pend.header + "\n");
              else {
                // (the record moved on since, by another writer: neither is dropped; the copy kept as a board of its own: CORR-12C-2)
                try {
                  await makeInWorkspace(ws, { ...pend.doc, title: (pend.doc.title || "Untitled board") + " (unsaved changes from a closed page)" }, isHere(hereKey(id)), undefined, { copyOf: id });
                  dropPending(id, pend.header + "\n");
                  notice = "**Changes left by a page closed while saving were made after this board changed elsewhere.** They are kept as a board of their own, \"" + safeTitle(pend.doc.title) + " (unsaved changes from a closed page)\".";
                } catch (e: any) {
                  notice = `**Changes left by a page closed while saving couldn't be kept as a board of their own** (${String(e?.message ?? e)}); they stay in this browser.`;
                }
              }
            }
            wsEpoch++;
            wsRev = rec.rev;
            return { doc: rec.content, original: null, ...(notice ? { notice } : {}) };
          }
        }
        // (a board only a pending copy holds: brought into the workspace, under its id: CORR-12C-3)
        if (!path && pend && pend !== "unread") {
          try {
            await adoptBoard(ws, id, pend.doc);
            wsEpoch++;
            wsRev = 1;
            dropPending(id, pend.header + "\n");
          } catch (e) { console.warn("workspace:", e); }
          return { doc: pend.doc, original: null };
        }
        // (not in the workspace: as kept before, if it is; written into the workspace at the first save)
        const before = localDoc(id);
        return before ? { doc: before, original: null } : { doc: blankBoard("python"), original: null, notice: "**This board isn't in this browser** (any more): what you write here is kept as a board of its own." };
      }
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
      if (local && ws) return wsSave(source.slice(6), d);
      try { localStorage.setItem(saveKey, JSON.stringify(d)); } catch { throw new Error(STORAGE_REFUSED); }
      if (local && !listLocal(source.slice(6), d)) throw new Error(STORAGE_REFUSED);
    },
    revert() {
      try { localStorage.removeItem(saveKey); } catch {}
    },
    // (a board of the workspace: its version from elsewhere, when this page's write met it: CORR-AA2-1)
    ...(local && ws ? { subscribe(f: (d: BoardDoc, notice?: string) => void | Promise<void>) { wsSubs.add(f); return () => { wsSubs.delete(f); }; } } : {}),
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
  newBoard: file ? undefined : ws ? (mode) => departFor("A new board", async (signal) => localUrl(await makeInWorkspace(ws, blankBoard(mode), true, signal, { person: true }))) : async (mode) => { if (!(await settled("A new board"))) return; const id = makeLocal(blankBoard(mode)); if (!id) throw new Error(STORAGE_REFUSED); await leaveFor(localUrl(id), "A new board"); },
  duplicate: file ? undefined : ws ? (d) => departFor("The copy", async (signal) => localUrl(await makeInWorkspace(ws, { ...JSON.parse(JSON.stringify(d)), title: (d.title || "Untitled board") + " (copy)" }, isHere(saveKey + "#here"), signal, { copyOf: local ? source.slice(6) : undefined }))) : async (d) => { if (!(await settled("The copy"))) return; const id = makeLocal({ ...JSON.parse(JSON.stringify(d)), title: (d.title || "Untitled board") + " (copy)" }, isHere(saveKey + "#here")); if (!id) throw new Error(STORAGE_REFUSED); await leaveFor(localUrl(id), "The copy"); },
  // The File menu's items that are the workspace's (design §3): a new
  // notebook, a folder, Open… (the file browser as a dialog), Recent, and
  // this board to Trash; none without the workspace, or in an exported file
  files: ws && !file ? {
    newNotebook: (mode: string) => departFor("A new notebook", async (signal) => {
      const top = new Set((await ws!.list("/")).map((e) => e.path));
      const p = freePath("/", "Untitled", ".ipynb", (x) => top.has(x));
      if (!p) throw new Error("no free name for a new notebook");
      const e = await ws!.createByPerson(p, { mode, signal });
      return "/?nb=" + encodeURIComponent(e.ref!);
    }),
    async newFolder() {
      const name = prompt("A new folder, at the top of your files: its name", "New folder");
      if (!name?.trim()) return;
      await ws!.mkdir("/" + safeName(name.trim()));
    },
    open: () => openFilesDialog(ws!, openEntry, () => (local ? { kind: "board", ref: source.slice(6) } : undefined)),
    recent: async () => (await recentOpened(ws!, local ? { kind: "board", ref: source.slice(6) } : undefined)).map((e) => ({ label: recentLabel(e), title: e.path, open: () => openEntry(e, "here") })),
    upload: (files: File[], mode: string) => uploadToWorkspace(ws!, files, mode),
    // (this board, by its identity, to Trash; then the latest other board, or a new one)
    delete: local ? async () => {
      const id = source.slice(6), p = await ws!.pathOf("board", id), e = p ? await ws!.stat(p) : undefined;
      if (!p || !e || e.kind !== "board" || e.ref !== id) throw new Error("this board isn't in your files");
      if (!confirm(`Move "${nameOf(p)}" to Trash? Trash keeps it until you empty it.`)) return;
      await departFor("The next board", async (signal) => {
        await ws!.remove(p, { kind: "board", ref: id, fid: e.fid, created: e.created }, signal);
        const next = (await recentOpened(ws!, { kind: "board", ref: id })).find((x) => x.kind === "board");
        return location.pathname + (next ? "?doc=local:" + next.ref : "?new=" + encodeURIComponent(e.mode ?? "python"));
      });
    } : undefined,
  } : undefined,
  // (an exported file's or a frame's empty board opens as any other)
  editBlank: !file,
  // the function search beside a code item being written: the notebook's
  // indexes, at the site's root, each fetched once (a failure: tried again
  // at the next search); not in an exported file, which has no site
  docs: file ? undefined : (lang) => {
    const f = DOC_INDEX[lang];
    if (!f) return Promise.resolve(null);
    return (docIndexes[lang] ??= fetch(new URL("../" + f, import.meta.url)).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${f}: ${r.status}`)))).then((d) => prepareIndex(d, lang)).catch((e) => {
      delete docIndexes[lang];
      throw e;
    }));
  },
};

// (a data file that couldn't be opened as a board: said over what opens instead)
if (openAsFailed && host.store) {
  const load0 = host.store.load.bind(host.store);
  host.store.load = async () => { const r = await load0(); return r ? { ...r, notice: openAsFailed + (r.notice ? "\n\n" + r.notice : "") } : r; };
}
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

// The file browser (design §4): a sidebar on the left, over the board's
// left edge (which moves aside), shown and hidden by Files in the top bar,
// remembered with the notebook page's
if (ws && local) {
  const side = document.createElement("div");
  side.id = "wssidebar";
  side.style.cssText = "position:fixed;left:0;top:0;bottom:0;width:272px;border-right:1px solid #d4d4cb;z-index:30";
  side.hidden = true;
  document.body.append(side);
  const btn = document.createElement("button");
  btn.textContent = "Files";
  btn.title = "Your notebooks, boards and files (in this browser)";
  btn.setAttribute("aria-pressed", "false");
  btn.dataset.sbb = "files";
  document.querySelector('[data-sbb="top"] [data-sbb="home"]')?.after(btn);
  const boardEl = document.getElementById("board")!;
  let browser: ReturnType<typeof mountBrowser> | null = null;
  const phone = () => matchMedia("(max-width: 640px)").matches;
  const show = (on: boolean) => {
    side.hidden = !on;
    boardEl.style.left = on && !phone() ? "272px" : "";
    side.style.width = phone() ? "" : "272px";
    side.style.right = phone() ? "0" : "";
    btn.setAttribute("aria-pressed", String(on));
    try { localStorage.setItem("sagebrush-files-sidebar", on ? "1" : "0"); } catch {}
    dispatchEvent(new Event("resize"));
    if (on && !browser) browser = mountBrowser(side, {
      ws,
      current: () => ({ kind: "board", ref: source.slice(6) }),
      open: openEntry,
      upload: (files, folder) => uploadToWorkspace(ws, files, mounted.agent.snapshot().doc?.mode ?? "python", folder),
      openAs: (e, as) => openAsHere(ws, e, as, mounted.agent.snapshot().doc?.mode ?? "python").then((err) => (err ? `"${nameOf(e.path)}" couldn't be opened as a ${as}: ${err}` : undefined)),
      close: () => show(false),
      // (this board renamed here: its title follows, saved by this page as
      // its other changes are, never written beside them: CORR-0B0-2)
      retitles: (e) => e.kind === "board" && e.ref === source.slice(6),
      renamed(e, was) {
        if (e.kind === "board" && e.ref === source.slice(6)) {
          const base = (p: string) => splitExt(nameOf(p))[0];
          void mounted.retitle(base(e.path), base(was));
        }
      },
    });
  };
  btn.onclick = () => show(side.hidden !== false);
  let pref: string | null = null;
  try { pref = localStorage.getItem("sagebrush-files-sidebar"); } catch {}
  if (pref === "1") show(true);
}

(window as any).board = mounted.board;
(window as any).boardBench = mounted.bench;
(window as any).sagebrush = { ...(window as any).sagebrush, leaving: () => held, board: mounted.agent, ...(ws ? { workspace: ws.forAgent("agent:page"), saveLog: () => wsLog.slice() } : {}) };
