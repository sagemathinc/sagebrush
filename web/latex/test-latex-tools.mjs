// The LaTeX page's agent tools (agent-tools.ts: latex_check, latex_render, registered with navigator.modelContext),
// in headless Chrome against a web/dist built with SAGEBRUSH_LATEX_PREVIEW=test, served by web/serve.py: what an agent
// in the browser runs to verify a .tex and see it. A stand-in navigator.modelContext (before the page's scripts)
// keeps the tools registered; each is called as an agent would.
//   - latex_check: the frames (titles, lines), the problems with their lines (a missing image, an unknown command),
//     JSON and text; after an edit, the report of the edited source (it waits for the preview to catch up);
//   - latex_render: one PNG per frame at 1024 px and the slide's aspect ratio, the overflowing frame named, chosen
//     frames only; an image of the folder drawn (its blob: URL inlined), KaTeX's fonts loaded;
//   - an article: pages, 816 px wide.
//   SAGEBRUSH_LATEX_PREVIEW=test bun web/build.ts && CHROME=google-chrome node web/latex/test-latex-tools.mjs
//   (LATEX_SHOTS=dir: the PNGs the tool returned, written there for a look)
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const here = new URL(".", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn("python3", [join(here, "..", "serve.py"), "0"], { stdio: ["ignore", "pipe", "inherit"] });
const sport = await new Promise((res, rej) => { let acc = ""; server.stdout.on("data", (b) => { acc += b; const m = /(\d{2,5})/.exec(acc); if (m) res(+m[1]); }); setTimeout(() => rej(new Error("no server port")), 15000); });
const base = `http://127.0.0.1:${sport}/`;
let port = Number(process.env.CDP_PORT) || 0;
const profile = mkdtempSync(join(tmpdir(), "sb-latex-tools-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, "--window-size=1400,900", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
if (!port) port = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map(); const errors = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
};
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 1500)); return r.result?.value; };
const until = async (expr, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(100); } return false; };
const fails = []; let checks = 0;
const check = (ok, what, detail) => { checks++; if (!ok) { fails.push(what); console.log("FAIL", what, detail === undefined ? "" : JSON.stringify(detail).slice(0, 700)); } };
const W = "window.sagebrush?.workspace";
const mk = (p, text) => ev(`${W}.create(${JSON.stringify(p)}, { content: new TextEncoder().encode(${JSON.stringify(text)}) }).then((e) => e.fid)`);
// a tool called as an agent would: its result's content, images as their base64 length and PNG size
const call = (name, args = {}) => ev(`window.__tools[${JSON.stringify(name)}].execute(${JSON.stringify(args)}).then((r) => r.content.map((c) => c.type === "text" ? c : { type: c.type, mimeType: c.mimeType, data: c.data }))`);
const png = (b64) => { const b = Buffer.from(b64, "base64"); return b.subarray(0, 8).toString("hex") === "89504e470d0a1a0a" ? [b.readUInt32BE(16), b.readUInt32BE(20)] : null; };
const typeInto = (text) => ev(`(() => { const t = document.querySelector(".tex-src"); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event("input")); return true; })()`);
const lineOf = (text, needle) => text.slice(0, text.indexOf(needle)).split("\n").length;

