// ci: checks.3 order=105 runner=bun
// (checks.3: after the job's final build-cli, as this runs the session's script in build/cli/pyjs.cjs --sage, with node;
// bun runs the rest: web/notebook's runner and kernel are ES modules in .js files; about 4 s)
// The editor's Run (run-core.mjs), without a browser: the session's script run in the CLI's own Sage (the same
// engine's Python and preparser as the page's runner), its printed results parsed and turned into the results file's
// states; then those states shown by the renderer's own rule (sagetex.mjs savedStates/stateOf). William's case: a
// value, a computation, a name defined again later (page order), a failing item whose later readers show Sage's
// NameError and the rest still run, a plot as an SVG; and the parts alone: refused items, a session that stopped,
// unreadable lines, bounds, a traceback without the script's frames.
//   node scripts/build-cli.mjs && bun web/latex/test-latex-run.mjs
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { driver, runnable, parseOutput, statesOf, resultsText, msgOf, MARK, RUN_LIMITS, RESULTS_FORMAT, runAndSave, sessionOf, sandboxEngine, SANDBOX_FAILED } from "./run-core.mjs";
import { itemKey, savedStates, stateOf, WRAPPER_VERSION, MAX_RESULT } from "./engine/sagetex.mjs";

const results = [];
const check = (name, ok, detail) => { results.push([name, !!ok]); if (!ok) console.log("FAIL", name, JSON.stringify(detail)?.slice(0, 900)); };
// (an item as the worker's check sends it: its key, and its code unless refused)
// (the renderer's item, as itemOf makes it: a refused one has no code)
const real = (mode, code, extra = {}) => (extra.err ? { mode, opts: [], ...extra } : { mode, code, opts: [] });
const item = (mode, code, extra = {}) => { const it = real(mode, code, extra); return { mode, err: it.err ?? null, key: itemKey(it), ...(it.err ? {} : { code }), ...(it.name ? { name: it.name } : {}) }; };

// ---- the parts alone
{
  const its = [item("silent", "x = 1"), item("sage", "x", { err: "cs", name: "foo" }), item("sage", "x")];
  check("runnable: refused items aren't sent", JSON.stringify(runnable(its)) === JSON.stringify([{ mode: "silent", code: "x = 1" }, { mode: "sage", code: "x" }]), runnable(its));
  const st = statesOf(its, [{ s: "ok" }, { s: "ok", latex: "1" }], "");
  check("statesOf: a refused item says why, the next one is the next result", st[1].s === "error" && /TeX command/.test(st[1].msg) && st[2].s === "ok" && st[2].latex === "1", st);
  check("statesOf: every state has its item's key", st.every((s, k) => s.key === its[k].key), st);
  const cut = statesOf([item("silent", "a"), item("sage", "b")], [{ s: "ok" }], "the run was stopped");
  check("statesOf: an item after the session stopped says so", cut[1].s === "error" && cut[1].msg === "not run: the run was stopped", cut);
  const big = statesOf([item("sage", "b")], [{ s: "ok", latex: "x".repeat(MAX_RESULT + 1) }], "");
  check("statesOf: a result over MAX_RESULT is an error", big[0].s === "error" && /over/.test(big[0].msg), big);
  const notSvg = statesOf([item("plot", "p")], [{ s: "ok", svg: "<script>alert(1)</script>" }], "");
  check("statesOf: a plot that isn't an SVG is an error", notSvg[0].s === "error" && !notSvg[0].src, notSvg);
  const bigSvg = statesOf([item("plot", "p")], [{ s: "ok", svg: "<svg>" + "x".repeat(RUN_LIMITS.svg) }], "");
  check("statesOf: a plot over the SVG limit is an error", bigSvg[0].s === "error", bigSvg);
  const svg = statesOf([item("plot", "p")], [{ s: "ok", svg: "<svg xmlns='http://www.w3.org/2000/svg'>é</svg>" }], "");
  check("statesOf: a plot becomes a base64 SVG data URL (UTF-8)", svg[0].s === "ok" && /^data:image\/svg\+xml;base64,[A-Za-z0-9+/]+=*$/.test(svg[0].src) && Buffer.from(svg[0].src.split(",")[1], "base64").toString() === "<svg xmlns='http://www.w3.org/2000/svg'>é</svg>", svg);
  const out = `hello\n${MARK}{"s": "ok"}\n${MARK}not json\n${MARK}3\nbye`;
  const got = parseOutput(out);
  check("parseOutput: only marked lines; an unreadable one is an error", got.length === 3 && got[0].s === "ok" && got[1].s === "error" && got[2].s === "error", got);
  const tb = 'Traceback (most recent call last):\n  File "<cell>", line 15, in <module>\n    _sbtx_r = {"s": "ok"}\n  File "<string>", line 1, in <module>\n    y\nNameError: name \'y\' is not defined\n';
  check("msgOf: the script's own frames are dropped", msgOf(tb) === 'Traceback (most recent call last):\n  File "<string>", line 1, in <module>\n    y\nNameError: name \'y\' is not defined', msgOf(tb));
  const j = JSON.parse(resultsText(st));
  check("resultsText: results v1 of this wrapper", j.format === RESULTS_FORMAT && j.version === 1 && j.wrapper === WRAPPER_VERSION && j.items.length === 3, j);
  // (the code reaches the script only as base64: quotes, newlines and backslashes can't end its string)
  const evil = '"); import os; ("\n\\x1eSBTX{}';
  const d = driver([{ mode: "silent", code: evil }]);
  check("driver: code only as base64", !d.includes("import os") && !d.includes('"); '), d.slice(0, 200));
}

