// pyjs: run Python programs, or an interactive prompt.
//
//   sagebrush                 interactive prompt
//   pyjs program.py [args]    run a program
//   pyjs -c 'code' [args]     run a string
//   pyjs -m module [args]     run a library module as __main__
//   pyjs -i program.py        run, then stay interactive
//   pyjs --emit program.py    print the generated JavaScript

import { readFileSync, readSync, writeSync, mkdirSync, appendFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, rmdirSync, unlinkSync, readdirSync, lstatSync, opendirSync, type Dirent } from "fs";
import { dirname, resolve, join } from "path";
import { homedir, tmpdir } from "os";
import * as readline from "readline";
import { oneLine } from "./terminal-text";
import { initParser, compile, execModule, R, libDir, findModuleSource, packageModuleNames, installPackageSet, coreBuildId, reservedNames } from "./compile";
import { prepareSet } from "./pkgcache";
import { magmaToPython, MagmaSyntaxError, type Recover } from "./magma";
import { matlabToPython, MatlabSyntaxError, matlabSyntaxMessage, matlabHostOps, looksLikeMagma } from "./matlab";
import { needsMore, complete, helpSyntax, ipythonSyntax } from "./interactive";
import { MAGIC_PRE, MAGIC_POST, GET_IPYTHON, magicTransform } from "./magic-syntax";
import { getattr, unbox } from "./runtime/object";
import { isMainThread, workerData, parentPort } from "worker_threads";
import { installKernel, runKernel, kernelWorker, Mode } from "./kernel";
import { runNotebookServer, notebookWorker } from "./notebook";
import { takeLimitsOption, launcherLimits, startLimits, setSessionLimits, type LimitsText } from "./limits";
import { selectLimits } from "./limits-file";

const VERSION = `sagebrush ${(globalThis as any).__SAGEBRUSH_VERSION__ ?? "dev"} (Python 3.14 language on a JavaScript runtime)`;
const USAGE = `usage: sagebrush [-c cmd | -m mod | file | -] [args]
  -c cmd   run the program passed as a string
  -m mod   run a library module as a script
  -i       inspect interactively after running a program
  --sage   Sage syntax (2^3 == 8, 2/3 is a Rational) with sage_all imported;
           implied for .sage files
  --magma  Magma: the program is Magma, translated to Python (src/magma.ts)
           and run on lib/_magma.py; implied for .mag files, and for .m files
           that assign with :=
  --matlab MATLAB: the program is MATLAB, translated to Python (src/matlab.ts)
           and run on lib/_matlab.py; implied for other .m files
  -q       no banner on the interactive prompt
  --limits FILE
           this run's engine limits (also SAGEBRUSH_LIMITS=FILE): a JSON
           object of at most 4096 bytes, such as {"ff.work": 100000000};
           every key (ff.work, ff.conway_work, ff.embed_max, ff.root_bits,
           poly.work, nf.relation_rounds, nf.certify_norm_max,
           nf.certify_index_max, padic.kedlaya_work, matlab.lu_work,
           pandas.decoded_bytes) is
           "unlimited" by default: set finite values to opt in to work
           limits (grading, shared compute); memory guards always apply;
           invalid limits end the run with status 2 before it starts
  --pkgset ID|FILE
           an optional package set for this run (also SAGEBRUSH_PKGSET): its
           id, fetched and verified into ~/.cache/sagebrush/pkg, or a local
           pkgset/<id>.json (scripts/optional-packages.mjs build)
  --figures DIR
           keep the figures shown (plt.show(), a plot's display) as SVG files
           in DIR; without it, they are in a directory removed at exit
  --emit   print the JavaScript compiled from file (with --magma or --matlab: the Python)
  -V       print the version
  --licenses  the licenses of Sagebrush and of what it contains
  --search QUERY [--mode sage|python|magma|matlab] [--limit N] [--json]
           search the documentation of every function (name, signature,
           docstring): what Sagebrush can do; obj? in a session shows one.
           --mode: that language's functions (default: Sage's library,
           which Python mode imports too)
  --install-jupyter-kernel [--user | --sys-prefix | --prefix DIR] [--mode sage|python|magma|matlab|all]
           register Sagebrush as a Jupyter kernel (no Python needed)
  --uninstall-jupyter-kernel [the same options]
  notebook [DIR] [--port N] [--no-browser]
           the Sagebrush notebook in your browser, running Python here;
           notebooks are the .ipynb files in DIR
  board open FILE [--port N] [--no-browser]
           a board in your browser, shown again each time FILE changes
           (sagebrush board --help: every board command)
`;

