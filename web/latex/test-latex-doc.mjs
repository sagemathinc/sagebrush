// ci: web-browser/latex order=40 chrome
// A published document opened read only (/?tex-doc=, the articles' links: William, Nov 4; @sagebrush's ruling), in
// headless Chrome against a web/dist built with SAGEBRUSH_LATEX_PREVIEW=test, served by web/serve.py with the two
// documents as /articles/tst/*.tex (SB_SERVE_OVERRIDES):
//   - an article: its preview, its source read only, "Read only" shown, nothing written to the workspace; the page's
//     own chunk, sagebrush-latex-doc.js, fetched for the link and never by the editor opening a file;
//   - a Beamer talk: its slides, and Present offered;
//   - "Edit a copy": /LaTeX articles/doc.tex made with the document's bytes, and opened in the editor by its fid; a
//     second copy is "doc (2).tex";
//   - refused, each without a request for it: a path outside /articles/, "..", another origin; and, with its reason,
//     a redirect (never followed), a body that isn't UTF-8, and a 404. (The size bound, read chunk by chunk and
//     cancelled past it, is pinned in test-latex-units.mjs, doc-read-capped-*.)
//   SAGEBRUSH_LATEX_PREVIEW=test bun web/build.ts && CHROME=google-chrome node web/latex/test-latex-doc.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const here = new URL(".", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(join(tmpdir(), "sb-latex-doc-"));
const DOC = "\\documentclass{article}\n\\begin{document}\n\\section{Hello}\nSome DocWord text with $x^2$.\n\\end{document}\n";
const TALK = "\\documentclass{beamer}\n\\begin{document}\n\\begin{frame}{First}\nSlideWord \\pause more\n\\end{frame}\n\\end{document}\n";
writeFileSync(join(tmp, "doc.tex"), DOC); writeFileSync(join(tmp, "talk.tex"), TALK);
// (not UTF-8: a Latin-1 "é" in the text)
writeFileSync(join(tmp, "latin1.tex"), Buffer.concat([Buffer.from("\\documentclass{article}\n\\begin{document}\nCaf"), Buffer.from([0xe9]), Buffer.from("\n\\end{document}\n")]));
const overrides = join(tmp, "overrides.json");
writeFileSync(overrides, JSON.stringify({
  "/articles/tst/doc.tex": { file: join(tmp, "doc.tex") },
  "/articles/tst/talk.tex": { file: join(tmp, "talk.tex") },
  "/articles/tst/moved.tex": { status: 302, location: "/articles/tst/doc.tex" },
  "/articles/tst/latin1.tex": { file: join(tmp, "latin1.tex") },
}));
const server = spawn("python3", [join(here, "..", "serve.py"), "0"], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, SB_SERVE_OVERRIDES: overrides } });
const sport = await new Promise((res, rej) => { let acc = ""; server.stdout.on("data", (b) => { acc += b; const m = /(\d{2,5})/.exec(acc); if (m) res(+m[1]); }); setTimeout(() => rej(new Error("no server port")), 15000); });
const base = `http://127.0.0.1:${sport}/`;
const profile = mkdtempSync(join(tmpdir(), "sb-latex-doc-chrome-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--remote-debugging-port=0", "--window-size=1400,900", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const fails = []; let checks = 0;
const check = (ok, what, detail) => { checks++; if (!ok) { fails.push(what); console.log("FAIL", what, detail === undefined ? "" : JSON.stringify(detail).slice(0, 500)); } };
try {
  const port = await devtoolsPort(profile, 60_000, { child: chrome });
  let targets;
  for (let k = 0; k < 300 && !targets?.some((t) => t.type === "page"); k++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch {} await sleep(100); }
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0; const waiting = new Map(), requests = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
    if (m.method === "Network.requestWillBeSent") requests.push(m.params.request.url);
  };
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500)); return r.result?.value; };
  const until = async (expr, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(100); } return false; };
  // (navigation by document identity, as test-latex-page.mjs: the old document marked, a new one without the mark awaited)
  const fresh = async (ms = 30000) => { if (!(await until(`!window.__sbOld && document.readyState !== "loading"`, ms))) throw new Error("no new document within " + ms + " ms"); };
  const go = async (url) => { await ev("window.__sbOld = true; true"); await send("Page.navigate", { url }); await fresh(); };
  const W = "window.sagebrush?.workspace";
  const shown = (q) => go(base + "?tex-doc=" + encodeURIComponent(q));
  const gone = () => ev(`document.querySelector(".tex-doc .tex-gone")?.textContent ?? null`);
  for (const m of ["Page.enable", "Runtime.enable", "Network.enable"]) await send(m);
  await go(base);
  await until(`!!${W}`, 60000);

  // ---- the article: preview, source read only, nothing written
  await shown("/articles/tst/doc.tex");
  const art = await until(`/DocWord/.test(document.querySelector(".tex-doc .tex-preview")?.textContent ?? "")`);
  const a = await ev(`(() => { const s = document.querySelector(".tex-doc .tex-src"); return { ro: s?.readOnly, src: s?.value, label: document.querySelector(".tex-doc .tex-ro")?.textContent, title: document.title,
    present: document.querySelector(".tex-doc .tex-present-btn")?.hidden, edit: document.querySelector(".tex-doc .tex-edit")?.disabled }; })()`);
  const noCopy = await ev(`${W}.stat("/LaTeX articles").then((e) => !e)`);
  check(art && a.ro === true && a.src === DOC && a.label === "Read only" && a.title === "doc.tex (read only)" && a.present === true && a.edit === false && noCopy, "an article: preview, read-only source, nothing copied", { art, a, noCopy });

  // ---- the talk: slides, Present offered
  await shown("/articles/tst/talk.tex");
  const talk = await until(`!!document.querySelector(".tex-doc .tex-preview section.slide") && /SlideWord/.test(document.querySelector(".tex-doc .tex-preview").textContent) && document.querySelector(".tex-doc .tex-present-btn")?.hidden === false`);
  check(talk, "a Beamer talk: its slides, and Present");

  // ---- Edit a copy: made with the document's bytes, opened by its fid; a second one is "(2)"
  // (the chunk, sagebrush-latex-doc.js: fetched for the link, and not by the editor opening the copy)
  const chunkAsks = [];
  const editCopy = async () => {
    const r0 = requests.length;
    await shown("/articles/tst/doc.tex");
    await until(`/DocWord/.test(document.querySelector(".tex-doc .tex-preview")?.textContent ?? "")`);
    const r1 = requests.length;
    await ev(`window.__sbOld = true; document.querySelector(".tex-doc .tex-edit").click(); true`);
    await fresh();
    await until(`!!document.querySelector(".tex-page:not(.tex-doc) .tex-src")`);
    await sleep(500);
    const doc = (a, b) => requests.slice(a, b).filter((u) => /sagebrush-latex-doc\.js/.test(u)).length;
    chunkAsks.push([doc(r0, r1), doc(r1)]);
    return ev(`location.search`);
  };
  const s1 = await editCopy(), s2 = await editCopy();
  check(chunkAsks.every(([link, editor]) => link === 1 && editor === 0), "the chunk: fetched once for the link, never by the editor opening a file", chunkAsks);
  const c1 = await ev(`${W}.stat("/LaTeX articles/doc.tex").then(async (e) => e && { fid: e.fid, text: new TextDecoder().decode((await ${W}.read("/LaTeX articles/doc.tex")).content) })`);
  const c2 = await ev(`${W}.stat("/LaTeX articles/doc (2).tex").then((e) => e && { fid: e.fid })`);
  check(c1?.text === DOC && s1 === "?tex=" + c1.fid && c2?.fid && s2 === "?tex=" + c2.fid, "Edit a copy: /LaTeX articles/doc.tex with its bytes, opened; then doc (2).tex", { s1, s2, c1, c2 });

  // ---- refused: not fetched at all, or (a redirect, a 404) fetched and said why
  for (const bad of ["/index.html", "/articles/../index.html", "/articles/tst/x.tex?y=1", "//evil.example/articles/a/b.tex", "https://evil.example/articles/a/b.tex", "/articles/Tst/doc.tex"]) {
    const before = requests.length;
    await shown(bad);
    await until(`!!document.querySelector(".tex-doc .tex-gone")`);
    const t = await gone(), asked = requests.slice(before).filter((u) => /evil\.example|\/index\.html$|x\.tex|Tst/.test(u) && !/[?&]tex-doc=/.test(u));
    check(t === "This link isn't to a document this site publishes." && asked.length === 0, "refused, never fetched: " + bad, { t, asked });
  }
  await shown("/articles/tst/moved.tex");
  await until(`!!document.querySelector(".tex-doc .tex-gone")`);
  const moved = await gone(), docAfterMove = await ev(`document.querySelector(".tex-doc .tex-src")?.value ?? null`);
  check(/^The document couldn't be read/.test(moved ?? "") && docAfterMove === null, "a redirect: not followed, said", { moved, docAfterMove });
  await shown("/articles/tst/latin1.tex");
  await until(`!!document.querySelector(".tex-doc .tex-gone")`);
  const latin = await gone(), latinSrc = await ev(`document.querySelector(".tex-doc .tex-src")?.value ?? null`);
  check(/^The document couldn't be read: /.test(latin ?? "") && latinSrc === null, "not UTF-8: refused, said, nothing shown", { latin, latinSrc });
  await shown("/articles/tst/none.tex");
  await until(`!!document.querySelector(".tex-doc .tex-gone")`);
  check((await gone()) === "The document couldn't be read (404).", "a 404: said", await gone());
} catch (e) {
  fails.push("threw"); console.log("FAIL threw", e?.stack ?? e);
} finally {
  chrome.kill(); server.kill();
  await sleep(200);
  rmSync(profile, { recursive: true, force: true }); rmSync(tmp, { recursive: true, force: true });
}
if (fails.length) { console.log(`FAIL: ${fails.length} of ${checks}: ${fails.join("; ")}`); process.exit(1); }
console.log(`ok: the LaTeX editor's read-only documents, ${checks} checks`);
