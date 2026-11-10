// The LaTeX editor page (DEV only, behind the flag: plan sbspace r5 + r6b). The page index.html hands itself to
// mount() for /?tex=<fid>. It binds to the file's fid (Workspace.pathOfFile), reads the whole file (at most 4 MiB),
// shows the source on the left and the live preview on the right, and saves as you type (autosave.ts, plan U8 r6:
// durable drafts, no Save button), only over the revision its text came from (a change made elsewhere is followed,
// or asked about), with the kept minimums of save.ts. The preview comes from a module Worker
// (dist/sagebrush-latex-worker.js), whose replies are taken only for the request's own document/revision (gate.ts),
// patched under a per-frame budget, a split chunk's pieces replaced as one unit (staged hidden, then swapped).
// SECURITY: file names, paths and messages reach the page through textContent; preview HTML is the renderer's (its
// own escaping, KaTeX trust:false); images only as <img> from blob: URLs made of bytes checked by images.ts.
import type { Workspace, Entry } from "../workspace/api";
import { nameOf, parentOf, join, safeName } from "../workspace/paths";
import { openBytes, encodeText, EDIT_MAX } from "./save";
import { imageCandidates, graphicsPathOf, notFoundWhy, sniffImage, admitImageBytes, IMAGE_BOUNDS, IMAGE_EXTS } from "./images";
import { engineInputs, admitInput, type Known } from "./inputs";
import { AutoSaver, type SaveState } from "./autosave";
import { leaver } from "./leave";
import { browserDrafts, newWriterId } from "./drafts";
import { type Token } from "./gate";
import { createEditor } from "./editor";
import { PAGE_CSS } from "./style";
import { registerLatexTools, setTarget, clearTarget } from "./agent-tools";
import { mark } from "./marks";
import type { Example } from "./examples";
import type { sessionOf } from "./run-core.mjs";
import { seenOf, checkedResults } from "./results-check.mjs";
import { staleWhy } from "./engine/sagetex.mjs";
// (the embeddable editor, for the questions site: component.ts)
export { mountEditor, type LatexEditor } from "./component";
import { viewOf } from "./component";
// (comments on the preview: comments.ts, its own chunk, /sagebrush-latex-comments.js, fetched on the first call;
// a document without comments never loads it)
export type { Thread } from "./comments";
const commentsUrl = new URL("sagebrush-latex-comments.js", import.meta.url).href;
export const loadComments = (): Promise<typeof import("./comments")> => import(commentsUrl);
export async function attachComments(...a: Parameters<typeof import("./comments").attachComments>) { return (await loadComments()).attachComments(...a); }
// (a document's live comments in this page: comments-doc.ts, a chunk of its own, /sagebrush-latex-comments-doc.js)
const docCommentsUrl = new URL("sagebrush-latex-comments-doc.js", import.meta.url).href;
const loadDocComments = (): Promise<typeof import("./comments-doc")> => import(docCommentsUrl);
// (an agent on this computer, paired with the page: agent.ts, a chunk of its own, /sagebrush-latex-agent.js; mounted
// once per page, as the editor switches files in place)
const agentUrl = new URL("sagebrush-latex-agent.js", import.meta.url).href;
// (the presenter, present.ts: a chunk of its own, /sagebrush-latex-present.js; a failed fetch is tried again by a URL of its own)
const presentUrl = new URL("sagebrush-latex-present.js", import.meta.url).href;
let presentMod: Promise<typeof import("./present")> | null = null, presentTries = 0;
// (the ten examples, examples.ts: a chunk of its own, /sagebrush-latex-examples.js, fetched when their list opens (or
// earlier, by the page's background loading); a failed fetch is tried again by a URL of its own)
const examplesUrl = new URL("sagebrush-latex-examples.js", import.meta.url).href;
let examplesMod: Promise<Example[]> | null = null, examplesTries = 0;
export const loadExamples = (): Promise<Example[]> => (examplesMod ??= (import(examplesTries++ ? `${examplesUrl}?try=${examplesTries}` : examplesUrl) as Promise<typeof import("./examples")>).then((m) => m.EXAMPLES).catch((e) => { examplesMod = null; throw e; }));
const loadPresent = () => (presentMod ??= (import(presentTries++ ? `${presentUrl}?try=${presentTries}` : presentUrl) as Promise<typeof import("./present")>).catch((e) => { presentMod = null; throw e; }));
// (Run's Sage session, run-core.mjs: the hosting page's kernel and runner classes (Host.sandbox), its interpreter in
// the runner, the opaque-origin sandbox, with no fallback; one per page, kept warm for the next Run and
// for the next file opened in place; started again on a Run after it failed to start. Each Run's number: a Run is
// current only while it is the last one asked for, on a page not disposed of)
let sageSession: ReturnType<typeof sessionOf> | null = null;
// (the interacts this page's Sage session made, by id: the last Run's, live in the preview (interact.ts live), only in
//  the document that Run was of (liveFid): another document's results, from another session, have ids of their own;
//  with the interpreter's generation then (run-core), and ended (`over`) when the page leaves the document (astra))
let liveIds: Set<number> & { over?: number } = new Set(), liveFid = "";
// (Run's code, run-core.mjs: a chunk of its own, /sagebrush-latex-run.js, fetched on the first Run (it is first-use
//  code: the editor loads without it); a failed fetch is tried again by a URL of its own)
const runUrl = new URL("sagebrush-latex-run.js", import.meta.url).href;
let runMod: Promise<typeof import("./run-core.mjs")> | null = null, runTries = 0;
// (@interact, a Sagebrush extension: the preview's interacts drawn, and a Run's checked, by interact.ts, a chunk of its own,
//  /sagebrush-latex-interact.js, fetched only once a preview or a Run has one; a failed fetch is tried again by a URL of
//  its own)
const interactUrl = new URL("sagebrush-latex-interact.js", import.meta.url).href;
let interactMod: Promise<typeof import("./interact")> | null = null, interactTries = 0;
const loadInteract = () => (interactMod ??= (import(interactTries++ ? `${interactUrl}?try=${interactTries}` : interactUrl) as Promise<typeof import("./interact")>).catch((e) => { interactMod = null; throw e; }));
const loadRun = () => (runMod ??= (import(runTries++ ? `${runUrl}?try=${runTries}` : runUrl) as Promise<typeof import("./run-core.mjs")>).catch((e) => { runMod = null; throw e; }));
let runGen = 0;
// (a failed fetch is forgotten, so the next try fetches again, by a URL of its own: a browser may keep a failed
// module's result for its URL; each caller says the failure)
let agentPairing: Promise<{ connect(): unknown }> | null = null, agentTries = 0;
const pairAgent = (ws: Workspace) => (agentPairing ??= (import(agentTries++ ? `${agentUrl}?try=${agentTries}` : agentUrl) as Promise<typeof import("./agent")>).then((m) => m.mountAgentPairing(ws as any)))
  .catch((e) => { agentPairing = null; throw e; });

export { PATCH_BUDGET, FOLLOW_KEY } from "./editor";
// the source's font size (px) and the preview's zoom (%): their ranges, defaults and keys in localStorage
/** The largest results file read (`sagebrush latex run`'s, beside the .tex). */
const RESULTS_MAX = 32 * 2 ** 20;
export const FONT = { key: "sagebrush-latex-font", min: 9, max: 28, def: 13 };
export const ZOOM = { key: "sagebrush-latex-zoom", min: 50, max: 200, def: 100, step: 10 };
// (the strip under the toolbar (William, Nov 9: "exactly what should I expect of this thing", and a page that says how
//  it differs from LaTeX, not a wall of text): one line, dismissible; a file that can't be saved says so instead, not
//  dismissible)
const BANNER = "Shown as a web page as you type, not a PDF; part of LaTeX is supported.";
const DIFFERS = "/articles/latex/02-how-it-differs";
const NO_SAVE = (why: string) => "This file can't be saved here: " + why + ".";
const BANNER_OFF = "sagebrush-latex-banner-dismissed";

// (sandbox: the hosting page's runner and kernel classes, for Run, boot.ts; none, Run says why it can't run)
type Host = {
  ws: Workspace; fid: string; back(): void; sandbox?: { WorkerKernel: unknown; RunnerWorker: unknown } | null;
  /** The File menu drawn into `menu` by the notebook page's own one (boot.ts texFileMenu, U0); its key handler returned */
  fileMenu?(menu: HTMLElement, o: { print(): void; close(): void }): (e: KeyboardEvent) => void;
  /** A comment's text drawn into `box` as Markdown with math, by the notebook page's own renderer (boot.ts) */
  markdown?(box: HTMLElement, text: string): void;
};
// (true only in a SAGEBRUSH_LATEX_PREVIEW=test build, web/build.ts: the page test's hold on image reads)
declare const __SB_LATEX_TEST__: boolean | undefined;
// (a reply's piece: its group, its HTML and, from the worker, its UTF-8 size)
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e;
};
const enc = new TextEncoder();

/** "From an example" (boot.ts adds the item and loads this module on its click): a list of the examples
 * (examples.ts), as large buttons that fit a phone; the one chosen is made as a folder of its own,
 * "/LaTeX examples/<title>" (or "<title> (2)", ...: the first name not taken), with its files, and its main .tex
 * opened in the editor by boot.ts's hook (`open`). Escape, or the backdrop, closes it with nothing made. */
export async function texExamples(ws: Workspace, open: (e: Entry) => unknown): Promise<void> {
  let examples: Example[];
  try { examples = await loadExamples(); }
  catch { alert("The examples couldn't be loaded. Check the network, then try again."); return; }
  const d = document.createElement("dialog");
  d.className = "sb-tex-examples";
  d.setAttribute("aria-label", "LaTeX examples");
  d.style.cssText = "max-width:min(560px,calc(100vw - 16px));width:100%;max-height:calc(100dvh - 32px);padding:0;border:1px solid #c8ccc9;border-radius:10px;box-sizing:border-box";
  const head = document.createElement("div");
  head.style.cssText = "display:flex;justify-content:space-between;align-items:center;padding:10px 14px;border-bottom:1px solid #e3e6e4;position:sticky;top:0;background:inherit";
  const h = document.createElement("b"); h.textContent = "LaTeX examples";
  const x = document.createElement("button"); x.textContent = "✕"; x.setAttribute("aria-label", "Close"); x.style.cssText = "min-width:44px;min-height:44px"; x.onclick = () => d.close();
  head.append(h, x);
  const list = document.createElement("div"); list.style.cssText = "display:grid;gap:8px;padding:12px";
  for (const ex of examples) {
    const b = document.createElement("button");
    b.dataset.example = ex.id;
    b.style.cssText = "display:block;width:100%;text-align:left;padding:10px 12px;min-height:44px;border:1px solid #d5d9d6;border-radius:8px;background:transparent;cursor:pointer";
    const t = document.createElement("b"); t.textContent = ex.title;
    const a = document.createElement("div"); a.textContent = ex.about; a.style.cssText = "font-size:13px;opacity:.75;margin-top:2px";
    b.append(t, a);
    b.onclick = async () => {
      d.close();
      try { open(await makeExample(ws, ex)); }
      catch (err) { alert("The example couldn't be made: " + String((err as Error)?.message ?? err)); }
    };
    list.append(b);
  }
  d.append(head, list);
  d.addEventListener("click", (ev) => { if (ev.target === d) d.close(); });
  d.addEventListener("close", () => d.remove());
  document.body.append(d);
  d.showModal();
}

/** An example's folder and files; its main .tex (the first file) returned. */
export async function makeExample(ws: Workspace, ex: Example): Promise<Entry> {
  for (let i = 1; i <= 1000; i++) {
    const dir = "/LaTeX examples/" + ex.title + (i > 1 ? " (" + i + ")" : "");
    if (await ws.stat(dir)) continue;
    await ws.mkdir(dir);
    let main: Entry | undefined;
    for (const [name, text, b64] of ex.files) {
      const content = b64 ? Uint8Array.from(atob(text), (c) => c.charCodeAt(0)) : new TextEncoder().encode(text);
      const e = await ws.createByPerson(dir + "/" + name, { content });
      main ??= e;
    }
    return main!;
  }
  throw new Error("no free folder name");
}

