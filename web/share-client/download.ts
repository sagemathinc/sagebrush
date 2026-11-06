// File > Download "with its files (.zip)" (dependencies 2b): Share's picker (picker.ts), the files the notebook uses
// pre-checked with why, and one button that downloads the notebook and the checked files as one .zip.  The notebook
// goes in as Download's own .ipynb bytes, each file as its workspace bytes, read at the click; the .zip is written in
// the export's lazy chunk (export/selected.ts), loaded only then.
//
// Names in the .zip: the notebook's folder is the .zip's root when every checked file is inside it (a helper imported
// as _code/helpers.py lands there, and the notebook runs where it is unpacked); else every file has its workspace path.
// The selection, the notebook's bytes and its path are taken at the click, the path looked up then and the notebook
// checked after it (a rename or a switch before the click can't leave a stale path: astra's DEP2B-OPEN-ID-1,
// daybreak3's A->B->A); the notebook is checked again before every read, and each file's read refuses one that is no
// longer the file listed (its fid).  Closing the dialog, or a switch of notebooks, stops the download.
import { createPicker, type PickerHost } from "./picker";

export interface DownloadDialogHost extends Omit<PickerHost, "notebook"> {
  dlg: HTMLDialogElement;
  /** the notebook: its file name, and its Download bytes */
  notebook: () => { path: string; data: Uint8Array };
  /** its workspace path now, without the leading /, or null (not in the workspace): looked up at the click */
  notebookPath: () => Promise<string | null>;
  /** one file's bytes; throws if it is no longer the file listed (fid) */
  readFile: (f: { path: string; fid?: string }) => Promise<Uint8Array>;
  /** the .zip written and handed to the browser (the export chunk's zipPicks); throws to say why it wasn't */
  zip: (o: { picks: { name: string; read(): Promise<Uint8Array> }[]; name: string; signal: AbortSignal; progress(done: number, of: number): void }) => Promise<void>;
}

const $ = (root: ParentNode, sel: string) => root.querySelector(sel) as HTMLElement;
export function createDownloadDialog(h: DownloadDialogHost) {
  const d = h.dlg;
  const btn = $(d, "#dldepsgo") as HTMLButtonElement, prog = $(d, "#dldepsprogress"), out = $(d, "#dldepsresult");
  let busy: AbortController | null = null;
  const picker = createPicker(d, "dldeps", { ...h, notebook: () => { const nb = h.notebook(); return { path: nb.path, size: nb.data.length }; } }, () => !!busy, (s) => (btn.disabled = !!busy || !!s.over));
  const setBusy = (b: AbortController | null) => {
    busy = b;
    btn.textContent = b ? "Preparing…" : "Download .zip";
    for (const id of ["#dldepsall", "#dldepsnone"]) ($(d, id) as HTMLButtonElement).disabled = !!b;
    picker.draw();
  };
  // (closing stops a download in progress: nothing is handed over)
  d.addEventListener("close", () => {
    if (d.open) return;
    busy?.abort();
    picker.reset();
  });

  btn.addEventListener("click", async () => {
    if (!picker.selection || busy) return;
    if (!picker.mine()) {
      out.textContent = "The notebook changed since this was opened: open it again.";
      return;
    }
    const nb = h.notebook(), nbId = picker.notebook;
    const { snap } = picker.take();
    const ac = new AbortController();
    setBusy(ac);
    out.textContent = "";
    try {
      const where = await h.notebookPath();
      if (ac.signal.aborted) throw new Error("cancelled");
      if (h.notebookId() !== nbId) throw new Error("the notebook changed");
      const notebookPath = "/" + (where ?? nb.path), folder = notebookPath.slice(0, notebookPath.lastIndexOf("/") + 1);
      const inside = folder !== "/" && snap.every((r) => r.notebook || r.path.startsWith(folder));
      const nameOf = (p: string) => p.slice(inside ? folder.length : 1);
      await h.zip({
        picks: snap.map((r) => ({
          name: nameOf(r.notebook ? notebookPath : r.path),
          read: async () => {
            // (the notebook it was opened for, still: never another's files with this one's)
            if (h.notebookId() !== nbId) throw new Error("the notebook changed");
            return r.notebook ? nb.data : h.readFile(r);
          },
        })),
        name: nb.path.slice(nb.path.lastIndexOf("/") + 1).replace(/\.ipynb$/i, "") + ".zip",
        signal: ac.signal,
        progress: (done, of) => (prog.textContent = `${done} of ${of} files`),
      });
      out.textContent = `Downloaded ${snap.length} file${snap.length === 1 ? "" : "s"} as one .zip.`;
    } catch (e: any) {
      const why = e?.why ?? e?.message ?? String(e);
      out.textContent = why === "cancelled" ? "Stopped: nothing was downloaded." : /\.$/.test(why) ? `${why} Nothing was downloaded.` : `The download stopped: ${why}. Nothing was downloaded.`;
    } finally {
      prog.textContent = "";
      picker.selection?.thaw();
      setBusy(null);
    }
  });

  return {
    async open() {
      out.textContent = "";
      if (!d.open) d.showModal();
      await picker.open("it");
    },
    /** a switch of notebooks: this notebook's open ends, a download in progress with it */
    invalidate() {
      busy?.abort();
      picker.reset();
      if (d.open) d.close();
    },
    get selection() {
      return picker.selection;
    },
    get analyzing() {
      return picker.analyzing;
    },
    get generation() {
      return picker.generation;
    },
    get busy() {
      return !!busy;
    },
  };
}
