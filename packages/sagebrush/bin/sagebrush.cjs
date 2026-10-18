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
const { existsSync } = require("node:fs");
const bundle = [join(__dirname, "..", "dist", "sagebrush.cjs"), join(__dirname, "pyjs.cjs")].find((f) => existsSync(f));
const argv = process.argv.slice(2);

// Whether the arguments run a program, by the rules of src/cli.ts's main()
function runsProgram(a) {
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

if (!runsProgram(argv)) require(bundle);
else {
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
    if (intr === null || (Atomics.load(intr, 0) !== 0 && now - last < 2000)) return die();
    last = now;
    Atomics.store(intr, 0, 1);
    Atomics.notify(intr, 0); // (a time.sleep waits on the flag)
  });
  // (the worker turns on the compile cache before it loads the bundle, as
  // this thread does: a Worker started on the file itself compiles it anew
  // every time, about 160 ms)
  const boot = `try { require("node:module").enableCompileCache?.(); } catch {}\nrequire(${JSON.stringify(bundle)});`;
  // (stdout and stderr: true, so that this thread never opens its own
  // process.stdout, which would make the shared descriptor non-blocking: the
  // worker writes to fds 1 and 2 itself, cliWorker in src/cli.ts)
  const worker = new Worker(boot, { eval: true, stdout: true, stderr: true, workerData: { sagebrushCli: { argv } } });
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
