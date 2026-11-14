// ci: web-runner order=125 chrome
// A Terminal prompt in the browser's worker (term-prompt design r1, r1a, r1b): the built worker (web/term-run.ts's
// prompt loop) in headless Chromium, its `line` requests answered from a script the test gives and its `out` bodies
// read whole by the page's side (web/term-prompt-wire.ts), every operation recorded in order.  Checks:
// - a session: assignment, a continued `for`, a traceback, a workspace file, the prompts (>>>, ...), EOF → 0;
// - input(): its own prompt sent by `out` first, then `line` {kind: "input"}; its answer returned;
// - Ctrl+C as answers (r1b §2): a continuation dropped whole, back to ps1; input() unwound by KeyboardInterrupt;
// - Ctrl+C while a statement runs (the interrupt flag only): its KeyboardInterrupt, then the prompt goes on, 1+1 is 2;
// - Stop while waiting for a line, and while a statement runs: 130, the channel CANCELLED;
// - exit(3) → 3, and any SystemExit leaves with its status (exit(1), exit("bye"), sys.exit(0)); a ValueError keeps
//   the prompt; MATLAB's exit(4) → 4; Sage's prompt and preparser; Magma's prompt;
// - more than 4096 alternating one-byte writes: several `out` requests, no `line` between them, all of it in order;
// - what an input has left, in each request (small bounds): bytes with a newline each, and lines; a continuation with
//   none left refused by the worker, never asked; an answer of exactly room - 1 bytes taken, one byte more stops the
//   prompt unrun; input()'s own bound; each statement's output counted from nothing (after one past its IN);
// - a refusal answer: the line, then ps1 again; a forged answer: the prompt stops, 1, its reason.
//   bun web/build.ts, then node web/test-term-prompt-worker.mjs
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { devtoolsPort } from "./test-port.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "sb-term-prompt-"));
// (the page's side: the channel and the prompt's wire checks, as a script the page evaluates)
const entry = join(tmp, "entry.ts");
writeFileSync(entry, `import * as S from ${JSON.stringify(join(here, "term-sync.ts"))};\nimport * as W from ${JSON.stringify(join(here, "term-prompt-wire.ts"))};\n(globalThis as any).TermSync = S;\n(globalThis as any).PromptWire = W;\n`);
execFileSync("bun", ["build", entry, "--target=browser", "--format=iife", `--outfile=${join(tmp, "ts.js")}`], { stdio: ["ignore", "ignore", "inherit"] });
const pageSide = readFileSync(join(tmp, "ts.js"), "utf8");
const serve = spawn("python3", [join(here, "serve.py"), "0"], { stdio: ["ignore", "pipe", "inherit"] });
const port = await new Promise((r) => serve.stdout.once("data", (d) => r(Number(String(d).trim().split(/\s+/).pop()))));
const profile = join(tmp, "profile");
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--password-store=basic", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const cdp = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) {
  try {
    targets = await (await fetch(`http://127.0.0.1:${cdp}/json`)).json();
    break;
  } catch {
    await sleep(100);
  }
}
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0;
const waiting = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) {
    waiting.get(m.id)(m.result ?? m.error);
    waiting.delete(m.id);
  }
};
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 600));
  return r.result?.value;
};
const fails = [];
const check = (ok, what) => {
  console.log((ok ? "ok   " : "FAIL ") + what);
  if (!ok) fails.push(what);
};

