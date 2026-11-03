// `sagebrush latex check|render`: the LaTeX editor's own preview engine (web/latex/engine) on a .tex file, so that an
// agent can verify what it wrote and see it.
//   - check lists what the preview can't show or found wrong, each with its line, as text or JSON (--json).
//   - render writes the preview as one self-contained HTML file. With --png DIR it also writes one PNG per beamer
//     frame (or per page of any other document), and reports each frame whose content overflows its slide.
// The PNGs are taken by a Chromium-family browser already on this computer (Chrome, Chromium, Edge or Brave, or the
// one $CHROME names), run headless and driven over its DevTools protocol. Nothing is installed; without a browser,
// render says so and still writes the HTML.
// Built as its own file, sagebrush-latex.cjs, beside the CLI's bundle (scripts/build-cli.mjs). src/cli.ts loads it
// only for `latex`, so other commands don't carry the engine, KaTeX and its fonts.
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { basename, dirname, join, resolve, delimiter } from "path";
import { tmpdir } from "os";
import { spawn, type ChildProcess } from "child_process";
import { pathToFileURL } from "url";
import katex from "katex";
import { Engine } from "../web/latex/engine/pipeline.mjs";
import { setKatex } from "../web/latex/engine/render.mjs";
import { PAGE_CSS } from "../web/latex/style";
import { imageCandidates, sniffImage, admitImageBytes } from "../web/latex/images";

setKatex(katex.renderToString);

/** The largest .tex read (the editor's own bound on a document is far below it). */
const TEX_MAX = 4 * 2 ** 20;
/** The most PNG pages written for a document that isn't beamer's. */
const PAGES_MAX = 60;
/** A beamer slide's width in the HTML and the PNGs, in CSS pixels (its height follows the aspect ratio). */
const SLIDE_W = 1024;

export interface Problem { severity: "error" | "warning"; kind: string; name: string; line: number | null; message: string }
export interface CheckResult {
  file: string; ok: boolean; class: string; outcome: string;
  frames: { n: number; title: string; line: number | null }[];
  problems: Problem[];
  images: { name: string; found: boolean; path?: string; why?: string }[];
  code: { n: number; mode: string; state: string }[];
}

const HELP = `sagebrush latex: check and see a .tex file as Sagebrush's LaTeX editor shows it

  sagebrush latex check FILE.tex [--json]
      What the preview can't show or found wrong, each with its line number: unsupported commands and
      environments, math KaTeX can't typeset, missing images, code not run, expansion stopped. Exits 1 if
      there is an error (a warning alone exits 0).

  sagebrush latex render FILE.tex [-o OUT.html] [--png DIR] [--json]
      The preview as one self-contained HTML file (default: FILE.html beside FILE.tex). With --png DIR, one
      PNG per beamer frame (frame-01.png, ...) or per page of another document, and a report of each frame
      whose content overflows its slide. PNGs need Chrome, Chromium, Edge or Brave on this computer (or
      CHROME=/path/to/browser); nothing is installed.

Look at the PNGs after every change: they are what the reader sees.
`;

