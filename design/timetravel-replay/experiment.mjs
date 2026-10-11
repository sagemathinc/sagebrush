// Replay determinism experiment (design/timetravel-replay.md): the same
// cells in fresh workers of the real sagebrush.space worker, unpinned and
// pinned (pin.js).  From the repository root:
//   bun web/build.ts && cp design/timetravel-replay/{pin.js,replay-worker.js,tt.html} web/dist/
//   node design/timetravel-replay/experiment.mjs
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn("python3", ["-m", "http.server", "8771", "--bind", "127.0.0.1"], { cwd: process.env.SITE ?? "web/dist", stdio: "ignore" });
const profile = mkdtempSync(join(tmpdir(), "tt-"));
const chrome = spawn("chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=9341", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
let targets;
for (let i = 0; i < 100; i++) { try { targets = await (await fetch("http://127.0.0.1:9341/json")).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; };

const T = (code) => `try:\n${code.split("\n").map((l) => "    " + l).join("\n")}\nexcept Exception as e:\n    print("ERR", type(e).__name__, str(e)[:80])`;
const cells = {
  "random": T("import random\nprint(random.random(), random.randint(1, 10**6))"),
  "time": T("import time\nprint(time.time())\nt = time.perf_counter(); s = sum(range(10**5)); print(time.perf_counter() - t)"),
  "numpy": T("import numpy as np\nprint(np.random.rand(2))\nprint(np.random.default_rng().integers(0, 100, 4))"),
  "sets/hash": T("print(list({'apple', 'banana', 'cherry', 'date', 'elderberry'}))\nprint(hash('abc'), hash((1, 'a')), hash(1.5))\ns = set(str(k) for k in range(30)); print(list(s)[:6])"),
  "id/urandom": T("import os\nprint(id(object()) % 100000)\nprint(os.urandom(4).hex())"),
  "sage random": T("print(randint(1, 10^9)); print(random_prime(10^20)); print(random_matrix(ZZ, 2, 2).list())"),
  "sage exact": T("print(factor(2^128 + 1)); x = var('x'); print(solve(x^3 - 3*x + 1 == 0, x))"),
  "file mtime": T("import os\nopen('f.txt', 'w').write('hi'); print(os.path.getmtime('f.txt'))"),
  "datetime": T("import datetime\nprint(datetime.datetime.now())"),
  "uuid": T("import uuid\nprint(uuid.uuid4())"),
  "pickle": T("import pickle\nprint(len(pickle.dumps({'a': [1, 2, 3]})))\ndef f(z): return z + 1\nprint(len(pickle.dumps(f)))\nprint(pickle.loads(pickle.dumps(QQ(3)/7)))"),
  "heavy": T("print(len(str(factorial(30000))))"),
};
const names = Object.keys(cells), codes = Object.values(cells);
try {
  await send("Page.navigate", { url: "http://127.0.0.1:8771/tt.html" });
  for (let i = 0; i < 100; i++) { if (await ev("typeof runSession === 'function'").catch(() => false)) break; await sleep(100); }
  const run = (url, name) => ev(`runSession(${JSON.stringify(url)}, ${JSON.stringify(codes)}, ${JSON.stringify(name ?? "")})`);
  const pinned = JSON.stringify({ seed: 12345, epoch: 1791680000000 });
  const R = {
    A: await run("sagebrush-worker.js"),
    B: await run("sagebrush-worker.js"),
    PA: await run("replay-worker.js", pinned),
    PB: await run("replay-worker.js", pinned),
    PC: await run("replay-worker.js", JSON.stringify({ seed: 999, epoch: 1791680000000 })),
  };
  for (const [k, r] of Object.entries(R)) if (r.error) console.log(k, "ERROR", r.error);
  console.log("startup ms:", Object.fromEntries(Object.entries(R).map(([k, r]) => [k, Math.round(r.ready)])));
  console.log("total ms:", Object.fromEntries(Object.entries(R).map(([k, r]) => [k, Math.round(r.total)])));
  const same = (x, y) => x.text === y.text;
  console.log("\ncell             | unpinned A==B | pinned A==B | seed changes it | ms (A, B, PA)");
  names.forEach((nm, i) => {
    const o = (k) => R[k].out[i];
    console.log(`${nm.padEnd(16)} | ${String(same(o("A"), o("B"))).padEnd(13)} | ${String(same(o("PA"), o("PB"))).padEnd(11)} | ${String(!same(o("PA"), o("PC"))).padEnd(15)} | ${[o("A").ms, o("B").ms, o("PA").ms].map((x) => x.toFixed(1)).join(", ")}`);
  });
  console.log("\nunpinned A outputs:");
  names.forEach((nm, i) => console.log(`--- ${nm}\n${R.A.out[i].text.trim().slice(0, 300)}`));
  console.log("\npinned PA outputs (where they differ from A):");
  names.forEach((nm, i) => { if (R.PA.out[i].text !== R.A.out[i].text) console.log(`--- ${nm}\n${R.PA.out[i].text.trim().slice(0, 300)}`); });
} finally {
  chrome.kill(); server.kill();
}
