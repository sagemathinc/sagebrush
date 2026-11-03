// `sagebrush latex check|render` (src/latex-cli.ts, built as build/cli/sagebrush-latex.cjs) on real files in a temp
// folder, through the CLI's own bundle: what an agent runs to verify a .tex and see it. Check's problems and their
// lines, frames, images and exit codes; render's HTML (self-contained, no script); beamer frames as slides (titles,
// [t], plain, \frame{}, aspectratio), overlays all shown; and, with a Chromium-family browser, one PNG per frame and
// an overflowing frame reported.
//   node scripts/build-cli.mjs && node web/latex/test-latex-cli.mjs
//   (CHROME=/path/to/chrome for the PNGs; LATEX_CLI_PNG=1 makes a missing browser a failure, not a skip)
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const CLI = new URL("../../build/cli/pyjs.cjs", import.meta.url).pathname;
if (!existsSync(CLI) || !existsSync(new URL("../../build/cli/sagebrush-latex.cjs", import.meta.url).pathname)) {
  console.log("FAIL: no build/cli/pyjs.cjs and sagebrush-latex.cjs: run node scripts/build-cli.mjs first");
  process.exit(1);
}
const run = (cwd, ...a) => new Promise((res) => {
  const p = spawn(process.execPath, [CLI, "latex", ...a], { cwd });
  let o = "", e = "";
  p.stdout.on("data", (d) => (o += d)); p.stderr.on("data", (d) => (e += d));
  p.on("close", (code) => { let json = null; try { json = JSON.parse(o); } catch {} res({ code, out: o, err: e, json }); });
});
const results = [];
const check = (name, ok, detail) => { results.push([name, !!ok]); if (!ok) console.log("FAIL", name, JSON.stringify(detail)?.slice(0, 900)); };
const dir = mkdtempSync(join(tmpdir(), "sb-latex-cli-"));

const TALK = String.raw`\documentclass[aspectratio=169]{beamer}
\usetheme{Madrid}
\title{Dynamics in pictures}
\author{A. Speaker}
\institute{Somewhere University}
\date{November 2026}
\begin{document}
\frame{\titlepage}
\begin{frame}{Overlays}
\begin{itemize}
\item<1-> First, the question.
\item<2-> Then, an \alert{idea}.
\end{itemize}
\pause
\only<3>{Only on three.}
\end{frame}
\begin{frame}[t]
\frametitle{A block and a picture}
\framesubtitle{with a subtitle}
\begin{block}{Theorem}
For every $n \ge 1$, $\sum_{k=1}^n k = \frac{n(n+1)}{2}$.
\end{block}
\begin{columns}
\begin{column}{0.5\textwidth}
\includegraphics[width=0.8\textwidth]{wave}
\end{column}
\begin{column}{0.5\textwidth}
\includegraphics{missing.png}
\end{column}
\end{columns}
\end{frame}
\begin{frame}{Too much}
\begin{itemize}
\item a \item b \item c \item d \item e \item f \item g \item h \item i \item j \item k \item l \item m
\end{itemize}
\end{frame}
\begin{frame}[plain]{Not shown}
\begin{weirdenv}inside\end{weirdenv}
\begin{tikzpicture}\draw (0,0) -- (1,1);\end{tikzpicture}
\includegraphics{../outside.png}

\mystery{x} and $\frac{1}{$ there.
\end{frame}
\end{document}
`;
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" width="200" height="100"><path d="M0 50 Q25 0 50 50 T100 50 T150 50 T200 50" fill="none" stroke="#c00" stroke-width="3"/></svg>`;
const CLEAN = String.raw`\documentclass{beamer}
\begin{document}
\begin{frame}{One}
Hello $x^2$.
\end{frame}
\end{document}
`;
const ARTICLE = String.raw`\documentclass{article}
\begin{document}
\section{Intro}
Text. \begin{frame}{Not a slide}here\end{frame}
\end{document}
`;
writeFileSync(join(dir, "talk.tex"), TALK); writeFileSync(join(dir, "wave.svg"), SVG);
writeFileSync(join(dir, "clean.tex"), CLEAN); writeFileSync(join(dir, "article.tex"), ARTICLE);
const lineOf = (text, needle) => text.slice(0, text.indexOf(needle)).split("\n").length;