/** `sagebrush latex ...`: the exit code. */
export async function latexCommand(argv: string[]): Promise<number> {
  const cmd = argv[0];
  if (cmd === undefined || cmd === "-h" || cmd === "--help" || cmd === "help") { process.stdout.write(HELP); return cmd === undefined ? 2 : 0; }
  if (cmd !== "check" && cmd !== "render") { process.stderr.write(`sagebrush latex: no command ${JSON.stringify(cmd)} (check or render)\n\n${HELP}`); return 2; }
  const args = argv.slice(1);
  let file: string | null = null, out: string | null = null, png: string | null = null, json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") json = true;
    else if ((a === "-o" || a === "--out") && cmd === "render") { out = args[++i] ?? null; if (out === null) return usage(`${a} needs a file name`); }
    else if (a === "--png" && cmd === "render") { png = args[++i] ?? null; if (png === null) return usage("--png needs a folder"); }
    else if (a.startsWith("-")) return usage(`unknown option ${a}`);
    else if (file === null) file = a;
    else return usage(`one file only (${JSON.stringify(a)} is a second)`);
  }
  if (file === null) return usage("which .tex file?");
  let text: string;
  try {
    const st = statSync(file);
    if (!st.isFile()) return fail(`${file}: not a file`);
    if (st.size > TEX_MAX) return fail(`${file}: ${st.size} bytes, over the ${TEX_MAX} this reads`);
    text = readFileSync(file, "utf8");
  } catch (e: any) { return fail(`${file}: ${e?.code === "ENOENT" ? "no such file" : e?.message ?? e}`); }
  const { result, html } = renderTex(file, text);
  if (cmd === "check") {
    if (json) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    else process.stdout.write(checkText(result));
    return result.ok ? 0 : 1;
  }
  const htmlPath = out ?? join(dirname(file), basename(file).replace(/\.tex$/i, "") + ".html");
  writeFileSync(htmlPath, html);
  const report: any = { html: htmlPath, check: result };
  let code = 0;
  if (png !== null) {
    try { report.png = await screenshots(htmlPath, png, result); }
    catch (e: any) { report.png_error = String(e?.message ?? e); code = 1; }
  }
  if (json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  else {
    process.stdout.write(`wrote ${htmlPath}\n`);
    if (report.png) for (const p of report.png.pages) process.stdout.write(`wrote ${p.file}${p.title ? `  (frame ${p.frame}: ${p.title})` : ""}${p.overflow_px ? `  OVERFLOWS its slide by ${p.overflow_px}px` : ""}\n`);
    if (report.png_error) process.stderr.write(`sagebrush latex: no PNGs: ${report.png_error}\n`);
    const n = result.problems.length;
    if (n) process.stdout.write(`${n} problem${n === 1 ? "" : "s"} (sagebrush latex check ${file} lists them)\n`);
  }
  return code;
}

function usage(why: string): number { process.stderr.write(`sagebrush latex: ${why}\n\n${HELP}`); return 2; }
function fail(why: string): number { process.stderr.write(`sagebrush latex: ${why}\n`); return 2; }

/** The line (1-based) of a source offset, or null for none. */
function lineOf(text: string, at: number): number | null {
  if (!(at >= 0)) return null;
  let n = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < at; i = text.indexOf("\n", i + 1)) n++;
  return n;
}

const MESSAGES: Record<string, (name: string) => string> = {
  command: (n) => `\\${n} is not supported by the preview (it shows as a grey \\${n} chip)`,
  environment: (n) => `the ${n} environment is not supported by the preview (its content is shown in a plain box)`,
  "not-rendered": (n) => `${n} is not drawn by the preview (a placeholder is shown instead)`,
  math: (n) => `KaTeX can't typeset this math: ${n}`,
  runaway: (n) => `\\${n}: the paragraph ended before its argument was complete (a missing "}"?)`,
  redefined: (n) => `\\newcommand: \\${n} is already defined (LaTeX would stop here; use \\renewcommand)`,
};
const ERRORS = new Set(["math", "runaway", "redefined", "image", "expansion"]);

