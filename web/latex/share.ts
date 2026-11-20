// A shared talk on the share page (/s/<id>, web/share-client/view.ts, sync-docs' side): its slides drawn read only with
// the author's results, and its code run on the visitor's click, in the runner (the opaque-origin sandbox, no storage,
// no network, never a fallback), with the share's files of the .tex's folder mounted read only. The results stay in this
// page: nothing is written or published, and a reload shows the author's again. The agreed shape:
// /scratch/sagebrush-plans/specs/S2-runner.md (astra's SEC design, Nov 12).
// A chunk of its own, /sagebrush-latex-share.js: the editor's parts are loaded by URL (the files the editor caches),
// never bundled here: the page module's mountEditor (the read-only preview), Run's (run-core), the presenter's and the
// interacts'.
import type { LatexEditor, mountEditor as MountEditor } from "./component";

type Remote = { url: string; sha256: string; size: number };
export type SharedOpts = {
  /** The .tex's path in the share's manifest ("talks/st.tex"). */
  path: string;
  /** Its text, SHA-checked by the share page. */
  text: string;
  /** The author's "<path>.results.json", parsed and SHA-checked by the share page; null if the share has none. */
  results: unknown | null;
  /** The page's kernel and runner classes, and the runner's URL; null where this browser can't make the runner. */
  sandbox: { WorkerKernel: unknown; RunnerWorker: unknown; runnerUrl: string } | null;
  /** The share's files ([manifest path, {url, sha256, size}]): only those under the .tex's folder are given to Sage. */
  mount: [string, Remote][];
  say(text: string): void;
  onRunning(on: boolean): void;
  /** After each render, what the document has: code to run (Run's own items) and slides to present (as the editor
   *  decides its Run and Present), so the page offers only those (an article shared from a folder has neither). */
  onShape?(shape: { hasCode: boolean; hasSlides: boolean }): void;
};
export type Shared = { run(): void; stop(): void; present(): void; dispose(): void };

const at = (f: string) => new URL(f, import.meta.url).href;
type RunCore = typeof import("./run-core.mjs");
let runMod: Promise<RunCore> | null = null, presentMod: Promise<typeof import("./present")> | null = null, interactMod: Promise<typeof import("./interact")> | null = null;
// (a load that fails is forgotten: the next click tries again)
const load = <T>(get: () => Promise<T> | null, set: (p: Promise<T> | null) => void, f: string): Promise<T> => get() ?? (set((import(at(f)) as Promise<T>).catch((e) => { set(null); throw e; })), get()!);
const loadRun = () => load(() => runMod, (p) => { runMod = p; }, "sagebrush-latex-run.js");
const loadPresent = () => load(() => presentMod, (p) => { presentMod = p; }, "sagebrush-latex-present.js");
const loadInteract = () => load(() => interactMod, (p) => { interactMod = p; }, "sagebrush-latex-interact.js");
// (this page's words where the editor's would point elsewhere (board): the visitor is on the site already, and sees only
//  the slides)
const NO_SANDBOX = "Run needs the sandbox Sagebrush runs code in, which this browser doesn't have: open this page in Chrome or Edge";
// (the results file's whole size, as the editor's Run bounds it)
const RESULTS_MAX = 8 * 2 ** 20;

/** The folder of a manifest path ("" for the share's top), or null for one that isn't a plain relative path: no leading
 *  "/", no "\\", no empty, "." or ".." part (astra: the folder boundary normalized, never trusted). */
export function folderOf(path: string): string | null {
  if (typeof path !== "string" || !path || path.startsWith("/") || path.includes("\\")) return null;
  const parts = path.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return null;
  return parts.slice(0, -1).join("/");
}
/** The entries of `mount` in `dir` (folderOf's) or under it, each a plain relative path; anything else left out. */
export function mountIn(mount: [string, Remote][], dir: string): [string, Remote][] {
  return (Array.isArray(mount) ? mount : []).filter((e) => Array.isArray(e) && folderOf(e[0]) !== null && (dir === "" || e[0].startsWith(dir + "/")) && !!e[1] && typeof e[1].url === "string" && typeof e[1].sha256 === "string" && Number.isSafeInteger(e[1].size))
    .map(([p, r]) => [p, { url: r.url, sha256: r.sha256, size: r.size }]);
}
/** The author's results as the renderer reads them, or none: the editor's results file (format, version, wrapper,
 *  items), its items' own checks left to the renderer (savedStates). */
export function savedOf(j: any): { wrapper: string | null; saved: unknown[] } {
  return j && j.format === "sagebrush-latex-results" && j.version === 1 && typeof j.wrapper === "string" && Array.isArray(j.items) ? { wrapper: j.wrapper, saved: j.items } : { wrapper: null, saved: [] };
}

