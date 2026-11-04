// ci: checks.3 order=95 chrome env=LATEX_CLI_PNG=1
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
    check("png-overflow-reported", pages[3]?.overflow_px > 0 && pages.filter((x) => x.overflow_px).length === 1 && pages[1].title === "Overlays", pages);
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
    && after.json.problems.some((x) => x.kind === "code" && x.severity === "error" && x.line === lineOf(SAGE, "$\\sage{1/0}") && /ZeroDivisionError: division by zero/.test(x.message)), after.json?.problems);
  await run(dir, "render", "sage.tex", "-o", "sage.html");
  const sh = readFileSync(join(dir, "sage.html"), "utf8");
  check("render after run: the plot and the results drawn", /<img class="sageplot" alt="a plot" src="data:image\/svg\+xml;base64,/.test(sh) && sh.includes("274177") && !sh.includes("Sage item 2: not run"), null);
  // (item 3 changed: items 1 and 2 keep their results, 3 on are not run until the next run)
  writeFileSync(join(dir, "sage.tex"), SAGE.replace("factor(2^64+1)", "factor(2^32+1)"));
  const edited = await run(dir, "check", "sage.tex", "--json");
  check("an edit: the results before it kept, those from it on not run", edited.json.code.map((x) => x.state).join(",") === "ok,ok,not run,not run,not run,not run", edited.json?.code);
  // (a timeout: what ran before it is kept)
  writeFileSync(join(dir, "slow.tex"), "\\documentclass{article}\n\\begin{document}\n$\\sage{2+3}$\n\\begin{sagesilent}\nwhile True:\n    pass\n\\end{sagesilent}\n$\\sage{7}$\n\\end{document}\n");
  const slow = await run(dir, "run", "slow.tex", "--timeout", "8", "--json");
  check("run --timeout: stopped, earlier results kept", slow.code === 1 && slow.json.items.map((x) => x.state).join(",") === "ok,error,blocked" && /timeout/.test(slow.json.items[1].message), slow.json?.items ?? slow.err);
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
  check("run, no code: says so", none.code === 0 && /no SageTeX code to run/.test(none.out), none);

  // (a file named latex in the folder: \`sagebrush latex run\` is still the command, never that file run as a script,
  //  astra's LATEX-RUN-1; for every command)
  writeFileSync(join(dir, "latex"), "print('THE LOCAL SCRIPT RAN')\n");
  const col = await Promise.all(["run", "check", "render"].map((c) => run(dir, c, "clean.tex")));
  check("a local file named latex: each latex command is still the command", col.every((x) => x.code === 0 && !/THE LOCAL SCRIPT RAN/.test(x.out + x.err)) && /no SageTeX code to run/.test(col[0].out) && /no problems/.test(col[1].out), col.map((x) => [x.code, (x.out + x.err).slice(0, 120)]));
  rmSync(join(dir, "latex"));

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