// A SystemExit's status as the process's exit code, by CPython's rule
// (Python/pythonrun.c), from its Python type, not how this runtime holds it:
// None is 0; an integer (bool and int subclasses too) is its value, its low
// byte as the system keeps it, or -1 (255) if it does not fit a long long;
// anything else is written to stderr, and is 1.
/** All of stdin, as text.  readFileSync(0) throws EAGAIN when stdin is a
 * non-blocking pipe whose writer hasn't written yet: under load a fresh
 * `sagebrush --magma` session died that way, printing nothing (the flaky
 * Magma examples test).  So: read to the end of input, waiting a little
 * whenever there is nothing to read yet. */
// The largest program read from stdin, in bytes: past it the program is refused
// before more of it is kept (a source this size is far past any real program, and
// the lexer's tokens are proportional to it)
const STDIN_SOURCE_MAX = 8 << 20;

/** The program on stdin, or null after refusing one past STDIN_SOURCE_MAX bytes. */
function readStdin(): string | null {
  const chunks: Buffer[] = [];
  let total = 0;
  const buf = Buffer.alloc(1 << 16);
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    let n: number;
    try {
      n = readSync(0, buf, 0, buf.length, null);
    } catch (e: any) {
      if (e?.code === "EAGAIN") {
        Atomics.wait(pause, 0, 0, 5);
        continue;
      }
      if (e?.code === "EOF") break;
      throw e;
    }
    if (n === 0) break;
    if (total + n > STDIN_SOURCE_MAX) {
      // (refused before the chunk that crosses the limit is kept; the rest is not read)
      process.stderr.write(`sagebrush: the program on stdin is more than ${STDIN_SOURCE_MAX >> 20} MiB: not supported.\n`);
      return null;
    }
    total += n;
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function exitCode(c: any): number {
  if (c === null || c === undefined) return 0;
  let int = false;
  try {
    int = R.typeOf(c).$mro.includes(R.T.int);
  } catch {}
  if (int) {
    try {
      // (its integer as stored, as CPython reads it: an int subclass's __index__ is not asked, CORR-0BE-1)
      const v = BigInt(unbox(c));
      return v >= -(2n ** 63n) && v < 2n ** 63n ? Number(BigInt.asUintN(8, v)) : 255;
    } catch {}
  }
  R.stdout.flush();
  let text: string;
  try {
    text = String(R.str(c));
  } catch {
    text = "(an exit status that could not be written as text)";
  }
  R.stderr.write(text + "\n");
  return 1;
}

// Run fn, reporting an uncaught exception as CPython does; returns the exit code.
// (an uncaught KeyboardInterrupt: after its traceback the process ends by
// SIGINT, as CPython's does, so a shell sees 130: endByInterrupt)
let keyboardInterrupt = false;
function guarded(fn: () => void): number | null {
  try {
    fn();
    return null;
  } catch (e: any) {
    const exc = R.toPyExc(e);
    if (R.typeOf(exc).$mro.includes(R.T.SystemExit)) return exitCode(exc.code);
    R.stdout.flush();
    R.stderr.write(R.formatException(exc));
    if (R.typeOf(exc).$mro.includes(R.T.KeyboardInterrupt)) {
      keyboardInterrupt = true;
      return 130;
    }
    return 1;
  }
}
function endByInterrupt() {
  R.stdout.flush();
  R.stderr.flush();
  // (in the launcher's worker: the launcher ends the process so)
  if (!isMainThread) {
    parentPort?.postMessage({ keyboardInterrupt: true });
    return;
  }
  process.removeAllListeners("SIGINT");
  process.kill(process.pid, "SIGINT");
}

// Rich display on a terminal: a picture (SVG) is written to a file whose
// path is printed with the picture's description; the rest prints its repr.
// The files go to --figures DIR, and are kept; else to a directory of this
// run's own, removed when sagebrush exits (runs used to leave a file in
// /tmp for every figure, agent-UX R0-7).
// A process ended by a signal emits no "exit" (HARD-191-1): its directory is
// removed by the next sagebrush that makes one, but only a directory it can
// tell is one of ours, whose process is gone (sweepFigures, HARD-B98-1); the
// prompt removes its own on SIGINT, and on SIGTERM and SIGHUP while it waits
// for input (removeFiguresOnSignal, promptSignals).  A program run by the launcher runs in
// a worker thread and gets Ctrl-C as KeyboardInterrupt (cliWorker); its
// other signals, and all of a program run here on the main thread, keep their
// default action: a handler here would wait for the computation to end.
let plotCount = 0, figuresDir: string | null = null, figuresKept = false, figuresHinted = false;
const removeFigures = () => { if (figuresDir !== null && !figuresKept) try { rmSync(figuresDir, { recursive: true, force: true }); } catch {} };
const FIGURES_MARK = ".sagebrush-figures", FIGURES_STALE_MS = 3600e3;
// A directory left by a sagebrush ended by a signal, removed when all of
// this holds, else left alone: mkdtemp's name, sagebrush-figures-PID-XXXXXX;
// a directory (not a link), this user's, mode 0700, untouched for an hour (a
// process in another pid namespace may share the temporary directory); our
// mark in it, naming that pid; nothing else in it but figure-N.svg files; and
// no process PID.  Only those files and the mark are removed, then the
// directory, never anything recursively.
// (bounds on the sweep's work, so that a plot never waits on it: entries
// of the temporary directory looked at, entries of one candidate, and
// candidates removed; what is past them is left for a later run, or for
// good, HARD-260-1)
const SWEEP_TMP_MAX = 100000, SWEEP_DIR_MAX = 10000, SWEEP_REMOVE_MAX = 8;
/** At most `max` entries of a directory, read one at a time (never the
 * whole listing), or null when it has more. */
function entriesUpTo(path: string, max: number): Dirent[] | null {
  const d = opendirSync(path);
  try {
    const out: Dirent[] = [];
    for (let e = d.readSync(); e !== null; e = d.readSync()) {
      if (out.length === max) return null;
      out.push(e);
    }
    return out;
  } finally {
    d.closeSync();
  }
}
function sweepFigures() {
  const uid = process.getuid?.();
  let dir;
  try { dir = opendirSync(tmpdir()); } catch { return; }
  try {
    let seen = 0, removed = 0;
    for (let ent = dir.readSync(); ent !== null && seen < SWEEP_TMP_MAX && removed < SWEEP_REMOVE_MAX; ent = dir.readSync(), seen++) {
      const f = ent.name;
      const m = /^sagebrush-figures-([1-9]\d{0,9})-[A-Za-z0-9]{6}$/.exec(f);
      if (!m || Number(m[1]) === process.pid) continue;
      try {
        const p = join(tmpdir(), f), st = lstatSync(p);
        if (!st.isDirectory() || (uid !== undefined && st.uid !== uid) || (st.mode & 0o777) !== 0o700 || Date.now() - st.mtimeMs < FIGURES_STALE_MS) continue;
        const mark = join(p, FIGURES_MARK), ms = lstatSync(mark);
        if (!ms.isFile() || ms.size > 100 || readFileSync(mark, "utf8") !== `sagebrush figures ${m[1]}\n`) continue;
        // (no more entries than a run could have left; each a regular file:
        // the directory listing's own type, no stat of each)
        const files = entriesUpTo(p, SWEEP_DIR_MAX);
        if (files === null || !files.every((g) => g.isFile() && (g.name === FIGURES_MARK || /^figure-\d+\.svg$/.test(g.name)))) continue;
        try { process.kill(Number(m[1]), 0); continue; } catch (e: any) { if (e?.code !== "ESRCH") continue; }
        for (const g of files) unlinkSync(join(p, g.name));
        rmdirSync(p);
        removed++;
      } catch {}
    }
  } finally {
    try { dir.closeSync(); } catch {}
  }
}
// (the prompt's handlers, by signal: a handler runs only when the main thread
// is idle, so while the prompt evaluates, SIGTERM and SIGHUP have none and
// keep their default action, ending a computation that never returns, a
// closed terminal's included; the figures it leaves are sweepFigures'.
// SIGINT's stays: it is the prompt's Ctrl-C)
const figureHandlers = new Map<NodeJS.Signals, () => void>();
function removeFiguresOnSignal() {
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    if (process.listenerCount(sig) === 0) {
      const h = () => { removeFigures(); process.kill(process.pid, sig); };
      figureHandlers.set(sig, h);
      process.once(sig, h);
    }
}
/** While the prompt evaluates (busy): SIGTERM's and SIGHUP's handlers off,
 * their default action back; on again when it waits for input. */
function promptSignals(busy: boolean) {
  for (const sig of ["SIGTERM", "SIGHUP"] as const) {
    const h = figureHandlers.get(sig);
    if (h === undefined) continue;
    if (busy) process.removeListener(sig, h);
    else if (!process.listeners(sig).includes(h)) process.once(sig, h);
  }
}
function figurePath(): string {
  if (figuresDir === null) {
    sweepFigures();
    figuresDir = mkdtempSync(join(tmpdir(), `sagebrush-figures-${process.pid}-`));
    process.on("exit", removeFigures);
    writeFileSync(join(figuresDir, FIGURES_MARK), `sagebrush figures ${process.pid}\n`, { flag: "wx" });
  }
  // (in a directory of the user's: never over a file that is there)
  let path: string;
  do path = join(figuresDir, `figure-${++plotCount}.svg`); while (figuresKept && existsSync(path));
  return path;
}
R.host = {
  display(bundle: Record<string, string>): boolean {
    const svg = bundle["image/svg+xml"];
    if (svg === undefined) return false;
    let path: string;
    try {
      path = figurePath();
      writeFileSync(path, svg, { flag: figuresKept ? "wx" : "w" });
    } catch {
      return false; // e.g. a sandbox without environment or write access
    }
    const m = /<title>([^<]*)<\/title>/.exec(svg);
    const desc = m ? m[1].replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&") : "";
    const hint = figuresKept || figuresHinted ? "" : "\n(figures are removed when sagebrush exits; sagebrush --figures DIR keeps them)";
    figuresHinted = true;
    // (the path as one line: a directory named with a newline or an escape code is shown, not obeyed, HARD-191-2)
    R.stdout.write(`${bundle["text/plain"] ?? ""}\nSaved ${oneLine(path)}${desc ? ` (${oneLine(desc.length > 300 ? desc.slice(0, 300) + "…" : desc)})` : ""}${hint}\n`);
    return true;
  },
  // (MATLAB function files on the path: lib/_matlab_files.py)
  ...matlabHostOps(),
};

// --sage: Sage syntax for everything typed or passed on the command line.
let sage = false;
let magma = false;
let matlab = false;
// .m is both Magma's and MATLAB's: looksLikeMagma decides (src/matlab.ts)
const mFileIsMagma = (f: string) => {
  try {
    return looksLikeMagma(readFileSync(f, "utf8"));
  } catch {
    return false;
  }
};
const isMagma = (f: string | null) => magma || (!matlab && f !== null && (/\.(mag|magma)$/.test(f) || (/\.m$/.test(f) && mFileIsMagma(f))));
const isMatlab = (f: string | null) => matlab || (!magma && f !== null && /\.m$/.test(f) && !mFileIsMagma(f));

/** MATLAB source as Python, or null after reporting a syntax error. */
function matlabSource(src: string, file: string): string | null {
  try {
    return matlabToPython(src, file);
  } catch (e) {
    if (!(e instanceof MatlabSyntaxError)) throw e;
    process.stderr.write(matlabSyntaxMessage(e, src, file));
    process.exitCode = 1;
    return null;
  }
}

/**
 * Magma source as Python, or null after reporting a syntax error.  A file
 * runs up to its first syntax error; input from stdin is a session, which
 * reports errors and goes on (src/magma.ts, Recover).
 */
function magmaSource(src: string, file: string, recover: Recover = "file"): string | null {
  try {
    return magmaToPython(src, file, { recover });
  } catch (e) {
    if (!(e instanceof MagmaSyntaxError)) throw e;
    const line = src.split("\n")[e.line - 1] ?? "";
    process.stdout.write(`\n>> ${line}\n${" ".repeat(e.col + 2)}^\nUser error: bad syntax: ${e.message} (${file}, line ${e.line})\n`);
    process.exitCode = 1;
    return null;
  }
}
const opts = () => ({ sage });

function mainModule(file: string): any {
  const m = R.newModule("__main__");
  m.__file__ = file;
  m.__builtins__ = R.builtins;
  R.dictSet(R.sysModules, "__main__", m);
  if (sage) R.loader.exec("from sage_all import *\n", m, "exec", "<sage>");
  return m;
}

// ------------------------------------------------------------------ the prompt

// Module names importable from sys.path (and the builtin modules and the
// packages').
function moduleNames(): string[] {
  const names = new Set<string>([...R.builtinModuleNames(), ...packageModuleNames()]);
  const fs = require("fs");
  for (const d of R.toArray(R.importModule("sys").path) as string[]) {
    const emb: Record<string, string> | undefined = (globalThis as any).__PYJS_LIB__;
    if (emb !== undefined && d === libDir()) {
      for (const k of Object.keys(emb)) names.add(k.split("/")[0].replace(/\.py$/, ""));
      continue;
    }
    try {
      for (const f of fs.readdirSync(d)) if (f.endsWith(".py") || (!f.includes(".") && fs.existsSync(join(d, f, "__init__.py")))) names.add(f.replace(/\.py$/, ""));
    } catch {
      // not a directory
    }
  }
  return [...names];
}

function completer(main: any) {
  return (line: string): [string[], string] => complete(main, line, moduleNames);
}

function historyFile(): string | null {
  try {
    const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
    const dir = join(base, "sagebrush");
    mkdirSync(dir, { recursive: true });
    return join(dir, "history");
  } catch {
    return null;
  }
}

function repl(main: any, quiet: boolean): Promise<number> {
  removeFiguresOnSignal();
  if (!quiet) process.stdout.write(`${VERSION}\nType help(obj) for help, exit() or Ctrl-D to leave.\n`);
  const hist = historyFile();
  let history: string[] = [];
  if (hist) {
    try {
      history = readFileSync(hist, "utf8").split("\n").filter((l) => l).reverse().slice(0, 1000);
    } catch {
      // no history yet
    }
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, completer: completer(main), history, historySize: 1000, terminal: process.stdin.isTTY });
  const sys = R.importModule("sys");
  const ps1 = () => (typeof sys.ps1 === "string" ? sys.ps1 : sage ? "sage: " : ">>> ");
  const ps2 = () => (typeof sys.ps2 === "string" ? sys.ps2 : sage ? "....: " : "... ");
  let buf: string[] = [];
  // (the session's own Python around each input: %autoreload's hooks)
  const host = R.newModule("__sagebrush_host__");
  host.__builtins__ = R.builtins;
  // get_ipython(), as in a notebook
  guarded(() => R.loader.exec(GET_IPYTHON, host, "exec", "<init>"));
  rl.setPrompt(ps1());
  rl.prompt();
  return new Promise((resolveExit) => {
    let done = false;
    const finish = (code: number) => {
      if (done) return;
      done = true;
      R.stdout.flush();
      rl.close();
      resolveExit(code);
    };
    rl.on("line", (line) => {
      buf.push(line);
      const src = buf.join("\n");
      if (src.trim() !== "" && needsMore(src, opts())) {
        rl.setPrompt(ps2());
        rl.prompt();
        return;
      }
      buf = [];
      if (src.trim() !== "") {
        if (hist) {
          try {
            appendFileSync(hist, src.replace(/\n/g, " ") + "\n");
          } catch {
            // read-only home: no history
          }
        }
        promptSignals(true);
        let code: number | null = null;
        try {
          guarded(() => R.loader.exec(MAGIC_PRE, host, "exec", "<autoreload>"));
          code = guarded(() => R.loader.exec(ipythonSyntax(src) + "\n", main, "single", "<stdin>", { ...opts(), transform: magicTransform(sage) }));
          guarded(() => R.loader.exec("import sys as _s\n" + MAGIC_POST, host, "exec", "<autoreload>"));
          // (Python's file flushes are Python code too, and may not return:
          // still busy, astra2 CORR-PR123-1)
          flushFiles();
          R.stdout.flush();
          R.stderr.flush();
        } finally {
          promptSignals(false);
        }
        if (code !== null && code !== 1) return finish(code);
      }
      rl.setPrompt(ps1());
      rl.prompt();
    });
    rl.on("SIGINT", () => {
      buf = [];
      process.stdout.write("\nKeyboardInterrupt\n");
      rl.setPrompt(ps1());
      rl.prompt();
    });
    rl.on("close", () => {
      if (process.stdin.isTTY) process.stdout.write("\n");
      finish(0);
    });
  });
}

