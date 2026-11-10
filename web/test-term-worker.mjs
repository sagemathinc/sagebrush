// ci: web-runner order=124 chrome
// A Terminal command in the browser's worker (PR 3a (b1); design r4): the built worker (web/worker.ts's {term} entry,
// web/term-run.ts) in headless Chromium, its files answered by the page's side of the file channel
// (web/term-sync.ts PageChannel) from a workspace kept in the page, as part (b2)'s ShellHost will.  Checks:
// - python -c and python FILE: sys.argv, sys.path[0], __file__, -B; output and status as CPython's;
// - the exit paths: 0, an uncaught exception (1, the traceback on stderr), SystemExit(3), SystemExit("text"), 130;
// - FILE missing: CPython's "can't open file" line naming the workspace path, status 2;
// - files live: read from the page, written through it (committed before the program goes on); a refused write is
//   the program's PermissionError, and the page's file is unchanged;
// - stdin: the finite bytes, read by sys.stdin and input() (the prompt written, the line not echoed), then EOF;
// - Stop while the program waits on the page: KeyboardInterrupt, status 130, the channel CANCELLED;
// - output past its allowance: cut, counted, `exceeded`.
//   bun web/build.ts, then node web/test-term-worker.mjs
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { devtoolsPort } from "./test-port.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(join(tmpdir(), "sb-term-worker-"));
// (the page's side of the channel, as a script the page evaluates: window.TermSync)
const entry = join(tmp, "entry.ts");
writeFileSync(entry, `import * as S from ${JSON.stringify(join(here, "term-sync.ts"))};\n(globalThis as any).TermSync = S;\n`);
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

