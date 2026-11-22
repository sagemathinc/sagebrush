// ci: checks.3 order=43
// A change the interpreter waits on, through the desktop app's engine (app/engine/serve.mjs; the write-wait design, SEC
// ruling of Nov 22, 2026): Python run by a real engine writes outside what it may change, and its run blocks in
// Atomics.wait on {fsAsk}; the engine keeps the request and relays the page's {runnerAsk} answer, storing an allow's
// epoch in the shared word before writing it. A blocked interpreter takes no message, so:
//   - an allow (a fresh policy covering the file, at the next epoch) lets the same run make the change, and the page is
//     told of it;
//   - a stale answer (an old epoch), a torn one (the word's epoch not the policy's), one for another key, and Stop while
//     it waits: the change refused, nothing written;
//   - the control: a widened policy posted the ordinary way ({fsWrite}) while the run waits reaches nothing (the run
//     stays blocked, nothing written) until the request is answered, here with no: refused.
//   node web/test-app-engine-ask.mjs [DIR]     DIR: the worker's folder (default web/dist, from bun web/build.ts)
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { encode, decode, frame, frameReader } from "../app/engine/frames.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = process.argv[2] ?? join(here, "dist");
let failed = 0, passed = 0;
const ok = (c, what) => (c ? (passed++, console.log("ok   " + what)) : (failed++, console.log("FAIL " + what)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function engine() {
  const p = spawn(process.execPath, [join(here, "..", "app", "engine", "main.mjs"), "--stdio", "--root", root, "--memory", "2048"], { stdio: ["pipe", "pipe", "pipe"] });
  const msgs = [], waiters = [];
  let err = "";
  p.stderr.on("data", (d) => (err += d));
  const r = frameReader((x) => {
    const m = decode(x);
    msgs.push(m);
    for (const w of [...waiters]) if (w.test(m)) { waiters.splice(waiters.indexOf(w), 1); w.res(m); }
  });
  p.stdout.on("data", (d) => r.push(d));
  return {
    p, msgs,
    send: (m) => p.stdin.write(frame(encode(m))),
    wait(test, ms = 60000, what = "a message") {
      const have = msgs.find(test);
      if (have) return Promise.resolve(have);
      return new Promise((res, rej) => {
        const w = { test, res };
        waiters.push(w);
        setTimeout(() => { if (waiters.includes(w)) rej(new Error(`timed out waiting for ${what}; stderr: ${err.slice(-2000)}`)); }, ms);
      });
    },
  };
}

const CODE = "try:\n    open('/x.txt', 'w').write('hi')\n    print('wrote')\nexcept PermissionError:\n    print('refused')";
const POLICY = (epoch) => ({ epoch, state: "scoped", trees: ["/ok", "/x.txt"] });

// One case: a fresh engine whose interpreter may change /ok only (epoch 1); the cell writes /x.txt, and `answer(e, ask)`
// does what the page would with its {fsAsk}. What the run printed, and whether /x.txt reached the page.
async function run(answer) {
  const e = engine();
  const from = (test) => (m) => m.from === "nb1" && test(m.m);
  try {
    e.send({ hello: { protocol: { min: 1, max: 1 }, client: "test", want: [] } });
    await e.wait((m) => m.hello);
    e.send({ open: "nb1", name: "" });
    e.send({ to: "nb1", m: { init: { limits: null } } });
    e.send({ to: "nb1", m: { fsWrite: { epoch: 1, state: "scoped", trees: ["/ok"] } } });
    await e.wait(from((m) => m.ready), 60000, "ready");
    e.send({ to: "nb1", m: { id: 1, code: CODE } });
    const ask = (await e.wait(from((m) => m.fsAsk !== undefined), 60000, "the request")).m;
    const extra = await answer(e, ask);
    await e.wait(from((m) => m.id === 1 && m.done), 60000, "the run's end");
    const text = e.msgs.filter((x) => x.from === "nb1" && x.m.id === 1 && x.m.stream).map((x) => x.m.text).join("").trim();
    const told = e.msgs.some((x) => x.from === "nb1" && x.m.fsChanged === "/x.txt");
    return { ask: ask.fsAsk, buffer: ask.buffer, text, told, ...extra };
  } finally {
    e.p.kill();
  }
}
const reply = (e, key, epoch, policy) => e.send({ to: "nb1", m: { runnerAsk: key, epoch, answer: policy ? JSON.stringify({ key, policy }) : null } });

try {
  // (an allow: the next epoch's policy covering /x.txt)
  const a = await run((e, m) => reply(e, m.fsAsk.key, 2, POLICY(2)));
  ok(a.ask && a.ask.path === "/x.txt" && a.ask.what === "open" && a.ask.epoch === 1 && typeof a.ask.key === "string" && a.buffer === null, "the run asks, with its path, operation, epoch and key; the engine keeps the buffer: " + JSON.stringify(a.ask));
  ok(a.text === "wrote" && a.told, `an allow: the same run makes the change, and the page is told of it (${a.text}, told ${a.told})`);
  // (stale: an answer at the request's own epoch; torn: the word stored at 2, the policy saying 3; another key)
  const s = await run((e, m) => reply(e, m.fsAsk.key, 1, POLICY(1)));
  ok(s.text === "refused" && !s.told, `an answer at an old epoch: refused, nothing written (${s.text})`);
  const t = await run((e, m) => reply(e, m.fsAsk.key, 2, POLICY(3)));
  ok(t.text === "refused" && !t.told, `a torn answer (the word's epoch not the policy's): refused, nothing written (${t.text})`);
  const k = await run(async (e, m) => { reply(e, m.fsAsk.key + "x", 2, POLICY(2)); await sleep(1500); e.send({ to: "nb1", m: { runnerInterrupt: 1 } }); });
  ok(!/wrote/.test(k.text) && !k.told, `an answer for another key changes nothing; Stop while it waits: refused, nothing written (${JSON.stringify(k.text)})`);
  // (the control: the widening posted the ordinary way reaches nothing while the run is blocked)
  const c = await run(async (e, m) => {
    e.send({ to: "nb1", m: { fsWrite: { epoch: 2, state: "on", trees: ["/"] } } });
    await sleep(2000);
    const during = e.msgs.some((x) => x.from === "nb1" && ((x.m.id === 1 && (x.m.stream || x.m.done)) || x.m.fsChanged === "/x.txt"));
    reply(e, m.fsAsk.key, null, null);
    return { during };
  });
  ok(!c.during && c.text === "refused" && !c.told, `the control: a policy posted as {fsWrite} while the run waits reaches nothing (blocked: ${!c.during}); answered no: refused (${c.text})`);
} catch (e) {
  ok(false, String(e?.stack ?? e));
}
console.log(failed ? `FAIL: ${failed} of ${passed + failed}` : `app engine ask: all ${passed} checks passed`);
process.exit(failed ? 1 : 0);
