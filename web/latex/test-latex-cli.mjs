// ci: checks.3 order=95 chrome env=LATEX_CLI_PNG=1
// `sagebrush latex check|render` (src/latex-cli.ts, built as build/cli/sagebrush-latex.cjs) on real files in a temp
// folder, through the CLI's own bundle: what an agent runs to verify a .tex and see it. Check's problems and their
// lines, frames, images and exit codes; render's HTML (self-contained, no script); beamer frames as slides (titles,
// [t], plain, \frame{}, aspectratio), overlays all shown; and, with a Chromium-family browser, one PNG per frame and
// an overflowing frame reported.
//   node scripts/build-cli.mjs && node web/latex/test-latex-cli.mjs
//   (CHROME=/path/to/chrome for the PNGs; LATEX_CLI_PNG=1 makes a missing browser a failure, not a skip)
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, mkdirSync, copyFileSync, symlinkSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const CLI = new URL("../../build/cli/pyjs.cjs", import.meta.url).pathname;
if (!existsSync(CLI) || !existsSync(new URL("../../build/cli/sagebrush-latex.cjs", import.meta.url).pathname)) {
  console.log("FAIL: no build/cli/pyjs.cjs and sagebrush-latex.cjs: run node scripts/build-cli.mjs first");
  process.exit(1);
}
const run = (cwd, ...a) => runWith(CLI, cwd, ...a);
const runWith = (cli, cwd, ...a) => runOpts({}, cli, cwd, ...a);
// (opts.node: node's own options before the script; opts.env: more environment)
const runOpts = (opts, cli, cwd, ...a) => new Promise((res) => {
  const p = spawn(process.execPath, [...(opts.node ?? []), cli, "latex", ...a], { cwd, env: opts.env ? { ...process.env, ...opts.env } : process.env });
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
  check("check-parent-image-looked-for", p("image", "../outside.png")?.severity === "error" && /: above the workspace's top folder$/.test(p("image", "../outside.png").message), j.problems);
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
  // (a frame the editor's preview shows as a placeholder, over 128 KiB of markup: a warning at its line, exit 0; a
  //  frame with an image over 128 KiB, inlined as a data: URL, none: the preview shows it, sim run 8)
  const BIGSVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">` + `<circle cx="5" cy="5" r="4"/>`.repeat(6000) + "</svg>";
  const LARGE = String.raw`\documentclass{beamer}
\begin{document}
\begin{frame}{Picture}
\includegraphics{big.svg}
\end{frame}
\begin{frame}{Long}
${"many words ".repeat(14000)}
\end{frame}
\end{document}
`;
  writeFileSync(join(dir, "large.tex"), LARGE); writeFileSync(join(dir, "big.svg"), BIGSVG);
  const cl = await run(dir, "check", "large.tex", "--json");
  const tl = (cl.json?.problems ?? []).filter((x) => x.kind === "toolarge");
  check("check-frame-too-large-warning-with-line", cl.code === 0 && BIGSVG.length > 128 * 1024 && cl.json.frames.length === 2 && tl.length === 1 && tl[0].severity === "warning" && tl[0].line === lineOf(LARGE, "\\begin{frame}{Long}")
    && /^this slide is too large \(\d+ KiB, over 128 KiB\): the preview and Present show a placeholder instead/.test(tl[0].message), { code: cl.code, problems: cl.json?.problems });
  // (render shows what check says: that frame's placeholder, inside its own slide, the picture's frame whole; and a
  //  frame over CHUNK_MAX, 2 MiB, still a slide too: the deck's frames all kept)
  const HUGE = LARGE.replace("\\end{document}", "\\begin{frame}{Huge}\n" + "more words ".repeat(200000) + "\n\\end{frame}\n\\end{document}");
  writeFileSync(join(dir, "huge.tex"), HUGE);
  const rl = await run(dir, "render", "huge.tex", "-o", "huge.html", "--json");
  const hh = existsSync(join(dir, "huge.html")) ? readFileSync(join(dir, "huge.html"), "utf8") : "";
  const frameOf = (k) => { const i = hh.indexOf(`<section class="slide" data-frame="${k}"`); return i < 0 ? "" : hh.slice(i, hh.indexOf("</section>", i) + 10); };
  const ch = await run(dir, "check", "huge.tex", "--json");
  check("render-too-large-frames-placeholders-in-their-slides", rl.code === 0 && (hh.match(/<section class="slide"/g) || []).length === 3 && frameOf(1).includes('src="data:image/svg+xml;base64,')
    && /^<section[^>]*><div class="placeholder toolarge">\[this slide is too large[^\]]*\]<\/div><\/section>$/.test(frameOf(2)) && /^<section[^>]*><div class="placeholder toolarge">\[this slide is too large[^\]]*\]<\/div><\/section>$/.test(frameOf(3))
    && !hh.includes("many words many words") && !hh.includes("more words more words"), { code: rl.code, slides: (hh.match(/<section class="slide"/g) || []).length, f2: frameOf(2).slice(0, 300), f3: frameOf(3).slice(0, 300) });
  check("check-frame-over-2MiB-warning", ch.json?.frames?.length === 3 && (ch.json?.problems ?? []).some((x) => x.kind === "toolarge" && x.line === lineOf(HUGE, "\\begin{frame}{Huge}") && /over 2048 KiB/.test(x.message)), ch.json?.problems);

  // ---- images as TeX finds them (William's L2, Nov 2): the file's folder, a parent (../), \graphicspath, a leading /
  // (the folder the command runs in); when not found, the folders searched and the name to write. Never outside the
  // folder the command runs in (astra L2-BOUND-1: relative, \graphicspath's and the not-found probe too; a .tex outside
  // it has no images) nor through a link out of it (L2-BOUND-2: a linked folder, a linked file; a link inside is read)
  {
    const { mkdirSync, symlinkSync } = await import("node:fs");
    const w = join(dir, "w"), ex = join(w, "ex"), out = join(dir, "outside");
    mkdirSync(join(ex, "figs"), { recursive: true }); mkdirSync(out, { recursive: true });
    const SECRET = SVG.replace("#c00", "#0c0");
    writeFileSync(join(w, "top.svg"), SVG); writeFileSync(join(ex, "here.svg"), SVG); writeFileSync(join(ex, "figs", "deep.svg"), SVG);
    writeFileSync(join(out, "secret.svg"), SECRET); writeFileSync(join(out, "top2.svg"), SECRET);
    symlinkSync(out, join(ex, "jump")); symlinkSync(join(out, "secret.svg"), join(ex, "leaf.svg")); symlinkSync(join(w, "top.svg"), join(ex, "inlink.svg"));
    const refs = ["here.svg", "../top.svg", "deep", "top.svg", "nowhere.png", "/ex/here.svg", "/../top.svg", "../../outside/secret.svg", "secret.svg", "jump/secret.svg", "leaf.svg", "/ex/jump/secret.svg", "inlink.svg", "top2.svg"];
    writeFileSync(join(ex, "cv.tex"), "\\documentclass{article}\n\\graphicspath{{figs/}{../../outside/}}\n\\begin{document}\n" + refs.map((r) => "\\includegraphics{" + r + "}\n").join("") + "\\end{document}\n");
    const ci = (await run(w, "check", "ex/cv.tex", "--json")).json;
    const im = (n) => ci?.images.find((x) => x.name === n);
    check("images: same folder, parent (../), \\graphicspath and a link inside the folder: found", im("here.svg")?.found && im("../top.svg")?.found && im("../top.svg").path === "../top.svg" && im("deep")?.found && im("deep").path === "figs/deep.svg" && im("inlink.svg")?.found, ci?.images);
    check("images: a file in a parent folder named without ../: where it is, and what to write", im("top.svg")?.found === false && im("top.svg").why === 'not found in this file\'s folder, "figs/"; it is in "../": write {../top.svg}, or move the file into this file\'s folder', im("top.svg"));
    check("images: a leading / is the folder the command runs in, never the computer's top, never above it", im("/ex/here.svg")?.found && im("/ex/here.svg").path === "here.svg" && im("/../top.svg")?.found === false && /above the workspace's top folder/.test(im("/../top.svg").why), [im("/ex/here.svg"), im("/../top.svg")]);
    check("images: missing everywhere: the folders searched, no suggestion", im("nowhere.png")?.found === false && im("nowhere.png").why === 'not found in this file\'s folder, "figs/"', im("nowhere.png"));
    check("images: ../ and \\graphicspath never reach outside the folder the command runs in (L2-BOUND-1), nor does the not-found probe",
      im("../../outside/secret.svg")?.found === false && im("secret.svg")?.found === false && !/outside/.test(im("secret.svg").why)
      && im("top2.svg")?.found === false && !/it is in/.test(im("top2.svg").why), [im("../../outside/secret.svg"), im("secret.svg"), im("top2.svg")]);
    check("images: a linked folder or a linked file pointing outside is refused (L2-BOUND-2)", ["jump/secret.svg", "leaf.svg", "/ex/jump/secret.svg"].every((n) => im(n)?.found === false && im(n).why === "a link to outside the folder the command runs in"), ["jump/secret.svg", "leaf.svg", "/ex/jump/secret.svg"].map(im));
    const rh = await run(w, "render", "ex/cv.tex", "-o", "cv.html");
    const page = existsSync(join(w, "cv.html")) ? readFileSync(join(w, "cv.html"), "utf8") : "";
    check("images: the outside SVG's bytes are nowhere in the page", page.length > 1000 && !page.includes(Buffer.from(SECRET).toString("base64")) && page.includes(Buffer.from(SVG).toString("base64")), { code: rh.code, n: page.length });
    const co = (await run(ex, "check", "../top-doc.tex", "--json"));
    writeFileSync(join(w, "top-doc.tex"), "\\documentclass{article}\n\\begin{document}\n\\includegraphics{top.svg}\n\\end{document}\n");
    const co2 = (await run(ex, "check", "../top-doc.tex", "--json")).json;
    check("images: a .tex outside the folder the command runs in has no images (not widened)", co2?.images?.[0]?.found === false && /outside the folder the command runs in/.test(co2.images[0].why), co2?.images ?? co);
  }

  // ---- \input and \include (William's L4, Nov 2): read from the folder the command runs in as TeX finds them (with
  // .tex added, ../, a leading /), never through a link out of it; macros from them apply; one not read is an error
  // naming where it was looked for
  {
    const w = join(dir, "w"), ex = join(w, "ex");
    const { mkdirSync, symlinkSync } = await import("node:fs");
    mkdirSync(join(w, "shared"), { recursive: true });
    writeFileSync(join(w, "shared", "macros.tex"), "\\newcommand{\\RR}{\\mathbb{R}}\n\\newcommand{\\hello}{Hello from macros}\n");
    writeFileSync(join(ex, "part.tex"), "Included part with $\\RR$.\n");
    writeFileSync(join(dir, "outside", "evil.tex"), "\\newcommand{\\hello}{OUTSIDE TEXT}\n");
    symlinkSync(join(dir, "outside", "evil.tex"), join(ex, "evil.tex"));
    writeFileSync(join(ex, "talk2.tex"), "\\documentclass{article}\n\\input{../shared/macros}\n\\input{evil}\n\\begin{document}\n\\hello: $\\RR$.\n\\include{part}\n\\input{/shared/macros.tex}\n\\input{missing}\n\\end{document}\n");
    const ch = (await run(w, "check", "ex/talk2.tex", "--json")).json;
    const ip = (n) => ch?.problems.find((x) => x.kind === "input" && x.name === n);
    check("input: a missing file is an error at its line, naming where it was looked for", ip("missing")?.severity === "error" && ip("missing").line === 8 && /\\input\{missing\}: not found in this file's folder/.test(ip("missing").message), ch?.problems);
    check("input: a link to outside the folder is refused", /a link to outside the folder the command runs in/.test(ip("evil")?.message ?? ""), ip("evil"));
    const rr = await run(w, "render", "ex/talk2.tex", "-o", "t2.html");
    const hh = existsSync(join(w, "t2.html")) ? readFileSync(join(w, "t2.html"), "utf8") : "";
    check("input: the macros file's macros apply (../ and a leading /), \\include's text is there, nothing from outside", hh.includes("Hello from macros") && hh.includes("Included part with") && /mathbb/.test(hh) && !hh.includes("OUTSIDE TEXT"), { code: rr.code, err: rr.err, n: hh.length });
  }

  // ---- render: one self-contained HTML file
  const r = await run(dir, "render", "talk.tex", "-o", "out.html", "--json");
  const html = existsSync(join(dir, "out.html")) ? readFileSync(join(dir, "out.html"), "utf8") : "";
  check("render-writes-html", r.code === 0 && r.json?.html === "out.html" && html.startsWith("<!doctype html>"), r);
  check("render-html-no-script-and-csp", !/<script/i.test(html) && html.includes(`content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:"`), html.slice(0, 400));
  check("render-html-fonts-inlined", /@font-face\{[^}]*url\(data:font\/woff2;base64,/.test(html) && !/url\(fonts\//.test(html), html.match(/@font-face\{[^}]{0,200}/)?.[0]);
  check("render-image-inlined", html.includes('src="data:image/svg+xml;base64,') && html.includes("[image: missing.png: not found in this file&#39;s folder]") || html.includes("[image: missing.png: not found in this file's folder]"), html.match(/\[image: missing[^\]]*\]/)?.[0]);
  const slides = [...html.matchAll(/<section class="slide([^"]*)" data-frame="(\d+)"[^>]*style="([^"]*)"/g)];
  check("render-slides", slides.length === 5 && slides.every((m) => m[3].startsWith("aspect-ratio:160/90;--sfs:")) && slides[2][1] === " va-t", slides.map((m) => m.slice(1)));
  check("render-frame-titles", html.includes('<header class="slide-title">Overlays</header>') && html.includes('<header class="slide-title">A block and a picture<div class="slide-subtitle">with a subtitle</div></header>')
    && !html.includes("Not shown</header>"), null);
  check("render-overlays-all-shown", html.includes("Only on three.") && html.includes('<span class="alert">idea</span>') && !html.includes(">\\only<"), null);
  check("render-beamer-block-and-title", html.includes('<div class="bblock block"><div class="bblock-title">Theorem</div>') && html.includes('<div class="institute">Somewhere University</div>'), null);
  const d = await run(dir, "render", "clean.tex");
  check("render-default-path", d.code === 0 && existsSync(join(dir, "clean.html")) && d.out.startsWith("wrote clean.html"), d);

  // ---- render --png: what the agent looks at
  // (CHROME as CI sets it, a command's name (CHROME=google-chrome), is the CLI's to look up on PATH: passed as it is)
  // (a browser that fails to start: what it said is in png_error, not only that it failed; a fake one, on any box)
  {
    const fake = join(dir, "fake-chrome");
    writeFileSync(fake, "#!/bin/sh\necho 'fake-chrome: Missing X server or $DISPLAY' >&2\nexit 1\n", { mode: 0o755 });
    const fk = await new Promise((res) => {
      const q = spawn(process.execPath, [CLI, "latex", "render", "talk.tex", "--png", "fkpng", "--json"], { cwd: dir, env: { ...process.env, CHROME: fake } });
      let o = ""; q.stdout.on("data", (x) => (o += x)); q.on("close", (code) => { let json = null; try { json = JSON.parse(o); } catch {} res({ code, json }); });
    });
    check("png: a browser that exits at once, its own words in png_error", fk.code === 1 && /exited \(1\) before it could take the pictures; it said: fake-chrome: Missing X server or \$DISPLAY/.test(fk.json?.png_error ?? ""), { code: fk.code, png_error: fk.json?.png_error });
    const fakeRun = (script, out) => new Promise((res) => {
      writeFileSync(fake, script, { mode: 0o755 });
      const q = spawn(process.execPath, [CLI, "latex", "render", "talk.tex", "--png", out, "--json"], { cwd: dir, env: { ...process.env, CHROME: fake } });
      let o = ""; q.stdout.on("data", (x) => (o += x)); q.on("close", (code) => { let json = null; try { json = JSON.parse(o); } catch {} res({ code, json }); });
    });
    // (grader D5: the tail is the END of what it said, at most 2048 characters)
    const fl = await fakeRun("#!/bin/sh\nprintf 'FIRST' >&2\nhead -c 3000 /dev/zero | tr '\\0' x >&2\necho 'LAST' >&2\nexit 1\n", "flpng");
    const said = /; it said: ([\s\S]*)$/.exec(fl.json?.png_error ?? "")?.[1] ?? "";
    check("png: a long stderr, its last 2048 characters kept (the end, not the start)", fl.code === 1 && said.endsWith("LAST") && !said.includes("FIRST") && said.length <= 2048 && said.length > 2000, { code: fl.code, n: said.length, head: said.slice(0, 20), tail: said.slice(-10) });
    // (grader D4: the CI sighting's path: a browser that says something and never opens its DevTools port; the CLI
    //  gives up at 30 s, with what it said)
    const ft = await fakeRun("#!/bin/sh\necho 'fake-chrome: still starting' >&2\nexec sleep 40\n", "fspng");
    check("png: a browser that never opens its DevTools port: the 30 s timeout, with what it said", ft.code === 1 && /didn't open its DevTools port in 30 s; it said: fake-chrome: still starting$/.test(ft.json?.png_error ?? ""), { code: ft.code, png_error: ft.json?.png_error });
  }
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
    check("png-one-per-frame", g.code === 0 && pages.length === 5 && files.join(",") === "frame-01.png,frame-02.png,frame-03.png,frame-04.png,frame-05.png", { code: g.code, err: g.err, png_error: g.json?.png_error, pages, files });
    const dims = files.map((f) => { const b = readFileSync(join(dir, "png", f)); return b.subarray(0, 8).toString("hex") === "89504e470d0a1a0a" ? [b.readUInt32BE(16), b.readUInt32BE(20)] : null; });
    check("png-slide-size-16-9", dims.length === 5 && dims.every((x) => x && x[0] === 1024 && Math.abs(x[1] - 576) <= 1), dims);
    // (--steps: each frame at each overlay step)
    writeFileSync(join(dir, "ov.tex"), "\\documentclass{beamer}\n\\begin{document}\n\\begin{frame}{S}\n\\begin{itemize}\n\\item<1-> a\n\\item<2-> b\n\\end{itemize}\n\\pause\n\\pause\nc\n\\end{frame}\n\\begin{frame}{T}\nt\n\\end{frame}\n\\end{document}\n");
    const st = await new Promise((res) => { const q = spawn(process.execPath, [CLI, "latex", "render", "ov.tex", "--png", "ovpng", "--steps", "--json"], { cwd: dir, env: { ...process.env, CHROME: browser } }); let o = ""; q.stdout.on("data", (x) => (o += x)); q.on("close", (code) => { let json = null; try { json = JSON.parse(o); } catch {} res({ code, json }); }); });
    const sp = st.json?.png?.pages ?? [];
    const ovFiles = existsSync(join(dir, "ovpng")) ? readdirSync(join(dir, "ovpng")).sort() : [];
    check("png --steps: a PNG per frame and step", st.code === 0 && st.json.check.frames.map((f) => f.steps).join(",") === "3,1" && ovFiles.join(",") === "frame-01-1.png,frame-01-2.png,frame-01-3.png,frame-02-1.png" && sp.map((x) => x.frame + "." + x.step).join(",") === "1.1,1.2,1.3,2.1", { code: st.code, png_error: st.json?.png_error, files: ovFiles, pages: sp });
    const bytes = ovFiles.map((f) => readFileSync(join(dir, "ovpng", f)).toString("base64"));
    check("png --steps: the steps' pictures differ", bytes[0] !== bytes[1] && bytes[1] !== bytes[2], null);
    // (--pdf: printed by the same browser, a beamer document one page per frame, of the slide's size)
    const pd = await new Promise((res) => { const q = spawn(process.execPath, [CLI, "latex", "render", "talk.tex", "--pdf", "talk.pdf", "--json"], { cwd: dir, env: { ...process.env, CHROME: browser } }); let o = ""; q.stdout.on("data", (x) => (o += x)); q.on("close", (code) => { let json = null; try { json = JSON.parse(o); } catch {} res({ code, json }); }); });
    const pdfBytes = existsSync(join(dir, "talk.pdf")) ? readFileSync(join(dir, "talk.pdf")) : Buffer.alloc(0);
    const mb = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(pdfBytes.toString("latin1"));
    check("pdf: one page per frame, 16:9", pd.code === 0 && pdfBytes.subarray(0, 5).toString() === "%PDF-" && pd.json?.pdf?.pages === 5 && mb && Math.abs(+mb[1] / +mb[2] - 16 / 9) < 0.01, { code: pd.code, pdf_error: pd.json?.pdf_error, pdf: pd.json?.pdf, mb: mb && mb.slice(1) });
    // (Codex W05: an article's page breaks are the PDF's pages. TeX Live 2025, pdflatex, this document: 3 pages, "One." |
    //  "Two. Still two." | "Three.Four.": a \newpage before anything, \clearpage then \newpage, and one after
    //  everything make no blank page; \pagebreak[2] is a hint; \pagebreak within a paragraph breaks after it)
    writeFileSync(join(dir, "breaks.tex"), "\\documentclass{article}\n\\begin{document}\n\\newpage\nOne.\n\\newpage\nTwo.\\pagebreak[2] Still two.\\clearpage\\newpage Three.\\pagebreak Four.\n\\newpage\n\\end{document}\n");
    const bk = await runOpts({ env: { CHROME: browser } }, CLI, dir, "render", "breaks.tex", "--pdf", "breaks.pdf", "--json");
    check("pdf: an article's \\newpage, \\clearpage and \\pagebreak are its pages, as TeX's (3, none blank)", bk.code === 0 && bk.json?.pdf?.pages === 3, { code: bk.code, pdf: bk.json?.pdf, err: bk.json?.pdf_error ?? bk.err.slice(-300) });
    check("png-overflow-reported", pages[3]?.overflow_px > 0 && pages.filter((x) => x.overflow_px).length === 1 && pages[1].title === "Overlays", pages);
    // (sim run 11 X01, run 12 BL01: displays squeezed and clipped while their frame read as fitting. Against TeX Live
    //  2025, beamer at aspectratio=169: X01's frame fits; with k copies of its nested-root display, each after a line
    //  (72% of the width in TeX, so its normal display skips, and one line in any sans font: a wrapped line would make
    //  this depend on the fonts installed), TeX fits k <= 3; k = 4 is overfull by 6.6 pt, 5 and 6 by 62 and 117 pt;
    //  k = 3 and 1 to 5 more sentences: fits, fits, fits, 6.0 and 20.2 pt over. Here: X01's frame and k <= 3 fit, and
    //  every frame TeX finds clearly over-full (k = 5, 6; k = 3 and 5 more) is reported, none squeezed to fit; the
    //  frames within a few points of full in TeX either way (this preview is within about a line of TeX there))
    const DISP = String.raw`\[b=\frac{\sqrt5-1}{2},\qquad a=\pm\sqrt{\frac{\sqrt5-1}{2}}.\]`, LINE = "The notebook checks that both original equations reduce to zero.";
    const X01 = String.raw`\begin{frame}{1. Exact algebra: a circle meets a parabola}
Intersect $a^2+b^2=1$ with $b=a^2$. A lexicographic Gr\"obner basis is
\[\left[a^{2} - b, b^{2} + b - 1\right].\]
Thus $b^2+b-1=0$. Only the positive root can equal $a^2$:
` + DISP + String.raw`
The notebook checks both original equations reduce to zero.
The eliminated quartic is irreducible over $\mathbb Q$, but over $\mathbb F_5$:
\[w^4+w^2-1=(w^2+3)^2.\]
\end{frame}
`;
    // (a frame: a full line, then k times a display and a full line, then `more` full lines)
    const fr = (k, more = 0) => [`\\begin{frame}{Displays ${k}${more ? ` and ${more} lines` : ""}}`, LINE, ...Array.from({ length: k }, () => DISP + "\n" + LINE), ...Array(more).fill(LINE), "\\end{frame}\n"].join("\n");
    writeFileSync(join(dir, "clip.tex"), "\\documentclass[aspectratio=169]{beamer}\n\\begin{document}\n" + X01 + [1, 2, 3, 4, 5, 6].map((k) => fr(k)).join("") + [1, 2, 3, 4, 5].map((n) => fr(3, n)).join("") + "\\end{document}\n");
    const cl = await new Promise((res) => { const q = spawn(process.execPath, [CLI, "latex", "render", "clip.tex", "--png", "clippng", "--json"], { cwd: dir, env: { ...process.env, CHROME: browser } }); let o = ""; q.stdout.on("data", (x) => (o += x)); q.on("close", (code) => { let json = null; try { json = JSON.parse(o); } catch {} res({ code, json }); }); });
    const over = (cl.json?.png?.pages ?? []).map((p) => p.overflow_px ?? 0);
    check("png: displays never squeezed to fit their frame (sim X01, BL01): X01's frame and k <= 3 nested-root displays fit, as in TeX Live; every frame TeX finds clearly over-full (k = 5, 6; k = 3 and 5 more lines) reported",
      cl.code === 0 && over.length === 12 && over.slice(0, 4).every((x) => x === 0) && over[5] > 0 && over[6] > 0 && over[11] > 0, { code: cl.code, over });
    // (grader Y4: a block is a frame's block too, and its box (.bblock) hides its overflow, as a display's does: never
    //  shrunk to fit either. TeX Live, the same line, a block of n one-line paragraphs between two more: n <= 13 fits,
    //  n = 20 is overfull by 91.5 pt. Here a block of 6 fits and one of 20 is reported (blocks run taller here than in
    //  TeX: from n = 10, a spacing difference, not this))
    const blk = (n) => `\\begin{frame}{Block ${n}}\n${LINE}\n\\begin{block}{A block}\n${Array(n).fill(LINE).join("\n\n")}\n\\end{block}\n${LINE}\n\\end{frame}\n`;
    writeFileSync(join(dir, "clipb.tex"), "\\documentclass[aspectratio=169]{beamer}\n\\begin{document}\n" + blk(6) + blk(20) + "\\end{document}\n");
    const cb = await new Promise((res) => { const q = spawn(process.execPath, [CLI, "latex", "render", "clipb.tex", "--png", "clipbpng", "--json"], { cwd: dir, env: { ...process.env, CHROME: browser } }); let o = ""; q.stdout.on("data", (x) => (o += x)); q.on("close", (code) => { let json = null; try { json = JSON.parse(o); } catch {} res({ code, json }); }); });
    const overB = (cb.json?.png?.pages ?? []).map((p) => p.overflow_px ?? 0);
    check("png: a block never squeezed to fit its frame (grader Y4): a block of 6 lines fits, as in TeX Live; a block of 20, overfull in TeX, reported",
      cb.code === 0 && overB.length === 2 && overB[0] === 0 && overB[1] > 0, { code: cb.code, overB });
  }

  // ---- run: the SageTeX code, in order, in one session; its results beside the file, shown by check and render
  const SAGE = String.raw`\documentclass{beamer}
\usepackage{sagetex}
\begin{document}
\begin{frame}{Computed}
\begin{sagesilent}
f(x) = x^3 - 2*x
print("printed, not a result")
\end{sagesilent}
The derivative is $\sage{diff(f(x), x)}$; $2^{64}+1 = \sage{factor(2^64+1)}$.

\sageplot[width=0.5\textwidth]{plot(f, (x, -2, 2))}
\end{frame}
\begin{frame}{A failure}
$\sage{1/0}$ then $\sage{2+2}$.
\end{frame}
\end{document}
`;
  writeFileSync(join(dir, "sage.tex"), SAGE);
  const before = await run(dir, "check", "sage.tex", "--json");
  check("run-before: not run yet, said how", before.code === 0 && before.json.code.every((x) => x.state === "not run") && before.json.problems.some((x) => x.kind === "code" && /sagebrush latex run sage\.tex/.test(x.message)), before.json?.problems);
  const ran = await run(dir, "run", "sage.tex", "--json");
  const res = existsSync(join(dir, "sage.tex.results.json")) ? JSON.parse(readFileSync(join(dir, "sage.tex.results.json"), "utf8")) : null;
  check("run: exit 1 (an item failed), results file written", ran.code === 1 && res?.format === "sagebrush-latex-results" && res.version === 1 && res.items.length === 6, { code: ran.code, err: ran.err, res: res && res.items.map((x) => x.s) });
  check("run: states in order, fail-stop", JSON.stringify(res?.items.map((x) => x.s)) === JSON.stringify(["ok", "ok", "ok", "ok", "error", "blocked"]) && ran.json.items[4].line === lineOf(SAGE, "$\\sage{1/0}"), { items: ran.json?.items });
  check("run: results are Sage's", res.items[1].latex === "3 \\, x^{2} - 2" && /274177/.test(res.items[2].latex) && /^data:image\/svg\+xml;base64,/.test(res.items[3].src), res.items.slice(1, 4).map((x) => (x.latex ?? x.src ?? "").slice(0, 60)));
  check("run: the error's traceback is the item's, not the session script's", /ZeroDivisionError/.test(res.items[4].msg) && !/driver\.sage/.test(res.items[4].msg), res.items[4].msg);
  const after = await run(dir, "check", "sage.tex", "--json");
  check("check after run: the states, the failure at its line", after.code === 1 && after.json.code.map((x) => x.state.split(":")[0]).join(",") === "ok,ok,ok,ok,error,blocked"
    && after.json.problems.some((x) => x.kind === "code" && x.severity === "error" && x.line === lineOf(SAGE, "$\\sage{1/0}") && /ZeroDivisionError: rational division by zero/.test(x.message)), after.json?.problems); // (Sage's own message for 1/0: the item is Sage, #706)
  await run(dir, "render", "sage.tex", "-o", "sage.html");
  const sh = readFileSync(join(dir, "sage.html"), "utf8");
  check("render after run: the plot and the results drawn", /<img class="sageplot" alt="a plot" src="data:image\/svg\+xml;base64,/.test(sh) && sh.includes("274177") && !sh.includes("Sage item 2: not run"), null);
  // (item 3 changed: items 1 and 2 keep their results, 3 on are not run until the next run)
  writeFileSync(join(dir, "sage.tex"), SAGE.replace("factor(2^64+1)", "factor(2^32+1)"));
  const edited = await run(dir, "check", "sage.tex", "--json");
  check("an edit: the results before it kept, those from it on not run", edited.json.code.map((x) => x.state).join(",") === "ok,ok,not run,not run,not run,not run", edited.json?.code);
  // (#706, a wrong answer: Sage's arithmetic in every item, as in a .sage file: the issue's document, the values Sage
  //  gives (sage -c on the same lines; latex() as Sage writes it); and results saved by the old wrapper, whose 1/3 was
  //  a float, aren't shown: those items are run again)
  const EXACT = "\\documentclass{article}\n\\usepackage{sagetex}\n\\begin{document}\n\\begin{sageblock}\na = 1/3\nb = 2^3\nc = 5^^3\nR.<t> = QQ[]\nL = sum(1/10^factorial(j) for j in range(1, 5))\n\\end{sageblock}\n$\\sage{a}$, $\\sage{b}$, $\\sage{c}$, $\\sage{L}$, $\\sage{ 1/2 + 1/3 }$, $\\sage{(t+1)^2}$.\n\\end{document}\n";
  writeFileSync(join(dir, "exact.tex"), EXACT);
  const ex = await run(dir, "run", "exact.tex", "--json");
  const exr = JSON.parse(readFileSync(join(dir, "exact.tex.results.json"), "utf8"));
  check("exact: latex run is Sage's arithmetic: 1/3, 2^3, 5^^3 (xor), the sum with its 10^-24 term, 1/2 + 1/3, (t+1)^2 over QQ",
    ex.code === 0 && JSON.stringify(exr.items.map((x) => x.latex ?? null)) === JSON.stringify([null, "\\frac{1}{3}", "8", "6", "\\frac{110001000000000000000001}{1000000000000000000000000}", "\\frac{5}{6}", "t^{2} + 2 t + 1"]), { code: ex.code, items: exr.items.map((x) => [x.s, x.latex ?? (x.msg ?? "").slice(-160)]) });
  // (the same results as the old wrapper saved them, its version in the file and in each item's key, \sage{a} its
  //  float: not shown, every item not run until it is run again)
  writeFileSync(join(dir, "exact.tex.results.json"), readFileSync(join(dir, "exact.tex.results.json"), "utf8").replace(/sbtx-wrapper-\d+/g, "sbtx-wrapper-1").replace('"latex":"\\\\frac{1}{3}"', '"latex":"0.3333333333333333"'));
  const stale = await run(dir, "check", "exact.tex", "--json");
  check("exact: results saved by the old wrapper (1/3 a float) aren't shown: not run", stale.json?.code?.length === 7 && stale.json.code.every((x) => x.state === "not run") && readFileSync(join(dir, "exact.tex.results.json"), "utf8").includes("0.3333333333333333"), stale.json?.code);
  // (a timeout: what ran before it is kept)
  writeFileSync(join(dir, "slow.tex"), "\\documentclass{article}\n\\begin{document}\n$\\sage{2+3}$\n\\begin{sagesilent}\nwhile True:\n    pass\n\\end{sagesilent}\n$\\sage{7}$\n\\end{document}\n");
  const slow = await run(dir, "run", "slow.tex", "--timeout", "8", "--json");
  check("run --timeout: stopped, earlier results kept", slow.code === 1 && slow.json.items.map((x) => x.state).join(",") === "ok,error,blocked" && /timeout/.test(slow.json.items[1].message), slow.json?.items ?? slow.err);
  // (a helper beside the .tex: its code imports it, as real SageTeX's does (SageTeX 3.6.1 on Sage 10.9, run in the
  //  document's folder: "The answer is 49."); the run is started from another folder, the document's own counts)
  mkdirSync(join(dir, "helped"));
  writeFileSync(join(dir, "helped", "helper.py"), "def square(n):\n    return n * n\n");
  // (and a sagebrush.py beside it doesn't shadow the session script's own `sagebrush` import: @sagebrush-latex's review)
  writeFileSync(join(dir, "helped", "sagebrush.py"), "raise ImportError('shadowed')\n");
  writeFileSync(join(dir, "helped", "doc.tex"), "\\documentclass{article}\n\\usepackage{sagetex}\n\\begin{document}\n\\begin{sagesilent}\nfrom helper import square\nx = square(7)\n\\end{sagesilent}\nThe answer is $\\sage{x}$, and $\\sage{1/3}$.\n\\end{document}\n");
  const helped = await run(dir, "run", "helped/doc.tex", "--json");
  const hr = existsSync(join(dir, "helped", "doc.tex.results.json")) ? JSON.parse(readFileSync(join(dir, "helped", "doc.tex.results.json"), "utf8")) : null;
  check("run: a helper.py beside the .tex is imported (the document's folder on sys.path, as in SageTeX); a sagebrush.py there doesn't break the session",
    helped.code === 0 && JSON.stringify(hr?.items?.map((x) => [x.s, x.latex ?? null])) === JSON.stringify([["ok", null], ["ok", "49"], ["ok", "\\frac{1}{3}"]]), { code: helped.code, items: helped.json?.items, saved: hr?.items });
  // (the document's folder LAST on sys.path, as Sage 10.9's `sage doc.sagetex.sage` has it (its sys.path printed: the
  //  bin folder, the standard library, site-packages, then the document's folder): a statistics.py beside the .tex
  //  doesn't replace the standard library's (the stdlib's has NormalDist; the document's one only a mean returning 42).
  //  statistics isn't imported when the session starts (checked in the item), so this is the search order, not a
  //  cached module; grader's Y2, @sagebrush's (A))
  mkdirSync(join(dir, "shadowing"));
  writeFileSync(join(dir, "shadowing", "statistics.py"), "def mean(xs):\n    return 42\n");
  writeFileSync(join(dir, "shadowing", "doc.tex"), "\\documentclass{article}\n\\usepackage{sagetex}\n\\begin{document}\n\\begin{sagesilent}\nimport sys\nfresh = 'statistics' not in sys.modules\nimport statistics\n\\end{sagesilent}\n$\\sage{fresh}$ $\\sage{hasattr(statistics, 'NormalDist')}$\n\\end{document}\n");
  const shadowing = await run(dir, "run", "shadowing/doc.tex", "--json");
  const sr = existsSync(join(dir, "shadowing", "doc.tex.results.json")) ? JSON.parse(readFileSync(join(dir, "shadowing", "doc.tex.results.json"), "utf8")) : null;
  check("run: the document's folder is LAST on sys.path, as Sage's: its statistics.py doesn't replace the standard library's",
    shadowing.code === 0 && JSON.stringify(sr?.items?.map((x) => [x.s, x.latex ?? null])) === JSON.stringify([["ok", null], ["ok", "\\mathrm{True}"], ["ok", "\\mathrm{True}"]]), { code: shadowing.code, items: shadowing.json?.items, saved: sr?.items });
  // (William's L1, Nov 3: \title{$\sage{factor(2026)}$} "doesn't work": an item in a title field is shown where
  //  \maketitle prints it, so it runs and its result is in the title block; with no \maketitle it is still hidden)
  const TITLED = "\\documentclass{article}\n\\usepackage{sagetex}\n\\title{$\\sage{factor(2026)}$}\n\\author{A $\\sage{2+3}$\\thanks{t $\\sage{6*7}$}}\n\\date{$\\sage{2025+1}$}\n\\begin{document}\n\\maketitle\nBody $\\sage{1+1}$.\n\\end{document}\n";
  writeFileSync(join(dir, "titled.tex"), TITLED);
  const tr = await run(dir, "run", "titled.tex", "--json");
  await run(dir, "render", "titled.tex", "-o", "titled.html");
  const th = existsSync(join(dir, "titled.html")) ? readFileSync(join(dir, "titled.html"), "utf8") : "";
  const tblock = th.slice(th.indexOf('<div class="titleblock">'), th.indexOf('<div class="titleblock">') + 20000);
  check("run: items in \\title, \\author, \\thanks and \\date run and are shown in the title block", tr.code === 0 && tr.json?.items?.length === 5 && tr.json.items.every((x) => x.state === "ok")
    && /<div class="title">[\s\S]*1013/.test(tblock) && /<div class="author">[\s\S]*<mn>5<\/mn>/.test(tblock) && /<div class="date">[\s\S]*2026/.test(tblock) && /<div class="thanks">[\s\S]*42/.test(tblock), { code: tr.code, items: tr.json?.items, block: tblock.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 300) });
  writeFileSync(join(dir, "untitled.tex"), TITLED.replace("\\maketitle\n", ""));
  const ut = await run(dir, "check", "untitled.tex", "--json");
  check("check: a \\title item with no \\maketitle is still hidden (refused, an error at its line)", ut.code === 1 && ut.json.problems.some((x) => x.kind === "code" && x.severity === "error" && x.line === 3 && /can't be run/.test(x.message)), ut.json?.problems);
  // (grader E6: \institute on a beamer \titlepage; E7: a \sage in the preamble outside every title field, with
  //  \maketitle there, is still hidden: refused at its line, S1E01-A3)
  const INST = "\\documentclass{beamer}\n\\usepackage{sagetex}\n\\title{T}\n\\institute{Inst $\\sage{3*3}$}\n\\begin{document}\n\\frame{\\titlepage}\n\\end{document}\n";
  writeFileSync(join(dir, "inst.tex"), INST);
  const ir = await run(dir, "run", "inst.tex", "--json");
  await run(dir, "render", "inst.tex", "-o", "inst.html");
  const ih = existsSync(join(dir, "inst.html")) ? readFileSync(join(dir, "inst.html"), "utf8") : "";
  check("run: an item in \\institute runs and is shown on the \\titlepage", ir.code === 0 && ir.json?.items?.length === 1 && ir.json.items[0].state === "ok" && /<div class="institute">Inst [\s\S]*<mn>9<\/mn>/.test(ih), { code: ir.code, items: ir.json?.items });
  const PRE = "\\documentclass{article}\n\\usepackage{sagetex}\n\\title{T}\nPreamble text $\\sage{5}$\n\\begin{document}\n\\maketitle\nBody $\\sage{1+1}$.\n\\end{document}\n";
  writeFileSync(join(dir, "pre.tex"), PRE);
  const pc = await run(dir, "check", "pre.tex", "--json");
  check("check: a \\sage in the preamble outside the title fields is still refused at its line (\\maketitle there)", pc.code === 1 && pc.json.problems.some((x) => x.kind === "code" && x.severity === "error" && x.line === 4 && /can't be run/.test(x.message)), pc.json?.problems);
  const none = await run(dir, "run", "clean.tex");
  check("run, no code: says so", none.code === 0 && /no SageTeX or PythonTeX code to run/.test(none.out), none);

  // (a file named latex in the folder: \`sagebrush latex run\` is still the command, never that file run as a script,
  //  astra's LATEX-RUN-1; for every command)
  writeFileSync(join(dir, "latex"), "print('THE LOCAL SCRIPT RAN')\n");
  const col = await Promise.all(["run", "check", "render"].map((c) => run(dir, c, "clean.tex")));
  check("a local file named latex: each latex command is still the command", col.every((x) => x.code === 0 && !/THE LOCAL SCRIPT RAN/.test(x.out + x.err)) && /no SageTeX or PythonTeX code to run/.test(col[0].out) && /no problems/.test(col[1].out), col.map((x) => [x.code, (x.out + x.err).slice(0, 120)]));
  rmSync(join(dir, "latex"));

  // ---- the bundle moved to another folder: `sagebrush latex` loads the sagebrush-latex.cjs beside where the bundle,
  //  or the npm launcher, really is. (Bun bakes the build machine's folder into the bundle as __dirname: a copy loaded
  //  the build's own module here, and on any other machine found none.) A stub module in each copy says it was the one.
  {
    const away = mkdtempSync(join(tmpdir(), "sb-latex-moved-"));
    try {
      const STUB = 'exports.latexCommand = async () => { process.stdout.write("THE MOVED MODULE\\n"); return 0; };\n';
      // the bundle alone, the stub beside it
      mkdirSync(join(away, "cli"));
      copyFileSync(CLI, join(away, "cli", "pyjs.cjs")); writeFileSync(join(away, "cli", "sagebrush-latex.cjs"), STUB);
      const alone = await runWith(join(away, "cli", "pyjs.cjs"), dir, "check", "clean.tex");
      check("moved: the bundle in another folder loads the module beside it", alone.code === 0 && alone.out === "THE MOVED MODULE\n", alone);
      // the npm package's layout (bin/sagebrush.cjs, dist/sagebrush.cjs and the module), run through a symlink as
      // node_modules/.bin/sagebrush is
      for (const d of ["pkg/bin", "pkg/dist", ".bin"]) mkdirSync(join(away, d), { recursive: true });
      copyFileSync(new URL("../../packages/sagebrush/bin/sagebrush.cjs", import.meta.url).pathname, join(away, "pkg", "bin", "sagebrush.cjs"));
      copyFileSync(CLI, join(away, "pkg", "dist", "sagebrush.cjs")); writeFileSync(join(away, "pkg", "dist", "sagebrush-latex.cjs"), STUB);
      symlinkSync(join(away, "pkg", "bin", "sagebrush.cjs"), join(away, ".bin", "sagebrush"));
      const npm = await runWith(join(away, ".bin", "sagebrush"), dir, "check", "clean.tex");
      check("moved: the npm layout, through a .bin symlink, loads dist/'s module", npm.code === 0 && npm.out === "THE MOVED MODULE\n", npm);
      // (grader, #625: the launcher without its worker requires the bundle in this thread, so the entry is bin/'s
      //  launcher, and dist/ is found as bin/../dist)
      const inproc = await runOpts({ env: { SAGEBRUSH_NO_WORKER: "1" } }, join(away, ".bin", "sagebrush"), dir, "check", "clean.tex");
      check("moved: the npm layout without the launcher's worker (SAGEBRUSH_NO_WORKER) loads dist/'s module", inproc.code === 0 && inproc.out === "THE MOVED MODULE\n", inproc);
      // (grader, #625: a symlink to the moved bundle, run with --preserve-symlinks-main: the entry's real path is the
      //  bundle's folder, not the symlink's)
      mkdirSync(join(away, "links"));
      symlinkSync(join(away, "cli", "pyjs.cjs"), join(away, "links", "pyjs.cjs"));
      const preserved = await runOpts({ node: ["--preserve-symlinks-main"] }, join(away, "links", "pyjs.cjs"), dir, "check", "clean.tex");
      check("moved: a symlink to the moved bundle, with --preserve-symlinks-main, loads the module beside the real bundle", preserved.code === 0 && preserved.out === "THE MOVED MODULE\n", preserved);
      // the npm layout with the real module: `latex run` starts its Sage session from the bundle the launcher loaded
      // (in the launcher's worker, process.argv[1] is "[worker eval]": before, "can't find this sagebrush's own bundle")
      for (const d of ["real-pkg/bin", "real-pkg/dist", "doc"]) mkdirSync(join(away, d), { recursive: true });
      copyFileSync(join(away, "pkg", "bin", "sagebrush.cjs"), join(away, "real-pkg", "bin", "sagebrush.cjs"));
      copyFileSync(CLI, join(away, "real-pkg", "dist", "sagebrush.cjs")); copyFileSync(join(dirname(CLI), "sagebrush-latex.cjs"), join(away, "real-pkg", "dist", "sagebrush-latex.cjs"));
      writeFileSync(join(away, "doc", "one.tex"), "\\documentclass{article}\n\\usepackage{sagetex}\n\\begin{document}\n$\\sage{2+3}$\n\\end{document}\n");
      const nrun = await runWith(join(away, "real-pkg", "bin", "sagebrush.cjs"), join(away, "doc"), "run", "one.tex", "--json");
      check("moved: latex run through the npm launcher runs its code", nrun.code === 0 && nrun.json?.items?.length === 1 && nrun.json.items[0].state === "ok", { code: nrun.code, err: nrun.err.slice(0, 300), items: nrun.json?.items });
      // and the real module beside a moved bundle checks a file
      mkdirSync(join(away, "real"));
      copyFileSync(CLI, join(away, "real", "pyjs.cjs")); copyFileSync(join(dirname(CLI), "sagebrush-latex.cjs"), join(away, "real", "sagebrush-latex.cjs"));
      const real = await runWith(join(away, "real", "pyjs.cjs"), dir, "check", "clean.tex");
      check("moved: the real module beside a moved bundle checks the file", real.code === 0 && real.out.startsWith("clean.tex: beamer, 1 frame; no problems"), real);
    } finally { rmSync(away, { recursive: true, force: true }); }
  }

  // ---- usage
  const u = await run(dir, "render");
  const n = await run(dir, "check", "nope.tex");
  const h = await run(dir, "--help");
  const x = await run(dir, "frobnicate");
  check("usage-exit-2", u.code === 2 && n.code === 2 && /no such file/.test(n.err) && x.code === 2 && h.code === 0 && h.out.includes("sagebrush latex render FILE.tex"), { u: u.err, n: n.err, x: x.err });
  // ---- (Codex W01, python's repro/wrong/W01) an edited helper's old results never used: run records what it imported
  // from the .tex's folder (deps: path, SHA-256); after h.py is edited, check says so (a warning: not run) and render
  // shows the items not run, not the old value; run again, the new value. A deleted helper: the same. A results file
  // without deps (an older one) is used exactly as before, the edit not noticed; one whose deps can't be read is not used
  {
    const w = join(dir, "w01");
    mkdirSync(w);
    writeFileSync(join(w, "h.py"), "v = 1\n");
    writeFileSync(join(w, "d.tex"), "\\documentclass{article}\n\\usepackage{sagetex}\n\\begin{document}\n\\begin{sagesilent}\nfrom h import v\n\\end{sagesilent}\n$\\sage{v}$\n\\end{document}\n");
    const rp = join(w, "d.tex.results.json"), saved = () => JSON.parse(readFileSync(rp, "utf8"));
    const r1 = await run(w, "run", "d.tex", "--json"), j1 = saved();
    const hash = createHash("sha256").update("v = 1\n").digest("hex");
    check("W01: run records what it imported from the .tex's folder, with its SHA-256", r1.code === 0 && JSON.stringify(j1.deps) === JSON.stringify([["h.py", hash]]) && j1.items[1].latex === "1", { code: r1.code, deps: j1.deps });
    const c1 = await run(w, "check", "d.tex", "--json");
    writeFileSync(join(w, "h.py"), "v = 2\n");
    const c2 = await run(w, "check", "d.tex", "--json"), rd = await run(w, "render", "d.tex", "-o", "d.html", "--json");
    const html = readFileSync(join(w, "d.html"), "utf8");
    check("W01: h.py edited: check says the results aren't used (h.py changed), the items not run", c1.json?.code?.every((x) => x.state === "ok") && c2.json?.code?.every((x) => x.state === "not run") && c2.json.problems.some((p) => p.kind === "stale" && /h\.py changed or was removed since they were run/.test(p.message)), { c1: c1.json?.code, c2: c2.json?.problems });
    check("W01: h.py edited: render shows the items not run, never the old value", rd.code === 0 && /s-notrun/.test(html) && !/<span class="katex[^"]*">.*>1<\/mn>/.test(html), { code: rd.code, chips: (html.match(/s-notrun/g) || []).length });
    const r2 = await run(w, "run", "d.tex", "--json"), c3 = await run(w, "check", "d.tex", "--json");
    check("W01: run again: the new value, its new hash, check clean", r2.code === 0 && saved().items[1].latex === "2" && saved().deps[0][1] === createHash("sha256").update("v = 2\n").digest("hex") && c3.json?.code?.every((x) => x.state === "ok") && !c3.json.problems.some((p) => p.kind === "stale"), { r2: r2.code, c3: c3.json?.problems });
    rmSync(join(w, "h.py"));
    const c4 = await run(w, "check", "d.tex", "--json");
    check("W01: the helper deleted: the results aren't used", c4.json?.code?.every((x) => x.state === "not run") && c4.json.problems.some((p) => p.kind === "stale" && /h\.py/.test(p.message)), c4.json?.problems);
    // (an older results file: no deps; the helper edited: used as before, its old value shown)
    writeFileSync(join(w, "h.py"), "v = 3\n");
    const old = saved(); delete old.deps; writeFileSync(rp, JSON.stringify(old) + "\n");
    const c5 = await run(w, "check", "d.tex", "--json");
    check("W01: a results file without deps (an older one) is used exactly as before", c5.json?.code?.every((x) => x.state === "ok") && !c5.json.problems.some((p) => p.kind === "stale"), c5.json?.problems);
    // (deps not of the shape (a path out of the folder): not used, said)
    const bad = saved(); bad.deps = [["../h.py", "0".repeat(64)]]; writeFileSync(rp, JSON.stringify(bad) + "\n");
    const c6 = await run(w, "check", "d.tex", "--json");
    check("W01: deps that can't be read (a path out of the folder): the results aren't used, said", c6.json?.code?.every((x) => x.state === "not run") && c6.json.problems.some((p) => p.kind === "stale" && /can't be read/.test(p.message)), c6.json?.problems);
    // (astra's DEP-READ-1: one bounded reader. A helper that is a link out of the folder, a folder, or past the
    //  budget: not read, so not used (the link's target's own hash doesn't make it so))
    const stale = async (deps) => { const j = saved(); j.deps = deps; writeFileSync(rp, JSON.stringify(j) + "\n"); const c = await run(w, "check", "d.tex", "--json"); return c.json?.code?.every((x) => x.state === "not run") && c.json.problems.some((p) => p.kind === "stale"); };
    writeFileSync(join(dir, "out.py"), "v = 1\n");
    rmSync(join(w, "h.py")); symlinkSync(join(dir, "out.py"), join(w, "h.py"));
    const viaLink = await stale([["h.py", hash]]);
    rmSync(join(w, "h.py")); mkdirSync(join(w, "h.py"));
    const aDir = await stale([["h.py", hash]]);
    rmSync(join(w, "h.py"), { recursive: true }); writeFileSync(join(w, "h.py"), "v = 1\n"); writeFileSync(join(w, "big.py"), ""); truncateSync(join(w, "big.py"), 65 * 2 ** 20);
    const past = await stale([["big.py", hash]]);
    check("DEP-READ-1: a helper linked out of the folder, a folder, or past the budget: not read, the results not used", viaLink && aDir && past, { viaLink, aDir, past });
    rmSync(join(w, "big.py"));
    // (astra's DEP-SNAPSHOT-1: a helper changed while the run ran: what it imported can't be named, the results recorded
    //  "incomplete" and not used; never left without a record, as an older file's)
    writeFileSync(join(w, "d.tex"), "\\documentclass{article}\n\\usepackage{sagetex}\n\\begin{document}\n\\begin{sagesilent}\nfrom h import v\n\\end{sagesilent}\n\\begin{sagesilent}\nopen('h.py', 'w').write('v = 5')\n\\end{sagesilent}\n$\\sage{v}$\n\\end{document}\n");
    const r3 = await run(w, "run", "d.tex", "--json"), c7 = await run(w, "check", "d.tex", "--json");
    check("DEP-SNAPSHOT-1: a helper changed during the run: recorded incomplete, the results not used, said", r3.code === 0 && saved().deps === "incomplete" && c7.json?.code?.every((x) => x.state === "not run") && c7.json.problems.some((p) => p.kind === "stale" && /didn't record everything/.test(p.message)), { r3: r3.code, deps: saved().deps, c7: c7.json?.problems });
    // (grader's #804 C4, daybreak3's probe: an item removes the run's own record of what it imported (deps.json, its
    //  sys.argv[3]) and runs until the timeout, so the results of the items before it are kept with no record beside
    //  them: recorded "incomplete", never as "imported nothing"; h.py edited, check uses none of them)
    {
      const w3 = join(dir, "w01c");
      mkdirSync(w3);
      writeFileSync(join(w3, "h.py"), "v = 17\n");
      writeFileSync(join(w3, "d.tex"), "\\documentclass{article}\n\\usepackage{sagetex}\n\\begin{document}\n\\begin{sagesilent}\nfrom h import v\n\\end{sagesilent}\n$\\sage{v}$\n\\begin{sagesilent}\nimport os, sys\nos.remove(sys.argv[3])\nwhile True:\n    pass\n\\end{sagesilent}\n\\end{document}\n");
      const r5 = await run(w3, "run", "d.tex", "--timeout", "5", "--json"), j5 = JSON.parse(readFileSync(join(w3, "d.tex.results.json"), "utf8"));
      writeFileSync(join(w3, "h.py"), "v = 18\n");
      const c5 = await run(w3, "check", "d.tex", "--json");
      check("DEP-SNAPSHOT-1: an item removes the run's record and runs to the timeout: the results before it recorded incomplete; h.py edited, none used",
        j5.deps === "incomplete" && j5.items?.[1]?.latex === "17" && c5.json?.code?.every((x) => x.state !== "ok") && c5.json.problems.some((p) => p.kind === "stale" && /didn't record everything/.test(p.message)),
        { code: r5.code, deps: j5.deps, items: j5.items?.map((x) => x.s + ":" + (x.latex ?? "")), check: c5.json?.code?.map((x) => x.state) });
      rmSync(w3, { recursive: true, force: true });
    }
    // (grader's #804 C2: the files hashed before a run share one budget, DEPS_BYTES (64 MiB): a.py (not imported) takes
    //  all but 4 bytes of it, so b.py (6 bytes), under the budget alone, isn't hashed before the run, and a run importing it
    //  records "incomplete")
    {
      const w2 = join(dir, "w01b");
      mkdirSync(w2);
      writeFileSync(join(w2, "a.py"), ""); truncateSync(join(w2, "a.py"), 64 * 2 ** 20 - 4);
      writeFileSync(join(w2, "b.py"), "v = 1\n");
      writeFileSync(join(w2, "d.tex"), "\\documentclass{article}\n\\usepackage{sagetex}\n\\begin{document}\n\\begin{sagesilent}\nfrom b import v\n\\end{sagesilent}\n$\\sage{v}$\n\\end{document}\n");
      const r4 = await run(w2, "run", "d.tex", "--json"), j4 = JSON.parse(readFileSync(join(w2, "d.tex.results.json"), "utf8"));
      check("DEP-SNAPSHOT-1: the files hashed before a run share one budget: past it, a helper imported is recorded incomplete", r4.code === 0 && j4.deps === "incomplete" && j4.items?.[1]?.latex === "1", { code: r4.code, deps: j4.deps });
      rmSync(w2, { recursive: true, force: true });
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
const bad = results.filter(([, ok]) => !ok);
console.log(bad.length ? `FAIL: ${bad.length} of ${results.length} checks` : `ok: sagebrush latex, ${results.length} checks`);
process.exit(bad.length ? 1 : 0);
