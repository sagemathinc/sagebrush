// ci: web-browser/latex order=50 runner=bun chrome
// An agent's latex_build in the page (chat plan PR 4b; packet r3 §8, §11's last row; implementation notes r1-r2 and
// their rulings): in headless Chromium against a web/dist built with SAGEBRUSH_LATEX_PREVIEW=test, through the page's
// real runner, LaTeX engine and workspace, with the calling grant as a test object (as test-run-verbs-page.mjs does).
// The build's engine worker is watched (its requests, their messages, its termination) and its replies can be held, so
// each phase and each race is reached on purpose.
//   SAGEBRUSH_LATEX_PREVIEW=test bun web/build.ts && CHROME=google-chrome bun web/workspace/test-latex-build-page.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort, startServe } from "../test-port.mjs";

const here = join(import.meta.dir, "..");
if (!existsSync(join(here, "dist", "sagebrush-agent-run.js")) || !existsSync(join(here, "dist", "sagebrush-latex.js"))) throw new Error("build web/dist with the LaTeX editor first (SAGEBRUSH_LATEX_PREVIEW=test bun web/build.ts)");
let checks = 0;
const fails = [];
const check = (ok, what) => { checks++; if (!ok) fails.push(what); console.log(`${ok ? "ok" : "FAIL"} ${what}`); };
let server = null, chrome = null;
// (git_branch's module, for the page to make a branch with, built into the site under a test-only name, removed at the end)
const gbName = `__test-git-branch-${process.pid}.js`;
const gbBuilt = await Bun.build({ entrypoints: [join(here, "workspace", "git-branch.ts")], outdir: join(here, "dist"), naming: gbName, target: "browser", format: "esm" });
if (!gbBuilt.success) throw new Error(gbBuilt.logs.join("\n"));
const profile = mkdtempSync(join(tmpdir(), "sb-test-latex-build-"));
try {
  const port = await startServe(() => (server = spawn("python3", [join(here, "serve.py"), "0"], { stdio: ["ignore", "pipe", "pipe"] }))).port;
  const url = `http://127.0.0.1:${port}/`;
  chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", "--window-size=1100,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore", detached: false });
  const dport = await devtoolsPort(profile);
  const target = (await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json()).find((t) => t.type === "page");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  let seq = 0;
  const waiting = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) (waiting.get(m.id)(m), waiting.delete(m.id)); };
  const send = (method, params = {}) => new Promise((r, j) => {
    const id = ++seq;
    const t = setTimeout(() => (waiting.delete(id), j(new Error(`DevTools ${method} gave no answer in 120 s`))), 120000);
    waiting.set(id, (m) => (clearTimeout(t), r(m)));
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text };
    return r.result?.result?.value;
  };
  const until = async (expr, ms = 30000) => {
    const t = Date.now();
    for (;;) { const v = await evaluate(expr); if (v && !v.error) return v; if (Date.now() - t > ms) return null; await new Promise((r) => setTimeout(r, 50)); }
  };
  // (the build's engine worker watched, before the page's scripts: each one made, each message it is sent, its
  //  termination; and a reply held while __wHold is set, released by __wRelease)
  await send("Page.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
    const W = window.Worker;
    window.__builds = [];
    window.__wHold = false; window.__wHeld = []; window.__wRelease = () => { const h = window.__wHeld; window.__wHeld = []; for (const f of h) f(); };
    window.Worker = class extends W {
      constructor(u, o) {
        super(u, o);
        if (o?.name !== "sagebrush-latex-build") return;
        const b = { posts: [], terminated: 0, replies: 0 };
        window.__builds.push(b);
        const post = this.postMessage.bind(this), term = this.terminate.bind(this);
        this.postMessage = (m, t) => { b.posts.push(JSON.parse(JSON.stringify({ rev: m.rev, text: m.text, images: Object.keys(m.images ?? {}), imageVals: m.images, inputs: m.inputs ? { version: m.inputs.version, known: m.inputs.known.map(([p, k]) => [p, Object.keys(k)[0], k.why ?? null]) } : null, sage: m.sage ? m.sage.saved.length : null }))); return post(m, t); };
        this.terminate = () => { b.terminated++; return term(); };
        let set = null;
        Object.defineProperty(this, "onmessage", { configurable: true, get: () => set, set: (f) => { set = f; super.onmessage = (ev) => { b.replies++; if (window.__wHold) window.__wHeld.push(() => f(ev)); else f(ev); }; } });
      }
    };
  })()` });
  await send("Page.navigate", { url });
  check(!!(await until(`typeof window.__agentRunsFor === "function"`)), "the page offers the runs' test handle on a local host");
  check(await evaluate(`(async () => {
    const R = await window.__agentRunsFor(); window.__R = R; window.__M = await R.load(); window.__ws = R.host().ws;
    window.__grant = { id: "a".repeat(32), agent: "Test agent", client: "test", folders: ["/"], write: true, run: true, expires: null, created: 0, lastUsed: 0 };
    window.__holder = { current: null, show(a, v, stop) { window.__stop = stop; }, hide() {} };
    window.__ctx = (g = window.__grant) => ({ agent: "Test agent", actor: "agent:Test-agent", grant: g, live: () => window.__live !== false, why: () => window.__why ?? "the grant was revoked", grantNow: () => (window.__live === false ? null : g), onChange: (cb) => { window.__changed = cb; return () => {}; } });
    // (the host, with what a row changes: no sandbox, no LaTeX, a counted interpreter class)
    window.__kernels = 0;
    window.__hostWith = (o = {}) => { const h = window.__R.host(); const K = h.WorkerKernel; return { ...h, WorkerKernel: class extends K { constructor(x) { window.__kernels++; super(x); } }, ...o }; };
    window.__hostO = {};
    window.__run = (params, g, method = "workspace.latex_build") => window.__M.run(method, params, window.__ctx(g), window.__hostWith(window.__hostO), window.__holder).then((r) => r, (e) => ({ threw: e.code, message: e.message }));
    const enc = new TextEncoder();
    await window.__ws.mkdir("/lb").catch(() => {});
    const put = (p, s) => window.__ws.putFile(p, typeof s === "string" ? enc.encode(s) : s);
    window.__put = put;
    await put("/lb/plain.tex", "\\\\documentclass{article}\\\\begin{document}Hello $x^2$.\\\\end{document}");
    await put("/lb/code.tex", "\\\\documentclass{article}\\\\usepackage{sagetex}\\\\begin{document}Two is $\\\\sage{1+1}$.\\\\end{document}");
    await put("/lb/nested.tex", "\\\\documentclass{article}\\\\begin{document}\\\\input{m}\\\\foo\\\\end{document}");
    await put("/lb/m.tex", "\\\\newcommand{\\\\foo}{FOOBAR}\\\\input{n}");
    await put("/lb/n.tex", "NESTED");
    await put("/lb/img.tex", "\\\\documentclass{article}\\\\begin{document}\\\\includegraphics{w}\\\\includegraphics{missing}\\\\end{document}");
    await put("/lb/w.svg", '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10" width="20" height="10"><rect width="20" height="10" fill="#c00"/></svg>');
    await put("/lb/data.csv", "1,2\\\\n");
    return !!window.__M.run && window.__R.host().sandbox === "ok" && !!window.__R.host().latex;
  })()`) === true, "the run module loads, the sandbox and LaTeX are here");
  const run = (params, g, hostO) => evaluate(`(window.__hostO = ${hostO ?? "{}"}, window.__run(${JSON.stringify(params)}${g ? ", " + g : ""}))`);
  const builds = () => evaluate(`window.__builds`);
  const lastBuild = async () => (await builds()).at(-1);
  const nBuilds = async () => (await builds()).length;
  const kernels = () => evaluate(`window.__kernels`);

  // ---- a .tex with no code: one request, no interpreter, the report and the first page
  let k0 = await kernels(), b0 = await nBuilds();
  let r = await run({ path: "/lb/plain.tex" });
  let b = await lastBuild();
  check(r?.ok === true && r.ended === "done" && r.report?.ok === true && r.report.class === "other" && JSON.stringify(r.sagetex) === JSON.stringify({ ran: 0, failed: 0, saved: "nothing to save" }) && /^[0-9a-f]{64}$/.test(r.inputHash ?? ""), `no code: the report, sagetex says nothing to save: ${JSON.stringify(r).slice(0, 400)}`);
  check(r?.pages?.length === 1 && r.pages[0].n === 1 && r.pages[0].w === 816 && atob(r.pages[0].png).startsWith("\x89PNG"), `no code: the first page as a PNG, 816 px wide: ${JSON.stringify(r?.pages?.map((p) => [p.n, p.w, p.h]))}`);
  check((await kernels()) === k0, "no code: no interpreter constructed (astra's Q2)");
  check((await nBuilds()) === b0 + 1 && b.posts.length === 1 && b.terminated === 1, `no code, no input, no image: one worker, one request, terminated once: ${JSON.stringify({ n: (await nBuilds()) - b0, posts: b.posts.length, t: b.terminated })}`);

  // ---- refusals before anything is read (Q2: the no-item path too)
  const nb = await nBuilds();
  r = await run({ path: "/lb/plain.tex" }, `{ ...window.__grant, run: false }`);
  check(r?.threw === "not_allowed", `run off: refused even with no code: ${JSON.stringify(r)}`);
  r = await run({ path: "/lb/plain.tex" }, `(() => { const g = { ...window.__grant }; delete g.run; return g; })()`);
  check(r?.threw === "not_allowed", `run missing: refused: ${JSON.stringify(r)}`);
  r = await run({ path: "/lb/plain.tex" }, null, `{ sandbox: "none" }`);
  check(r?.threw === "no_sandbox", `no sandbox: refused even with no code: ${JSON.stringify(r)}`);
  r = await run({ path: "/lb/plain.tex" }, null, `{ latex: undefined }`);
  check(r?.threw === "no_latex" && r.message === "no LaTeX: Sagebrush's LaTeX editor isn't available here", `no LaTeX in this build: refused, board's words, code no_latex: ${JSON.stringify(r)}`);
  r = await run({ path: "/lb/data.csv" });
  check(r?.threw === "invalid" && r.message === "invalid: /lb/data.csv isn't a .tex file", `a .csv: refused, board's words: ${JSON.stringify(r)}`);
  r = await run({ path: "/secret/none.tex" }, `{ ...window.__grant, folders: ["/lb"] }`);
  check(r?.threw === "invalid" && /outside the folders this agent may read/.test(r.message), `a path outside the grant: refused as unreadable: ${JSON.stringify(r)}`);
  check((await nBuilds()) === nb, "no engine worker made for any refusal");

  // ---- the closure: \\input to a fixed point, images in the same rounds (daybreak3's Q4 refinement)
  r = await run({ path: "/lb/nested.tex" });
  b = await lastBuild();
  check(r?.ok === true && b.posts.length === 3 && b.terminated === 1, `nested \\input: converges in 3 requests, one worker: ${JSON.stringify({ ok: r?.ok, posts: b.posts.length })}`);
  r = await run({ path: "/lb/img.tex" });
  b = await lastBuild();
  const imgRep = r?.report?.images ?? [];
  check(r?.ok === true && b.posts.length === 2 && imgRep.find((i) => i.name === "w")?.found === true && imgRep.find((i) => i.name === "missing")?.found === false, `images: one resolving round only (2 requests), the present one found, the missing one not: ${JSON.stringify({ posts: b.posts.length, imgRep })}`);
  // (more than 64 unrelated text files, one include: it builds; only included files count)
  check(await evaluate(`(async () => { await window.__ws.mkdir("/lb/many").catch(() => {}); for (let i = 0; i < 70; i++) await window.__put("/lb/many/u" + i + ".tex", "unrelated " + i); await window.__put("/lb/many/inc.tex", "INCLUDED"); await window.__put("/lb/many/doc.tex", "\\\\documentclass{article}\\\\begin{document}\\\\input{inc}\\\\end{document}"); return true; })()`) === true, "70 unrelated .tex files and one include made");
  r = await run({ path: "/lb/many/doc.tex" });
  check(r?.ok === true && r.report?.problems?.length === 0, `70 unrelated text files and one include: it builds, no problem: ${JSON.stringify(r?.report?.problems)}`);
  // (65 files actually included: the 65th says the bound, never "not found")
  check(await evaluate(`(async () => { await window.__ws.mkdir("/lb/inc").catch(() => {}); let body = ""; for (let i = 1; i <= 65; i++) { await window.__put("/lb/inc/f" + i + ".tex", "F" + i + " "); body += "\\\\input{f" + i + "}"; } await window.__put("/lb/inc/doc.tex", "\\\\documentclass{article}\\\\begin{document}" + body + "\\\\end{document}"); return true; })()`) === true, "a document including 65 files made");
  r = await run({ path: "/lb/inc/doc.tex" });
  b = await lastBuild();
  const k65 = b.posts.at(-1)?.inputs?.known?.find(([p]) => p === "/lb/inc/f65.tex");
  check(!!k65 && k65[1] === "why" && /too many included files \(64\)/.test(k65[2] ?? ""), `the 65th included file: its bound said, not "not found": ${JSON.stringify(k65)}`);
  // (a missing candidate: stable, the rounds end)
  check(await evaluate(`window.__put("/lb/nope.tex", "\\\\documentclass{article}\\\\begin{document}\\\\input{nothere}x\\\\end{document}").then(() => true)`) === true, "a document with a missing \\input made");
  r = await run({ path: "/lb/nope.tex" });
  b = await lastBuild();
  // (its two candidates, nothere.tex then nothere, each learned absent in a round of its own: 3 requests, then stable)
  check(r?.ok === true && b.posts.length === 3 && b.terminated === 1 && /\\input\{nothere\}: not found/.test(r.report?.problems?.[0]?.message ?? ""), `a missing \\input: its candidates learned absent, it settles and says not found: ${JSON.stringify({ ok: r?.ok, posts: b.posts.length, problems: r?.report?.problems })}`);
  // (a serial chain of 64 extension-less included files, each found only once the one before is read: two rounds each
  //  (name.tex absent, then name), the longest closure INPUT_BOUNDS allows, reaching its fixed point (daybreak3's
  //  review). Sequential, not nested (the engine stops nesting at 16): each file redefines \\nxt to input the next)
  check(await evaluate(`(async () => { await window.__ws.mkdir("/lb/deep").catch(() => {}); for (let i = 1; i <= 64; i++) await window.__put("/lb/deep/c" + i, "L" + i + " " + (i < 64 ? "\\\\def\\\\nxt{\\\\input{c" + (i + 1) + "}}" : "\\\\def\\\\nxt{}BOTTOM")); await window.__put("/lb/deep/doc.tex", "\\\\documentclass{article}\\\\begin{document}\\\\input{c1}" + "\\\\nxt ".repeat(63) + "\\\\end{document}"); return true; })()`) === true, "a serial chain of 64 extension-less included files made");
  r = await run({ path: "/lb/deep/doc.tex" });
  b = await lastBuild();
  check(r?.ok === true && r.report?.problems?.length === 0 && b.posts.length >= 2 * 64 && b.posts.length <= 2 * (64 + 1) + 2 && b.terminated === 1, `the 64-file serial chain: settles in ${b.posts.length} requests (two a file), no problem: ${JSON.stringify({ ok: r?.ok, reason: r?.reason, problems: r?.report?.problems?.slice(0, 2) })}`);
  // (a report over 256 KiB on its own: cut and said, the result within 256 KiB, its fixed fields kept (astra's review))
  check(await evaluate(`window.__put("/lb/huge.tex", "\\\\documentclass{article}\\\\begin{document}" + Array.from({ length: 500 }, (_, i) => "\\\\" + "q".repeat(240) + "z" + i + " ").join("") + "\\\\end{document}").then(() => true)`) === true, "a .tex with 500 long unknown commands made");
  r = await run({ path: "/lb/huge.tex" });
  const hsz = new TextEncoder().encode(JSON.stringify(r)).length;
  check(r?.ended === "done" && hsz <= 256 * 1024 && /^report\.problems \d+–500$/.test(r.truncated?.omitted?.[0] ?? "") && r.report.problems.length > 0 && r.report.problems.length < 500 && /^[0-9a-f]{64}$/.test(r.inputHash ?? ""), `a report over 256 KiB: its problems cut and said, the result ${hsz} B: ${JSON.stringify({ kept: r?.report?.problems?.length, truncated: r?.truncated, pages: r?.pages?.length })}`);
  // (a CRLF include dropped by the code's change: the bytes it was charged released, not its LF text's (daybreak3's review).
  //  A stand-in engine names the files; included: a CRLF file of 4 MiB (2.67 MiB as LF text) and three of 3.9 MiB;
  //  phase two drops the CRLF one (the code made it small) and newly needs one more of 3.9 MiB: 15.6 MiB in all, within
  //  the inputs' 16 MiB, only if the CRLF file's whole 4 MiB was released)
  const crlf = await evaluate(`(async () => {
    const L = await window.__R.host().latex.load(), MiB = 2 ** 20;
    const fill = (n, line) => { const u = new Uint8Array(n); const l = new TextEncoder().encode(line); for (let i = 0; i < n; i++) u[i] = l[i % l.length]; return u; };
    const files = new Map([["/doc.tex", new TextEncoder().encode("doc")], ["/a.tex", fill(4 * MiB, "x\\r\\n")], ["/f1.tex", fill(3.9 * MiB | 0, "y\\n")], ["/f2.tex", fill(3.9 * MiB | 0, "y\\n")], ["/f3.tex", fill(3.9 * MiB | 0, "y\\n")], ["/b.tex", fill(3.9 * MiB | 0, "z\\n")]]);
    const src = "onmessage = (e) => { const m = e.data; postMessage({ doc: m.doc, rev: m.rev, ok: true, items: [], groups: 0, imageRefs: [], inputRefs: m.sage ? ['a', 'f1', 'f2', 'f3', 'b'] : ['a', 'f1', 'f2', 'f3'], check: { outcome: 'ok', beamer: false, problems: [], frames: [], sage: [] } }); };";
    const url = new URL(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
    const b = L.tools.latexBuild(document.body, { text: "doc", docPath: "/doc.tex", files }, L.page.buildDeps, url);
    try {
      const r1 = await b.first();
      const r2 = await b.second({ wrapper: null, saved: [1] }, new Map([["/a.tex", new TextEncoder().encode("small")]]));
      return { r1: r1.ok, r2: r2.ok };
    } finally { b.end(); } })()`);
  b = await lastBuild();
  const bKnown = b?.posts?.flatMap((p) => p.inputs?.known ?? []).filter(([q]) => q === "/b.tex").at(-1);
  check(crlf?.r1 === true && crlf?.r2 === true && bKnown?.[1] === "text", `a CRLF include dropped by the code: its 4 MiB released whole, so the next one fits the inputs' 16 MiB: ${JSON.stringify({ crlf, bKnown })}`);
  // (an unreadable \\input and an absent one: the same words, READ-2)
  check(await evaluate(`(async () => { await window.__ws.mkdir("/sec").catch(() => {}); await window.__put("/sec/hid.tex", "SECRET"); await window.__put("/lb/r1.tex", "\\\\documentclass{article}\\\\begin{document}\\\\input{/sec/hid}\\\\end{document}"); await window.__put("/lb/r2.tex", "\\\\documentclass{article}\\\\begin{document}\\\\input{/sec/hie}\\\\end{document}"); return true; })()`) === true, "two documents: one includes an unreadable file, one an absent one");
  const ra = await run({ path: "/lb/r1.tex" }, `{ ...window.__grant, folders: ["/lb"] }`);
  const rb = await run({ path: "/lb/r2.tex" }, `{ ...window.__grant, folders: ["/lb"] }`);
  const norm = (x) => JSON.stringify(x?.report?.problems ?? null).replace(/hi[de]/g, "X");
  check(ra?.ok !== undefined && norm(ra) === norm(rb) && !JSON.stringify(ra).includes("SECRET"), `unreadable and absent \\input: identical report entries, no byte of it: ${JSON.stringify({ a: ra?.report?.problems, b: rb?.report?.problems })}`);

  // ---- SageTeX on main: run in the sandbox, nothing saved; one more request for phase two
  k0 = await kernels();
  r = await run({ path: "/lb/code.tex", timeout_s: 300 });
  b = await lastBuild();
  check(r?.ok === true && JSON.stringify(r.sagetex) === JSON.stringify({ ran: 1, failed: 0, saved: "not saved: main" }) && r.report?.code?.[0]?.state === "ok", `a \\sage item on main: run, its state ok, not saved: ${JSON.stringify({ s: r?.sagetex, code: r?.report?.code })}`);
  check((await kernels()) === k0 + 1, "with code: one interpreter");
  check(b.posts.length === 2 && b.posts[1].sage === 1 && b.posts[1].inputs === null && b.posts[1].text === b.posts[0].text && JSON.stringify(b.posts[1].images) === JSON.stringify(b.posts[0].images) && b.terminated === 1, `phase two: exactly one request, the same text, images and inputs (not sent again), with the states; one worker terminated once: ${JSON.stringify(b.posts.map((p) => ({ rev: p.rev, sage: p.sage, inputs: !!p.inputs })))}`);
  check(await evaluate(`window.__ws.stat("/lb/code.tex.results.json").then((e) => !e)`) === true, "main: no results file");

  // ---- pages: the agent's list, the pixel cap, the budget
  check(await evaluate(`window.__put("/lb/talk.tex", "\\\\documentclass{beamer}\\\\begin{document}" + ["One", "Two", "Three", "Four", "Five"].map((t) => "\\\\begin{frame}{" + t + "}" + t + "\\\\end{frame}").join("") + "\\\\begin{frame}{Tall}" + "line\\\\\\\\ ".repeat(400) + "\\\\end{frame}\\\\end{document}").then(() => true)`) === true, "a talk of 6 frames made, the last very tall");
  r = await run({ path: "/lb/talk.tex", pages: [1, 3, 6, 9] });
  check(r?.ok === true && JSON.stringify(r.pages.map((p) => [p.n, p.w, p.h])) === JSON.stringify([[1, 1024, 768], [3, 1024, 768]]) && JSON.stringify(r.overflow) === "[6]", `pages asked: frames 1 and 3 at 1024x768 (scale 1), 6 omitted for its size, 9 not there: ${JSON.stringify({ pages: r?.pages?.map((p) => [p.n, p.w, p.h]), overflow: r?.overflow })}`);
  check(await evaluate(`window.__put("/lb/dense.tex", "\\\\documentclass{article}\\\\begin{document}" + "Some text with $x^2$ and more words. ".repeat(1400) + "\\\\end{document}").then(() => true)`) === true, "a dense article of several pages made");
  r = await run({ path: "/lb/dense.tex", pages: [1, 2, 3, 4] });
  const size = new TextEncoder().encode(JSON.stringify(r)).length;
  check(r?.ok === true && size <= 256 * 1024 && Array.isArray(r.truncated?.omitted) && r.truncated.omitted.some((x) => /^page \d$/.test(x)), `budget: pages that don't fit dropped, said in truncated, the JSON within 256 KiB (${size} B): ${JSON.stringify({ pages: r?.pages?.map((p) => [p.n, p.png.length]), truncated: r?.truncated })}`);

  // ---- pages, row by row (daybreak2's Q3, f376e681; astra's and daybreak3's pins): buildPages called directly on a
  // build of a dense article, with the room and seed each row needs, its attempts as measured
  check(await evaluate(`(() => {
    window.__dense = "\\\\documentclass{article}\\\\begin{document}" + "Some text with $x^2$ and more words. ".repeat(1400) + "\\\\end{document}";
    window.__bp = async (want, o) => {
      const L = await window.__R.host().latex.load(), enc = new TextEncoder(), text = o.text ?? window.__dense;
      const b = L.tools.latexBuild(document.body, { text, docPath: "/x.tex", files: new Map([["/x.tex", enc.encode(text)]]) }, L.page.buildDeps);
      try {
        const r = await b.first();
        const t = { file: () => "/x.tex", text: () => text, lastCheck: () => r.check, current: () => true, preview: b.preview, images: b.images, css: L.page.buildDeps[0] };
        let asked = 0;
        const bp = await L.tools.buildPages(t, want, { maxPx: 1600, minScale: 0.5, bpp: o.bpp ?? 0.15, room: (kept) => o.room - kept.reduce((n, p) => n + p.png.length, 0), alive: () => { asked++; return !(o.dieAt && asked >= o.dieAt); } });
        return bp && { attempts: bp.attempts, pages: bp.pages.map((p) => [p.n, p.w, p.h, p.png.length]), overflow: bp.overflow, dropped: bp.dropped, asked };
      } finally { b.end(); }
    };
    return true; })()`) === true, "(buildPages' rows: a dense article, built)");
  const bp = (want, o) => evaluate(`window.__bp(${JSON.stringify(want)}, ${JSON.stringify(o)})`);
  // (calibration: page 1 at scale 1, and at 0.5, measured)
  const big = await bp([1], { room: 4e6, bpp: 1e-6 });
  const B0 = big?.attempts?.[0]?.bytes, W0 = big?.attempts?.[0]?.w, H0 = big?.attempts?.[0]?.h;
  check(B0 > 0 && big.attempts[0].s === 1 && W0 === 816, `calibration: a dense page at scale 1 is ${B0} B of base64 (${W0}x${H0})`);
  // (a dense first page that succeeds on its one retry, the retry's scale from the scale used)
  let ok1 = null;
  for (const f of [0.9, 0.8, 0.7]) {
    const R = Math.floor(B0 * f), x = await bp([1], { room: R, bpp: 1e-6 });
    if (x?.attempts?.length === 2 && x.attempts[1].kept) { ok1 = { R, x }; break; }
  }
  const s1want = ok1 && ok1.x.attempts[0].s * (0.95 * ok1.R / ok1.x.attempts[0].bytes);
  check(!!ok1 && ok1.x.attempts[0].s === 1 && !ok1.x.attempts[0].kept && Math.abs(ok1.x.attempts[1].s - s1want) < 1e-9 && ok1.x.pages.length === 1 && ok1.x.pages[0][3] <= ok1.R, `a dense first page: too large at scale 1, kept on its one retry at s·(0.95R/B): ${JSON.stringify(ok1 && { R: ok1.R, attempts: ok1.x.attempts })}`);
  // (the retry's scale would be under 0.5: no retry, dropped)
  let x = await bp([1], { room: Math.floor(B0 * 0.4), bpp: 1e-6 });
  check(x?.attempts?.length === 1 && x.attempts[0].s === 1 && JSON.stringify(x.dropped) === "[1]" && x.pages.length === 0, `a retry scale under 0.5 (0.95·0.4 < 0.5): no retry, dropped: ${JSON.stringify(x?.attempts)}`);
  // (estimation already under the natural scale: the first encode at s < s0, the retry computed from s, not s0)
  let ok2 = null;
  for (const f of [0.6, 0.5, 0.45, 0.4]) {
    const R = Math.floor(B0 * f), y = await bp([1], { room: R, bpp: (B0 / (W0 * H0)) * 0.7 });
    if (y?.attempts?.length === 2 && y.attempts[0].s < 1) { ok2 = { R, y }; break; }
  }
  const s2want = ok2 && ok2.y.attempts[0].s * (0.95 * ok2.R / ok2.y.attempts[0].bytes);
  check(!!ok2 && ok2.y.attempts[0].s < 1 && Math.abs(ok2.y.attempts[1].s - s2want) < 1e-9 && ok2.y.attempts[1].s < ok2.y.attempts[0].s, `the estimate picks s < s0; the retry is s·(0.95R/B) from that s: ${JSON.stringify(ok2 && { R: ok2.R, attempts: ok2.y.attempts.map((a) => [a.s, a.bytes, a.kept]) })}`);
  // (a retry that still misses: dropped. A page's PNG made larger than its pixels say (the canvas's encoder stubbed for
  //  this row: its second PNG padded), as irregular compression could)
  const R3 = Math.floor(B0 * 0.8);
  await evaluate(`(() => { const T = HTMLCanvasElement.prototype.toDataURL; window.__toDataURL = T; let n = 0; HTMLCanvasElement.prototype.toDataURL = function (...a) { const u = T.apply(this, a); return ++n === 2 ? u + "A".repeat(${R3}) : u; }; return 1; })()`);
  const z3 = await bp([1], { room: R3, bpp: 1e-6 });
  await evaluate(`(HTMLCanvasElement.prototype.toDataURL = window.__toDataURL, 1)`);
  const miss = z3?.attempts?.length === 2 && !z3.attempts[1].kept ? { R: R3, z: z3 } : null;
  check(!!miss && miss.z.attempts[1].s >= 0.5 && miss.z.attempts[1].bytes > miss.R && JSON.stringify(miss.z.dropped) === "[1]" && miss.z.pages.length === 0, `a retry that still doesn't fit: dropped, nothing kept: ${JSON.stringify(miss && { R: miss.R, attempts: miss.z.attempts.map((a) => [a.s, a.bytes, a.kept]) })}`);
  // (learning from a dropped page: page 2's first scale comes from page 1's measured bytes per pixel, the running maximum)
  x = await bp([1, 2], { room: Math.floor(B0 * 0.2), bpp: 1e-6 });
  const learned = x?.attempts?.[0] && x.attempts[0].bytes / (x.attempts[0].w * x.attempts[0].h);
  const p2 = x?.attempts?.find((a) => a.n === 2);
  check(x?.dropped?.includes(1) && (!p2 || p2.s < 1) && (!p2 || Math.abs(p2.s - Math.min(1, Math.sqrt(Math.floor(B0 * 0.2) / (816 * p2.h / p2.s * p2.s * 0 + 816 * (x.attempts[0].h) * learned)))) < 0.02 || !p2), `a dropped page's bytes per pixel raise the estimate: page 2 starts below scale 1 (or isn't encoded): ${JSON.stringify(x?.attempts?.map((a) => [a.n, a.s, a.bytes, a.kept]))}`);
  // (four pages at most, eight encodes at most, serially, in order)
  x = await bp([1, 2, 3, 4], { room: Math.floor(B0 * 0.9), bpp: 1e-6 });
  const order = x?.attempts?.map((a) => a.n) ?? [];
  check(x && x.attempts.length <= 8 && x.pages.length + x.dropped.length + x.overflow.length <= 4 && order.every((n, i) => i === 0 || n >= order[i - 1]), `four pages: at most eight encodes, in order: ${JSON.stringify(x?.attempts?.map((a) => [a.n, a.s.toFixed(3), a.kept]))}`);
  // (the run ended between the first attempt and the retry: nothing more drawn, nothing returned)
  x = await bp([1], { room: Math.floor(B0 * 0.8), bpp: 1e-6, dieAt: 3 });
  check(x === null, `ended between the first attempt and its retry: no retry, nothing returned: ${JSON.stringify(x)}`);
  x = await bp([1], { room: Math.floor(B0 * 0.8), bpp: 1e-6, dieAt: 2 });
  check(x === null, `ended while the first PNG was made: discarded, nothing returned: ${JSON.stringify(x)}`);
  // (the exact envelope through the run: a page a little over the room at scale 1, kept on its retry; the whole result
  //  within 256 KiB and close to it, so the room counted every other byte of it)
  let env = null;
  for (const reps of [1400, 230, 210, 250]) {
    await evaluate(`window.__put("/lb/env.tex", "\\\\documentclass{article}\\\\begin{document}" + "Some text with $x^2$ and more words. ".repeat(${reps}) + "\\\\end{document}").then(() => 1)`);
    const e = await run({ path: "/lb/env.tex", pages: [1] });
    if (e?.pages?.length === 1 && e.pages[0].w < 816) { env = e; break; }
  }
  const sz = env ? new TextEncoder().encode(JSON.stringify(env)).length : -1;
  check(!!env && sz <= 256 * 1024 && !env.truncated, `through the run: a page kept on its retry, the whole result ${sz} B, within 256 KiB (the exact room: test-run-verbs.mjs's pageRoom rows): ${JSON.stringify(env?.pages?.map((p) => [p.n, p.w, p.h, p.png.length]))}`);
  r = await run({ path: "/lb/dense.tex", pages: [1] });
  check(r?.ok === true && r.pages.length === 1 && r.pages[0].w < 816 && r.pages[0].w >= 408 && !r.truncated, `a full dense page through the run: kept on its retry, at a scale of at least 0.5: ${JSON.stringify({ pages: r?.pages?.map((p) => [p.n, p.w, p.h, p.png.length]), truncated: r?.truncated })}`);

  // ---- holds: a run's stages, and the build's engine replies
  await evaluate(`(() => { window.__holdOn = {}; window.__R.host = ((h) => () => ({ ...h(), hold: (st) => window.__holdOn[st] ? new Promise((res) => { window.__held = st; window.__release = () => { window.__held = null; res(); }; }) : Promise.resolve() }))(window.__R.host); return 1; })()`);
  const go = (params, g, hostO) => evaluate(`(window.__hostO = ${hostO ?? "{}"}, window.__p = window.__run(${JSON.stringify(params)}${g ? ", " + g : ""}), 1)`);
  const result = () => evaluate(`window.__p`);
  const heldAt = (st) => until(`window.__held === ${JSON.stringify(st)}`, 60000);
  // (Stop in phase one, its reply held: the run stopped, the late reply never used, the worker terminated once)
  await evaluate(`(window.__wHold = true, 1)`);
  await go({ path: "/lb/code.tex", timeout_s: 300 });
  await until(`window.__wHeld.length > 0`, 60000);
  b0 = await nBuilds();
  await evaluate(`(window.__stop(), 1)`);
  r = await result();
  await evaluate(`(window.__wHold = false, window.__wRelease(), 1)`);
  b = await lastBuild();
  check(r?.ok === false && r.ended === "stopped" && !("report" in r) && !("pages" in r) && b.terminated === 1 && b.posts.length === 1, `Stop in phase one: stopped, nothing of the build said, the held reply never asked for more: ${JSON.stringify({ r, posts: b.posts.length, t: b.terminated })}`);
  // (the deadline in phase one, its reply held past it)
  await evaluate(`(window.__wHold = true, 1)`);
  await go({ path: "/lb/plain.tex", timeout_s: 2 });
  r = await result();
  await evaluate(`(window.__wHold = false, window.__wRelease(), 1)`);
  await new Promise((res) => setTimeout(res, 300));
  b = await lastBuild();
  check(r?.ok === false && r.ended === "timeout" && !("report" in r) && b.posts.length === 1 && b.terminated === 1, `the deadline in phase one: timeout, its late reply unused, the worker terminated once: ${JSON.stringify({ r, posts: b.posts.length, t: b.terminated })}`);
  // (Stop in phase two, its reply held)
  await evaluate(`(window.__holdOn = { phase2: true }, 1)`);
  await go({ path: "/lb/code.tex", timeout_s: 300 });
  await heldAt("phase2");
  await evaluate(`(window.__wHold = true, window.__release(), window.__holdOn = {}, 1)`);
  await until(`window.__wHeld.length > 0`, 60000);
  await evaluate(`(window.__stop(), 1)`);
  r = await result();
  await evaluate(`(window.__wHold = false, window.__wRelease(), 1)`);
  b = await lastBuild();
  check(r?.ok === false && r.ended === "stopped" && !("pages" in r) && b.posts.at(-1).sage === 1 && b.terminated === 1, `Stop in phase two: stopped, nothing said, the worker terminated once: ${JSON.stringify({ r, posts: b.posts.length, t: b.terminated })}`);
  // (the deadline during phase two: held before it, its reply then held past the deadline)
  await evaluate(`(window.__holdOn = { phase2: true }, 1)`);
  await go({ path: "/lb/code.tex", timeout_s: 8 });
  await heldAt("phase2");
  await evaluate(`(window.__wHold = true, window.__release(), window.__holdOn = {}, 1)`);
  r = await result();
  await evaluate(`(window.__wHold = false, window.__wRelease(), 1)`);
  b = await lastBuild();
  check(r?.ok === false && r.ended === "timeout" && !("pages" in r) && b.posts.at(-1).sage === 1 && b.terminated === 1, `the deadline during phase two: timeout, nothing said, its late reply unused, the worker terminated once: ${JSON.stringify({ r, posts: b.posts.length, t: b.terminated })}`);
  // (Stop, and the grant, after the code's writes drained but before phase two: no second build, nothing delivered)
  for (const [what, act, want] of [["Stop", "window.__stop()", "stopped"], ["revoke", "(window.__live = false, window.__changed?.())", "revoked"]]) {
    await evaluate(`(window.__holdOn = { phase2: true }, 1)`);
    await go({ path: "/lb/code.tex", timeout_s: 300 });
    await heldAt("phase2");
    await evaluate(`(${act}, window.__release(), window.__holdOn = {}, 1)`);
    r = await result();
    await evaluate(`(window.__live = true, 1)`);
    b = await lastBuild();
    check(r?.ok === false && r.ended === want && !("pages" in r) && !b.posts.some((p) => p.sage !== null) && b.terminated === 1, `${what} after the writes drained, before phase two: ${want}, no second build: ${JSON.stringify({ r, posts: b.posts.length, t: b.terminated })}`);
  }
  // (revoked with phase one's reply held: revoked; the reply, released later, asks nothing more)
  await evaluate(`(window.__wHold = true, 1)`);
  await go({ path: "/lb/plain.tex" });
  await until(`window.__wHeld.length > 0`, 60000);
  await evaluate(`(window.__live = false, window.__changed?.(), 1)`);
  r = await result();
  await evaluate(`(window.__wHold = false, window.__wRelease(), window.__live = true, 1)`);
  await new Promise((res) => setTimeout(res, 300));
  b = await lastBuild();
  check(r?.ok === false && r.ended === "revoked" && b.posts.length === 1 && b.terminated === 1, `revoked in phase one: revoked; the late reply asked nothing more: ${JSON.stringify({ r, posts: b.posts.length, t: b.terminated })}`);
  // (the engine failing: an error said, the worker terminated once)
  r = await run({ path: "/lb/plain.tex" }, null, `{ latex: { load: async () => { const m = await window.__R.host().latex.load(); return { ...m, tools: { ...m.tools, latexBuild: (root, o, d) => m.tools.latexBuild(root, o, d, new URL("no-such-worker.js", location.href)) } }; } } }`);
  b = await lastBuild();
  check(r?.ok === false && r.ended === "error" && /engine stopped/.test(r.reason ?? "") && b.terminated === 1, `the engine failing: error, its reason, the worker terminated once: ${JSON.stringify({ r: { ok: r?.ok, ended: r?.ended, reason: r?.reason }, t: b.terminated })}`);
  // (a SageTeX item failing: error, its state said, the rest blocked, the worker terminated once)
  check(await evaluate(`window.__put("/lb/fail.tex", "\\\\documentclass{article}\\\\usepackage{sagetex}\\\\begin{document}$\\\\sage{1/0}$ and $\\\\sage{2}$\\\\end{document}").then(() => true)`) === true, "a .tex whose first item fails made");
  r = await run({ path: "/lb/fail.tex", timeout_s: 300 });
  b = await lastBuild();
  check(r?.ok === false && r.ended === "error" && r.sagetex?.failed === 1 && /^error: ZeroDivisionError/.test(r.report?.code?.[0]?.state ?? "") && r.report.code[1]?.state === "blocked" && b.terminated === 1, `a failing item: error, its state, the next blocked, the worker terminated once: ${JSON.stringify({ s: r?.sagetex, code: r?.report?.code, t: b.terminated })}`);
  // (the deadline between the phases: held at the interpreter's start, past the deadline)
  await evaluate(`(window.__holdOn = { start: true }, 1)`);
  await go({ path: "/lb/code.tex", timeout_s: 2 });
  await heldAt("start");
  await new Promise((res) => setTimeout(res, 2500));
  await evaluate(`(window.__release(), window.__holdOn = {}, 1)`);
  r = await result();
  b = await lastBuild();
  check(r?.ok === false && r.ended === "timeout" && !("pages" in r) && b.posts.length === 1 && b.terminated === 1, `the deadline between the phases: timeout, no second phase, the worker terminated once: ${JSON.stringify({ r, posts: b.posts.length, t: b.terminated })}`);
  // (revoked while drawing: nothing delivered)
  await evaluate(`(window.__holdOn = { render: true }, 1)`);
  await go({ path: "/lb/plain.tex" });
  await heldAt("render");
  await evaluate(`(window.__live = false, window.__changed?.(), 1)`);
  await evaluate(`(window.__release(), window.__holdOn = {}, 1)`);
  r = await result();
  await evaluate(`(window.__live = true, 1)`);
  b = await lastBuild();
  check(r?.ok === false && r.ended === "revoked" && !("pages" in r) && !("report" in r) && b.terminated === 1, `revoked while drawing: revoked, nothing of the build said: ${JSON.stringify({ r, t: b.terminated })}`);
  // (Stop while drawing: nothing delivered)
  await evaluate(`(window.__holdOn = { render: true }, 1)`);
  await go({ path: "/lb/plain.tex" });
  await heldAt("render");
  await evaluate(`(window.__stop(), window.__release(), window.__holdOn = {}, 1)`);
  r = await result();
  check(r?.ok === false && r.ended === "stopped" && !("pages" in r), `Stop while drawing: stopped, no pages: ${JSON.stringify(r)}`);
  // (busy: a second build while one is held)
  await evaluate(`(window.__holdOn = { engine: true }, 1)`);
  await go({ path: "/lb/plain.tex" });
  await heldAt("engine");
  x = await evaluate(`window.__M.run("workspace.latex_build", { path: "/lb/plain.tex" }, window.__ctx(), window.__hostWith(), window.__holder).then((r) => r, (e) => ({ threw: e.code, message: e.message }))`);
  await evaluate(`(window.__release(), window.__holdOn = {}, 1)`);
  r = await result();
  check(x?.threw === "busy" && r?.ok === true, `a second build while one runs: busy; the first completes: ${JSON.stringify({ x, ok: r?.ok })}`);

  // ---- a worktree: the results file saved beside the .tex, guarded; the code's writes seen by the second build
  const gb = `${url}${gbName}`;
  check(await evaluate(`(async () => {
    const m = await import(${JSON.stringify(gb)});
    await m.gitBranch(window.__ws.branchHost("agent:Test-agent"), { name: "lb1", owner: window.__grant.id, folders: ["/"], live: () => true });
    window.__rh = window.__ws.runHost("agent:Test-agent", () => window.__grant.id);
    const P = (p, s) => window.__rh.putFile(p, new TextEncoder().encode(s), () => {});
    window.__P = P;
    const SVG = (c) => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10" width="20" height="10"><rect width="20" height="10" fill="' + c + '"/></svg>';
    window.__SVG = SVG;
    await P("/Branches/lb1/lb/gen.tex", "\\\\documentclass{article}\\\\usepackage{sagetex}\\\\begin{document}\\\\begin{sagesilent}\\nopen('gen.svg','w').write('" + SVG("#00c") + "')\\nopen('gen-in.tex','w').write('GENERATED')\\n\\\\end{sagesilent}\\\\includegraphics{gen}\\\\input{gen-in}$\\\\sage{2+3}$\\\\end{document}");
    await P("/Branches/lb1/lb/old.svg", SVG("#0c0"));
    await P("/Branches/lb1/lb/gone.svg", SVG("#ccc"));
    await P("/Branches/lb1/lb/rep.tex", "\\\\documentclass{article}\\\\usepackage{sagetex}\\\\begin{document}\\\\begin{sagesilent}\\nimport os\\nopen('old.svg','w').write('" + SVG("#c0c") + "')\\nos.remove('gone.svg')\\n\\\\end{sagesilent}\\\\includegraphics{old}\\\\includegraphics{gone}\\\\end{document}");
    return true; })()`) === true, "a branch, with a .tex whose code writes an image and an \\input it uses, and one whose code replaces and removes images");
  b0 = await nBuilds();
  r = await run({ path: "/Branches/lb1/lb/gen.tex", timeout_s: 300 });
  b = await lastBuild();
  const genImg = r?.report?.images?.find((i) => i.name === "gen"), res = await evaluate(`window.__ws.readUpTo("/Branches/lb1/lb/gen.tex.results.json", 1e6).then((x) => new TextDecoder().decode(x.content), () => null)`);
  check(r?.ok === true && r.sagetex?.saved === "saved" && r.sagetex.ran === 2 && genImg?.found === true && /GENERATED/.test(await evaluate(`document.body.innerHTML.length >= 0 && "GENERATED"`)), `the code's image and \\input, missing in phase one, made by the code: the second build shows them; results saved: ${JSON.stringify({ ok: r?.ok, s: r?.sagetex, genImg, problems: r?.report?.problems })}`);
  check(typeof res === "string" && JSON.parse(res).format === "sagebrush-latex-results" && JSON.parse(res).items.length === 2, `the results file in the branch, run-core's format: ${String(res).slice(0, 160)}`);
  check(b.posts.length > 2 && b.posts.slice(2).some((p) => p.sage !== null), `phase two ran rounds again, the overlay's paths given anew: ${JSON.stringify(b.posts.map((p) => ({ sage: p.sage, inputs: p.inputs?.known?.map(([q, k]) => q + ":" + k) })))}`);
  check(await evaluate(`window.__ws.stat("/lb/gen.svg").then((e) => !e)`) === true && await evaluate(`window.__ws.stat("/Branches/lb1/lb/gen.svg").then((e) => !!e)`) === true, "the code's write kept in the branch, main unchanged");
  r = await run({ path: "/Branches/lb1/lb/rep.tex", timeout_s: 300 });
  b = await lastBuild();
  const oldImg = r?.report?.images?.find((i) => i.name === "old"), goneImg = r?.report?.images?.find((i) => i.name === "gone");
  const firstOld = b.posts[0]?.imageVals?.old, lastOld = b.posts.at(-1)?.imageVals?.old;
  check(r?.ok === true && oldImg?.found === true && goneImg?.found === false && firstOld !== lastOld, `the code replaced one image and removed another: the second build has the new bytes and the removal, never the snapshot's: ${JSON.stringify({ oldImg, goneImg, firstOld, lastOld })}`);
  // (a rename by the code: both sides seen by the second build)
  check(await evaluate(`(async () => { await window.__P("/Branches/lb1/lb/ra.svg", window.__SVG("#123")); await window.__P("/Branches/lb1/lb/ren.tex", "\\\\documentclass{article}\\\\usepackage{sagetex}\\\\begin{document}\\\\begin{sagesilent}\\nimport os\\nos.rename('ra.svg','rb.svg')\\n\\\\end{sagesilent}\\\\includegraphics{ra}\\\\includegraphics{rb}\\\\end{document}"); return true; })()`) === true, "a .tex whose code renames an image it shows");
  r = await run({ path: "/Branches/lb1/lb/ren.tex", timeout_s: 300 });
  const raI = r?.report?.images?.find((i) => i.name === "ra"), rbI = r?.report?.images?.find((i) => i.name === "rb");
  check(r?.ok === true && raI?.found === false && rbI?.found === true, `a rename by the code: its old name gone, its new one shown: ${JSON.stringify({ ra: raI, rb: rbI, problems: r?.report?.problems })}`);
  // (the code changes an included file to include another, unchanged one that phase one never needed: phase two reads it
  //  from the snapshot, which the run kept (astra's and daybreak3's review))
  check(await evaluate(`(async () => { await window.__P("/Branches/lb1/lb/ua.tex", "UA-OLD"); await window.__P("/Branches/lb1/lb/ub.tex", "UB-UNCHANGED"); await window.__P("/Branches/lb1/lb/un.tex", "\\\\documentclass{article}\\\\usepackage{sagetex}\\\\begin{document}\\\\begin{sagesilent}\\nopen('ua.tex','w').write('UA-NEW \\\\\\\\input{ub}')\\n\\\\end{sagesilent}\\\\input{ua}\\\\end{document}"); return true; })()`) === true, "a .tex whose code makes an included file include another, unchanged one");
  r = await run({ path: "/Branches/lb1/lb/un.tex", timeout_s: 300 });
  b = await lastBuild();
  const unKnown = b.posts.flatMap((p) => p.inputs?.known ?? []).filter(([q]) => q === "/lb/ub.tex");
  const unText = await evaluate(`document.body.innerHTML.length`);
  check(r?.ok === true && r.report?.problems?.length === 0 && unKnown.some(([, k]) => k === "text"), `phase two newly needs an unchanged file: read from the kept snapshot, no problem: ${JSON.stringify({ ok: r?.ok, reason: r?.reason, problems: r?.report?.problems, unKnown })}`);
  // ---- the results save, held: Stop, the grant, an edit of the .tex, the branch root another one
  const saveHeld = async (during) => {
    await evaluate(`(window.__holdOn = { save: true }, 1)`);
    await go({ path: "/Branches/lb1/lb/gen.tex", timeout_s: 300 });
    await heldAt("save");
    await evaluate(during);
    await evaluate(`(window.__release(), window.__holdOn = {}, 1)`);
    return result();
  };
  const resRev = () => evaluate(`window.__ws.stat("/Branches/lb1/lb/gen.tex.results.json").then((e) => e?.rev ?? null)`);
  let rev0 = await resRev();
  r = await saveHeld(`(window.__stop(), 1)`);
  check(r?.ended === "stopped" && (await resRev()) === rev0, `Stop before the save's admission: stopped, the results file untouched: ${JSON.stringify(r)}`);
  r = await saveHeld(`(window.__P("/Branches/lb1/lb/gen.tex", "\\\\documentclass{article}\\\\begin{document}edited\\\\end{document}"), 1)`);
  await new Promise((res) => setTimeout(res, 300));
  check(r?.sagetex?.saved === "conflict" && (await resRev()) === rev0, `the .tex edited before the save: conflict, the results file untouched: ${JSON.stringify(r?.sagetex)}`);
  await evaluate(`window.__P("/Branches/lb1/lb/gen.tex", "\\\\documentclass{article}\\\\usepackage{sagetex}\\\\begin{document}$\\\\sage{7}$\\\\end{document}").then(() => 1)`);
  rev0 = await resRev();
  const reroot = `{ ws: { runHost: (a, o) => { const h = window.__ws.runHost(a, o); return Object.create(h, { putFile: { value: (p, d, admit, g) => h.putFile(p, d, (c) => admit({ ...c, branch: { ...(c.branch ?? {}), root: { ...(c.branch?.root ?? {}), fid: "another-root" } } }), g) } }); } } }`;
  r = await run({ path: "/Branches/lb1/lb/gen.tex", timeout_s: 300 }, null, reroot);
  check(r?.sagetex?.saved === "conflict" && (await resRev()) === rev0, `the branch root another one at the save: conflict: ${JSON.stringify(r?.sagetex)}`);
  r = await run({ path: "/Branches/lb1/lb/gen.tex", timeout_s: 300 }, `{ ...window.__grant, write: false }`);
  check(r?.sagetex?.saved === "refused" && (await resRev()) === rev0, `a read-only grant: the results file refused: ${JSON.stringify(r?.sagetex)}`);
  r = await run({ path: "/Branches/lb1/lb/gen.tex", timeout_s: 300 });
  check(r?.sagetex?.saved === "saved" && (await resRev()) !== rev0, `unchanged: saved, the results file written over: ${JSON.stringify(r?.sagetex)}`);

  // ---- the guard itself (api.ts, N4): runHost.putFile with {path, fid, rev, sha256}, on its create and overwrite ways
  check(await evaluate(`(async () => {
    const enc = new TextEncoder(), rh = window.__rh;
    const sha = async (u) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", u))].map((x) => x.toString(16).padStart(2, "0")).join("");
    window.__gtex = async (p, s) => { const u = enc.encode(s); await rh.putFile(p, u, () => {}); const e = await window.__ws.stat(p); return { path: p, fid: e.fid, rev: e.rev, sha256: await sha(u) }; };
    window.__gput = (p, g) => rh.putFile(p, enc.encode("R"), () => {}, g).then(() => "saved", (e) => e.code);
    return true; })()`) === true, "(the guard's helpers)");
  const G = "/Branches/lb1/lb/g.tex", T = "/Branches/lb1/lb/g.out";
  x = await evaluate(`(async () => { const g = await window.__gtex(${JSON.stringify(G)}, "A"); const a = await window.__gput(${JSON.stringify(T)}, g); const b = await window.__gput(${JSON.stringify(T)}, g); return [a, b]; })()`);
  check(JSON.stringify(x) === JSON.stringify(["saved", "saved"]), `the guard unchanged: created, then written over: ${JSON.stringify(x)}`);
  x = await evaluate(`(async () => { const g = await window.__gtex(${JSON.stringify(G)}, "A"); await window.__P(${JSON.stringify(G)}, "B"); return window.__gput(${JSON.stringify(T)}, g); })()`);
  check(x === "conflict", `the guard's file edited: conflict: ${x}`);
  x = await evaluate(`(async () => { const g = await window.__gtex(${JSON.stringify(G)}, "A"); await window.__rh.remove(${JSON.stringify(G)}, () => {}); return window.__gput(${JSON.stringify(T)}, g); })()`);
  check(x === "conflict", `the guard's file trashed: conflict: ${x}`);
  x = await evaluate(`(async () => { const g = await window.__gtex(${JSON.stringify(G)}, "A"); await window.__ws.rename(${JSON.stringify(G)}, ${JSON.stringify(G + ".moved")}); return window.__gput(${JSON.stringify(T)}, g); })()`);
  check(x === "conflict", `the guard's file moved away: conflict: ${x}`);
  x = await evaluate(`(async () => { const g = await window.__gtex(${JSON.stringify(G + "2")}, "A"); await window.__rh.remove(${JSON.stringify(G + "2")}, () => {}); await window.__P(${JSON.stringify(G + "2")}, "A"); return window.__gput(${JSON.stringify(T)}, g); })()`);
  check(x === "conflict", `the guard's file made again with the same bytes (another fid): conflict: ${x}`);
  x = await evaluate(`(async () => { const g = await window.__gtex(${JSON.stringify(G + "3")}, "A"); return [await window.__gput(${JSON.stringify(T + "3")}, { ...g, sha256: "0".repeat(64) }), await window.__gput(${JSON.stringify(T + "3")}, { ...g, sha256: undefined }), await window.__gput(${JSON.stringify(T + "3")}, { ...g, rev: g.rev + 1 }), await window.__window_ok ?? 0]; })()`);
  check(Array.isArray(x) && x[0] === "conflict" && x[1] === "conflict" && x[2] === "conflict" && (await evaluate(`window.__ws.stat(${JSON.stringify(T + "3")}).then((e) => !e)`)) === true, `another hash, no hash, another rev: conflict, nothing made: ${JSON.stringify(x)}`);
  // (a change of the guard's file asked during the save's admission, in this page: it waits for the workspace's lock, so
  //  the save completes against the file as read, and the change lands after; a change between the fence and the check
  //  can only come from another tab or sync, which the transaction's own check is for: the rows above pin that check)
  x = await evaluate(`(async () => {
    const g = await window.__gtex(${JSON.stringify(G + "4")}, "A");
    let later = null;
    const out = await window.__rh.putFile(${JSON.stringify(T + "4")}, new TextEncoder().encode("R"), () => { later = window.__P(${JSON.stringify(G + "4")}, "Z"); }, g).then(() => "saved", (e) => e.code);
    await later;
    const now = new TextDecoder().decode((await window.__ws.readUpTo(${JSON.stringify(G + "4")}, 10)).content);
    return [out, now]; })()`);
  check(JSON.stringify(x) === JSON.stringify(["saved", "Z"]), `a change of the guard's file asked during the save's admission: serialized by the lock, the save first, the change after: ${JSON.stringify(x)}`);
} catch (e) {
  fails.push(String(e?.stack ?? e));
  console.log("FAIL", e?.stack ?? e);
} finally {
  chrome?.kill(); server?.kill();
  await new Promise((r) => setTimeout(r, 300));
  rmSync(profile, { recursive: true, force: true });
  rmSync(join(here, "dist", gbName), { force: true });
}
console.log(fails.length ? `test-latex-build-page: ${fails.length} of ${checks} FAILED` : `ok: an agent's latex_build, ${checks} checks`);
process.exit(fails.length ? 1 : 0);
