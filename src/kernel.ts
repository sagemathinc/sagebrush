// A Jupyter kernel for Sagebrush: the pyjs runtime (Sage, Python, Magma or
// MATLAB syntax) with its engines and SVG graphics, over the Jupyter messaging
// protocol 5.3 (https://jupyter-client.readthedocs.io/en/latest/messaging.html)
// on a pure-JavaScript ZeroMQ transport (./zmtp), so installing it needs
// neither Python nor a native library:
//
//   sagebrush --install-jupyter-kernel [--user | --sys-prefix | --prefix P] [--mode sage|python|magma|matlab|all]
//   sagebrush --uninstall-jupyter-kernel [...the same options]
//   sagebrush --jupyter-kernel CONNECTION_FILE [--mode sage]   (what kernel.json runs)
//
// The kernel's main thread owns the sockets (so heartbeats and interrupt
// requests are answered while a cell runs); the code runs in a worker
// thread with the runtime, whose interrupt flag (R.INTR) is shared memory:
// an interrupt raises KeyboardInterrupt in Python loops and stops the
// WebAssembly engines.

import { createHmac, randomUUID } from "crypto";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, realpathSync, statSync, copyFileSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { Worker, parentPort, workerData } from "worker_threads";
import { sessionLimits, startLimits } from "./limits";
import { ZSocket } from "./zmtp";
import { initParser, R, libDir, packageModuleNames } from "./compile";
import { needsMore, complete, ipythonSyntax } from "./interactive";
import { magmaToPython, MagmaSyntaxError } from "./magma";
import { matlabToPython, MatlabSyntaxError, matlabSyntaxMessage, matlabHostOps, matlabIsIncomplete } from "./matlab";
import { mimeBundle } from "./runtime/index";
import { requestCtrlC } from "./runtime/interrupt";
import { typeName } from "./runtime/object";
import { exitStatus } from "./notebook-session";
import { MAGIC_PRE, MAGIC_POST, GET_IPYTHON, magicTransform } from "./magic-syntax";

export type Mode = "sage" | "python" | "magma" | "matlab";

const SPECS: Record<Mode, { dir: string; display: string; language: string; info: any }> = {
  sage: {
    dir: "sagebrush",
    display: "Sagebrush (Sage)",
    language: "sage",
    info: { name: "sage", version: "3.14", mimetype: "text/x-python", file_extension: ".sage", codemirror_mode: { name: "ipython", version: 3 }, pygments_lexer: "ipython3" },
  },
  python: {
    dir: "sagebrush-python",
    display: "Sagebrush (Python)",
    language: "python",
    info: { name: "python", version: "3.14", mimetype: "text/x-python", file_extension: ".py", codemirror_mode: { name: "ipython", version: 3 }, pygments_lexer: "ipython3", nbconvert_exporter: "python" },
  },
  magma: {
    dir: "sagebrush-magma",
    display: "Sagebrush (Magma)",
    language: "magma",
    info: { name: "magma", version: "", mimetype: "text/x-magma", file_extension: ".m" },
  },
  matlab: {
    dir: "sagebrush-matlab",
    display: "Sagebrush (MATLAB)",
    language: "matlab",
    // (as the MathWorks kernel describes MATLAB: Jupyter's front ends highlight it as Octave)
    info: { name: "matlab", version: "", mimetype: "text/x-matlab", file_extension: ".m", codemirror_mode: "octave", pygments_lexer: "matlab" },
  },
};

const VERSION = () => (globalThis as any).__SAGEBRUSH_VERSION__ ?? "dev";
// (said of a run whose worker was ended: it did not stop when interrupted;
// the same words as the notebook page's, web/notebook/worker-kernel.js)
const STOPPED = "it did not stop when interrupted, so the interpreter was restarted; variables are gone";

// ------------------------------------------------------------------ install

function jupyterDataDir(args: string[]): string {
  const i = args.indexOf("--prefix");
  if (i >= 0) {
    const p = args[i + 1];
    if (!p) throw new Error("--prefix needs a directory");
    return join(p, "share", "jupyter");
  }
  if (args.includes("--sys-prefix")) {
    const p = process.env.CONDA_PREFIX || process.env.VIRTUAL_ENV;
    if (!p) throw new Error("--sys-prefix: activate a conda or virtual environment first (or use --prefix DIR)");
    return join(p, "share", "jupyter");
  }
  if (process.env.JUPYTER_DATA_DIR) return process.env.JUPYTER_DATA_DIR;
  if (process.platform === "darwin") return join(homedir(), "Library", "Jupyter");
  if (process.platform === "win32") return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "jupyter");
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "jupyter");
}