// ---- a published document, opened read only (?tex-doc=, boot.ts: the articles' links): doc.ts, a chunk of its own
// (/sagebrush-latex-doc.js), fetched only for such a link; it's given the editor's pieces from here, so they aren't
// bundled twice
const docUrl = new URL("sagebrush-latex-doc.js", import.meta.url).href;
export async function openDoc(root: HTMLElement, path: string, ws: Workspace | null, open: (e: Entry) => unknown): Promise<void> {
  let m: typeof import("./doc");
  try { m = await import(docUrl); } catch { root.textContent = "Couldn't load this document's page. Check the network, then reload to try again."; return; }
  return m.openDoc({ createEditor, css: PAGE_CSS + PRINT_CSS + MENU_CSS, printPreview, loadPresent, editMax: EDIT_MAX }, root, path, ws, open);
}

/** New ▸ LaTeX document (boot.ts texNew, the pages' File ▸ New and file panel): <folder>/Untitled.tex, or
 * "Untitled (2).tex", ... (the first name not taken), made by the person here with a short document, then opened in
 * the editor by boot.ts's own hook (`open`). */
export async function newTex(ws: Workspace, open: (e: Entry) => unknown, folder = "/"): Promise<void> {
  try {
    for (let i = 1; i <= 1000; i++) {
      const p = (folder === "/" ? "" : folder) + "/Untitled" + (i > 1 ? " (" + i + ")" : "") + ".tex";
      if (await ws.stat(p)) continue;
      open(await ws.createByPerson(p, { content: new TextEncoder().encode("\\documentclass{article}\n\\begin{document}\n\n\\end{document}\n") }));
      return;
    }
    alert("No free name for a new LaTeX file");
  } catch (err) { alert("The LaTeX file couldn't be made: " + String((err as Error)?.message ?? err)); }
}

// the page mounted now: another .tex is opened in place (no reload: William's B2, the notebook no longer flashing by),
// so the one shown is disposed of first (its worker, image blobs and listeners)
let current: { dispose(): void; close(): Promise<unknown>; dirty(): boolean; settle(): Promise<boolean>; hold(on: boolean): void } | null = null;
// each mount's number: a mount whose number is no longer the last one's was replaced while it waited (a read, a path
// lookup), and stops at its next step, before it sets the title, makes an editor or becomes current
let mounts = 0;
// (every editor closed goes through this one barrier, in order: a mount waits for all those closed before it, its
//  number taken before it waits, and only the newest mount goes on (astra U8-SWITCH-1))
let closing: Promise<unknown> = Promise.resolve();
// (a controlled switch waits for the editor shown to settle first, held read-only, and only the newest intent goes on:
//  leave.ts)
const { intent, leaveOk } = leaver(() => current, (lost) => confirm(lost ? LEAVE_LOST : LEAVE));
// the history entry shown, so a declined Back or Forward goes back to exactly it: its id (history.state.sbTexId), URL
// and Navigation API key where there is one (traverseTo); else its position (history.state.sbTex: every entry this
// page sees is numbered, from 0 at the first file, a fragment's entry too). Whether that return is under way: where it
// lands is checked, and anywhere else the shown entry is pushed again, so the URL is always the file shown.
let shownAt = 0, shownId = "", shownUrl = "", shownKey: string | undefined, returning = false;
// (how the return under way goes: by the entry's key, which lands only on that entry, or by its position, which can
//  land on another entry numbered the same, or on an unnumbered one, and is then pushed again)
let returnBy: "key" | "go" = "key";
const navApi = (): any => (globalThis as any).navigation;
const entryId = () => Math.random().toString(36).slice(2, 12);
const noteShown = () => { const st = history.state; shownAt = st.sbTex; shownId = st.sbTexId; shownUrl = location.href; shownKey = navApi()?.currentEntry?.key; };
// (a popstate while a return is under way: that return's landing, or a newer Back or Forward that goes on in its place
//  (astra U8-SWITCH-6))
const landsHere = (st: any) => history.state?.sbTexId === shownId && location.href === shownUrl
  || returnBy === "go" && (typeof st?.sbTex !== "number" || st.sbTex === shownAt);
// (a return superseded by a newer Back or Forward: its traversal, if it lands after all, is taken back to the entry
//  shown instead of opening that file again. Known by the traversal itself, not by where it lands (astra U8-SWITCH-7:
//  a Back or Forward of the person's own to that same entry goes on as asked): each return by key carries a token in
//  its navigation's info, which the Navigation API's navigate event, fired before that traversal's popstate, hands
//  back; a superseded return's token is stale. A return by position needs none: its history.go was queued before the
//  Back or Forward that superseded it, so it has landed already. A traversal given up never lands: its token goes)
let retTok = 0, retPending = 0, staleTok = 0, staleLanding = false, fenceHooked = false;
// (the fence's own take-back (grader W8): it goes to the entry the stale traversal left, which is where the person
//  last went: the entry shown, or a decided switch's whose mount hasn't taken it yet (the stale return went to the
//  entry shown, so taking it back there would go nowhere, and no landing would ever come). Its landing is the fence's:
//  it ends the return and runs what waited for it, nothing pushed or noted; until then a mount waits before it takes
//  the entry the history is on for its own)
let fenceTok = 0, fenceLanding = false, staleFrom: string | undefined, staleFromUrl: string | undefined, fencing = false;
let fenceEnd = () => {}, fenceSettled: Promise<void> = Promise.resolve(), fenceWake: (() => void) | null = null;
// (what waits for a return, dropped: set with fenceWake by the mount listening for the landing)
let fenceOff: (() => void) | null = null;
// (a file opened in place, as the latest mount opens one: for the navigation owner below)
let openFile: ((fid: string) => void) | null = null;
// (back to the entry shown by its key, or to `key`, the traversal tagged: its token)
const traverseShown = (nav: any, failed: () => void, key = shownKey) => {
  const tok = ++retTok; retPending = tok;
  const gone = () => { if (staleTok === tok) staleTok = 0; if (retPending === tok) retPending = 0; };
  try { nav.traverseTo(key, { info: { sbTexReturn: tok } }).finished?.catch(() => { gone(); failed(); }); } catch { gone(); failed(); }
  return tok;
};
// (navigate comes before the traversal commits: the entry it leaves is still the current one)
const onNavigate = (e: any) => {
  if (e.navigationType !== "traverse") return;
  const tok = e.info?.sbTexReturn;
  staleLanding = !!staleTok && tok === staleTok;
  fenceLanding = !staleLanding && !!fenceTok && tok === fenceTok;
  if (staleLanding) { const c = navApi()?.currentEntry; staleFrom = c?.key; staleFromUrl = c?.url ?? undefined; }
};
const fenceDone = () => { fenceTok = 0; if (fencing) { fencing = false; fenceEnd(); } };
const fenceStale = (ev: PopStateEvent) => {
  if (fenceLanding) {
    fenceLanding = false;
    ev.stopImmediatePropagation();
    returning = false; fenceDone();
    const w = fenceWake; fenceWake = fenceOff = null; w?.();
    return;
  }
  if (!staleLanding) {
    // (the navigation owner, for the window past a switch's decision: no editor current, the next mount waiting on
    //  the close or a take-back, no return landing but the fence's. Every untagged Back or Forward there is the
    //  person's latest intent, taken here and by nothing else (astra R16-FENCE-2): a take-back under way given up
    //  (marked stale: landing after all, it is taken back to this entry; refused, it does nothing), what waited for a
    //  return dropped, the waiting mount superseded, and this entry's file opened, nothing asked)
    if (current !== null || returning && !fencing) return;
    ev.stopImmediatePropagation();
    if (fenceTok) staleTok = fenceTok;
    fenceTok = 0; retPending = 0; returning = false;
    const off = fenceOff; fenceWake = fenceOff = null; off?.();
    fenceDone(); intent();
    const t = new URLSearchParams(location.search).get("tex");
    if (t && openFile) openFile(t); else location.reload();
    return;
  }
  staleLanding = false; staleTok = 0;
  ev.stopImmediatePropagation();
  const nav = navApi(), to = staleFrom ?? shownKey, toUrl = staleFrom && staleFromUrl ? staleFromUrl : shownUrl; staleFrom = staleFromUrl = undefined;
  returning = true; returnBy = "key";
  if (!fencing) { fencing = true; fenceSettled = new Promise<void>((r) => (fenceEnd = r)); }
  // (the take-back impossible, or refused: the entry it went to pushed again, its URL: the entry shown, noted, or a
  //  decided switch's, which its mount takes once the fence is done (astra, r16); then what waited for the return runs)
  const fallback = () => {
    if (returning) {
      returning = false; history.pushState({ sbTex: shownAt + 1, sbTexId: entryId() }, "", toUrl);
      if (toUrl === shownUrl) noteShown();
      fenceDone(); const w = fenceWake; fenceWake = fenceOff = null; w?.();
    } else fenceDone();
  };
  // (a traversal to the current entry goes nowhere and never lands: never one)
  if (nav?.traverseTo && to && to !== nav.currentEntry?.key && nav.entries?.().some((x: any) => x.key === to)) {
    const tok = retTok + 1; fenceTok = tok;
    traverseShown(nav, () => { if (fenceTok === tok) fallback(); }, to);
  } else fallback();
};
// (asked only when a write has actually failed: William, Nov 2, U8: never otherwise; the edits are kept in this
// browser's drafts either way, and offered when the file is opened again)
const LEAVE = "Your last changes couldn't be saved. Leave this file anyway? They're kept in this browser and offered when you open it again.";
// (and when this browser couldn't keep them either: said as it is)
const LEAVE_LOST = "Your last changes couldn't be saved, and this browser couldn't keep a copy of them. Leave this file anyway? They will be lost.";