// The page's workspace and one command: a fresh worker per command, its file channel answered from window.WS
// (path -> {fid, rev, bytes}); `opts.refuse` ops answered EACCES; `opts.hold` ops never answered (until Stop).
const harness = `(() => {
  const enc = new TextEncoder();
  let fid = 1;
  window.WS = new Map();
  window.put = (p, text) => window.WS.set(p, { fid: "f" + fid++, rev: 1, bytes: enc.encode(text) });
  window.text = (p) => window.WS.has(p) ? new TextDecoder().decode(window.WS.get(p).bytes) : null;
  window.command = (plan, { stdin = "", refuse = [], hold = [], stopAfterMs = null, allowance = 1 << 20 } = {}) => new Promise((res) => {
    const w = new Worker("sagebrush-worker.js", { type: "module" });
    const err = (code, message) => ({ error: { code, message } });
    const handler = async (h) => {
      const a = h.args, f = window.WS.get(a.path);
      if (hold.includes(h.op)) return new Promise(() => {});
      if (refuse.includes(h.op)) return err("EACCES", a.path + ": Permission denied");
      if (h.op === "stat") return f ? { json: { kind: "file", size: f.bytes.length, mtime: 1, fid: f.fid, rev: f.rev } } : (a.path === "/" || a.path === "/w") ? { json: { kind: "folder", size: 0, mtime: 1, fid: "d" + a.path, rev: 0 } } : err("ENOENT", a.path + ": No such file or directory");
      if (h.op === "open") return f ? { json: { fid: f.fid, rev: f.rev, size: f.bytes.length } } : err("ENOENT", a.path + ": No such file or directory");
      if (h.op === "openw") { if (!f) window.WS.set(a.path, { fid: "f" + fid++, rev: 1, bytes: new Uint8Array(0) }); const g = window.WS.get(a.path); if (a.trunc) { g.bytes = new Uint8Array(0); g.rev++; } return { json: { fid: g.fid, rev: g.rev } }; }
      if (h.op === "read") { const g = [...window.WS.values()].find((x) => x.fid === a.fid); return g ? { bytes: g.bytes.slice(a.pos, a.pos + a.max) } : err("EBADF", "the file was removed"); }
      if (h.op === "list") return a.path === "/" || a.path === "/w" ? { json: [...window.WS.keys()].filter((k) => k.startsWith(a.path === "/" ? "/" : a.path + "/")).map((k) => k.slice(a.path === "/" ? 1 : a.path.length + 1).split("/")[0]) } : f ? err("ENOTDIR", a.path + ": Not a directory") : err("ENOENT", a.path + ": No such file or directory");
      if (h.op === "write") return { admit: async (body) => {
        let g = a.fid ? [...window.WS.values()].find((x) => x.fid === a.fid) : window.WS.get(a.path);
        if (!g) { window.WS.set(a.path, { fid: "f" + fid++, rev: 0, bytes: new Uint8Array(0) }); g = window.WS.get(a.path); }
        if (a.mode === "at" && g.rev !== a.rev) return err("ECONFLICT", a.path + ": changed elsewhere");
        const base = a.mode === "replace" ? new Uint8Array(0) : g.bytes;
        const at = a.mode === "append" ? base.length : a.mode === "at" ? a.pos : 0;
        const out = new Uint8Array(Math.max(base.length, at + body.length)); out.set(base); out.set(body, at);
        g.bytes = out; g.rev++;
        return { json: { fid: g.fid, rev: g.rev, size: out.length } };
      } };
      return err("EINVAL", "op " + h.op);
    };
    const page = new TermSync.PageChannel(1, handler);
    window.lastPage = page;
    const t0 = performance.now();
    w.onmessage = (e) => {
      const m = e.data;
      if (m.fsSync || m.fsMore) { page.onMessage(m).catch((x) => console.error(x)); return; }
      if (m.termDone || m.termRefused) { w.terminate(); res({ ...(m.termDone ?? { refused: m.termRefused }), ms: performance.now() - t0, state: Atomics.load(new Int32Array(page.control), 0) }); }
    };
    if (stopAfterMs !== null) setTimeout(() => page.cancel(), stopAfterMs);
    // (a command that never answers: reported, never a hang)
    setTimeout(() => { w.terminate(); res({ timeout: true, log: window.lastLog ?? null }); }, 90000);
    window.lastLog = [];
    const onm = w.onmessage;
    w.onmessage = (e) => { if (e.data?.libLoading !== undefined || e.data?.termRefused || e.data?.initFailed) window.lastLog.push(JSON.stringify(e.data).slice(0, 200)); onm(e); };
    w.postMessage({ init: { limits: null } });
    w.postMessage({ term: { gen: 1, plan, cwd: "/w", stdin: enc.encode(stdin), env: { COLUMNS: 100, LINES: 30 }, out: { allowance, backstop: 32 << 20 }, sync: { control: page.control, data: page.data } } });
  });
  return true;
})()`;
const py = (source, argv, path0 = "", extra = {}) => ({ run: true, mode: "python", argv0: "python", source, argv, path0, ...extra });
const cmd = (plan, opts = {}) => ev(`command(${JSON.stringify(plan)}, ${JSON.stringify(opts)})`);

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
  await sleep(1500);
  check((await ev("self.crossOriginIsolated")) === true, "the page is cross-origin isolated (SharedArrayBuffer)");
  await ev(pageSide);
  await ev(harness);

  // ---- -c and FILE
  let r = await cmd(py({ kind: "code", code: "import sys, os\nprint('hi', sys.argv, repr(sys.path[0]), os.getcwd(), sys.dont_write_bytecode)" }, ["-c", "x y"], "", { noBytecode: true }));
  check(r.code === 0 && r.stdout === "hi ['-c', 'x y'] '' /w True\n" && r.stderr === "", `python -c: argv, sys.path[0], cwd, -B (${JSON.stringify(r)})`);
  await ev(`put("/w/a.py", "import sys\\nprint(__file__, sys.argv, sys.path[0])\\nprint(open('/w/in.txt').read().upper(), end='')\\nopen('/w/out.txt', 'w').write('written')\\n")`);
  await ev(`put("/w/in.txt", "from the page\\n")`);
  r = await cmd(py({ kind: "file", path: "/w/a.py", shown: "/w/a.py", typed: "a.py" }, ["a.py", "1"], "/w"));
  check(r.code === 0 && r.stdout === "/w/a.py ['a.py', '1'] /w\nFROM THE PAGE\n" && (await ev(`text("/w/out.txt")`)) === "written", `python FILE: __file__, argv, sys.path[0]; a file read from the page and one written through it (${JSON.stringify(r).slice(0, 300)})`);

  // ---- exit paths
  r = await cmd(py({ kind: "code", code: "1/0" }, ["-c"]));
  check(r.code === 1 && /ZeroDivisionError: division by zero\n$/.test(r.stderr), `an uncaught exception: 1, the traceback on stderr (${JSON.stringify(r.stderr.slice(-80))})`);
  r = await cmd(py({ kind: "code", code: "raise SystemExit(3)" }, ["-c"]));
  check(r.code === 3 && r.stderr === "", "SystemExit(3): 3");
  r = await cmd(py({ kind: "code", code: "raise SystemExit('bye')" }, ["-c"]));
  check(r.code === 1 && r.stderr === "bye\n", "SystemExit('bye'): the text, and 1");
  r = await cmd(py({ kind: "file", path: "/w/nofile.py", shown: "/w/nofile.py", typed: "nofile.py" }, ["nofile.py"], "/w"));
  check(r.code === 2 && r.stderr === "python: can't open file '/w/nofile.py': [Errno 2] No such file or directory\n", `FILE missing: CPython's line, the workspace path, 2 (${JSON.stringify(r.stderr)})`);

  // ---- a refused write
  await ev(`put("/w/keep.txt", "kept")`);
  r = await cmd(py({ kind: "code", code: "open('/w/keep.txt', 'w').write('lost')" }, ["-c"]), { refuse: ["openw", "write"] });
  check(r.code === 1 && /PermissionError/.test(r.stderr) && (await ev(`text("/w/keep.txt")`)) === "kept", `a refused write: the program's PermissionError, the page's file unchanged (${JSON.stringify(r.stderr.slice(-120))})`);

  // ---- stdin
  r = await cmd(py({ kind: "code", code: "import sys\nx = input('name? ')\nprint('got', x)\nprint(repr(sys.stdin.read()))\ntry:\n    input()\nexcept EOFError as e:\n    print('EOF', e)" }, ["-c"]), { stdin: "ann\nrest\n" });
  check(r.code === 0 && r.stdout === "name? got ann\n'rest\\n'\nEOF EOF when reading a line\n", `stdin: input() reads a line, not echoed; sys.stdin the rest; then EOF (${JSON.stringify(r.stdout)})`);
  r = await cmd(py({ kind: "stdin" }, [""]), { stdin: "print(6*7)\n" });
  check(r.code === 0 && r.stdout === "42\n", "a program on stdin runs");

  // ---- Stop while the program waits on the page
  r = await cmd(py({ kind: "code", code: "open('/w/in.txt').read()" }, ["-c"]), { hold: ["open"], stopAfterMs: 500 });
  check(r.code === 130 && /KeyboardInterrupt/.test(r.stderr) && r.state === 6, `Stop while a file request waits: KeyboardInterrupt, 130, the channel CANCELLED (${JSON.stringify({ code: r.code, state: r.state, err: r.stderr?.slice(-60) })})`);
  // (every way into the file system: the interrupt is never turned into an OSError, nor caught as a quiet False)
  for (const [op, code] of [["stat", "import os\nos.path.exists('/w/in.txt')"], ["list", "import os\nos.listdir('/w')"], ["write", "open('/w/z.txt', 'w').write('z')"], ["openw", "import os\nos.open('/w/q', os.O_WRONLY | os.O_CREAT)"], ["read", "import pathlib\npathlib.Path('/w/in.txt').read_text()"]]) {
    r = await cmd(py({ kind: "code", code }, ["-c"]), { hold: [op], stopAfterMs: 400 });
    check(r.code === 130 && /KeyboardInterrupt\n$/.test(r.stderr), `Stop while a ${op} request waits: KeyboardInterrupt, 130 (${JSON.stringify({ code: r.code, err: r.stderr?.slice(-70) })})`);
  }

  // ---- the other modes: Sage (preparsed), MATLAB (-batch), Magma (stdin a session, status 0 after an error)
  r = await cmd({ run: true, mode: "sage", argv0: "sage", source: { kind: "code", code: "print(2^10, factor(60))" }, argv: ["-c"], path0: "" });
  check(r.code === 0 && r.stdout === "1024 2^2 * 3 * 5\n", `sage -c: preparsed, Sage's own (${JSON.stringify(r).slice(0, 600)})`);
  r = await cmd({ run: true, mode: "matlab", argv0: "matlab", source: { kind: "code", code: "x = [1 2 3]; disp(sum(x))" }, argv: [], path0: "" });
  check(r.code === 0 && r.stdout.trim() === "6", `matlab -batch: runs, 0 (${JSON.stringify({ code: r.code, out: r.stdout, errTail: (r.stderr ?? "").slice(-500) })})`);
  r = await cmd({ run: true, mode: "matlab", argv0: "matlab", source: { kind: "code", code: "error('boom')" }, argv: [], path0: "" });
  check(r.code !== 0 && /boom/.test(r.stderr ?? ""), `matlab -batch with an error: not 0 (${JSON.stringify(r).slice(0, 300)})`);
  r = await cmd({ run: true, mode: "magma", argv0: "magma", source: { kind: "stdin" }, argv: [""], path0: "/w" }, { stdin: "print 2^10;\nprint undefined_thing;\nprint 3;\n" });
  check(r.code === 0 && /^1024\n/.test(r.stdout) && /3\n$/.test(r.stdout) && /not been declared/.test((r.stdout ?? "") + (r.stderr ?? "")), `magma on stdin: a session, an error reported and it goes on, status 0 (${JSON.stringify({ code: r.code, out: r.stdout, errTail: (r.stderr ?? "").slice(-500) })})`);

  // ---- output past its allowance
  r = await cmd(py({ kind: "code", code: "import sys\nprint('x' * 100)\nsys.stderr.write('e' * 50)" }, ["-c"]), { allowance: 64 });
  check(r.code === 0 && r.stdout === "x".repeat(64) && r.stderr === "" && r.output.producedBytes === 151 && r.output.exceeded === true, `output past its allowance: cut at it, counted, exceeded (${JSON.stringify(r.output)})`);
} catch (e) {
  check(false, "the test ran: " + String(e?.stack ?? e).slice(0, 600));
} finally {
  chrome.kill();
  serve.kill();
  await sleep(300);
  rmSync(tmp, { recursive: true, force: true });
}
console.log(fails.length ? `${fails.length} failed` : "all passed");
process.exit(fails.length ? 1 : 0);
