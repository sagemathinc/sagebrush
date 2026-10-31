// The lazy chunk's entry (sagebrush-export.js): the export's flow inside the Storage panel (export plan E1 r2c §0).
//   Export all current files → preflight (progress, Cancel) → ready: what goes in, what isn't on this device (Fetch
//   them first / Export the rest / Cancel), Save… → written (progress, Cancel) → a summary, or one plain reason with
//   Export again.  Save… is its own click: the browser's save picker needs one.
import type { Workspace } from "../api";
import { ExportStopped, localDate, preflight, setKit, startWorker, write, type Kit, type Plan, type Progress } from "./run";

export type ExportHost = {
  say(m: string): void;
  fail(e: unknown): void;
  /** the worker's address (sagebrush-export-worker.js, beside this chunk) */
  workerUrl: string;
  /** this tab's open documents saved, first (§1) */
  saveOpen?: () => Promise<void>;
  /** "Keep on this device" for these paths, when sync is on (§2: Fetch them first); absent: not offered */
  fetchFirst?: (paths: string[]) => Promise<void>;
  /** the status line changed */
  stamped(): void;
  site: string;
  app: string;
  /** the page's own functions (run.ts Kit) */
  kit: Kit;
};

const fmt = (n: number) => (n < 2 ** 20 ? `${Math.ceil(n / 1024)} KB` : n < 2 ** 30 ? `${(n / 2 ** 20).toFixed(1)} MB` : `${(n / 2 ** 30).toFixed(2)} GB`);
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
const btn = (text: string, onclick: () => void, cls = "") => { const b = el("button", { textContent: text, className: cls }); b.onclick = onclick; return b; };

/** Runs one export in `box` (the Storage panel's export section); resolves when it ends, however it ends. */
export async function openExport(w: Workspace, host: ExportHost, box: HTMLElement): Promise<void> {
  setKit(host.kit);
  const ac = new AbortController();
  const line = el("p", { className: "note" }), cancel = btn("Cancel", () => ac.abort());
  const show = (...kids: (Node | string)[]) => box.replaceChildren(...kids);
  const progress = (p: Progress) => {
    line.textContent = p.phase === "preflight" ? `Checking… ${p.files.toLocaleString()} files · ${fmt(p.bytes)}`
      : p.phase === "writing" ? `${p.files.toLocaleString()} of ${p.of.toLocaleString()} files and folders · ${fmt(p.bytes)} written`
      : `Finishing the archive's index… ${fmt(p.bytes)} written`;
  };
  const { worker, opfs, id } = await startWorker(host.workerUrl);
  const stopped = (e: unknown) => {
    const why = e instanceof ExportStopped ? (e.why === "cancelled" ? "The export was cancelled. Nothing was saved." : `The export stopped: ${e.why}. Nothing was saved.`) : `The export stopped: ${String((e as Error)?.message ?? e)}. Nothing was saved.`;
    return new Promise<void>((done) => show(el("p", { className: "warn", textContent: why }), btn("Export again", () => { done(); void openExport(w, host, box); }), " ", btn("Close", () => { box.replaceChildren(); done(); })));
  };
  try {
    await host.saveOpen?.();
    show(line, " ", cancel);
    // (tests only: the r2d heap baselines are taken here, the worker started and preflight not begun)
    await (globalThis as any).__SB_EXPORT_TEST__?.beforePreflight?.();
    let plan: Plan = await preflight(w, ac.signal, progress);
    for (;;) {
      const go = await ready(plan);
      if (go === "cancel") { box.replaceChildren(); return; }
      if (go === "fetch") {
        show(el("p", { className: "note", textContent: "Fetching them to this device…" }));
        await host.fetchFirst!(plan.unavailable.map((u) => u.path));
        show(line, " ", cancel);
        plan = await preflight(w, ac.signal, progress);
        continue;
      }
      // (Save…: the picker, on this click, where the browser has one; else OPFS or a Blob, chosen on the bound)
      let picked: any = null;
      const T = (globalThis as any).__SB_EXPORT_TEST__;
      const name = `sagebrush-${localDate()}${go === "partial" ? "-partial" : ""}.zip`;
      if (typeof (globalThis as any).showSaveFilePicker === "function" && !T?.noPicker) {
        try {
          const h = await (globalThis as any).showSaveFilePicker({ suggestedName: name, types: [{ description: "Zip archive", accept: { "application/zip": [".zip"] } }] });
          picked = await h.createWritable();
        } catch (e: any) {
          if (e?.name === "AbortError") continue; // (the picker closed: back to ready)
          throw e;
        }
      }
      show(line, " ", cancel);
      const r = await write(w, plan, { partial: go === "partial" }, { worker, opfs, id, picked, signal: ac.signal, progress, site: host.site, app: host.app });
      host.stamped();
      show(
        el("p", { textContent: `Exported ${r.name}: ${(r.members - 1).toLocaleString()} files and folders, ${fmt(r.bytes)}.` }),
        el("p", { className: "note", textContent: "Each file is in the export as it was saved when it was read. Anything saved after that isn't included." }),
        ...(r.omitted ? [el("p", { className: "warn", textContent: `${r.omitted.toLocaleString()} files were not on this device and are not in this export.` })] : []),
        btn("Close", () => box.replaceChildren()),
      );
      return;
    }
  } catch (e) {
    await stopped(e);
  } finally {
    worker.terminate();
  }

  function ready(plan: Plan): Promise<"save" | "partial" | "fetch" | "cancel"> {
    return new Promise((done) => {
      const what = el("p", { textContent: `Ready: ${plan.files.toLocaleString()} files and ${plan.folders.toLocaleString()} folders, ${fmt(plan.bytes)} before compression.` });
      if (!plan.unavailable.length) return show(what, btn("Save…", () => done("save")), " ", btn("Cancel", () => done("cancel")));
      const n = plan.unavailable.length, list = el("ul");
      for (const u of plan.unavailable.slice(0, 20)) list.append(el("li", { textContent: `${u.path} (${u.why === "remote" ? "in the cloud only" : "missing"})` }));
      if (n > 20) list.append(el("li", { textContent: `and ${(n - 20).toLocaleString()} more` }));
      show(
        what,
        el("p", { className: "warn", textContent: `${n.toLocaleString()} file${n === 1 ? " isn't" : "s aren't"} on this device, so ${n === 1 ? "it" : "they"} can't be exported from here:` }),
        list,
        ...(host.fetchFirst && plan.unavailable.some((u) => u.why === "remote") ? [btn("Fetch them first", () => done("fetch")), " "] : []),
        btn("Export the rest", () => done("partial")),
        " ",
        btn("Cancel", () => done("cancel")),
      );
    });
  }
}
