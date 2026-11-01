// The lazy chunk's entry (sagebrush-export.js): the export's flow inside the Storage panel (export plan E1 r2d §0).
//   Export all current files → this tab's open document saved → preflight (progress, Cancel) → ready (Save… / Cancel),
//   or, when files aren't on this device, a plain refusal naming them (nothing is ever left out of an export: the r2
//   simplification of "Export the rest" and "Fetch them first", @sagebrush's rule of Oct 31) → written (progress,
//   Cancel) → a summary, or one plain reason with Export again.  Save… is its own click: the browser's save picker
//   needs one.
import type { Workspace } from "../api";
import { ExportStopped, LOCK_PREFIX, localDate, preflight, setKit, Spool, startWorker, unavailableWhyText, write, type Kit, type Plan, type Progress, type Result } from "./run";
// (the caps in effect: the test page checks a page without its hooks has the real ones, grader's N-3)
export { capsInEffect } from "./run";
// (tests only: the direct writer against JSON.stringify, in the page, E1 r2c)
export { writerCheck } from "./run";

export type ExportHost = {
  say(m: string): void;
  fail(e: unknown): void;
  /** the worker's address (sagebrush-export-worker.js, beside this chunk) */
  workerUrl: string;
  /** this tab's open document saved, first (§1): the notebook page's and the board page's own save, settled */
  saveOpen?: () => Promise<void>;
  /** the status line changed */
  stamped(): void;
  site: string;
  app: string;
  /** the page's own values (run.ts Kit) */
  kit: Kit;
  /** the Storage panel closed: the export it shows is cancelled (its panel is gone, so nothing can be shown or saved) */
  closed?: AbortSignal;
};

// (astra's E1 code R1: one export at a time in this page.  Its decoder's row (rows.ts R), the slice counts and the
// kit are this module's, one per page; an export owns them from its first step until its archive is handed over or
// it has stopped, and another Export meanwhile (the Storage panel closed and opened again, or Export again beside the
// panel's own button) is refused in words, never run beside it)
let owner: object | null = null;
/** (tests) whether an export owns this page's export state now */
export const exportOwned = () => owner !== null;

const fmt = (n: number) => (n < 2 ** 20 ? `${Math.ceil(n / 1024)} KB` : n < 2 ** 30 ? `${(n / 2 ** 20).toFixed(1)} MB` : `${(n / 2 ** 30).toFixed(2)} GB`);
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
const btn = (text: string, onclick: () => void, cls = "") => { const b = el("button", { textContent: text, className: cls }); b.onclick = onclick; return b; };

/** Runs one export in `box` (the Storage panel's export section); resolves when it ends, however it ends.  The export
 * holds the Web Lock LOCK_PREFIX + its id from before its worker starts until its last scratch file is gone, which
 * may be a minute after this resolves (an OPFS handoff): another tab's export never removes its files meanwhile. */
export async function openExport(w: Workspace, host: ExportHost, box: HTMLElement): Promise<void> {
  if (owner) { host.say("An export is already running in this tab. Finish or cancel it first."); return; }
  const me = {};
  owner = me;
  const free = () => { if (owner === me) owner = null; };
  try { await flow(w, host, box, free); } finally { free(); }
}

