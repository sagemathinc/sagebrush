#!/usr/bin/env node
// The launcher (also build/cli/pyjs): Node's compile cache on (faster starts
// after the first), then the bundle.
//
// A program (a file, -c, -m, or a program on stdin) runs in a worker
// thread, so that Ctrl-C raises KeyboardInterrupt in it as in CPython: a
// signal handler runs only when its thread is idle, and the program keeps
// its own thread busy, so this thread, which stays idle, takes SIGINT and
// sets the interrupt flag the compiled code polls (the runtime's INTR, in
// shared memory). A second Ctrl-C within 2 s, while the first is still
// unseen (a call that does not poll), ends the process as SIGINT's default
// action would. An uncaught KeyboardInterrupt ends it the same way after the
// traceback, so the shell sees 130, as CPython's does. This thread never
// loads the bundle then: only the worker does, once. Everything else (the
// interactive prompt, the notebook, the Jupyter kernel, board, --help) runs
// here as before; so does a program when SAGEBRUSH_NO_WORKER is set.
try {
  require("node:module").enableCompileCache?.();
} catch {}
const { join } = require("node:path");
const { existsSync, openSync, readSync, closeSync } = require("node:fs");
const bundle = [join(__dirname, "..", "dist", "sagebrush.cjs"), join(__dirname, "pyjs.cjs")].find((f) => existsSync(f));
const argv = process.argv.slice(2);

// The engine's limits (src/limits.ts has the same rules, for the bundle run
// directly): --limits FILE among the interpreter's own options (taken out of
// the arguments; after -c, -m, -, a script, a subcommand or --, it is the
// program's), else SAGEBRUSH_LIMITS=FILE; the file read here with a bounded
// read of at most 4097 bytes, a failure ending the run with status 2.  The
// text then goes to the program's worker (workerData) or to the bundle loaded
// here (a global, never an environment value a child would inherit), whose
// runtime validates it (lib/_limits.py) before its first statement.
const LIMITS_MAX = 4096;
const oneLine = (s) => String(s).replace(/[\x00-\x1f\x7f-\x9f]/g, (c) => "\\x" + c.charCodeAt(0).toString(16).padStart(2, "0"));
function refuse(msg) {
  process.stderr.write(`sagebrush: ${msg}\n`);
  process.exit(2);
}
function limitsFile() {
  let file = null;
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--limits") {
      if (i + 1 >= argv.length) refuse("--limits takes a file");
      if (file !== null) refuse("--limits is given more than once");
      file = argv[i + 1];
      argv.splice(i, 2);
      i--;
      continue;
    }
    if (x === "--figures" || x === "--pkgset") {
      i++;
      continue;
    }
    if (x === "--" || x === "-c" || x === "-m" || x === "-" || !x.startsWith("-")) break;
  }
  if (file !== null) return file;
  try {
    return process.env.SAGEBRUSH_LIMITS || null;
  } catch {
    return null; // (a Deno without --allow-env)
  }
}
const WHY = { ENOENT: "No such file or directory", EACCES: "Permission denied", EISDIR: "Is a directory", ENOTDIR: "Not a directory", ELOOP: "Too many levels of symbolic links" };
function readLimits(path) {
  const name = oneLine(path), buf = Buffer.alloc(LIMITS_MAX + 1);
  let n = 0;
  try {
    const fd = openSync(path, "r");
    try {
      for (let k; n < buf.length && (k = readSync(fd, buf, n, buf.length - n, null)) > 0; ) n += k;
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    refuse(`limits: cannot read ${name}: ${WHY[e && e.code] || oneLine((e && (e.code || e.message)) || e)}`);
  }
  if (n > LIMITS_MAX) refuse(`limits: ${name} is larger than ${LIMITS_MAX} bytes`);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buf.subarray(0, n));
  } catch {
    refuse(`limits: ${name} is not JSON: it is not UTF-8`);
  }
  return { text, name };
}
// (only on the main thread: the bundle's own workers start this file too,
// #88, and take their limits from their workerData, never from a file again)
const mainThread = require("node:worker_threads").isMainThread;
const limitsPath = mainThread ? limitsFile() : null;
const limits = limitsPath === null ? null : readLimits(limitsPath);

// Whether the arguments run a program, by the rules of src/cli.ts's main().
// Never in a worker thread: the bundle's own workers (board check's and board
// try's interpreter, the notebook's sessions, the Jupyter kernel's) start this
// file, require.main's, and are told what to do by their workerData, not by
// arguments, which a worker has none of (its stdin not a terminal either, so
// it would otherwise start a program on stdin in a worker of its own).
function runsProgram(a) {
  if (!require("node:worker_threads").isMainThread) return false;
  try {
    if (process.env.SAGEBRUSH_NO_WORKER) return false;
  } catch {} // (a Deno without --allow-env)
  const first = a[0];
  if (["board", "notebook", "--notebook", "--jupyter-kernel", "--install-jupyter-kernel", "--uninstall-jupyter-kernel"].includes(first)) return false;
  if (first === "--search" || first === "search") return true;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    if (x === "-i" || x === "--emit" || x === "-V" || x === "--version" || x === "--licenses" || x === "-h" || x === "--help") return false;
    if (x === "--figures") {
      i++;
      continue;
    }
    if (x === "-c" || x === "-m" || x === "-" || !x.startsWith("-")) return true;
  }
  // (options only: the prompt on a terminal, else a program on stdin)
  return !process.stdin.isTTY;
}

if (!runsProgram(argv)) {
  // (the arguments without --limits FILE, for the bundle's main())
  if (mainThread) {
    process.argv.splice(2, process.argv.length - 2, ...argv);
    globalThis.__SAGEBRUSH_LIMITS__ = limits;
  }
  require(bundle);
} else {
  const { Worker } = require("node:worker_threads");
  let intr = null, last = 0, interrupted = false;
  const die = () => {
    process.removeAllListeners("SIGINT");
    process.kill(process.pid, "SIGINT");
  };
  process.on("SIGINT", () => {
    const now = Date.now();
    // (before the worker has handed over its flag, or a second Ctrl-C the
    // program has not seen yet: SIGINT's default action)
    if (intr === null || ((Atomics.load(intr, 0) & 1) !== 0 && now - last < 2000)) return die();
    last = now;
    Atomics.or(intr, 0, 1); // (bit 0, Ctrl-C: the word's other bits left, src/runtime/interrupt.ts)
    Atomics.notify(intr, 0); // (a time.sleep waits on the flag)
  });
  // (the worker turns on the compile cache before it loads the bundle, as
  // this thread does: a Worker started on the file itself compiles it anew
  // every time, about 160 ms)
  const boot = `try { require("node:module").enableCompileCache?.(); } catch {}\nrequire(${JSON.stringify(bundle)});`;
  // (stdout and stderr: true, so that this thread never opens its own
  // process.stdout, which would make the shared descriptor non-blocking: the
  // worker writes to fds 1 and 2 itself, cliWorker in src/cli.ts)
  const worker = new Worker(boot, { eval: true, stdout: true, stderr: true, workerData: { sagebrushCli: { argv, limits } } });
  worker.on("message", (m) => {
    if (m && m.interrupt) intr = new Int32Array(m.interrupt);
    if (m && m.keyboardInterrupt) interrupted = true;
  });
  worker.on("error", (e) => {
    process.stderr.write(`sagebrush: ${(e && e.stack) || e}\n`);
    process.exitCode = 1;
  });
  worker.on("exit", (code) => {
    if (interrupted) return die();
    if (!process.exitCode) process.exitCode = code;
  });
}
