// The Terminal commands' page side (design-term-3b2 r1), run in the page by test-term-bridge.mjs.
import { startShell, ShellHost, STOP_GRACE_MS, TB, TS, W } from "/host-bundle.js";

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PERSON = { kind: "person" };
let D;
let nth = 0;

// A workspace of its own and a host over it whose commands run through the bridge (`opts`: the bridge's test options)
async function fresh(name, { bridgeOpts = {}, bash, wrap } = {}) {
  localStorage.clear();
  const ws = await W.Workspace.open({ name: `term-${name}-${++nth}`, mainName: `term-${name}-main-${nth}` });
  let b = null;
  const host = new ShellHost(wrap ? wrap(ws) : ws, (signal) => startShell(D.S, "/", { signal }).then((x) => x.shell), {
    ...(bash ? { bash } : {}),
    commands: async () => ({ bridge: () => (b = TB.bridge(bridgeOpts)) }),
    size: () => ({ cols: 100, rows: 30 }),
  });
  return { ws, host, bridge: () => b };
}
const put = (ws, p, s) => ws.create(p, { content: typeof s === "string" ? enc(s) : s });
const read = async (ws, p) => {
  try {
    return dec((await ws.readUpTo(p, 2 ** 24)).content);
  } catch (e) {
    if (e instanceof W.WorkspaceError && e.code === "missing") return null;
    throw e;
  }
};
const exec = (host, script, opts = {}) => host.exec(PERSON, script, opts);
const live = () => window.workers.live;
// (until `f()` holds, or `ms` passes)
async function until(f, ms = 20000) {
  const t = Date.now();
  while (!(await f()) && Date.now() - t < ms) await sleep(20);
  return !!(await f());
}

export async function run(only) {
  D = await (await fetch("/data.json")).json();
  const out = [];
  const check = (ok, what) => out.push([!!ok, what]);
  const groups = { smoke, schema, handler, races, writes, loop, ends, e2e, oracle };
  for (const [name, g] of Object.entries(groups)) {
    if (only && !only.split(",").includes(name)) continue;
    try {
      // (a group that hangs fails here, by name, instead of stopping the run)
      let timer;
      await Promise.race([g(check), new Promise((_, j) => (timer = setTimeout(() => j(new Error("the group didn't end within 120 s")), 120000)))]).finally(() => clearTimeout(timer));
    } catch (e) {
      check(false, `${name}: the cases threw: ${e?.constructor?.name}: ${e?.message}\n${e?.stack ?? ""}`.slice(0, 1500));
    }
  }
  return out;
}

// ---- end to end: a few commands through the real module, host, bridge and worker
async function smoke(check) {
  const { ws, host } = await fresh("smoke");
  let o = await exec(host, "python -c 'print(6*7)'");
  check(o.kind === "exit" && o.code === 0 && o.stdout === "42\n", `python -c: 42 (${JSON.stringify(o).slice(0, 300)})`);
  await ws.mkdir("/w");
  await put(ws, "/w/a.py", "import sys\nprint(open('in.txt').read().upper(), end='')\nopen('out.txt', 'w').write('written ' + sys.argv[1])\n");
  await put(ws, "/w/in.txt", "from the workspace\n");
  o = await exec(host, "cd /w && python a.py one");
  check(o.kind === "exit" && o.code === 0 && o.stdout === "FROM THE WORKSPACE\n" && (await read(ws, "/w/out.txt")) === "written one", `python FILE: reads and writes the workspace live (${JSON.stringify(o).slice(0, 300)})`);
  o = await exec(host, "echo 'print(sum(range(10)))' | python");
  check(o.kind === "exit" && o.stdout === "45\n", `a pipe into python (${JSON.stringify(o).slice(0, 300)})`);
  o = await exec(host, "python -c 'print(1); print(2)' | python -c 'import sys; print(len(sys.stdin.read().split()))'");
  check(o.kind === "exit" && o.stdout === "2\n", `python | python (${JSON.stringify(o).slice(0, 300)})`);
  check(await until(() => live() === 0, 5000), `no command worker left (${live()})`);
}

// ---- the operations' exact shapes (r1 §4.1): the merged worker's (web/shims/fs.ts), nothing else
async function schema(check) {
  const ok = (op, args, length) => TB.headerOk({ op, args, ...(length === undefined ? {} : { length }) });
  const good = [
    ["stat", { path: "/a" }], ["list", { path: "/" }], ["open", { path: "/a" }], ["read", { path: "/a", fid: "f1", pos: 0, max: 2 ** 31 - 1 }],
    ["openw", { path: "/a", create: true, trunc: false, excl: false }], ["access", { path: "/a", write: true }], ["mkdir", { path: "/a", recursive: false }],
    ["remove", { path: "/a", folder: null, recursive: true }], ["remove", { path: "/a", folder: false, recursive: false }], ["rename", { from: "/a", to: "/b" }],
    ["write", { path: "/a", mode: "replace" }, 3], ["write", { path: "/a", mode: "append" }, 0], ["write", { path: "/a", fid: "f1", mode: "append" }, 3], ["write", { path: "/a", fid: "f1", mode: "at", rev: 2, pos: 5 }, 3],
  ];
  check(good.every(([op, a, l]) => ok(op, a, l)), `every operation the worker sends, in its exact shape, is accepted (${good.filter(([op, a, l]) => !ok(op, a, l)).map(([op]) => op)})`);
  const bad = [
    ["an unknown op", "chmod", { path: "/a" }], ["an extra key", "stat", { path: "/a", x: 1 }], ["a missing key", "read", { path: "/a", fid: "f", pos: 0 }],
    ["a relative path", "stat", { path: "a" }], ["a path past PATH_MAX", "stat", { path: "/" + "x".repeat(4096) }], ["args an array", "stat", ["/a"]],
    ["a negative pos", "read", { path: "/a", fid: "f", pos: -1, max: 1 }], ["a fractional max", "read", { path: "/a", fid: "f", pos: 0, max: 1.5 }],
    ["max past the protocol cap", "read", { path: "/a", fid: "f", pos: 0, max: 2 ** 31 }], ["pos past 2^53", "read", { path: "/a", fid: "f", pos: 2 ** 53, max: 1 }],
    ["an empty fid", "read", { path: "/a", fid: "", pos: 0, max: 1 }], ["a string boolean", "openw", { path: "/a", create: "yes", trunc: false, excl: false }],
    ["access without write", "access", { path: "/a", write: false }], ["remove's folder a string", "remove", { path: "/a", folder: "no", recursive: false }],
    ["a write without a body", "write", { path: "/a", mode: "replace" }], ["a body on a stat", "stat", { path: "/a" }, 3],
    ["an unknown write mode", "write", { path: "/a", mode: "insert" }, 1], ["replace with a fid", "write", { path: "/a", fid: "f", mode: "replace" }, 1],
    ["at without its rev", "write", { path: "/a", fid: "f", mode: "at", pos: 0 }, 1], ["at without its fid", "write", { path: "/a", mode: "at", rev: 1, pos: 0 }, 1],
    ["at past 2^53", "write", { path: "/a", fid: "f", mode: "at", rev: 1, pos: 2 ** 53 - 2 }, 3], ["a negative length", "write", { path: "/a", mode: "replace" }, -1],
    ["a length past the cap", "write", { path: "/a", mode: "replace" }, 2 ** 31],
  ];
  const passed = bad.filter(([, op, a, l]) => ok(op, a, l)).map(([what]) => what);
  check(!passed.length, `malformed, negative, fractional, overflowing and extra-key headers are refused (${passed})`);
}

