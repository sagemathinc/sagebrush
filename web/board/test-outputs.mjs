// Outputs on boards (design/outputs.md), in headless Chrome.  Step 1: a
// board's seed makes its random numbers the same at every load (and another
// seed, others); each code item's output key changes exactly when its code or
// anything upstream does; its time from root is its own time and its
// ancestors'; a new board gets a seed of its own.  Serve web/dist first
// (python3 web/serve.py 8765), then
//   node web/board/test-outputs.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const port = +(process.env.CDP_PORT ?? 9457), sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-outputs-prof-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, "--window-size=1280,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
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
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result?.value; };
const until = async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(50); } return false; };
const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };

const SEED_A = "a".repeat(64), SEED_B = "b".repeat(64);
// r draws a random number; p prints it (reads r); q is on its own
const board = (seed, rCode = "import random\nx = random.random()") => ({
  title: "Outputs", ...(seed ? { seed } : {}),
  nodes: [
    { id: "r", title: "draw", code: rCode },
    { id: "p", title: "show", code: "print(x)" },
    { id: "q", title: "alone", code: "y = 2\nprint(y)" },
  ],
});
const outputs = () => ev("window.sagebrush.board.outputs().then((os) => Object.fromEntries(os.map((o) => [o.id, o])))");
const ran = () => until("window.sagebrush.board.outputs().then((os) => os.length === 3 && os.every((o) => o.state === '') && /\\d/.test(os.find((o) => o.id === 'p').output) && /2/.test(os.find((o) => o.id === 'q').output))", 90000);
const open = async (doc) => {
  await send("Page.navigate", { url: `${base}board/?doc=${encodeURIComponent("examples/live.json")}` });
  await until("window.sagebrush?.board?.snapshot().items.length > 0", 60000);
  await ev(`window.sagebrush.board.load(${JSON.stringify(doc)}).then(() => 1)`);
  check(await ran(), "the board's code items ran: " + JSON.stringify(await outputs().catch(() => null)).slice(0, 300));
  return (await outputs()).p.output.trim();
};
const keys = () => ev("window.sagebrush.board.outputKeys()");

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  // the same seed: the same numbers, at every load; another seed: others
  const a1 = await open(board(SEED_A));
  const k1 = await keys();
  const a2 = await open(board(SEED_A));
  const k2 = await keys();
  check(/^0\.\d+$/.test(a1) && a1 === a2, `the same seed drew different numbers: ${a1} ${a2}`);
  check(k1 && ["r", "p", "q"].every((id) => /^[0-9a-f]{64}$/.test(k1[id]?.key ?? "")), "every item has a key: " + JSON.stringify(k1));
  check(k1 && k2 && ["r", "p", "q"].every((id) => k1[id].key === k2[id].key), "the same board has the same keys at every load");
  const b1 = await open(board(SEED_B));
  const kb = await keys();
  check(b1 !== a1, `another seed drew the same number: ${b1}`);
  check(["r", "p", "q"].every((id) => kb[id].key !== k1[id].key), "the seed is in every key");
  // a board without a seed: the same numbers at every load too
  const n1 = await open(board(null)), n2 = await open(board(null));
  check(n1 === n2 && n1 !== a1, `a board without a seed: ${n1} ${n2}`);
  // the file keeps the seed (canonical, after the engine's field)
  await open(board(SEED_A));
  const file = await ev("window.sagebrush.board.json()");
  check(file.includes(`  "seed": "${SEED_A}",\n`), "the file keeps the board's seed");
  // editing r changes the keys of r and p (which reads it), not q's
  await ev(`window.sagebrush.board.edit((d) => { d.nodes.find((x) => x.id === "r").code = "import random\\nx = random.random() + 1"; }).then(() => 1)`);
  check(await until("window.sagebrush.board.outputs().then((os) => /^1\\.\\d+/.test(os.find((o) => o.id === 'p').output.trim()))", 30000), "p reran after r changed");
  const k3 = await keys();
  check(k3.r.key !== k1.r.key && k3.p.key !== k1.p.key && k3.q.key === k1.q.key, "editing r changed r's and p's keys only: " + JSON.stringify([k1, k3]).slice(0, 400));
  // time from root: p's is its own time and r's; q's its own
  const close = (x, y) => Math.abs(x - y) < 1e-6;
  check(k3.p.untimed === 0 && close(k3.p.fromRoot, k3.p.ms + k3.r.ms), "p's time from root is p's and r's: " + JSON.stringify(k3.p) + JSON.stringify(k3.r));
  check(close(k3.q.fromRoot, k3.q.ms) && close(k3.r.fromRoot, k3.r.ms), "q's and r's time from root are their own");
  check(!k3.p.widget && !k3.r.widget, "no widget moved");
  // a new board gets a seed of its own
  await ev("document.querySelector('[data-sbb=newboard]').click(), 1");
  check(await until("window.sagebrush.board.json().then((t) => /\"seed\": \"[0-9a-f]{64}\"/.test(t) && !t.includes('aaaa'))", 10000), "a new board has a seed of its own");
  check(!errors.length, "no exceptions: " + errors.join(" | ").slice(0, 400));
} catch (e) {
  fails.push(String(e?.stack ?? e));
} finally {
  chrome.kill();
  await sleep(200);
  rmSync(profile, { recursive: true, force: true });
}
if (fails.length) {
  console.log(`${fails.length} of ${checks} checks failed:\n  ` + fails.join("\n  "));
  process.exit(1);
}
console.log(`${checks}/${checks} checks passed`);
