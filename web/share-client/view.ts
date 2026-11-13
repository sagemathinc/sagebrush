// A shared collection's page, /s/<id> (or /s/<id>@<version>): its title,
// license and files, and a notebook of it opened in the page.  Nothing runs
// until the reader presses Run: a shared notebook is someone else's code.
// The collection's files are mounted in the interpreter (web/shims/fs.ts):
// each is fetched from the user-content domain, and checked against its
// SHA-256, the first time the code reads it.  Everything shown here comes
// from the uploader, so it goes into the page as text, never as markup.
//
// A chapter's link (book links, B1): /s/<id>?f=<path> opens that file. The reader's own copy: the first edit copies
// the notebook, and the collection's data files beside it, into the reader's own files in this browser (no sign-in);
// every later edit is saved there, and a later visit opens it, with "Back to the book's version".  The copy is made
// as anything brought in from elsewhere is (its code runs without file changes until the reader allows them).
//
// Background loading (web/preload.ts, as on the notebook page): at idle, the library files the open notebook's first
// Run will fetch, by the page, in the runner broker's request shape (the same cache the runner's requests are answered
// from; no frame made for it, nothing run); never the collection's data files, nor the copy's chunk (it isn't
// named by its content, so the site can't let a browser keep it: fetched ahead, it would be fetched again, daybreak2).
//
// A talk (a .tex file, S2): where the LaTeX editor is on (a LaTeX build, on one of its hosts), it opens in the LaTeX
// view's chunk (web/latex/share.ts, fetched on the first talk), drawn with its author's results; its code runs, in the
// runner, only when the reader presses Run, and what it makes is kept in the page, never saved.  One interpreter at a
// time: opening a talk stops the notebook's, and leaving it disposes the talk's.  Elsewhere a talk is a download.
import { preloadSoon, preloadState, preloadStop, type PreloadTable } from "../preload";
import { createNotebook, fromFile, MemoryStore, RunnerWorker, toIpynb, WorkerKernel } from "../notebook/index.js";
// (the workspace is web/share-client/copy.ts, a chunk fetched on the first need: types only here)
import type { Workspace } from "../workspace/api";

declare const __SB_PRELOAD__: PreloadTable;
declare const __SB_LATEX__: boolean;
declare const __SB_LATEX_HOSTS__: string[];

interface File { path: string; sha256: string; size: number }
type Mount = [string, { url: string; sha256: string; size: number }][];
// (the LaTeX view's chunk, web/latex/share.ts: the interface agreed with its owner, S2-runner.md.  openShared draws the
// talk and starts no interpreter: the view's Sage starts on its run(), after the view is returned, and its dispose()
// ends it, whenever called; astra)
interface TalkView { run(): void; stop(): void; present(): void; dispose(): void }
interface TalkChunk {
  openShared(root: HTMLElement, o: {
    path: string; text: string; results: unknown | null;
    sandbox: { WorkerKernel: unknown; RunnerWorker: unknown; runnerUrl: string } | null;
    mount: Mount; say(text: string): void; onRunning(on: boolean): void;
  }): Promise<TalkView>;
}
interface Shared {
  id: string;
  version: string;
  latest: string;
  files_origin: string;
  manifest: { title: string; license?: string; author?: string; created: string; files: File[] };
}

const $ = (s: string) => document.querySelector(s) as HTMLElement;
const el = (tag: string, text = "", attrs: Record<string, string> = {}) => {
  const e = document.createElement(tag);
  e.textContent = text;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};