// A run of the person's (or `principal`), its port for invocation 0 and a handler over it
async function handlerOf(name, opts = {}) {
  const f = await fresh(name, opts);
  const run = f.host.run(opts.principal ?? PERSON);
  const port = run.commandPort(0);
  const h = TB.fileHandler(port);
  const call = (op, args, length) => h.handler({ op, args, ...(length === undefined ? {} : { length }) });
  return { ...f, run, port, h, call };
}
const err = (r) => r?.error?.code;

// ---- the handler: every operation against a real run (r1 §4.2)
async function handler(check) {
  const { ws, run, h, call } = await handlerOf("handler");
  await ws.mkdir("/w");
  await put(ws, "/w/a.txt", "hello world");
  let r = await call("stat", { path: "/w/a.txt" });
  const a = r.json;
  check(a?.kind === "file" && a.size === 11 && typeof a.fid === "string" && a.rev >= 0, `stat: kind, size, fid and rev (${JSON.stringify(r)})`);
  r = await call("stat", { path: "/" });
  check(r.json?.kind === "folder", "stat of the top: a folder");
  check(err(await call("stat", { path: "/w/none" })) === "ENOENT", "stat of nothing: ENOENT");
  r = await call("list", { path: "/w" });
  check(JSON.stringify(r.json) === JSON.stringify(["a.txt"]), `list: the names (${JSON.stringify(r)})`);
  check(err(await call("list", { path: "/w/a.txt" })) === "ENOTDIR", "list of a file: ENOTDIR");
  r = await call("open", { path: "/w/a.txt" });
  check(r.json?.fid === a.fid && r.json.size === 11, "open: its fid, rev and size");
  check(err(await call("open", { path: "/w" })) === "EISDIR", "open of a folder: EISDIR");
  r = await call("stat", { path: W.TRASH + "/x" });
  check(err(r) === "EACCES", `a path in Trash is refused, the workspace's (${JSON.stringify(r)})`);
  // reads: a window, the slot, a change between windows seen
  r = await call("read", { path: "/w/a.txt", fid: a.fid, pos: 6, max: 3 });
  check(r.bytes && dec(r.bytes) === "wor", `read: the exact range (${r.bytes && dec(r.bytes)})`);
  check(h.held() === 11, `the read slot holds the file read (${h.held()})`);
  r = await call("read", { path: "/w/a.txt", fid: a.fid, pos: 50, max: 3 });
  check(r.bytes?.length === 0, "a read past the end: 0 bytes");
  const cur = await ws.stat("/w/a.txt");
  await ws.write("/w/a.txt", enc("HELLO WORLD!"), { base: cur.rev, fid: cur.fid });
  r = await call("read", { path: "/w/a.txt", fid: a.fid, pos: 6, max: 6 });
  check(r.bytes && dec(r.bytes) === "WORLD!" && h.held() === 12, `a change between windows: the next read sees the new bytes, the slot re-filled (${r.bytes && dec(r.bytes)})`);
  // replaced between the open and the read: never the new file's bytes for the old descriptor
  await ws.remove("/w/a.txt");
  await put(ws, "/w/a.txt", "another file");
  check(err(await call("read", { path: "/w/a.txt", fid: a.fid, pos: 0, max: 5 })) === "EBADF", "a file replaced after its open: EBADF, not the new file's bytes");
  await put(ws, "/w/b.txt", "bbb");
  const b = (await call("open", { path: "/w/b.txt" })).json;
  await call("read", { path: "/w/b.txt", fid: b.fid, pos: 0, max: 3 });
  check(h.held() === 3, `a second file replaces the slot (one slot: ${h.held()} B held)`);
  h.drop();
  check(h.held() === 0, "the end drops the slot");
  // notebooks and boards are refused in this PR
  await ws.create("/w/nb.ipynb", { content: { cells: [] } });
  check(err(await call("open", { path: "/w/nb.ipynb" })) === "EACCES", "opening a notebook: EACCES (r1 §4.2)");
  check(err(await call("write", { path: "/w/nb.ipynb", mode: "replace" }, 2)) === "EACCES", "writing a notebook: EACCES, refused before its body");
  // folders, removals, renames: the shell's own verbs
  check((await call("mkdir", { path: "/w/d", recursive: false })).json === true && (await ws.stat("/w/d"))?.kind === "folder", "mkdir");
  check(err(await call("mkdir", { path: "/w/d", recursive: false })) === "EEXIST", "mkdir of an existing folder: EEXIST");
  await put(ws, "/w/d/x", "x");
  check(err(await call("remove", { path: "/w/d", folder: true, recursive: false })) === "ENOTEMPTY", "rmdir of a folder that isn't empty: ENOTEMPTY");
  check(err(await call("remove", { path: "/w/d", folder: false, recursive: false })) === "EISDIR", "unlink of a folder: EISDIR");
  check(err(await call("remove", { path: "/w/b.txt", folder: true, recursive: false })) === "ENOTDIR", "rmdir of a file: ENOTDIR");
  check((await call("rename", { from: "/w/d", to: "/w/e" })).json === true && (await ws.stat("/w/e/x")) && !(await ws.stat("/w/d")), "a folder renamed whole");
  check((await call("remove", { path: "/w/e", folder: null, recursive: true })).json === true && !(await ws.stat("/w/e")), "rm -r");
  check(run.ledger().ops >= 3 && run.ops.length === run.ledger().ops, `each change charged and recorded once (${run.ledger().ops} ops, ${run.ops.length} records)`);
  check((await call("access", { path: "/w/b.txt", write: true })).json === true, "access(W_OK) on a file");
  // scope lost on a cache hit: a grant revoked between two reads of the slot's file
  let state = "ok";
  const g = await fresh("handler-grant");
  const gd = await g.ws.mkdir("/g");
  await put(g.ws, "/g/f.txt", "granted");
  const gr = g.host.run({ kind: "grant", actor: "agent:test", folders: new Set([gd.fid]), write: true, live: () => state });
  const gh = TB.fileHandler(gr.commandPort(0));
  const gcall = (op, args, length) => gh.handler({ op, args, ...(length === undefined ? {} : { length }) });
  const gf = (await gcall("open", { path: "/g/f.txt" })).json;
  await gcall("read", { path: "/g/f.txt", fid: gf.fid, pos: 0, max: 3 });
  state = "revoked";
  r = await gcall("read", { path: "/g/f.txt", fid: gf.fid, pos: 3, max: 4 });
  check(err(r) === "EACCES" && gr.terminal?.row === 3, `a revoked grant on a cache hit: refused, the run latched (row 3); the slot is no authorization (${JSON.stringify(r).slice(0, 120)})`);
  // the fence: a stopped run's port answers nothing
  run.stop();
  check(err(await call("stat", { path: "/w/b.txt" })) === "EBADF", "a stopped run's port: EBADF");
}