try {
  // ---- check
  const c = await run(dir, "check", "talk.tex", "--json");
  const j = c.json;
  check("check-json-exit-1-on-errors", c.code === 1 && j && j.ok === false && j.class === "beamer", { code: c.code, err: c.err });
  check("check-frames", j.frames.length === 5 && j.frames.map((f) => f.title).join("|") === "|Overlays|A block and a picture|Too much|Not shown"
    && j.frames[1].line === lineOf(TALK, "\\begin{frame}{Overlays}") && j.frames[0].line === lineOf(TALK, "\\frame{\\titlepage}"), j.frames);
  const p = (kind, name) => j.problems.find((x) => x.kind === kind && (name === undefined || x.name === name));
  check("check-missing-image-error-with-line", p("image", "missing.png")?.severity === "error" && p("image", "missing.png").line === lineOf(TALK, "{missing.png}"), j.problems);
  check("check-outside-image-refused", p("image", "../outside.png")?.severity === "error" && /outside this folder/.test(p("image", "../outside.png").message), j.problems);
  check("check-unknown-command-warning-with-line", p("command", "mystery")?.severity === "warning" && p("command", "mystery").line === lineOf(TALK, "\\mystery"), j.problems);
  check("check-math-error", p("math")?.severity === "error" && p("math").line === lineOf(TALK, "\\mystery"), j.problems);
  check("check-unknown-environment", p("environment", "weirdenv")?.severity === "warning" && p("environment", "weirdenv").line === lineOf(TALK, "\\begin{weirdenv}"), j.problems);
  check("check-tikz-not-rendered", p("not-rendered", "tikzpicture")?.severity === "warning", j.problems);
  check("check-beamer-commands-known", !j.problems.some((x) => ["usetheme", "institute", "alert", "only", "pause", "frametitle", "framesubtitle"].includes(x.name)), j.problems);
  check("check-images-report", j.images.find((i) => i.name === "wave")?.found === true && j.images.find((i) => i.name === "wave").path === "wave.svg", j.images);
  check("check-problems-in-line-order", j.problems.every((x, k, a) => k === 0 || (a[k - 1].line ?? 1e9) <= (x.line ?? 1e9)), j.problems.map((x) => x.line));
  const ct = await run(dir, "check", "talk.tex");
  check("check-text-lines", ct.code === 1 && ct.out.includes(`talk.tex:${lineOf(TALK, "{missing.png}")}: error: \\includegraphics{missing.png}`) && /^talk\.tex: beamer, 5 frames; \d+ problems/.test(ct.out), ct.out);
  const cc = await run(dir, "check", "clean.tex");
  check("check-clean-exit-0", cc.code === 0 && cc.out.startsWith("clean.tex: beamer, 1 frame; no problems"), cc);
  const ca = await run(dir, "check", "article.tex", "--json");
  check("check-article-has-no-frames", ca.code === 0 && ca.json.class === "other" && ca.json.frames.length === 0 && ca.json.problems.some((x) => x.kind === "environment" && x.name === "frame"), ca.json);

  // ---- render: one self-contained HTML file
  const r = await run(dir, "render", "talk.tex", "-o", "out.html", "--json");
  const html = existsSync(join(dir, "out.html")) ? readFileSync(join(dir, "out.html"), "utf8") : "";
  check("render-writes-html", r.code === 0 && r.json?.html === "out.html" && html.startsWith("<!doctype html>"), r);
  check("render-html-no-script-and-csp", !/<script/i.test(html) && html.includes(`content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:"`), html.slice(0, 400));
  check("render-html-fonts-inlined", /@font-face\{[^}]*url\(data:font\/woff2;base64,/.test(html) && !/url\(fonts\//.test(html), html.match(/@font-face\{[^}]{0,200}/)?.[0]);
  check("render-image-inlined", html.includes('src="data:image/svg+xml;base64,') && html.includes("[image: missing.png: no such file in this folder]"), null);
  const slides = [...html.matchAll(/<section class="slide([^"]*)" data-frame="(\d+)"[^>]*style="([^"]*)"/g)];
  check("render-slides", slides.length === 5 && slides.every((m) => m[3].startsWith("aspect-ratio:160/90;--sfs:")) && slides[2][1] === " va-t", slides.map((m) => m.slice(1)));
  check("render-frame-titles", html.includes('<header class="slide-title">Overlays</header>') && html.includes('<header class="slide-title">A block and a picture<div class="slide-subtitle">with a subtitle</div></header>')
    && !html.includes("Not shown</header>"), null);
  check("render-overlays-all-shown", html.includes("Only on three.") && html.includes('<span class="alert">idea</span>') && !html.includes(">\\only<"), null);
  check("render-beamer-block-and-title", html.includes('<div class="bblock block"><div class="bblock-title">Theorem</div>') && html.includes('<div class="institute">Somewhere University</div>'), null);
  const d = await run(dir, "render", "clean.tex");
  check("render-default-path", d.code === 0 && existsSync(join(dir, "clean.html")) && d.out.startsWith("wrote clean.html"), d);

  // ---- render --png: what the agent looks at
  const browser = process.env.CHROME || ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((b) => existsSync(b));
  if (!browser) {
    if (process.env.LATEX_CLI_PNG === "1") check("png-browser-found", false, "no Chromium-family browser (CHROME=...)");
    else console.log("skip: render --png (no Chromium-family browser; CHROME=...)");
  } else {
    const g = await new Promise((res) => {
      const q = spawn(process.execPath, [CLI, "latex", "render", "talk.tex", "--png", "png", "--json"], { cwd: dir, env: { ...process.env, CHROME: browser } });
      let o = "", e = ""; q.stdout.on("data", (x) => (o += x)); q.stderr.on("data", (x) => (e += x));
      q.on("close", (code) => { let json = null; try { json = JSON.parse(o); } catch {} res({ code, json, err: e }); });
    });
    const pages = g.json?.png?.pages ?? [];
    const files = existsSync(join(dir, "png")) ? readdirSync(join(dir, "png")).sort() : [];
    check("png-one-per-frame", g.code === 0 && pages.length === 5 && files.join(",") === "frame-01.png,frame-02.png,frame-03.png,frame-04.png,frame-05.png", { code: g.code, err: g.err, pages, files });
    const dims = files.map((f) => { const b = readFileSync(join(dir, "png", f)); return b.subarray(0, 8).toString("hex") === "89504e470d0a1a0a" ? [b.readUInt32BE(16), b.readUInt32BE(20)] : null; });
    check("png-slide-size-16-9", dims.length === 5 && dims.every((x) => x && x[0] === 1024 && Math.abs(x[1] - 576) <= 1), dims);
    check("png-overflow-reported", pages[3]?.overflow_px > 0 && pages.filter((x) => x.overflow_px).length === 1 && pages[1].title === "Overlays", pages);
  }

  // ---- usage
  const u = await run(dir, "render");
  const n = await run(dir, "check", "nope.tex");
  const h = await run(dir, "--help");
  const x = await run(dir, "frobnicate");
  check("usage-exit-2", u.code === 2 && n.code === 2 && /no such file/.test(n.err) && x.code === 2 && h.code === 0 && h.out.includes("sagebrush latex render FILE.tex"), { u: u.err, n: n.err, x: x.err });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
const bad = results.filter(([, ok]) => !ok);
console.log(bad.length ? `FAIL: ${bad.length} of ${results.length} checks` : `ok: sagebrush latex, ${results.length} checks`);
process.exit(bad.length ? 1 : 0);