const TALK = String.raw`\documentclass[aspectratio=169]{beamer}
\title{Tools}
\author{An Agent}
\begin{document}
\frame{\titlepage}
\begin{frame}{A picture}
\includegraphics[width=0.5\textwidth]{wave.svg}
\includegraphics{missing.png}
\end{frame}
\begin{frame}{Math}
$\displaystyle \int_0^1 x^2\,dx = \frac{1}{3}$ and \mystery.
\end{frame}
\begin{frame}{Too much}
\begin{itemize}
\item a \item b \item c \item d \item e \item f \item g \item h \item i \item j \item k \item l \item m \item n
\end{itemize}
\end{frame}
\end{document}
`;
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" width="200" height="100"><rect width="200" height="100" fill="#c00"/></svg>`;
const ARTICLE = "\\documentclass{article}\n\\begin{document}\n\\section{Hello}\n" + "Some text with $x^2$. ".repeat(400) + "\n\\end{document}\n";

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__tools = {}; Object.defineProperty(navigator, "modelContext", { configurable: true, value: { registerTool(t) { window.__tools[t.name] = t; } } });` });
  await send("Page.navigate", { url: base });
  await until(`!!${W}`, 60000);
  const fid = await mk("/talk.tex", TALK);
  await ev(`${W}.create("/wave.svg", { content: new TextEncoder().encode(${JSON.stringify(SVG)}) }).then(() => 1)`);
  await send("Page.navigate", { url: base + "?tex=" + fid + "&latex=1" });
  check(await until(`document.querySelectorAll(".tex-preview section.slide").length === 4 && !!window.__tools.latex_check`, 30000), "the deck open, its four slides shown, the tools registered");
  check(await until(`!!document.querySelector(".tex-preview section.slide img.graphic")`, 15000), "the folder's image shown in the preview");

  // ---- latex_check
  const c = await call("latex_check");
  const j = JSON.parse(c[0].text);
  check(j.class === "beamer" && j.frames.map((f) => f.title).join("|") === "|A picture|Math|Too much" && j.frames[1].line === lineOf(TALK, "\\begin{frame}{A picture}"), "latex_check: the frames, titles and lines", j.frames);
  const p = (kind, name) => j.problems.find((x) => x.kind === kind && x.name === name);
  check(p("image", "missing.png")?.severity === "error" && p("image", "missing.png").line === lineOf(TALK, "{missing.png}") && p("command", "mystery")?.line === lineOf(TALK, "\\mystery") && j.ok === false,
    "latex_check: the missing image and the unknown command, with their lines", j.problems);
  check(j.images.some((i) => i.name === "wave.svg" && i.found), "latex_check: the found image", j.images);
  const ct = await call("latex_check", { format: "text" });
  check(/^\/talk\.tex: beamer, 4 frames; 2 problems\n/.test(ct[0].text) && ct[0].text.includes(`/talk.tex:${lineOf(TALK, "{missing.png}")}: error:`), "latex_check: text, compiler style", ct[0].text);
  // (an edit, then at once a check: the report is the edited source's)
  const edited = TALK.replace("and \\mystery.", "and \\mystery \\another.");
  await typeInto(edited);
  const c2 = JSON.parse((await call("latex_check"))[0].text);
  check(c2.problems.some((x) => x.kind === "command" && x.name === "another" && x.line === lineOf(edited, "\\another")), "latex_check right after an edit: the edited source's report", c2.problems);
  await typeInto(TALK);

  // ---- latex_render
  const r = await call("latex_render");
  const sum = JSON.parse(r[0].text), imgs = r.slice(1);
  const dims = imgs.map((x) => (x.type === "image" && x.mimeType === "image/png" ? png(x.data) : null));
  check(sum.frames === 4 && imgs.length === 4 && dims.every((d) => d && d[0] === 1024 && Math.abs(d[1] - 576) <= 1), "latex_render: one PNG per frame, 1024 x 576 (16:9)", { sum, dims });
  check(JSON.stringify(sum.overflowing) === "[4]" && sum.shown[3].overflow_px > 0 && sum.shown[1].title === "A picture", "latex_render: the overflowing frame named", sum);
  if (process.env.LATEX_SHOTS) imgs.forEach((x, k) => writeFileSync(join(process.env.LATEX_SHOTS, `tool-frame-${k + 1}.png`), Buffer.from(x.data, "base64")));
  // (what was drawn: the picture frame's red image, and the math frame's KaTeX glyphs, decoded in the page)
  const look = await ev(`(async () => {
    const at = async (b64, x, y) => { const i = new Image(); i.src = "data:image/png;base64," + b64; await i.decode(); const c = document.createElement("canvas"); c.width = i.width; c.height = i.height; const g = c.getContext("2d"); g.drawImage(i, 0, 0); return g; };
    const pic = await at(${JSON.stringify(imgs[1]?.data ?? "")}), d = pic.getImageData(0, 0, 1024, 576).data;
    let red = 0; for (let k = 0; k < d.length; k += 4) if (d[k] > 180 && d[k + 1] < 60 && d[k + 2] < 60) red++;
    const m = await at(${JSON.stringify(imgs[2]?.data ?? "")}), e = m.getImageData(0, 0, 1024, 576).data;
    let ink = 0; for (let k = 0; k < e.length; k += 4) if (e[k] < 100 && e[k + 1] < 100 && e[k + 2] < 100) ink++;
    return { red, ink };
  })()`);
  check(look.red > 5000 && look.ink > 200, "latex_render: the folder's image drawn, and the math's ink", look);
  const one = await call("latex_render", { frames: [3] });
  check(JSON.parse(one[0].text).shown.length === 1 && JSON.parse(one[0].text).shown[0].n === 3 && one.length === 2, "latex_render: one chosen frame", JSON.parse(one[0].text));

  // ---- Present (present.ts): the slides full screen, step by step through their overlays; and latex_render's steps
  const OV = String.raw`\documentclass[aspectratio=169]{beamer}