const size = (n: number) => (n < 1e3 ? `${n} B` : n < 1e6 ? `${(n / 1e3).toFixed(1)} kB` : n < 1e9 ? `${(n / 1e6).toFixed(1)} MB` : `${(n / 1e9).toFixed(2)} GB`);
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const NOTEBOOK = /\.(ipynb|py|sage)$/i;
const TALKS = __SB_LATEX__ && __SB_LATEX_HOSTS__.includes(location.hostname);
const isTalk = (path: string) => TALKS && /\.tex$/i.test(path);
const openable = (path: string) => NOTEBOOK.test(path) || isTalk(path);
// (where each reader's copies are: collection id and file path -> the copy's path in the reader's files)
const COPIES = "sagebrush-share-copies";
const copies = (): Record<string, string> => { try { return JSON.parse(localStorage.getItem(COPIES) ?? "{}") ?? {}; } catch { return {}; } };
const remember = (key: string, at: string | null) => { const all = copies(); if (at) all[key] = at; else delete all[key]; try { localStorage.setItem(COPIES, JSON.stringify(all)); } catch {} };
// (a folder name from the title: letters, digits, spaces and - _ . only, at most 60 characters, never "." or "..",
// which no path can hold (workspace/paths.ts): a title of dots alone, as an empty one, is "Shared"; grader's B12)
const folderOf = (title: string) => {
  const s = title.replace(/[^\p{L}\p{N} ._-]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 60).trim();
  return "/" + (s === "" || s === "." || s === ".." ? "Shared" : s);
};