// ---- the script in Sage (the CLI's own: build/cli/pyjs.cjs --sage)
const CLI = new URL("../../build/cli/pyjs.cjs", import.meta.url).pathname;
if (!existsSync(CLI)) {
  console.log("FAIL: no build/cli/pyjs.cjs: run node scripts/build-cli.mjs first");
  process.exit(1);
}
const sage = (code) => new Promise((res) => {
  const dir = mkdtempSync(join(tmpdir(), "sb-latex-run-")), f = join(dir, "run.sage");
  writeFileSync(f, code);
  const p = spawn("node", [CLI, "--sage", f], { cwd: dir });
  let o = "", e = "";
  p.stdout.on("data", (x) => (o += x)); p.stderr.on("data", (x) => (e += x));
  p.on("close", (c) => { rmSync(dir, { recursive: true, force: true }); res({ code: c, out: o, err: e }); });
});
{
  const spec = [
    ["silent", "var('t')\nx = 2^10"],
    ["sage", "x"],
    ["sage", "integrate(t^2, t, 0, 1)"],
    ["silent", "y = 1/0"],
    ["sage", "y"],
    ["sage", "x", { err: "cs", name: "foo" }],
    ["block", "x = 7\nprint('not a result')"],
    ["sage", "x"],
    ["plot", "plot(sin(t), (t, 0, 3))"],
  ];
  const its = spec.map((a) => item(...a)), reals = spec.map((a) => real(...a));
  const r = await sage(driver(runnable(its)));
  const st = statesOf(its, parseOutput(r.out), "");
  const show = (k) => stateOf(savedStates(reals, st), k, reals[k]);
  check("sage: the session ran", r.code === 0, r.err.slice(-600));
  check("sage: \\sage{x} is 1024", st[1].s === "ok" && st[1].latex === "1024", st[1]);
  check("sage: integrate is \\frac{1}{3}", st[2].s === "ok" && st[2].latex === "\\frac{1}{3}", st[2]);
  check("sage: 1/0 shows ZeroDivisionError", st[3].s === "error" && /ZeroDivisionError/.test(st[3].msg) && !/<cell>|_sbtx_/.test(st[3].msg), st[3]);
  check("sage: a later reader of y shows Sage's NameError", st[4].s === "error" && /NameError: name 'y' is not defined/.test(st[4].msg), st[4]);
  check("sage: a refused item says why", st[5].s === "error" && /TeX command/.test(st[5].msg), st[5]);
  check("sage: the rest still run after failures", st[6].s === "ok", st[6]);
  check("sage: x defined again later is 7 (page order)", st[7].s === "ok" && st[7].latex === "7", st[7]);
  check("sage: an item's own printing isn't a result", !r.out.split("\n").some((l) => l === "not a result"), r.out.slice(0, 300));
  check("sage: the plot is an SVG data URL", st[8].s === "ok" && /^data:image\/svg\+xml;base64,/.test(st[8].src ?? ""), { ...st[8], src: String(st[8].src).slice(0, 80) });
  check("sage: every state is shown by the renderer's rule (keys match, in order)", savedStates(reals, st).length === its.length, null);
  check("sage: the renderer shows 1024 for item 2", show(1).s === "ok" && show(1).latex === "1024", show(1));
  // Sage's arithmetic in every item (#706, a wrong answer: each item was exec'd as Python, 1/3 a float, an exact sum
  // short of its 10^-24 term): the values Sage gives (sage -c on the same lines; latex() as Sage writes it)
  {
    const ex = await sage(driver([
      { mode: "block", code: "a = 1/3\nb = 2^3\nc = 5^^3\nR.<t> = QQ[]\nL = sum(1/10^factorial(j) for j in range(1, 5))" },
      { mode: "sage", code: "a" }, { mode: "sage", code: "b" }, { mode: "sage", code: "c" }, { mode: "sage", code: "L" },
      { mode: "sage", code: " 1/2 + 1/3 " }, { mode: "sage", code: "(t+1)^2" },
    ]));
    const v = parseOutput(ex.out).map((g) => g.s === "ok" ? g.latex ?? "" : "error: " + String(g.msg).slice(-120));
    check("sage: exact as Sage: 1/3, 2^3, 5^^3 (xor), the sum with its 10^-24 term, 1/2 + 1/3, (t+1)^2 over QQ",
      JSON.stringify(v) === JSON.stringify(["", "\\frac{1}{3}", "8", "6", "\\frac{110001000000000000000001}{1000000000000000000000000}", "\\frac{5}{6}", "t^{2} + 2 t + 1"]), v);
  }
  // a second Run in the same session starts from the session's first globals: a name of the first Run is gone
  const two = await sage(driver([{ mode: "silent", code: "z = 5" }]) + driver([{ mode: "sage", code: "z" }]));
  const g2 = parseOutput(two.out);
  check("sage: a second Run doesn't see the first Run's names", g2.length === 2 && g2[0].s === "ok" && g2[1].s === "error" && /NameError/.test(g2[1].msg), g2);
  // (and a Sage name the first Run redefined, or a var() it made, is as Sage has it again)
  const three = await sage(driver([{ mode: "silent", code: "x = 7\nvar('w')" }]) + driver([{ mode: "sage", code: "x" }, { mode: "sage", code: "w" }]));
  const g3 = parseOutput(three.out);
  check("sage: a second Run sees Sage's own x, not the first Run's", g3.length === 3 && g3[1].s === "ok" && g3[1].latex === "x" && g3[2].s === "error" && /NameError/.test(g3[2].msg), g3);
}