// ------------------------------------------------------------------ main

/** The runtime's limits, given to it before any user code: false (status 2,
 * said on stderr) if they are invalid.  libDir() must be on sys.path. */
function giveLimits(lim: LimitsText): boolean {
  const err = startLimits(R, lim);
  if (err === null) return true;
  process.stderr.write(`sagebrush: ${oneLine(err)}\n`);
  process.exitCode = 2;
  return false;
}

/** For a command that starts workers (notebook, kernel, board): its limits
 * checked, and locked, in this thread's runtime before any worker starts. */
async function serverLimits(lim: LimitsText): Promise<boolean> {
  await initParser();
  R.importModule("sys").path.push(libDir());
  return giveLimits(lim);
}

async function main(argv = process.argv.slice(2), preset?: LimitsText) {
  // --limits FILE (or SAGEBRUSH_LIMITS=FILE, or the launcher's): read now,
  // validated in each runtime before its first statement (src/limits.ts)
  const opt = takeLimitsOption(argv);
  if (opt !== null && typeof opt === "object") {
    process.stderr.write(`sagebrush: ${opt.error}\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  const sel = selectLimits(opt, preset !== undefined ? preset : launcherLimits());
  if (sel !== null && "error" in sel) {
    process.stderr.write(`sagebrush: ${sel.error}\n`);
    process.exitCode = 2;
    return;
  }
  const lim: LimitsText = sel;
  setSessionLimits(lim);
  // (a board's command: loaded only then, src/board-cli.ts, HARD-974-2;
  // `board` with a command it doesn't have is said so there, R0-3, unless
  // there is a script named board here, to run as before)
  if (argv[0] === "board" && (["render", "run", "check", "answers", "try", "open", "-h", "--help"].includes(argv[1]) || !existsSync("board"))) {
    if (!(await serverLimits(lim))) return;
    const { boardCommand } = await import("./board-cli");
    process.exitCode = await boardCommand(argv.slice(1));
    return;
  }
  if (argv[0] === "--install-jupyter-kernel" || argv[0] === "--uninstall-jupyter-kernel") {
    process.exitCode = installKernel(argv.slice(1), argv[0] === "--uninstall-jupyter-kernel");
    return;
  }
  if (argv[0] === "notebook" || argv[0] === "--notebook") {
    if (!(await serverLimits(lim))) return;
    await runNotebookServer(argv.slice(1));
    return;
  }
  if (argv[0] === "--jupyter-kernel") {
    const i = argv.indexOf("--mode");
    if (!(await serverLimits(lim))) return;
    await runKernel(argv[1], (i >= 0 ? argv[i + 1] : "sage") as Mode);
    return;
  }
  // sagebrush --search QUERY [--json]: search the documentation (lib/_pyjs_docsearch.py)
  if (argv[0] === "--search" || argv[0] === "search") argv.splice(0, 1, "-m", "_pyjs_docsearch");
  let emit = false, inspect = false, quiet = false;
  let pkgset: string | null = process.env.SAGEBRUSH_PKGSET || null;
  let cmd: string | null = null, mod: string | null = null, file: string | null = null;
  while (argv.length) {
    const a = argv[0];
    if (a === "--emit") emit = true;
    else if (a === "-i") inspect = true;
    else if (a === "-q") quiet = true;
    else if (a === "--sage") sage = true;
    else if (a === "--magma") magma = true;
    else if (a === "--matlab") matlab = true;
    else if (a === "--pkgset") {
      // (an optional package set for this run: src/pkgcache.ts)
      argv.shift();
      if (!argv.length) {
        process.stderr.write(`--pkgset takes a set id or a pkgset/<id>.json file\n${USAGE}`);
        process.exitCode = 2;
        return;
      }
      pkgset = argv[0];
    } else if (a === "--figures") {
      // (figures to keep, in DIR: made if it isn't there)
      argv.shift();
      if (!argv.length || argv[0].startsWith("-")) {
        process.stderr.write(`--figures takes a directory\n${USAGE}`);
        process.exitCode = 2;
        return;
      }
      try {
        mkdirSync(argv[0], { recursive: true });
      } catch (e: any) {
        process.stderr.write(`--figures: can't make ${oneLine(argv[0])}: ${oneLine(String(e?.code ?? e?.message ?? e))}\n`);
        process.exitCode = 2;
        return;
      }
      figuresDir = argv[0];
      figuresKept = true;
    } else if (a === "-V" || a === "--version") {
      process.stdout.write(VERSION + "\n");
      return;
    } else if (a === "--licenses") {
      const files: [string, string][] = (globalThis as any).__SAGEBRUSH_NOTICES__ ?? [];
      process.stdout.write("Sagebrush is licensed under the MIT license or the Apache License 2.0, at your option; it also contains\nthe components below, each under its own license.\n\n");
      for (const [name, text] of files) process.stdout.write(`==== ${name} ====\n\n${text.trim()}\n\n`);
      if (!files.length) process.stdout.write("(see LICENSE-MIT, LICENSE-APACHE and packages/sagebrush/THIRD-PARTY-NOTICES.txt in the repository)\n");
      return;
    } else if (a === "-h" || a === "--help") {
      process.stdout.write(USAGE);
      return;
    } else if (a === "-c") {
      argv.shift();
      cmd = argv.shift() ?? "";
      break;
    } else if (a === "-m") {
      argv.shift();
      mod = argv.shift() ?? "";
      break;
    } else if (a.startsWith("-") && a !== "-") {
      process.stderr.write(`unknown option ${a}\n${USAGE}`);
      process.exitCode = 2;
      return;
    } else {
      file = argv.shift()!;
      break;
    }
    argv.shift();
  }
  // (a file that can't be read: CPython's message and exit status, not a stack trace)
  if (file !== null && file !== "-") {
    try {
      readFileSync(file, "utf8");
    } catch (e: any) {
      const why: Record<string, [number, string]> = { ENOENT: [2, "No such file or directory"], EACCES: [13, "Permission denied"], EISDIR: [21, "Is a directory"] };
      const [n, msg] = why[e?.code] ?? [Math.abs(e?.errno ?? 0), String(e?.code ?? e)];
      process.stderr.write(`sagebrush: can't open file ${JSON.stringify(resolve(file)).replace(/^"|"$/g, "'")}: [Errno ${n}] ${msg}\n`);
      process.exitCode = 2;
      return;
    }
  }
  await initParser();
  if (emit) {
    if (file === null) {
      process.stderr.write("--emit needs a file\n");
      process.exitCode = 2;
      return;
    }
    if (isMagma(file)) {
      const py = magmaSource(readFileSync(file, "utf8"), file);
      if (py !== null) process.stdout.write(py);
      return;
    }
    if (isMatlab(file)) {
      const py = matlabSource(readFileSync(file, "utf8"), file);
      if (py !== null) process.stdout.write(py);
      return;
    }
    process.stdout.write(compile(readFileSync(file, "utf8"), file, "__main__", false, false, { sage: sage || file.endsWith(".sage") }).code + "\n");
    return;
  }
  const sys = R.importModule("sys");
  sys.argv.length = 0;
  sys.argv.push(cmd !== null ? "-c" : mod !== null ? mod : file ?? "", ...argv);
  if (file !== null && file !== "-") sys.path.push(dirname(resolve(file)));
  else sys.path.push(process.cwd());
  sys.path.push(libDir());
  if (pkgset !== null) {
    try {
      const [S, index, read] = await prepareSet(pkgset, coreBuildId(), reservedNames());
      installPackageSet(S, index, read);
    } catch (e: any) {
      process.stderr.write(`sagebrush: package set: ${oneLine(String(e?.message ?? e))}\n`);
      process.exitCode = 2;
      return;
    }
  }
  // (the limits, before the first statement of any program or prompt)
  if (!giveLimits(lim)) return;
  let code: number | null = null;
  let main: any = null;
  const interactive = (file === null && cmd === null && mod === null && process.stdin.isTTY) || inspect;
  if (cmd !== null && isMatlab(null)) {
    main = mainModule("<string>");
    const py = matlabSource(cmd, "<string>");
    // (a syntax error, reported: exit status 1)
    code = py === null ? 1 : guarded(() => R.loader.exec(py, main, "exec", "<string>", opts()));
  } else if (cmd !== null && isMagma(null)) {
    main = mainModule("<string>");
    const py = magmaSource(cmd, "<string>");
    if (py !== null) code = guarded(() => R.loader.exec(py, main, "exec", "<string>", opts()));
  } else if (cmd !== null) {
    main = mainModule("<string>");
    code = guarded(() => R.loader.exec(helpSyntax(cmd!), main, "exec", "<string>", opts()));
  } else if (mod !== null) {
    code = guarded(() => {
      main = execModuleAsMain(mod!);
    });
  } else if (file !== null && file !== "-" && isMatlab(file)) {
    const py = matlabSource(readFileSync(file, "utf8"), file);
    code = py === null ? 1 : guarded(() => {
      main = execModule(py, file!, "__main__", false, false);
    });
  } else if (file !== null && file !== "-" && isMagma(file)) {
    const py = magmaSource(readFileSync(file, "utf8"), file);
    if (py !== null) code = guarded(() => {
      main = execModule(py, file!, "__main__", false, false);
    });
  } else if (file !== null && file !== "-") {
    const source = readFileSync(file, "utf8");
    code = guarded(() => {
      main = execModule(source, file!, "__main__", false, sage || file!.endsWith(".sage"));
    });
  } else if (!interactive && isMatlab(null)) {
    // MATLAB on stdin (or `--matlab -`): a program, run as a file of it is, up to its first
    // error, which gives exit status 1, as `matlab -batch` does
    main = mainModule("<stdin>");
    const src = readStdin();
    const py = src === null ? null : matlabSource(src, "<stdin>");
    code = py === null ? 1 : guarded(() => R.loader.exec(py, main, "exec", "<stdin>", opts()));
  } else if (!interactive && isMagma(null)) {
    // Magma on stdin: a session, as `magma < file` is
    main = mainModule("<stdin>");
    const src = readStdin();
    const py = src === null ? null : magmaSource(src, "<stdin>", "session");
    if (src === null) code = 1;
    else if (py !== null) code = guarded(() => R.loader.exec(py, main, "exec", "<stdin>", opts()));
  } else if (!interactive) {
    // program on stdin
    const source = readStdin();
    main = mainModule("<stdin>");
    code = source === null ? 1 : guarded(() => R.loader.exec(source, main, "exec", "<stdin>", opts()));
  }
  flushFiles();
  R.stdout.flush();
  R.stderr.flush();
  if (interactive && (code === null || inspect)) {
    main ??= mainModule("<stdin>");
    code = await repl(main, quiet || inspect);
  }
  flushFiles();
  R.stdout.flush();
  R.stderr.flush();
  process.exitCode = code ?? 0;
  if (keyboardInterrupt && code === 130) endByInterrupt();
}