/** The preview of a .tex file: what check reports, and the self-contained HTML page. */
export function renderTex(file: string, text: string): { result: CheckResult; html: string } {
  // (a first pass finds the images the document names; the second has them, read from the file's own folder
  //  as the editor reads them from the workspace: imageCandidates, never outside it)
  const first = new Engine({}).update(text, { cold: true });
  const images: Record<string, string | { why: string }> = {};
  const imgReport: CheckResult["images"] = [];
  let kept = 0;
  for (const name of first.imageRefs as string[]) {
    const c = imageCandidates(name, "/" + basename(file));
    if (!c.ok) { images[name] = { why: c.why }; imgReport.push({ name, found: false, why: c.why }); continue; }
    let got: { path: string; url: string } | { why: string } = { why: "no such file in this folder" };
    for (const p of c.paths) {
      const local = join(dirname(file), p.slice(1));
      if (!existsSync(local) || !statSync(local).isFile()) continue;
      const size = statSync(local).size;
      const why = admitImageBytes(size, size, kept);
      if (why) { got = { why }; break; }
      const b = readFileSync(local);
      const s = sniffImage(new Uint8Array(b.buffer, b.byteOffset, b.byteLength));
      if (!s.ok) { got = { why: s.why }; break; }
      kept += size;
      got = { path: p.slice(1), url: `data:${s.mime};base64,${b.toString("base64")}` };
      break;
    }
    if ("url" in got) { images[name] = got.url; imgReport.push({ name, found: true, path: got.path }); }
    else { images[name] = got; imgReport.push({ name, found: false, why: got.why }); }
  }
  const r = new Engine({ images }).update(text, { cold: true });
  const problems: Problem[] = [];
  if (r.stats.outcome !== "ok") problems.push({ severity: "error", kind: "expansion", name: String(r.stats.outcome), line: null, message: `expansion stopped (${r.stats.outcome}): the preview shows the document only up to that point` });
  for (const p of r.problems as { kind: string; name: string; at: number }[]) {
    const m = MESSAGES[p.kind];
    problems.push({ severity: ERRORS.has(p.kind) ? "error" : "warning", kind: p.kind, name: p.name, line: lineOf(text, p.at), message: m ? m(p.name) : `${p.kind}: ${p.name}` });
  }
  for (const im of imgReport) if (!im.found) problems.push({ severity: "error", kind: "image", name: im.name, line: lineFind(text, im.name), message: `\\includegraphics{${im.name}}: ${im.why}` });
  const code = (r.sageItems as any[]).map((it, k) => ({ n: k + 1, mode: String(it.mode), state: it.err ? `refused: ${it.err}` : "not run" }));
  if (code.length) problems.push({ severity: "warning", kind: "code", name: String(code.length), line: null, message: `${code.length} SageTeX item${code.length === 1 ? " is" : "s are"} shown but not run by the preview` });
  problems.sort((a, b) => (a.line ?? 1e9) - (b.line ?? 1e9));
  const result: CheckResult = {
    file, ok: !problems.some((p) => p.severity === "error"), class: r.beamer ? "beamer" : "other", outcome: String(r.stats.outcome),
    frames: (r.frames as { n: number; title: string; at: number }[]).map((f) => ({ n: f.n, title: f.title, line: lineOf(text, f.at) })),
    problems, images: imgReport, code,
  };
  return { result, html: pageHtml(basename(file), r.chunks.join("\n"), !!r.beamer) };
}

/** The first line naming an image (a missing one has no position of its own). */
function lineFind(text: string, name: string): number | null {
  const i = text.indexOf("{" + name + "}");
  return i < 0 ? null : lineOf(text, i);
}

function checkText(r: CheckResult): string {
  const lines: string[] = [];
  lines.push(`${r.file}: ${r.class === "beamer" ? `beamer, ${r.frames.length} frame${r.frames.length === 1 ? "" : "s"}` : "a document"}; ${r.problems.length ? `${r.problems.length} problem${r.problems.length === 1 ? "" : "s"}` : "no problems"}`);
  for (const p of r.problems) lines.push(`${r.file}:${p.line ?? "-"}: ${p.severity}: ${p.message}`);
  return lines.join("\n") + "\n";
}

// ---- the page

/** KaTeX's stylesheet with its WOFF2 fonts inlined (the CLI's build gives them; from a checkout, node_modules). */
function katexCss(): string {
  const g = (globalThis as any).__SAGEBRUSH_LATEX_ASSETS__ as { css: string; fonts: Record<string, string> } | undefined;
  let css: string, font: (name: string) => string | null;
  if (g) { css = g.css; font = (n) => g.fonts[n] ?? null; }
  else {
    // (a path built at run time: a bundler would take a literal one for an import of the stylesheet)
    const dir = join(dirname(require.resolve(["katex", "package.json"].join("/"))), "dist");
    css = readFileSync(join(dir, "katex.min.css"), "utf8");
    font = (n) => { const p = join(dir, "fonts", n); return existsSync(p) ? readFileSync(p).toString("base64") : null; };
  }
  // (each @font-face's WOFF2 as a data: URL; its WOFF and TTF fallbacks dropped: every browser that renders this reads WOFF2)
  return css.replace(/url\(fonts\/([A-Za-z0-9_-]+\.woff2)\) format\("woff2"\)(,url\(fonts\/[^)]+\) format\("[a-z]+"\))*/g, (all, n) => {
    const b = font(n);
    return b ? `url(data:font/woff2;base64,${b}) format("woff2")` : all;
  });
}

const STANDALONE_CSS = `
body { margin: 0; background: #eef0f2; }
.tex-page.sb-standalone { position: static; display: block; min-height: 100vh; }
.sb-standalone .page.beamer { max-width: none; width: ${SLIDE_W}px; margin: 0 auto; padding: 16px; background: transparent; box-shadow: none; box-sizing: content-box; }
.sb-standalone .page.beamer > .slide { margin: 0 0 16px; }
`;