export async function mount(root: HTMLElement, host: Host): Promise<void> {
  mark("tex-mount", {});
  // (the editor shown is closed first: its pending edits written, or durable in its drafts, before this file is read)
  const my = ++mounts;
  // (the fence's listener: once, before any mount's own, so a stale landing it takes never reaches them)
  if (!fenceHooked) { fenceHooked = true; window.addEventListener("popstate", fenceStale); navApi()?.addEventListener?.("navigate", onNavigate); }
  const prev = current; current = null;
  closing = closing.then(() => prev?.close()).catch(() => {});
  await closing;
  // (a fence's take-back under way: the history isn't back where the person went yet (grader W8))
  while (fencing) await fenceSettled;
  if (my !== mounts) return;
  const life = new AbortController(), on = { signal: life.signal };
  const live = () => my === mounts && !life.signal.aborted;
  // (this mount's own entry in `current`: when `current` is another's, or none, a switch away from this file is under
  //  way, past its decision; a Back or Forward then is the navigation owner's (above))
  let mine: unknown = null;
  const st = history.state && typeof history.state === "object" ? history.state : {};
  if (typeof st.sbTex !== "number" || typeof st.sbTexId !== "string") history.replaceState({ ...st, sbTex: typeof st.sbTex === "number" ? st.sbTex : 0, sbTexId: entryId() }, "");
  noteShown();
  let dispose = () => { life.abort(); };
  current = { dispose: () => dispose(), close: async () => dispose(), dirty: () => false, settle: async () => true, hold: () => {} };
  mine = current;
  if (!document.getElementById("sb-tex-style")) { const style = el("style"); style.id = "sb-tex-style"; style.textContent = PAGE_CSS + PRINT_CSS + MENU_CSS; document.head.appendChild(style); }
  if (!document.getElementById("sb-katex")) {
    const link = document.createElement("link"); link.rel = "stylesheet"; link.href = new URL("katex/katex.min.css", location.href).href; document.head.appendChild(link);
  }
  root.textContent = "";
  const page = el("div", "tex-page"); root.appendChild(page);
  const banner = el("div", "tex-banner"); banner.setAttribute("role", "note");
  const bannerText = el("span"), bannerLink = el("a", "", "How it differs from LaTeX"), bannerX = el("button", "tex-banner-x", "×");
  bannerLink.href = DIFFERS; bannerLink.target = "_blank"; bannerLink.rel = "noopener";
  bannerX.title = "Dismiss this notice"; bannerX.setAttribute("aria-label", bannerX.title);
  banner.append(bannerText, " ", bannerLink, bannerX);
  const setBanner = (why?: string) => { bannerText.textContent = why ? NO_SAVE(why) : BANNER; bannerLink.hidden = bannerX.hidden = !!why; banner.hidden = !why && pref(BANNER_OFF, 0, 1, 0) > 0; };
  bannerX.onclick = () => { banner.hidden = true; keep(BANNER_OFF, 1); };
  const head = el("div", "tex-head");
  // Files: the notebook page's own Files button (index.html's #wsfilesbtn) clicked, so the files show and hide beside
  // this page as they do beside a notebook, the document staying open; pressed while they are shown (body.wsfiles)
  const back = el("button", "tex-back", "Files"); back.setAttribute("aria-controls", "wssidebar");
  back.onclick = () => { const b = document.getElementById("wsfilesbtn"); if (b) b.click(); else host.back(); };
  const pressed = () => back.setAttribute("aria-pressed", String(document.body.classList.contains("wsfiles")));
  const pressedObs = new MutationObserver(pressed); pressedObs.observe(document.body, { attributes: true, attributeFilter: ["class"] }); pressed();
  life.signal.addEventListener("abort", () => pressedObs.disconnect());
  const title = el("span", "tex-title");
  // (the save state, as Google Docs shows it: Saving…, Saved ✓; a failed write stays shown, with its reason)
  const saveState = el("span", "tex-savestate"); saveState.setAttribute("role", "status"); saveState.setAttribute("aria-live", "polite");
  const toggle = el("button", "tex-toggle", "Preview");
  const status = el("span", "tex-status"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  // the source's font size and the preview's zoom, each remembered in this browser
  const tools = el("span", "tex-tools");
  const btn = (text: string, label: string) => { const b = el("button", "", text); b.title = label; b.setAttribute("aria-label", label); return b; };
  const fsDown = btn("A−", "Smaller source text"), fsUp = btn("A+", "Larger source text");
  const zOut = btn("−", "Zoom the preview out"), zIn = btn("+", "Zoom the preview in"), zShow = el("span", "tex-zoomv");
  // keeping the two sides in sync: Follow (the preview follows the cursor; remembered, on by default) and Show (the
  // cursor's place in the preview now); a double-click in the preview puts the cursor at that place in the source
  const followBtn = btn("Follow", "The preview follows the cursor"), showBtn = btn("Show", "Show the cursor's place in the preview");
  tools.append(el("span", "tex-tl", "Source"), fsDown, fsUp, el("span", "tex-tl", "Preview"), zOut, zShow, zIn, followBtn, showBtn);
  // File: the one File menu of every editor (New in the file panel's order, Open…, Recent, Print or save as PDF…: U0),
  // drawn by the page that mounted this one (host.fileMenu), under its button
  const fileBtn = el("button", "tex-filebtn", "File ▾"); fileBtn.setAttribute("aria-haspopup", "menu"); fileBtn.setAttribute("aria-expanded", "false");
  const fileMenu = el("div", "tex-filemenu"); fileMenu.setAttribute("role", "menu"); fileMenu.setAttribute("aria-label", "File"); fileMenu.hidden = true;
  fileMenu.style.cssText = "position:fixed;z-index:30;background:#fff;color:#222;border:1px solid #c8ccc9;border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,.2);padding:4px;min-width:200px;max-height:calc(100dvh - 60px);overflow:auto";
  const showFile = (on: boolean) => {
    fileMenu.hidden = !on; fileBtn.setAttribute("aria-expanded", String(on));
    if (on) { const r = fileBtn.getBoundingClientRect(); fileMenu.style.left = Math.max(4, Math.min(r.left, innerWidth - 210)) + "px"; fileMenu.style.top = r.bottom + 2 + "px"; }
  };
  const fileKey = host.fileMenu?.(fileMenu, { print: () => printPreview(), close: () => showFile(false) });
  fileBtn.disabled = !host.fileMenu;
  fileBtn.onclick = (ev) => { ev.stopPropagation(); showFile(fileMenu.hidden); };
  document.addEventListener("click", (ev) => { if (!fileMenu.hidden && !fileMenu.contains(ev.target as Node)) showFile(false); }, on);
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && !fileMenu.hidden) showFile(false); else fileKey?.(ev); }, on);
  // Comments (comments-doc.ts, in the comments' chunk: fetched when this file has a comments file, or on first use)
  const cmBtn = el("button", "tex-comments", "Comments");
  // Agent: an agent on this computer (Claude Code, Codex, … with sagebrush-mcp) connected to this page, to read and
  // answer the comments and edit the .tex, under the person's grant
  const agentBtn = el("button", "tex-agent", "Agent"); agentBtn.title = "Connect an agent on this computer (Claude Code, Codex, …) to files you choose";
  const agentFailed = () => { status.textContent = "Couldn't load the agent connection. Check the network, then click Agent to try again."; };
  agentBtn.onclick = () => void pairAgent(host.ws).then((p) => p.connect(), agentFailed);
  // Present (present.ts, a chunk of its own, /sagebrush-latex-present.js): a beamer document's slides full screen,
  // step by step through their overlays; shown once the preview has slides
  const presentBtn = el("button", "tex-present-btn", "Present"); presentBtn.title = "Present the slides full screen (arrow keys; Shift+Enter runs the code; Escape stops)"; presentBtn.hidden = true;
  // (Print / Save as PDF, William Nov 2: "an easy PDF download, so a person can print out something or archive it": File ▸
  // Print or save as PDF…, as in the notebook and board; the browser prints the rendered preview only, PRINT_CSS)
  // Run (run-core.mjs): the document's SageTeX code, in page order, in Sage; shown once the preview has SageTeX items
  const runBtn = el("button", "tex-run", "Run"); runBtn.title = "Run the document's SageTeX code (Sage, in this browser): Shift+Enter"; runBtn.hidden = true;
  head.append(back, fileBtn, title, saveState, toggle, runBtn, cmBtn, agentBtn, presentBtn, status, tools);
  page.appendChild(fileMenu);
  // (a ?pair= link, or an agent this browser remembers: the pairing module mounted now, to connect or reconnect)
  // (the link taken by the hosting page before this loaded: pair-link.ts's key; or still in the URL)
  if ((globalThis as any)[Symbol.for("sagebrush.pairLink")] || new URLSearchParams(location.search).has("pair")) void pairAgent(host.ws).catch(agentFailed);
  else void host.ws.agentGrants().then((k) => { if (Object.keys(k ?? {}).length) void pairAgent(host.ws).catch(agentFailed); }, () => {});
  const main = el("div", "tex-main");
  const left = el("div", "tex-left"), right = el("div", "tex-right");
  const preview = el("div", "page tex-preview");
  right.appendChild(preview);
  main.append(left, right);
  // (the source's and the preview's widths: the edge between them, remembered on this device: workspace/resize.ts's
  // texSplit, which the notebook page hosting this editor provides (index.html), so it isn't in the LaTeX bundles)
  (globalThis as { __sbTexSplit?: (main: HTMLElement, left: HTMLElement, signal: AbortSignal) => void }).__sbTexSplit?.(main, left, life.signal);
  // (the bar for a change made elsewhere while this text had unsaved edits: one at a time, below)
  const bar = el("div", "tex-conflict"); bar.hidden = true; bar.setAttribute("role", "alert");
  const barText = el("span", "tex-conflict-t");
  const useTheirs = el("button", "tex-theirs", "Use theirs (keep mine as a copy)"), keepMine = el("button", "tex-mine", "Keep mine (theirs stays in TimeTravel)");
  bar.append(barText, useTheirs, keepMine);
  page.append(head, banner, bar, main);
  const say = (t: string) => { status.textContent = t; };
  const pref = (k: string, lo: number, hi: number, d: number) => { let v = d; try { v = Number(localStorage.getItem(k) ?? d); } catch {} return Number.isInteger(v) && v >= lo && v <= hi ? v : d; };
  const keep = (k: string, v: number) => { try { localStorage.setItem(k, String(v)); } catch {} };
  setBanner();
  let fontPx = pref(FONT.key, FONT.min, FONT.max, FONT.def), zoomPct = pref(ZOOM.key, ZOOM.min, ZOOM.max, ZOOM.def);
  const applyView = () => {
    page.style.setProperty("--tex-src-fs", fontPx + "px");
    // (at 100% no zoom is set at all: the default view is the preview as it was)
    if (zoomPct === ZOOM.def) preview.style.removeProperty("zoom"); else preview.style.setProperty("zoom", String(zoomPct / 100));
    zShow.textContent = zoomPct + "%";
    fsDown.disabled = fontPx <= FONT.min; fsUp.disabled = fontPx >= FONT.max; zOut.disabled = zoomPct <= ZOOM.min; zIn.disabled = zoomPct >= ZOOM.max;
  };
  const font = (d: number) => { fontPx = Math.min(FONT.max, Math.max(FONT.min, fontPx + d)); keep(FONT.key, fontPx); applyView(); };
  const zoom = (d: number) => { zoomPct = Math.min(ZOOM.max, Math.max(ZOOM.min, zoomPct + d)); keep(ZOOM.key, zoomPct); applyView(); };
  fsDown.onclick = () => font(-1); fsUp.onclick = () => font(1); zOut.onclick = () => zoom(-ZOOM.step); zIn.onclick = () => zoom(ZOOM.step);
  applyView();

  // ---- a notebook opened while this page is up (from the files beside it, a row's menu, Open as a notebook, an
  // upload): the notebook page's openId() asks here first (index.html, in a LaTeX build only) and its page is opened
  // by URL instead, as a board's is; without this it would be loaded unseen under the editor
  (globalThis as any).__sbTexOpen = (id: string) => { location.assign("/?nb=" + encodeURIComponent(id)); return true; };
  // another .tex (from the files beside this page, New, an example): opened here, in place, its URL pushed; a new tab
  // as before (boot.ts's hook); unsaved changes asked about first
  const g: any = globalThis, bootHook = (g.__sbTexBoot ??= g.__sbTex);
  const openHere = (fid: string) => { void mount(root, { ...host, fid }); };
  openFile = openHere;
  g.__sbTex = (e: Entry, tab?: boolean) => {
    if (tab || !/\.tex$/i.test(e.path) || !e.fid) return bootHook(e, tab);
    // (the file shown, asked for again: a newer intent, so a switch still settling does nothing; and if Back or
    //  Forward had already moved the history away from it, it is taken back to the entry shown (daybreak3
    //  DB3-U8-SWITCH-3), so the URL is this file's)
    if (e.fid === host.fid) {
      intent();
      // (a switch past its decision: its mount superseded now; this file opened again only once the history is back
      //  on its entry (DB3-U8-SWITCH-4): a mount started while the URL is still the other file's would take that
      //  for its own)
      if (current !== mine) { mounts++; returnToShown(() => openHere(host.fid)); } else returnToShown();
      return true;
    }
    // (its entry after the one the history is on: numbered by position, so a return by history.go finds it)
    const go = () => {
      const q = new URLSearchParams(location.search); q.set("tex", e.fid!);
      const at = typeof history.state?.sbTex === "number" ? history.state.sbTex : shownAt;
      history.pushState({ sbTex: at + 1, sbTexId: entryId() }, "", "/?" + q.toString());
      openHere(e.fid!);
    };
    // (a switch past its decision, its mount waiting on this editor's close: nothing of this mount is left to settle,
    //  so the newest file asked for goes on, the waiting mount superseded, and a return still under way waits for it
    //  instead of the stale one (astra U8-SWITCH-5): the file opened is the last one asked for)
    if (current !== mine) { intent(); mounts++; whenBack(go); return true; }
    void leaveOk().then((ok) => {
      if (!ok || !live()) return;
      whenBack(go);
    });
    return true;
  };
  // Back and Forward among those entries: the same question first; declined, the history is taken back to the entry
  // shown and the editor, its text unsaved, stays as it is
  // (the shown entry again, as a new one after this: when going back to it isn't possible or didn't land on it)
  const pushShown = () => { history.pushState({ sbTex: shownAt + 1, sbTexId: entryId() }, "", shownUrl); noteShown(); };
  const isShown = () => history.state?.sbTexId === shownId && location.href === shownUrl;
  // (what waits for a return to the entry shown to land: one at a time, the newest)
  let afterReturn: (() => void) | null = null, landOff: (() => void) | null = null;
  const landed = () => { landOff?.(); landOff = null; const f = afterReturn; afterReturn = null; f?.(); };
  // (back to the entry shown, wherever the history is now: by the Navigation API's key where there is one, else by
  //  its position; as a new entry when neither lands on it)
  // `then`: run once the history is on that entry: at once if it is already, else when the return's popstate lands (or
  // its fallback has pushed the entry again)
  // (a listener of its own for the landing, not this editor's: a fast close can dispose of this editor, and its
  //  listeners, before the history lands; whichever sees the landing first runs what waits, once)
  // (a newer Back or Forward than the return under way: the return given up, what waited for it dropped, and its
  //  traversal, if it went by key, marked stale (astra U8-SWITCH-6, -7))
  const supersede = () => { if (returnBy === "key" && retPending) staleTok = retPending; retPending = 0; returning = false; landOff?.(); landOff = null; afterReturn = null; intent(); };
  const listenLand = () => {
    landOff?.();
    const onLand = (ev: PopStateEvent) => {
      // (no editor of this mount left to take it (a fast close): the newer entry's file opened here)
      if (returning && !landsHere(ev.state)) { supersede(); const t = new URLSearchParams(location.search).get("tex"); if (t) openHere(t); else location.reload(); return; }
      if (returning) { returning = false; if (!isShown()) pushShown(); else noteShown(); }
      landed();
    };
    // (or the fence's own take-back landing, which the fence takes: it wakes this instead)
    const wake = () => landed(), drop = () => { landOff?.(); landOff = null; afterReturn = null; };
    window.addEventListener("popstate", onLand, { once: true }); fenceWake = wake; fenceOff = drop;
    landOff = () => { window.removeEventListener("popstate", onLand); if (fenceWake === wake) fenceWake = fenceOff = null; };
  };
  // (`go` once the history is back on the entry shown: at once when no return is under way, else when it lands, in
  //  place of whatever waited for it: a newer intent replaces an older one (astra U8-SWITCH-5))
  const whenBack = (go: () => void) => { if (!returning) { go(); return; } afterReturn = go; listenLand(); };
  const returnToShown = (then?: () => void) => {
    // (a fence's take-back under way: this return goes once it has landed, from where it lands)
    if (fencing && returning) { whenBack(() => returnToShown(then)); return; }
    // (whatever waited for an earlier return is stale now: this is the newest intent)
    if (isShown()) { landOff?.(); landOff = null; afterReturn = null; then?.(); return; }
    afterReturn = then ?? null;
    if (then) listenLand();
    const nav = navApi(), st = history.state, to = typeof st?.sbTex === "number" ? st.sbTex : null;
    if (nav?.traverseTo && shownKey && nav.entries?.().some((x: any) => x.key === shownKey)) {
      returning = true; returnBy = "key";
      const failed = () => { if (returning) { returning = false; pushShown(); landed(); } };
      traverseShown(nav, failed);
    } else if (to !== null && to !== shownAt) { returning = true; returnBy = "go"; history.go(shownAt - to); }
    else { pushShown(); landed(); }
  };
  window.addEventListener("popstate", (ev) => {
    const t = new URLSearchParams(location.search).get("tex");
    const st = ev.state && typeof ev.state === "object" ? ev.state : null;
    // (a return under way: its landing; or a newer Back or Forward, which goes on below in its place)
    if (returning) {
      if (landsHere(st)) { returning = false; if (!isShown()) pushShown(); else noteShown(); landed(); return; }
      supersede();
    }
    if (t === host.fid) {
      // (back to the file shown: a newer intent than a switch still settling, which then does nothing)
      intent();
      // (this file's own entries: a fragment's new entry, unnumbered, is the one after the shown one)
      if (typeof st?.sbTex !== "number" || typeof st?.sbTexId !== "string") history.replaceState({ ...(st ?? {}), sbTex: shownAt + 1, sbTexId: entryId() }, "");
      noteShown();
      return;
    }
    void leaveOk().then((ok) => {
    if (ok === null || !live()) return;
    if (!ok) {
      const nav = navApi(), to = typeof st?.sbTex === "number" ? st.sbTex : null;
      if (nav?.traverseTo && shownKey && nav.entries?.().some((e: any) => e.key === shownKey)) {
        returning = true; returnBy = "key";
        // (traverseTo's own failure: the entry pushed again, if the return didn't happen)
        const failed = () => { if (returning) { returning = false; pushShown(); } };
        traverseShown(nav, failed);
      } else if (to !== null && to !== shownAt) { returning = true; returnBy = "go"; history.go(shownAt - to); }
      else pushShown();
      return;
    }
    if (t) openHere(t); else { current?.dispose(); location.reload(); }
    });
  }, on);
  const gone = (t: string) => { main.textContent = ""; const m = el("div", "tex-gone", t); main.appendChild(m); saveState.hidden = true; toggle.hidden = true; tools.hidden = true; };

  // ---- binding and reading (r5 §1a, §4)
  const where = await host.ws.pathOfFile(host.fid);
  if (!live()) return;
  if (!where.ok) { gone(where.why === "trashed" ? "This file isn't here any more (it's in the Trash)." : "This file isn't here any more."); return; }
  const e0: Entry = where.entry;
  title.textContent = nameOf(where.path); title.title = where.path;
  document.title = nameOf(where.path) + " — Sagebrush";
  if ((e0.size ?? 0) > EDIT_MAX) {
    gone("This file is too large for the LaTeX editor (over 4 MiB): download it from the file's preview.");
    return;
  }
  let read: { entry: Entry; content: Uint8Array };
  try {
    // (the test build only: the page test can hold this read, to replace the mount while it waits; elsewhere this folds away)
    if (typeof __SB_LATEX_TEST__ !== "undefined" && __SB_LATEX_TEST__) await (globalThis as any).__sbTexMountRead?.(where.path);
    read = await host.ws.readUpTo(where.path, EDIT_MAX);
  } catch (err) { if (!live()) return; gone("This file can't be read here: " + String((err as Error)?.message ?? err)); return; }
  if (!live()) return;
  if (read.entry.fid !== host.fid) { gone("This file isn't here any more."); return; }
  mark("tex-read-done", { bytes: read.content.length });
  const opened = openBytes(read.content);
  if (opened.kind === "binary") { gone("This file can't be opened in the LaTeX editor: " + opened.why + "."); setBanner(opened.why); return; }
  // (the whole file only: the bytes read are the file's size, else no Save)
  let saveable: boolean = opened.saveable && read.content.length === (read.entry.size ?? -1) && !e0.remote;
  let whyNot = !opened.saveable ? opened.why : e0.remote ? "it is in the cloud; open it on the device that made it" : read.content.length !== (read.entry.size ?? -1) ? "the whole file couldn't be read" : "";
  if (!saveable) { setBanner(whyNot); saveState.textContent = "Read-only"; saveState.title = whyNot; }
  let eol = opened.eol;
  let savedText = opened.text;
  // (the revision savedText was read or saved as, the Save's base; and the person's edits, counted: an await that
  //  saw the text clean knows whether it still is)
  let docRev = read.entry.rev ?? 0, edits = 0;
  // (saving as you type, below; none for a file that can't be saved here)
  let saver: AutoSaver | null = null;

  // ---- the editor and its preview (editor.ts); the images, the saving and the controls are this page's
  const images: Record<string, string | { why: string }> = {};
  const blobs = new Set<string>();
  let imageBytes = 0;
  // (the code's results, paper.tex.results.json beside it: `sagebrush latex run`'s; read when the page opens, when
  //  the window comes back into focus, and before an agent's tool call; bounded, and checked by the worker and renderer)
  const results: { wrapper: string | null; saved: unknown[] } = { wrapper: null, saved: [] };
  let resultsSeen: unknown = undefined;
  // (the files the results' run imported from the .tex's folder (their `deps`, Codex W01): their state is part of what
  //  was seen, so an edited helper is noticed at the next read, and the results it made aren't used (run-core.mjs
  //  checkedResults); a check during which anything changed counts as nothing seen, and is made again shortly)
  let resultsDeps: [string, string][] = [], recheck = 0;
  const texDir = () => where.path.slice(0, where.path.lastIndexOf("/")) || "/";
  const loadResults = async () => {
    try {
      const p = where.path + ".results.json", e = await host.ws.stat(p).catch(() => undefined);
      // (no results file: "none", seen as such until one comes)
      const seen = e && !e.trashed ? await seenOf(host.ws, e, texDir(), resultsDeps) : "none";
      if (!live()) return;
      if (seen === resultsSeen) return;
      let next: typeof results = { wrapper: null, saved: [] }, checked: { deps: [string, string][]; stale: string | null; seen: string | null } = { deps: [], stale: null, seen };
      if (e && !e.trashed && (e.size ?? 0) <= RESULTS_MAX) {
        const j = JSON.parse(new TextDecoder().decode((await host.ws.readUpTo(p, RESULTS_MAX)).content));
        if (j && j.format === "sagebrush-latex-results" && j.version === 1 && typeof j.wrapper === "string" && Array.isArray(j.items)) {
          const c = await checkedResults(host.ws, p, e, j, texDir());
          next = { wrapper: j.wrapper, saved: c.saved };
          checked = c;
        }
      }
      if (!live()) return;
      // (the file counted as seen only once it was read and parsed, and checked with nothing changing meanwhile: one
      //  that failed or was malformed is read again at the next chance, astra's #519 advisory)
      resultsDeps = checked.deps;
      resultsSeen = checked.seen ?? undefined;
      results.wrapper = next.wrapper; results.saved = next.saved;
      if (checked.stale) say(`The SageTeX results aren't used: ${staleWhy(checked.stale)}; press Run`);
      request();
      if (checked.seen === null && e && recheck++ < 3) setTimeout(() => void loadResults(), 1000);
      else if (checked.seen !== null) recheck = 0;
    } catch {}
  };
  // ---- \input and \include (William's L4, Nov 2; inputs.ts): the files the document asks for, found as TeX finds them
  // (from this file's folder, ../, a leading "/" for the top), read by identity as images are, bounded, given to the
  // engine; one reader at a time; a change to any of them (another tab, Python, an agent) reads it again
  const inputs = { docPath: where.path, known: new Map<string, Known>(), version: 0 };
  let inputBytes = 0, readingInputs = false;
  const inputsWanted = new Set<string>();
  const readInputs = async (refs: string[], tok: Token) => {
    for (const p of engineInputs(where.path, inputs.known).wanted(refs)) inputsWanted.add(p);
    if (readingInputs || !inputsWanted.size) return;
    readingInputs = true;
    let changed = false;
    try {
      for (const p of inputsWanted) {
        inputsWanted.delete(p);
        if (inputs.known.has(p) || inputs.known.size >= 1024) continue;
        const e = await host.ws.stat(p).catch(() => undefined);
        if (!alive(tok)) { inputsWanted.clear(); return; }
        let k: Known;
        if (!e || e.kind !== "file" || e.trashed) k = { absent: true };
        else if (e.remote) k = { why: "it is in the cloud; open it on the device that made it" };
        else {
          let r: { entry: Entry; content: Uint8Array } | null = null;
          try { r = await host.ws.readUpTo(p, EDIT_MAX + 1); } catch {}
          const now = await host.ws.stat(p).catch(() => undefined);
          if (!alive(tok)) { inputsWanted.clear(); return; }
          if (!r) k = { why: "not readable" };
          else if (!now || now.fid !== e.fid || r.entry.fid !== e.fid || now.updated !== e.updated) k = { why: "changed while it was read" };
          else {
            const count = [...inputs.known.values()].filter((x) => "text" in x).length;
            k = admitInput(r.content, inputBytes, count);
            if ("text" in k) inputBytes += r.content.length;
          }
        }
        inputs.known.set(p, k); changed = true;
      }
    } finally { readingInputs = false; }
    if (changed && alive(tok)) { inputs.version++; request(); }
  };
  // (a file the document read, or looked for, changed: forgotten, so the next render asks for it and it is read again)
  const unwatchInputs = host.ws.watch((c) => {
    let again = false;
    for (const op of c.ops ?? []) for (const q of [op.path, op.to]) if (q && inputs.known.has(q)) {
      const k = inputs.known.get(q)!; if ("text" in k) inputBytes -= new TextEncoder().encode(k.text).length;
      inputs.known.delete(q); again = true;
    }
    if (again) { inputs.version++; request(); }
  });
  life.signal.addEventListener("abort", () => unwatchInputs());
  const E = createEditor({
    left, right, preview, text: opened.text, large: read.content.length > 2 ** 20, say, images, sage: results,
    workerUrl: new URL("sagebrush-latex-worker.js", location.href),
    onImageRefs: (refs, tok) => void resolveImages(refs, tok),
    inputs, onInputRefs: (refs, tok) => void readInputs(refs, tok),
    // (an edit: its draft durable now, its write scheduled (autosave.ts); the last message is stale)
    onEdit: () => { edits++; saver?.edited(); if (!saving) say(""); },
  });
  const { src, gate, request } = E;
  // ---- the name at the top (William's M0, Nov 3): it follows this file renamed or moved elsewhere (the file panel,
  // another tab), read again by its identity on any change; and a click on it renames the file there, as a notebook's
  // title does: a true rename of the .tex, with its results and comments files beside it moved along
  // (the rename is offered only for a file that can be saved here: elsewhere the name is plain text, no control)
  const showName = (p: string) => { title.textContent = nameOf(p); title.title = saveable ? p + ": click to rename" : p; document.title = nameOf(p) + " — Sagebrush"; };
  let renamingTitle = false, nameCheck: any = null;
  // (the name the file has now, found again by its identity; not while the name is being edited)
  const refreshName = () => host.ws.pathOfFile(host.fid).then((at) => { if (live() && at.ok && !renamingTitle) showName(at.path); }, () => {});
  const unwatchName = host.ws.watch(() => { clearTimeout(nameCheck); nameCheck = setTimeout(() => void refreshName(), 50); });
  life.signal.addEventListener("abort", () => { unwatchName(); clearTimeout(nameCheck); });
  if (saveable) { title.classList.add("renamable"); title.tabIndex = 0; title.setAttribute("role", "button"); title.setAttribute("aria-label", "Rename this file"); }
  showName(where.path);
  const renameTitle = async () => {
    if (renamingTitle || !saveable) return;
    const at = await host.ws.pathOfFile(host.fid);
    if (!live() || !at.ok) return;
    renamingTitle = true;
    const input = el("input", "tex-titlein"); input.value = nameOf(at.path); input.setAttribute("aria-label", "The file's new name");
    title.replaceWith(input); input.focus(); input.setSelectionRange(0, input.value.replace(/\.tex$/i, "").length);
    let done = false;
    // (every end but a rename done: the name the file has now, found again, since it may have been renamed elsewhere
    //  while the field was open, daybreak3's M0-SEM-1)
    const finish = async (keep: boolean) => {
      if (done) return; done = true;
      let renamed = false;
      try { renamed = await commit(keep); } finally { if (!renamed) void refreshName(); }
    };
    const commit = async (keep: boolean): Promise<boolean> => {
      const v = input.value.trim();
      input.replaceWith(title); renamingTitle = false;
      if (!keep || !v) return false;
      const name = safeName(/\.tex$/i.test(v) ? v : v + ".tex");
      const now = await host.ws.pathOfFile(host.fid);
      if (!live()) return false;
      if (!now.ok) { say("Not renamed: this file isn't here any more"); return false; }
      const to = join(parentOf(now.path), name);
      if (to === now.path) return false;
      try {
        // (its results and comments files, as they are BEFORE the rename (astra LATEX-RENAME-1): once the .tex has moved,
        //  its old name is free, and another document's files made there meanwhile must never be taken along)
        const companions: { ext: string; e: Entry }[] = [];
        for (const ext of [".results.json", ".comments.json"]) {
          const se = await host.ws.stat(now.path + ext).catch(() => undefined);
          if (se && !se.trashed && se.kind === "file") companions.push({ ext, e: se });
        }
        const e = await host.ws.rename(now.path, to, { expect: { kind: now.entry.kind, ref: now.entry.ref, fid: now.entry.fid, created: now.entry.created } });
        // (the test build only: the page test can make files at the freed name here; elsewhere this folds away)
        if (typeof __SB_LATEX_TEST__ !== "undefined" && __SB_LATEX_TEST__) await (globalThis as any).__sbTexRenamed?.(now.path, e.path);
        // (each moved along only if it is still the very entry found before (its identity checked holding the lock) and
        //  the new name is free; one that can't be is left where it was, said)
        let left = 0;
        for (const { ext, e: se } of companions) {
          if (await host.ws.stat(e.path + ext).catch(() => undefined)) { left++; continue; }
          try { await host.ws.rename(se.path, e.path + ext, { expect: { kind: se.kind, ref: se.ref, fid: se.fid, created: se.created } }); } catch { left++; }
        }
        if (!live()) return true;
        where.path = e.path; inputs.docPath = e.path; inputs.version++;
        showName(e.path); request();
        say(left ? `Renamed; ${left} file${left === 1 ? "" : "s"} beside it kept ${left === 1 ? "its" : "their"} old name` : "Renamed");
        return true;
      } catch (err: any) {
        say(err?.code === "exists" ? `Not renamed: there is already a "${name}" here` : err?.code === "conflict" ? "Not renamed: this file was moved or replaced meanwhile" : "Not renamed: " + String(err?.message ?? err).slice(0, 200));
        return false;
      }
    };
    input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); void finish(true); } else if (ev.key === "Escape") { ev.preventDefault(); void finish(false); } });
    input.addEventListener("blur", () => void finish(true));
  };
  if (saveable) {
    title.addEventListener("click", () => void renameTitle());
    title.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); void renameTitle(); } });
  }
  // (an agent in the browser checks and sees this document: latex_check, latex_render, agent-tools.ts)
  void loadResults();
  window.addEventListener("focus", () => void loadResults(), on);
  const slidesNow = () => Array.from(preview.querySelectorAll(":scope > .ch:not([hidden]) section.slide")) as HTMLElement[];
  // (the slide to start at: the first one whose bottom is in the preview's view)
  const frameInView = () => { const top = right.getBoundingClientRect().top; const k = slidesNow().findIndex((s) => s.getBoundingClientRect().bottom > top + 8); return k < 0 ? 1 : k + 1; };
  let presenting: { stop(): void; at(): { frame: number; step: number }; go(frame: number, step?: number): void } | null = null;
  presentBtn.onclick = () => void loadPresent().then((m) => {
    if (!live() || presenting) return;
    presenting = m.present({ slides: slidesNow, onRendered: E.onRendered, onRun: () => { runKey(false); }, onShow: (st: HTMLElement) => { if (st.querySelector(".sageinteract")) void loadInteract().then((m) => { if (live()) m.live(st, sageSession as any, liveFid === host.fid ? liveIds : new Set()); }, () => {}); }, start: frameInView(), onExit: () => { presenting = null; presentBtn.focus(); } });
  }, () => say("Couldn't load the presenter. Check the network, then click Present to try again."));
  E.onRendered(() => { presentBtn.hidden = slidesNow().length === 0; });
  // (the preview's interacts, drawn after each render that has one not drawn yet; the slide being presented shown again,
  //  so its copy has them)
  E.onRendered(() => {
    if (!preview.querySelector(".sageinteract-at")) return;
    void loadInteract().then((m) => { if (live() && m.draw(preview, sageSession as any, liveFid === host.fid ? liveIds : new Set()) && presenting) { const a = presenting.at(); presenting.go(a.frame, a.step); } }, () => {});
  });
  life.signal.addEventListener("abort", () => { presenting?.stop(); liveIds.over = 1; liveIds = new Set(); });

  // ---- Run (run-core.mjs): the SageTeX items of the text in the editor now (the preview's own list of them, so only
  // once it has caught up), run in page order in this page's Sage session, on the person's click only (never on
  // open); their states written as the results file beside the .tex, then read and shown as the CLI's are. A second
  // click while it runs stops it.
  let running = false;
  // (the Run under way's own Stop: a second click stops that Run, and only it (astra's LATEX-QUEUE-STOP-1): waiting for
  //  another Run in the session, it runs nothing; running, its script is interrupted)
  let runStop: AbortController | null = null;
  // (with any PythonTeX item: "code item", and the Run button says it runs PythonTeX's too: board's rule)
  // (0: no PythonTeX item, 1: some, 2: only PythonTeX ones)
  const pyIn = () => { const l = E.lastCheck()?.sage ?? [], n = l.filter((x: any) => /^py/.test(x.mode)).length; return n && (n < l.length ? 1 : 2); };
  const what = () => (pyIn() ? "code item" : "SageTeX item");
  const runTitle = () => "Run the document's " + ["SageTeX code (Sage", "SageTeX and PythonTeX code (Sage and Python", "PythonTeX code (Python"][pyIn()] + ", in this browser): Shift+Enter";
  E.onRendered(() => { const c = E.lastCheck(); if (c) runBtn.hidden = !(Array.isArray(c.sage) && c.sage.length); if (!running) runBtn.title = runTitle(); });
  const runIdle = () => { running = false; runBtn.textContent = "Run"; runBtn.title = runTitle(); };
  runBtn.onclick = async () => {
    if (running) { runStop?.abort(); say("stopping…"); return; }
    let rc: typeof import("./run-core.mjs");
    try { rc = await loadRun(); } catch { say("Not run: Run's code couldn't be loaded; press Run again"); return; }
    // (the test build only: the page test holds Run's code loading here; elsewhere this folds away)
    if (typeof __SB_LATEX_TEST__ !== "undefined" && __SB_LATEX_TEST__) await (globalThis as any).__sbTexRunLoaded?.();
    // (the page replaced or closed while Run's code loaded: this Run never starts, so nothing of the old document's
    //  folder is listed or read (daybreak3, #824))
    if (!live() || running) return;
    if (!host.sandbox) { say(rc.NO_SANDBOX); return; }
    const session = (sageSession ??= rc.sessionOf(rc.sandboxEngine(host.sandbox, new URL(".", import.meta.url))));
    const c = E.lastCheck();
    if (!c) { say("the preview is behind the source: try again when it has caught up"); return; }
    const items = (Array.isArray(c.sage) ? c.sage : []) as any[];
    if (!items.length) { say("No SageTeX or PythonTeX code to run"); return; }
    running = true; runBtn.textContent = "Starting Sage…"; runBtn.title = "Stop"; say("");
    const my = ++runGen, run = new AbortController(), stop = () => run.abort(), stopRun = new AbortController();
    // (the last Run's widgets end here, before this one takes the session's turn (astra, daybreak3, #937))
    liveIds.over = 1;
    runStop = stopRun;
    life.signal.addEventListener("abort", stop, { once: true });
    const current = () => live() && my === runGen;
    try {
      const r = await rc.runAndSave({
        items, ws: host.ws, fid: host.fid, current, signal: run.signal, max: RESULTS_MAX, now: () => performance.now(),
        session: async () => { const k = await session(); if (current()) runBtn.textContent = "Running…"; return k; },
        exec: rc.runIn,
        // (the .tex's folder, as it is now, given to the session: its code imports a helper beside the .tex and reads
        //  its data, read-only, as real SageTeX run in the document's folder does; nothing else of the workspace)
        folder: async (codes: string[]) => { const at = await host.ws.pathOfFile(host.fid); return at.ok ? rc.folderFiles(host.ws, at.path, codes) : { msg: "Not run: this file isn't here any more" }; },
        store: session, serial: session.serial, stop: stopRun.signal, interacts: loadInteract,
      });
      if (r.stale || !current()) return;
      if (r.msg) { say(r.msg); return; }
      liveIds = r.interactIds; liveFid = host.fid;
      if (typeof __SB_LATEX_TEST__ !== "undefined" && __SB_LATEX_TEST__) await (globalThis as any).__sbTexResultsHold?.();
      await loadResults();
      const bad = r.states.filter((x: any) => x.s !== "ok").length;
      const cloud = r.remote ? `; ${r.remote} file${r.remote === 1 ? " the code names is" : "s the code names are"} only in the cloud, not given to Sage` : "";
      say(`Ran ${items.length} ${what()}${items.length === 1 ? "" : "s"} in ${(r.ms / 1000).toFixed(1)} s` + (bad ? `; ${bad} failed` : "") + cloud);
    } catch (err) {
      if (current()) say(String((err as Error)?.message ?? err).slice(0, 200));
    } finally { life.signal.removeEventListener("abort", stop); if (live()) runIdle(); else running = false; }
  };
  // Shift+Enter runs, as Run does (William, Nov 3: "make 'shift+enter' run the code"), in the source and in Present. A
  // Run under way is left alone (the button's second click is its Stop, never the key's). Whether the document has
  // SageTeX code is the text's now, never the last render's (daybreak3, #874): the preview caught up, its items decide
  // (none: the source's Shift+Enter is a newline, as before); behind (an edit just made), the key waits for this text's
  // render, then runs, or, with no code, puts the newline where it was asked for. Only for the text it was pressed on:
  // the text changed before that render, the key does nothing (astra, #874: never a Run of code typed after it)
  const hasCode = (c: any) => Array.isArray(c?.sage) && c.sage.length > 0;
  const runKey = (fromSource: boolean): boolean => {
    if (running) return true;
    const c = E.lastCheck();
    if (c) { if (!hasCode(c)) return false; runBtn.click(); return true; }
    const text = src.value, a = src.selectionStart, b = src.selectionEnd;
    const off = E.onRendered(() => {
      if (src.value !== text) { off(); return; }
      const now = E.lastCheck();
      if (!now) return;
      off();
      if (!live() || running) return;
      if (hasCode(now)) runBtn.click();
      else if (fromSource) { src.setRangeText("\n", a, b, "end"); src.dispatchEvent(new Event("input")); }
    });
    return true;
  };
  src.addEventListener("keydown", (ev) => { if (ev.key === "Enter" && ev.shiftKey && !ev.ctrlKey && !ev.metaKey && !ev.altKey && !ev.isComposing && runKey(true)) ev.preventDefault(); });
  // (the items kept from the last Run while their code has changed, their values shown marked stale, sagetex.mjs
  //  savedStates: said after a render when the status is empty, as every edit leaves it (daybreak3, #874), so the
  //  count follows the edits; never over another message (a Run's "Ran ...", until the next edit), and never while a
  //  Run is under way, whose own results come next)
  E.onRendered(() => {
    const c = E.lastCheck();
    if (!c || running || status.textContent) return;
    const n = (Array.isArray(c.sage) ? c.sage : []).filter((x: any) => x.s === "stale").length;
    if (n) say(`${n} ${what()}${n === 1 ? "" : "s"} out of date: Shift+Enter runs ${n === 1 ? "it" : "them"} again`);
  });
  const agentTarget = { file: () => where.path, text: () => src.value, lastCheck: E.lastCheck, current: E.posCurrent, preview, images, css: PAGE_CSS, refresh: loadResults };
  registerLatexTools(); setTarget(agentTarget);
  life.signal.addEventListener("abort", () => clearTarget(agentTarget));

  // ---- images (r5 §3): resolved as TeX does (images.ts), read by identity, checked, shown from blob: URLs
  // One resolver at a time (i1c01 A3-1): a reply's names join the queue, and only the running loop reads, counts and
  // keeps images, so no two resolutions are admitted against the same count or bytes, and a name is read once.
  const wanted = new Set<string>();
  let resolving = false;
  // (a read that completes after this page was disposed of keeps nothing: E.destroy leaves the gate's document current)
  const alive = (tok: Token) => !life.signal.aborted && gate.sameDoc(tok);
  // (\graphicspath, from the source: when it changes, every name is resolved again)
  let gpKey = "";
  // (a name not found: the files of the same name elsewhere, from one listing of the workspace per resolution)
  let everywhere: Promise<Entry[]> | null = null;
  const elsewhere = async (name: string) => {
    everywhere ??= host.ws.list("/", { recursive: true }).catch(() => [] as Entry[]);
    const leaf = name.replace(/^.*\//, ""), want = /\.[A-Za-z0-9]+$/.test(leaf) ? [leaf] : IMAGE_EXTS.map((x) => leaf + x);
    return (await everywhere).filter((e) => e.kind === "file" && !e.trashed && !e.path.startsWith("/Trash/") && want.includes(e.path.replace(/^.*\//, ""))).map((e) => e.path).slice(0, 3);
  };
  const resolveImages = async (refs: string[], tok: Token) => {
    const dirs = graphicsPathOf(src.value), key = JSON.stringify(dirs);
    if (key !== gpKey) { gpKey = key; for (const n of Object.keys(images)) delete images[n]; dropImages(); imageBytes = 0; }
    for (const name of refs) if (!Object.hasOwn(images, name)) wanted.add(name);
    if (resolving) return;
    resolving = true;
    everywhere = null;
    let changed = false;
    try {
      // (a Set visits names added while it is iterated: those from replies that came during an await)
      for (const name of wanted) {
        wanted.delete(name);
        if (Object.hasOwn(images, name)) continue;
        if (Object.keys(images).length >= IMAGE_BOUNDS.perDocument) { images[name] = { why: "too many images" }; changed = true; continue; }
        const c = imageCandidates(name, where.path, dirs);
        if (!c.ok) { images[name] = { why: c.why }; changed = true; continue; }
        let found: Entry | undefined;
        for (const p of c.paths) { const e = await host.ws.stat(p).catch(() => undefined); if (e && e.kind === "file" && !e.trashed) { found = e; break; } }
        if (!alive(tok)) { wanted.clear(); return; }
        if (!found) { const why = notFoundWhy(where.path, c.searched, await elsewhere(name), false, name); if (!alive(tok)) { wanted.clear(); return; } images[name] = { why }; changed = true; continue; }
        if ((found.size ?? 0) > IMAGE_BOUNDS.perImage || imageBytes + (found.size ?? 0) > IMAGE_BOUNDS.total) { images[name] = { why: "too large" }; changed = true; continue; }
        let r: { entry: Entry; content: Uint8Array };
        // (the test build only: the page test can hold an image read here; elsewhere this folds away)
        if (typeof __SB_LATEX_TEST__ !== "undefined" && __SB_LATEX_TEST__) await (globalThis as any).__sbTexImageRead?.(found.path);
        try { r = await host.ws.readUpTo(found.path, IMAGE_BOUNDS.perImage); } catch { if (alive(tok)) { images[name] = { why: "not readable" }; changed = true; } continue; }
        // (the same file, by identity, when the read completes; else dropped)
        const now = await host.ws.stat(found.path).catch(() => undefined);
        if (!alive(tok)) { wanted.clear(); return; }
        if (!now || now.fid !== found.fid || r.entry.fid !== found.fid || now.updated !== found.updated) { images[name] = { why: "changed while it was read" }; changed = true; continue; }
        // (the bytes actually read, against the size admitted and what is kept, before any blob is made)
        const why = admitImageBytes(r.content.length, found.size, imageBytes);
        if (why) { images[name] = { why }; changed = true; continue; }
        const sn = sniffImage(r.content);
        if (!sn.ok) { images[name] = { why: sn.why }; changed = true; continue; }
        if (sn.pixels !== null && sn.pixels > IMAGE_BOUNDS.megapixels * 1e6) { images[name] = { why: "too large" }; changed = true; continue; }
        imageBytes += r.content.length;
        const url = URL.createObjectURL(new Blob([r.content as BlobPart], { type: sn.mime }));
        blobs.add(url); images[name] = url; changed = true;
      }
    } finally { resolving = false; }
    if (changed && alive(tok)) request();
  };
  const dropImages = () => { for (const u of blobs) URL.revokeObjectURL(u); blobs.clear(); };
  // (back in this tab, an image not found is looked for again: the file may have been moved or added meanwhile)
  window.addEventListener("focus", () => {
    let again = false;
    for (const [n, v] of Object.entries(images)) if (typeof v !== "string" && v.why.startsWith("not found")) { delete images[n]; again = true; }
    if (again) request();
  }, on);

  // ---- editing: Ctrl/Cmd+S writes what is pending now (and shows Saved ✓), never the browser's own Save dialog
  const isDirty = () => src.value !== savedText;
  const flushKey = (ev: KeyboardEvent) => { if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && ev.key.toLowerCase() === "s") { ev.preventDefault(); if (saveable) void saver?.flush(); else say("This file can't be saved here: " + whyNot + "."); } };
  src.addEventListener("keydown", flushKey);
  document.addEventListener("keydown", (ev) => { if (ev.target !== src) flushKey(ev); }, on);
  toggle.onclick = () => { const p = page.classList.toggle("show-preview"); toggle.textContent = p ? "Source" : "Preview"; };
  // (the browser's own prompt on leaving only when a write has failed: William, Nov 2, "never" otherwise)
  window.addEventListener("beforeunload", (ev) => { if (saver?.failed) { ev.preventDefault(); ev.returnValue = ""; } }, on);
  window.addEventListener("pagehide", dropImages, on);
  // ---- comments: paper.tex's in paper.tex.comments.json beside it, read and written with the workspace's base
  // (compare-and-swap: a conflict is merged and retried, comments-core.mjs)
  const cmPath = () => where.path + ".comments.json";
  const cmIo = {
    read: async () => {
      const e = await host.ws.stat(cmPath());
      if (!e || e.trashed) return { content: null, base: null };
      const r = await host.ws.readUpTo(cmPath(), (2 << 20) + 1);
      return { content: new TextDecoder().decode(r.content), base: r.entry.rev ?? 0 };
    },
    write: async (content: string, base: unknown) => {
      // (the test build only: the page test can write as an agent here, between this write's read and itself)
      if (typeof __SB_LATEX_TEST__ !== "undefined" && __SB_LATEX_TEST__) await (globalThis as any).__sbTexCommentsWrite?.();
      const bytes = new TextEncoder().encode(content);
      if (base !== null) return host.ws.write(cmPath(), bytes, { base: base as number });
      try { return await host.ws.createByPerson(cmPath(), { content: bytes }); } catch (e: any) { throw e?.code === "exists" ? Object.assign(new Error("made meanwhile"), { code: "conflict" }) : e; }
    },
  };
  let cm: any = null, cmLoading: Promise<any> | null = null;
  const comments = () => (cmLoading ??= loadDocComments().then((m) => {
    if (!live()) return null;
    return (cm = m.attachDocComments(viewOf(E), { io: cmIo, file: { fid: host.fid, path: cmPath() }, author: "person:me", src, hl: E.hl, button: cmBtn, md: host.markdown, reveal: E.revealSource }));
  }));
  cmBtn.onclick = () => void comments().then((c) => c?.openList());
  src.addEventListener("keydown", (ev) => { if (!cm && (ev.ctrlKey || ev.metaKey) && ev.altKey && ev.code === "KeyM") { ev.preventDefault(); void comments().then((c) => c?.commentSelection()); } });
  void host.ws.stat(cmPath()).then((e) => { if (e && !e.trashed && live()) void comments(); }, () => {});
  // (the agent's route to a PDF, documented in llms.txt: window.sagebrush.latex.print() opens the same dialog;
  // printMode(true) puts the page in its print layout for a browser an agent drives, whose own print-to-PDF (CDP
  // Page.printToPDF) then makes the file, and printMode(false) puts it back)
  const sb = ((globalThis as any).sagebrush ??= {});
  const handle = { print: () => printPreview(), printMode: (on: boolean) => { document.documentElement.classList.toggle("tex-print", !!on); slidePages(!!on); }, fid: host.fid };
  sb.latex = handle;
  // (left in its print layout, by an agent's printMode(true) then the page left or another file opened: put back, as
  //  the layout hides all but this preview, and the slide page would stay the next page's paper)
  dispose = () => { life.abort(); E.destroy(); dropImages(); cm?.destroy(); if (sb.latex === handle) { handle.printMode(false); delete sb.latex; } };
  // (closing for another file: what is pending written first, then the editor disposed of)
  // (held: read-only while a controlled switch settles and closes it; the saver's own read-only, for recovery, kept apart)
  let held = false, roSaver = false;
  // (closing for a switch: this editor no longer shows its saver's states (they're the next file's to show), so while
  //  its last write is under way it says so, rather than leaving an older state shown: a slow close write read as a
  //  failure (#551's DB3 follow-up))
  const closingSaid = () => { if (saver && saver.state.k !== "saved" && saver.state.k !== "readonly") { saveState.classList.remove("failed"); saveState.textContent = "Saving before switching…"; } };
  current = { dispose: () => { void saver?.dispose(); dispose(); }, close: async () => { closingSaid(); await saver?.dispose(); dispose(); }, dirty: () => !!saver?.failed, hold: (on: boolean) => { held = on; src.readOnly = on || roSaver; }, settle: () => saver ? saver.settle() : Promise.resolve(true) };
  mine = current;
  // (the test build only: the page test tells this workspace an op as sync's view would; elsewhere this folds away)
  if (typeof __SB_LATEX_TEST__ !== "undefined" && __SB_LATEX_TEST__) { (globalThis as any).__sbTexWs = host.ws; (globalThis as any).__sbTexActor = () => actor; (globalThis as any).__sbTexSession = () => sageSession; }

  // ---- saving (r6b E5): the opened file only, and only over the revision its text was read or saved as (base): a
  // change made elsewhere since is never written over, the bar below asks. Asked for by the saver (autosave.ts), as
  // you type; "blocked" while the bar asks or a choice in it is under way; a refusal thrown, its message the reason
  let saving = false;
  async function writeText(text: string): Promise<"saved" | "blocked" | "readonly"> {
    if (!saveable) return "readonly";
    if (conflict || acting) return "blocked";
    const base = docRev;
    // (the comments' anchors with this text, taken now: before anything waits, an edit can't move them in between)
    const snap = cm?.snapshot();
    const bytes = encodeText(text, eol);
    if (bytes.length > EDIT_MAX) throw new Error("over the prototype's 4 MiB limit");
    saving = true;
    try {
      const at = await host.ws.pathOfFile(host.fid);
      if (!at.ok) { goneSaid = true; throw new Error("this file isn't here any more" + (at.why === "trashed" ? " (it's in the Trash: restore it)" : "")); }
      if (at.entry.remote) throw new Error("this file is in the cloud: open it on the device that made it");
      const path = at.path;
      // (the test build only: the page test can hold the .tex's write here, or make it fail; elsewhere this folds away)
      if (typeof __SB_LATEX_TEST__ !== "undefined" && __SB_LATEX_TEST__) await (globalThis as any).__sbTexSaveWrite?.();
      let w: { rev?: number };
      try { w = await host.ws.write(path, bytes, { fid: host.fid, base }); } catch (err) {
        // (the workspace's own refusal, by its code: this module doesn't bundle the workspace's classes)
        const c = (err as any)?.code === "conflict", other = c && /another file/.test(String((err as Error)?.message));
        if (c && !other) { again = true; return "blocked"; }
        throw other ? new Error("another file is at this path now") : err;
      }
      savedText = text; docRev = w.rev ?? 0;
      void cm?.saved(snap);
      if (path !== where.path && !renamingTitle) showName(path);
      return "saved";
    } finally { saving = false; if (again && live()) void check(); }
  }
  const showSave = (st: SaveState) => {
    // (a file that can't be saved here: Read-only, never Saved ✓ or Edited)
    if (!saveable && (st.k === "saved" || st.k === "edited")) st = { k: "readonly" };
    saveState.classList.toggle("failed", st.k === "failed");
    saveState.textContent = st.k === "saving" ? "Saving…" : st.k === "saved" ? "Saved ✓" : st.k === "edited" ? "Edited" : st.k === "blocked" ? "Not saved yet: changed elsewhere" : st.k === "readonly" ? "Read-only" : "Not saved: " + st.why;
    saveState.title = st.k === "failed" ? "Your edits are kept in this browser; they are written again on the next edit or Ctrl/Cmd+S" : st.k === "readonly" ? whyNot : "";
  };

  // ---- a change to this file made elsewhere (an agent through sagebrush-mcp, another tab, another device): with no
  // unsaved edits here, the text follows it in place, the cursor and scroll kept; with them, nothing is replaced or
  // written and the bar asks (William, Nov 3: "a critical thing to get right"). One check at a time, each reading
  // the file's bytes, fid and revision together (readUpTo, under the workspace's lock); one asked for meanwhile, or
  // during a Save or a choice in the bar (Keep mine, Use theirs), runs after it.
  let checking = false, again = false, acting = false, goneSaid = false, checkTimer: any = null, docPath = where.path;
  let conflict: { fid: string; rev: number; theirs: boolean; by: string } | null = null;
  // (who changed it, a label only: the one actor among this file's ops since the last check, "elsewhere" once there
  //  is a second (one string, however many ops wait); this tab's own Save's ops are its own)
  let actor: string | null = null;
  let waits = 0;
  const actorName = (op: any) => { const by = typeof op.by === "string" ? op.by : "";
    return op.origin === "server" ? "another device" : by === "agent:page" ? "an agent in this page" : by.startsWith("agent:") ? by.slice(6).replace(/[-_]+/g, " ").trim() || "an agent" : "another tab"; };
  const unwatchDoc = host.ws.watch((c) => {
    let hit = false;
    for (const op of c.ops ?? []) if (op.fid === host.fid || op.path === docPath || op.to === docPath) {
      hit = true;
      if (!((saving || acting) && op.by === "person" && op.origin !== "server")) { const n = actorName(op); actor = actor === null || actor === n ? n : "elsewhere"; }
    }
    if (hit) { waits = 0; clearTimeout(checkTimer); checkTimer = setTimeout(() => void check(), 50); }
  });
  life.signal.addEventListener("abort", () => { unwatchDoc(); clearTimeout(checkTimer); });
  const setSaveable = (ok: boolean, why: string) => { saveable = ok; whyNot = why; setBanner(ok ? undefined : why); if (!ok) { saveState.textContent = "Read-only"; saveState.title = why; } };
  // (a coherent read's saveability, as at opening: whole, text, written back exactly, not in the cloud)
  const judge = (r: { entry: Entry; content: Uint8Array }) => {
    const o = openBytes(r.content);
    if (o.kind !== "text") return { o, ok: false, why: o.why };
    const ok = o.saveable && r.content.length === (r.entry.size ?? -1) && !r.entry.remote;
    return { o, ok, why: !o.saveable ? o.why : r.entry.remote ? "it is in the cloud; open it on the device that made it" : !ok ? "the whole file couldn't be read" : "" };
  };
  // (their text in the editor, as the text saved: the selection and scroll kept, clamped to its length)
  const install = (text: string, rev: number, nextEol: "\n" | "\r\n", ok: boolean, why: string) => {
    const a = src.selectionStart, b = src.selectionEnd, d = src.selectionDirection, top = src.scrollTop, lft = src.scrollLeft;
    E.setText(text);
    src.setSelectionRange(Math.min(a, text.length), Math.min(b, text.length), d);
    src.scrollTop = top; src.scrollLeft = lft;
    savedText = text; docRev = rev; eol = nextEol; setSaveable(ok, why);
    conflict = null; bar.hidden = true; saver?.settled();
  };
  const showBar = (c: NonNullable<typeof conflict>) => {
    conflict = c;
    barText.textContent = c.by === "elsewhere" ? "This file was changed elsewhere while you were editing." : c.by[0].toUpperCase() + c.by.slice(1) + " changed this file while you were editing.";
    // (Keep mine only where this text can be saved; Use theirs only where theirs is text)
    keepMine.hidden = !saveable; useTheirs.hidden = !c.theirs;
    bar.hidden = false;
    saver?.held();
  };
  // (another device's change, its bytes not here yet (readUpTo: "missing"; sync-fetch installs them without an op):
  //  nothing replaced, this text kept; looked at again every 2 s until they are (for 5 minutes; then at the next
  //  change), who changed it kept for then)
  const keepActor = (by: string) => { actor = actor === null || actor === by ? by : "elsewhere"; };
  const onItsWay = (by: string) => {
    say("This file was changed on another device; its new text is on its way…");
    keepActor(by);
    if (++waits > 150) return;
    clearTimeout(checkTimer); checkTimer = setTimeout(() => void check(), 2000);
  };
  const check = async (): Promise<void> => {
    // (one at a time, and none during a Save or a choice in the bar: asked for meanwhile, it runs when they end)
    if (checking || saving || acting) { again = true; return; }
    checking = true; again = false;
    // (who: the writers seen up to when the read is done, the read being of their writes)
    const take = () => { const b = actor ?? "elsewhere"; actor = null; return b; };
    try {
      const at = await host.ws.pathOfFile(host.fid);
      if (!live()) return;
      if (!at.ok) { take(); if (!goneSaid) say("This file was deleted elsewhere; your text is still here."); goneSaid = true; return; }
      goneSaid = false; docPath = at.path;
      const e0 = edits, d0 = docRev;
      // (the test build only: the page test can hold the check here, before its read and after it; elsewhere this folds away)
      if (typeof __SB_LATEX_TEST__ !== "undefined" && __SB_LATEX_TEST__) await (globalThis as any).__sbTexCheckRead?.("before");
      let r: { entry: Entry; content: Uint8Array };
      try { r = await host.ws.readUpTo(at.path, EDIT_MAX); } catch (err) {
        if (!live()) return;
        if ((err as any)?.code === "missing") { onItsWay(take()); return; }
        say("This file was changed elsewhere and can't be read here now: " + String((err as Error)?.message ?? err).slice(0, 160)); return;
      }
      if (typeof __SB_LATEX_TEST__ !== "undefined" && __SB_LATEX_TEST__) await (globalThis as any).__sbTexCheckRead?.("after");
      const by = take();
      // (another file at this path now is never this editor's)
      if (!live() || r.entry.fid !== host.fid) return;
      // (a Save or Keep mine done while it read: what it read may be older than that; read again)
      if (docRev !== d0) { keepActor(by); again = true; return; }
      const rev = r.entry.rev ?? 0;
      if (rev === docRev || rev === conflict?.rev) return;
      if (r.entry.remote) { onItsWay(by); return; }
      waits = 0;
      const j = judge(r);
      if (!conflict && edits === e0 && src.value === savedText) {
        // (no unsaved edits, before the read and after it: their text here; one the editor can't show leaves this
        //  text, and Save off)
        if (j.o.kind !== "text") { setSaveable(false, j.why); say(`${by === "elsewhere" ? "This file was changed elsewhere" : by[0].toUpperCase() + by.slice(1) + " changed this file"} into one the editor can't show: ${j.why}`); return; }
        const same = j.o.text === src.value;
        install(j.o.text, rev, j.o.eol, j.ok, j.why);
        if (!same) say(by === "elsewhere" ? "Updated elsewhere" : "Updated by " + by);
        return;
      }
      showBar({ fid: r.entry.fid!, rev, theirs: j.o.kind === "text", by });
    } finally { checking = false; if (again && live()) void check(); }
  };
  const barBusy = (b: boolean) => { acting = b; keepMine.disabled = useTheirs.disabled = b; };
  // Keep mine: this text, written over exactly the revision the bar shows (its fid and rev, taken at the click);
  // a later change makes it a conflict again, nothing written, the bar shown for that one
  keepMine.onclick = async () => {
    const c = conflict;
    if (!c || acting || saving || !saveable) return;
    const t = src.value, g = saver?.gen, snap = cm?.snapshot(), bytes = encodeText(t, eol);
    barBusy(true); say("saving…");
    try {
      const at = await host.ws.pathOfFile(c.fid);
      if (!at.ok) { if (live()) say("Not saved: this file isn't here any more"); return; }
      // (the test build only: the page test can hold this write; elsewhere this folds away)
      if (typeof __SB_LATEX_TEST__ !== "undefined" && __SB_LATEX_TEST__) await (globalThis as any).__sbTexKeepWrite?.();
      const w = await host.ws.write(at.path, bytes, { fid: c.fid, base: c.rev });
      if (!live()) return;
      savedText = t; docRev = w.rev; void cm?.saved(snap);
      if (conflict === c) { conflict = null; bar.hidden = true; }
      saver?.settled(g);
      say("Saved: yours kept, theirs is in TimeTravel");
    } catch (err) {
      if (!live()) return;
      if ((err as any)?.code === "conflict") { say("Not saved: it was changed again; choose again"); again = true; }
      else say("Not saved: " + String((err as Error)?.message ?? err).slice(0, 200));
    } finally { if (live()) { barBusy(false); if (again) void check(); } }
  };
  // Use theirs: this text first kept as a new file beside it, "name (mine).tex" (else "(mine 2)", … "(mine 20)",
  // made, never written over); only then, and only if nothing was typed meanwhile, their text read and put here
  useTheirs.onclick = async () => {
    if (!conflict || acting || saving) return;
    const t = src.value, e0 = edits;
    barBusy(true); say("keeping your text as a copy…");
    let made = "";
    try {
      const at = await host.ws.pathOfFile(host.fid);
      if (!at.ok) { if (live()) say("Not done: this file isn't here any more; your text is still here"); return; }
      const dir = parentOf(at.path), stem = nameOf(at.path).replace(/\.tex$/i, "");
      // (an unsaveable file's copy has LF line endings, so it can be saved)
      const bytes = encodeText(t, saveable ? eol : "\n");
      for (let k = 1; k <= 20 && !made; k++) {
        const p = (dir === "/" ? "/" : dir + "/") + `${stem} (mine${k > 1 ? " " + k : ""}).tex`;
        // (the test build only: the page test can hold or fail this create; elsewhere this folds away)
        if (typeof __SB_LATEX_TEST__ !== "undefined" && __SB_LATEX_TEST__) await (globalThis as any).__sbTexCopyCreate?.(p);
        try { await host.ws.createByPerson(p, { content: bytes }); made = p; } catch (err) { if ((err as any)?.code !== "exists") throw err; }
      }
      if (!live()) return;
      if (!made) { say(`Not done: ${stem} (mine).tex to (mine 20) are all taken; your text is still here`); return; }
      const kept = nameOf(made);
      const r = await host.ws.readUpTo(at.path, EDIT_MAX);
      // (the test build only: the page test can hold this read; elsewhere this folds away)
      if (typeof __SB_LATEX_TEST__ !== "undefined" && __SB_LATEX_TEST__) await (globalThis as any).__sbTexTheirsRead?.();
      if (!live()) return;
      const j = judge(r);
      if (edits !== e0 || src.value !== t) { say(`Your text up to then is in ${kept}; you've typed since, so your text stays here`); return; }
      if (r.entry.fid !== host.fid || j.o.kind !== "text" || r.entry.remote) { say(`Your text is in ${kept}; theirs can't be shown here now, so your text stays here too`); return; }
      install(j.o.text, r.entry.rev ?? 0, j.o.eol, j.ok, j.why);
      say(`Your text is in ${kept}`);
    } catch (err) {
      if (live()) say((made ? `Your text is in ${nameOf(made)}, but theirs couldn't be read: ` : "Not done: your text couldn't be kept as a copy (it is still here): ") + String((err as Error)?.message ?? err).slice(0, 160));
    } finally { if (live()) { barBusy(false); if (again) void check(); } }
  };

  // ---- saving as you type (autosave.ts; plan U8 r6): each edit durable at once in this editor's own draft
  // (drafts.ts), the file written by writeText above, 800 ms after the last edit and at once on Ctrl/Cmd+S, blur,
  // hidden, pagehide and a switch. (For every text file: one that can't be saved here now may become saveable, its
  // text replaced by a change made elsewhere; until then its edits are drafts, and it says Read-only)
  {
    saver = new AutoSaver({
      write: writeText,
      // (a recovered draft kept as a version of this file, never written over it: by its entry, checked to be this file)
      keepVersion: async (text: string) => {
        const at = await host.ws.pathOfFile(host.fid);
        if (!at.ok || at.entry.fid !== host.fid) throw new Error("this file isn't here any more");
        await host.ws.keepVersion(at.entry, encodeText(text, eol));
      },
    }, browserDrafts(), { fid: host.fid, writerId: newWriterId(), path: () => where.path }, {
      text: () => src.value,
      dirty: isDirty,
      rev: () => docRev,
      blocked: () => !!conflict || acting,
      adopt: (t) => { E.setText(t); edits++; },
      stale: () => showBar({ fid: host.fid, rev: docRev, theirs: true, by: "elsewhere" }),
      readOnly: (ro) => { roSaver = ro; src.readOnly = ro || held; },
      state: (st) => { if (live()) showSave(st); },
    }, { set: (f, ms) => setTimeout(f, ms), clear: (h) => clearTimeout(h as any) });
    const s = saver;
    if (saveable) showSave({ k: "saved" });
    src.addEventListener("blur", () => void s.flush(), on);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") void s.flush(); }, on);
    window.addEventListener("pagehide", () => void s.flush(), on);
    // (edits this file had that never reached it: another tab's, or this browser's before it closed)
    if (saveable) void s.recover(savedText).then((r) => {
      if (!live()) return;
      if (r.recovered) say("Recovered your unsaved edits");
      else if (r.kept) say(r.kept + " unsaved drafts from other tabs were kept as versions of this file: open its history to compare them");
    });
  }

  // ---- source and preview in sync (editor.ts): Follow (remembered, on by default) and Show
  const showFollow = () => followBtn.setAttribute("aria-pressed", String(E.following()));
  followBtn.onclick = () => { E.setFollow(!E.following()); showFollow(); };
  showBtn.onclick = () => E.showCursor(true);
  showFollow();

  void parentOf; void enc;
}

/** The preview printed alone (PRINT_CSS, while <html> has tex-print): the browser's dialog, with "Save as PDF". */
export function printPreview() {
  const html = document.documentElement;
  html.classList.add("tex-print");
  slidePages(true);
  const done = () => { html.classList.remove("tex-print"); slidePages(false); };
  window.addEventListener("afterprint", done, { once: true });
  try { window.print(); } finally { setTimeout(() => { if (html.classList.contains("tex-print")) done(); }, 0); }
}

/** A beamer document printed as beamer makes its PDF: one slide a page, the page the class's own paper (beamer.mjs
 * slideStyle's aspect-ratio, in mm: 128 x 96 mm, 160 x 90 mm for aspectratio=169, ...), no margins, while it prints;
 * any other document keeps PRINT_CSS's page. */
export function slidePages(on: boolean) {
  const id = "sb-tex-slide-page";
  document.getElementById(id)?.remove();
  if (!on) return;
  const s = document.querySelector(".tex-page .tex-preview section.slide");
  const m = /aspect-ratio:\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/.exec(s?.getAttribute("style") ?? "");
  if (!m) return;
  const st = document.createElement("style");
  st.id = id;
  st.textContent = `@page { size: ${m[1]}mm ${m[2]}mm; margin: 0; }`;
  document.head.appendChild(st);
}

/** The print layout, only while <html> has tex-print: the rendered preview alone (no editor, header, banner, comments'
 * margin or file browser), on the page's own margins, with breaks kept off headings, math, floats and tables. */
export const PRINT_CSS = `
@media print {
  @page { margin: 18mm 16mm; }
  html.tex-print body > :not(:has(.tex-page)) { display: none !important; }
  html.tex-print body { background: #fff !important; }
  html.tex-print .tex-page { position: static !important; display: block !important; inset: auto !important; left: 0 !important; background: #fff !important; z-index: auto; }
  html.tex-print .tex-page > :not(.tex-main), html.tex-print .tex-left, html.tex-print .tex-right > :not(.tex-preview), html.tex-print .tex-filemenu { display: none !important; }
  html.tex-print .tex-main, html.tex-print .tex-right { display: block !important; overflow: visible !important; background: none !important; padding: 0 !important; border: 0 !important; }
  html.tex-print .tex-page .page { max-width: none !important; margin: 0 !important; padding: 0 !important; box-shadow: none !important; zoom: 1 !important; }
  html.tex-print .tex-preview .pc { content-visibility: visible !important; contain-intrinsic-size: none !important; }
  html.tex-print .tex-preview .ch.sync-flash { outline: none !important; }
  html.tex-print .tex-preview h1, html.tex-print .tex-preview h2, html.tex-print .tex-preview h3, html.tex-print .tex-preview h4 { break-after: avoid; page-break-after: avoid; }
  html.tex-print .tex-preview .dmath, html.tex-print .tex-preview .float, html.tex-print .tex-preview table.tabular, html.tex-print .tex-preview img.graphic, html.tex-print .tex-preview .titleblock, html.tex-print .tex-preview .thmhead { break-inside: avoid; page-break-inside: avoid; }
  html.tex-print .tex-preview .dmath { overflow: visible !important; }
  html.tex-print .tex-preview h1.chapter, html.tex-print .tex-preview h1.part { break-before: page; }
  html.tex-print .tex-preview section.slide { break-before: page; break-inside: avoid; margin: 0 !important; border: 0 !important; box-shadow: none !important; }
  html.tex-print .tex-preview header.slide-title { display: block !important; }
}
`;

/** The File menu's items drawn as the other editors' menus draw them (code/page.ts): flat rows, a highlight on hover,
 * not the browser's bordered buttons. */
const MENU_CSS = `.tex-filemenu button { background: none; border: 0; padding: 5px 10px; border-radius: 5px; font: inherit; color: inherit; cursor: pointer; }
.tex-filemenu button:hover:not(:disabled) { background: #eef2f7; }`;