\begin{document}
\begin{frame}{Step by step}
\begin{itemize}[<+->]
\item First, the question.
\item Then, an idea.
\end{itemize}
\only<3>{Only on three.}
\end{frame}
\begin{frame}{Second}
Plain.
\end{frame}
\end{document}
`;
  await send("Page.navigate", { url: base });
  await until(`!!${W}`, 60000);
  const ofid = await mk("/ov.tex", OV);
  await send("Page.navigate", { url: base + "?tex=" + ofid + "&latex=1" });
  check(await until(`document.querySelectorAll(".tex-preview section.slide").length === 2 && !document.querySelector(".tex-present-btn").hidden`, 30000), "a beamer document: Present offered");
  const oc = JSON.parse((await call("latex_check"))[0].text);
  check(oc.frames.map((f) => f.steps).join(",") === "3,1", "latex_check: each frame's overlay steps", oc.frames);
  await ev(`document.querySelector(".tex-present-btn").click(), 1`);
  const P = `document.querySelector(".tex-present")`;
  check(await until(`!!${P} && ${P}.dataset.frame === "1" && ${P}.dataset.step === "1"`, 15000), "Present: the presenter open at frame 1, step 1");
  const vis = () => ev(`[...${P}.querySelectorAll("li")].map((li) => getComputedStyle(li).visibility).join(",") + "|" + (${P}.querySelector(".tp-stage").textContent.includes("Only on three") && getComputedStyle(${P}.querySelector('[data-ovm="only"]')).display !== "none")`);
  const v1 = await vis();
  const key = async (k, code) => { await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: { ArrowRight: 39, ArrowLeft: 37, Escape: 27, End: 35 }[k] }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code }); };
  await key("ArrowRight", "ArrowRight");
  const v2 = await vis();
  await key("ArrowRight", "ArrowRight");
  const v3 = await vis();
  check(v1 === "visible,hidden|false" && v2 === "visible,visible|false" && v3 === "visible,visible|true", "Present: Right steps through the overlays (an item at a time, then \\only<3>)", { v1, v2, v3 });
  await key("ArrowRight", "ArrowRight");
  check(await until(`${P}.dataset.frame === "2" && ${P}.dataset.step === "1" && ${P}.textContent.includes("2 / 2")`, 5000), "Present: after the last step, the next frame", await ev(`${P}.textContent.slice(-40)`));
  await key("ArrowLeft", "ArrowLeft");
  check(await until(`${P}.dataset.frame === "1" && ${P}.dataset.step === "3"`, 5000), "Present: Left goes back to the last step of the frame before");
  const box = await ev(`(() => { const r = ${P}.querySelector(".tp-stage > .slide").getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height), innerWidth, innerHeight]; })()`);
  check(Math.abs(box[0] / box[1] - 16 / 9) < 0.02 && (Math.abs(box[0] - box[2]) <= 1 || Math.abs(box[1] - box[3]) <= 1), "Present: the slide as large as the window allows, 16:9", box);
  // (an edit while presenting: shown at once)
  await typeInto(OV.replace("Then, an idea.", "Then, a better idea."));
  check(await until(`${P}.querySelector(".tp-stage").textContent.includes("a better idea")`, 15000), "Present: an edit shows at once");
  await key("Escape", "Escape");
  check(await until(`!${P}`, 5000), "Present: Escape stops it");
  const rs = await call("latex_render", { steps: true });
  const rsum = JSON.parse(rs[0].text);
  check(rs.length === 1 + 4 && rsum.shown.map((x) => x.n + "." + x.step).join(",") === "1.1,1.2,1.3,2.1" && rsum.shown.every((x) => png(rs[1 + rsum.shown.indexOf(x)].data)?.[0] === 1024), "latex_render steps: each frame at each step", rsum.shown);
  check(rs[1].data !== rs[2].data && rs[2].data !== rs[3].data, "latex_render steps: the steps' pictures differ");
  await typeInto(OV);

  // ---- the code's saved results (`sagebrush latex run`'s file beside the .tex): drawn in the page, and in its report
  const SAGE = String.raw`\documentclass{beamer}
