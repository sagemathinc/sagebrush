// A published document, opened read only (/?tex-doc=, boot.ts; the articles' links: William, Nov 4, and @sagebrush's
// ruling): its preview and its source, nothing copied. "Edit a copy" makes the visitor's own copy, "/LaTeX
// articles/<name>.tex" (or "<name> (2).tex", ...: the first name not taken), and opens that, as an example is ("make a
// copy on first edit", as the books). Only a path of this site under /articles/ (DOC_PATH: no other origin, no "..",
// no query), read without following a redirect, at most the editor's limit of UTF-8.
// A chunk of its own, /sagebrush-latex-doc.js (page.ts's openDoc fetches it for such a link and gives it the editor's
// pieces, so nothing of the editor is bundled here twice).
import type { Workspace, Entry } from "../workspace/api";
import type { createEditor as CreateEditor } from "./editor";

export type Kit = {
  createEditor: typeof CreateEditor;
  css: string;
  printPreview(): void;
  loadPresent(): Promise<typeof import("./present")>;
  editMax: number;
};

export const DOC_PATH = /^\/articles\/[a-z0-9-]+\/[a-z0-9-]+\.tex$/;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e;
};

export async function openDoc(kit: Kit, root: HTMLElement, path: string, ws: Workspace | null, open: (e: Entry) => unknown): Promise<void> {
  if (!document.getElementById("sb-tex-style")) { const style = el("style"); style.id = "sb-tex-style"; style.textContent = kit.css; document.head.appendChild(style); }
  if (!document.getElementById("sb-katex")) {
    const link = el("link"); link.id = "sb-katex"; link.rel = "stylesheet"; link.href = new URL("katex/katex.min.css", location.href).href; document.head.appendChild(link);
  }
  root.textContent = "";
  const page = el("div", "tex-page tex-doc"); root.appendChild(page);
  const head = el("div", "tex-head"), name = path.slice(path.lastIndexOf("/") + 1);
  const title = el("span", "tex-title", name), ro = el("span", "tex-ro", "Read only");
  ro.style.cssText = "font-size:12px;padding:2px 8px;border:1px solid #c8ccc9;border-radius:10px;opacity:.8";
  const edit = el("button", "tex-edit", "Edit a copy"); edit.title = "Your own copy, in /LaTeX articles, to edit";
  const toggle = el("button", "tex-toggle", "Preview");
  const printBtn = el("button", "tex-printbtn", "Print / Save as PDF"); printBtn.onclick = () => kit.printPreview();
  const presentBtn = el("button", "tex-present-btn", "Present"); presentBtn.title = "Present the slides full screen (arrow keys; Escape stops)"; presentBtn.hidden = true;
  const status = el("span", "tex-status"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  head.append(title, ro, edit, toggle, printBtn, presentBtn, status);
  const main = el("div", "tex-main"), left = el("div", "tex-left"), right = el("div", "tex-right"), preview = el("div", "page tex-preview");
  right.appendChild(preview); main.append(left, right); page.append(head, main);
  toggle.onclick = () => { const p = page.classList.toggle("show-preview"); toggle.textContent = p ? "Source" : "Preview"; };
  const say = (t: string) => { status.textContent = t; };
  const fail = (t: string) => { say(t); edit.disabled = true; main.textContent = ""; main.appendChild(el("div", "tex-gone", t)); };
  if (!DOC_PATH.test(path)) return fail("This link isn't to a document this site publishes.");
  let text: string;
  try {
    const r = await fetch(path, { redirect: "error", credentials: "same-origin" });
    if (!r.ok) return fail("The document couldn't be read (" + r.status + ").");
    const b = await readCapped(r, kit.editMax);
    if (!b) return fail("The document is too large to open here.");
    text = new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch (e) { return fail("The document couldn't be read: " + String((e as Error)?.message ?? e)); }
  document.title = name + " (read only)";
  const E = kit.createEditor({ left, right, preview, text, readOnly: true, workerUrl: new URL("sagebrush-latex-worker.js", location.href), say });
  const slidesNow = () => Array.from(preview.querySelectorAll(":scope > .ch:not([hidden]) section.slide")) as HTMLElement[];
  let presenting: { stop(): void } | null = null;
  presentBtn.onclick = () => void kit.loadPresent().then((m) => {
    if (presenting) return;
    presenting = m.present({ slides: slidesNow, onRendered: E.onRendered, start: 1, onExit: () => { presenting = null; presentBtn.focus(); } });
  }, () => say("Couldn't load the presenter. Check the network, then click Present to try again."));
  E.onRendered(() => { presentBtn.hidden = slidesNow().length === 0; });
  if (!ws) { edit.disabled = true; edit.title = "There's no workspace in this browser to copy it into."; return; }
  edit.onclick = async () => {
    edit.disabled = true; say("Making your copy…");
    try { open(await copyDoc(ws, name, text)); }
    catch (e) { edit.disabled = false; say("The copy couldn't be made: " + String((e as Error)?.message ?? e)); }
  };
}

/** A response's body, at most `max` bytes: null past it. Read chunk by chunk, and cancelled at the chunk that crosses
 * `max`, so an oversized body is never kept or copied whole (astra, DOC656-FETCH-1); a Content-Length over `max` refuses
 * it before any read, but is only that early hint: a body without one, or longer than its header says, is counted. */
export async function readCapped(r: Response, max: number): Promise<Uint8Array | null> {
  if (Number(r.headers.get("content-length")) > max) { await r.body?.cancel().catch(() => {}); return null; }
  const parts: Uint8Array[] = [], rd = r.body?.getReader();
  let n = 0;
  for (let c; rd && !(c = await rd.read()).done; ) {
    n += c.value.length;
    if (n > max) { await rd.cancel().catch(() => {}); return null; }
    parts.push(c.value);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** The visitor's copy of a published document (Edit a copy): "/LaTeX articles/<name>.tex", or "<name> (2).tex", ... */
export async function copyDoc(ws: Workspace, name: string, text: string): Promise<Entry> {
  const dir = "/LaTeX articles", base = name.replace(/\.tex$/i, "");
  if (!(await ws.stat(dir))) await ws.mkdir(dir);
  for (let i = 1; i <= 1000; i++) {
    const p = dir + "/" + base + (i > 1 ? " (" + i + ")" : "") + ".tex";
    if (await ws.stat(p)) continue;
    return ws.createByPerson(p, { content: new TextEncoder().encode(text) });
  }
  throw new Error("no free file name");
}