async function flow(w: Workspace, host: ExportHost, box: HTMLElement, free: () => void): Promise<void> {
  // (the panel closed: this export cancelled, while it is still this page's; never after, when another may be.
  // Listened for from the first step, before anything asynchronous; a panel already closed cancels it at once)
  const ac = new AbortController();
  let ended = false;
  const onClosed = () => { if (!ended) ac.abort(); };
  if (host.closed?.aborted) onClosed(); else host.closed?.addEventListener("abort", onClosed, { once: true });
  const unlisten = () => { ended = true; host.closed?.removeEventListener("abort", onClosed); };
  setKit(host.kit);
  const id = crypto.randomUUID();
  let release!: () => void;
  const lifetime = new Promise<void>((r) => (release = r));
  let worker!: Awaited<ReturnType<typeof startWorker>>["worker"], opfs!: boolean;
  try {
    await new Promise<void>((held, no) => {
      (navigator as any).locks.request(LOCK_PREFIX + id, () => { held(); return lifetime; }).catch(no);
    });
    ({ worker, opfs } = await startWorker(host.workerUrl, id).catch((e) => { release(); throw e; }));
  } catch (e) { unlisten(); throw e; }
  // (what outlives the flow: the OPFS scratch's removal after the download has it; the worker and the lock until then)
  let after: Promise<void> = Promise.resolve();
  worker.cancelOn(ac.signal);
  // (closed during the startup: nothing begun, nothing to show)
  if (ac.signal.aborted) { unlisten(); worker.terminate(); release(); return; }
  const line = el("p", { className: "note" }), cancel = btn("Cancel", () => ac.abort());
  const show = (...kids: (Node | string)[]) => box.replaceChildren(...kids);
  const progress = (p: Progress) => {
    line.textContent = p.phase === "preflight" ? `Checking… ${p.files.toLocaleString()} files · ${fmt(p.bytes)}`
      : p.phase === "writing" ? `${p.files.toLocaleString()} of ${p.of.toLocaleString()} files and folders · ${fmt(p.bytes)} written`
      : `Finishing the archive's index… ${fmt(p.bytes)} written`;
  };
  const again = (done: () => void) => [btn("Export again", () => { done(); void openExport(w, host, box); }), " ", btn("Close", () => { box.replaceChildren(); done(); })];
  // (what the panel shows at the end, shown once this export no longer owns the page's state: its Export again then
  // starts a new one)
  let end: (() => Promise<void> | void) | null = null;
  const stopped = (e: unknown) => {
    const why = e instanceof ExportStopped ? (e.why === "cancelled" ? "The export was cancelled. Nothing was saved." : e.plain ? `${e.why} Nothing was saved.` : `The export stopped: ${e.why}. Nothing was saved.`) : `The export stopped: ${String((e as Error)?.message ?? e)}. Nothing was saved.`;
    return new Promise<void>((done) => { host.closed?.addEventListener("abort", () => done(), { once: true }); show(el("p", { className: "warn", textContent: why }), ...again(done)); });
  };
  // (the entries' records (E1 r2a heap plan r2c §1; astra's obligations): owned from here, before their file is opened
  // and before preflight's first record, under this export's lock; removed on every exit before any panel is shown
  // (the refusal, Cancel at ready, a stop, a Cancel), or by writing's own cleanup once it has them; Ready and a closed
  // picker keep them, for the Save… that follows)
  const rows = new Spool(`${id}-rows`, opfs ? worker : null, Number.MAX_SAFE_INTEGER, true, ac.signal);
  // (each way out of the work below breaks out of `work`, never returns: the end panel is shown after `finally`)
  try { work: {
    await host.saveOpen?.();
    show(line, " ", cancel);
    // (tests only: the r2d heap baselines are taken here, the worker started and preflight not begun)
    await (globalThis as any).__SB_EXPORT_TEST__?.beforePreflight?.();
    const plan: Plan = await preflight(w, ac.signal, progress, rows, opfs);
    if (plan.unavailable.length) { await rows.remove(); end = () => refused(plan); break work; }
    await (globalThis as any).__SB_EXPORT_TEST__?.onPlan?.(plan);
    for (;;) {
      if ((await ready(plan)) === "cancel") { await rows.remove(); box.replaceChildren(); break work; }
      // (Save…: the picker, on this click, where the browser has one; else OPFS or a Blob, chosen on the bound.  The
      // picker's writable is write()'s from the moment it exists: any failure aborts it)
      let picked: any = null;
      const T = (globalThis as any).__SB_EXPORT_TEST__;
      if (typeof (globalThis as any).showSaveFilePicker === "function" && !T?.noPicker) {
        try {
          const h = await (globalThis as any).showSaveFilePicker({ suggestedName: `sagebrush-${localDate()}.zip`, types: [{ description: "Zip archive", accept: { "application/zip": [".zip"] } }] });
          picked = await h.createWritable();
        } catch (e: any) {
          if (e?.name === "AbortError") continue; // (the picker closed: back to ready)
          throw e;
        }
      }
      show(line, " ", cancel);
      const r = await write(w, plan, { worker, opfs, id, picked, signal: ac.signal, progress, site: host.site, app: host.app, after: (p) => { after = p; }, rows });
      if (!r.stampFailed) host.stamped();
      end = () => summary(r);
      break work;
    }
  } } catch (e) {
    await rows.remove();
    end = () => stopped(e);
  } finally {
    unlisten();
    // (astra's E1 code R2: the delayed removal's own failure is this lifetime's end too, never an unhandled rejection)
    const settle = () => { worker.terminate(); release(); };
    void after.then(settle, settle);
    free();
  }
  // (the panel closed meanwhile: nothing to show, and no one to answer it)
  if (end && !host.closed?.aborted) await end();

  function summary(r: Result) {
    show(
      el("p", { textContent: `Exported ${r.name}: ${(r.members - 1).toLocaleString()} files and folders, ${fmt(r.bytes)}.` }),
      el("p", { className: "note", textContent: "Each file is in the export as it was saved when it was read. Anything saved after that isn't included." }),
      // (the archive is saved; only the "Last export prepared" line couldn't be updated: said as it is (astra's E1-A6))
      ...(r.stampFailed ? [el("p", { className: "warn", textContent: `The archive was saved, but this device couldn't record when (${r.stampFailed}), so "Last export prepared" wasn't updated.` })] : []),
      btn("Close", () => box.replaceChildren()),
    );
  }

  function refused(plan: Plan): Promise<void> {
    return new Promise((done) => {
      host.closed?.addEventListener("abort", () => done(), { once: true });
      const n = plan.unavailable.length, list = el("ul");
      for (const u of plan.unavailable.slice(0, 20)) list.append(el("li", { textContent: `${u.path} (${u.why === "remote" ? "in the cloud only" : "missing"})` }));
      if (n > 20) list.append(el("li", { textContent: `and ${(n - 20).toLocaleString()} more` }));
      show(el("p", { className: "warn", textContent: unavailableWhyText(plan.unavailable) + ":" }), list, ...again(done));
    });
  }

  function ready(plan: Plan): Promise<"save" | "cancel"> {
    return new Promise((done) => {
      // (the panel closed while it waits: as Cancel; closed before it was shown (while the save picker was open, say):
      // Cancel at once, the abort having fired already (astra3's E1 code R1a))
      if (ac.signal.aborted) { done("cancel"); return; }
      ac.signal.addEventListener("abort", () => done("cancel"), { once: true });
      show(
        el("p", { textContent: `Ready: ${plan.files.toLocaleString()} files and ${plan.folders.toLocaleString()} folders, ${fmt(plan.bytes)} before compression.` }),
        btn("Save…", () => done("save")), " ", btn("Cancel", () => done("cancel")),
      );
    });
  }
}
