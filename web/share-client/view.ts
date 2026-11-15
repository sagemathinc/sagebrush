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
import { RUNNER_BROWSER } from "../notebook/runner-browser.js";
// (the workspace is web/share-client/copy.ts, a chunk fetched on the first need: types only here)
import type { Entry, GhSource, Workspace } from "../workspace/api";
import { loadLti } from "./lti";
import { GhError, ghPath, listGh, parseGh, type GhAddress, type GhListing } from "../gh/source";
import { gitBlobSha1 } from "../../src/runtime/sha1";
import { render as renderMarkdown } from "../markdown";
import { loadRemotePicture } from "../safe-html";
import { PixelBudget } from "../image-size";

declare const __SB_PRELOAD__: PreloadTable;
declare const __SB_LATEX__: boolean;
declare const __SB_LATEX_HOSTS__: string[];

// (a file is checked by one hash: a share's SHA-256, or a GitHub listing's git blob id, web/gh/source.ts)
interface File { path: string; sha256?: string; gitSha1?: string; size: number }
type Mount = [string, { url: string; sha256?: string; gitSha1?: string; size: number }][];
// (the LaTeX view's chunk, web/latex/share.ts: the interface agreed with its owner, S2-runner.md.  openShared draws the
// talk and starts no interpreter: the view's Sage starts on its run(), after the view is returned, and its dispose()
// ends it, whenever called; astra)
interface TalkView { run(): void; stop(): void; present(): void; dispose(): void }
interface TalkChunk {
  openShared(root: HTMLElement, o: {
    path: string; text: string; results: unknown | null;
    sandbox: { WorkerKernel: unknown; RunnerWorker: unknown; runnerUrl: string } | null;
    mount: Mount; say(text: string): void; onRunning(on: boolean): void;
    onShape?(shape: { hasCode: boolean; hasSlides: boolean }): void;
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
// (where Sagebrush's sandbox can't run at all (web/notebook/runner-browser.js: no browser today), shared code doesn't run
// at all: each run is answered as not run, its cell as it was, and the page says so once, with what can be done)
export const NO_SANDBOX = "Shared notebooks can't run in this browser yet: Sagebrush's sandbox can't start in Safari or in iPhone and iPad browsers built on WebKit. Open this link in Chrome, Edge or Firefox, or press Copy to my workspace to run your own copy.";
// (and where it should but didn't start (the frame or its worker never answered), the same, with why)
export const SANDBOX_FAILED = "Sagebrush's sandbox didn't start in this browser, so this notebook's code can't run here. Reload the page to try again, or press Copy to my workspace to run your own copy.";
// (an assignment's: it has no "Copy to my workspace", since the first change makes the student's copy)
export const ASSIGNMENT_NO_SANDBOX = "This assignment's code can't run in this browser: Sagebrush's sandbox can't start here. Open the assignment from your course in another browser.";
export const ASSIGNMENT_SANDBOX_FAILED = "Sagebrush's sandbox didn't start in this browser, so this assignment's code can't run here. Reload the page to try again.";
// (the page's, set once it knows what it shows)
const sandboxText = { no: NO_SANDBOX, failed: SANDBOX_FAILED };
class NoSandbox {
  text: string;
  constructor(text = sandboxText.no) { this.text = text; }
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  postMessage(m: any) {
    const say = (d: unknown) => setTimeout(() => this.onmessage?.({ data: d }));
    if (m && m.init !== undefined) return say({ ready: true, version: "" });
    if (!m || typeof m !== "object" || m.id === undefined) return;
    if (m.code !== undefined || m.interact !== undefined) $("#status").textContent = this.text;
    say({ id: m.id, skipped: true });
  }
  terminate() {}
}
// (set once a runner in this page gives up: a restart doesn't wait for one again, and is the same refusal at once)
let sandboxGaveUp = false;
const sandboxFailed = () => ((sandboxGaveUp = true), ($("#status").textContent = sandboxText.failed), new NoSandbox(sandboxText.failed));
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
// (and a GitHub copy's identity, by the same key: the notebook's ref, which a rename keeps, so a copy moved or renamed in
// the reader's files is still found, and one put in Trash, or another notebook at its path, isn't taken for it)
const GH_COPIES = "sagebrush-gh-copies";
const ghCopies = (): Record<string, string> => { try { return JSON.parse(localStorage.getItem(GH_COPIES) ?? "{}") ?? {}; } catch { return {}; } };
const rememberGh = (key: string, ref: string | null) => { const all = ghCopies(); if (ref) all[key] = ref; else delete all[key]; try { localStorage.setItem(GH_COPIES, JSON.stringify(all)); } catch {} };
// Where a collection comes from: one loader per kind of path.  A loader gives the collection (its id, which keys the
// reader's copies, so one source's ids must never be another's: a share's is 12 base32 letters), its manifest, and
// where each file is read from; or, as a string, why it can't.  Everything after it is the same for every source: each
// file checked against its SHA-256 as it is read, code run only in the runner, the reader's copy and its button.
export type Loaded = { id: string; version: string; latest: string; manifest: Shared["manifest"]; fileUrl: (f: File) => string; kind?: "assignment" | "github"; gh?: GhView };
// (a GitHub repository's: where it was read from, the folder asked for and the file, and the root it is mounted under,
// /<repo>/, so the notebook's own folder is the interpreter's working folder and its relative paths resolve as in a
// checkout)
export type GhView = { at: GhAddress; listing: GhListing; root: string };
// (what the page calls the collection's own version, and the lines that name it: a share's is the book's; an
// assignment's is the handout, its date the day it was handed out, with no version line (one revision, a digest no
// student needs), and its copy says it stays in this browser, where opening the assignment again finds it)
export const WORDS = {
  share: { dated: "Shared", original: "the book's version", back: "Back to the book's version", asShared: "as shared", version: true, mine: true,
    yours: (at: string) => `This is your copy, kept in this browser at ${at}. Your changes are saved there.` },
  github: { dated: "", original: "GitHub's version", back: "Back to GitHub's version", asShared: "on GitHub", version: false, mine: true,
    yours: (at: string) => `This is your copy, kept in this browser at ${at}. Your changes are saved there.` },
  assignment: { dated: "Handed out", original: "the handout", back: "Back to the handout", asShared: "as handed out", version: false, mine: false,
    yours: (_at: string) => "This is your copy, saved in this browser. To come back to it, open the assignment from your course in this same browser." },
};
export const LOADERS: [RegExp, (m: RegExpMatchArray) => Promise<Loaded | string>][] = [
  // (a share: /s/<id>, or a version of it, /s/<id>@<version>, from the share server; its files from the files origin)
  [/^\/s\/([a-z2-7]{12})(?:@([0-9a-f]{8,64}))?\/?$/, async (m) => {
    const r = await fetch(`/api/share/c/${m[1]}${m[2] ? `?at=${m[2]}` : ""}`);
    if (!r.ok) return r.status === 404 ? "This collection doesn't exist, or its owner deleted it." : `The collection could not be loaded (HTTP ${r.status}).`;
    const c = (await r.json()) as Shared;
    // (the server's whole answer kept, files_origin included: the runner broker's test reads it from window.shared)
    return { ...c, fileUrl: (f: File) => new URL(`/c/${c.id}/${f.sha256}`, c.files_origin).href };
  }],
  // (an assignment opened from a course: /s/#lti=<the course tool's link>, on this site's paired tool only: lti.ts)
  [/^\/s\/$/, () => loadLti(location.hash, location.origin, fetch.bind(globalThis))],
  // (a public GitHub repository: /gh/<owner>/<repo>/blob|tree/<ref>/<path>, or a github.com address pasted after /gh/;
  // read by this browser from GitHub, pinned to a commit when listed by GitHub, or checked against jsDelivr's listing at
  // the ref: web/gh/source.ts)
  [/^\/gh\/(.+)$/, (m) => loadGh(m[1] + location.search)],
];

async function loadGh(rest: string): Promise<Loaded | string> {
  try {
    const at = parseGh(rest);
    const listing = await listGh(at);
    const files: File[] = listing.files.map((f) => ({ path: f.path, size: f.size, ...(f.gitSha1 ? { gitSha1: f.gitSha1 } : { sha256: f.sha256 }) }));
    const urls = new Map(listing.files.map((f) => [f.path, f.url]));
    if (at.kind === "blob" && !urls.has(at.path)) return `No ${at.path} in ${listing.owner}/${listing.repo} at ${at.ref}.`;
    const version = listing.commit ?? at.ref;
    return {
      // (the reader's copies are kept per repository and path, whatever commit: a later visit opens the same copy)
      id: `gh:${listing.owner}/${listing.repo}`, version, latest: version,
      manifest: { title: `${listing.owner}/${listing.repo}`, created: "", files },
      fileUrl: (f: File) => urls.get(f.path)!,
      kind: "github", gh: { at, listing, root: `/${listing.repo}/` },
    };
  } catch (e) {
    return e instanceof GhError ? e.message : `GitHub couldn't be read: ${String((e as Error)?.message ?? e).slice(0, 200)}`;
  }
}

// (a folder name from the title: letters, digits, spaces and - _ . only, at most 60 characters, never "." or "..",
// which no path can hold (workspace/paths.ts): a title of dots alone, as an empty one, is "Shared"; grader's B12)
const folderOf = (title: string) => {
  const s = title.replace(/[^\p{L}\p{N} ._-]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 60).trim();
  return "/" + (s === "" || s === "." || s === ".." ? "Shared" : s);
};

async function main() {
  const hit = LOADERS.map(([re, load]) => [location.pathname.match(re), load] as const).find(([m]) => m);
  if (!hit) return fail("This is not a link to a shared collection.");
  const c = await hit[1](hit[0]!);
  if (typeof c === "string") return fail(c);
  const fileUrl = c.fileUrl;
  const W = WORDS[c.kind ?? "share"];
  if (c.kind === "assignment") Object.assign(sandboxText, { no: ASSIGNMENT_NO_SANDBOX, failed: ASSIGNMENT_SANDBOX_FAILED });

  document.title = `${c.manifest.title} — Sagebrush`;
  $("#title").textContent = c.manifest.title;
  const meta = $("#meta");
  const gh = c.gh ?? null;
  // (a GitHub folder's page is titled by the folder too: "<owner>/<repo> / <folder>")
  if (gh && ghDir(gh)) $("#title").textContent = `${c.manifest.title} / ${ghDir(gh).replace(/\/$/, "")}`;
  if (gh) ghBanner(meta, gh, () => (current ? { kind: "blob" as const, path: current.path } : { kind: "tree" as const, path: ghDir(gh).replace(/\/$/, "") }));
  else {
  // (who it's by, as its publisher typed it: text, never markup, on one line; none when they gave none)
  const by = typeof c.manifest.author === "string" ? c.manifest.author.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200) : "";
  if (by) meta.append(el("span", `by ${by}`, { class: "by" }));
  meta.append(el("span", `${W.dated} ${c.manifest.created.slice(0, 10)}`));
  if (c.manifest.license) meta.append(el("span", `License: ${c.manifest.license}`));
  if (W.version) meta.append(el("span", `Version ${c.version.slice(0, 12)}`, { title: c.version }));
  if (c.version !== c.latest) {
    const a = el("a", "A newer version exists", { href: `/s/${c.id}` });
    meta.append(a);
  }
  }

  const list = $("#files");
  if (gh) ghFolders(list, gh, c.manifest.files);
  for (const f of gh ? ghFilesIn(gh, c.manifest.files) : c.manifest.files) {
    const li = document.createElement("li");
    if (openable(f.path)) {
      const b = el("button", gh ? f.path.slice(ghDir(gh).length) : f.path, { type: "button", class: "link" });
      b.onclick = () => void show(f, true);
      li.append(b);
    } else li.append(el("span", gh ? f.path.slice(ghDir(gh).length) : f.path));
    li.append(el("span", size(f.size), { class: "size" }));
    // (a GitHub file's download is GitHub's own, a click away from the banner's link)
    if (!gh) li.append(el("a", "download", { href: fileUrl(f), class: "dl", download: f.path.split("/").pop()! }));
    list.append(li);
  }

  // (a GitHub file's page: the folder's list folded into one line, "<folder> · N files ▸", so the notebook comes first;
  // a folder's page shows it open)
  if (gh && gh.at.kind === "blob") {
    const t = $("#filestoggle") as HTMLButtonElement, n = ghFilesIn(gh, c.manifest.files).length;
    const label = `${ghDir(gh).replace(/\/$/, "") || gh.listing.repo} · ${n} file${n === 1 ? "" : "s"}`;
    const set = (open: boolean) => { list.hidden = !open; t.textContent = `${label} ${open ? "▾" : "▸"}`; t.setAttribute("aria-expanded", String(open)); };
    t.onclick = () => set(list.hidden);
    set(false);
    t.hidden = false;
  }
  const NOT_RUN = /^Nothing has run yet/;
  // one interpreter, with every file of the collection mounted
  const mount: Mount = c.manifest.files.map((f) => [(gh ? gh.root : "") + f.path, { url: fileUrl(f), ...(f.gitSha1 ? { gitSha1: f.gitSha1 } : { sha256: f.sha256 }), size: f.size }]);
  // (a GitHub notebook's own folder, under the repository's root: the interpreter's working folder and sys.path[0], as
  // the notebook page starts a notebook (web/worker.ts startDir), so open("zeta_zeros_1000.txt") reads the one beside it)
  const startDirOf = (f: File) => gh!.root + f.path.slice(0, f.path.lastIndexOf("/") + 1).replace(/\/$/, "");
  const kernel = new WorkerKernel({
    // (someone else's code: always in the runner, an opaque-origin sandboxed frame; design/runner.md)
    // (a runner that doesn't start is said, never a run left spinning: its held runs are answered as not run)
    createWorker: () => (RUNNER_BROWSER && !sandboxGaveUp ? new RunnerWorker("/runner/", { fallback: sandboxFailed, notRun: sandboxText.failed + "\n" }) : new NoSandbox(sandboxGaveUp ? sandboxText.failed : sandboxText.no)),
    onStart: (w: Worker) => { w.postMessage({ mount }); if (gh && current) w.postMessage({ startDir: startDirOf(current) }); },
  });
  // (nothing runs, and no runner frame exists, until the reader runs something: the interpreter starts with the first
  // run, so opening a share runs no one's code and loads no interpreter; a Stop before then has nothing to stop)
  for (const k of ["execute", "interact"] as const) {
    const f = (kernel as any)[k].bind(kernel);
    (kernel as any)[k] = (...a: unknown[]) => {
      if (!kernel.worker) kernel.start();
      return f(...a);
    };
  }
  const interrupt = (kernel as any).interrupt.bind(kernel);
  (kernel as any).interrupt = (...a: unknown[]) => (kernel.worker ? interrupt(...a) : undefined);
  // (the first run here: the page no longer says nothing has run)
  kernel.on("execute", () => {
    if (NOT_RUN.test($("#status").textContent ?? "")) $("#status").textContent = `This notebook runs in your browser: a cell you run shows your output in place of the one ${W.asShared}.${firstMakes ? FIRST_MAKES : ""}`;
  });
  // (a Run stops background loading starting another file; one in flight finishes)
  kernel.on("execute", preloadStop);
  let nb: any = null;
  let current: File | null = null;
  // (whether the open notebook's first change makes the reader's copy: not in the original when they have one, whose
  // changes aren't kept, as its line says)
  const FIRST_MAKES = " Your first change makes it your own copy.";
  let firstMakes = true;
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
    const ok = f.gitSha1 ? gitBlobSha1(new Uint8Array(bytes)) === f.gitSha1 : hex(await crypto.subtle.digest("SHA-256", bytes)) === f.sha256;
    if (!resp.ok || bytes.byteLength !== f.size || !ok) throw new Error(`${f.path} could not be loaded${gh ? ": it doesn't match GitHub's listing. Reload to try again." : ""}`);
    return bytes;
  };
  // (a GitHub copy's source, as recorded in the reader's files (workspace ghSource): this repository's file `f`?)
  const ghSrc = (f: File, left: File[] = []): GhSource => ({ owner: gh!.listing.owner, repo: gh!.listing.repo, ref: gh!.listing.ref, commit: gh!.listing.commit,
    path: f.path, blob: (f.gitSha1 ?? f.sha256)!, left: left.map((x) => x.path) });
  const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const ghIsCopyOf = (src: GhSource | undefined, f: File) => !!src && sameRepo(src.owner, gh!.listing.owner) && sameRepo(src.repo, gh!.listing.repo) && src.path === f.path;
  const inTrash = (e: Entry) => !!e.trashed || e.path === "/Trash" || e.path.startsWith("/Trash/");
  // (whether `e` is the reader's copy of the GitHub notebook `f`: a notebook, not in Trash, whose recorded source is
  // this repository's file)
  const ghCopyIs = async (ws: Workspace, e: Entry | undefined, f: File) =>
    !!e && e.kind === "notebook" && !!e.ref && !inTrash(e) && ghIsCopyOf(await ws.ghSource("notebook", e.ref).catch(() => undefined), f);
  // (the reader's copy of the GitHub notebook `f`, found by its identity wherever it is now; null, and forgotten, if it
  // is gone, in Trash, or no longer recorded as this file's copy: then the next edit makes a fresh one)
  async function ghCopyAt(ws: Workspace, f: File): Promise<string | null> {
    const ref = ghCopies()[keyOf(f)];
    const p = ref ? await ws.pathOf("notebook", ref) : undefined;
    const e = p ? await ws.stat(p) : undefined;
    if (!e || e.ref !== ref || !(await ghCopyIs(ws, e, f))) { remember(keyOf(f), null); rememberGh(keyOf(f), null); return null; }
    remember(keyOf(f), e.path);
    return e.path;
  }
  // (the copy: the notebook at <folder>/<its path>, and every data file of the collection beside it, unless the reader
  // already has one there (theirs is kept); made once, on the first edit)
  async function makeCopy(f: File, doc: any): Promise<{ ws: Workspace; at: string; rev: number } | null> {
    const ws = await workspace();
    if (!ws) return null;
    const folder = gh ? `/GitHub/${gh.listing.owner}/${gh.listing.repo}` : folderOf(c.manifest.title), at = `${folder}/${f.path}`.replace(/\.(py|sage)$/i, ".ipynb");
    const mk = async (dir: string) => { if (!(await ws.stat(dir))) await ws.mkdir(dir); };
    const dirs = (q: string) => q.split("/").slice(1, -1).map((_, i, a) => "/" + a.slice(0, i + 1).join("/"));
    const { rev: _r, id: _i, ...rest } = doc;
    // (a GitHub notebook's copy takes the files of its own folder and the folders under it, at most GH_COPY_FILES of them
    // and GH_COPY_BYTES in all; the rest stay on GitHub, recorded with the copy, whose line names them)
    const data = gh ? ghCopyFiles(f, c.manifest.files) : { take: c.manifest.files, left: [] as File[] };
    // (a GitHub notebook's copy is made by one tab at a time (Web Locks): a copy another tab made meanwhile, its source
    // recorded with it, is the one copy, and this tab's change is a conflict, said, never a second copy beside it)
    const locks = (navigator as any).locks;
    const oneTab = <T,>(g: () => Promise<T>): Promise<T> => (gh && locks && typeof locks.request === "function" ? locks.request("sagebrush-gh-copy", g) : g());
    const placed = await oneTab(async () => {
      for (const d of dirs(at)) await mk(d);
      let target = at;
      for (let n = 2; ; n++) {
        const e = await ws.stat(target);
        if (!e) break;
        if (gh && (await ghCopyIs(ws, e, f))) return { target, ref: e.ref!, theirs: true };
        target = at.replace(/(\.ipynb)$/i, ` (${n})$1`);
      }
      const e = await ws.create(target, { content: rest });
      if (gh && e.ref) await ws.setGhSource("notebook", e.ref, ghSrc(f, data.left));
      return { target, ref: gh ? e.ref : null, theirs: false };
    });
    const target = placed.target;
    if (gh && placed.ref) rememberGh(keyOf(f), placed.ref);
    // (the revision later saves are based on: the one read now, taken only if it holds exactly what this tab wrote;
    // one another tab wrote meanwhile is a conflict, its contents kept, never written over (astra B1-COPY-1))
    const made = await ws.read(target);
    const ours = !placed.theirs && sameDoc(made.content, rest);
    if (!placed.theirs) for (const d of data.take) {
      if (NOTEBOOK.test(d.path)) continue;
      const q = `${folder}/${d.path}`;
      if (await ws.stat(q)) continue;
      for (const x of dirs(q)) await mk(x);
      const e = await ws.create(q, { content: new Uint8Array(await fetchChecked(d)) });
      if (gh && e.fid) await ws.setGhSource("file", e.fid, ghSrc(d));
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
    line.replaceChildren(el("span", W.yours(at)), el("span", " "));
    const back = el("button", W.back, { type: "button", class: "link" });
    back.onclick = () => void open(f, "original");
    line.append(back);
    line.hidden = false;
    line.dataset.copy = at;
    if (gh) void ghNotes(f, at, back);
    // (the status no longer offers to make a copy: there is one, and the line above says so)
    if (($("#status").textContent ?? "").endsWith(FIRST_MAKES)) $("#status").textContent = "";
  }
  // (a GitHub copy's line, from its recorded source, each time it opens: GitHub's version newer than the copy's, at the
  // ref it was opened at (never merged: the button opens GitHub's), and the files of its folder that stayed on GitHub)
  async function ghNotes(f: File, at: string, back: HTMLElement) {
    const ws = await workspace(), ref = ghCopies()[keyOf(f)];
    const src = ws && ref ? await ws.ghSource("notebook", ref).catch(() => undefined) : undefined;
    const line = $("#copyline");
    if (!src || !ghIsCopyOf(src, f) || line.dataset.copy !== at || current !== f) return;
    const now = gh!.listing.commit;
    if (now && src.commit && src.ref === gh!.listing.ref && src.commit !== now) back.textContent = `Newer on GitHub (${now.slice(0, 7)}): open it`;
    const n = src.left.length, dir = f.path.slice(0, f.path.lastIndexOf("/") + 1);
    if (n) line.append(el("div", `${n} file${n === 1 ? "" : "s"} of its folder stayed on GitHub (over the copy's limit of ${GH_COPY_FILES} files or ${GH_COPY_BYTES / 1e6} MB): ${src.left.slice(0, 5).map((p) => (p.startsWith(dir) ? p.slice(dir.length) : p)).join(", ")}${n > 5 ? ", …" : ""}.`, { class: "left" }));
  }
  function original(f: File, at: string | null) {
    const line = $("#copyline");
    if (!at) { line.hidden = true; return; }
    line.replaceChildren(el("span", `This is ${W.original}: changes here aren't kept. `));
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
  // (a file opened from the list: brought into view, its bar at the top of the window, and focus moved to its name, so the
  // reader sees it opened, and a keyboard or screen reader is taken there; the list can be long, a README longer)
  const show = (f: File, reveal = false) => (isTalk(f.path) ? openTalk(f, reveal) : open(f, "auto", reveal));
  const bringIn = (bar: string, name: string) => { $(bar).scrollIntoView({ block: "start" }); ($(name) as HTMLElement).focus({ preventScroll: true }); };
  const mark = (f: File) => { for (const b of list.querySelectorAll("button.link")) b.classList.toggle("on", b.textContent === f.path); };

  async function open(f: File, which: "auto" | "original" = "auto", reveal = false) {
    const me = ++view;
    leaveTalk();
    $("#status").textContent = `opening ${f.path}…`;
    let doc, copy: { ws: Workspace; at: string; rev: number } | null = null;
    let at: string | null = copies()[keyOf(f)] ?? null;
    try {
      // (a GitHub notebook's copy: the one its identity names, if it is still there, out of Trash, and still this file's)
      if (gh && at) { const ws = await workspace(); at = ws ? await ghCopyAt(ws, f) : null; }
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
      if (!kernel.worker) kernel.start();
      if (gh) (kernel as any).worker?.postMessage({ startDir: startDirOf(f) });
      // (where the sandbox can't run, a Run touches no cell: the page says why once, the outputs as shared kept)
      nb ??= createNotebook($("#nb"), { kernel, staleOnLoad: true, assetBase: "/", refuseRun: () => (RUNNER_BROWSER ? false : (($("#status").textContent = sandboxText.no), true)) });
      // (the book's version, when the reader has a copy, keeps nothing: their copy is one, and it isn't written over)
      store = new CopyStore(doc, f, copy, !(at && which === "original" && copies()[keyOf(f)]));
      await nb.attach(store);
      // (attached after the reader went elsewhere: let go of it, show nothing of it)
      if (me !== view) { nb.detach(); return; }
    } finally {
      done();
    }
    current = f;
    player?.stop();
    ($("#history") as HTMLButtonElement).hidden = !histOf(f);
    setMine();
    $("#nb").hidden = false;
    $("#nbbar").hidden = false;
    $("#nbname").textContent = f.path;
    if (copy) yours(f, copy.at); else original(f, which === "original" ? copies()[keyOf(f)] ?? null : null);
    firstMakes = !copy && !(which === "original" && copies()[keyOf(f)]);
    $("#status").textContent = copy ? "Your copy, as you left it. Run all runs it in your browser." : `Nothing has run yet: the outputs are ${W.asShared}. Run all runs this notebook in your browser.${firstMakes ? FIRST_MAKES : ""}`;
    mark(f);
    if (reveal) bringIn("#nbbar", "#nbname");
  }

  // (the open talk's view, and its file)
  let talk: TalkView | null = null, talkFile: File | null = null;
  const talkRun = $("#talkrun") as HTMLButtonElement;
  let running = false;
  const setRunning = (on: boolean) => {
    running = on;
    talkRun.textContent = on ? "■ Stop" : "▶ Run";
    talkRun.title = on ? "Stop this document's code" : "Run this document's code in your browser";
  };
  function leaveTalk() {
    talk?.dispose();
    talk = talkFile = null;
    setRunning(false);
    $("#talk").replaceChildren();
    $("#talk").hidden = $("#talkbar").hidden = true;
  }
  let chunk: Promise<TalkChunk> | null = null;
  async function openTalk(f: File, reveal = false) {
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
      if (reveal && me === view && !$("#talkbar").hidden) bringIn("#talkbar", "#talkname");
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
    let shaped = false;
    talkRun.hidden = ($("#talkpresent") as HTMLButtonElement).hidden = false;
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
        // (a .tex shared with its folder may be an article: Run only with code to run, Present only with slides, and the
        //  first status said for what it has (later renders, a Run's own, leave the status to the Run))
        onShape: ({ hasCode, hasSlides }) => {
          if (me !== view) return;
          talkRun.hidden = !hasCode && !running;
          ($("#talkpresent") as HTMLButtonElement).hidden = !hasSlides;
          if (!shaped) say(hasCode ? "These are the author's results. Press Run to run this document's code in your browser." : "");
          shaped = true;
        },
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
    // (an assignment has no button: its copy is made by the first change, and the copy line goes between the two)
    mineBtn.hidden = !W.mine;
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

  // (a notebook published with its edit history (<name>.sbreplay beside it, the author's choice): ▶ History replays it,
  // version by version, read-only, the history module loaded only then; Close goes back to the notebook as it was)
  // (a published history's bounds: history.js PUBLISHED_HISTORY_LIMITS, its changes its versions; checked again
  // after replay as a second guard)
  const HISTORY_MAX_VERSIONS = 5000;
  const histOf = (f: File | null) => (f ? c.manifest.files.find((x) => x.path === f.path.replace(/\.[^./]+$/, "") + ".sbreplay") ?? null : null);
  let player: { stop(): void } | null = null;
  $("#history").onclick = async () => {
    const hf = histOf(current);
    if (!hf || player) return;
    const btn = $("#history") as HTMLButtonElement;
    btn.disabled = true;
    try {
      // (someone else's file: read as notebook/bundle.js reads any, unpacked as it streams and stopped at a bound,
      // at most 5,000 changes (all versions: no journal) and no files, and checked to be well formed, all before any
      // of it is replayed; each version built only when shown)
      const mod: any = await import(new URL("/sagebrush-history.js", location.href).href);
      const b = await mod.readBundle(await fetchChecked(hf), mod.PUBLISHED_HISTORY_LIMITS);
      if (Object.keys(b.blobs ?? {}).length) throw new Error("a published history holds no files");
      const h = mod.replayHistory(mod.checkPublishedHistory(b.history));
      await h.init();
      const vs: { time: string; ms: number }[] = h.versions().filter((v: any) => v.time);
      if (!vs.length) throw new Error("it has no versions");
      if (vs.length > HISTORY_MAX_VERSIONS) throw new Error(`it has more than ${HISTORY_MAX_VERSIONS} versions`);
      const view = createNotebook($("#histview"), { readOnly: true, mode: b.notebook?.mode });
      const slider = $("#histslider") as HTMLInputElement, info = $("#histinfo"), play = $("#histplay") as HTMLButtonElement;
      slider.max = String(vs.length - 1);
      const showAt = (i: number) => {
        slider.value = String(i);
        view.load(h.docAt(vs[i].time));
        info.textContent = `Version ${i + 1} of ${vs.length} · ${new Date(vs[i].ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
      };
      let timer: ReturnType<typeof setInterval> | null = null;
      const pause = () => { if (timer) clearInterval(timer); timer = null; play.textContent = "▶ Play"; };
      play.onclick = () => {
        if (timer) return pause();
        if (+slider.value >= vs.length - 1) showAt(0);
        play.textContent = "❚❚ Pause";
        timer = setInterval(() => (+slider.value >= vs.length - 1 ? pause() : showAt(+slider.value + 1)), 700);
      };
      slider.oninput = () => { pause(); showAt(+slider.value); };
      player = { stop: () => { pause(); view.destroy?.(); $("#histview").replaceChildren(); $("#histview").hidden = $("#histbar").hidden = true; $("#nb").hidden = false; h.close?.(); player = null; } };
      $("#histclose").onclick = () => player?.stop();
      $("#nb").hidden = true;
      $("#histview").hidden = $("#histbar").hidden = false;
      // (it opens at now, the newest version; Play from there starts again at the first)
      showAt(vs.length - 1);
    } catch (e: any) {
      $("#status").textContent = `The edit history couldn't be opened: ${String(e?.message ?? e).slice(0, 160)}`;
    } finally {
      btn.disabled = false;
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
  // (a GitHub folder's README, below its list, when no notebook is asked for: rendered as a notebook's text is, its
  // relative links to this repository's /gh/ pages and its pictures from raw, at the same commit)
  if (gh && gh.at.kind === "tree") {
    const readme = c.manifest.files.find((f) => /^readme\.md$/i.test(f.path.slice(ghDir(gh).length)));
    if (readme) void fetchChecked(readme).then((b) => ghReadme(gh, new TextDecoder().decode(b), c.manifest.files, fileUrl)).catch(() => {});
  }
  // (?f=<path>: that file, a chapter's own link; else the first notebook)
  const want = gh ? (gh.at.kind === "blob" ? gh.at.path : null) : new URLSearchParams(location.search).get("f");
  const asked = want !== null ? c.manifest.files.find((f) => f.path === want && openable(f.path)) : undefined;
  const first = asked ?? (gh ? undefined : c.manifest.files.find((f) => /\.ipynb$/i.test(f.path)) ?? c.manifest.files.find((f) => openable(f.path)));
  if (first) await show(first);
  // background loading: the open notebook's library files at idle (its mode's groups, the groups its import lines name)
  preloadSoon({ table: __SB_PRELOAD__, base: new URL("/", location.href).href, doc: () => { if (!nb) return null; const d = nb.snapshot(); return { mode: d.mode ?? nb.mode, codes: d.cells.filter((x: any) => !x.type).map((x: any) => x.code ?? "") }; } });
  if (gh && want !== null && !asked) $("#status").textContent = `${want} isn't a notebook Sagebrush opens: its files are listed above.`;
  else if (gh && !first) $("#status").textContent = "Open a notebook to read it. Nothing runs until you press Run.";
  else if (want !== null && !asked) $("#status").textContent = `This collection has no notebook ${JSON.stringify(want.slice(0, 200))}: ${first ? `opened ${first.path} instead` : "nothing to open"}.`;
  (window as any).shared = { c, kernel, get nb() { return nb; }, get talk() { return talk; }, preload: preloadState }; // for tests
}

// ---- a GitHub repository's page: its banner, the asked folder's subfolders and files, and what a copy takes
const GH_COPY_FILES = 20, GH_COPY_BYTES = 10e6;
const ghDir = (gh: GhView) => (gh.at.kind === "tree" ? gh.at.path : gh.at.path.slice(0, gh.at.path.lastIndexOf("/") + 1)).replace(/\/?$/, "/").replace(/^\/$/, "");
/** "From github.com/<owner>/<repo>", the ref and the commit, linked to GitHub; and whether it may be behind */
function ghBanner(meta: HTMLElement, gh: GhView, target: () => { kind: "blob" | "tree"; path: string }) {
  const { owner, repo, commit, viaJsdelivr, partial, skipped } = gh.listing;
  const at = commit ?? gh.at.ref;
  const from = el("a", `From github.com/${owner}/${repo}`, { href: `https://github.com/${owner}/${repo}/tree/${encodeURIComponent(at)}/${gh.at.kind === "tree" ? gh.at.path : ""}`, target: "_blank", rel: "noopener noreferrer" });
  meta.append(from, el("span", gh.at.ref === "HEAD" ? (commit ? `at ${commit.slice(0, 7)}` : "") : `${gh.at.ref}${commit && commit !== gh.at.ref ? ` at ${commit.slice(0, 7)}` : ""}`));
  if (viaJsdelivr) meta.append(el("span", "(via jsDelivr, may be up to 12 hours old)"));
  if (partial) meta.append(el("span", "This repository is too large to list whole: some files aren't shown."));
  if (skipped.length) meta.append(el("span", `${skipped.length} not opened here`, { title: skipped.slice(0, 20).map((x) => `${x.path}: ${x.why}`).join("\n") }));
  // (the README badge for what's open, at the ref as asked: Markdown that shows /badge/open-in-sagebrush.svg and links here)
  const badge = el("button", "Copy badge", { type: "button", class: "link", title: "Markdown for an \"Open in Sagebrush\" badge that links to this notebook (or folder), for a README" });
  badge.onclick = async () => {
    const page = new URL(ghPath({ owner, repo, ref: gh.at.ref, ...target() }), location.origin).href;
    const md = `[![Open in Sagebrush](${new URL("/badge/open-in-sagebrush.svg", location.origin).href})](${page})`;
    try { await navigator.clipboard.writeText(md); badge.textContent = "Copied"; setTimeout(() => (badge.textContent = "Copy badge"), 2000); }
    catch { $("#status").textContent = md; }
  };
  meta.append(badge);
}
/** the asked folder's subfolders, and its parent, as links to their own /gh/ pages */
function ghFolders(list: HTMLElement, gh: GhView, files: File[]) {
  const dir = ghDir(gh), subs = new Set<string>();
  for (const f of files) if (f.path.startsWith(dir)) { const rest = f.path.slice(dir.length); if (rest.includes("/")) subs.add(rest.slice(0, rest.indexOf("/"))); }
  const link = (text: string, path: string) => { const li = document.createElement("li"); li.append(el("a", text, { href: ghPath({ ...gh.at, owner: gh.listing.owner, repo: gh.listing.repo, kind: "tree", path }) })); list.append(li); };
  if (dir) link("../", dir.replace(/\/$/, "").split("/").slice(0, -1).join("/"));
  for (const s of [...subs].sort()) link(`${s}/`, dir + s);
}
/** A folder's README, into #readme, as an imported document's text is drawn (web/notebook/notebook.js): its pictures
 * shown only when clicked (a relative one by its raw URL in this repository), one pixel budget for all of them; its
 * relative links to /gh/ pages (a folder's, or a file's) */
function ghReadme(gh: GhView, text: string, files: File[], fileUrl: (f: File) => string) {
  const box = $("#readme");
  const dir = ghDir(gh), byPath = new Map(files.map((f) => [f.path, f]));
  const resolve = (href: string) => {
    const out: string[] = dir ? dir.replace(/\/$/, "").split("/") : [];
    for (const s of decodeURIComponent(href.replace(/[?#].*$/, "")).split("/")) { if (s === "..") out.pop(); else if (s && s !== ".") out.push(s); }
    return out.join("/");
  };
  const relative = (u: string | null) => !!u && !/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(u);
  // (a relative picture, ![alt](path), as its listed file's raw URL; one not listed stays as it is, and is shown as its
  // alt text: only an http(s) address is a picture)
  const md = text.replace(/!\[([^\]]*)\]\(\s*([^)\s]+)(\s+"[^"]*")?\s*\)/g, (m, alt: string, url: string, title?: string) => {
    const f = relative(url) ? byPath.get(resolve(url)) : undefined;
    return f ? `![${alt}](${fileUrl(f)}${title ?? ""})` : m;
  });
  box.innerHTML = renderMarkdown(md, { remote: "click", pixels: new PixelBudget() });
  box.addEventListener("click", loadRemotePicture);
  for (const a of box.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href");
    if (!relative(href)) continue;
    const path = resolve(href!);
    // (a listed file, or one not listed but named like a file (it may be one this listing skipped): its page; else a folder's)
    const kind = byPath.has(path) || (!files.some((f) => f.path.startsWith(path + "/")) && /\.[^/.]+$/.test(path)) ? "blob" : "tree";
    a.setAttribute("href", ghPath({ owner: gh.listing.owner, repo: gh.listing.repo, ref: gh.at.ref, kind, path }));
  }
  box.hidden = false;
  // (its math by KaTeX, sagebrush-math.js, fetched only when the README has some, as a notebook's text fetches it)
  if (box.querySelector(".math")) void import(new URL("/sagebrush-math.js", location.href).href).then(async (m) => { await m.ready?.(); m.typeset(box); }).catch(() => {});
}
/** the files directly in the asked folder */
const ghFilesIn = (gh: GhView, files: File[]) => files.filter((f) => f.path.startsWith(ghDir(gh)) && !f.path.slice(ghDir(gh).length).includes("/"));
/** what a copy of `f` takes from its own folder and the folders under it (data/x.csv too), within the copy's limits,
 * and what stays on GitHub (said, never dropped silently); other notebooks are left for their own copies */
function ghCopyFiles(f: File, files: File[]) {
  const dir = f.path.slice(0, f.path.lastIndexOf("/") + 1);
  const take: File[] = [], left: File[] = [];
  let bytes = 0;
  // (the folder's own files first, then each level below: a cap reached in data/ never leaves out what sits beside it)
  const depth = (p: string) => p.split("/").length;
  for (const d of [...files].sort((x, y) => depth(x.path) - depth(y.path) || (x.path < y.path ? -1 : 1))) {
    if (d === f || !d.path.startsWith(dir) || NOTEBOOK.test(d.path)) continue;
    if (take.length < GH_COPY_FILES && bytes + d.size <= GH_COPY_BYTES) { take.push(d); bytes += d.size; } else left.push(d);
  }
  return { take, left };
}

function fail(text: string) {
  // (an assignment's link that can't be opened isn't a missing page: the sentence says why, and what to do)
  $("#title").textContent = location.hash.startsWith("#lti=") ? "This assignment can't be opened" : location.pathname.startsWith("/gh/") ? "This can't be opened from GitHub" : "Not found";
  $("#status").textContent = text;
}

main().catch((e) => fail(String(e?.message ?? e)));
