// ci: web-runner order=186 runner=bun chrome
// An agent's runs of code in the page (chat plan PR 4a; packet r3 §11): run_notebook, run_file and run_stop, in headless
// Chromium against web/dist, through the page's real runner and workspace, with the calling grant as a test object
// (the pairing's own rows are test-agent-pair.mjs's). Every race is reached through a named hold the test releases.
//   bun web/build.ts && CHROME=google-chrome bun web/workspace/test-run-verbs-page.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort, startServe } from "../test-port.mjs";

const here = join(import.meta.dir, "..");
if (!existsSync(join(here, "dist", "sagebrush-agent-run.js"))) throw new Error("build web/dist first (bun web/build.ts)");
let checks = 0;
const fails = [];
const check = (ok, what) => { checks++; if (!ok) fails.push(what); console.log(`${ok ? "ok" : "FAIL"} ${what}`); };
let server = null, chrome = null;
// (git_branch's module, for the page to make a branch with: the notebook page doesn't offer it (the board page does), so
//  it is built here into the site under a test-only name, removed at the end)
const gbName = `__test-git-branch-${process.pid}.js`;
const gbBuilt = await Bun.build({ entrypoints: [join(here, "workspace", "git-branch.ts")], outdir: join(here, "dist"), naming: gbName, target: "browser", format: "esm" });
if (!gbBuilt.success) throw new Error(gbBuilt.logs.join("\n"));
// (git_commit and the branch store, for the run notes' rows: a commit's blob ids against the notes', built the same way)
const gvName = `__test-git-verbs-${process.pid}.js`;
const gvEntry = join(mkdtempSync(join(tmpdir(), "sb-test-gv-")), "entry.ts");
writeFileSync(gvEntry, `export { gitCommit } from ${JSON.stringify(join(here, "workspace", "git-verbs.ts"))};\nexport { openBranchStore } from ${JSON.stringify(join(here, "workspace", "branch-store.ts"))};\nexport { onBranch } from ${JSON.stringify(join(here, "workspace", "branch-wake.ts"))};\nexport { blobOid, docCanonBytes } from ${JSON.stringify(join(here, "workspace", "canon-doc.ts"))};\n`);
const gvBuilt = await Bun.build({ entrypoints: [gvEntry], outdir: join(here, "dist"), naming: gvName, target: "browser", format: "esm" });
if (!gvBuilt.success) throw new Error(gvBuilt.logs.join("\n"));
const profile = mkdtempSync(join(tmpdir(), "sb-test-runs-"));
try {
  const port = await startServe(() => (server = spawn("python3", [join(here, "serve.py"), "0"], { stdio: ["ignore", "pipe", "pipe"] }))).port;
  const url = `http://127.0.0.1:${port}/`;
  chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", "--window-size=1100,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore", detached: true });
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
    for (;;) { const v = await evaluate(expr); if (v && !v.error) return v; if (Date.now() - t > ms) return null; await new Promise((r) => setTimeout(r, 100)); }
  };
  await send("Page.navigate", { url });
  check(!!(await until(`typeof window.__agentRunsFor === "function"`)), "the page offers the runs' test handle on a local host");
  // (the page's host and the run module; a grant as the pairing gives it; the line as the pairing's holder shows it)
  check(await evaluate(`(async () => {
    const R = await window.__agentRunsFor(); window.__R = R; window.__M = await R.load(); window.__ws = R.host().ws;
    window.__grant = { id: "a".repeat(32), agent: "Test agent", client: "test", folders: ["/"], write: true, run: true, expires: null, created: 0, lastUsed: 0 };
    window.__lines = []; window.__holder = { current: null, show(a, v, stop) { window.__lines.push(a + " is running " + v); window.__stop = stop; }, hide() { window.__lines.push("hidden"); } };
    window.__ctx = (g = window.__grant) => ({ agent: "Test agent", actor: "agent:Test-agent", grant: g, live: () => window.__live !== false, why: () => window.__why ?? "the grant was revoked", grantNow: () => window.__grantNow ?? g, onChange: (cb) => { window.__chg = cb; return () => { window.__chg = null; }; } });
    window.__run = (method, params, g) => window.__M.run(method, params, window.__ctx(g), window.__R.host(), window.__holder).then((r) => r, (e) => ({ threw: e.code, message: e.message }));
    const enc = new TextEncoder();
    await window.__ws.mkdir("/rv").catch(() => {});
    await window.__ws.putFile("/rv/hello.py", enc.encode("print('hi')\\n"));
    await window.__ws.putFile("/rv/boom.py", enc.encode("print('before')\\nraise ValueError('boom')\\n"));
    await window.__ws.putFile("/rv/writes.py", enc.encode("open('/rv/out.txt','w').write('x')\\nprint('wrote')\\n"));
    await window.__ws.putFile("/rv/data.csv", enc.encode("1,2\\n"));
    return !!window.__M.run && window.__R.host().sandbox;
  })()`) === "ok", "the run module loads, and the sandbox is here");

  // ---- run_file
  let r = await evaluate(`window.__run("workspace.run_file", { path: "/rv/hello.py" })`);
  check(r?.ok === true && r.ended === "done" && r.exit === 0 && r.stdout === "hi\n" && r.stderr === "" && /^[0-9a-f]{64}$/.test(r.inputHash ?? ""), `run_file: its output and exit 0: ${JSON.stringify(r)}`);
  check(JSON.stringify(await evaluate(`window.__lines`)) === JSON.stringify(["Test agent is running /rv/hello.py", "hidden"]), `the line while it ran, gone at its end: ${JSON.stringify(await evaluate(`window.__lines`))}`);
  r = await evaluate(`window.__run("workspace.run_file", { path: "/rv/boom.py" })`);
  check(r?.ok === false && r.ended === "error" && r.exit === 1 && r.stdout === "before\n" && /ValueError: boom/.test(r.stderr ?? ""), `run_file: an uncaught exception, exit 1, stderr: ${JSON.stringify(r)}`);
  // (a main .py has no write permission of its own: its code writes nothing, said in refused)
  r = await evaluate(`window.__run("workspace.run_file", { path: "/rv/writes.py" })`);
  const out1 = await evaluate(`window.__ws.stat("/rv/out.txt").then((e) => !!e)`);
  check(r?.refused?.paths?.includes("/rv/out.txt") && out1 === false, `a main run's write with no permission: refused, nothing written: ${JSON.stringify({ r, out1 })}`);
  // ---- refusals before anything runs
  r = await evaluate(`window.__run("workspace.run_file", { path: "/rv/hello.py" }, { ...window.__grant, run: false })`);
  check(r?.threw === "not_allowed" && r.message === 'not allowed: this grant may not run code (the person can allow it when they connect this agent again)', `run off: refused, board's words: ${JSON.stringify(r)}`);
  r = await evaluate(`window.__run("workspace.run_file", { path: "/rv/data.csv" })`);
  check(r?.threw === "invalid" && /isn't a \.py or \.sage file/.test(r.message), `run_file on a .csv: refused: ${JSON.stringify(r)}`);
  r = await evaluate(`window.__run("workspace.run_notebook", { path: "/rv/hello.py" })`);
  check(r?.threw === "invalid" && /isn't a notebook/.test(r.message), `run_notebook on a .py: refused: ${JSON.stringify(r)}`);
  r = await evaluate(`window.__run("workspace.run_file", { path: "/rv/hello.py" }, { ...window.__grant, folders: ["/other"] })`);
  const unreadMissing = await evaluate(`window.__run("workspace.run_file", { path: "/secret/none.py" }, { ...window.__grant, folders: ["/rv"] })`);
  check(unreadMissing?.threw === "invalid" && /outside the folders this agent may read/.test(unreadMissing.message), `a path outside the grant that doesn't exist: refused as unreadable, never said missing: ${JSON.stringify(unreadMissing)}`);
  check(r?.threw === "invalid" && /outside the folders this agent may read/.test(r.message), `a path the grant can't read: refused: ${JSON.stringify(r)}`);
  // ---- run_notebook on main: its outputs come back, the person's notebook stays byte for byte as it was
  check(await evaluate(`(async () => {
    await window.__ws.create("/rv/nb.ipynb", { content: { mode: "python", cells: [{ id: "c1", code: "print(1+1)" }, { id: "t1", type: "markdown", code: "text" }, { id: "c2", code: "open('/rv/nbout.txt','w').write('y')\\nprint('w')" }] } });
    window.__nb0 = JSON.stringify((await window.__ws.read("/rv/nb.ipynb")).content);
    return true; })()`) === true, "a notebook made on main");
  r = await evaluate(`window.__run("workspace.run_notebook", { path: "/rv/nb.ipynb" })`);
  const nb1 = await evaluate(`window.__ws.read("/rv/nb.ipynb").then((x) => JSON.stringify(x.content) === window.__nb0)`);
  check(r?.ended === "error" && r.saved === "not saved: main" && r.cells?.[0]?.status === "ok" && r.cells[0].out === "2\n" && r.cells[1]?.index === 2 && r.cells[1].status === "error" && nb1 === true,
    `run_notebook on main: outputs returned, nothing saved, the notebook unchanged (its write refused: no permission): ${JSON.stringify({ r, nb1 })}`);
  // ---- a worktree: this grant's branch, seen as "/" (W1)
  const gb = `${url}${gbName}`;
  r = await evaluate(`(async () => {
    const m = await import(${JSON.stringify(gb)});
    const out = await m.gitBranch(window.__ws.branchHost("agent:Test-agent"), { name: "w1", owner: window.__grant.id, folders: ["/"], live: () => true });
    // (the branch's own copy of data.csv made different from main's, so a read shows which one the run saw)
    await window.__R.host().ws.runHost("agent:Test-agent", () => window.__grant.id).putFile("/Branches/w1/rv/data.csv", new TextEncoder().encode("9,9\\n"), () => {});
    await window.__ws.runHost("agent:Test-agent", () => window.__grant.id).putFile("/Branches/w1/rv/reads.py", new TextEncoder().encode("print(open('/rv/data.csv').read(), end='')\\nimport os\\nprint(sorted(os.listdir('/')))\\n"), () => {});
    return out; })()`);
  check(!!r && !r.error, `a branch made for the test grant: ${JSON.stringify(r).slice(0, 200)}`);
  r = await evaluate(`window.__run("workspace.run_file", { path: "/Branches/w1/rv/reads.py" })`);
  check(r?.ok === true && r.stdout === "9,9\n['rv']\n", `W1: a worktree run reads the branch's copy at /rv/data.csv, and / is the branch: ${JSON.stringify(r)}`);
  r = await evaluate(`window.__run("workspace.run_notebook", { path: "/Branches/w1/rv/nb.ipynb" })`);
  const wt = await evaluate(`(async () => ({ branch: !!(await window.__ws.stat("/Branches/w1/rv/nbout.txt")), main: !!(await window.__ws.stat("/rv/nbout.txt")), outs: (await window.__ws.read("/Branches/w1/rv/nb.ipynb")).content.cells.map((c) => (c.outputs ?? []).map((o) => o.text ?? "").join("")) }))()`);
  check(r?.ok === true && r.saved === "saved" && wt?.branch === true && wt.main === false && wt.outs?.[0] === "2\n" && wt.outs[2] === "w\n",
    `a worktree notebook: runs, writes in its branch only, outputs saved in the branch's copy: ${JSON.stringify({ r, wt })}`);
  // (ownership isn't write permission: under a read-only grant, nothing is written or saved (AUTH-1))
  check(await evaluate(`window.__ws.runHost("agent:Test-agent", () => window.__grant.id).remove("/Branches/w1/rv/nbout.txt", () => {}).then(() => true)`) === true, "(the branch's output file removed)");
  r = await evaluate(`window.__run("workspace.run_notebook", { path: "/Branches/w1/rv/nb.ipynb" }, { ...window.__grant, write: false })`);
  const ro = await evaluate(`window.__ws.stat("/Branches/w1/rv/nbout.txt").then((e) => !!e)`);
  check(r?.saved === "refused" && ro === false && r.refused?.paths?.includes("/rv/nbout.txt"), `AUTH-1: the owned branch under a read-only grant: no write, no outputs saved: ${JSON.stringify({ r, ro })}`);
  // (another grant's branch: refused before anything runs)
  r = await evaluate(`window.__run("workspace.run_file", { path: "/Branches/w1/rv/reads.py" }, { ...window.__grant, id: "b".repeat(32) })`);
  check(r?.threw === "invalid" && /another connection|isn't yours|not yours/i.test(r.message), `another grant's branch: refused before anything runs: ${JSON.stringify(r)}`);
  // ---- the runs' notes in the branch (the review page's run line): a finished run notes its target as its snapshot read
  // it, by the blob id of its canonical bytes; a refused run, a failed one and a run on main note nothing
  const runsNow = () => evaluate(`(async () => { const b = await window.__ws.branchAtName("w1"); const x = await window.__ws.branchRuns(b.fid, "w1"); return { seq: x.seq, runs: Object.fromEntries(x.runs) }; })()`);
  const n1 = await runsNow();
  check(/^[0-9a-f]{40}$/.test(n1?.runs?.["/rv/nb.ipynb"]?.oid ?? "") && /^[0-9a-f]{40}$/.test(n1.runs["/rv/reads.py"]?.oid ?? "") && Object.keys(n1.runs).length === 2 && n1.runs["/rv/nb.ipynb"].at >= n1.runs["/rv/reads.py"].at,
    `run notes: the branch's finished runs, by path within it, newest last run first: ${JSON.stringify(n1)}`);
  r = await evaluate(`window.__run("workspace.run_file", { path: "/Branches/w1/rv/boom.py" })`);
  r = await evaluate(`window.__run("workspace.run_file", { path: "/Branches/w1/rv/reads.py" }, { ...window.__grant, id: "b".repeat(32) })`);
  r = await evaluate(`window.__run("workspace.run_file", { path: "/rv/hello.py" })`);
  const n2 = await runsNow();
  check(n2?.seq === n1.seq && !("/rv/boom.py" in n2.runs) && !("/rv/hello.py" in n2.runs), `run notes: a failed run, another grant's refused one and a main run note nothing: ${JSON.stringify(n2)}`);
  const gv = `${url}${gvName}`;
  // (a note's wake: one per note written, heard by a subscriber in another copy of the module (the review's), none for a
  //  run that notes nothing)
  check(await evaluate(`(async () => {
    const g = await import(${JSON.stringify(gv)});
    const b = await window.__ws.branchAtName("w1"), ns = (await g.openBranchStore(window.__ws.dbName)).name;
    window.__wakes = 0; window.__offWake = g.onBranch(ns, b.fid, () => window.__wakes++);
    return true; })()`) === true, "(a subscriber to the branch's wakes)");
  r = await evaluate(`window.__run("workspace.run_file", { path: "/Branches/w1/rv/reads.py" })`);
  const woke = await until(`window.__wakes >= 1 && window.__wakes`, 5000);
  r = await evaluate(`window.__run("workspace.run_file", { path: "/Branches/w1/rv/boom.py" })`);
  const wakes = await evaluate(`new Promise((r) => setTimeout(() => { window.__offWake(); r(window.__wakes); }, 300))`);
  check(woke === 1 && wakes === 1, `run notes: a finished run's note wakes a subscriber once; a failed run, not at all: ${JSON.stringify({ woke, wakes })}`);
  // (a branch made before canon 2 (its record names no canon: canon 1, as git_branch's first form made it): its note is
  //  the notebook's canon-1 id, never canon 2's)
  const c1 = await evaluate(`(async () => {
    const m = await import(${JSON.stringify(gb)}), g = await import(${JSON.stringify(gv)});
    const host = window.__ws.branchHost("agent:Test-agent");
    await m.gitBranch({ ...host, publishBranch: (f, n, pages, live) => host.publishBranch(f, n, pages, live) }, { name: "old1", owner: window.__grant.id, folders: ["/"], live: () => true });
    const b = await window.__ws.branchAtName("old1"), doc = (await window.__ws.read("/Branches/old1/rv/nb.ipynb")).content;
    const r = await window.__run("workspace.run_notebook", { path: "/Branches/old1/rv/nb.ipynb" });
    const runs = new Map((await window.__ws.branchRuns(b.fid, "old1")).runs);
    return { canon: b.record.canon ?? 1, ended: r.ended, note: runs.get("/rv/nb.ipynb")?.oid, one: await g.blobOid(g.docCanonBytes("notebook", doc, 1)), two: await g.blobOid(g.docCanonBytes("notebook", doc, 2)) };
  })()`);
  check(c1?.canon === 1 && c1.note === c1.one && c1.one !== c1.two, `run notes: a canon-1 branch's run notes its canon-1 id: ${JSON.stringify(c1)}`);
  // (a revoke while the note is written: the run ends as revoked, with nothing of what it printed)
  const rv = await evaluate(`(async () => {
    const ws = window.__ws, orig = ws.runHost;
    ws.runHost = function (...a) { const h = orig.apply(this, a); return { ...h, noteBranchRun: async (...b) => { window.__live = false; window.__chg?.(); return h.noteBranchRun(...b); } }; };
    try { return await window.__run("workspace.run_file", { path: "/Branches/w1/rv/reads.py" }); }
    finally { ws.runHost = orig; window.__live = true; }
  })()`);
  check(rv?.ended === "revoked" && rv.ok === false && !("stdout" in rv), `run notes: revoked while the note is written: ended as revoked, nothing it printed: ${JSON.stringify(rv)}`);
  // (the run line's "Ran": the notes' ids are the commit's own, the notebook's outputs saved by the run notwithstanding)
  const same = await evaluate(`(async () => {
    const g = await import(${JSON.stringify(gv)});
    const res = await g.gitCommit(window.__ws.branchHost("agent:Test-agent"), { name: "w1", message: "runs", review: true }, { owner: window.__grant.id, actor: "agent:Test-agent", live: () => true });
    const oids = await (await g.openBranchStore(window.__ws.dbName)).oidsAt(res.commit);
    const b = await window.__ws.branchAtName("w1"), runs = new Map((await window.__ws.branchRuns(b.fid, "w1")).runs);
    return { nb: oids.get("rv/nb.ipynb") === runs.get("/rv/nb.ipynb").oid, py: oids.get("rv/reads.py") === runs.get("/rv/reads.py").oid, outs: (await window.__ws.read("/Branches/w1/rv/nb.ipynb")).content.cells[0].outputs?.length ?? 0 };
  })()`);
  check(same?.nb === true && same.py === true && same.outs > 0, `run notes: the committed notebook (outputs and all) and file have the notes' blob ids: ${JSON.stringify(same)}`);
  // ---- holds the test releases: a run's stages (the page's __runHold), and the workspace's admission, inside its lock,
  // before or after the run's admit (wrapping this workspace's admitAt for the paths named)
  await evaluate(`(() => {
    window.__holdOn = {};
    window.__runHold = (stage) => window.__holdOn[stage] ? new Promise((r) => { window.__held = stage; window.__release = () => { window.__held = null; r(); }; }) : Promise.resolve();
    const ws = window.__ws, orig = Object.getPrototypeOf(ws).admitAt;
    window.__admit = null;
    ws.admitAt = function (admit, op, role, p) {
      if (!admit) return undefined;
      const h = window.__admit;
      // (h.skip: matching asks to let pass first, e.g. the run's own branch check at its start, which asks as a write)
      const hold = (when) => h && h.when === when && p === h.path && (!h.op || h.op === op) && !(h.skip > 0 && h.skip-- > 0) ? new Promise((r) => { window.__aheld = when; window.__arelease = () => { window.__aheld = null; window.__admit = null; r(); }; }) : null;
      return (async () => { await hold("before"); const out = await orig.call(this, admit, op, role, p); await hold("after"); return out; })();
    };
    return 1; })()`);
  const go = (method, params, g) => evaluate(`(window.__p = window.__run(${JSON.stringify(method)}, ${JSON.stringify(params)}${g ? ", " + g : ""}), 1)`);
  const result = () => evaluate(`window.__p`);
  const enc8 = (s) => `new TextEncoder().encode(${JSON.stringify(s)})`;
  const put = (p, s) => evaluate(`window.__ws.runHost("agent:Test-agent", () => window.__grant.id).putFile(${JSON.stringify(p)}, ${enc8(s)}, () => {}).then(() => true)`);
  const exists = (p) => evaluate(`window.__ws.stat(${JSON.stringify(p)}).then((e) => !!e && !e.trashed)`);
  // (a note's time is when its run's snapshot was read, not when the run ended: the review's "Ran … at", and which of
  //  two runs is the newer; held after the read, the clock moved on, then released)
  await put("/Branches/w1/rv/at.py", "print('at')\n");
  await evaluate(`(window.__holdOn = { start: true }, 1)`);
  await go("workspace.run_file", { path: "/Branches/w1/rv/at.py" });
  check(!!(await until(`window.__held === "start"`, 60000)), "(a run held after its snapshot was read)");
  const heldAt = await evaluate(`(async () => { const t = Date.now(); while (Date.now() <= t + 2) await new Promise((r) => setTimeout(r, 1)); return t; })()`);
  await evaluate(`(window.__holdOn = {}, window.__release(), 1)`);
  r = await result();
  const atNote = (await runsNow()).runs["/rv/at.py"]?.at;
  check(r?.ok === true && typeof atNote === "number" && atNote <= heldAt, `run notes: a note's time is its snapshot's read, not the run's end: ${JSON.stringify({ ok: r?.ok, atNote, heldAt })}`);
  // (a note not written (a newer one is there: "same") wakes nobody)
  await put("/Branches/w1/rv/same.py", "print('same')\n");
  check(await evaluate(`(async () => {
    const g = await import(${JSON.stringify(gv)});
    const b = await window.__ws.branchAtName("w1"), ns = (await g.openBranchStore(window.__ws.dbName)).name;
    const n = await window.__ws.runHost("agent:Test-agent", () => window.__grant.id).noteBranchRun(b.fid, "w1", "/Branches/w1/rv/same.py", { at: 8.64e15, oid: "f".repeat(40) }, () => true);
    window.__wakes2 = 0; window.__offWake2 = g.onBranch(ns, b.fid, () => window.__wakes2++);
    // (and the branch store's channel itself: any message posted, a well-formed wake or not)
    window.__posts = 0; window.__raw = new BroadcastChannel("sagebrush-branches:" + ns); window.__raw.onmessage = () => window.__posts++;
    return n.r === "ok"; })()`) === true, "(a newer note there first, a subscriber, and a listener on the branch's channel)");
  r = await evaluate(`window.__run("workspace.run_file", { path: "/Branches/w1/rv/same.py" })`);
  const sameWakes = await evaluate(`new Promise((r) => setTimeout(() => { window.__offWake2(); window.__raw.close(); r([window.__wakes2, window.__posts]); }, 300))`);
  check(r?.ok === true && sameWakes[0] === 0 && sameWakes[1] === 0 && (await runsNow()).runs["/rv/same.py"]?.at === 8.64e15, `run notes: a finished run whose note isn't written (a newer one is there) wakes nobody and posts nothing: ${JSON.stringify({ ok: r?.ok, sameWakes })}`);
  await put("/Branches/w1/rv/d1.py", "open('/rv/d1.txt','w').write('1')\nprint('done')\n");
  await put("/Branches/w1/rv/d2.py", "open('/rv/d2.txt','w').write('2')\nprint('done')\n");
  // (RUN-DRAIN-1, before admission: the write waits at the lock's admission; Stop; released, it is fenced: nothing kept)
  await evaluate(`(window.__admit = { when: "before", path: "/Branches/w1/rv/d1.txt" }, 1)`);
  await go("workspace.run_file", { path: "/Branches/w1/rv/d1.py" });
  check(!!(await until(`window.__aheld === "before"`, 60000)), "RUN-DRAIN-1: the run's write held before its admission");
  await evaluate(`(window.__stop(), window.__arelease(), 1)`);
  r = await result();
  check(r?.ended === "stopped" && r.ok === false && !("stdout" in r) && (await exists("/Branches/w1/rv/d1.txt")) === false, `RUN-DRAIN-1: Stop before admission: nothing kept, the end is Stop's, nothing of what ran said: ${JSON.stringify(r)}`);
  // (RUN-DRAIN-1, after admission: Stop; the run stays busy while it drains; released, the write completes once)
  await evaluate(`(window.__admit = { when: "after", path: "/Branches/w1/rv/d2.txt" }, 1)`);
  await go("workspace.run_file", { path: "/Branches/w1/rv/d2.py" });
  check(!!(await until(`window.__aheld === "after"`, 60000)), "RUN-DRAIN-1: the run's write held after its admission");
  await evaluate(`(window.__stop(), 1)`);
  const busy = await evaluate(`window.__run("workspace.run_file", { path: "/Branches/w1/rv/reads.py" })`);
  check(busy?.threw === "busy" && busy.message === "busy: your run of /rv/d2.py is still going; wait for it or call workspace.run_stop", `RUN-DRAIN-1: while a stopped run drains, a second is busy (board's words): ${JSON.stringify(busy)}`);
  await evaluate(`(window.__arelease(), 1)`);
  r = await result();
  const d2 = await evaluate(`window.__ws.read("/Branches/w1/rv/d2.txt").then((x) => new TextDecoder().decode(x.content))`);
  // (Python's open("w") sends two changes: the file emptied, then its bytes. The first, admitted before Stop, completes
  //  and is kept; the second, after Stop, is fenced: both sides of the boundary)
  check(r?.ended === "stopped" && d2 === "", `RUN-DRAIN-1: the admitted change completes once and is kept, the one after Stop isn't; the end is Stop's: ${JSON.stringify({ r, d2 })}`);
  r = await evaluate(`window.__run("workspace.run_file", { path: "/Branches/w1/rv/reads.py" })`);
  check(r?.ok === true, `after the drain, the next run goes: ${JSON.stringify(r).slice(0, 160)}`);
  // ---- the grant's write changed mid-run (held at the start): a narrowing applies at once; a widening never does (§3)
  await put("/Branches/w1/rv/n1.py", "open('/rv/n1.txt','w').write('n')\n");
  await evaluate(`(window.__holdOn = { start: true }, 1)`);
  await go("workspace.run_file", { path: "/Branches/w1/rv/n1.py" });
  check(!!(await until(`window.__held === "start"`, 60000)), "a writing run held at its start");
  await evaluate(`(window.__grantNow = { ...window.__grant, write: false }, window.__chg?.(), window.__holdOn = {}, window.__release(), 1)`);
  r = await result();
  await evaluate(`(window.__grantNow = undefined, 1)`);
  check(r?.refused?.paths?.includes("/rv/n1.txt") && (await exists("/Branches/w1/rv/n1.txt")) === false, `the grant's write narrowed mid-run: the next write refused: ${JSON.stringify(r)}`);
  await evaluate(`(window.__holdOn = { start: true }, 1)`);
  await go("workspace.run_file", { path: "/Branches/w1/rv/n1.py" }, "{ ...window.__grant, write: false }");
  check(!!(await until(`window.__held === "start"`, 60000)), "a read-only run held at its start");
  await evaluate(`(window.__grantNow = { ...window.__grant, write: true }, window.__chg?.(), window.__holdOn = {}, window.__release(), 1)`);
  r = await result();
  await evaluate(`(window.__grantNow = undefined, 1)`);
  check(r?.refused?.paths?.includes("/rv/n1.txt") && (await exists("/Branches/w1/rv/n1.txt")) === false, `the grant's write widened mid-run: never applied to that run: ${JSON.stringify(r)}`);
  // ---- Stop during the run's own save (held there): nothing saved, the end is Stop's (astra's RUN-SAVE-STOP-1)
  check(await evaluate(`window.__ws.create("/Branches/w1/rv/st.ipynb", { content: { mode: "python", cells: [{ id: "c1", code: "print(5)" }] } }).then(() => true)`) === true, "(a notebook in the branch to stop at its save)");
  await evaluate(`(window.__holdOn = { save: true }, 1)`);
  await go("workspace.run_notebook", { path: "/Branches/w1/rv/st.ipynb" });
  check(!!(await until(`window.__held === "save"`, 60000)), "a run held at its save");
  const lineAtSave = await evaluate(`window.__lines.at(-1)`);
  await evaluate(`(window.__stop(), window.__holdOn = {}, window.__release(), 1)`);
  r = await result();
  const st = await evaluate(`window.__ws.read("/Branches/w1/rv/st.ipynb").then((x) => (x.content.cells[0].outputs ?? []).length)`);
  check(r?.ended === "stopped" && r.ok === false && !("cells" in r) && st === 0 && lineAtSave === "Test agent is running /rv/st.ipynb", `Stop at the save: nothing saved, the end is Stop's, the line there until then: ${JSON.stringify({ r, st, lineAtSave })}`);
  // ---- the input is the snapshot (grader's M7): a person's edit after it (held at the start) changes neither what the
  //  run reads nor its inputHash; the next run sees the edit and another hash
  await put("/Branches/w1/rv/snap.txt", "before");
  await put("/Branches/w1/rv/snap.py", "print(open('/rv/snap.txt').read())\n");
  r = await evaluate(`window.__run("workspace.run_file", { path: "/Branches/w1/rv/snap.py" })`);
  const h1 = r?.inputHash;
  await evaluate(`(window.__holdOn = { start: true }, 1)`);
  await go("workspace.run_file", { path: "/Branches/w1/rv/snap.py" });
  check(!!(await until(`window.__held === "start"`, 60000)), "a run held after its snapshot");
  await put("/Branches/w1/rv/snap.txt", "after");
  await evaluate(`(window.__holdOn = {}, window.__release(), 1)`);
  const r2 = await result();
  const r3 = await evaluate(`window.__run("workspace.run_file", { path: "/Branches/w1/rv/snap.py" })`);
  check(r2?.stdout === "before\n" && r2.inputHash === h1 && r3?.stdout === "after\n" && r3.inputHash !== h1, `an edit after the snapshot: the run reads the snapshot and keeps its hash; the next run sees the edit: ${JSON.stringify({ h1, r2: [r2?.stdout, r2?.inputHash], r3: [r3?.stdout, r3?.inputHash] })}`);
  // ---- r2 (the code reviews of 0ca8b12f) ------------------------------------------------------------------------
  // (RUN-POLICY-2: writable, narrowed, widened again: the run stays narrowed)
  await put("/Branches/w1/rv/mono.py", "open('/rv/mono.txt','w').write('m')\n");
  // (what the interpreter is given at its start, as the runner gets it: its first fsWrite)
  const recHost = `{ ...window.__R.host(), RunnerWorker: class extends window.__R.host().RunnerWorker { postMessage(m, t) { if (m?.fsWrite) window.__fsw.push(m.fsWrite); return super.postMessage(m, t); } } }`;
  await evaluate(`(window.__fsw = [], window.__holdOn = { start: true }, window.__p = window.__M.run("workspace.run_file", { path: "/Branches/w1/rv/mono.py" }, window.__ctx(), ${recHost}, window.__holder).then((x) => x, (e) => ({ threw: e.code, message: e.message })), 1)`);
  check(!!(await until(`window.__held === "start"`, 60000)), "RUN-POLICY-2: a writing run held at its start");
  await evaluate(`(window.__grantNow = { ...window.__grant, write: false }, window.__chg?.(), window.__grantNow = { ...window.__grant, write: true }, window.__chg?.(), window.__holdOn = {}, window.__release(), 1)`);
  r = await result();
  await evaluate(`(window.__grantNow = undefined, 1)`);
  const fsw0 = await evaluate(`window.__fsw`);
  check(r?.refused?.paths?.includes("/rv/mono.txt") && (await exists("/Branches/w1/rv/mono.txt")) === false, `RUN-POLICY-2: narrowed, then widened again: still narrowed: ${JSON.stringify(r)}`);
  check(fsw0?.length >= 1 && fsw0[0].trees.length === 0 && fsw0[0].epoch > 1, `and its interpreter started with that: no write trees, under a later epoch (astra's RUN-POLICY-2 r3): ${JSON.stringify(fsw0)}`);
  // (a document's own trees narrowed in part mid-run: what's outside them refused, what's inside kept)
  check(await evaluate(`window.__ws.create("/rv/part.ipynb", { content: { mode: "python", cells: [{ id: "c1", code: "import os\\nos.makedirs('/rv/sub', exist_ok=True)\\nopen('/rv/sub/py.txt','w').write('y')\\nopen('/rv/px.txt','w').write('x')" }] } }).then(() => true)`) === true, "(a notebook on main that writes in two folders)");
  await evaluate(`(window.__dt = ["/rv"], window.__fsw = [], window.__holdOn = { start: true }, 1)`);
  await evaluate(`(window.__p = window.__M.run("workspace.run_notebook", { path: "/rv/part.ipynb" }, window.__ctx(), { ...window.__R.host(), docTrees: () => window.__dt, RunnerWorker: ${recHost}.RunnerWorker }, window.__holder).then((x) => x, (e) => ({ threw: e.code, message: e.message })), 1)`);
  check(!!(await until(`window.__held === "start"`, 60000)), "a main run held at its start, its notebook's trees /rv");
  await evaluate(`(window.__dt = ["/rv/sub"], window.__holdOn = {}, window.__release(), 1)`);
  r = await result();
  const fswP = await evaluate(`window.__fsw`);
  check(r?.refused?.paths?.includes("/rv/px.txt") && (await exists("/rv/px.txt")) === false && (await exists("/rv/sub/py.txt")) === true, `the notebook's trees narrowed in part mid-run: outside refused, inside kept: ${JSON.stringify(r)}`);
  check(fswP?.length >= 1 && JSON.stringify(fswP[0].trees) === JSON.stringify(["/rv/sub"]) && fswP[0].epoch > 1, `and its interpreter started with the subtree only: ${JSON.stringify(fswP)}`);
  // (RUN-POLICY-2 r2: the page's own permissions (perms) of the notebook, with the page's host, no pairing change and no
  //  file operation between: allowed, revoked, allowed again here; then the same from another tab (its storage
  //  event); and in part (a subtree kept): each run stays at the narrowest)
  const pol = async (name, between) => {
    check(await evaluate(`window.__ws.create("/rv/${name}.ipynb", { content: { mode: "python", cells: [{ id: "c1", code: "import os\\nos.makedirs('/rv/${name}d/s', exist_ok=True)\\nopen('/rv/${name}d/s/b.txt','w').write('b')\\nopen('/rv/${name}d/a.txt','w').write('a')" }] } }).then((e) => (window.__ref = e.ref, window.__R.perms.grant(e.ref, "write", "/rv"), true))`) === true, `(a notebook on main, /rv allowed by its permissions: ${name})`);
    // (what the interpreter is given at its start, as the runner gets it: its first fsWrite)
    await evaluate(`(window.__fsw = [], window.__holdOn = { start: true }, window.__p = window.__M.run("workspace.run_notebook", { path: "/rv/${name}.ipynb" }, window.__ctx(),
      ${recHost}, window.__holder).then((x) => x, (e) => ({ threw: e.code, message: e.message })), 1)`);
    check(!!(await until(`window.__held === "start"`, 60000)), `(${name}: held at its start)`);
    await evaluate(between);
    await evaluate(`(window.__holdOn = {}, window.__release(), 1)`);
    return result();
  };
  r = await pol("pa", `(window.__R.perms.revoke(window.__ref, "write", "/rv"), window.__R.perms.grant(window.__ref, "write", "/rv"), 1)`);
  let fsw = await evaluate(`window.__fsw`);
  check(r?.refused?.paths?.length > 0 && !(await exists("/rv/pad/a.txt")) && !(await exists("/rv/pad/s/b.txt")), `the notebook's permission revoked and allowed again in this page: still revoked for the run: ${JSON.stringify(r)}`);
  check(fsw?.length >= 1 && fsw[0].trees.length === 0 && fsw[0].epoch > 1, `and its interpreter started with that: no write trees, under a later epoch: ${JSON.stringify(fsw)}`);
  const otherTab = (trees) => `(() => { const k = "sagebrush-grants", was = localStorage.getItem(k), j = JSON.parse(was); j.docs[window.__ref].write = ${JSON.stringify(trees)};
    localStorage.setItem(k, JSON.stringify(j)); dispatchEvent(new StorageEvent("storage", { key: k })); localStorage.setItem(k, was); dispatchEvent(new StorageEvent("storage", { key: k })); return 1; })()`;
  r = await pol("pb", otherTab([]));
  check(r?.refused?.paths?.length > 0 && !(await exists("/rv/pbd/a.txt")) && !(await exists("/rv/pbd/s/b.txt")), `revoked and allowed again in another tab (its storage events): still revoked for the run: ${JSON.stringify(r)}`);
  r = await pol("pc", otherTab(["/rv/pcd/s"]));
  fsw = await evaluate(`window.__fsw`);
  check(r?.refused?.paths?.includes("/rv/pcd/a.txt") && !(await exists("/rv/pcd/a.txt")) && (await exists("/rv/pcd/s/b.txt")), `narrowed to a subtree in another tab and widened again: the subtree kept, the rest refused: ${JSON.stringify(r)}`);
  check(fsw?.length >= 1 && JSON.stringify(fsw[0].trees) === JSON.stringify(["/rv/pcd/s"]) && fsw[0].epoch > 1, `and its interpreter started with the subtree only: ${JSON.stringify(fsw)}`);
  // (RUN-READ-BOUND-4: between the listing and the read, a file replaced (another identity) and a file grown past what's left)
  await put("/Branches/w1/rv/id.txt", "one");
  await evaluate(`(window.__holdOn = { listed: true }, 1)`);
  await go("workspace.run_file", { path: "/Branches/w1/rv/hello.py" });
  check(!!(await until(`window.__held === "listed"`, 60000)), "RUN-READ-BOUND-4: a run held between its listing and its reads");
  await evaluate(`(async () => { const h = window.__ws.runHost("agent:Test-agent", () => window.__grant.id); await h.remove("/Branches/w1/rv/id.txt", () => {}); await h.putFile("/Branches/w1/rv/id.txt", new TextEncoder().encode("two"), () => {}); window.__holdOn = {}; window.__release(); return 1; })()`);
  r = await result();
  check(r?.threw === "changed" && r.message === "changed: /rv/id.txt was changed while the run was starting; try again", `a file replaced after the listing: refused as changed, never read as the listed one: ${JSON.stringify(r)}`);
  await put("/Branches/w1/rv/grow.bin", "g");
  await evaluate(`(window.__holdOn = { listed: true }, 1)`);
  await go("workspace.run_file", { path: "/Branches/w1/rv/hello.py" });
  check(!!(await until(`window.__held === "listed"`, 60000)), "a run held between its listing and its reads, again");
  await evaluate(`(async () => { await window.__ws.runHost("agent:Test-agent", () => window.__grant.id).putFile("/Branches/w1/rv/grow.bin", new Uint8Array(64 * 1024 * 1024 + 1), () => {}); window.__holdOn = {}; window.__release(); return 1; })()`);
  r = await result();
  check(r?.threw === "too_large" && /^too large: the files you can read are over 64\.0 MB/.test(r.message), `a file grown past what's left after the listing: refused before it is read: ${JSON.stringify(r)}`);
  await evaluate(`window.__ws.runHost("agent:Test-agent", () => window.__grant.id).remove("/Branches/w1/rv/grow.bin", () => {})`);
  // (the deadline counts from the call's start: a run whose deadline passed while its chunk loaded ends as the timeout)
  r = await evaluate(`(() => { const pre = { owner: window.__grant.id, view: "/rv/hello.py", loading: { stopped: false }, deadlineAt: performance.now() - 1, stop() {} };
    window.__holder.current = pre;
    return window.__M.run("workspace.run_file", { path: "/rv/hello.py" }, window.__ctx(), window.__R.host(), window.__holder, pre); })()`);
  check(r?.ended === "timeout", `a deadline passed while the chunk loaded: the timeout's end: ${JSON.stringify(r)}`);
  // (RUN-DEADLINE-HANDOFF-1: a lookup before the run is held that never answers (the branch's, the file's stat) ends
  //  with the deadline, or with Stop, never outliving them)
  const hung = (which) => `{ ...window.__R.host(), ws: { runHost: (a, o) => Object.create(window.__ws.runHost(a, o), { ${which}: { value: () => new Promise(() => {}) } }) } }`;
  const pre = (ms) => `(() => { const loading = { stopped: false }; const pre = { owner: window.__grant.id, view: "x", loading, deadlineAt: performance.now() + ${ms}, stop() { loading.stopped = true; loading.wake?.(); } }; window.__pre = pre; window.__holder.current = pre; return pre; })()`;
  for (const [which, path] of [["branchAt", "/Branches/w1/rv/hello.py"], ["stat", "/rv/hello.py"]]) {
    const t = await evaluate(`(async () => { const t0 = performance.now(); const r = await window.__M.run("workspace.run_file", { path: ${JSON.stringify(path)} }, window.__ctx(), ${hung(which)}, window.__holder, ${pre(300)}); return { r, ms: performance.now() - t0, held: window.__holder.current }; })()`);
    check(t?.r?.ended === "timeout" && t.ms >= 250 && t.ms < 3000 && t.held === null, `a held ${which}: the deadline (300 ms) ends the run: ${JSON.stringify(t)}`);
    await evaluate(`(window.__p = window.__M.run("workspace.run_file", { path: ${JSON.stringify(path)} }, window.__ctx(), ${hung(which)}, window.__holder, ${pre(60000)}).then((x) => x, (e) => ({ threw: e.code, message: e.message })), 1)`);
    await new Promise((res) => setTimeout(res, 200));
    await evaluate(`(window.__pre.stop(), 1)`);
    r = await until(`Promise.race([window.__p, new Promise((res) => setTimeout(() => res(null), 50))])`, 3000);
    check(r?.ended === "stopped" && (await evaluate(`window.__holder.current === null`)), `a held ${which}: Stop ends the run at once: ${JSON.stringify(r)}`);
    const t2 = await evaluate(`(async () => { const t0 = performance.now(); const r = await window.__M.run("workspace.run_file", { path: ${JSON.stringify(path)}, timeout_s: 1 }, window.__ctx(), ${hung(which)}, window.__holder); return { r, ms: performance.now() - t0 }; })()`);
    check(t2?.r?.ended === "timeout" && t2.ms < 4000, `a held ${which}, no loader's record: timeout_s ends it: ${JSON.stringify(t2)}`);
  }
  // (Stop and the deadline after the save's admission: the save completes once, the end is theirs (ENGINE, RUN-DRAIN-1))
  check(await evaluate(`window.__ws.create("/Branches/w1/rv/st2.ipynb", { content: { mode: "python", cells: [{ id: "c1", code: "print(6)" }] } }).then(() => true)`) === true, "(a notebook to stop after its save's admission)");
  await evaluate(`(window.__admit = { when: "after", path: "/Branches/w1/rv/st2.ipynb", op: "write", skip: 1 }, 1)`);
  await go("workspace.run_notebook", { path: "/Branches/w1/rv/st2.ipynb" });
  check(!!(await until(`window.__aheld === "after"`, 60000)), "a save held after its admission");
  await evaluate(`(window.__stop(), 1)`);
  const busy2 = await evaluate(`window.__run("workspace.run_file", { path: "/rv/hello.py" })`);
  await evaluate(`(window.__arelease(), 1)`);
  r = await result();
  const savedSt2 = await evaluate(`window.__ws.read("/Branches/w1/rv/st2.ipynb").then((x) => (x.content.cells[0].outputs ?? []).length)`);
  check(busy2?.threw === "busy" && r?.ended === "stopped" && !("cells" in r) && savedSt2 > 0, `Stop after the save's admission: busy until it settles, the save kept once, the end is Stop's: ${JSON.stringify({ busy2: busy2?.threw, r, savedSt2 })}`);
  check(await evaluate(`window.__ws.create("/Branches/w1/rv/st3.ipynb", { content: { mode: "python", cells: [{ id: "c1", code: "print(7)" }] } }).then(() => true)`) === true, "(a notebook for the deadline after its save's admission)");
  await evaluate(`(window.__admit = { when: "after", path: "/Branches/w1/rv/st3.ipynb", op: "write", skip: 1 }, window.__lines = [], 1)`);
  await go("workspace.run_notebook", { path: "/Branches/w1/rv/st3.ipynb", timeout_s: 1 });
  check(!!(await until(`window.__aheld === "after"`, 60000)), "a save held after its admission, the deadline 1 s");
  check(!!(await until(`window.__lines.includes("hidden")`, 30000)), "the deadline passes while the save is held (the line goes)");
  await evaluate(`(window.__arelease(), 1)`);
  r = await result();
  const st3 = await evaluate(`window.__ws.read("/Branches/w1/rv/st3.ipynb").then((x) => (x.content.cells[0].outputs ?? []).length)`);
  check(r?.ended === "timeout" && st3 > 0, `the deadline after the save's admission: the save kept once, the end is the timeout's: ${JSON.stringify({ r, st3 })}`);
  // (RUN-BOUND-3 / SIZE-OUTPUT-6: displays charged as they come against the save's 8 MiB, measured while held at the save)
  check(await evaluate(`window.__ws.create("/Branches/w1/rv/big1.ipynb", { content: { mode: "python", cells: [{ id: "c1", code: "from IPython.display import display, HTML\\ndisplay(HTML('x' * 9000000))" }] } }).then(() => true)`) === true, "(a notebook with one display over 8 MiB)");
  await evaluate(`(window.__holdOn = { save: true }, 1)`);
  await go("workspace.run_notebook", { path: "/Branches/w1/rv/big1.ipynb", timeout_s: 120 });
  check(!!(await until(`window.__held === "save"`, 120000)), "held at its save");
  const kept1 = await evaluate(`window.__holder.current.retained()`);
  await evaluate(`(window.__holdOn = {}, window.__release(), 1)`);
  r = await result();
  const outs1 = await evaluate(`window.__ws.read("/Branches/w1/rv/big1.ipynb").then((x) => x.content.cells[0].outputs.map((o) => o.output_type + ":" + (o.text ?? "").slice(0, 40)))`);
  check(kept1?.savedBytes <= 8 * 2 ** 20 && r?.saved === "saved" && kept1.savedBytes === 0 && JSON.stringify(outs1) === JSON.stringify(["stream:[output not kept: the notebook's outputs"]), `one display over 8 MiB: never kept, the note in its place (${kept1?.savedBytes} bytes kept): ${JSON.stringify({ outs1 })}`);
  check(await evaluate(`window.__ws.create("/Branches/w1/rv/big2.ipynb", { content: { mode: "python", cells: [{ id: "c1", code: "from IPython.display import display, HTML\\nfor i in range(12):\\n    display(HTML('y' * 1000000))" }] } }).then(() => true)`) === true, "(a notebook with twelve 1 MB displays)");
  await evaluate(`(window.__holdOn = { save: true }, 1)`);
  await go("workspace.run_notebook", { path: "/Branches/w1/rv/big2.ipynb", timeout_s: 120 });
  check(!!(await until(`window.__held === "save"`, 120000)), "held at its save, again");
  const kept2 = await evaluate(`window.__holder.current.retained()`);
  await evaluate(`(window.__holdOn = {}, window.__release(), 1)`);
  r = await result();
  const outs2 = await evaluate(`window.__ws.read("/Branches/w1/rv/big2.ipynb").then((x) => x.content.cells[0].outputs.map((o) => o.output_type))`);
  check(kept2?.savedBytes <= 8 * 2 ** 20 && outs2?.filter((t) => t === "display_data").length === 8 && outs2.at(-1) === "stream", `twelve 1 MB displays: kept while they fit (8), then the note (${kept2?.savedBytes} bytes kept): ${JSON.stringify(outs2)}`);
  // (the code's changes waiting to be kept: bounded by bytes, measured while the first is held at its admission)
  await put("/Branches/w1/rv/q.py", "for i in range(3):\n    open('/rv/q%d.bin' % i, 'wb').write(b'q' * 30000000)\nprint('wrote')\n");
  await evaluate(`(window.__admit = { when: "before", path: "/Branches/w1/rv/q0.bin" }, 1)`);
  await go("workspace.run_file", { path: "/Branches/w1/rv/q.py", timeout_s: 120 });
  check(!!(await until(`window.__aheld === "before"`, 120000)), "the first write held at its admission");
  check(!!(await until(`window.__holder.current?.retained?.().queuedBytes >= 60000000`, 60000)), "the second write queued behind the held first (its bytes charged)");
  const q = await evaluate(`window.__holder.current.retained()`);
  await evaluate(`(window.__arelease(), 1)`);
  r = await result();
  check(q?.queuedBytes <= 64 * 2 ** 20 && r?.refused?.paths?.includes("/rv/q2.bin") && (await exists("/Branches/w1/rv/q0.bin")) && (await exists("/Branches/w1/rv/q1.bin")), `the changes waiting: at most 64 MiB (${q?.queuedBytes} bytes), the one past it refused: ${JSON.stringify(r?.refused)}`);
  // (RUN-BOUND-3 r2 / SIZE-QUEUE-7: every change charged (its path and a fixed cost, an empty write and a delete too) and
  //  counted: at most 4 096 waiting, the next refused; all let go of once kept)
  await put("/Branches/w1/rv/ops.py", "import os\nfor i in range(4100):\n    open('/rv/e.txt','w').close()\nos.remove('/rv/e.txt')\nprint('done')\n");
  await evaluate(`(window.__admit = { when: "before", path: "/Branches/w1/rv/e.txt" }, 1)`);
  await go("workspace.run_file", { path: "/Branches/w1/rv/ops.py", timeout_s: 300 });
  check(!!(await until(`window.__aheld === "before"`, 120000)), "the first empty write held at its admission");
  check(!!(await until(`window.__holder.current?.retained?.().queuedOps === 4096`, 120000)), "4 096 changes waiting (the cap)");
  const cur = await evaluate(`(window.__cur = window.__holder.current, window.__cur.retained())`);
  await new Promise((res) => setTimeout(res, 500));
  const still = await evaluate(`window.__cur.retained()`);
  await evaluate(`(window.__arelease(), 1)`);
  r = await result();
  const freed = await evaluate(`window.__cur.retained()`);
  check(cur?.queuedOps === 4096 && still?.queuedOps === 4096 && cur.queuedBytes >= 4096 * 256 && r?.refused?.paths?.includes("/rv/e.txt") && r.stdout === "done\n",
    `the 4 097th change refused, never queued; each charged, an empty one too: ${JSON.stringify({ cur, still, refused: r?.refused, out: r?.stdout })}`);
  check(freed?.queuedOps === 0 && freed.queuedBytes === 0 && freed.pending === 0, `once kept, all let go of (no change, byte or promise held): ${JSON.stringify(freed)}`);
  await evaluate(`(window.__holdOn = { start: true }, 1)`);
  await go("workspace.run_file", { path: "/rv/hello.py" });
  check(!!(await until(`window.__held === "start"`, 60000)), "a run held at its start");
  const other = `{ ...window.__grant, id: "b".repeat(32) }`;
  const b2 = await evaluate(`window.__run("workspace.run_file", { path: "/rv/hello.py" }, ${other})`);
  const st2 = await evaluate(`window.__M.stop(window.__ctx(${other}), window.__holder)`);
  check(b2?.threw === "busy" && b2.message === "busy: another run is going in this page; try again when it ends" && JSON.stringify(st2) === '{"stopped":false}' && (await evaluate(`!!window.__holder.current`)) === true,
    `another grant: busy without a name, and its run_stop is {stopped: false}, the run going on: ${JSON.stringify({ b2, st2 })}`);
  const st1 = await evaluate(`window.__M.stop(window.__ctx(), window.__holder)`);
  await evaluate(`(window.__holdOn = {}, window.__release(), 1)`);
  r = await result();
  check(JSON.stringify(st1) === '{"stopped":true}' && r?.ended === "stopped", `its own run_stop stops it: ${JSON.stringify({ st1, r })}`);
  // ---- the grant: revoked mid-run (held at the snapshot), and the page hidden (held at the start)
  await evaluate(`(window.__holdOn = { snapshot: true }, 1)`);
  await go("workspace.run_file", { path: "/rv/hello.py" });
  check(!!(await until(`window.__held === "snapshot"`, 60000)), "a run held at its snapshot");
  await evaluate(`(window.__live = false, window.__why = "the grant was revoked", window.__chg?.(), window.__holdOn = {}, window.__release(), 1)`);
  r = await result();
  await evaluate(`(window.__live = true, window.__why = undefined, 1)`);
  check(JSON.stringify(r) === '{"ok":false,"ended":"revoked","reason":"the grant was revoked"}', `revoked mid-run: its end and why, nothing else: ${JSON.stringify(r)}`);
  await evaluate(`(window.__holdOn = { start: true }, 1)`);
  await go("workspace.run_file", { path: "/rv/hello.py" });
  check(!!(await until(`window.__held === "start"`, 60000)), "a run held at its start, again");
  await evaluate(`(dispatchEvent(new Event("pagehide")), window.__holdOn = {}, window.__release(), 1)`);
  r = await result();
  check(r?.ended === "stopped" && (await evaluate(`window.__holder.current === null`)) === true, `the page hidden: the run ends, the slot freed: ${JSON.stringify(r)}`);
  // ---- revoked while its result is delivered (held at deliver): nothing of it said
  await evaluate(`(window.__holdOn = { deliver: true }, 1)`);
  await go("workspace.run_notebook", { path: "/Branches/w1/rv/nb.ipynb" });
  check(!!(await until(`window.__held === "deliver"`, 60000)), "a run held at its delivery");
  await evaluate(`(window.__live = false, window.__why = "May run code was turned off", window.__holdOn = {}, window.__release(), 1)`);
  r = await result();
  await evaluate(`(window.__live = true, window.__why = undefined, 1)`);
  check(JSON.stringify(r) === '{"ok":false,"ended":"revoked","reason":"May run code was turned off"}', `run turned off at delivery: no cells, no outputs said: ${JSON.stringify(r)}`);
  // ---- SAVE-IDENTITY-2: the notebook replaced at its path (same sources) before the save: conflict, nothing written into it
  await put("/Branches/w1/rv/nb2.ipynb", "{}").catch(() => {});
  await evaluate(`window.__ws.runHost("agent:Test-agent", () => window.__grant.id).remove("/Branches/w1/rv/nb2.ipynb", () => {}).catch(() => {})`);
  await evaluate(`window.__ws.create("/Branches/w1/rv/nb2.ipynb", { content: { mode: "python", cells: [{ id: "c1", code: "print(3)" }] } }).then(() => 1, (e) => String(e))`);
  await evaluate(`(window.__holdOn = { save: true }, 1)`);
  await go("workspace.run_notebook", { path: "/Branches/w1/rv/nb2.ipynb" });
  check(!!(await until(`window.__held === "save"`, 60000)), "SAVE-IDENTITY-2: a run held before its save");
  const rep = await evaluate(`(async () => { const h = window.__ws; await h.remove("/Branches/w1/rv/nb2.ipynb"); await h.create("/Branches/w1/rv/nb2.ipynb", { content: { mode: "python", cells: [{ id: "c1", code: "print(3)" }] } }); window.__holdOn = {}; window.__release(); return 1; })()`);
  r = await result();
  const nb2 = await evaluate(`window.__ws.read("/Branches/w1/rv/nb2.ipynb").then((x) => x.content.cells.map((c) => (c.outputs ?? []).length))`);
  check(rep === 1 && r?.saved === "conflict" && JSON.stringify(nb2) === "[0]", `SAVE-IDENTITY-2: replaced at its path: conflict, the new notebook untouched: ${JSON.stringify({ rep, r, nb2 })}`);
  // ---- the deadline (§2): a run past its timeout_s ends as the timeout
  await put("/Branches/w1/rv/spin.py", "while True:\n    pass\n");
  r = await evaluate(`window.__run("workspace.run_file", { path: "/Branches/w1/rv/spin.py", timeout_s: 1 })`);
  check(r?.ended === "timeout" && r.ok === false, `past timeout_s: the timeout's end: ${JSON.stringify(r)}`);
  // ---- Q1: no sandbox here (the app, sagebrush notebook): refused, and no plain worker made at all
  r = await evaluate(`(async () => { const W = window.Worker; let made = 0; window.Worker = class extends W { constructor(...a) { made++; super(...a); } };
    const out = await window.__M.run("workspace.run_file", { path: "/rv/hello.py" }, window.__ctx(), { ...window.__R.host(), sandbox: "none" }, window.__holder).then((x) => x, (e) => ({ threw: e.code, message: e.message }));
    window.Worker = W; return { ...out, made }; })()`);
  check(r?.threw === "no_sandbox" && r.message === "no sandbox: code runs only in Sagebrush's sandbox, which isn't available here" && r.made === 0, `no sandbox by design: refused, no plain worker made: ${JSON.stringify(r)}`);
  // ---- stopped while its chunk loaded (the pairing's record, agent-ui.ts): it ends at once, nothing read or run
  r = await evaluate(`(() => { const pre = { owner: window.__grant.id, view: "/rv/hello.py", loading: { stopped: true }, stop() {} };
    window.__holder.current = pre;
    return window.__M.run("workspace.run_file", { path: "/rv/hello.py" }, window.__ctx(), window.__R.host(), window.__holder, pre).then((x) => ({ ...x, free: window.__holder.current === null })); })()`);
  check(r?.ended === "stopped" && r.ok === false && r.free === true && !("inputHash" in r), `stopped while its chunk loaded: ended at once, the slot freed: ${JSON.stringify(r)}`);
  // ---- r5 (grader's TESTS at f5302342: 986-r4-1..9, and R15)
  // (986-r4-4, R6: a load the deadline stopped ends as the timeout, its cause kept)
  r = await evaluate(`(() => { const pre = { owner: window.__grant.id, view: "/rv/hello.py", loading: { stopped: true, cause: "timeout" }, stop() {} };
    window.__holder.current = pre;
    return window.__M.run("workspace.run_file", { path: "/rv/hello.py" }, window.__ctx(), window.__R.host(), window.__holder, pre); })()`);
  check(r?.ended === "timeout" && !("inputHash" in r), `a load the deadline stopped: the timeout's end: ${JSON.stringify(r)}`);
  // (986-r4-3, R5: a held run's deadline counts from the call's start, not from its hold)
  await evaluate(`(window.__holdOn = { snapshot: true }, window.__p = window.__M.run("workspace.run_file", { path: "/rv/hello.py" }, window.__ctx(), window.__R.host(), window.__holder, ${pre(1500)}).then((x) => x, (e) => ({ threw: e.code, message: e.message })), 1)`);
  check(!!(await until(`window.__held === "snapshot"`, 60000)), "a run with 1.5 s left from its call held at its snapshot");
  await new Promise((res) => setTimeout(res, 2000));
  await evaluate(`(window.__holdOn = {}, window.__release(), 1)`);
  r = await result();
  check(r?.ended === "timeout" && !("stdout" in r) && (await evaluate(`window.__holder.current === null`)), `the deadline from the call's start passed while held: the timeout's end, nothing run: ${JSON.stringify(r)}`);
  // (986-r4-1, R2: Stop before the save's admission: nothing saved, the end is Stop's)
  check(await evaluate(`window.__ws.create("/Branches/w1/rv/st4.ipynb", { content: { mode: "python", cells: [{ id: "c1", code: "print(8)" }] } }).then(() => true)`) === true, "(a notebook to stop before its save's admission)");
  await evaluate(`(window.__admit = { when: "before", path: "/Branches/w1/rv/st4.ipynb", op: "write", skip: 1 }, 1)`);
  await go("workspace.run_notebook", { path: "/Branches/w1/rv/st4.ipynb" });
  check(!!(await until(`window.__aheld === "before"`, 60000)), "a save held before its admission");
  await evaluate(`(window.__stop(), window.__arelease(), 1)`);
  r = await result();
  const st4 = await evaluate(`window.__ws.read("/Branches/w1/rv/st4.ipynb").then((x) => (x.content.cells[0].outputs ?? []).length)`);
  check(r?.ended === "stopped" && st4 === 0, `Stop before the save's admission: nothing saved, the end is Stop's: ${JSON.stringify({ r, st4 })}`);
  // (986-r4-2, R4: the first end's cause is kept: the deadline, then run_stop while the admitted save drains)
  check(await evaluate(`window.__ws.create("/Branches/w1/rv/st5.ipynb", { content: { mode: "python", cells: [{ id: "c1", code: "print(9)" }] } }).then(() => true)`) === true, "(a notebook for the deadline, then run_stop)");
  await evaluate(`(window.__admit = { when: "after", path: "/Branches/w1/rv/st5.ipynb", op: "write", skip: 1 }, window.__lines = [], 1)`);
  await go("workspace.run_notebook", { path: "/Branches/w1/rv/st5.ipynb", timeout_s: 5 });
  check(!!(await until(`window.__aheld === "after"`, 60000)), "a save held after its admission, the deadline 5 s");
  check(!!(await until(`window.__lines.includes("hidden")`, 30000)), "the deadline passes while the save is held");
  const st5stop = await evaluate(`window.__M.stop(window.__ctx(), window.__holder)`);
  await evaluate(`(window.__arelease(), 1)`);
  r = await result();
  check(r?.ended === "timeout", `the deadline, then run_stop: the first end's cause kept (timeout): ${JSON.stringify({ r, st5stop })}`);
  // (986-r4-5, R11: results charged per cell as they come: every cell listed with its status, the later ones without
  //  their output, said as "the output of N cells")
  check(await evaluate(`window.__ws.create("/rv/many.ipynb", { content: { mode: "python", cells: Array.from({ length: 200 }, (_, i) => ({ id: "c" + i, code: "print('m' * 3000)" })) } }).then(() => true)`) === true, "(a notebook of 200 cells, each printing 3,000 characters)");
  r = await evaluate(`window.__run("workspace.run_notebook", { path: "/rv/many.ipynb", timeout_s: 300 })`);
  const many = { cells: r?.cells?.length, statuses: r?.cells?.every((c) => c.status === "ok"), withOut: r?.cells?.filter((c) => "out" in c).length, last: r?.cells?.at(-1), omitted: r?.truncated?.omitted };
  check(many.cells === 200 && many.statuses && many.withOut > 0 && many.withOut < 200 && !("out" in many.last) && /^the output of \d+ cells$/.test(many.omitted?.[0] ?? "") && JSON.stringify(r).length <= 300 * 1024,
    `200 cells over the 256 KiB result: every cell listed with its status, the later ones' output said as omitted: ${JSON.stringify({ ...many, last: undefined })}`);
  // (astra's r5: the same with 64 refused paths of 255 bytes, almost all quotes (their JSON twice as long): every cell
  //  still listed, the refused paths said)
  check(await evaluate(`window.__ws.create("/rv/many2.ipynb", { content: { mode: "python", cells: [{ id: "q", code: "for i in range(64):\\n    try:\\n        open('/rv/' + chr(34) * 246 + '%03d' % i, 'w').write('q')\\n    except Exception:\\n        pass" }, ...Array.from({ length: 199 }, (_, i) => ({ id: "c" + i, code: "print('m' * 3000)" }))] } }).then(() => true)`) === true, "(a notebook refused 64 quote-heavy paths, then 199 cells of 3,000 characters)");
  r = await evaluate(`window.__run("workspace.run_notebook", { path: "/rv/many2.ipynb", timeout_s: 300 })`);
  const has2 = (r?.cells ?? []).map((c) => "out" in c);
  const many2 = { cells: r?.cells?.length, statuses: r?.cells?.every((c) => c.status === "ok"), refused: r?.refused?.paths?.length, quoted: (r?.refused?.paths?.[0] ?? "").split('"').length - 1, omitted: r?.truncated?.omitted, bytes: new TextEncoder().encode(JSON.stringify(r)).length, latestFirst: has2.includes(false) && has2.lastIndexOf(true) < has2.indexOf(false) };
  check(many2.cells === 200 && many2.statuses && many2.refused === 64 && many2.quoted === 246 && /^the output of \d+ cells$/.test(many2.omitted?.[0] ?? "") && many2.bytes <= 256 * 1024 && many2.latestFirst,
    `64 escaped refused paths and 200 cells over the result: every cell still listed, the result within 256 KiB: ${JSON.stringify(many2)}`);
  // (986-r6-3: Stop at the started hold: nothing of the code reaches the workspace or the result (its write fenced, its
  //  output not said), whether or not the interpreter gets to it)
  await put("/Branches/w1/rv/d3.py", "open('/rv/d3.txt','w').write('ran')\nprint('ran')\n");
  await evaluate(`(window.__holdOn = { started: true }, 1)`);
  await go("workspace.run_file", { path: "/Branches/w1/rv/d3.py" });
  check(!!(await until(`window.__held === "started"`, 60000)), "a run held once its sandbox started");
  await evaluate(`(window.__stop(), window.__holdOn = {}, window.__release(), 1)`);
  r = await result();
  check(r?.ended === "stopped" && !("stdout" in r) && (await exists("/Branches/w1/rv/d3.txt")) === false, `Stop at the started hold: stopped, no effect of the code kept or said: ${JSON.stringify(r)}`);
  // (986-r4-8, R21: a notebook on main keeps no outputs to save, held at its delivery)
  check(await evaluate(`window.__ws.create("/rv/main21.ipynb", { content: { mode: "python", cells: [{ id: "c1", code: "print('y' * 5000)" }] } }).then(() => true)`) === true, "(a notebook on main that prints)");
  await evaluate(`(window.__holdOn = { deliver: true }, 1)`);
  await go("workspace.run_notebook", { path: "/rv/main21.ipynb" });
  check(!!(await until(`window.__held === "deliver"`, 60000)), "a main run held at its delivery");
  const kept21 = await evaluate(`window.__holder.current.retained()`);
  await evaluate(`(window.__holdOn = {}, window.__release(), 1)`);
  r = await result();
  check(kept21?.savedBytes === 0 && r?.saved === "not saved: main", `a notebook on main: no outputs kept to save (${kept21?.savedBytes} bytes): ${JSON.stringify({ kept21, saved: r?.saved })}`);
  // (986-r4-9, R24: a change let go of once kept, while the run is still open)
  await put("/Branches/w1/rv/p24.py", "open('/rv/p24.txt','w').write('x')\nwhile True:\n    pass\n");
  await go("workspace.run_file", { path: "/Branches/w1/rv/p24.py", timeout_s: 60 });
  check(!!(await until(`window.__ws.stat("/Branches/w1/rv/p24.txt").then((e) => !!e && e.size === 1)`, 60000)), "the open run's write is kept");
  const open24 = await until(`(() => { const c = window.__holder.current, k = c?.retained?.(); return c && k && k.pending === 0 && k.queuedOps === 0 ? k : null; })()`, 10000);
  await evaluate(`(window.__stop(), 1)`);
  r = await result();
  check(!!open24 && r?.ended === "stopped", `while the run is still open, its kept change is let go of (no promise or op held): ${JSON.stringify({ open24, ended: r?.ended })}`);
  // (986-r4-7, R16: the notebook replaced at its path (another ref) between its stat and its read: changed, nothing run)
  check(await evaluate(`window.__ws.create("/Branches/w1/rv/r16.ipynb", { content: { mode: "python", cells: [{ id: "c1", code: "print(16)" }] } }).then(() => true)`) === true, "(a notebook to replace before its read)");
  await evaluate(`(window.__holdOn = { listed: true }, 1)`);
  await go("workspace.run_notebook", { path: "/Branches/w1/rv/r16.ipynb" });
  check(!!(await until(`window.__held === "listed"`, 60000)), "a run held between its listing and its reads");
  await evaluate(`(async () => { const h = window.__ws; await h.remove("/Branches/w1/rv/r16.ipynb"); await h.create("/Branches/w1/rv/r16.ipynb", { content: { mode: "python", cells: [{ id: "c1", code: "open('/rv/r16.txt','w').write('ran')" }] } }); window.__holdOn = {}; window.__release(); return 1; })()`);
  r = await result();
  check(r?.threw === "changed" && (await exists("/Branches/w1/rv/r16.txt")) === false, `replaced between its stat and its read: changed, the replacement never run: ${JSON.stringify(r)}`);
  // (986-r4-6, R13: a file grown past what's left is read only up to it, never whole: readUpTo's bound recorded)
  await put("/Branches/w1/rv/grow2.bin", "g");
  const spy = `{ ...window.__R.host(), ws: { runHost: (a, o) => { const h = window.__ws.runHost(a, o); return Object.create(h, { readUpTo: { value: (p, max, admit) => { (window.__maxes ??= []).push([p, max]); return h.readUpTo(p, max, admit).then((x) => { window.__got = Math.max(window.__got ?? 0, x.content.length); return x; }); } } }); } } }`;
  await evaluate(`(window.__maxes = [], window.__got = 0, window.__holdOn = { listed: true }, window.__p = window.__M.run("workspace.run_file", { path: "/Branches/w1/rv/hello.py" }, window.__ctx(), ${spy}, window.__holder).then((x) => x, (e) => ({ threw: e.code, message: e.message })), 1)`);
  check(!!(await until(`window.__held === "listed"`, 60000)), "a run held between its listing and its reads, spied");
  await evaluate(`(async () => { await window.__ws.runHost("agent:Test-agent", () => window.__grant.id).putFile("/Branches/w1/rv/grow2.bin", new Uint8Array(64 * 1024 * 1024 + 1), () => {}); window.__holdOn = {}; window.__release(); return 1; })()`);
  r = await result();
  const spied = await evaluate(`({ grow: window.__maxes.filter(([p]) => p.endsWith("/grow2.bin")).map(([, m]) => m), got: window.__got })`);
  check(r?.threw === "too_large" && spied?.grow?.length === 1 && spied.grow[0] <= 64 * 2 ** 20 && spied.got <= 64 * 2 ** 20, `the grown file asked for at most what's left, never read whole: ${JSON.stringify({ r, spied })}`);
  await evaluate(`window.__ws.runHost("agent:Test-agent", () => window.__grant.id).remove("/Branches/w1/rv/grow2.bin", () => {})`);
  // (R15: the branch's root replaced after the listing, its files keeping their fids (a file moved into a new root at
  //  the same path keeps its fid): the read's admission sees another root and refuses it as changed)
  const reroot = `{ ...window.__R.host(), ws: { runHost: (a, o) => { const h = window.__ws.runHost(a, o); return Object.create(h, { readUpTo: { value: (p, max, admit) => h.readUpTo(p, max, (c) => admit({ ...c, branch: { ...(c.branch ?? {}), root: { ...(c.branch?.root ?? {}), fid: "another-root" } } })) } }); } } }`;
  r = await evaluate(`window.__M.run("workspace.run_file", { path: "/Branches/w1/rv/hello.py" }, window.__ctx(), ${reroot}, window.__holder).then((x) => x, (e) => ({ threw: e.code, message: e.message }))`);
  check(r?.threw === "changed" && r.message === "changed: /rv/hello.py was changed while the run was starting; try again", `the branch's root another one at the read: refused as changed, the run's own path said: ${JSON.stringify(r)}`);
  // ---- Q1: the sandbox didn't start (a runner that never answers): said, never retried outside it, no plain worker
  r = await evaluate(`(async () => { const W = window.Worker; let made = 0; window.Worker = class extends W { constructor(...a) { made++; super(...a); } };
    class Silent { constructor() { this.onmessage = null; this.onerror = null; } postMessage() {} terminate() {} get interrupt() { return undefined; } }
    const out = await window.__M.run("workspace.run_file", { path: "/rv/hello.py" }, window.__ctx(), { ...window.__R.host(), RunnerWorker: Silent }, window.__holder).then((x) => x, (e) => ({ threw: e.code, message: e.message }));
    window.Worker = W; return { ...out, made, free: window.__holder.current === null }; })()`);
  check(r?.threw === "no_sandbox" && r.message === "no sandbox: Sagebrush's sandbox didn't start; try again" && r.made === 0 && r.free === true, `the sandbox didn't start: said, no plain worker, the slot freed: ${JSON.stringify(r)}`);
  // ---- AUTH-1 on main: the target's own trees met with the grant's, never the notebook on screen's
  check(await evaluate(`window.__ws.create("/rv/nb3.ipynb", { content: { mode: "python", cells: [{ id: "c1", code: "open('/rv/n3.txt','w').write('3')" }] } }).then(() => true)`) === true, "(a second notebook on main)");
  const ref3 = await evaluate(`window.__ws.stat("/rv/nb3.ipynb").then((e) => e.ref)`);
  const ref1 = await evaluate(`window.__ws.stat("/rv/nb.ipynb").then((e) => e.ref)`);
  const withTrees = (allowed) => `{ ...window.__R.host(), docTrees: (ref) => (${JSON.stringify(allowed)}).includes(ref) ? ["/rv"] : [] }`;
  r = await evaluate(`window.__M.run("workspace.run_notebook", { path: "/rv/nb3.ipynb" }, window.__ctx(), ${withTrees([ref1])}, window.__holder)`);
  check(r?.refused?.paths?.includes("/rv/n3.txt") && (await exists("/rv/n3.txt")) === false, `another notebook's permission isn't lent: nb3's write refused: ${JSON.stringify(r)}`);
  r = await evaluate(`window.__M.run("workspace.run_notebook", { path: "/rv/nb3.ipynb" }, window.__ctx({ ...window.__grant, write: false }), ${withTrees([ref3])}, window.__holder)`);
  check(r?.refused?.paths?.includes("/rv/n3.txt") && (await exists("/rv/n3.txt")) === false, `its own permission, but a read-only grant: refused: ${JSON.stringify(r)}`);
  r = await evaluate(`window.__M.run("workspace.run_notebook", { path: "/rv/nb3.ipynb" }, window.__ctx(), ${withTrees([ref3])}, window.__holder)`);
  check(r?.ok === true && r.saved === "not saved: main" && (await exists("/rv/n3.txt")) === true, `its own permission met with a writable grant: the write kept, no outputs saved: ${JSON.stringify(r)}`);
  // ---- W1: a write the code names outside the branch has no real path: refused
  await put("/Branches/w1/rv/esc.py", "for p in ['/Branches/w2/x.txt', '/Trash/x.txt']:\n    try:\n        open(p, 'w').write('x')\n    except Exception as e:\n        print(type(e).__name__)\n");
  r = await evaluate(`window.__run("workspace.run_file", { path: "/Branches/w1/rv/esc.py" })`);
  check(r?.ok === true && (await exists("/Branches/w2/x.txt")) === false && (await exists("/Branches/w1/Branches/w2/x.txt")) === false && (await exists("/Branches/w1/Trash/x.txt")) === false, `W1: /Branches and /Trash named inside the view: nothing written anywhere: ${JSON.stringify(r)}`);
  // ---- a cell's output: head and tail kept, the middle said (§7)
  await put("/Branches/w1/rv/loud.py", "print('a' * 5000)\n");
  r = await evaluate(`window.__run("workspace.run_file", { path: "/Branches/w1/rv/loud.py" })`);
  check(r?.stdout === "a".repeat(5000) + "\n", `5,001 bytes of stdout: under 32+32 KiB, whole: ${(r?.stdout ?? "").length}`);
  check(await evaluate(`window.__ws.create("/Branches/w1/rv/loud.ipynb", { content: { mode: "python", cells: [{ id: "c1", code: "print('b' * 3000)" }] } }).then(() => true)`) === true, "(a loud notebook in the branch)");
  r = await evaluate(`window.__run("workspace.run_notebook", { path: "/Branches/w1/rv/loud.ipynb" })`);
  // (counted as JSON: the newline is 2 of the tail's 1,024 bytes)
  check(r?.cells?.[0]?.out === "b".repeat(1024) + "[… 954 bytes]" + "b".repeat(1022) + "\n", `a cell's 3,001 bytes: its first and last KiB as JSON, the middle said: ${(r?.cells?.[0]?.out ?? "").length}`);
  // ---- the snapshot's bounds (§4): 2,000 files accepted, 2,001 refused before anything is hashed or run
  check(await evaluate(`(async () => { const h = window.__ws.runHost("agent:Test-agent", () => window.__grant.id), e = new TextEncoder();
    await window.__ws.mkdir("/lim").catch(() => {});
    await h.putFile("/lim/t.py", e.encode("print('ok')\\n"), () => {});
    for (let i = 0; i < 1999; i++) await h.putFile("/lim/f" + i, e.encode("x"), () => {});
    return true; })()`) === true, "(2,000 files the grant can read: /lim)");
  const lim = `{ ...window.__grant, folders: ["/lim"] }`;
  r = await evaluate(`window.__run("workspace.run_file", { path: "/lim/t.py" }, ${lim})`);
  check(r?.ok === true && r.stdout === "ok\n", `2,000 files: accepted: ${JSON.stringify(r).slice(0, 200)}`);
  await evaluate(`window.__ws.runHost("agent:Test-agent", () => window.__grant.id).putFile("/lim/f1999", new TextEncoder().encode("x"), () => {})`);
  r = await evaluate(`window.__run("workspace.run_file", { path: "/lim/t.py" }, ${lim})`);
  check(r?.threw === "too_large" && r.message === "too large: the files you can read are over 2,000 (2,001)", `2,001 files: refused, with the count: ${JSON.stringify(r)}`);
  // (64 MiB: the files' bytes exactly at the bound accepted, one byte more refused)
  check(await evaluate(`(async () => { const h = window.__ws.runHost("agent:Test-agent", () => window.__grant.id), e = new TextEncoder();
    await window.__ws.mkdir("/big").catch(() => {});
    const t = e.encode("print('big')\\n");
    await h.putFile("/big/t.py", t, () => {});
    await h.putFile("/big/blob", new Uint8Array(64 * 1024 * 1024 - t.length), () => {});
    return true; })()`) === true, "(64 MiB the grant can read: /big)");
  const bigG = `{ ...window.__grant, folders: ["/big"] }`;
  // (the snapshot's peak, daybreak2's evidence: the page's JS heap before the run, and at its start, the snapshot built
  //  and not yet handed to the runner: one copy of the 64 MiB, never two)
  // (measureUserAgentSpecificMemory, which a cross-origin isolated page has: it counts ArrayBuffers' bytes, as the JS
  //  heap's own figure doesn't)
  const heap = () => evaluate(`performance.measureUserAgentSpecificMemory ? performance.measureUserAgentSpecificMemory().then((m) => m.bytes) : -1`);
  const before = await heap();
  // (held before the hand-off: the snapshot built, one copy; then after it (daybreak2's SIZE-SNAPSHOT-3): the bytes
  //  moved to the runner by transfer, none left in the page)
  await evaluate(`(window.__holdOn = { start: true, started: true }, 1)`);
  await go("workspace.run_file", { path: "/big/t.py" }, bigG);
  check(!!(await until(`window.__held === "start"`, 120000)), "the 64 MiB run held before its hand-off to the runner");
  const peak = await heap();
  await evaluate(`(window.__release(), 1)`);
  check(!!(await until(`window.__held === "started"`, 120000)), "the 64 MiB run held after its hand-off");
  const after = await heap();
  await evaluate(`(window.__holdOn = {}, window.__release(), 1)`);
  r = await result();
  const grew = Math.round((peak - before) / 2 ** 20), left = Math.round((after - before) / 2 ** 20);
  console.log(`snapshot after the hand-off: +${left} MiB left in the page`);
  console.log(`snapshot peak: the page's memory ${Math.round(before / 2 ** 20)} MiB before, ${Math.round(peak / 2 ** 20)} MiB with the 64 MiB snapshot built (+${grew} MiB)`);
  check(r?.ok === true && r.stdout === "big\n" && before > 0 && grew >= 60 && grew < 64 * 2 && left < 16, `64 MiB exactly: accepted, its snapshot one copy (+${grew} MiB at its peak): ${JSON.stringify(r).slice(0, 200)}`);
  await evaluate(`window.__ws.runHost("agent:Test-agent", () => window.__grant.id).putFile("/big/one", new Uint8Array(1), () => {})`);
  r = await evaluate(`window.__run("workspace.run_file", { path: "/big/t.py" }, ${bigG})`);
  check(r?.threw === "too_large" && /^too large: the files you can read are over 64\.0 MB \(64\.0 MB\)$/.test(r.message), `one byte more: refused: ${JSON.stringify(r)}`);
} catch (e) {
  fails.push(String(e?.stack ?? e));
} finally {
  try { process.kill(-chrome.pid); } catch {}
  try { server?.kill(); } catch {}
  try { rmSync(join(here, "dist", gbName), { force: true }); } catch {}
  try { rmSync(join(here, "dist", gvName), { force: true }); rmSync(join(gvEntry, ".."), { recursive: true, force: true }); } catch {}
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5 }); } catch {}
}
if (fails.length) { console.error(`FAIL: ${fails.length} of ${checks} checks\n  ` + fails.join("\n  ")); process.exit(1); }
console.log(`ok: an agent's runs of code, ${checks} checks`);