// ---- writes: preflight before any body, then the commit in its own turn (r1 §4.3; D8)
async function writes(check) {
  {
    const { ws, run, call } = await handlerOf("writes", { bash: { write_bytes: 65536 } });
    await ws.mkdir("/w");
    let r = await call("write", { path: "/w/r.txt", mode: "replace" }, 3);
    check(typeof r.admit === "function", "replace of a new file: admitted");
    r = await r.admit(enc("abc"));
    check(r.json?.size === 3 && (await read(ws, "/w/r.txt")) === "abc", `committed: ${JSON.stringify(r)}`);
    await (await call("write", { path: "/w/r.txt", mode: "replace" }, 2)).admit(enc("xy"));
    check((await read(ws, "/w/r.txt")) === "xy", "replace of an existing file");
    const e = await ws.stat("/w/r.txt");
    r = await (await call("write", { path: "/w/r.txt", fid: e.fid, mode: "append" }, 2)).admit(enc("zz"));
    check((await read(ws, "/w/r.txt")) === "xyzz" && r.json.size === 4, "append to that fid's file");
    const e2 = await ws.stat("/w/r.txt");
    await (await call("write", { path: "/w/r.txt", fid: e2.fid, mode: "at", rev: e2.rev, pos: 6 }, 1)).admit(enc("!"));
    check((await read(ws, "/w/r.txt")) === "xyzz\0\0!", "a positional write past the end: zeros between");
    check(err(await call("write", { path: "/w/r.txt", fid: e2.fid, mode: "at", rev: e2.rev, pos: 0 }, 1)) === "ECONFLICT", "a positional write on a stale revision: ECONFLICT before any body");
    check(err(await call("write", { path: "/w/r.txt", fid: "nope", mode: "append" }, 1)) === "EBADF", "an append by a fid that isn't the file's now: EBADF");
    const before = run.ledger();
    r = await call("write", { path: "/w/big.txt", mode: "replace" }, 70000);
    check(err(r) === "EDQUOT" && !r.admit && run.terminal?.row === 4 && run.terminal.key === "write_bytes", `a header past write_bytes: refused before its body moves or is allocated, the limit typed (${JSON.stringify(r).slice(0, 120)})`);
    check(run.ledger().ops === before.ops && run.ledger().written_bytes === before.written_bytes, "the refused preflight charged nothing");
  }
  {
    const { ws, call } = await handlerOf("writes-growth");
    await put(ws, "/g.txt", "one ");
    const ad = await call("write", { path: "/g.txt", mode: "append" }, 5);
    const cur = await ws.stat("/g.txt");
    await ws.write("/g.txt", enc("one two "), { base: cur.rev, fid: cur.fid });
    await ad.admit(enc("three"));
    check((await read(ws, "/g.txt")) === "one two three", `an append that grew since its admission: composed from the file at the commit (${await read(ws, "/g.txt")})`);
  }
  {
    const { ws, run, call, port } = await handlerOf("writes-queue");
    let release;
    const held = port.turn("/", () => new Promise((res) => (release = res)));
    const pre = call("write", { path: "/q.txt", mode: "replace" }, 1);
    let settled = false;
    pre.then(() => (settled = true));
    await sleep(80);
    check(!settled, "a write's preflight waits for the op before it in the run's queue");
    release(true);
    await held;
    const ad = await pre;
    let release2;
    const held2 = port.turn("/", () => new Promise((res) => (release2 = res)));
    const commit = ad.admit(enc("q"));
    await sleep(80);
    check(!(await ws.stat("/q.txt")), "the final commit waits its own turn: nothing written while another op runs");
    const ops0 = run.ledger().ops;
    run.stop();
    release2(true);
    await held2;
    const cr = await commit;
    check(err(cr) === "EBADF" && !(await ws.stat("/q.txt")) && run.ledger().ops === ops0 && run.ops.length === ops0, `Stop while the final commit waits (before its locked admission): nothing committed, charged or recorded (${JSON.stringify(cr)})`);
  }
  {
    const { ws, run, call } = await handlerOf("writes-d8");
    const ad = await call("write", { path: "/d8.txt", mode: "replace" }, 2);
    const orig = run.check;
    let fired = false;
    run.check = (c) => {
      orig(c);
      if (!fired && c.op === "create" && c.path === "/d8.txt") {
        fired = true;
        run.stop();
      }
    };
    const cr = await ad.admit(enc("d8"));
    check(fired && (await read(ws, "/d8.txt")) === "d8" && run.ledger().ops === 1 && run.ops.length === 1 && run.terminal?.row === 1, `D8: a write inside its locked section when Stop latches finishes, charged and recorded once (${JSON.stringify(cr)})`);
  }
  {
    const { ws, run, call } = await handlerOf("writes-zero");
    const cr = await (await call("write", { path: "/z.txt", mode: "replace" }, 0)).admit(new Uint8Array(0));
    check(cr.json?.size === 0 && (await ws.stat("/z.txt"))?.size === 0 && run.ledger().ops === 1, `a zero-length write: one commit (${JSON.stringify(cr)})`);
  }
  {
    const { ws, call } = await handlerOf("writes-openw");
    const o = await call("openw", { path: "/o.txt", create: true, trunc: true, excl: false });
    check(o.json?.fid && (await ws.stat("/o.txt"))?.size === 0, "openw with create: the file made before the open succeeds");
    await (await call("write", { path: "/o.txt", mode: "replace" }, 3)).admit(enc("abc"));
    check(err(await call("openw", { path: "/o.txt", create: true, trunc: false, excl: true })) === "EEXIST", "O_EXCL on an existing file: EEXIST");
    await call("openw", { path: "/o.txt", create: false, trunc: true, excl: false });
    check((await ws.stat("/o.txt"))?.size === 0, "O_TRUNC: truncated before the open succeeds");
    check(err(await call("openw", { path: "/none.txt", create: false, trunc: false, excl: false })) === "ENOENT", "no O_CREAT and no file: ENOENT");
  }
}

