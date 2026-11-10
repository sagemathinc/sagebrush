// The LaTeX page's agent tools, latex_check and latex_render, and their work: a chunk of its own,
// /sagebrush-latex-tools.js, fetched only where the browser offers WebMCP (agent-tools.ts): latex_check's report (check.ts, as `sagebrush latex check` makes it)
// and latex_render's pictures. Each slide is copied into a box off the screen at the PNGs' width and measured there,
// then drawn onto a canvas from an SVG whose foreignObject holds the copy with the page's styles, KaTeX's (its fonts
// as data: URLs) and its images as data: URLs: an SVG drawn as an image loads nothing.
import { checkResult, checkText, type CheckResult } from "./check";
import type { ToolTarget } from "./agent-tools";
import { applyStep, stepsOf } from "./overlay";

type Content = ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
const SLIDE_W = 1024, PAGE_W = 816, MAX_SHOTS = 40;
export const DEFAULT_SHOTS = 12;

function report(t: ToolTarget): CheckResult | null {
  const c = t.lastCheck();
  if (!c) return null;
  const imgs = Object.entries(t.images).map(([name, v]) => (typeof v === "string" ? { name, found: true } : { name, found: false, why: v.why }));
  return checkResult(t.file(), t.text(), c, imgs);
}

export function latexCheck(t: ToolTarget, format?: string): { content: Content } {
  const r = report(t)!;
  return { content: [{ type: "text", text: format === "text" ? checkText(r) : JSON.stringify(r) }] };
}

export async function latexRender(t: ToolTarget, frames?: number[], steps?: boolean): Promise<{ content: Content }> { return shots(t, frames, !!steps); }

let katexCss: Promise<string> | null = null;
const dataUrl = async (blob: Blob) => await new Promise<string>((ok, no) => { const f = new FileReader(); f.onload = () => ok(String(f.result)); f.onerror = () => no(f.error); f.readAsDataURL(blob); });
/** KaTeX's stylesheet as the page has it, its fonts (WOFF2) as data: URLs: an SVG drawn as an image loads nothing. */
function katexStyles(): Promise<string> {
  return (katexCss ??= (async () => {
    const url = new URL("katex/katex.min.css", location.href);
    const css = await (await fetch(url)).text();
    const names = [...new Set([...css.matchAll(/url\((fonts\/[A-Za-z0-9_-]+\.woff2)\)/g)].map((m) => m[1]))];
    const urls = new Map<string, string>();
    await Promise.all(names.map(async (n) => { try { urls.set(n, await dataUrl(await (await fetch(new URL(n, url))).blob())); } catch {} }));
    return css.replace(/url\((fonts\/[A-Za-z0-9_-]+\.woff2)\) format\("woff2"\)(,url\(fonts\/[^)]+\) format\("[a-z]+"\))*/g, (all, n) => (urls.has(n) ? `url(${urls.get(n)}) format("woff2")` : all));
  })().catch((e) => { katexCss = null; throw e; }));
}

// (the copy's box: the page's .tex-page rules apply to it, placed off the screen; inside the SVG, in its own flow)
const SHOT_CSS = `
.tex-page.sb-off { position: fixed; inset: auto; left: -30000px; top: 0; display: block; background: #fff; }
.tex-page.sb-shot { display: block; background: #fff; }
.sb-shot .page.tex-preview { margin: 0; box-shadow: none; }
.sb-shot .page.beamer { max-width: none; width: ${SLIDE_W}px; padding: 0; background: transparent; }
.sb-shot .page.beamer > .slide { margin: 0; border: none; box-shadow: none; }
.sb-shot .pc, .sb-shot .ch { content-visibility: visible !important; }
`;