// One prompt in a fresh worker.  `script`: the answers to its `line` requests, in order: {line} | {eof} | {interrupt}
// | {refused} | {hold: true} (never answered) | {forged: <any JSON>}; an entry's `ctrlcAfterMs` sets the interrupt flag
// that long after the answer (a Ctrl+C while the next statement runs), `stopAfterMs` also cancels the channel (a Stop).
// The result: the status, the events in order (["out", fd, text] | ["line", kind, cont, prompt]) and the screen text.
const harness = `(() => {
  const enc = new TextEncoder();
  let fid = 1;
  window.WS = new Map();
  window.put = (p, text) => window.WS.set(p, { fid: "f" + fid++, rev: 1, bytes: enc.encode(text) });
  window.prompt1 = (plan, script, { bounds = { sourceBytes: 1 << 20, lines: 10000, inBytes: 1 << 20, reserve: 65536 }, allowance = 64 << 20, readDelayMs = 0 } = {}) => new Promise((res) => {
    const w = new Worker("sagebrush-worker.js", { type: "module" });
    const err = (code, message) => ({ error: { code, message } });
    const events = [];
    let intr = null, outs = 0;
    const handler = async (h) => {
      const a = h.args, f = window.WS.get(a.path);
      if (h.op === "out") {
        const args = PromptWire.outArgs(a, h.length, allowance);
        if (!args) return err("EPROTO", "an out that isn't the protocol's");
        return { admit: async (body) => {
          const segs = PromptWire.decodeSegments(body, args.segs);
          if (!segs) return err("EPROTO", "an out body that isn't the protocol's");
          outs++;
          for (const s of segs) events.push(["out", s.fd, s.text]);
          return { json: { ok: true } };
        } };
      }
      if (h.op === "line") {
        const la = PromptWire.lineArgs(a, h.length, bounds);
        if (!la) return err("EPROTO", "a line that isn't the protocol's");
        events.push(["line", la.kind, la.cont, la.prompt, la.bytes, la.lines]);
        const next = script.shift() ?? { eof: true };
        if (next.stopAfterMs !== undefined) setTimeout(() => { Atomics.or(new Int32Array(intr), 0, 1); page.cancel(); }, next.stopAfterMs);
        if (next.hold) return new Promise(() => {});
        if (next.ctrlcAfterMs !== undefined) setTimeout(() => { Atomics.or(new Int32Array(intr), 0, 1); if (next.stop) page.cancel(); }, next.ctrlcAfterMs);
        if (next.forged !== undefined) return { json: next.forged };
        const { ctrlcAfterMs, stopAfterMs, stop, ...answer } = next;
        if (Object.keys(answer).length === 0) return new Promise(() => {});
        return { json: answer };
      }
      if (h.op === "stat") return f ? { json: { kind: "file", size: f.bytes.length, mtime: 1, fid: f.fid, rev: f.rev } } : err("ENOENT", a.path + ": No such file or directory");
      if (h.op === "open") return f ? { json: { fid: f.fid, rev: f.rev, size: f.bytes.length } } : err("ENOENT", a.path + ": No such file or directory");
      if (h.op === "read") {
        // (a read the page holds a while: a Ctrl+C during it is deferred to the read's end, r1b §3)
        if (readDelayMs) { events.push(["read-held"]); await new Promise((r) => setTimeout(r, readDelayMs)); events.push(["read-answered"]); }
        const g = [...window.WS.values()].find((x) => x.fid === a.fid); return g ? { bytes: g.bytes.slice(a.pos, a.pos + a.max) } : err("EBADF", "gone");
      }
      return err("EINVAL", "op " + h.op);
    };
    const page = new TermSync.PageChannel(1, handler);
    w.onmessage = (e) => {
      const m = e.data;
      if (m.ready) intr = m.interrupt;
      if (m.fsSync || m.fsMore) { page.onMessage(m).catch((x) => { events.push(["protocol", String(x?.message ?? x)]); page.cancel(); }); return; }
      if (m.termDone || m.termRefused) {
        w.terminate();
        const screen = events.map((x) => x[0] === "out" ? x[2] : x[0] === "line" ? x[3] : "").join("");
        res({ ...(m.termDone ?? { refused: m.termRefused }), events, outs, screen, state: Atomics.load(new Int32Array(page.control), 0) });
      }
    };
    setTimeout(() => { w.terminate(); res({ timeout: true, events }); }, 90000);
    w.postMessage({ init: { limits: null } });
    w.postMessage({ term: { gen: 1, plan, cwd: "/w", stdin: new Uint8Array(0), env: { COLUMNS: 100, LINES: 30 }, out: { allowance, backstop: 32 << 20 }, sync: { control: page.control, data: page.data }, prompt: bounds } });
  });
  return true;
})()`;
const plan = (mode, argv0 = mode, extra = {}) => ({ run: true, mode, argv0, source: { kind: "prompt" }, argv: [""], path0: mode === "magma" ? "/w" : "", ...extra });
const run = (p, script, opts = {}) => ev(`prompt1(${JSON.stringify(p)}, ${JSON.stringify(script)}, ${JSON.stringify(opts)})`);
const lines = (r) => r.events.filter((e) => e[0] === "line");
const outText = (r, fd) => r.events.filter((e) => e[0] === "out" && (fd === undefined || e[1] === fd)).map((e) => e[2]).join("");

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
  await sleep(1500);
  check((await ev("self.crossOriginIsolated")) === true, "the page is cross-origin isolated (SharedArrayBuffer)");
  await ev(pageSide);
  await ev(harness);
  await ev(`put("/w/a.txt", "hello from the workspace")`);

  // ---- a session
  let r = await run(plan("python", "python3"), [{ line: "x = 2**10" }, { line: "for i in range(3):" }, { line: "    print(i, x)" }, { line: "" }, { line: "1/0" }, { line: "open('/w/a.txt').read()" }, { eof: true }]);
  check(r.code === 0 && r.state === 0, `EOF: status 0, the channel idle (${JSON.stringify({ code: r.code, state: r.state, timeout: r.timeout })})`);
  check(/^Python, in a session of its own \(not any notebook's\), with your workspace's files\.\n/.test(r.screen) && /Ctrl\+D or exit\(\) leaves; Ctrl\+C interrupts\.\n/.test(r.screen), `the banner, then the keys line (${JSON.stringify(r.screen?.slice(0, 120))})`);
  check(outText(r, 1).includes("0 1024\n1 1024\n2 1024\n") && outText(r, 1).includes("'hello from the workspace'\n"), `a continued for, then the workspace's file read (${JSON.stringify(outText(r, 1).slice(-120))})`);
  check(/ZeroDivisionError: division by zero\n/.test(outText(r, 2)), "a traceback on stderr, and the prompt goes on");
  check(JSON.stringify(lines(r).map((e) => e[3])) === JSON.stringify([">>> ", ">>> ", "... ", "... ", ">>> ", ">>> ", ">>> "]) && lines(r).every((e) => e[1] === "prompt") && lines(r)[2][2] === true && lines(r)[1][2] === false, `the prompts and cont, as asked (${JSON.stringify(lines(r))})`);
  // (output always flushed before the next line request: no line between a statement's outs and its end)
  const order = r.events.map((e) => e[0]).join(",");
  check(!/line,line,line,line,line,line,line/.test(order) && order.startsWith("out"), `out before line (${order.slice(0, 120)})`);

  // ---- input()
  r = await run(plan("python"), [{ line: "name = input('who? ')" }, { line: "Ada" }, { line: "print('hi', name)" }, { eof: true }]);
  const iIn = r.events.findIndex((e) => e[0] === "line" && e[1] === "input");
  check(iIn > 0 && r.events.slice(0, iIn).some((e) => e[0] === "out" && e[2].endsWith("who? ")) && outText(r, 1).includes("hi Ada\n"), `input(): its prompt sent by out first, then line {kind: input}; the answer returned (${JSON.stringify(r.events.slice(Math.max(0, iIn - 2), iIn + 1))})`);

  // ---- Ctrl+C as answers (r1b §2)
  r = await run(plan("python"), [{ line: "for i in range(3):" }, { interrupt: true }, { line: "print(5)" }, { eof: true }]);
  check(/KeyboardInterrupt\n/.test(outText(r, 2)) && outText(r, 1).includes("5\n") && lines(r)[2][3] === ">>> " && lines(r)[2][2] === false, `a continuation interrupted: dropped whole, back to ps1 (${JSON.stringify(lines(r))})`);
  r = await run(plan("python"), [{ line: "input()" }, { interrupt: true }, { line: "print(1+1)" }, { eof: true }]);
  check(/KeyboardInterrupt/.test(outText(r, 2)) && /Traceback/.test(outText(r, 2)) && outText(r, 1).includes("2\n") && r.code === 0, `input() interrupted: KeyboardInterrupt unwinds the statement; the prompt goes on (${JSON.stringify(outText(r, 2).slice(-160))})`);

  // ---- Ctrl+C while a statement runs (the flag only), then 1+1
  r = await run(plan("python"), [{ line: "while True: pass", ctrlcAfterMs: 400 }, { line: "print(1+1)" }, { eof: true }]);
  check(/KeyboardInterrupt/.test(outText(r, 2)) && outText(r, 1).includes("2\n") && r.code === 0, `Ctrl+C mid-statement: its KeyboardInterrupt, the flag cleared, then 1+1 prints 2 (${JSON.stringify({ code: r.code, err: outText(r, 2).slice(-120) })})`);

  // ---- Stop: waiting for a line, and while a statement runs
  r = await run(plan("python"), [{ hold: true, stopAfterMs: 300 }]);
  check(r.code === 130 && r.state === 6, `Stop while waiting for a line: 130, CANCELLED (${JSON.stringify({ code: r.code, state: r.state })})`);
  r = await run(plan("python"), [{ line: "while True: pass", stopAfterMs: 400 }, { line: "print('never')" }]);
  check(r.code === 130 && !outText(r, 1).includes("never"), `Stop mid-statement: 130, the prompt ends, nothing after (${JSON.stringify({ code: r.code })})`);

  // ---- exit statuses; Sage, MATLAB, Magma
  r = await run(plan("python"), [{ line: "exit(3)" }]);
  check(r.code === 3, `exit(3): 3 (${JSON.stringify({ code: r.code, screen: r.screen?.slice(-200) })})`);
  // (any SystemExit leaves, its status an error's too, as CPython's prompt: never asked for the next line)
  r = await run(plan("python"), [{ line: "exit(1)" }, { line: "print('after')" }, { eof: true }]);
  check(r.code === 1 && lines(r).length === 1 && !outText(r).includes("after"), `exit(1): 1, the prompt left (${JSON.stringify({ code: r.code, lines: lines(r).length })})`);
  r = await run(plan("python"), [{ line: "exit('bye')" }, { line: "print('after')" }, { eof: true }]);
  check(r.code === 1 && outText(r, 2).includes("bye\n") && lines(r).length === 1, `exit("bye"): bye on stderr, 1, the prompt left (${JSON.stringify({ code: r.code, err: outText(r, 2).slice(-40) })})`);
  r = await run(plan("python"), [{ line: "import sys" }, { line: "sys.exit(0)" }, { line: "print('after')" }, { eof: true }]);
  check(r.code === 0 && lines(r).length === 2, `sys.exit(0): 0, the prompt left (${JSON.stringify({ code: r.code, lines: lines(r).length })})`);
  r = await run(plan("python"), [{ line: "raise ValueError('v')" }, { line: "print('still')" }, { eof: true }]);
  check(r.code === 0 && outText(r, 2).includes("ValueError: v") && outText(r, 1).includes("still"), `a raised ValueError: its traceback, and the prompt goes on (${JSON.stringify({ code: r.code })})`);
  r = await run(plan("sage"), [{ line: "factor(2^10 - 1)" }, { eof: true }]);
  check(outText(r, 1).includes("3 * 11 * 31") && lines(r)[0][3] === "sage: ", `Sage: its prompt, its preparser (${JSON.stringify(outText(r, 1).slice(-60))})`);
  r = await run(plan("matlab"), [{ line: "x = 3 * 4;" }, { line: "disp(x)" }, { line: "exit(4)" }]);
  check(r.code === 4 && outText(r, 1).includes("12") && lines(r)[0][3] === ">> ", `MATLAB: >>, disp, exit(4) → 4 (${JSON.stringify({ code: r.code, out: outText(r, 1).slice(-40) })})`);
  r = await run(plan("magma"), [{ line: "x := 2^10;" }, { line: "x;" }, { eof: true }]);
  check(outText(r, 1).includes("1024") && lines(r)[0][3] === "> ", `Magma: >, a statement and its value (${JSON.stringify(outText(r, 1).slice(-40))})`);

  // ---- many tiny writes: forced outs, no line between them, in order
  r = await run(plan("python"), [{ line: "import sys" }, { line: "for i in range(5000): print('a', end='', flush=True); print('b', end='', file=sys.stderr, flush=True)" }, { line: "" }, { eof: true }]);
  const big = r.events.findIndex((e) => e[0] === "out" && e[2] === "a");
  const seq = r.events.slice(big);
  const firstLine = seq.findIndex((e) => e[0] === "line");
  const body = seq.slice(0, firstLine).filter((e) => e[0] === "out").map((e) => e[2]).join("");
  check(r.outs >= 4 && firstLine > 4096 && body === "ab".repeat(5000), `10,000 alternating writes: ${r.outs} outs, no line until the statement ends, in order (${body.length})`);

  // ---- five Ctrl+Cs during engine calls, then an engine call: its answer (or the memory guard's MemoryError), never a
  // hang or another error; a non-engine statement after it works either way
  {
    const spin = "while True: factor(next_prime(2^150) * next_prime(2^160))";
    const script = [];
    for (let i = 0; i < 5; i++) script.push({ line: spin, ctrlcAfterMs: 700 });
    script.push({ line: "print(factor(2^64 - 1))" }, { line: "print('after', 1 + 1)" }, { eof: true });
    r = await run(plan("sage"), script);
    const kis = (outText(r, 2).match(/KeyboardInterrupt/g) ?? []).length;
    const answered = outText(r, 1).includes("3 * 5 * 17 * 257 * 641 * 65537 * 6700417\n");
    const guarded = /MemoryError/.test(outText(r, 2).split("KeyboardInterrupt").pop() ?? "");
    check(r.code === 0 && kis === 5 && (answered || guarded) && outText(r, 1).includes("after 2\n") && !/RuntimeError|SystemError|internal error/.test(outText(r, 2)),
      `five Ctrl+Cs during engine calls, then one: ${answered ? "its answer" : guarded ? "MemoryError" : "NEITHER"} (${JSON.stringify({ code: r.code, kis, tail: outText(r, 2).slice(-160), timeout: r.timeout })})`);
  }

  // ---- a Ctrl+C while the page holds a file read: the read is answered whole, then KeyboardInterrupt; the prompt goes on
  r = await run(plan("python"), [{ line: "print(len(open('/w/a.txt').read())); print('after the read')", ctrlcAfterMs: 300 }, { line: "print(1 + 1)" }, { eof: true }], { readDelayMs: 1500 });
  {
    const held = r.events.findIndex((e) => e[0] === "read-held"), answered = r.events.findIndex((e) => e[0] === "read-answered");
    const ki = r.events.findIndex((e) => e[0] === "out" && /KeyboardInterrupt/.test(e[2]));
    check(held >= 0 && answered > held && ki > answered && outText(r, 1).includes("2\n") && r.code === 0,
      `Ctrl+C during a held read: deferred, the read answered first, then KeyboardInterrupt, then 1+1 (${JSON.stringify({ held, answered, ki, code: r.code, out: outText(r, 1).slice(-60) })})`);
  }

  // ---- a refusal answer; a forged answer
  // ---- what an input has left (r1 §7.1), small bounds: each request says it; a continuation with no line left is
  // refused by the worker itself, never asked, and the next statement has the whole bounds again
  {
    const bounds = { sourceBytes: 32, lines: 3, inBytes: 1 << 20, reserve: 65536 };
    r = await run(plan("python"), [{ line: "if True:" }, { line: "  x = 1" }, { line: "  y = 2" }, { line: "1+1" }, { eof: true }], { bounds });
    const asked = lines(r).map((e) => [e[2], e[4], e[5]]);
    check(JSON.stringify(asked.slice(0, 3)) === JSON.stringify([[false, 32, 3], [true, 23, 2], [true, 15, 1]]), `each request says what is left: bytes (a newline each) and lines (${JSON.stringify(asked)})`);
    check(/input too long \(the limit is 32 bytes, 3 lines\)/.test(outText(r, 2)) && asked[3]?.[0] === false && asked[3][1] === 32 && asked[3][2] === 3 && outText(r, 1).includes("2\n") && r.code === 0, `no line left: refused by the worker, the input dropped whole, never asked with nothing left; then 1+1 is 2 (${JSON.stringify({ asked, err: outText(r, 2).slice(-80) })})`);
    r = await run(plan("python"), [{ line: "if True:" }, { line: "  x = " + "1".repeat(20) }, { eof: true }], { bounds });
    check(r.code === 1 && /the prompt stopped: .*isn't one/.test(r.stderr ?? ""), `an answer past what the request said is left: the prompt stops, 1 (the page refuses such a line itself) (${JSON.stringify({ code: r.code, stderr: r.stderr })})`);
    // (the answer's bound exactly: a line of room - 1 bytes is taken and runs; one byte more stops the prompt, unrun)
    r = await run(plan("python"), [{ line: "x = '" + "a".repeat(25) + "'" }, { line: "len(x)" }, { eof: true }], { bounds });
    check(r.code === 0 && outText(r, 1).includes("25\n"), `a first line of exactly 31 bytes (32 left, a newline's byte kept): taken and run (${JSON.stringify({ code: r.code, out: outText(r, 1).slice(-20) })})`);
    r = await run(plan("python"), [{ line: "print('" + "b".repeat(23) + "')" }, { line: "print('after')" }, { eof: true }], { bounds });
    check(r.code === 1 && /the prompt stopped: .*isn't one/.test(r.stderr ?? "") && !outText(r, 1).includes("bbb") && !outText(r, 1).includes("after"), `one byte past what the request said (32 of 32): the prompt stops, 1, the line never run (${JSON.stringify({ code: r.code, stderr: r.stderr, out: outText(r, 1).slice(-40) })})`);
    r = await run(plan("python"), [{ line: "s = input()" }, { line: "x".repeat(31) }, { line: "len(s)" }, { eof: true }], { bounds });
    const inp = lines(r).find((e) => e[1] === "input");
    check(inp?.[4] === 33 && inp[5] === 1 && outText(r, 1).includes("31\n"), `input(): its own one line of up to sourceBytes, not the statement's (${JSON.stringify(inp)})`);
  }
  // ---- each statement's output counted from nothing: one that fills its IN (the omitted line), then print(1) shows
  {
    const bounds = { sourceBytes: 1 << 20, lines: 10000, inBytes: 1024, reserve: 64 };
    r = await run(plan("python"), [{ line: "print('a' * 3000)" }, { line: "print(1)" }, { eof: true }], { bounds });
    const all = outText(r);
    const cut = all.lastIndexOf("bytes of output omitted");
    check(cut > 0 && /\n1\n/.test(all.slice(cut)) && !/omitted[^]*omitted/.test(all), `a statement past its IN: the omitted line, then the next statement's output in full (${JSON.stringify(all.slice(-120))})`);
  }
  r = await run(plan("python"), [{ refused: "too-long" }, { line: "print(7)" }, { eof: true }]);
  check(/input too long/.test(outText(r, 2)) && outText(r, 1).includes("7\n") && r.code === 0, "a refusal: its line, then ps1 again");
  // (a fault in an answer to input(), inside code that catches everything: the prompt still stops when it returns)
  r = await run(plan("python"), [{ line: "try:" }, { line: "  input()" }, { line: "except BaseException:" }, { line: "  print('caught')" }, { line: "" }, { forged: { line: "1", eof: true } }, { line: "print('after')" }, { eof: true }]);
  check(r.code === 1 && /the prompt stopped: .*isn't one/.test(r.stderr ?? "") && !outText(r, 1).includes("caught") && !outText(r, 1).includes("after"), `a forged answer to input(), its error caught by the code: no output reaches the page after it, the prompt stops, 1 (${JSON.stringify({ code: r.code, stderr: r.stderr, out: outText(r, 1).slice(-40) })})`);
  // (the same, the code printing nothing after it: the next prompt's line request is what ends it)
  r = await run(plan("python"), [{ line: "try:" }, { line: "  input()" }, { line: "except BaseException:" }, { line: "  pass" }, { line: "" }, { forged: { line: "1", eof: true } }, { line: "print('after')" }, { eof: true }]);
  check(r.code === 1 && /the prompt stopped: .*isn't one/.test(r.stderr ?? "") && !outText(r, 1).includes("after") && lines(r).length === 6, `...and with nothing printed after it: the next line is never asked, 1 (${JSON.stringify({ code: r.code, asked: lines(r).length, out: outText(r, 1).slice(-40) })})`);
  r = await run(plan("python"), [{ forged: { line: "1", eof: true } }]);
  check(r.code === 1 && /the prompt stopped: /.test(r.stderr ?? ""), `a forged answer: the prompt stops, 1, its reason (${JSON.stringify({ code: r.code, stderr: r.stderr })})`);
} catch (e) {
  check(false, "the test ran: " + (e?.stack ?? e));
} finally {
  chrome.kill();
  serve.kill();
  await sleep(200);
  rmSync(tmp, { recursive: true, force: true });
}
console.log(fails.length ? `${fails.length} FAILED` : "all ok");
process.exit(fails.length ? 1 : 0);
