// ci: web-runner order=186 runner=bun chrome
// An agent's runs of code in the page (chat plan PR 4a; packet r3 §11): run_notebook, run_file and run_stop, in headless
// Chromium against web/dist, through the page's real runner and workspace, with the calling grant as a test object
// (the pairing's own rows are test-agent-pair.mjs's). Every race is reached through a named hold the test releases.
//   bun web/build.ts && CHROME=google-chrome bun web/workspace/test-run-verbs-page.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
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
  check(r?.threw === "not_allowed" && r.message === 'not allowed: this grant may not run code (the person can turn on "May run code" in Agents with access)', `run off: refused, board's words: ${JSON.stringify(r)}`);
  r = await evaluate(`window.__run("workspace.run_file", { path: "/rv/data.csv" })`);
  check(r?.threw === "invalid" && /isn't a \.py or \.sage file/.test(r.message), `run_file on a .csv: refused: ${JSON.stringify(r)}`);
  r = await evaluate(`window.__run("workspace.run_notebook", { path: "/rv/hello.py" })`);
  check(r?.threw === "invalid" && /isn't a notebook/.test(r.message), `run_notebook on a .py: refused: ${JSON.stringify(r)}`);
  r = await evaluate(`window.__run("workspace.run_file", { path: "/rv/hello.py" }, { ...window.__grant, folders: ["/other"] })`);
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
} catch (e) {
  fails.push(String(e?.stack ?? e));
} finally {
  try { process.kill(-chrome.pid); } catch {}
  try { server?.kill(); } catch {}
  try { rmSync(join(here, "dist", gbName), { force: true }); } catch {}
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5 }); } catch {}
}
if (fails.length) { console.error(`FAIL: ${fails.length} of ${checks} checks\n  ` + fails.join("\n  ")); process.exit(1); }
console.log(`ok: an agent's runs of code, ${checks} checks`);