async function main() {
  const m = location.pathname.match(/^\/s\/([a-z2-7]{12})(?:@([0-9a-f]{8,64}))?\/?$/);
  if (!m) return fail("This is not a link to a shared collection.");
  const r = await fetch(`/api/share/c/${m[1]}${m[2] ? `?at=${m[2]}` : ""}`);
  if (!r.ok) return fail(r.status === 404 ? "This collection doesn't exist, or its owner deleted it." : `The collection could not be loaded (HTTP ${r.status}).`);
  const c = (await r.json()) as Shared;
  const fileUrl = (f: File) => new URL(`/c/${c.id}/${f.sha256}`, c.files_origin).href;

  document.title = `${c.manifest.title} — Sagebrush`;
  $("#title").textContent = c.manifest.title;
  const meta = $("#meta");
  // (who it's by, as its publisher typed it: text, never markup, on one line; none when they gave none)
  const by = typeof c.manifest.author === "string" ? c.manifest.author.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200) : "";
  if (by) meta.append(el("span", `by ${by}`, { class: "by" }));
  meta.append(el("span", `Shared ${c.manifest.created.slice(0, 10)}`));
  if (c.manifest.license) meta.append(el("span", `License: ${c.manifest.license}`));
  meta.append(el("span", `Version ${c.version.slice(0, 12)}`, { title: c.version }));
  if (c.version !== c.latest) {
    const a = el("a", "A newer version exists", { href: `/s/${c.id}` });
    meta.append(a);
  }

  const list = $("#files");
  for (const f of c.manifest.files) {
    const li = document.createElement("li");
    if (openable(f.path)) {
      const b = el("button", f.path, { type: "button", class: "link" });
      b.onclick = () => void show(f);
      li.append(b);
    } else li.append(el("span", f.path));
    li.append(el("span", size(f.size), { class: "size" }));
    li.append(el("a", "download", { href: fileUrl(f), class: "dl", download: f.path.split("/").pop()! }));
    list.append(li);
  }

  // one interpreter, with every file of the collection mounted
  const mount: Mount = c.manifest.files.map((f) => [f.path, { url: fileUrl(f), sha256: f.sha256, size: f.size }]);
  const kernel = new WorkerKernel({
    // (someone else's code: always in the runner, an opaque-origin sandboxed frame; design/runner.md)
    createWorker: () => new RunnerWorker("/runner/"),
    onStart: (w: Worker) => w.postMessage({ mount }),
  });
  // (nothing runs, and no runner frame exists, until the reader runs something: the interpreter starts with the first
  // run, so opening a share runs no one's code and loads no interpreter; a Stop before then has nothing to stop)
  for (const k of ["execute", "interact"] as const) {
    const f = (kernel as any)[k].bind(kernel);
    (kernel as any)[k] = (...a: unknown[]) => { if (!kernel.worker) kernel.start(); return f(...a); };
  }
  const interrupt = (kernel as any).interrupt.bind(kernel);
  (kernel as any).interrupt = (...a: unknown[]) => (kernel.worker ? interrupt(...a) : undefined);
  // (a Run stops background loading starting another file; one in flight finishes)
  kernel.on("execute", preloadStop);
  let nb: any = null;
  let current: File | null = null;
  // (the open notebook's store: the one copy it keeps is the one "Copy to my workspace" makes, so an edit after it saves
  // there, never into a second copy)
  let store: CopyStore | null = null;
  // (the reader's own files, opened on the first need; null where this browser can't keep them)
  let wsP: Promise<Workspace | null> | null = null;
  const workspace = () => (wsP ??= (import(new URL("/sagebrush-share-copy.js", location.href).href) as Promise<typeof import("./copy")>).then((m) => m.openWorkspace()).catch(() => { wsP = null; return null; }));
  const keyOf = (f: File) => `${c.id}:${f.path}`;
  const fetchChecked = async (f: File) => {
    const resp = await fetch(fileUrl(f));
    const bytes = await resp.arrayBuffer();
    if (!resp.ok || hex(await crypto.subtle.digest("SHA-256", bytes)) !== f.sha256) throw new Error(`${f.path} could not be loaded`);
    return bytes;
  };
  // (the copy: the notebook at <folder>/<its path>, and every data file of the collection beside it, unless the reader
  // already has one there (theirs is kept); made once, on the first edit)
  async function makeCopy(f: File, doc: any): Promise<{ ws: Workspace; at: string; rev: number } | null> {
    const ws = await workspace();
    if (!ws) return null;
    const folder = folderOf(c.manifest.title), at = `${folder}/${f.path}`.replace(/\.(py|sage)$/i, ".ipynb");
    const mk = async (dir: string) => { if (!(await ws.stat(dir))) await ws.mkdir(dir); };
    const dirs = (q: string) => q.split("/").slice(1, -1).map((_, i, a) => "/" + a.slice(0, i + 1).join("/"));
    for (const d of dirs(at)) await mk(d);
    let target = at;
    for (let n = 2; await ws.stat(target); n++) target = at.replace(/(\.ipynb)$/i, ` (${n})$1`);
    const { rev: _r, id: _i, ...rest } = doc;
    await ws.create(target, { content: rest });
    // (the revision later saves are based on: the one read now, taken only if it holds exactly what this tab wrote;
    // one another tab wrote meanwhile is a conflict, its contents kept, never written over (astra B1-COPY-1))
    const made = await ws.read(target);
    const ours = sameDoc(made.content, rest);
    for (const d of c.manifest.files) {
      if (NOTEBOOK.test(d.path)) continue;
      const q = `${folder}/${d.path}`;
      if (await ws.stat(q)) continue;
      for (const x of dirs(q)) await mk(x);
      await ws.create(q, { content: new Uint8Array(await fetchChecked(d)) });
    }
    remember(keyOf(f), target);
    if (!ours) throw Object.assign(new Error(`${target} was changed elsewhere`), { code: "conflict" });
    return { ws, at: target, rev: made.rev };
  }
  // (a notebook as written: all of it, cells with their outputs, its language, its metadata, everything a later save
  // replaces; key order aside.  Not the store's own envelope, which the workspace sets on every write (the revision,
  // the journal's marks, and the name, from the path): astra B1-COPY-1)
  const canon = (v: any): any => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
  const asWritten = (d: any) => {
    const { id: _i, rev: _r, updated: _u, baseRev: _b, j: _j, hash: _h, unjournaled: _n, stampOf: _s, name: _m, ...rest } = d ?? {};
    return JSON.stringify(canon({ ...rest, cells: rest.cells ?? [], mode: rest.mode ?? "python" }));
  };
  const sameDoc = (a: any, b: any) => asWritten(a) === asWritten(b);
  // (a store that keeps the notebook in memory for the page and, once there is a copy, saves every change to it with
  // its revision: a change made elsewhere (another tab) is a conflict, said, never written over)
  class CopyStore extends MemoryStore {
    copy: { ws: Workspace; at: string; rev: number } | null;
    making: Promise<unknown> | null = null;
    // (the book's text of every cell: a copy is made by an edit to it, not by a run, which only changes outputs)
    private text: string;
    constructor(doc: any, private f: File, copy: { ws: Workspace; at: string; rev: number } | null, private keep: boolean) { super(doc); this.copy = copy; this.text = textOf(doc); }
    async save(doc: any) {
      const out = await super.save(doc);
      if (!this.keep || (out as any).conflict) return out;
      if (!this.copy && textOf(doc) === this.text) return out;
      try {
        if (!this.copy) {
          this.making ??= makeCopy(this.f, doc).then((c) => { this.copy = c; if (c) yours(this.f, c.at); });
          await this.making;
        } else {
          const { rev: _r, id: _i, ...rest } = doc;
          this.copy.rev = (await this.copy.ws.write(this.copy.at, rest, { base: this.copy.rev })).rev;
        }
      } catch (e: any) {
        $("#status").textContent = e?.code === "conflict" ? `Your copy was changed in another tab: reload to see it (this tab's change isn't saved).` : `Your copy couldn't be saved: ${String(e?.message ?? e).slice(0, 200)}`;
      }
      return out;
    }
  }
  // (what a reader writes: each cell's kind and text, in order; outputs and counts aren't theirs)
  const textOf = (doc: any) => JSON.stringify((doc?.cells ?? []).map((c: any) => [c.type ?? c.cell_type ?? "", c.code ?? c.source ?? ""]));
  // (the line over the notebook: whose version this is, and the way to the other)
  function yours(f: File, at: string) {
    setMine();
    const line = $("#copyline");
    line.replaceChildren(el("span", `This is your copy, kept in this browser at ${at}. Your changes are saved there.`), el("span", " "));
    const back = el("button", "Back to the book's version", { type: "button", class: "link" });
    back.onclick = () => void open(f, "original");
    line.append(back);
    line.hidden = false;
  }
  function original(f: File, at: string | null) {
    const line = $("#copyline");
    if (!at) { line.hidden = true; return; }
    line.replaceChildren(el("span", "This is the book's version: changes here aren't kept. "));
    const mine = el("button", "Open your copy", { type: "button", class: "link" });
    mine.onclick = () => void open(f);
    line.append(mine);
    line.hidden = false;
  }

  // (what the page shows: each open is a new view, and whatever an earlier one is still waiting for (a file, the chunk,
  // a talk's start) is dropped when it arrives; astra, S2)
  let view = 0;
  // (and what a view starts, one at a time: the interpreter started or stopped, the notebook attached, a talk's view
  // opened.  Fetching goes on beside, but a view's start waits for the one before it to finish, so a start still under
  // way (an attach, an openShared) is never overlapped by the next: the one that finishes stale undoes itself first,
  // and at no moment are there two interpreters; astra S2-HOST-ATTACH-1, S2-HOST-OPEN-2)
  let lane: Promise<void> = Promise.resolve();
  const turn = async () => { let done!: () => void; const before = lane; lane = new Promise<void>((r) => (done = r)); await before; return done; };
  const show = (f: File) => (isTalk(f.path) ? openTalk(f) : open(f));
  const mark = (f: File) => { for (const b of list.querySelectorAll("button.link")) b.classList.toggle("on", b.textContent === f.path); };

  async function open(f: File, which: "auto" | "original" = "auto") {
    const me = ++view;
    leaveTalk();
    $("#status").textContent = `opening ${f.path}…`;
    let doc, copy: { ws: Workspace; at: string; rev: number } | null = null;
    const at = copies()[keyOf(f)] ?? null;
    try {
      if (at && which === "auto") {
        const ws = await workspace();
        const r = ws && (await ws.read(at).catch(() => null));
        if (r && r.content && Array.isArray(r.content.cells)) { doc = r.content; copy = { ws: ws!, at, rev: r.rev }; }
        else remember(keyOf(f), null); // (the copy is gone: deleted, or another browser)
      }
      doc ??= fromFile(f.path, new TextDecoder().decode(await fetchChecked(f)));
    } catch (e) {
      if (me === view) $("#status").textContent = String((e as Error).message ?? e);
      return;
    }
    const done = await turn();
    try {
      if (me !== view) return;
      nb ??= createNotebook($("#nb"), { kernel, staleOnLoad: true, assetBase: "/" });
      // (the book's version, when the reader has a copy, keeps nothing: their copy is one, and it isn't written over)
      store = new CopyStore(doc, f, copy, !(at && which === "original" && copies()[keyOf(f)]));
      await nb.attach(store);
      // (attached after the reader went elsewhere: let go of it, show nothing of it)
      if (me !== view) { nb.detach(); return; }
    } finally {
      done();
    }
    current = f;
    setMine();
    $("#nb").hidden = false;
    $("#nbbar").hidden = false;
    $("#nbname").textContent = f.path;
    if (copy) yours(f, copy.at); else original(f, which === "original" ? copies()[keyOf(f)] ?? null : null);
    $("#status").textContent = copy ? "Your copy, as you left it. Run all runs it in your browser." : "Nothing has run yet: the outputs are as shared. Run all runs this notebook in your browser. Your first change makes it your own copy.";
    mark(f);
  }

  // (the open talk's view, and its file)
  let talk: TalkView | null = null, talkFile: File | null = null;
  const talkRun = $("#talkrun") as HTMLButtonElement;
  let running = false;
  const setRunning = (on: boolean) => {
    running = on;
    talkRun.textContent = on ? "■ Stop" : "▶ Run";
    talkRun.title = on ? "Stop this talk's code" : "Run this talk's code in your browser";
  };
  function leaveTalk() {
    talk?.dispose();
    talk = talkFile = null;
    setRunning(false);
    $("#talk").replaceChildren();
    $("#talk").hidden = $("#talkbar").hidden = true;
  }
  let chunk: Promise<TalkChunk> | null = null;
  async function openTalk(f: File) {
    const me = ++view;
    leaveTalk();
    $("#nb").hidden = $("#nbbar").hidden = $("#copyline").hidden = true;
    current = null;
    store = null;
    mark(f);
    const say = (text: string) => { if (me === view) $("#status").textContent = text; };
    say(`opening ${f.path}…`);
    // (the talk's text and its author's results, each checked against its SHA-256: a file that doesn't match is
    // refused, the talk with it; no results file is no results)
    const resFile = c.manifest.files.find((x) => x.path === f.path + ".results.json") ?? null;
    let text: string, results: unknown = null, m: TalkChunk;
    try {
      text = new TextDecoder().decode(await fetchChecked(f));
      if (resFile) {
        const t = new TextDecoder().decode(await fetchChecked(resFile));
        try { results = JSON.parse(t); } catch { throw new Error(`${resFile.path} isn't readable`); }
      }
      m = await (chunk ??= (import(new URL("/sagebrush-latex-share.js", location.href).href) as Promise<TalkChunk>).catch((e) => { chunk = null; throw new Error(`the talk viewer didn't load (${String(e?.message ?? e).slice(0, 100)})`); }));
    } catch (e: any) {
      say(`This talk couldn't be opened: ${String(e?.message ?? e).slice(0, 200)}`);
      return;
    }
    const done = await turn();
    try {
      if (me !== view) return;
      // (one interpreter in the page: the notebook's stops, and starts again when a notebook is opened)
      kernel.close();
      await start(me, f, text, results, m);
    } finally {
      done();
    }
  }
  async function start(me: number, f: File, text: string, results: unknown, m: TalkChunk) {
    const say = (text: string) => { if (me === view) $("#status").textContent = text; };
    const root = el("div");
    $("#talk").replaceChildren(root);
    $("#talk").hidden = $("#talkbar").hidden = false;
    $("#talkname").textContent = f.path;
    setTalkMine(f);
    say("These are the author's results. Press Run to run this talk's code in your browser.");
    let v: TalkView;
    try {
      v = await m.openShared(root, {
        path: f.path,
        text,
        results,
        // (the notebook's own runner: an opaque-origin sandboxed frame, design/runner.md; none in a browser without workers)
        sandbox: typeof Worker === "function" ? { WorkerKernel, RunnerWorker, runnerUrl: "/runner/" } : null,
        // (a snapshot of the collection's checked files, as the notebook's; the view keeps to the talk's folder)
        mount: mount.map(([p, x]) => [p, { ...x }]),
        say,
        onRunning: (on) => { if (me === view) setRunning(on); },
      });
    } catch (e: any) {
      if (me === view) { root.remove(); $("#talkbar").hidden = true; }
      say(`This talk couldn't be opened: ${String(e?.message ?? e).slice(0, 200)}`);
      return;
    }
    // (a view that opened after the reader went elsewhere is closed at once: it never runs)
    if (me !== view) { v.dispose(); root.remove(); return; }
    talk = v;
    talkFile = f;
  }
  talkRun.onclick = () => { if (talk) running ? talk.stop() : talk.run(); };
  ($("#talkpresent") as HTMLButtonElement).onclick = () => talk?.present();

  // ("Copy to my workspace" for a talk: the talk and every file of its folder, as published, with its author's results
  // (never what the reader ran here: that is in this page only), at <folder>/<their paths>, then opened in the LaTeX
  // editor (/?tex=<its id>); a file the reader already has there is kept.  Once made, "Open my copy" opens it)
  const talkMine = $("#talkmine") as HTMLButtonElement;
  function setTalkMine(f: File) {
    const has = !!copies()[keyOf(f)];
    talkMine.textContent = has ? "Open my copy" : "Copy to my workspace";
    talkMine.title = has ? "Open your copy of this talk in the editor" : "Make your own copy of this talk and its folder, kept in this browser, and open it in the editor";
  }
  async function copyTalk(ws: Workspace, f: File) {
    const folder = folderOf(c.manifest.title), dir = f.path.slice(0, f.path.lastIndexOf("/") + 1);
    const mk = async (d: string) => { if (!(await ws.stat(d))) await ws.mkdir(d); };
    const dirs = (q: string) => q.split("/").slice(1, -1).map((_, i, a) => "/" + a.slice(0, i + 1).join("/"));
    const at = `${folder}/${f.path}`;
    for (const d of dirs(at)) await mk(d);
    let target = at;
    for (let n = 2; await ws.stat(target); n++) target = at.replace(/(\.tex)$/i, ` (${n})$1`);
    const put = async (q: string, x: File) => { for (const d of dirs(q)) await mk(d); await ws.create(q, { content: new Uint8Array(await fetchChecked(x)) }); };
    await put(target, f);
    const res = c.manifest.files.find((x) => x.path === f.path + ".results.json");
    if (res && !(await ws.stat(target + ".results.json"))) await put(target + ".results.json", res);
    for (const x of c.manifest.files) {
      if (x === f || x === res || !x.path.startsWith(dir)) continue;
      const q = `${folder}/${x.path}`;
      if (!(await ws.stat(q))) await put(q, x);
    }
    remember(keyOf(f), target);
    return target;
  }
  let copying: Promise<string> | null = null;
  talkMine.onclick = async () => {
    const f = talkFile;
    if (!f) return;
    talkMine.disabled = true;
    try {
      const ws = await workspace();
      if (!ws) { $("#status").textContent = "This browser can't keep files, so it can't hold a copy."; return; }
      let at = copies()[keyOf(f)] ?? null;
      if (!at || !(await ws.stat(at))) at = await (copying ??= copyTalk(ws, f).finally(() => (copying = null)));
      const e = await ws.stat(at);
      if (!e?.fid) { $("#status").textContent = "Your copy couldn't be opened."; return; }
      location.href = `/?tex=${encodeURIComponent(e.fid)}`;
    } catch (e: any) {
      $("#status").textContent = `Your copy couldn't be made: ${String(e?.message ?? e).slice(0, 200)}`;
    } finally {
      talkMine.disabled = false;
    }
  };

  // ("Copy to my workspace": the copy the first edit makes, made now, then opened in the notebook page (/?nb=<its ref>, as
  // the File menu's Recent opens one), where the reader goes on; once the notebook has one, "Open my copy" opens it.  A
  // copy deleted since is made again)
  const mineBtn = $("#mine") as HTMLButtonElement;
  function setMine() {
    const has = !!(current && copies()[keyOf(current)]);
    mineBtn.textContent = has ? "Open my copy" : "Copy to my workspace";
    mineBtn.title = has ? "Open your copy of this notebook, kept in this browser" : "Make your own copy of this notebook, kept in this browser, and open it";
  }
  mineBtn.onclick = async () => {
    if (!nb || !current || !store) return;
    const f = current, s = store;
    mineBtn.disabled = true;
    try {
      const ws = await workspace();
      if (!ws) { $("#status").textContent = "This browser can't keep files, so it can't hold a copy."; return; }
      let at = copies()[keyOf(f)] ?? null;
      if (!at || !(await ws.stat(at))) {
        s.making ??= makeCopy(f, nb.snapshot()).then((c) => { s.copy = c; if (c) yours(f, c.at); });
        await s.making;
        at = s.copy?.at ?? null;
      }
      const e = at ? await ws.stat(at) : null;
      if (!e?.ref) { $("#status").textContent = "Your copy couldn't be opened."; return; }
      location.href = `/?nb=${encodeURIComponent(e.ref)}`;
    } catch (e: any) {
      $("#status").textContent = e?.code === "conflict" ? "Your copy was changed in another tab: reload to see it." : `Your copy couldn't be made: ${String(e?.message ?? e).slice(0, 200)}`;
    } finally {
      mineBtn.disabled = false;
    }
  };

  $("#runall").onclick = () => nb?.runAll();
  $("#stop").onclick = () => nb?.interrupt();
  $("#download").onclick = () => {
    if (!nb || !current) return;
    const a = el("a", "", { href: URL.createObjectURL(new Blob([toIpynb(nb.snapshot())], { type: "application/x-ipynb+json" })), download: current.path.split("/").pop()!.replace(/\.(py|sage)$/i, ".ipynb") });
    a.click();
    URL.revokeObjectURL(a.getAttribute("href")!);
  };
  // (?f=<path>: that file, a chapter's own link; else the first notebook)
  const want = new URLSearchParams(location.search).get("f");
  const asked = want !== null ? c.manifest.files.find((f) => f.path === want && openable(f.path)) : undefined;
  const first = asked ?? c.manifest.files.find((f) => /\.ipynb$/i.test(f.path)) ?? c.manifest.files.find((f) => openable(f.path));
  if (first) await show(first);
  // background loading: the open notebook's library files at idle (its mode's groups, the groups its import lines name)
  preloadSoon({ table: __SB_PRELOAD__, base: new URL("/", location.href).href, doc: () => { if (!nb) return null; const d = nb.snapshot(); return { mode: d.mode ?? nb.mode, codes: d.cells.filter((x: any) => !x.type).map((x: any) => x.code ?? "") }; } });
  if (want !== null && !asked) $("#status").textContent = `This collection has no notebook ${JSON.stringify(want.slice(0, 200))}: ${first ? `opened ${first.path} instead` : "nothing to open"}.`;
  (window as any).shared = { c, kernel, get nb() { return nb; }, get talk() { return talk; }, preload: preloadState }; // for tests
}

function fail(text: string) {
  $("#title").textContent = "Not found";
  $("#status").textContent = text;
}

main().catch((e) => fail(String(e?.message ?? e)));