function pageHtml(name: string, body: string, beamer: boolean): string {
  const title = name.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html>\n<html><head><meta charset="utf-8"><title>${title}</title>\n` +
    // (no script runs in it and it loads nothing: its fonts and images are data: URLs, so the file is safe to open, send
    //  or publish, and safe for render's browser to draw, even without that browser's own sandbox)
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:">\n` +
    `<meta name="generator" content="sagebrush latex render">\n` +
    `<style>${katexCss()}</style>\n<style>${PAGE_CSS}</style>\n<style>${STANDALONE_CSS}</style>\n</head>\n` +
    `<body><div class="tex-page sb-standalone"><div class="page tex-preview${beamer ? " beamer" : ""}">\n${body}\n</div></div></body></html>\n`;
}

// ---- the pictures: a Chromium-family browser, headless, over its DevTools protocol

/** The browser to use: $CHROME (or $SAGEBRUSH_CHROME), else the usual places, else null. */
export function findBrowser(env = process.env, platform = process.platform): string | null {
  for (const k of ["SAGEBRUSH_CHROME", "CHROME"]) if (env[k]) return existsSync(env[k]!) ? env[k]! : null;
  const cands: string[] = [];
  if (platform === "darwin") {
    for (const app of ["Google Chrome", "Chromium", "Microsoft Edge", "Brave Browser", "Google Chrome Canary"]) {
      cands.push(`/Applications/${app}.app/Contents/MacOS/${app}`);
      if (env.HOME) cands.push(join(env.HOME, `Applications/${app}.app/Contents/MacOS/${app}`));
    }
  } else if (platform === "win32") {
    for (const base of [env["PROGRAMFILES"], env["PROGRAMFILES(X86)"], env["LOCALAPPDATA"]]) if (base) {
      cands.push(join(base, "Google", "Chrome", "Application", "chrome.exe"), join(base, "Microsoft", "Edge", "Application", "msedge.exe"),
        join(base, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"), join(base, "Chromium", "Application", "chrome.exe"));
    }
  } else {
    for (const dir of (env.PATH ?? "").split(delimiter)) if (dir) for (const b of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "microsoft-edge-stable", "brave-browser"]) cands.push(join(dir, b));
  }
  return cands.find((p) => existsSync(p)) ?? null;
}

class Cdp {
  private n = 0; private waiting = new Map<number, (m: any) => void>(); private events: ((m: any) => void)[] = [];
  constructor(private ws: WebSocket) {
    ws.onmessage = (ev: any) => {
      const m = JSON.parse(String(ev.data));
      if (m.id !== undefined && this.waiting.has(m.id)) { this.waiting.get(m.id)!(m); this.waiting.delete(m.id); }
      else if (m.method) for (const f of this.events) f(m);
    };
  }
  send(method: string, params: object = {}): Promise<any> {
    return new Promise((ok, no) => {
      const id = ++this.n;
      this.waiting.set(id, (m) => (m.error ? no(new Error(`${method}: ${m.error.message}`)) : ok(m.result)));
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  once(method: string, ms: number): Promise<void> {
    return new Promise((ok, no) => {
      const t = setTimeout(() => no(new Error(`the browser sent no ${method} in ${ms / 1000} s`)), ms);
      const f = (m: any) => { if (m.method === method) { clearTimeout(t); this.events = this.events.filter((g) => g !== f); ok(); } };
      this.events.push(f);
    });
  }
  async eval(expression: string): Promise<any> {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error("in the page: " + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
    return r.result?.value;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function screenshots(htmlPath: string, dir: string, check: CheckResult) {
  const browser = findBrowser();
  if (!browser) throw new Error("no Chrome, Chromium, Edge or Brave found (set CHROME=/path/to/it); the HTML is written: open it in a browser");
  if (typeof (globalThis as any).WebSocket !== "function") throw new Error(`this JavaScript runtime has no WebSocket (Node 22 or newer has it)`);
  mkdirSync(dir, { recursive: true });
  let proc: ChildProcess | null = null, ws: WebSocket | null = null, profile = "";
  try {
    // (where the browser's own sandbox can't start, as in many containers, once more without it: the page it draws
    //  runs no script and loads nothing, its Content-Security-Policy above)
    let port = 0, noSandbox = false;
    for (const extra of [[], ["--no-sandbox"]]) {
      profile = mkdtempSync(join(tmpdir(), "sb-latex-"));
      const r = await launch(browser, profile, extra);
      if ("port" in r) { proc = r.proc; port = r.port; noSandbox = extra.length > 0; break; }
      rmSync(profile, { recursive: true, force: true }); profile = "";
      if (extra.length) throw new Error(r.why);
    }
    const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json() as any[];
    const page = targets.find((t) => t.type === "page");
    if (!page) throw new Error("the browser has no page to draw in");
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((ok, no) => { ws!.onopen = ok; ws!.onerror = () => no(new Error("couldn't connect to the browser's DevTools")); });
    const cdp = new Cdp(ws);
    await cdp.send("Page.enable");
    const beamer = check.class === "beamer";
    const width = beamer ? SLIDE_W + 32 : 900;
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: 800, deviceScaleFactor: 1, mobile: false });
    const loaded = cdp.once("Page.loadEventFired", 30000);
    await cdp.send("Page.navigate", { url: pathToFileURL(resolve(htmlPath)).href });
    await loaded;
    await cdp.eval("document.fonts.ready.then(() => Promise.all([...document.images].map((i) => i.decode().catch(() => null)))).then(() => 1)");
    const boxes: { x: number; y: number; w: number; h: number; over: number }[] = await cdp.eval(beamer
      ? `[...document.querySelectorAll("section.slide")].map((s) => { const r = s.getBoundingClientRect(), b = s.querySelector(".slide-body");
          const over = b ? Math.max(0, Math.ceil(b.scrollHeight - b.clientHeight), Math.ceil(b.scrollWidth - b.clientWidth)) : 0;
          return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height, over }; })`
      : `(() => { const r = document.querySelector(".page").getBoundingClientRect(), H = Math.round(r.width * 1.294), out = [];
          for (let y = 0; y < r.height && out.length < ${PAGES_MAX}; y += H) out.push({ x: r.left + scrollX, y: r.top + scrollY + y, w: r.width, h: Math.min(H, r.height - y), over: 0 });
          return out; })()`);
    const pages: { file: string; frame?: number; title?: string; overflow_px?: number }[] = [];
    for (let k = 0; k < boxes.length; k++) {
      const b = boxes[k];
      const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: b.x, y: b.y, width: b.w, height: b.h, scale: 1 } });
      const f = join(dir, `${beamer ? "frame" : "page"}-${String(k + 1).padStart(2, "0")}.png`);
      writeFileSync(f, Buffer.from(shot.data, "base64"));
      const fr = beamer ? check.frames[k] : undefined;
      pages.push({ file: f, ...(fr ? { frame: fr.n, title: fr.title } : {}), ...(b.over ? { overflow_px: b.over } : {}) });
    }
    return { browser, ...(noSandbox ? { browser_sandbox: false } : {}), pages };
  } finally {
    try { ws?.close(); } catch {}
    if (proc && proc.exitCode === null) { proc.kill(); await new Promise((r) => { proc!.once("exit", r); setTimeout(r, 3000); }); }
    if (profile) rmSync(profile, { recursive: true, force: true });
  }
}

/** The browser started headless with its DevTools on a port of its choosing, or why it didn't start. */
async function launch(browser: string, profile: string, extra: string[]): Promise<{ proc: ChildProcess; port: number } | { why: string }> {
  const proc = spawn(browser, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
    "--disable-gpu", "--hide-scrollbars", "--mute-audio", "--disable-extensions", ...extra, "about:blank"], { stdio: "ignore" });
  let exited: string | null = null;
  proc.on("exit", (c, s) => { exited = `the browser (${browser}) exited (${s ?? c}) before it could take the pictures`; });
  proc.on("error", (e) => { exited = `the browser (${browser}) didn't start: ${e.message}`; });
  const portFile = join(profile, "DevToolsActivePort");
  for (let i = 0; i < 300; i++) {
    if (exited) return { why: exited };
    if (existsSync(portFile)) { const port = parseInt(readFileSync(portFile, "utf8").split("\n")[0], 10) || 0; if (port) return { proc, port }; }
    await sleep(100);
  }
  proc.kill();
  return { why: `the browser (${browser}) didn't open its DevTools port in 30 s` };
}