// A scripted stand-in for the notebook's worker: `script(msg, w)` answers each message the bridge posts
class Fake {
  constructor(script) {
    this.script = script;
    this.onmessage = this.onerror = null;
    this.terminated = false;
    this.posted = [];
    this.interrupt = new SharedArrayBuffer(8);
  }
  postMessage(m) {
    this.posted.push(m);
    if (m.init) setTimeout(() => this.script({ init: true }, this));
    else if (m.term) setTimeout(() => this.script(m, this));
  }
  emit(data) {
    if (!this.terminated) this.onmessage?.({ data });
  }
  ready() {
    this.emit({ ready: true, interrupt: this.interrupt });
  }
  terminate() {
    this.terminated = true;
  }
}
const okDone = (m, extra = {}) => ({ termDone: { gen: m.term.gen, code: 0, stdout: "out\n", stderr: "", output: { producedBytes: 4, deliveredBytes: 4, exceeded: false, truncated: false }, ...extra } });
const req = (name, argv, stdin = "", over = {}) => ({ req: 1, name, argv, stdin: enc(stdin), stdinRedirected: false, cwd: "/", ...over });

// ---- the command loop: answers with no worker, refusals, the queue and its reservation, generations
async function loop(check) {
  const f = await fresh("loop");
  const portOf = () => f.host.run(PERSON).commandPort(0);
  let fakes = [];
  const scripted = (script) => () => {
    const w = new Fake(script);
    fakes.push(w);
    return w;
  };
  let b = TB.bridge({ worker: scripted((m, w) => (m.init ? w.ready() : w.emit(okDone(m)))) });
  let a = await b.run(portOf(), req("python", ["-V"]));
  check(a.ok?.code === 0 && a.ok.stdout === "Python 3.14.10\n" && fakes.length === 0, `python -V: answered with no worker (${JSON.stringify(a)})`);
  a = await b.run(portOf(), req("python", []));
  check(a.ok?.code === 2 && /interactive prompt isn't available/.test(a.ok.stderr), "python alone, stdin not redirected: the alone-line, 2");
  a = await b.run(portOf(), req("python", ["x.py"]));
  check(a.ok?.code === 0 && a.ok.stdout === "out\n" && fakes.length === 1 && fakes[0].terminated, `a command: run in one worker, answered, the worker ended (${JSON.stringify(a)})`);
  const term = fakes[0].posted.find((m) => m.term)?.term;
  check(term && term.env.COLUMNS === 100 && term.env.LINES === 30 && term.out.backstop === 32 * 2 ** 20 && term.sync.control instanceof SharedArrayBuffer && fakes[0].posted[0].init?.limits === null, `its term message: the panel's size, the output bounds, the channel; the engine's default limits (${JSON.stringify(term && { env: term.env, out: term.out })})`);
  a = await b.run(portOf(), req("python", Array(1025).fill("a")));
  check(a.ok?.code === 2 && a.ok.stderr === "python: more than 1024 arguments; the Terminal accepts up to 1024\n", "1025 arguments: refused, 2");
  a = await b.run(portOf(), req("sage", ["x".repeat(65537)]));
  check(a.ok?.code === 2 && a.ok.stderr === "sage: the arguments are longer than the Terminal accepts (64 KiB)\n", "65537 bytes of arguments: refused, 2");
  a = await b.run(portOf(), { ...req("python", []), stdin: new Uint8Array(8 * 2 ** 20 + 1), stdinRedirected: true });
  check(a.ok?.code === 2 && a.ok.stderr === "python: the input is longer than the Terminal accepts (8 MiB)\n", "8 MiB + 1 of stdin: refused, 2");
  fakes = [];
  a = await TB.bridge({ isolated: () => false, worker: scripted(() => {}) }).run(portOf(), req("magma", ["f.m"]));
  check(a.ok?.code === 126 && /^magma: can't run here: it needs shared memory/.test(a.ok.stderr) && fakes.length === 0, "no shared memory: 126, no worker");
  const gport = f.host.run({ kind: "grant", actor: "agent:x", folders: new Set(), write: false, live: () => "ok" }).commandPort(0);
  a = await TB.bridge({ worker: scripted(() => {}) }).run(gport, req("python", ["x.py"]));
  check(a.ok?.code === 126 && a.ok.stderr === "python: can't run yet in a shell with limited access (an agent's or a document's); it runs in a Terminal the person opens\n" && fakes.length === 0, "a shell with limited access: 126, no worker, no fallback");
  fakes = [];
  b = TB.bridge({ firstGen: 2 ** 31 - 1, worker: scripted((m, w) => (m.init ? w.ready() : w.emit(okDone(m)))) });
  a = await b.run(portOf(), req("python", ["x.py"]));
  const a2 = await b.run(portOf(), req("python", ["x.py"]));
  check(a.ok?.code === 0 && fakes[0].posted.find((m) => m.term)?.term.gen === 2 ** 31 - 1 && a2.ok?.code === 126 && /too many commands; reopen it/.test(a2.ok.stderr), `generation 2^31-1 runs; the next is refused, never wrapped (${JSON.stringify(a2)})`);
  // the queue: one live worker, 16 waiting with their stdin reserved, the 17th refused; a Stop of a waiting run frees only its entry
  fakes = [];
  const releases = [];
  b = TB.bridge({ worker: scripted((m, w) => (m.init ? w.ready() : releases.push(() => w.emit(okDone(m))))) });
  const runs = Array.from({ length: 18 }, () => f.host.run(PERSON));
  const ps = runs.slice(0, 17).map((r, i) => b.run(r.commandPort(0), { ...req("python", []), stdin: enc("x".repeat(i + 1)), stdinRedirected: true }));
  await until(() => releases.length === 1, 3000);
  const full = await b.run(runs[17].commandPort(0), { ...req("python", []), stdin: enc("y"), stdinRedirected: true });
  let st = b.stats();
  const want = Array.from({ length: 16 }, (_, i) => i + 2).reduce((x, y) => x + y, 0);
  check(st.live === 1 && st.waiting === 16 && st.reserved === want && full.ok?.code === 2 && full.ok.stderr === "python: too many commands are waiting in the Terminal (16)\n", `one live, 16 waiting with ${want} B reserved, the 17th refused (${JSON.stringify(st)}, ${JSON.stringify(full)})`);
  runs[5].stop();
  const stopped = await ps[5];
  st = b.stats();
  check(stopped.err && st.waiting === 15 && st.reserved === want - 6, `a Stop of a waiting command's run: its entry and its reservation only (${JSON.stringify(st)})`);
  let n = 0;
  while (n < 16) {
    if (!(await until(() => releases.length > n, 3000))) break;
    releases[n++]();
  }
  const all = await Promise.all(ps);
  st = b.stats();
  check(all.filter((x) => x.ok?.code === 0).length === 16 && st.live === 0 && st.waiting === 0 && st.reserved === 0 && fakes.length === 16 && fakes.every((w) => w.terminated), `all run in turn, one worker at a time; nothing live, waiting or reserved after (${JSON.stringify(st)}, ${fakes.length} workers)`);
}

// ---- a command's end: the accepted messages, the end only when quiet, output, Stop and its grace (r1 §2.2, §5, §6)
async function ends(check) {
  const f = await fresh("ends");
  const fakes = [];
  const scripted = (script, o = {}) => TB.bridge({ graceMs: 200, ...o, worker: () => { const w = new Fake(script); fakes.push(w); return w; } });
  const one = async (script, o, host = f.host) => {
    const run = host.run(PERSON);
    const a = await scripted(script, o).run(run.commandPort(0), req("python", ["x.py"]));
    return { a, run, w: fakes.at(-1) };
  };
  let x = await one((m, w) => (m.init ? (w.emit({ libLoading: "numpy" }), w.emit({ libChunk: "c" }), w.ready()) : w.emit(okDone(m))));
  check(x.a.ok?.code === 0 && !x.run.terminal, "the runtime's loading notices are ignored");
  x = await one((m, w) => (m.init ? w.ready() : w.emit({ fsChanged: "/x", data: null })));
  check(x.a.err && x.run.terminal?.row === 5 && x.w.terminated, `a message a command doesn't send: a fault, the run latched (row 5), the worker ended (${JSON.stringify(x.run.terminal)})`);
  x = await one((m, w) => (m.init ? w.ready() : w.emit({ id: 3, liveData: {}, buffer: null })));
  check(x.run.terminal?.row === 5, "a host callback (live data) isn't routed: a fault");
  x = await one((m, w) => (m.init ? (w.ready(), w.ready()) : null));
  check(x.run.terminal?.row === 5 && x.w.terminated, "ready twice: a fault");
  x = await one((m, w) => (m.init ? w.ready() : w.emit(okDone(m, { gen: m.term.gen + 1 }))));
  check(x.run.terminal?.row === 5, "an end of another generation: a fault");
  x = await one((m, w) => (m.init ? w.ready() : w.emit(okDone(m, { code: 256 }))));
  check(x.run.terminal?.row === 5, "a code past 255: a fault");
  x = await one((m, w) => (m.init ? w.ready() : w.emit(okDone(m, { output: { producedBytes: 4, deliveredBytes: 3, exceeded: false, truncated: false } }))));
  check(x.run.terminal?.row === 5, "a delivered count that isn't the output's: a fault");
  x = await one((m, w) => (m.init ? w.ready() : w.emit(okDone(m, { stdout: "x".repeat(m.term.out.allowance + 1), output: { producedBytes: m.term.out.allowance + 1, deliveredBytes: m.term.out.allowance + 1, exceeded: true, truncated: false } }))));
  check(x.run.terminal?.row === 5, "more output back than the allowance: a fault (N1)");
  x = await one((m, w) => (m.init ? w.ready() : w.emit(okDone(m, { stdout: "abc", output: { producedBytes: m.term.out.allowance + 10, deliveredBytes: 3, exceeded: true, truncated: false } }))));
  check(x.run.terminal?.row === 4 && x.run.terminal.key === "output_bytes", `output past the run's allowance: the run's bash.output_bytes (${JSON.stringify(x.run.terminal)})`);
  {
    const g = await fresh("ends-backstop", { bash: { output_bytes: 64 * 2 ** 20 } });
    x = await one((m, w) => (m.init ? w.ready() : w.emit(okDone(m, { stdout: "abc", output: { producedBytes: 40 * 2 ** 20, deliveredBytes: 3, exceeded: false, truncated: true } }))), {}, g.host);
    check(x.a.ok?.code === 126 && x.a.ok.stdout === "abc" && !x.run.terminal, `past the 32 MiB backstop with allowance left: an ordinary 126 with the cut result (${JSON.stringify(x.a)})`);
  }
  x = await one((m, w) => (m.init ? w.emit({ initFailed: "bad limits" }) : null));
  check(x.a.ok?.code === 126 && /bad limits/.test(x.a.ok.stderr) && x.w.terminated, "the worker's init refused: 126 with its reason");
  // an end while a file request is held: a fault, settled after the held op
  {
    const run = f.host.run(PERSON);
    const port = run.commandPort(0);
    let release;
    const held = port.turn("/", () => new Promise((res) => (release = res)));
    const p = scripted((m, w) => {
      if (m.init) return w.ready();
      Atomics.store(new Int32Array(m.term.sync.control), TS.SL.STATE, TS.ST.WAITING);
      w.emit({ fsSync: { gen: m.term.gen, seq: 1, op: "stat", args: { path: "/" } } });
      setTimeout(() => w.emit(okDone(m)), 30);
    }).run(port, req("python", ["x.py"]));
    let settled = false;
    p.then(() => (settled = true));
    await sleep(200);
    const before = settled;
    release(true);
    await held;
    const a = await p;
    const c = new Int32Array(fakes.at(-1).posted.find((m) => m.term).term.sync.control);
    check(run.terminal?.row === 5 && a.err && !before && Atomics.load(c, TS.SL.STATE) === TS.ST.CANCELLED, `an end while a file request is held: a fault, settled only after the held op; the channel CANCELLED (${JSON.stringify(run.terminal)}, ${before})`);
  }
  // a refusal after the command started, with a write's commit held: a fault, settled only after the commit
  {
    const run = f.host.run(PERSON);
    const port = run.commandPort(0);
    let release;
    const held = port.turn("/", () => new Promise((res) => (release = res)));
    const p = scripted((m, w) => {
      if (m.init) return w.ready();
      Atomics.store(new Int32Array(m.term.sync.control), TS.SL.STATE, TS.ST.WAITING);
      w.emit({ fsSync: { gen: m.term.gen, seq: 1, op: "openw", args: { path: "/r.txt", create: true, trunc: true, excl: false } } });
      setTimeout(() => w.emit({ termRefused: "late" }), 30);
    }).run(port, req("python", ["x.py"]));
    let settled = false;
    p.then(() => (settled = true));
    await sleep(200);
    const before = settled;
    release(true);
    await held;
    const a = await p;
    check(!before && a.err && run.terminal?.row === 5 && fakes.at(-1).terminated, `a refusal after the command started: a fault, settled only after the held op (${before}, ${JSON.stringify(run.terminal)})`);
  }
  // Stop before ready: no worker stays
  {
    const run = f.host.run(PERSON);
    const p = scripted(() => {}).run(run.commandPort(0), req("python", ["x.py"]));
    await sleep(30);
    run.stop();
    const a = await p;
    check(a.err && fakes.at(-1).terminated, "Stop before the worker is ready: ended at once");
  }
  // Stop with a worker that ignores it: the channel cancelled and the interrupt flag set at once, ended at the grace
  {
    const run = f.host.run(PERSON);
    const p = scripted((m, w) => (m.init ? w.ready() : null), { graceMs: 300 }).run(run.commandPort(0), req("python", ["x.py"]));
    await until(() => fakes.at(-1)?.posted.some((m) => m.term), 3000);
    const w = fakes.at(-1);
    const t0 = performance.now();
    run.stop();
    const c = new Int32Array(w.posted.find((m) => m.term).term.sync.control);
    const flagged = Atomics.load(new Int32Array(w.interrupt), 0) & 1, cancelled = Atomics.load(c, TS.SL.STATE) === TS.ST.CANCELLED && Atomics.load(c, TS.SL.CLOSED) === 1;
    await sleep(100);
    const early = w.terminated;
    const a = await p;
    check(flagged && cancelled && !early && w.terminated && a.err && performance.now() - t0 >= 290, `Stop: the channel cancelled and the interrupt flag set at once; a worker that ignores them ended at the grace (${flagged}, ${cancelled}, ${early})`);
  }
  // the exec's own signal stops the command's worker (N2)
  {
    const g = await fresh("ends-signal", { bridgeOpts: { worker: () => { const w = new Fake((m, w) => (m.init ? w.ready() : null)); fakes.push(w); return w; }, graceMs: 200 } });
    const ctl = new AbortController();
    const p = exec(g.host, "python -c 1", { signal: ctl.signal });
    await until(() => fakes.at(-1)?.posted.some((m) => m.term), 20000);
    ctl.abort();
    const o = await p;
    check(o.kind === "interrupted" && fakes.at(-1).terminated, `the exec's signal stops the command's worker (N2): ${o.kind}`);
  }
}

// ---- end to end: the real worker, every mode, files live, Stop
async function e2e(check) {
  const { ws, host } = await fresh("e2e", { bridgeOpts: { graceMs: 1500 } });
  await ws.mkdir("/w");
  let o = await exec(host, "sage -c 'print(factor(60))'");
  check(o.kind === "exit" && o.code === 0 && o.stdout === "2^2 * 3 * 5\n", `sage -c (${JSON.stringify(o).slice(0, 200)})`);
  o = await exec(host, "matlab -batch 'disp(1+1)'");
  check(o.kind === "exit" && o.code === 0 && /2/.test(o.stdout), `matlab -batch (${JSON.stringify(o).slice(0, 200)})`);
  await put(ws, "/w/m.m", "print 2^10;\n");
  o = await exec(host, "cd /w && magma m.m");
  check(o.kind === "exit" && o.code === 0 && o.stdout === "1024\n", `magma FILE (${JSON.stringify(o).slice(0, 200)})`);
  o = await exec(host, "magma -Z m.m");
  check(o.kind === "exit" && o.code === 1 && o.stdout === "" && o.stderr === "Usage: magma [-d] [-l limit] [-b] [-n] [-s startfile] [-S seed] [-r workspace] [-c package] [-q directory machine] [filelist]\n", `magma with an unknown option: Magma's usage line on stderr, 1 (${JSON.stringify(o).slice(0, 300)})`);
  o = await exec(host, "python -c 'import shutil; print(shutil.get_terminal_size())'");
  check(o.kind === "exit" && o.stdout === "os.terminal_size(columns=100, lines=30)\n", `COLUMNS and LINES from the panel's size (${JSON.stringify(o.stdout)})`);
  o = await exec(host, "cd /w && python -c 'print(\"to a file\")' > out.txt && cat out.txt");
  check(o.kind === "exit" && o.stdout === "to a file\n", `python's output redirected to a file (${JSON.stringify(o).slice(0, 200)})`);
  o = await exec(host, "python -c 'for i in range(5): print(i)' | wc -l");
  check(o.kind === "exit" && o.stdout.trim() === "5", `python | wc -l (${JSON.stringify(o.stdout)})`);
  await exec(host, "python -c 'import builtins; builtins.leak = 1'");
  o = await exec(host, "python -c 'import builtins; print(hasattr(builtins, \"leak\"))'");
  check(o.stdout === "False\n", "isolation: nothing of one command in the next");
  o = await exec(host, "python -c 'import os; os.system(\"python -c 1\")'");
  check(o.kind === "exit" && o.code === 1 && /Error/.test(o.stderr), `no recursion: os.system raises (${JSON.stringify(o.stderr.slice(-120))})`);
  await put(ws, "/w/live.txt", "before");
  o = await exec(host, "cd /w && python -c 'print(open(\"live.txt\").read()); open(\"kept.txt\",\"w\").write(\"kept\"); 1/0'");
  check(o.kind === "exit" && o.code === 1 && o.stdout === "before\n" && (await read(ws, "/w/kept.txt")) === "kept", `a write before an exception persists (${JSON.stringify(o).slice(0, 200)})`);
  await ws.create("/w/nb.ipynb", { content: { cells: [] } });
  o = await exec(host, "cd /w && python -c 'open(\"nb.ipynb\").read()'");
  check(o.kind === "exit" && o.code === 1 && /PermissionError/.test(o.stderr), `opening a notebook from python: PermissionError (${JSON.stringify(o.stderr.slice(-160))})`);
  {
    const ctl = new AbortController();
    const p = exec(host, "python -c 'while True: pass'", { signal: ctl.signal });
    await until(() => live() === 1, 20000);
    await sleep(500);
    ctl.abort();
    const r = await p;
    check(r.kind === "interrupted" && (await until(() => live() === 0, 5000)), `Stop in a running loop: ^C (stopped), no worker left (${r.kind})`);
  }
  {
    const ctl = new AbortController();
    const p = exec(host, "python -c 'import time\nwhile True:\n    try:\n        time.sleep(0.01)\n    except KeyboardInterrupt:\n        pass'", { signal: ctl.signal });
    await until(() => live() === 1, 20000);
    await sleep(500);
    ctl.abort();
    const r = await p;
    check(r.kind === "interrupted" && (await until(() => live() === 0, 5000)), `a program that ignores Stop: ended at the grace, no worker left (${r.kind})`);
  }
  {
    const made = window.workers.made;
    const ctl = new AbortController();
    const p = exec(host, "python -c 'print(1)' | python -c 'while True: pass' | wc -l", { signal: ctl.signal });
    await until(() => live() === 1 && window.workers.made >= made + 2, 20000);
    await sleep(300);
    ctl.abort();
    const r = await p;
    check(r.kind === "interrupted" && (await until(() => live() === 0, 5000)), `Stop at a pipeline's middle stage: stopped, no worker left (${r.kind})`);
  }
  {
    const g = await fresh("e2e-limits", { bash: { read_bytes: 65536, written_bytes: 100 } });
    await put(g.ws, "/big.txt", "x".repeat(70000));
    let r = await exec(g.host, "python -c 'open(\"/big.txt\").read()'");
    check(r.kind === "limit" && r.key === "read_bytes", `a read past bash.read_bytes: the typed limit (${JSON.stringify(r).slice(0, 200)})`);
    const run = g.host.run(PERSON);
    r = await run.invoke("python -c 'open(\"/a.txt\",\"w\").write(\"a\"*60)'");
    const r2 = await run.invoke("python -c 'open(\"/b.txt\",\"w\").write(\"b\"*60)'");
    check(r.kind === "exit" && r2.kind === "limit" && r2.key === "written_bytes", `written_bytes across two commands of one run: one ledger (${r.kind}, ${JSON.stringify(r2).slice(0, 150)})`);
  }
  check(await until(() => live() === 0, 5000), `no command worker left at the end (${live()})`);
}

// ---- CPython 3.14.10's answers (test/term-cmd-oracle.json, recorded by test/gen_term_cmd_cases.py), case by case
async function oracle(check) {
  const { cases, records } = D.oracle;
  const { ws, host } = await fresh("oracle");
  await ws.mkdir("/in");
  const q = (s) => "'" + s.replace(/'/g, "'\\''") + "'";
  for (const [i, c] of cases.entries()) {
    const want = records[i];
    if (!want || want.name !== c.name) {
      check(false, `oracle: the record for ${c.name} is missing or out of order`);
      continue;
    }
    if (await ws.stat("/w")) await ws.remove("/w");
    await ws.mkdir("/w");
    for (const [name, text] of Object.entries(c.files)) {
      const p = "/w/" + name;
      const up = p.slice(0, p.lastIndexOf("/"));
      if (up !== "/w" && !(await ws.stat(up))) await ws.mkdir(up, { recursive: true });
      await put(ws, p, text);
    }
    let redirect = "";
    if (c.stdin !== null) {
      const f = `/in/${i}.txt`;
      await put(ws, f, c.stdin);
      redirect = " < " + f;
    }
    const o = await exec(host, `cd /w && ${c.argv0}${c.argv.map((a) => " " + q(a)).join("")}${redirect}`);
    const got = { stdout: o.stdout, stderr: o.stderr, code: o.code };
    const last = (s) => s.trimEnd().split("\n").at(-1);
    const after = (s) => s.slice(s.indexOf(": "));
    const same =
      o.kind === "exit" &&
      got.code === want.code &&
      got.stdout === want.stdout &&
      (c.compare === "last-line" ? last(got.stderr) === last(want.stderr) : c.compare === "after-name" ? after(got.stderr) === after(want.stderr) : got.stderr === want.stderr);
    check(same, `oracle: ${c.name} (${c.argv0} ${JSON.stringify(c.argv).slice(0, 80)}): ${same ? "as CPython 3.14.10" : `got ${JSON.stringify(got).slice(0, 300)}, CPython ${JSON.stringify({ stdout: want.stdout, stderr: want.stderr, code: want.code }).slice(0, 300)}`}`);
  }
}

// ---- the races the slot and the fence close (r1 §4.2), and the port's own contract
async function races(check) {
  // (a view of the workspace whose next readUpTo first runs `hooks.readUpTo`)
  const hooks = {};
  const wrap = (ws) => {
    const v = Object.create(ws);
    v.readUpTo = async function (...a) {
      const h = hooks.readUpTo;
      delete hooks.readUpTo;
      if (h) await h();
      const r = await ws.readUpTo.apply(this, a);
      const after = hooks.afterReadUpTo;
      delete hooks.afterReadUpTo;
      if (after) await after();
      return r;
    };
    return v;
  };
  const { ws, run, call, host } = await handlerOf("races", { wrap });
  await put(ws, "/a.txt", "old file");
  const a = (await call("open", { path: "/a.txt" })).json;
  // replaced inside the read itself, after its stat: the bytes returned are another file's, refused by their own fid
  hooks.readUpTo = async () => {
    await ws.remove("/a.txt");
    await put(ws, "/a.txt", "new file");
  };
  let r = await call("read", { path: "/a.txt", fid: a.fid, pos: 0, max: 8 });
  check(err(r) === "EBADF", `a file replaced between the read's stat and its bytes: EBADF from the returned entry's fid (${JSON.stringify(r).slice(0, 100)})`);
  // the slot's key is the fid at use too: a replacement at the same revision never gets the old file's bytes
  await put(ws, "/s.txt", "slot bytes");
  const s1 = (await call("open", { path: "/s.txt" })).json;
  await call("read", { path: "/s.txt", fid: s1.fid, pos: 0, max: 4 });
  await ws.remove("/s.txt");
  await put(ws, "/s.txt", "other");
  check((await ws.stat("/s.txt")).rev === s1.rev, "(the replacement has the slot's revision)");
  r = await call("read", { path: "/s.txt", fid: s1.fid, pos: 4, max: 6 });
  check(err(r) === "EBADF", `a replacement at the same revision: EBADF, never the slot's old bytes (${JSON.stringify(r).slice(0, 100)})`);
  // a Stop that lands after the read's locked admission, while its bytes are on their way: no bytes after it
  await put(ws, "/t.txt", "late bytes");
  const t = (await call("open", { path: "/t.txt" })).json;
  hooks.afterReadUpTo = async () => run.stop();
  r = await call("read", { path: "/t.txt", fid: t.fid, pos: 0, max: 4 });
  check(err(r) === "EBADF" && !r.bytes, `Stop while a read awaits: the run's end, no bytes (${JSON.stringify(r).slice(0, 100)})`);
  // the port: a Stop registered after the run has latched runs at once
  let called = false;
  run.commandPort(0).onStop(() => (called = true));
  check(called, "a Stop registered after the run latched is called at once");
  // a dead run's command never loads the bridge
  let loads = 0;
  const g = await fresh("races-load");
  const h2 = new ShellHost(g.ws, (signal) => startShell(D.S, "/", { signal }).then((x) => x.shell), { commands: async () => (loads++, { bridge: () => TB.bridge() }) });
  const dead = h2.run(PERSON);
  dead.stop();
  const a2 = await dead.command(0, req("python", ["-c", "1"]));
  check(a2.err && loads === 0, `a stopped run's command: refused before the bridge loads (${JSON.stringify(a2)}, ${loads} loads)`);
  // ops: room checked before the body moves
  const o = await handlerOf("races-ops", { bash: { ops: 1 } });
  await (await o.call("write", { path: "/one.txt", mode: "replace" }, 1)).admit(enc("1"));
  r = await o.call("write", { path: "/two.txt", mode: "replace" }, 1);
  check(!r.admit && err(r) === "EDQUOT" && o.run.terminal?.key === "ops", `no room left in bash.ops: refused at the preflight, before any body (${JSON.stringify(r).slice(0, 100)})`);
}
