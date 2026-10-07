// A Jupyter kernel for Sagebrush: the pyjs runtime (Sage, Python or Magma
// syntax) with its engines and SVG graphics, over the Jupyter messaging
// protocol 5.3 (https://jupyter-client.readthedocs.io/en/latest/messaging.html)
// on a pure-JavaScript ZeroMQ transport (./zmtp), so installing it needs
// neither Python nor a native library:
//
//   sagebrush --install-jupyter-kernel [--user | --sys-prefix | --prefix P] [--mode sage|python|magma|all]
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
import { Worker, parentPort } from "worker_threads";
import { ZSocket } from "./zmtp";
import { initParser, R, libDir } from "./compile";
import { needsMore, complete } from "./interactive";
import { magmaToPython, MagmaSyntaxError } from "./magma";
import { mimeBundle } from "./runtime/index";
import { typeName } from "./runtime/object";

export type Mode = "sage" | "python" | "magma";

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
};

const VERSION = () => (globalThis as any).__SAGEBRUSH_VERSION__ ?? "dev";

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
  if (m === "all") return ["sage", "python", "magma"];
  if (m !== "sage" && m !== "python" && m !== "magma") throw new Error(`--mode must be sage, python, magma or all, not ${m}`);
  return [m];
}

const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#6b8e5a"/><path d="M32 52V24M32 34l-10-8M32 30l10-9M32 42l-8-5M32 40l9-6" stroke="#f4f1e6" stroke-width="4" stroke-linecap="round" fill="none"/></svg>`;

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
    worker = new Worker(entry, { workerData: { sagebrushKernel: mode }, stdout: false, stderr: false });
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
            send(iopub, "error", m.error, current.msg);
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
    if (intr) intr[0] = 0;
    worker.postMessage({ id, code: ct.code });
    const r = await done;
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

  const interrupt = () => {
    if (intr) {
      intr[0] = 1;
      Atomics.notify(intr, 0);
    }
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
        const r = mode === "magma" ? { matches: [], prefix: "" } : await ask({ complete: code.slice(start, pos) });
        send(sock, "complete_reply", { status: "ok", matches: r.matches, cursor_start: pos - r.prefix.length, cursor_end: pos, metadata: {} }, msg, msg.idents);
      } else if (t === "is_complete_request") {
        const r = mode === "magma" ? { more: false } : await ask({ check: msg.content.code ?? "" });
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
  for (const [stream, name] of [[R.stdout, "stdout"], [R.stderr, "stderr"]] as [any, string][]) {
    stream.write = function (s: string) {
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
      }
    }
  };
  const ready = (async () => {
    await initParser();
    const sys = R.importModule("sys");
    sys.path.push(process.cwd());
    sys.path.push(libDir());
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
        b["text/plain"] ??= R.repr(v);
        flush();
        if (current !== null) port.postMessage({ id: current, result: b });
      }
      return null;
    };
    if (mode === "sage") run("from sage_all import *\n", main, "exec", "<sage>");
    return { main, host };
  })();
  const FLUSH = "import sys as _s\n_p = _s.modules.get('matplotlib.pyplot')\nif _p is not None: _p._flush_figures()\n_o = _s.modules.get('_pyjs_open')\nif _o is not None: _o._flush_all()\n";
  const moduleNames = () => [...R.builtinModuleNames(), ...Object.keys((globalThis as any).__PYJS_LIB__ ?? {}).map((k: string) => k.split("/")[0].replace(/\.py$/, ""))];
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
    R.INTR[0] = 0;
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
    } else run(m.code + "\n", main, "cell", "<cell>", { sage: mode === "sage" });
    run(FLUSH, host, "exec", "<figures>");
    flush();
    port.postMessage({ id: m.id, done: true, error: errorReported });
    current = null;
  });
  port.postMessage({ ready: true, interrupt: R.INTR.buffer instanceof SharedArrayBuffer ? R.INTR.buffer : null });
}