export async function openShared(root: HTMLElement, o: SharedOpts): Promise<Shared> {
  const dir = folderOf(o.path);
  if (dir === null) throw new Error("the talk's path isn't one this page opens");
  // (astra: dispose wins over a start or a Run still under way: each checks `gone` after its waits; an open still
  //  loading is the share page's to drop, as it holds no handle to it yet)
  let gone = false;
  const page = (await import(at("sagebrush-latex.js"))) as { mountEditor: typeof MountEditor };
  // (the author's results: what the slides show until a Run, and what an item a Run doesn't reach keeps)
  const results = savedOf(o.results);
  const E: LatexEditor = page.mountEditor(root, { text: o.text, readOnly: true, layout: "preview", sage: results });
  const preview = E.previewRoot();
  const mount = mountIn(o.mount, dir);
  let session: ReturnType<RunCore["sessionOf"]> | null = null;
  let running = false, gen = 0, runStop: AbortController | null = null;
  let liveIds: Set<number> & { over?: number } = new Set();
  let presenting: { stop(): void; at(): { frame: number; step: number }; go(frame: number, step?: number): void; running(on: boolean): void } | null = null;
  const live = () => !gone;
  const slidesNow = () => Array.from(preview.querySelectorAll(":scope > .ch:not([hidden]) section.slide")) as HTMLElement[];
  const idle = () => { running = false; presenting?.running(false); if (live()) o.onRunning(false); };

  // (what the document has, after each render: the page's Run and Present follow it)
  E.on("rendered", () => { if (live()) o.onShape?.({ hasCode: (E.items()?.length ?? 0) > 0, hasSlides: slidesNow().length > 0 }); });

  // (the preview's interacts, drawn after each render that has one not drawn yet; the slide being presented shown again)
  E.on("rendered", () => {
    if (!preview.querySelector(".sageinteract-at")) return;
    void loadInteract().then((m) => { if (live() && m.draw(preview, session as any, liveIds) && presenting) { const a = presenting.at(); presenting.go(a.frame, a.step); } }, () => {});
  });

  const run = async () => {
    if (gone || running) return;
    running = true; o.onRunning(true); presenting?.running(true);
    const my = ++gen, current = () => live() && my === gen, stop = new AbortController();
    runStop = stop;
    try {
      let rc: RunCore;
      try { rc = await loadRun(); } catch { if (current()) o.say("Not run: Run's code couldn't be loaded; press Run again"); return; }
      if (!current()) return;
      if (!o.sandbox) { o.say(NO_SANDBOX); return; }
      const items = E.items();
      if (!items) { o.say("The slides are still being drawn: try again in a moment"); return; }
      if (!items.length) { o.say("No SageTeX, PythonTeX or Magma code to run"); return; }
      const sb = o.sandbox;
      // (one session for this view: the share's files of the .tex's folder mounted, read only; its runner at the page's)
      session ??= rc.sessionOf({ module: async () => sb as any, worker: (mod: any) => new mod.RunnerWorker(new URL(sb.runnerUrl, location.href).href, {}) }, rc.SANDBOX_START_MS, mount);
      const s = session;
      o.say("Starting Sage…");
      liveIds.over = 1;
      const r = await rc.runInMemory({
        items, current, max: RESULTS_MAX, now: () => performance.now(), prev: results.saved, dir: "/" + dir,
        session: async () => { const k = await s(); if (current()) o.say("Running…"); return k; },
        exec: rc.runIn, serial: s.serial, stop: stop.signal, interacts: loadInteract,
      });
      if (r.stale || !current()) return;
      if (r.msg) { o.say(r.msg); return; }
      liveIds = r.interactIds;
      // (this page's results, as the editor reads its results file back: the slides drawn with them; nothing written)
      const next = savedOf(JSON.parse(rc.resultsText(r.states)));
      results.wrapper = next.wrapper; results.saved = next.saved;
      E.redraw();
      const { ran, failed } = rc.tally(r.states);
      // (as the editor says it: "SageTeX item" when all the code is Sage, else "code item")
      const what = items.some((x: any) => /^(py|magma)/.test(x?.mode)) ? "code item" : "SageTeX item";
      o.say(`Ran ${ran < items.length ? ran + " of " : ""}${items.length} ${what}${items.length === 1 ? "" : "s"} in ${(r.ms / 1000).toFixed(1)} s` + (failed ? `; ${failed} failed` : "") + " (this page only)");
    } catch (err) {
      if (current()) o.say(String((err as Error)?.message ?? err).slice(0, 200));
    } finally { if (my === gen) { runStop = null; idle(); } }
  };
  const stopRun = () => { if (running && runStop) { runStop.abort(); o.say("stopping…"); } };

  const present = () => void loadPresent().then((m) => {
    if (gone || presenting) return;
    presenting = m.present({
      slides: slidesNow, onRendered: (f: () => void) => E.on("rendered", f), start: 1,
      onRun: () => { void run(); }, onStop: stopRun,
      onShow: (st: HTMLElement) => { if (st.querySelector(".sageinteract")) void loadInteract().then((m) => { if (live()) m.live(st, session as any, liveIds); }, () => {}); },
      onExit: () => { presenting = null; },
    });
    if (running) presenting.running(true);
  }, () => o.say("Couldn't load the presenter. Check the network, then click Present to try again."));

  const dispose = () => {
    if (gone) return;
    gone = true;
    runStop?.abort();
    presenting?.stop(); presenting = null;
    liveIds.over = 1; liveIds = new Set();
    session?.dispose(); session = null;
    E.destroy();
  };
  return { run: () => { void run(); }, stop: stopRun, present, dispose };
}