/** How to start this program again: [node, script] or [executable]. */
function launcher(): string[] {
  const exe = process.execPath;
  const script = process.argv[1];
  try {
    if (script && realpathSync(script) !== realpathSync(exe)) return [exe, realpathSync(script)];
  } catch {
    // a virtual script path (a compiled executable)
  }
  return [exe];
}

/** Under plain Node, the one-file bundle this program runs from (the npm
 *  package's dist/sagebrush.cjs or build/cli/pyjs.cjs): the installer copies
 *  it next to kernel.json, so the kernel keeps working when it was installed
 *  with npx (whose cache can be cleared) or the package is upgraded. */
function bundleFile(): string | null {
  const g = globalThis as any;
  if (g.Deno || process.versions.bun || !g.__PYJS_LIB__) return null; // an executable, or not the bundle
  const main = require.main?.filename;
  if (!main) return null;
  for (const c of [main, join(dirname(main), "..", "dist", "sagebrush.cjs")]) {
    try {
      if (/\.cjs$/.test(c) && statSync(c).size > 1e6) return realpathSync(c);
    } catch {
      // not there
    }
  }
  return null;
}

function modes(args: string[]): Mode[] {
  const i = args.indexOf("--mode");
  const m = i >= 0 ? args[i + 1] : "sage";
  if (m === "all") return ["sage", "python", "magma", "matlab"];
  if (m !== "sage" && m !== "python" && m !== "magma" && m !== "matlab") throw new Error(`--mode must be sage, python, magma, matlab or all, not ${m}`);
  return [m];
}