\begin{document}
\begin{frame}{Computed}
\begin{sagesilent}
f(x) = x^3 - 2*x
\end{sagesilent}
$f'(x) = \sage{diff(f(x), x)}$

\sageplot[width=0.5\textwidth]{plot(f, (x, -2, 2), color='red', thickness=6)}
\end{frame}
\end{document}
`;
  const cli = new URL("../../build/cli/pyjs.cjs", import.meta.url).pathname;
  const rdir = mkdtempSync(join(tmpdir(), "sb-latex-tools-run-"));
  writeFileSync(join(rdir, "sage.tex"), SAGE);
  try { execFileSync(process.execPath, [cli, "latex", "run", "sage.tex"], { cwd: rdir, stdio: "ignore" }); } catch {}
  const resultsText = existsSync(join(rdir, "sage.tex.results.json")) ? readFileSync(join(rdir, "sage.tex.results.json"), "utf8") : "";
  rmSync(rdir, { recursive: true, force: true });
  check(/"s":"ok"/.test(resultsText), "the results file made by sagebrush latex run (build/cli)", resultsText.slice(0, 200));
  await send("Page.navigate", { url: base });
  await until(`!!${W}`, 60000);
  const sfid = await mk("/sage.tex", SAGE);
  await mk("/sage.tex.results.json", resultsText);
  await send("Page.navigate", { url: base + "?tex=" + sfid + "&latex=1" });
  check(await until(`!!document.querySelector(".tex-preview section.slide img.sageplot") && document.querySelector(".tex-preview section.slide").textContent.includes("3x")`, 30000), "the saved results drawn in the editor: the plot and \\sage{}'s result",
    await ev(`document.querySelector(".tex-preview section.slide")?.textContent?.slice(0, 200)`));
  const sc = JSON.parse((await call("latex_check"))[0].text);
  check(sc.code.map((x) => x.state).join(",") === "ok,ok,ok" && !sc.problems.some((x) => x.kind === "code"), "latex_check: the items' states from the results", sc.code);
  const sr = await call("latex_render");
  const red = await ev(`(async () => { const i = new Image(); i.src = "data:image/png;base64," + ${JSON.stringify(sr[1]?.data ?? "")}; await i.decode(); const c = document.createElement("canvas"); c.width = i.width; c.height = i.height; const g = c.getContext("2d"); g.drawImage(i, 0, 0); const d = g.getImageData(0, 0, i.width, i.height).data; let n = 0; for (let k = 0; k < d.length; k += 4) if (d[k] > 180 && d[k + 1] < 80 && d[k + 2] < 80) n++; return n; })()`);
  check(red > 500, "latex_render: the computed plot drawn in the frame's picture", red);
  // (an edit of the code: its result, and those after it, no longer shown; asked to run again)
  await typeInto(SAGE.replace("x^3 - 2*x", "x^3 - 3*x"));
  const se = JSON.parse((await call("latex_check"))[0].text);
  check(se.code.every((x) => x.state === "not run") && se.problems.some((x) => /sagebrush latex run/.test(x.message)), "an edit of the code: its results no longer shown, run asked for", se.code);

  // ---- an article: pages
  const afid = await mk("/notes.tex", ARTICLE);
  await send("Page.navigate", { url: base + "?tex=" + afid + "&latex=1" });
  check(await until(`!!document.querySelector(".tex-preview h2") && !!window.__tools.latex_render`, 30000), "the article open");
  const ar = await call("latex_render");
  const as = JSON.parse(ar[0].text), adims = ar.slice(1).map((x) => png(x.data));
  check(as.class === "other" && as.pages >= 2 && ar.length === 1 + as.pages && adims.every((d) => d && d[0] === 816), "latex_render, an article: its pages, 816 px wide", { as, adims });
  check(errors.length === 0, "no page errors", errors);
} catch (e) {
  check(false, "the run: " + String(e?.message ?? e));
} finally {
  server.kill();
  await new Promise((r) => { chrome.once("exit", r); chrome.kill(); setTimeout(r, 5000); });
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}
console.log(fails.length ? `FAIL: ${fails.length} of ${checks} checks` : `ok: the LaTeX page's agent tools, ${checks} checks`);
process.exit(fails.length ? 1 : 0);
