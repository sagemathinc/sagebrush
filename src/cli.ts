// pyjs: run Python programs, or an interactive prompt.
//
//   sagebrush                 interactive prompt
//   pyjs program.py [args]    run a program
//   pyjs -c 'code' [args]     run a string
//   pyjs -m module [args]     run a library module as __main__
//   pyjs -i program.py        run, then stay interactive
//   pyjs --emit program.py    print the generated JavaScript

import { readFileSync, readSync, writeSync, mkdirSync, appendFileSync, writeFileSync, existsSync, realpathSync, mkdtempSync, rmSync, rmdirSync, unlinkSync, readdirSync, lstatSync, opendirSync, type Dirent } from "fs";
import { dirname, resolve, join } from "path";
import { createRequire } from "module";
import { homedir, tmpdir } from "os";
import { isatty } from "tty";
import * as readline from "readline";
import { PassThrough } from "stream";
import { oneLine } from "./terminal-text";
import { initParser, compile, execModule, R, libDir, findModuleSource, packageModuleNames, installPackageSet, coreBuildId, reservedNames } from "./compile";
import { prepareSet } from "./pkgcache";
import { magmaToPython, magmaIsIncomplete, MagmaSyntaxError, magmaSyntaxMessage, type Recover } from "./magma";
import { installMagmaCompile } from "./magma-builtin";
import { matlabToPython, MatlabSyntaxError, matlabSyntaxMessage, matlabHostOps, matlabIsIncomplete, looksLikeMagma } from "./matlab";
import { needsMore, completeIn, helpSyntax, ipythonSyntax } from "./interactive";
import { MAGIC_PRE, MAGIC_POST, GET_IPYTHON, magicTransform } from "./magic-syntax";
import { getattr, unbox } from "./runtime/object";
import { isMainThread, workerData, parentPort, Worker } from "worker_threads";
import { installKernel, runKernel, kernelWorker, Mode, FIGURE_MODES } from "./kernel";
import { runNotebookServer, notebookWorker } from "./notebook";
import { takeLimitsOption, launcherLimits, startLimits, setSessionLimits, type LimitsText } from "./limits";
import { selectLimits } from "./limits-file";
import { setDataRoot } from "./runtime/modules";
import { rillRefusal, rillSource } from "./rill";
import { sprigRefusal, sprigSource } from "./sprig";
import type { ReplMode } from "./modes";
import { PromptSession, type StepResult } from "./repl-step";

// __pyjs_compile_magma__: Magma for one Python driver, `sagebrush latex run` (src/magma-builtin.ts)
installMagmaCompile(R);

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
  --data-root DIR
           the folder whose .sagebrush-data snapshots urllib.request may
           replay (default: the starting directory); nothing above it is used
  --emit   print the JavaScript compiled from file (with --magma or --matlab: the Python)
  -V       print the version
  --licenses  the licenses of Sagebrush and of what it contains
  --search QUERY [--mode sage|python|magma|matlab] [--limit N] [--json]
           search the documentation of every function (name, signature,
           docstring): what Sagebrush can do; obj? in a session shows one.
           --mode: that language's functions (default: Sage's library,
           which Python mode imports too)
  --install-jupyter-kernel [--user | --sys-prefix | --prefix DIR] [--mode sage|python|magma|matlab|all]
                           [--figures auto|svg|png|both]
           register Sagebrush as a Jupyter kernel (no Python needed); --figures:
           how its figures are shown (default auto: an SVG, or a sharp PNG
           when the SVG would be over 1 MiB; also SAGEBRUSH_FIGURES)
  --uninstall-jupyter-kernel [the same options]
  notebook [DIR] [--port N] [--no-browser]
           the Sagebrush notebook in your browser, running Python here;
           notebooks are the .ipynb files in DIR
  board open FILE [--port N] [--no-browser]
           a board in your browser, shown again each time FILE changes
           (sagebrush board --help: every board command)
  latex check|run|render FILE.tex [--png DIR]
           check a .tex file as Sagebrush's LaTeX editor shows it, run its
           SageTeX code, and see it: an HTML file, and a PNG per beamer frame
           (sagebrush latex --help)