// ---- LATEX-RUN-1 (astra): a Run that is no longer current writes nothing; a newer results file is never replaced
// A workspace as page.ts uses it (web/workspace/api.ts's rules: write's fid and base checked, and its admit asked,
// holding the lock; create refuses a path that's taken, and an aborted signal), with holds at each wait.
const gate = () => { let open; const p = new Promise((r) => (open = r)); return { p, open }; };
const dec = (b) => new TextDecoder().decode(b);
function fakeWs() {
  const files = new Map(), holds = {};
  let fids = 0;
  const wait = async (name) => { const h = holds[name]; if (h) { delete holds[name]; h.reached?.(); await h.p; } };
  const err = (code) => Object.assign(new Error(code), { code });
  return {
    files, holds,
    hold(name) { const g = gate(), r = gate(); holds[name] = { p: g.p, reached: r.open }; return { reached: r.p, open: g.open }; },
    put(p, text) { const f = files.get(p); files.set(p, { fid: f ? f.fid : "r" + ++fids, rev: f ? f.rev + 1 : 0, text }); },
    replace(p, text) { files.set(p, { fid: "r" + ++fids, rev: 0, text }); },
    async pathOfFile() { await wait("pathOfFile"); return { ok: true, path: "/paper.tex" }; },
    async stat(p) { await wait("stat"); const f = files.get(p); return f ? { fid: f.fid, rev: f.rev, path: p } : undefined; },
    async write(p, bytes, opts = {}) {
      await wait("write");   // (the lock taken: from here on, what this call checks is what it writes over)
      const f = files.get(p);
      opts.admit?.({ op: "write", role: "target", path: p, entry: f, chain: [] });
      if (!f) throw err("notfound");
      if (opts.fid !== undefined && f.fid !== opts.fid) throw err("conflict");
      if (opts.base !== undefined && f.rev !== opts.base) throw err("conflict");
      files.set(p, { fid: f.fid, rev: f.rev + 1, text: dec(bytes) });
    },
    async createByPerson(p, o) {
      await wait("create");
      if (o.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      if (files.has(p)) throw err("exists");
      files.set(p, { fid: "r" + ++fids, rev: 0, text: dec(o.content) });
    },
  };
}
const RP = "/paper.tex.results.json";
const runItems = [item("silent", "a = 1"), item("sage", "a")];
// (a Run: its session's answer is `latex` for the \sage item; `holdExec` holds the session's run)
function startRun(ws, latex, opts = {}) {
  const life = { live: true, ac: new AbortController() };
  const exec = async () => { if (opts.holdExec) await opts.holdExec; return { out: `${MARK}{"s": "ok"}\n${MARK}${JSON.stringify({ s: "ok", latex })}\n`, stopped: "" }; };
  const p = runAndSave({ items: runItems, session: async () => ({}), exec, ws, fid: "tex1", current: () => life.live && (!opts.gen || opts.gen.n === opts.my), signal: life.ac.signal, max: 2 ** 20, now: () => 0 });
  return { p, dispose() { life.live = false; life.ac.abort(); } };
}
const shown = (ws) => { const f = ws.files.get(RP); return f ? JSON.parse(f.text).items[1].latex : null; };
{
  // the stale Run's wait at each step: the session's run, the .tex's path, the results file's stat, the write's lock
  for (const step of ["exec", "pathOfFile", "stat", "write"]) {
    const ws = fakeWs();
    ws.put(RP, resultsText([]));   // (an earlier results file)
    const g = gate();
    const h = step === "exec" ? null : ws.hold(step);
    const old = startRun(ws, "OLD", step === "exec" ? { holdExec: g.p } : {});
    if (h) await h.reached; else await new Promise((r) => setTimeout(r, 5));
    old.dispose();   // (the page closed, or another file opened in it)
    const now = await startRun(ws, "NEW").p;
    g.open(); h?.open();
    const r = await old.p;
    check(`RUN-1 ${step}: the newer Run wrote its results`, now.ok === true, now);
    check(`RUN-1 ${step}: the disposed Run writes nothing over them`, r.stale === true && shown(ws) === "NEW", { r, shown: shown(ws) });
  }
  // a newer Run on the same page (its number) makes the older one stale too
  {
    const ws = fakeWs(), g = gate(), gen = { n: 1 };
    const old = startRun(ws, "OLD", { holdExec: g.p, gen, my: 1 });
    await new Promise((r) => setTimeout(r, 5));
    gen.n = 2;
    const now = await startRun(ws, "NEW", { gen, my: 2 }).p;
    g.open();
    const r = await old.p;
    check("RUN-1 generation: a superseded Run writes nothing", now.ok && r.stale === true && shown(ws) === "NEW", { r, shown: shown(ws) });
  }
  // (grader's T561-ADMIT) disposed while the write waits for the lock, nothing written meanwhile: only the admit
  // inside the lock refuses it
  {
    const ws = fakeWs();
    ws.put(RP, resultsText([]));
    const before = ws.files.get(RP).text;
    const h = ws.hold("write");
    const old = startRun(ws, "OLD");
    await h.reached;
    old.dispose();
    h.open();
    const r = await old.p;
    check("RUN-1 locked admit alone: disposed in the write lock, nothing written", r.stale === true && ws.files.get(RP).text === before && ws.files.get(RP).rev === 0, { r, rev: ws.files.get(RP).rev });
  }
  // still current, but the file was written meanwhile (another tab's Run): pinned by its revision, not replaced
  {
    const ws = fakeWs();
    ws.put(RP, resultsText([]));
    const h = ws.hold("write");
    const old = startRun(ws, "OLD");
    await h.reached;
    ws.put(RP, JSON.stringify({ items: [{}, { latex: "OTHER TAB" }] }));
    h.open();
    const r = await old.p;
    check("RUN-1 base: a results file written meanwhile isn't replaced", /changed meanwhile/.test(r.msg ?? "") && shown(ws) === "OTHER TAB", { r, shown: shown(ws) });
  }
  // another file put at the results path meanwhile: pinned by its fid
  {
    const ws = fakeWs();
    ws.put(RP, resultsText([]));
    const h = ws.hold("write");
    const old = startRun(ws, "OLD");
    await h.reached;
    ws.replace(RP, JSON.stringify({ items: [{}, { latex: "REPLACEMENT" }] }));
    h.open();
    const r = await old.p;
    check("RUN-1 fid: a file put at the path meanwhile isn't replaced", /changed meanwhile/.test(r.msg ?? "") && shown(ws) === "REPLACEMENT", { r, shown: shown(ws) });
  }
  // no results file yet, and one made meanwhile: the create refuses, nothing is written over it
  {
    const ws = fakeWs(), h = ws.hold("create");
    const old = startRun(ws, "OLD");
    await h.reached;
    ws.put(RP, JSON.stringify({ items: [{}, { latex: "MADE MEANWHILE" }] }));
    h.open();
    const r = await old.p;
    check("RUN-1 create: one made meanwhile isn't written over", /changed meanwhile/.test(r.msg ?? "") && shown(ws) === "MADE MEANWHILE", { r, shown: shown(ws) });
  }
  // disposed while the create waits: nothing is made
  {
    const ws = fakeWs(), h = ws.hold("create");
    const old = startRun(ws, "OLD");
    await h.reached;
    old.dispose();
    h.open();
    const r = await old.p;
    check("RUN-1 create: a disposed Run makes no file", r.stale === true && !ws.files.has(RP), { r, files: [...ws.files.keys()] });
  }
  // a Run that is current writes (the control for the cases above), a new file and over its own earlier one
  {
    const ws = fakeWs();
    const a = await startRun(ws, "FIRST").p, b = await startRun(ws, "SECOND").p;
    check("RUN-1: a current Run writes its results, then the next one over them", a.ok && b.ok && shown(ws) === "SECOND" && ws.files.get(RP).rev === 1, { a, b, shown: shown(ws) });
  }
  // the control: 9cedc1b5's sequence (live checked only before the session ran; then the path, the stat and an
  // unconditional write, or create then write on "exists"), in the same case as "RUN-1 pathOfFile": it overwrites
  {
    const ws = fakeWs();
    ws.put(RP, resultsText([]));
    let live = true;
    const old9 = async (latex) => {
      if (!live) return;
      const states = statesOf(runItems, parseOutput(`${MARK}{"s": "ok"}\n${MARK}${JSON.stringify({ s: "ok", latex })}\n`), "");
      const bytes = new TextEncoder().encode(resultsText(states));
      const at = await ws.pathOfFile("tex1");
      const rp = at.path + ".results.json", e = await ws.stat(rp).catch(() => undefined);
      if (e && !e.trashed) await ws.write(rp, bytes);
      else { try { await ws.createByPerson(rp, { content: bytes }); } catch (err) { if (err?.code === "exists") await ws.write(rp, bytes); else throw err; } }
    };
    const h = ws.hold("pathOfFile");
    const p = old9("OLD");
    await h.reached;
    live = false;
    await startRun(ws, "NEW").p;
    h.open();
    await p;
    check("RUN-1 control: 9cedc1b5's sequence writes the old results over the newer ones", shown(ws) === "OLD", shown(ws));
  }
}

// ---- LATEX-RUN-2 (astra): the session in the runner only, never a plain worker of the page's own origin
// web/notebook's own RunnerWorker and WorkerKernel, in a fake page: a frame that loads, then is given the worker's
// script (fetched here: `fetchOk` says whether it is there) and answers as the runner page does (`answers`).
{
  const made = { workers: 0, runners: [] };
  globalThis.location = new URL("http://localhost/sagebrush/");
  globalThis.Worker = class { constructor() { made.workers++; throw new Error("a plain worker was made"); } };
  const frameMode = { fetchOk: false, answers: false };
  // (answered after the frame has loaded, as on a network: the runner is waiting for it by then)
  globalThis.fetch = async (u) => (await new Promise((r) => setTimeout(r, 10)), frameMode.fetchOk ? { ok: true, status: 200, text: async () => "// the worker" } : { ok: false, status: 404, text: async () => "" });
  globalThis.document = {
    body: { appendChild(f) { setTimeout(() => f.fire("load"), 1); } },
    createElement() {
      const ls = {};
      return {
        style: {}, setAttribute() {}, remove() {}, addEventListener(t, f) { (ls[t] ??= []).push(f); }, fire(t) { for (const f of ls[t] ?? []) f(); },
        contentWindow: {
          postMessage(m, _o, ports) {
            if (!frameMode.answers || !ports?.[0]) return;
            const port = ports[0];
            port.postMessage({ runnerReady: 1 });
            // (the interpreter: ready, then any code it is sent is done)
            port.onmessage = (e) => { const d = e.data; if (d?.code !== undefined) port.postMessage({ id: d.id, done: true, ms: 1 }); };
            setTimeout(() => port.postMessage({ ready: true, version: "test" }), 1);
          },
        },
      };
    },
  };
  const { RunnerWorker } = await import("../notebook/runner-worker.js");
  const { WorkerKernel } = await import("../notebook/worker-kernel.js");
  const mod = { RunnerWorker: class extends RunnerWorker { constructor(src, o) { made.runners.push(o); super(src, o); } }, WorkerKernel };
  const eng = sandboxEngine(mod, new URL("http://localhost/sagebrush/"));
  const session = sessionOf(eng, 3000);
  const t0 = Date.now();
  const first = await session().then(() => "started", (e) => e.message);
  check("RUN-2: a runner whose worker can't load fails closed, with the message", first === SANDBOX_FAILED && Date.now() - t0 < 2500, { first, ms: Date.now() - t0 });
  check("RUN-2: no plain worker, and the runner was given no fallback", made.workers === 0 && made.runners.length >= 1 && made.runners.every((o) => !o || o.fallback === undefined), made);
  // a frame that loads but never answers (an error page): no fallback after the runner's own timers, the start's
  // deadline says the message
  frameMode.fetchOk = true;
  const t1 = Date.now();
  const second = await session().then(() => "started", (e) => e.message);
  check("RUN-2: a frame that never answers fails closed at the deadline", second === SANDBOX_FAILED && Date.now() - t1 >= 2900, { second, ms: Date.now() - t1 });
  check("RUN-2: still no plain worker after the runner's timers", made.workers === 0, made);
  // the frame there now: the next Run starts a new runner, and runs in it
  frameMode.answers = true;
  const third = await session().then((k) => k, (e) => e.message);
  check("RUN-2: a later Run starts the sandbox again and it runs", typeof third === "object" && third.ready === true, typeof third === "string" ? third : "ready");
  const ran = typeof third === "object" ? await new Promise((res) => third.execute("1", { mode: "sage" }, { start() {}, out() {}, display() {}, interact() {}, clear() {}, done: (ms, o) => res(!o?.error), stopped: () => res(false), skipped: () => res(false) })) : false;
  check("RUN-2: code runs in that runner; still no plain worker", ran === true && made.workers === 0 && made.runners.every((o) => !o || o.fallback === undefined) && made.runners.length === 3, made);
  third?.worker?.terminate?.();
}

const bad = results.filter(([, ok]) => !ok);
console.log(`${results.length - bad.length}/${results.length} passed`);
process.exit(bad.length ? 1 : 0);