const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="18.75" fill="#AE472A"/><path fill="#FADEB6" d="M14.5 63.4 16.5 61.8 18.8 59.8 25.3 58.4 26.3 56 27.4 54 28.6 52 30.2 50 32.8 48 33.3 43.3 43.5 43.3 43.5 48.6 45.7 48.6 45.7 45 47.3 45 47.3 49.2 47.9 50 49.6 52 43 54.2 37.1 56 34.4 58 31.2 60 29.6 62 28.9 63.4Z"/><path fill="#FADEB6" d="M55.6 63.4 57 62 59.7 60 63.6 58.6 64 55.2 67.7 55.2 67.7 51 68.2 49.6 69.6 49.6 70.4 51 70.4 55 71 56 72 58 76.9 60 79.6 62 81.6 63.4Z"/><path fill="#FADEB6" d="M58 39.5C57.7 40.7 58 44.7 57.6 46.5 57.2 48.3 56.9 49.1 55.6 50.2 54.3 51.4 52.5 52.1 50 53.4 47.5 54.7 42.6 56.8 40.4 58.2 38.2 59.6 36.6 60.7 36.7 62 36.8 63.3 38.6 64.7 41.2 66 43.8 67.3 50.3 68.7 52.4 69.9 54.5 71.1 54.9 72.2 53.8 73.4 52.6 74.6 49.2 75.6 45.5 77 41.8 78.4 34.9 80.6 31.5 82 28.1 83.4 25.4 84.7 25.3 85.4 25.2 86.2 27.7 86.2 31 86.5 34.3 86.8 40.2 87.7 45 87.5 49.8 87.3 55.7 86.4 60 85.2 64.3 84 68.4 82.3 70.6 80.6 72.8 78.9 73.4 76.8 73.3 75 73.2 73.2 72.4 71.5 70 70 67.6 68.5 62.7 67.2 59 66 55.3 64.8 50.2 63.7 48 62.6 45.8 61.5 45.2 60.8 45.9 59.6 46.6 58.4 49.9 56.7 52 55.2 54.1 53.7 57.1 52.3 58.4 50.6 59.7 48.9 59.5 46.9 59.7 45 59.9 43.1 59.7 40.4 59.4 39.5 59.1 38.6 58.3 38.3 58 39.5Z"/><path fill="#BAC49E" d="M59.2 40.8C54.5 36 54.8 28.5 60 24 65 19.6 72 17.5 79.3 13.4 79 21 77.5 28.5 71.5 33.6 67 37.4 62.5 39.3 59.9 40.8Z"/><path fill="#AE472A" d="M57.7 37C57.3 31 62 26.2 72.6 22.3 66 26.6 61.6 31.2 59.5 36.8Z"/></svg>`;

export function installKernel(args: string[], uninstall = false): number {
  try {
    const base = join(jupyterDataDir(args), "kernels");
    for (const mode of modes(args)) {
      const spec = SPECS[mode];
      const dir = join(base, spec.dir);
      if (uninstall) {
        if (existsSync(dir)) {
          rmSync(dir, { recursive: true, force: true });
          process.stdout.write(`removed the Jupyter kernel ${spec.dir} (${dir})\n`);
        } else process.stdout.write(`no Jupyter kernel ${spec.dir} in ${base}\n`);
        continue;
      }
      mkdirSync(dir, { recursive: true });
      const bundle = bundleFile();
      let run = launcher();
      if (bundle) {
        copyFileSync(bundle, join(dir, "sagebrush.cjs"));
        run = [process.execPath, join(dir, "sagebrush.cjs")];
      }
      const kernel = {
        argv: [...run, "--jupyter-kernel", "{connection_file}", "--mode", mode],
        display_name: spec.display,
        language: spec.language,
        interrupt_mode: "message",
        metadata: { debugger: false },
      };
      writeFileSync(join(dir, "kernel.json"), JSON.stringify(kernel, null, 2) + "\n");
      writeFileSync(join(dir, "logo-svg.svg"), LOGO);
      process.stdout.write(`installed the Jupyter kernel "${spec.display}" in ${dir}\n`);
    }
    return 0;
  } catch (e: any) {
    process.stderr.write(`sagebrush: ${e.message}\n`);
    return 1;
  }
}

// ------------------------------------------------------------------ the kernel (main thread)

const DELIM = Buffer.from("<IDS|MSG>");

interface Msg {
  idents: Buffer[];
  header: any;
  parent: any;
  metadata: any;
  content: any;
}

export async function runKernel(connectionFile: string, mode: Mode): Promise<void> {
  const c = JSON.parse(readFileSync(connectionFile, "utf8"));
  if (c.transport && c.transport !== "tcp") throw new Error(`transport ${c.transport} is not supported (only tcp)`);
  const key: string = c.key ?? "";
  const session = randomUUID();
  const sign = (parts: Buffer[]) => {
    if (!key) return "";
    const h = createHmac(String(c.signature_scheme || "hmac-sha256").replace(/^hmac-/, ""), key);
    for (const p of parts) h.update(p);
    return h.digest("hex");
  };
  const shell = new ZSocket("ROUTER");
  const control = new ZSocket("ROUTER");
  const stdin = new ZSocket("ROUTER");
  const iopub = new ZSocket("PUB");
  const hb = new ZSocket("REP");
  await Promise.all([
    shell.bind(c.ip, c.shell_port),
    control.bind(c.ip, c.control_port),
    stdin.bind(c.ip, c.stdin_port),
    iopub.bind(c.ip, c.iopub_port),
    hb.bind(c.ip, c.hb_port),
  ]);

  const send = (sock: ZSocket, msgType: string, content: any, parent: Msg | null, idents?: Buffer[], metadata: any = {}) => {
    const header = { msg_id: randomUUID(), session, username: "sagebrush", date: new Date().toISOString(), msg_type: msgType, version: "5.3" };
    const parts = [header, parent ? parent.header : {}, metadata, content].map((x) => Buffer.from(JSON.stringify(x)));
    const ids = idents ?? [Buffer.from(`kernel.${session}.${msgType}`)];
    sock.send([...ids, DELIM, Buffer.from(sign(parts)), ...parts]);
  };
  const status = (state: string, parent: Msg) => send(iopub, "status", { execution_state: state }, parent);

  const parse = (frames: Buffer[]): Msg | null => {
    const i = frames.findIndex((f) => f.equals(DELIM));
    if (i < 0 || frames.length < i + 6) return null;
    const parts = frames.slice(i + 2, i + 6);
    if (key && frames[i + 1].toString() !== sign(parts)) return null; // bad signature: drop
    const [header, parent, metadata, content] = parts.map((p) => JSON.parse(p.toString() || "{}"));
    return { idents: frames.slice(0, i), header, parent, metadata, content };
  };

  // ---- the worker
  let intr: Int32Array | null = null;
  let worker: Worker;
  const pending = new Map<number, (m: any) => void>();
  let nextId = 1;
  let current: { id: number; msg: Msg; count: number; silent: boolean; error: boolean } | null = null;
  const queue: Msg[] = [];
  let execCount = 0;
  let workerReady: Promise<void> = Promise.resolve();

  const startWorker = () => {
    const entry = require.main?.filename ?? process.argv[1];
    worker = new Worker(entry, { workerData: { sagebrushKernel: mode, sagebrushLimits: sessionLimits() }, stdout: false, stderr: false });
    workerReady = new Promise((res) => {
      worker.on("message", (m: any) => {
        if (m.ready) {
          intr = m.interrupt ? new Int32Array(m.interrupt) : null;
          res();
          return;
        }
        if (current && m.id === current.id) {
          if (m.stream && !current.silent) send(iopub, "stream", { name: m.stream, text: m.text }, current.msg);
          else if (m.display && !current.silent) send(iopub, "display_data", { data: m.display, metadata: {}, transient: {} }, current.msg);
          else if (m.result && !current.silent) send(iopub, "execute_result", { execution_count: current.count, data: m.result, metadata: {} }, current.msg);
          else if (m.clear && !current.silent) send(iopub, "clear_output", { wait: false }, current.msg);
          else if (m.error) {
            current.error = true;
            // (the run's done message carries its error again, for the reply: sent once)
            if (!m.done) send(iopub, "error", m.error, current.msg);
          }
        }
        const f = pending.get(m.id);
        if (f && (m.done || m.matches !== undefined || m.more !== undefined)) {
          pending.delete(m.id);
          f(m);
        }
      });
    });
    worker.on("error", (e) => process.stderr.write(`sagebrush kernel worker: ${e}\n`));
  };
  startWorker();
  const ask = async (req: any): Promise<any> => {
    await workerReady;
    const id = nextId++;
    return new Promise((res) => {
      pending.set(id, res);
      worker.postMessage({ id, ...req });
    });
  };

  // ---- executing, one cell at a time
  let running = false;
  const execute = async (msg: Msg) => {
    const ct = msg.content;
    const silent = !!ct.silent;
    if (!silent && ct.store_history !== false) execCount++;
    const count = execCount;
    status("busy", msg);
    if (!silent) send(iopub, "execute_input", { code: ct.code, execution_count: count }, msg);
    await workerReady;
    const id = nextId++;
    current = { id, msg, count, silent, error: false };
    const done = new Promise<any>((res) => pending.set(id, res));
    if (intr) Atomics.and(intr, 0, ~1); // (a Ctrl-C before this run: not for it; the other bits left)
    worker.postMessage({ id, code: ct.code });
    const r = await done;
    if (killTimer !== null) {
      clearTimeout(killTimer);
      killTimer = null;
    }
    const err = current.error ? r.error ?? { ename: "Error", evalue: "", traceback: [] } : null;
    current = null;
    if (err) {
      send(shell, "execute_reply", { status: "error", execution_count: count, ename: err.ename, evalue: err.evalue, traceback: err.traceback }, msg, msg.idents);
      if (ct.stop_on_error !== false) {
        // abort what was queued behind the failed cell
        for (const q of queue.splice(0)) {
          status("busy", q);
          send(shell, "execute_reply", { status: "aborted", execution_count: execCount }, q, q.idents);
          status("idle", q);
        }
      }
    } else send(shell, "execute_reply", { status: "ok", execution_count: count, user_expressions: {}, payload: [] }, msg, msg.idents);
    status("idle", msg);
  };
  const pump = async () => {
    if (running) return;
    running = true;
    while (queue.length) await execute(queue.shift()!);
    running = false;
  };

  // (a run that does not stop within 2 s of an interrupt is in a call that
  // never checks the flag, a backtracking re match: its worker is ended and
  // a new one started, the run reported stopped, as the notebook page does)
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const interrupt = () => {
    if (intr) requestCtrlC(intr);
    if (current === null || killTimer !== null) return;
    const id = current.id;
    killTimer = setTimeout(() => {
      killTimer = null;
      if (current === null || current.id !== id) return;
      worker.terminate();
      const run = current;
      const f = pending.get(id);
      pending.delete(id);
      // (what else waited on the old worker: completion, is_complete)
      for (const [k, g] of [...pending]) {
        pending.delete(k);
        g({ done: true, matches: [], prefix: "", more: false });
      }
      const error = { ename: "KeyboardInterrupt", evalue: STOPPED, traceback: [`KeyboardInterrupt: ${STOPPED}`] };
      run.error = true;
      if (!run.silent) send(iopub, "error", error, run.msg);
      startWorker();
      f?.({ done: true, error });
    }, 2000);
  };

  let shuttingDown = false;
  const shutdown = (msg: Msg, sock: ZSocket) => {
    shuttingDown = true;
    send(sock, "shutdown_reply", { status: "ok", restart: !!msg.content.restart }, msg, msg.idents);
    status("idle", msg);
    setTimeout(() => {
      worker.terminate();
      for (const s of [shell, control, stdin, iopub, hb]) s.close();
      process.exit(0);
    }, 50);
  };

  const handle = async (sock: ZSocket, msg: Msg) => {
    const t = msg.header.msg_type;
    if (shuttingDown) return;
    if (t === "execute_request") {
      queue.push(msg);
      pump();
      return;
    }
    if (t === "interrupt_request") {
      interrupt();
      status("busy", msg);
      send(sock, "interrupt_reply", { status: "ok" }, msg, msg.idents);
      status("idle", msg);
      return;
    }
    if (t === "shutdown_request") {
      status("busy", msg);
      shutdown(msg, sock);
      return;
    }
    status("busy", msg);
    try {
      if (t === "kernel_info_request") {
        send(sock, "kernel_info_reply", {
          status: "ok",
          protocol_version: "5.3",
          implementation: "sagebrush",
          implementation_version: VERSION(),
          language_info: SPECS[mode].info,
          banner: `Sagebrush ${VERSION()}: ${SPECS[mode].display} (the Python 3.14 language on JavaScript, Rust engines)`,
          help_links: [{ text: "Sagebrush", url: "https://sagebrush.space" }],
        }, msg, msg.idents);
      } else if (t === "complete_request") {
        const code: string = msg.content.code ?? "";
        const pos: number = msg.content.cursor_pos ?? code.length;
        // the line up to the cursor
        const start = code.lastIndexOf("\n", pos - 1) + 1;
        const r = mode === "magma" || mode === "matlab" ? { matches: [], prefix: "" } : await ask({ complete: code.slice(start, pos) });
        send(sock, "complete_reply", { status: "ok", matches: r.matches, cursor_start: pos - r.prefix.length, cursor_end: pos, metadata: {} }, msg, msg.idents);
      } else if (t === "is_complete_request") {
        const r = mode === "magma" ? { more: false } : mode === "matlab" ? { more: matlabIsIncomplete(msg.content.code ?? "") } : await ask({ check: msg.content.code ?? "" });
        send(sock, "is_complete_reply", r.more ? { status: "incomplete", indent: "" } : { status: "complete" }, msg, msg.idents);
      } else if (t === "inspect_request") {
        send(sock, "inspect_reply", { status: "ok", found: false, data: {}, metadata: {} }, msg, msg.idents);
      } else if (t === "history_request") {
        send(sock, "history_reply", { status: "ok", history: [] }, msg, msg.idents);
      } else if (t === "comm_info_request") {
        send(sock, "comm_info_reply", { status: "ok", comms: {} }, msg, msg.idents);
      } else if (t === "comm_open") {
        // no comms (widgets): close it again
        send(iopub, "comm_close", { comm_id: msg.content.comm_id, data: {} }, msg);
      }
    } finally {
      status("idle", msg);
    }
  };
  for (const sock of [shell, control]) {
    sock.onMessage = (frames) => {
      const msg = parse(frames);
      if (msg) handle(sock, msg);
    };
  }
  stdin.onMessage = () => {}; // input() is not supported: no input requests are sent
  process.on("SIGINT", interrupt); // interrupt_mode "signal" clients
  await workerReady;
  // announce
  send(iopub, "status", { execution_state: "starting" }, null);
}

// ------------------------------------------------------------------ the worker thread

export function kernelWorker(mode: Mode) {
  const port = parentPort!;
  let current: number | null = null;
  // stdout and stderr to the main thread, at least every 100 ms during a run
  // (timed from the start of the cell)
  let last = 0;
  // (the line being printed, its start, however it comes in pieces, and the
  // last Magma error line's start: Jupyter's error reply says it, CORR-396-1)
  const LINE_MAX = 1000;
  let line = "", lineLength = 0, magmaError: string | null = null;
  const printed = (s: string) => {
    const parts = s.split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) { line = ""; lineLength = 0; }
      lineLength += parts[i].length;
      if (line.length < LINE_MAX) line = (line + parts[i]).slice(0, LINE_MAX);
      if (/^(User|Runtime) error\b/.test(line)) magmaError = lineLength > LINE_MAX ? line + "…" : line;
    }
  };
  for (const [stream, name] of [[R.stdout, "stdout"], [R.stderr, "stderr"]] as [any, string][]) {
    stream.write = function (s: string) {
      if (name === "stdout") printed(s);
      this.buf.push(s);
      this.size += s.length;
      const now = Date.now();
      if (this.size > 1 << 14 || now - last > 100) {
        last = now;
        this.flush();
      }
    };
    stream.flush = function () {
      if (this.buf.length) {
        const text = this.buf.join("");
        this.buf = [];
        this.size = 0;
        if (current !== null) port.postMessage({ id: current, stream: name, text });
      }
    };
  }
  const flush = () => {
    R.stdout.flush();
    R.stderr.flush();
  };
  R.host = {
    // (a Python notebook: a value shown as IPython shows it, src/runtime/index.ts
    // displayText; Sage's, Magma's and MATLAB's keep the repr, as SageMath's shell does)
    ipython: mode === "python",
    // (MATLAB: a function file, name.m, found on the path, as Python)
    ...matlabHostOps(),
    display(bundle: Record<string, string>) {
      if (current === null) return false;
      flush();
      port.postMessage({ id: current, display: bundle });
      return true;
    },
    clear_output() {
      flush();
      if (current !== null) port.postMessage({ id: current, clear: true });
    },
    target() {},
  };
  let errorReported: any = null;
  const run = (src: string, ns: any, kind: string, filename: string, opts: any = {}) => {
    try {
      R.loader.exec(src, ns, kind, filename, opts);
    } catch (e) {
      const exc = R.toPyExc(e);
      flush();
      if (!R.typeOf(exc).$mro.includes(R.T.SystemExit)) {
        const tb = R.formatException(exc).replace(/\n$/, "");
        errorReported = { ename: typeName(exc), evalue: R.str(exc), traceback: tb.split("\n") };
        if (current !== null) port.postMessage({ id: current, error: errorReported });
      } else {
        // exit() just ends the cell; an exit with a failure's status is an
        // error: Magma's in a cell (lib/_magma.py raises SystemExit(1) once
        // it has printed it: its line is the error's value, and no traceback,
        // the text being on stdout already), or sys.exit(1)
        const s = exitStatus(exc.code);
        if (s.ok) return;
        const said = mode === "magma" ? magmaError : null, t = said === null ? s.text ?? R.str(exc.code) : "";
        errorReported = said !== null ? { ename: "MagmaError", evalue: said, traceback: [] } : { ename: "SystemExit", evalue: t, traceback: [`SystemExit: ${t}`] };
        if (current !== null) port.postMessage({ id: current, error: errorReported });
      }
    }
  };
  const ready = (async () => {
    await initParser();
    const sys = R.importModule("sys");
    sys.path.push(process.cwd());
    sys.path.push(libDir());
    // (the kernel's limits, before any cell: src/limits.ts; checked by the
    // main thread before this worker started, so a failure here is not expected)
    const bad = startLimits(R, workerData?.sagebrushLimits ?? null);
    if (bad !== null) throw new Error(bad);
    sys.argv.push("");
    const main = R.newModule("__main__");
    main.__builtins__ = R.builtins;
    R.dictSet(R.sysModules, "__main__", main);
    const host = R.newModule("__sagebrush_host__");
    host.__builtins__ = R.builtins;
    // libraries pick Jupyter's representations (e.g. a big 3D scene as an
    // iframe on a file, under the front end's output limit)
    R.builtins.__sagebrush_jupyter__ = true;
    // the value of a cell's last expression: an execute_result
    R.builtins.__pyjs_displayhook__ = (v: any) => {
      if (v !== null) {
        R.builtins._ = v;
        const b = mimeBundle(v) ?? {};
        b["text/plain"] ??= R.displayText(v);
        flush();
        if (current !== null) port.postMessage({ id: current, result: b });
      }
      return null;
    };
    run(GET_IPYTHON, host, "exec", "<init>");
    if (mode === "sage") run("from sage_all import *\n", main, "exec", "<sage>");
    return { main, host };
  })();
  const FLUSH = "import sys as _s\n_p = _s.modules.get('matplotlib.pyplot')\nif _p is not None: _p._flush_figures()\n_o = _s.modules.get('_pyjs_open')\nif _o is not None: _o._flush_all()\n" + MAGIC_POST;
  const moduleNames = () => [...R.builtinModuleNames(), ...Object.keys((globalThis as any).__PYJS_LIB__ ?? {}).map((k: string) => k.split("/")[0].replace(/\.py$/, "")), ...packageModuleNames()];
  port.on("message", async (m: any) => {
    const { main, host } = await ready;
    if (m.check !== undefined) {
      port.postMessage({ id: m.id, more: needsMore(m.check, { sage: mode === "sage" }) });
      return;
    }
    if (m.complete !== undefined) {
      const [matches, prefix] = complete(main, m.complete, () => [...new Set(moduleNames())]);
      port.postMessage({ id: m.id, matches, prefix });
      return;
    }
    current = m.id;
    last = Date.now();
    errorReported = null;
    line = "";
    lineLength = 0;
    magmaError = null;
    Atomics.and(R.INTR, 0, ~1);
    if (mode === "magma") {
      let py: string | null = null;
      try {
        py = magmaToPython(m.code, "<cell>");
      } catch (e: any) {
        if (!(e instanceof MagmaSyntaxError)) throw e;
        const line = m.code.split("\n")[e.line - 1] ?? "";
        const text = `>> ${line}\n${" ".repeat(e.col + 2)}^\nUser error: bad syntax: ${e.message} (line ${e.line})`;
        errorReported = { ename: "SyntaxError", evalue: e.message, traceback: text.split("\n") };
        port.postMessage({ id: m.id, error: errorReported });
      }
      if (py !== null) run(py, main, "exec", "<cell>");
    } else if (mode === "matlab") {
      // MATLAB: translated in cell mode (src/matlab.ts); its error message is Jupyter's error
      let py: string | null = null;
      try {
        py = matlabToPython(m.code, "<cell>", { cell: true });
      } catch (e: any) {
        if (!(e instanceof MatlabSyntaxError)) throw e;
        const text = matlabSyntaxMessage(e, m.code, "<cell>").replace(/\n$/, "");
        errorReported = { ename: "MATLAB:syntax", evalue: e.message, traceback: text.split("\n") };
        port.postMessage({ id: m.id, error: errorReported });
      }
      if (py !== null) {
        const M = R.importModule("_matlab");
        R.callObj(R.getattr(M, "host_shows_errors"), []);
        run(py, main, "exec", "<cell>");
        const text = R.callObj(R.getattr(M, "cell_error"), []);
        if (typeof text === "string" && errorReported === null) {
          const lines = text.replace(/\n$/, "").split("\n");
          errorReported = { ename: "MATLAB", evalue: lines[0], traceback: lines };
          port.postMessage({ id: m.id, error: errorReported });
        }
      }
    } else {
      run(MAGIC_PRE, host, "exec", "<autoreload>");
      run(ipythonSyntax(m.code) + "\n", main, "cell", "<cell>", { sage: mode === "sage", transform: magicTransform(mode === "sage") });
    }
    run(FLUSH, host, "exec", "<figures>");
    flush();
    port.postMessage({ id: m.id, done: true, error: errorReported });
    current = null;
  });
  port.postMessage({ ready: true, interrupt: R.INTR.buffer instanceof SharedArrayBuffer ? R.INTR.buffer : null });
}