Examples: https://sagebrush.space/examples/ (in the page: File > Examples…)
`;

// (src/exit-status.ts is the Terminal worker's copy of exitCode and guarded below, kept apart on purpose: moving
// these out of this module changed the minified CLI bundle by 77 KB.  A change to one is made to both)
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
// (brief: a KeyboardInterrupt as its name alone, as MATLAB's and Magma's prompts show it: their frames are the
// translation's, not the user's)
function guarded(fn: () => void, brief = false): number | null {
  try {
    fn();
    return null;
  } catch (e: any) {
    const exc = R.toPyExc(e);
    if (R.typeOf(exc).$mro.includes(R.T.SystemExit)) return exitCode(exc.code);
    R.stdout.flush();
    R.stderr.write(brief && R.typeOf(exc).$mro.includes(R.T.KeyboardInterrupt) ? "KeyboardInterrupt\n" : R.formatException(exc));
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
    // (the prompt's worker tells its front, which removes them if the process ends by a signal)
    if (promptHost) parentPort?.postMessage({ figures: { dir: figuresDir, kept: false } });
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
// --rill: R (src/rill.ts), hidden until design/rill.md's A1.7
let rill = false;
// --sprig: Sprig (src/sprig.ts), hidden until the S1 plan's S1.4
let sprig = false;
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
function matlabSource(src: string, file: string, asFile = false): string | null {
  try {
    return matlabToPython(src, file, { file: asFile });
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
    process.stdout.write(magmaSyntaxMessage(e, src, file));
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
  if (sage) R.loader.exec("from sage_all import *\nimport _sage_lazy as _sage_lazy_; _sage_lazy_.bind(globals()); del _sage_lazy_\n", m, "exec", "<sage>");
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

function completer(main: any, mode: string) {
  return (line: string): [string[], string] => completeIn(mode, main, line, moduleNames);
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

/** The line being typed, dropped without redrawing it (a Ctrl-C at the prompt starts a new one, as CPython's does). */
function clearLine(rl: readline.Interface) {
  (rl as any).line = "";
  (rl as any).cursor = 0;
}

/** A disappearing terminal can report an I/O error before SIGHUP is delivered (in particular, readline writes
 * its cursor after the visible prompt). Take the same exit path; other stream errors remain fatal. */
function terminalHangup(hangup: () => void) {
  const error = (e: NodeJS.ErrnoException) => {
    if (e.code === "EIO" || e.code === "EPIPE" || e.code === "ECONNRESET") hangup();
    else throw e;
  };
  process.stdin.on("error", error);
  process.stdout.on("error", error);
  return { error, dispose: () => {
    process.stdin.off("error", error);
    process.stdout.off("error", error);
  } };
}

function repl(main: any, quiet: boolean, mode: ReplMode = "python"): Promise<number> {
  removeFiguresOnSignal();
  const terminal = terminalHangup(() => {
    removeFigures();
    process.removeAllListeners("SIGHUP");
    process.kill(process.pid, "SIGHUP");
  });
  const leave = mode === "magma" ? "quit; or Ctrl-D to leave" : mode === "matlab" ? "exit or Ctrl-D to leave" : "exit() or Ctrl-D to leave";
  if (!quiet) process.stdout.write(mode === "python" ? `${VERSION}\nType help(obj) for help, ${leave}.\n` : `${VERSION} (${mode === "magma" ? "Magma" : "MATLAB"})\nType ${leave}.\n`);
  // (the session's step, shared with the Terminal's prompt: src/repl-step.ts; the language's library and
  // get_ipython() loaded before the first prompt rather than at the first input)
  const session = new PromptSession(main, mode, sage, {
    guarded,
    out: (t) => process.stdout.write(t),
    err: (t) => process.stderr.write(t),
    syntaxError: () => {
      process.exitCode = 1;
    },
    flushFiles,
  });
  session.start();
  const hist = historyFile();
  let history: string[] = [];
  if (hist) {
    try {
      history = readFileSync(hist, "utf8").split("\n").filter((l) => l).reverse().slice(0, 1000);
    } catch {
      // no history yet
    }
  }
  // (completion in the prompt's language: src/interactive.ts completeIn)
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, completer: completer(main, mode), history, historySize: 1000, terminal: process.stdin.isTTY });
  rl.on("error", terminal.error); // (readline forwards input errors too)
  const ps1 = () => session.ps1();
  const ps2 = () => session.ps2();
  let buf: string[] = [];
  rl.setPrompt(ps1());
  rl.prompt();
  return new Promise((resolveExit) => {
    let done = false;
    const finish = (code: number) => {
      if (done) return;
      done = true;
      R.stdout.flush();
      rl.close();
      terminal.dispose();
      resolveExit(code);
    };
    rl.on("line", (line) => {
      buf.push(line);
      const src = buf.join("\n");
      if (session.incomplete(src)) {
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
        let r: StepResult;
        try {
          r = session.run(src);
        } finally {
          promptSignals(false);
        }
        if ("end" in r) return finish(r.end);
        if (r.code !== null && r.code !== 1) return finish(r.code);
      }
      rl.setPrompt(ps1());
      rl.prompt();
    });
    rl.on("SIGINT", () => {
      buf = [];
      clearLine(rl);
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

// ------------------------------------------------------------------ the prompt in a worker
//
// Ctrl-C must reach an input that is running, a call into the engine included: a signal handler runs only when
// its thread is idle, so the prompt's inputs run in a worker (promptBack, with the session's __main__ and everything
// it computes), and this thread keeps the terminal (readline, the history, the completions it asks the worker for)
// and stays idle while an input runs. A Ctrl-C then sets the interrupt flag the compiled code polls, as the launcher
// does for a program: the call raises KeyboardInterrupt, and the prompt comes back with the session as it was. A
// second Ctrl-C within 2 s, while the first is still unseen (a call that does not poll), ends the process as SIGINT's
// default action would. The terminal stays in raw mode: while the worker runs an input this thread reads the keys,
// a Ctrl-C among them, and keeps the rest for readline; while it waits for an input, readline has them, and Ctrl-C
// clears the line as before. A SIGINT from kill is a Ctrl-C too. SAGEBRUSH_NO_WORKER keeps the prompt on this
// thread (repl).

/** promptHost: set in the prompt's worker (promptWorker), where main() runs the prompt as promptBack. */
let promptHost = false;

/** Whether this thread starts the prompt's worker: the process's main thread, unless SAGEBRUSH_NO_WORKER, with
 * shared memory for the flag and a file to start the worker on. */
function promptInWorker(): boolean {
  if (!isMainThread || typeof SharedArrayBuffer === "undefined") return false;
  try {
    if (process.env.SAGEBRUSH_NO_WORKER) return false;
  } catch {} // (a Deno without --allow-env)
  return cliEntry() !== null;
}

type FrontMsg = { interrupt?: SharedArrayBuffer | null; ready?: { ps1: string; ps2: string }; step?: { end?: number; ps1: string; ps2: string }; incomplete?: boolean; complete?: [string[], string]; figures?: { dir: string; kept: boolean }; keyboardInterrupt?: boolean };

/** This thread's side of the prompt: the terminal, and the worker running main(argv) with the prompt in it. Resolves
 * to the exit status. */
function promptFront(argv: string[], limits: LimitsText): Promise<number> {
  // (this process's own entry, as the kernel's and the notebook's workers: the npm launcher, started in a worker,
  // loads the bundle, which runs the prompt's side by its workerData; stdout and stderr written to fds 1 and 2 by the
  // worker itself, so that its output and this thread's prompts come out in the order written)
  const entry = require.main?.filename ?? process.argv[1];
  const worker = new Worker(entry, { stdout: true, stderr: true, workerData: { sagebrushPrompt: { argv, limits } } });
  let intr: Int32Array | null = null, last = 0, interrupted = false, busy = true;
  let figures: { dir: string; kept: boolean } | null = null;
  const tty = process.stdin.isTTY === true;
  // (the terminal is in raw mode from the start to the end, as readline keeps it at the prompt: a Ctrl-C is the key's
  // byte, read here while an input runs, and what is typed meanwhile isn't echoed until readline takes it)
  const raw = (on: boolean) => {
    if (tty) try { process.stdin.setRawMode(on); } catch {}
  };
  raw(true);
  // (and out of it however this thread ends, an exception's end included)
  process.on("exit", () => raw(false));
  const removeFiguresHere = () => { if (figures !== null && !figures.kept) try { rmSync(figures.dir, { recursive: true, force: true }); } catch {} };
  // Closing a pty does not invariably reach us as SIGHUP: a write to the
  // vanished terminal can fail first and make Node exit with status 1.  The
  // worker cannot then finish its own cleanup, so cover every ordinary exit
  // in this front thread too (rmSync is deliberately safe to repeat).
  process.on("exit", removeFiguresHere);
  const die = (sig: NodeJS.Signals) => {
    removeFiguresHere();
    raw(false);
    void worker.terminate();
    process.removeAllListeners(sig);
    process.kill(process.pid, sig);
  };
  const terminal = terminalHangup(() => die("SIGHUP"));
  // (Ctrl-C while an input runs, the key or a SIGINT: the flag, as the launcher sets it. Another while the first is
  // still unseen: within GRACE of it, the same press (a double tap lands both before any call could have polled);
  // from GRACE to 2 s, or one before the worker has handed over its flag: SIGINT's default action)
  const GRACE = 1000; // (ms: four times the 250 ms in which a polling call honours a press)
  const press = () => {
    const now = Date.now();
    if (intr === null) return die("SIGINT");
    if ((Atomics.load(intr, 0) & 1) !== 0 && now - last < 2000) {
      if (now - last < GRACE) return;
      return die("SIGINT");
    }
    last = now;
    Atomics.or(intr, 0, 1); // (bit 0, Ctrl-C: the word's other bits left, src/runtime/interrupt.ts)
    Atomics.notify(intr, 0); // (a time.sleep waits on the flag)
  };
  // (a SIGINT while the prompt waits for an input comes from kill, not the key (readline has that): it ends the
  // process as before, its figures removed)
  process.on("SIGINT", () => (busy ? press() : die("SIGINT")));
  // (SIGTERM and SIGHUP, a closed terminal's: their default action, the worker's figures removed first)
  for (const sig of ["SIGTERM", "SIGHUP"] as const) process.on(sig, () => die(sig));
  // What is typed goes to readline one line at a time: a line is given to it once the one before has run, so that
  // lines typed or pasted ahead are echoed each after the output before it, as at a prompt that runs them on its
  // own thread (repl). While an input runs, a Ctrl-C byte is the press above.
  const inp = new PassThrough();
  let held = "", eof = false, lineOut = false, sawLine = false;
  const feed = () => {
    while (held !== "" && !busy && !lineOut) {
      const m = /\r\n?|\n/.exec(held);
      const end = m === null ? held.length : m.index + m[0].length;
      const part = held.slice(0, end);
      held = held.slice(end);
      if (m !== null) {
        // (a line: the next waits until it has run; a terminator readline makes no line of waits for nothing)
        lineOut = true;
        sawLine = false;
        setImmediate(() => {
          if (!sawLine) {
            lineOut = false;
            feed();
          }
        });
      }
      inp.write(part);
    }
    if (held === "" && eof && !inp.writableEnded) inp.end();
  };
  process.stdin.setEncoding("utf8");
  const onData = (d: string) => {
    // (while an input runs, a Ctrl-C is the press; just after one stopped it, within the grace, the rest of a double
    // tap, not a Ctrl-C at the prompt)
    if (tty && d.includes("\x03") && (busy || Date.now() - last < GRACE)) {
      if (busy) press();
      d = d.replace(/\x03/g, "");
    }
    held += d;
    feed();
  };
  const onEnd = () => {
    eof = true;
    feed();
  };
  process.stdin.on("data", onData);
  process.stdin.on("end", onEnd);
  let rl: readline.Interface | null = null;
  // (what the worker answers, in order: one question at a time is asked)
  const waiting: ((m: FrontMsg) => void)[] = [];
  const ask = (m: object) => new Promise<FrontMsg>((res) => {
    waiting.push(res);
    worker.postMessage(m);
  });
  let ready: (m: FrontMsg) => void = () => {};
  const started = new Promise<FrontMsg>((res) => (ready = res));
  worker.on("message", (m: FrontMsg) => {
    if (!m || typeof m !== "object") return;
    if ("interrupt" in m) intr = m.interrupt ? new Int32Array(m.interrupt) : null;
    else if (m.figures) figures = m.figures;
    else if (m.keyboardInterrupt) interrupted = true;
    else if (m.ready) ready(m);
    else waiting.shift()?.(m);
  });
  return new Promise<number>((resolveExit) => {
    let done = false;
    // (the end: this thread lets go of the terminal, and the worker's figures go if it couldn't remove them itself)
    const finish = (code: number) => {
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.pause();
      raw(false);
      removeFiguresHere();
      terminal.dispose();
      if (interrupted) return die("SIGINT");
      resolveExit(code);
    };
    const close = (code: number) => {
      done = true;
      worker.postMessage({ close: true });
      worker.once("exit", (c) => finish(c ?? code));
    };
    worker.on("error", (e) => {
      process.stderr.write(`sagebrush: ${(e as any)?.stack ?? e}\n`);
      process.exitCode = 1;
    });
    worker.on("exit", (code) => {
      if (done) return;
      done = true;
      rl?.close();
      finish(code ?? 0);
    });
    started.then((first) => {
      if (done) return;
      let ps1 = first.ready!.ps1, ps2 = first.ready!.ps2;
      const hist = historyFile();
      let history: string[] = [];
      if (hist) {
        try {
          history = readFileSync(hist, "utf8").split("\n").filter((l) => l).reverse().slice(0, 1000);
        } catch {
          // no history yet
        }
      }
      // (the completions, from the worker's session: src/interactive.ts completeIn there)
      const completer = (line: string, cb: (err: null, r: [string[], string]) => void) => {
        if (busy) return cb(null, [[], line]);
        ask({ complete: line }).then((m) => cb(null, m.complete ?? [[], line]));
      };
      rl = readline.createInterface({ input: inp, output: process.stdout, completer, history, historySize: 1000, terminal: tty });
      rl.on("error", terminal.error);
      let buf: string[] = [];
      // (one line at a time, from feed: the next is given once this one is done)
      const take = async (line: string) => {
        buf.push(line);
        const src = buf.join("\n");
        if ((await ask({ incomplete: src })).incomplete) {
          rl!.setPrompt(ps2);
          rl!.prompt();
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
          busy = true;
          const m = await ask({ run: src });
          busy = false;
          const st = m.step!;
          ps1 = st.ps1;
          ps2 = st.ps2;
          if (st.end !== undefined) {
            // (the session ends: the worker finishes main(), and its exit gives the status)
            rl!.close();
            return close(st.end);
          }
        }
        rl!.setPrompt(ps1);
        rl!.prompt();
      };
      // (the line being taken: at the input's end, readline closes once it has its last line, which runs first)
      let taking: Promise<void> = Promise.resolve();
      rl.on("line", (line) => {
        sawLine = true;
        taking = take(line).then(() => {
          lineOut = false;
          if (!done) feed();
        });
      });
      rl.on("SIGINT", () => {
        if (busy) return;
        buf = [];
        clearLine(rl!);
        process.stdout.write("\nKeyboardInterrupt\n");
        rl!.setPrompt(ps1);
        rl!.prompt();
      });
      rl.on("close", () => {
        taking.then(() => {
          if (done) return;
          if (tty) process.stdout.write("\n");
          close(0);
        });
      });
      rl.setPrompt(ps1);
      rl.prompt();
      busy = false;
      feed();
    });
  });
}

/** The worker's side of the prompt: the session, one message at a time from promptFront (is an input complete,
 * run it, complete a line, close), each answered in order. Resolves to the prompt's exit status. */
function promptBack(main: any, quiet: boolean, mode: ReplMode = "python"): Promise<number> {
  const leave = mode === "magma" ? "quit; or Ctrl-D to leave" : mode === "matlab" ? "exit or Ctrl-D to leave" : "exit() or Ctrl-D to leave";
  if (!quiet) process.stdout.write(mode === "python" ? `${VERSION}\nType help(obj) for help, ${leave}.\n` : `${VERSION} (${mode === "magma" ? "Magma" : "MATLAB"})\nType ${leave}.\n`);
  const session = new PromptSession(main, mode, sage, {
    // (a KeyboardInterrupt at the prompt is reported and the prompt goes on, as CPython's: its status isn't the
    // session's, and it doesn't end the process when the prompt does)
    guarded: (fn) => {
      const code = guarded(fn, mode !== "python");
      if (code === 130 && keyboardInterrupt) {
        keyboardInterrupt = false;
        return null;
      }
      return code;
    },
    out: (t) => process.stdout.write(t),
    err: (t) => process.stderr.write(t),
    syntaxError: () => {
      process.exitCode = 1;
    },
    flushFiles,
  });
  session.start();
  R.stdout.flush();
  R.stderr.flush();
  const port = parentPort!;
  port.postMessage({ ready: { ps1: session.ps1(), ps2: session.ps2() } });
  return new Promise<number>((resolveExit) => {
    let done = false;
    const finish = (code: number) => {
      if (done) return;
      done = true;
      port.removeAllListeners("message");
      // (the port no longer keeps this worker up: it ends when main() does, as a program's worker does)
      port.unref();
      R.stdout.flush();
      resolveExit(code);
    };
    let ended: number | null = null;
    port.on("message", (m: any) => {
      if (!m || typeof m !== "object") return;
      if (m.close) return finish(ended ?? 0);
      if (typeof m.incomplete === "string") return port.postMessage({ incomplete: session.incomplete(m.incomplete) });
      if (typeof m.complete === "string") {
        let r: [string[], string] = [[], m.complete];
        try {
          r = completeIn(mode, main, m.complete, moduleNames);
        } catch {}
        return port.postMessage({ complete: r });
      }
      if (typeof m.run === "string") {
        const r: StepResult = session.run(m.run);
        R.stdout.flush();
        R.stderr.flush();
        let end: number | undefined;
        if ("end" in r) end = r.end;
        else if (r.code !== null && r.code !== 1) end = r.code;
        if (end !== undefined) ended = end;
        port.postMessage({ step: { end, ps1: session.ps1(), ps2: session.ps2() } });
      }
    });
  });
}

/** The prompt's worker (promptFront): main() on the arguments as given, with the prompt as promptBack. Its stdout
 * and stderr written to fds 1 and 2 as a program's are (cliWorker). */
function promptWorker(argv: string[], limits?: LimitsText) {
  promptHost = true;
  return cliWorker(argv, limits);
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
  // (the arguments as given, --limits FILE taken out: the prompt's worker runs this main() on them, promptFront)
  const given = argv.slice();
  // (a board's command: loaded only then, src/board-cli.ts, HARD-974-2;
  // `board` with a command it doesn't have is said so there, R0-3, unless
  // there is a script named board here, to run as before)
  if (argv[0] === "board" && (["render", "run", "check", "answers", "try", "open", "-h", "--help"].includes(argv[1]) || !existsSync("board"))) {
    if (!(await serverLimits(lim))) return;
    const { boardCommand } = await import("./board-cli");
    process.exitCode = await boardCommand(argv.slice(1));
    return;
  }
  // (`latex`: the LaTeX editor's engine, in a file of its own beside this one, src/latex-cli.ts; a script named latex
  // here runs as before unless a latex command is asked for)
  if (argv[0] === "latex" && (["check", "run", "render", "-h", "--help", "help"].includes(argv[1]) || !existsSync("latex"))) {
    const latex = loadLatex();
    if (typeof latex === "string") { process.stderr.write(`sagebrush: ${latex}\n`); process.exitCode = 2; return; }
    // (cli: the file this process runs from, the bundle or the npm launcher, for `latex run`'s Sage session)
    process.exitCode = await latex.latexCommand(argv.slice(1), { cli: cliEntry() ?? undefined });
    return;
  }
  if (argv[0] === "--install-jupyter-kernel" || argv[0] === "--uninstall-jupyter-kernel") {
    process.exitCode = installKernel(argv.slice(1), argv[0] === "--uninstall-jupyter-kernel");
    return;
  }
  // (sagebrush notebook run FILE.ipynb: src/notebook-run.ts; as `board`'s commands: `run` is the command unless a
  // folder named run is here and nothing names a notebook, when it is still the server's folder)
  if (argv[0] === "notebook" && argv[1] === "run" && argv.length > 2 && (argv.slice(2).some((a) => /\.ipynb$/i.test(a) || a === "-h" || a === "--help") || !existsSync("run"))) {
    process.exitCode = await (await import("./notebook-run")).notebookRun(argv.slice(2));
    return;
  }
  if (argv[0] === "notebook" || argv[0] === "--notebook") {
    if (!(await serverLimits(lim))) return;
    await runNotebookServer(argv.slice(1));
    return;
  }
  if (argv[0] === "--jupyter-kernel") {
    const i = argv.indexOf("--mode");
    // (an optional package set for its cells, as for a run: --pkgset ID|FILE, or SAGEBRUSH_PKGSET)
    const j = argv.indexOf("--pkgset");
    if (j >= 0 && !argv[j + 1]) {
      process.stderr.write("--pkgset takes a set id or a pkgset/<id>.json file\n");
      process.exitCode = 2;
      return;
    }
    // (how its figures are shown, unless a notebook's code says: --figures, or SAGEBRUSH_FIGURES; else "auto")
    const k = argv.indexOf("--figures");
    const figures = k >= 0 ? argv[k + 1] : process.env.SAGEBRUSH_FIGURES || null;
    if (figures !== null && !FIGURE_MODES.includes(figures)) {
      process.stderr.write(`--figures (or SAGEBRUSH_FIGURES) takes ${FIGURE_MODES.join(", ")}, not ${JSON.stringify(figures)}\n`);
      process.exitCode = 2;
      return;
    }
    if (!(await serverLimits(lim))) return;
    await runKernel(argv[1], (i >= 0 ? argv[i + 1] : "sage") as Mode, j >= 0 ? argv[j + 1] : process.env.SAGEBRUSH_PKGSET || null, figures);
    return;
  }
  // sagebrush --search QUERY [--json]: search the documentation (lib/_pyjs_docsearch.py)
  if (argv[0] === "--search" || argv[0] === "search") argv.splice(0, 1, "-m", "_pyjs_docsearch");
  let emit = false, inspect = false, quiet = false;
  let pkgset: string | null = process.env.SAGEBRUSH_PKGSET || null;
  let cmd: string | null = null, mod: string | null = null, file: string | null = null;
  let dataRootArg: string | null = null;
  while (argv.length) {
    const a = argv[0];
    if (a === "--emit") emit = true;
    else if (a === "-i") inspect = true;
    else if (a === "-q") quiet = true;
    else if (a === "--sage") sage = true;
    else if (a === "--magma") magma = true;
    else if (a === "--matlab") matlab = true;
    else if (a === "--rill") rill = true;
    else if (a === "--sprig") sprig = true;
    else if (a === "--pkgset") {
      // (an optional package set for this run: src/pkgcache.ts)
      argv.shift();
      if (!argv.length) {
        process.stderr.write(`--pkgset takes a set id or a pkgset/<id>.json file\n${USAGE}`);
        process.exitCode = 2;
        return;
      }
      pkgset = argv[0];
    } else if (a === "--data-root") {
      // (the data replay layer's root, lib/_sbdata.py: an existing directory;
      // default, the starting directory)
      argv.shift();
      if (!argv.length || !existsSync(argv[0])) {
        process.stderr.write(`--data-root takes an existing directory\n${USAGE}`);
        process.exitCode = 2;
        return;
      }
      dataRootArg = argv[0];
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
  // (--rill runs only -c until design/rill.md's A1.7: refused before any file is opened)
  if (rill) {
    const why = rillRefusal({ cmd, file, mod, inspect, emit });
    if (why !== null) {
      process.stderr.write(`sagebrush: ${why}\n`);
      process.exitCode = 2;
      return;
    }
  }
  // (--sprig runs only -c until the S1 plan's S1.4: refused before any file is opened)
  if (sprig) {
    const why = sprigRefusal({ cmd, file, mod, inspect, emit });
    if (why !== null) {
      process.stderr.write(`sagebrush: ${why}\n`);
      process.exitCode = 2;
      return;
    }
  }
  // (fixed before any Python runs: a program can't move it, replay-layer r2 §2.2)
  setDataRoot(dataRootArg ?? process.cwd());
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
      const py = matlabSource(readFileSync(file, "utf8"), file, true);
      if (py !== null) process.stdout.write(py);
      return;
    }
    process.stdout.write(compile(readFileSync(file, "utf8"), file, "__main__", false, false, { sage: sage || file.endsWith(".sage") }).code + "\n");
    return;
  }
  // (in the prompt's worker the prompt is always interactive: its stdin is no terminal of its own)
  const interactive = promptHost || (file === null && cmd === null && mod === null && process.stdin.isTTY) || inspect;
  // (an interactive prompt runs its inputs, and -i's program, in a worker, so that Ctrl-C reaches a call that is
  // running: this thread keeps the terminal and stays idle, as the launcher's does for a program)
  if (interactive && promptInWorker()) {
    process.exitCode = await promptFront(given, lim);
    return;
  }
  // (a program's stdin that is a pipe or a file: input() reads its lines, as CPython's does; a terminal's isn't read.
  // isatty(0), never process.stdin: opening that stream puts a pipe in non-blocking mode, and stdin's readSync then
  // spins on EAGAIN while a slow writer has nothing to send)
  if (!interactive && !isatty(0)) R.stdinInput = true;
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
  // (the __main__ of a -c program or of one on stdin, made first: with --sage, its `from sage_all import *` may
  // raise, and that is reported as a program's own exception is, a traceback and exit status 1, never an
  // unhandled rejection; nothing else runs then)
  const named = cmd !== null ? "<string>" : mod === null && (file === null || file === "-") && !interactive ? "<stdin>" : null;
  if (named !== null) code = guarded(() => void (main = mainModule(named)));
  const started = code === null;
  if (!started) {
    // (the startup raised: reported, and the program doesn't run)
  } else if (cmd !== null && sprig) {
    code = guarded(() => R.loader.exec(sprigSource(cmd!), main, "exec", "<string>", opts()));
  } else if (cmd !== null && rill) {
    code = guarded(() => R.loader.exec(rillSource(cmd!), main, "exec", "<string>", opts()));
  } else if (cmd !== null && isMatlab(null)) {
    const py = matlabSource(cmd, "<string>");
    // (a syntax error, reported: exit status 1)
    code = py === null ? 1 : guarded(() => R.loader.exec(py, main, "exec", "<string>", opts()));
  } else if (cmd !== null && isMagma(null)) {
    const py = magmaSource(cmd, "<string>");
    if (py !== null) code = guarded(() => R.loader.exec(py, main, "exec", "<string>", opts()));
  } else if (cmd !== null) {
    code = guarded(() => R.loader.exec(helpSyntax(cmd!), main, "exec", "<string>", opts()));
  } else if (mod !== null) {
    code = guarded(() => {
      main = execModuleAsMain(mod!);
    });
  } else if (file !== null && file !== "-" && isMatlab(file)) {
    const py = matlabSource(readFileSync(file, "utf8"), file, true);
    code = py === null ? 1 : guarded(() => {
      main = execModule(py, file!, "__main__", false, false, (m) => (main = m));
    });
  } else if (file !== null && file !== "-" && isMagma(file)) {
    const py = magmaSource(readFileSync(file, "utf8"), file);
    if (py !== null) code = guarded(() => {
      main = execModule(py, file!, "__main__", false, false, (m) => (main = m));
    });
  } else if (file !== null && file !== "-") {
    const source = readFileSync(file, "utf8");
    code = guarded(() => {
      // (made: the module as soon as it exists, so that -i after a program that raised has what it defined)
      main = execModule(source, file!, "__main__", false, sage || file!.endsWith(".sage"), (m) => (main = m));
    });
  } else if (!interactive && isMatlab(null)) {
    // MATLAB on stdin (or `--matlab -`): a program, run as a file of it is, up to its first
    // error, which gives exit status 1, as `matlab -batch` does
    const src = readStdin();
    const py = src === null ? null : matlabSource(src, "<stdin>");
    code = py === null ? 1 : guarded(() => R.loader.exec(py, main, "exec", "<stdin>", opts()));
  } else if (!interactive && isMagma(null)) {
    // Magma on stdin: a session, as `magma < file` is
    const src = readStdin();
    const py = src === null ? null : magmaSource(src, "<stdin>", "session");
    if (src === null) code = 1;
    else if (py !== null) code = guarded(() => R.loader.exec(py, main, "exec", "<stdin>", opts()));
  } else if (!interactive) {
    // program on stdin
    const source = readStdin();
    code = source === null ? 1 : guarded(() => R.loader.exec(source, main, "exec", "<stdin>", opts()));
  }
  flushFiles();
  R.stdout.flush();
  R.stderr.flush();
  if (interactive && started && (code === null || inspect)) {
    // (the prompt's __main__ if no program made one, made as a program's is: a --sage startup that raises ends here)
    if (main === null) code = guarded(() => void (main = mainModule("<stdin>")));
    if (main !== null) {
      // (the prompt speaks the program's language: --magma or --matlab, or that of the file -i ran)
      const mode: ReplMode = isMagma(file) ? "magma" : isMatlab(file) ? "matlab" : "python";
      code = await (promptHost ? promptBack(main, quiet || inspect, mode) : repl(main, quiet || inspect, mode));
    }
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
else if (workerData?.sagebrushPrompt) promptWorker(workerData.sagebrushPrompt.argv, workerData.sagebrushPrompt.limits);
else if (workerData?.sagebrushKernel) kernelWorker(workerData.sagebrushKernel);
else if (workerData?.sagebrushNotebook) notebookWorker(workerData.sagebrushNotebook);
// (`board run`'s interpreter, src/board-run.ts)
else if (workerData?.sagebrushBoardRun) import("./board-run").then((m) => m.boardRunWorker(workerData.sagebrushBoardRun));

/** The file this CLI runs from, its real path (a symlink such as node_modules/.bin/sagebrush followed): the bundle the
 * npm launcher loaded in a worker (the launcher says which: a worker's own main module and argv are none of them), or
 * this process's main module, or its script. Null if there is none. */
function cliEntry(): string | null {
  try { return realpathSync(workerData?.sagebrushCli?.entry ?? require.main?.filename ?? process.argv[1]); } catch { return null; }
}

/** `sagebrush latex`'s module, sagebrush-latex.cjs (scripts/build-cli.mjs): beside this bundle in the npm package and in
 * build/cli; from a checkout's tsc or bun run, build/cli's. Loaded by its path, so no bundler folds it into this one.
 * Or why there is none.
 * Looked for first where this process's entry really is (the bundle, or the npm launcher in bin/, beside dist/; a
 * symlink such as node_modules/.bin/sagebrush followed): Bun's bundle has the build machine's folder as __dirname,
 * which alone finds the module only on the machine that built it (or a stale build there). */
function loadLatex(): { latexCommand: (argv: string[], opts?: { cli?: string }) => Promise<number> } | string {
  // (cliEntry's path, written out here so that the census's pin of this function covers every place it loads from)
  const dirs: string[] = [];
  try { const at = dirname(realpathSync(workerData?.sagebrushCli?.entry ?? require.main?.filename ?? process.argv[1])); dirs.push(at, join(at, "..", "dist")); } catch {}
  const here = typeof __dirname === "string" ? __dirname : ".";
  dirs.push(here, join(here, "..", "build", "cli"), join(here, "..", "..", "build", "cli"));
  for (const d of dirs) {
    const p = join(d, "sagebrush-latex.cjs");
    if (existsSync(p)) return createRequire(join(d, "x.js"))(p);
  }
  return "this build of sagebrush has no LaTeX commands (sagebrush-latex.cjs isn't beside it): use the npm package, npx sagebrush latex ...";
}