async function shots(t: ToolTarget, want?: number[], steps = false): Promise<{ content: Content }> {
  const live = [...t.preview.querySelectorAll(":scope > .ch:not([hidden]) section.slide")] as HTMLElement[];
  const beamer = live.length > 0;
  const css = t.css + (await katexStyles()) + SHOT_CSS;
  const host = document.createElement("div");
  host.className = "tex-page sb-shot sb-off";
  const page = document.createElement("div");
  page.className = "page tex-preview" + (beamer ? " beamer" : "");
  host.appendChild(page);
  const style = document.createElement("style"); style.textContent = SHOT_CSS;
  document.head.appendChild(style); document.body.appendChild(host);
  try {
    // (the copy's images as data: URLs: the page's are blob: URLs, which an SVG image can't load)
    const inline = async (root: HTMLElement) => {
      for (const img of root.querySelectorAll("img")) {
        const src = img.getAttribute("src") || "";
        if (src.startsWith("blob:")) { try { img.setAttribute("src", await dataUrl(await (await fetch(src)).blob())); } catch { img.removeAttribute("src"); } }
      }
      await Promise.all([...root.querySelectorAll("img")].map((i) => (i as HTMLImageElement).decode().catch(() => null)));
    };
    const out: Content = [];
    const info: { n: number; step?: number; steps?: number; title?: string; overflow_px?: number }[] = [];
    const check = report(t);
    if (beamer) {
      const nums = (want && want.length ? want : live.map((_, k) => k + 1).slice(0, DEFAULT_SHOTS)).filter((n) => n >= 1 && n <= live.length).slice(0, MAX_SHOTS);
      // (steps: each frame at each of its overlay steps, as the presenter shows them, overlay.ts; else all at once,
      //  as the preview shows them)
      for (const n of nums) {
        const copy = live[n - 1].cloneNode(true) as HTMLElement;
        copy.removeAttribute("id");
        page.textContent = ""; page.appendChild(copy);
        await inline(copy); await document.fonts.ready;
        const all = stepsOf(copy);
        for (let s = 1; s <= (steps ? all : 1) && out.length < MAX_SHOTS; s++) {
          if (steps) applyStep(copy, s);
          const body = copy.querySelector(".slide-body") as HTMLElement | null;
          const over = body ? Math.max(0, Math.ceil(body.scrollHeight - body.clientHeight), Math.ceil(body.scrollWidth - body.clientWidth)) : 0;
          const h = Math.round(copy.getBoundingClientRect().height);
          out.push(await draw(page, css, SLIDE_W, h, 0));
          info.push({ n, ...(steps ? { step: s } : {}), steps: all, ...(check?.frames[n - 1]?.title ? { title: check.frames[n - 1].title } : {}), ...(over ? { overflow_px: over } : {}) });
        }
      }
    } else {
      for (const ch of t.preview.querySelectorAll(":scope > .ch:not([hidden])")) page.appendChild(ch.cloneNode(true));
      page.style.width = PAGE_W + "px"; page.style.maxWidth = "none";
      await inline(page); await document.fonts.ready;
      const H = Math.round(page.getBoundingClientRect().height), ph = Math.round(PAGE_W * 1.294);
      const count = Math.max(1, Math.ceil(H / ph));
      const nums = (want && want.length ? want : Array.from({ length: count }, (_, k) => k + 1).slice(0, DEFAULT_SHOTS)).filter((n) => n >= 1 && n <= count).slice(0, MAX_SHOTS);
      for (const n of nums) { out.push(await draw(page, css, PAGE_W, Math.min(ph, H - (n - 1) * ph), (n - 1) * ph)); info.push({ n }); }
    }
    const total = beamer ? live.length : info.length;
    const summary = { file: t.file(), class: beamer ? "beamer" : "other", [beamer ? "frames" : "pages"]: total, shown: info,
      overflowing: [...new Set(info.filter((x) => x.overflow_px).map((x) => x.n))], problems: check?.problems.length ?? 0 };
    return { content: [{ type: "text", text: JSON.stringify(summary) }, ...out] };
  } finally {
    host.remove(); style.remove();
  }
}

/** The element's copy drawn as a PNG: w x h CSS pixels of it, from y down. */
async function draw(el: HTMLElement, css: string, w: number, h: number, y: number): Promise<{ type: "image"; data: string; mimeType: string }> {
  const xhtml = new XMLSerializer().serializeToString(el);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 ${y} ${w} ${h}"><foreignObject x="0" y="0" width="${w}" height="${y + h}">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" class="tex-page sb-shot" style="position:static;width:${w}px"><style><![CDATA[${css.replace(/]]>/g, "]] >")}]]></style>${xhtml}</div></foreignObject></svg>`;
  const img = new Image();
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return { type: "image", data: canvas.toDataURL("image/png").split(",")[1], mimeType: "image/png" };
}

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

/** The tools, registered with the browser's WebMCP; `get`: the document they act on now. */
export function register(get: () => ToolTarget | null) {
  const tools = [
    {
      name: "latex_check",
      description: "Check the open LaTeX document as Sagebrush's preview shows it: every unsupported command or environment, math KaTeX can't typeset, missing image and stopped expansion, each with its line number, plus the beamer frames (number, title, line). Run it after every change; then latex_render to look.",
      inputSchema: { type: "object", properties: { format: { type: "string", enum: ["json", "text"], description: "json (default) or compiler-style lines" } } },
      async execute({ format }: { format?: string } = {}) {
        const t = get();
        if (!t) return text(NONE);
        if (!(await settled(t))) return text("The preview hasn't caught up with the source yet: try again in a moment.");
        return latexCheck(t, format);
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
        const t = get();
        if (!t) return text(NONE);
        if (!(await settled(t))) return text("The preview hasn't caught up with the source yet: try again in a moment.");
        try { return await latexRender(t, frames, steps); }
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
