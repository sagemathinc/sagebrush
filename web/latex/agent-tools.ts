// The LaTeX page's tools for an agent in the browser (WebMCP, navigator.modelContext), so that it can verify what it
// wrote and see it, as `sagebrush latex check|render` does on a computer (src/latex-cli.ts):
//   - latex_check: what the preview can't show or found wrong, each with its line (check.ts, the CLI's report);
//   - latex_render: each beamer frame (or each page of another document) as a PNG image, as the preview draws it,
//     and every frame whose content overflows its slide.
// Registered once per page; they act on the document the LaTeX page has open (setTarget), else say none is.
// This is only their names, descriptions and arguments; their work (the report, the pictures) is tools.ts, a chunk of
// its own, /sagebrush-latex-tools.js, fetched on the first call.
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

const DEFAULT_SHOTS = 12;
// (a failed fetch is forgotten, so the next call fetches again, by a URL of its own)
const toolsUrl = new URL("sagebrush-latex-tools.js", import.meta.url).href;
let work: Promise<typeof import("./tools")> | null = null, tries = 0;
const load = () => (work ??= (import(tries++ ? `${toolsUrl}?try=${tries}` : toolsUrl) as Promise<typeof import("./tools")>).catch((e) => { work = null; throw e; }));
let target: ToolTarget | null = null;
let registered = false;

/** The document the tools act on (null: none is open). */
export function setTarget(t: ToolTarget | null) { target = t; }
/** No document, if `t` is still the one (a page replaced by the next one's mount leaves that one's). */
export function clearTarget(t: ToolTarget) { if (target === t) target = null; }

type Content = ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
const text = (s: string): { content: Content } => ({ content: [{ type: "text", text: s }] });
const NONE = "No LaTeX document is open in this page: open a .tex file first.";

/** The preview of the source as it is now: waits for the reply (and its patch) to an edit made just before. */
async function settled(t: ToolTarget, ms = 15000): Promise<boolean> {
  await t.refresh?.();
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    if (t.current() && t.lastCheck()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

export function registerLatexTools() {
  if (registered) return;
  registered = true;
  const tools = [
    {
      name: "latex_check",
      description: "Check the open LaTeX document as Sagebrush's preview shows it: every unsupported command or environment, math KaTeX can't typeset, missing image and stopped expansion, each with its line number, plus the beamer frames (number, title, line). Run it after every change; then latex_render to look.",
      inputSchema: { type: "object", properties: { format: { type: "string", enum: ["json", "text"], description: "json (default) or compiler-style lines" } } },
      async execute({ format }: { format?: string } = {}) {
        const t = target;
        if (!t) return text(NONE);
        if (!(await settled(t))) return text("The preview hasn't caught up with the source yet: try again in a moment.");
        try { return (await load()).latexCheck(t, format); }
        catch (e) { return text("Couldn't load the check: " + String((e as Error)?.message ?? e)); }
      },
    },
    {
      name: "latex_render",
      description: "See the open LaTeX document as the reader does: each beamer frame as a PNG image (or each page of another document), as Sagebrush's preview draws it, with every frame whose content overflows its slide named. Look at the images after every change.",
      inputSchema: {
        type: "object",
        properties: {
          frames: { type: "array", items: { type: "number" }, description: `Frame (or page) numbers, from 1; default the first ${DEFAULT_SHOTS}` },
          steps: { type: "boolean", description: "Each frame at each of its overlay steps (\\pause, <2->, \\only), as Present shows them; default false: all steps at once, as the preview shows them" },
        },
      },
      async execute({ frames, steps }: { frames?: number[]; steps?: boolean } = {}) {
        const t = target;
        if (!t) return text(NONE);
        if (!(await settled(t))) return text("The preview hasn't caught up with the source yet: try again in a moment.");
        try { return await (await load()).latexRender(t, frames, steps); }
        catch (e) { return text("Couldn't draw the pictures: " + String((e as Error)?.message ?? e)); }
      },
    },
  ];
  try {
    const mc = (navigator as any).modelContext;
    if (mc?.registerTool) for (const tool of tools) mc.registerTool(tool);
    else if (mc?.provideContext) mc.provideContext({ tools });
  } catch (e) {
    console.warn("WebMCP (LaTeX):", e);
  }
}