// A program run by the launcher (packages/sagebrush/bin/sagebrush.cjs) in a
// worker thread, so that Ctrl-C reaches it: the interrupt flag goes to the
// launcher, whose SIGINT handler sets it, and this thread's process.stdout
// and process.stderr write straight to the descriptors, as the runtime's
// own streams do, so that everything comes out in the order written.
function cliWorker(argv: string[], limits?: LimitsText) {
  parentPort!.postMessage({ interrupt: R.INTR.buffer instanceof SharedArrayBuffer ? R.INTR.buffer : null });
  // (a full non-blocking pipe: EAGAIN or nothing written; waited on with a
  // backoff of 1 ms doubling to 50 ms, as readStdin waits, not spun on)
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (const [stream, fd] of [[process.stdout, 1], [process.stderr, 2]] as [any, number][]) {
    stream.write = (chunk: any, enc?: any, cb?: any) => {
      const data = typeof chunk === "string" ? Buffer.from(chunk, typeof enc === "string" ? (enc as BufferEncoding) : "utf8") : Buffer.from(chunk);
      for (let off = 0, wait = 1; off < data.length; ) {
        let n = 0;
        try {
          n = writeSync(fd, data, off);
        } catch (e: any) {
          if (e?.code !== "EAGAIN") throw e;
        }
        if (n > 0) {
          off += n;
          wait = 1;
        } else {
          Atomics.wait(pause, 0, 0, wait);
          wait = Math.min(2 * wait, 50);
        }
      }
      (typeof enc === "function" ? enc : cb)?.();
      return true;
    };
  }
  return main(argv, limits);
}

// Files written but never closed (no reference counting): write them, as
// CPython does when it collects them (lib/_pyjs_open.py).
function flushFiles() {
  // no Python import here: a program may have replaced __import__
  const o = R.sysModules.$m.get("_pyjs_open");
  if (o) guarded(() => R.callObj(getattr(o, "_flush_all"), []));
}

// `-m name`: find the module's source along sys.path and run it as __main__.
function execModuleAsMain(name: string): any {
  const found = findModuleSource(name);
  if (found === null) {
    R.stderr.write(`pyjs: No module named ${name}\n`);
    throw R.T.SystemExit(1);
  }
  R.importModule("sys").argv[0] = found[1];
  return execModule(found[0], found[1], "__main__");
}

if (isMainThread) main();
else if (workerData?.sagebrushCli) cliWorker(workerData.sagebrushCli.argv, workerData.sagebrushCli.limits);
else if (workerData?.sagebrushKernel) kernelWorker(workerData.sagebrushKernel);
else if (workerData?.sagebrushNotebook) notebookWorker(workerData.sagebrushNotebook);
// (`board run`'s interpreter, src/board-run.ts)
else if (workerData?.sagebrushBoardRun) import("./board-run").then((m) => m.boardRunWorker(workerData.sagebrushBoardRun));
