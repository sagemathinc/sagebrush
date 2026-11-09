// The code page's entry from the notebook page (index.html), in the page's own script and so kept small (1a). It
// installs the two hooks the file browser and the preview call: __sbCode (a .py, .sage, .m, .mag, .js, .json or .txt
// row with a fid opens /?code=<fid>, true if it took the file) and __sbCodeP (the preview's "Open" button); and, for
// /?code=<fid>, fetches the page module (dist/sagebrush-code.js, a lazy chunk) and mounts it.
import type { Workspace, Entry } from "../workspace/api";
import { langOf } from "./langs";
import { codeUrl } from "./url";
import { openFilesDialog } from "../workspace/fileopen";
import { openGallery } from "../examples/open";
import { renderFileMenu } from "../workspace/filemenu";

const isCode = (e: Entry) => e.kind === "file" && langOf(e.path) !== null;

/** Called once by the notebook page; true if the code page took the page over. `open`: the page's own way to open a
 * notebook, a board or a file chosen from the code page (Open…, a copy). */
export async function codeBoot(ws: Workspace | null, open: (e: Entry, how: "here" | "tab") => void, agent: ((back: HTMLElement) => Promise<unknown>) | null = null): Promise<boolean> {
  const g: any = globalThis;
  g.__sbCode = (e: Entry, tab?: boolean) => {
    if (!isCode(e) || !e.fid) return false;
    tab ? window.open(codeUrl(e.fid), "_blank", "noopener") : location.assign(codeUrl(e.fid));
    return true;
  };
  g.__sbCodeP = (e: Entry, box: HTMLElement) => {
    if (!isCode(e)) return;
    const b = document.createElement("button");
    b.textContent = "Open";
    b.title = "Open this file: View, or ✎ Edit";
    if (e.fid) b.onclick = () => g.__sbCode(e);
    else { b.disabled = true; b.title = "This file can't open on its own page yet: it hasn't been given a stable id"; }
    box.append(b);
  };
  const fid = new URLSearchParams(location.search).get("code");
  if (fid === null) return false;
  if (!ws || !/^[\w-]{1,128}$/.test(fid)) {
    const d = document.createElement("p");
    d.textContent = ws ? "This isn't a file's address." : "Your files can't be opened in this browser, so this file can't be shown.";
    document.body.prepend(d);
    return false;
  }
  const root = document.createElement("div");
  document.body.append(root);
  // (the page module, from the site's root, where this page is: a variable, so the bundler leaves it to the browser)
  const page = new URL("/sagebrush-code.js", location.href).href;
  // (a file opened from the page (a copy) is the code page's, the rest (a notebook, a board) the notebook page's)
  const go = (e: Entry, how: "here" | "tab") => { if (e.kind !== "file") open(e, how); else g.__sbCode(e, how === "tab"); };
  await (await import(page)).mount(root, { ws, fid, open: go, openFiles: () => openFilesDialog(ws, go), examples: () => openGallery(ws, (e) => go(e, "here")), renderFileMenu, agent });
  return true;
}
