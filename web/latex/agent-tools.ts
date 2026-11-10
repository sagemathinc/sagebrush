// The LaTeX page's tools for an agent in the browser (WebMCP, navigator.modelContext), so that it can verify what it
// wrote and see it, as `sagebrush latex check|render` does on a computer (src/latex-cli.ts):
//   - latex_check: what the preview can't show or found wrong, each with its line (check.ts, the CLI's report);
//   - latex_render: each beamer frame (or each page of another document) as a PNG image, as the preview draws it,
//     and every frame whose content overflows its slide.
// Registered once per page; they act on the document the LaTeX page has open (setTarget), else say none is.
// This is only the document they act on: the tools themselves (their names, descriptions and arguments) and their
// work (the report, the pictures) are tools.ts, a chunk of its own, /sagebrush-latex-tools.js, fetched only where the
// browser offers WebMCP (an agent's browser): an ordinary one never fetches it (the eager group full: William's H5).
import type { EngineCheck } from "./check";

export interface ToolTarget {
  file: () => string;
  text: () => string;
  /** The check data of the preview shown, if it is of the source now in the editor; else null (one is coming). */
  lastCheck: () => EngineCheck | null;
  /** Whether the preview shown is of the source now in the editor. */
  current: () => boolean;
  preview: HTMLElement;
  images: Record<string, string | { why: string }>;
  /** The page's own styles (style.ts PAGE_CSS), for the pictures. */
  css: string;
  /** Read the code's saved results again (a `sagebrush latex run` may have written them since). */
  refresh?: () => Promise<void>;
}

// (a failed fetch is forgotten, so the next page's mount fetches again, by a URL of its own)
const toolsUrl = new URL("sagebrush-latex-tools.js", import.meta.url).href;
let work: Promise<typeof import("./tools")> | null = null, tries = 0;
const load = () => (work ??= (import(tries++ ? `${toolsUrl}?try=${tries}` : toolsUrl) as Promise<typeof import("./tools")>).catch((e) => { work = null; throw e; }));
let target: ToolTarget | null = null;
let registered = false;

/** The document the tools act on (null: none is open). */
export function setTarget(t: ToolTarget | null) { target = t; }
/** No document, if `t` is still the one (a page replaced by the next one's mount leaves that one's). */
export function clearTarget(t: ToolTarget) { if (target === t) target = null; }

/** The tools registered with the browser's WebMCP, if it has it: once, the chunk fetched first. */
export function registerLatexTools() {
  if (registered || !(navigator as any).modelContext) return;
  registered = true;
  load().then((m) => m.register(() => target), (e) => { registered = false; console.warn("WebMCP (LaTeX):", e); });
}
