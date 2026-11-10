// A Terminal command, run in its own worker (PR 3a (b1) design r4 §2; plan-term-3a r1.7 §1–§3): one plan read by
// src/term-command.ts, run once, as CPython's (or Sage's, MATLAB's, Magma's) command line runs it, and answered with
// its exit status and output.  The page terminates the worker after (one command per worker, plan §3.3).
//
// - The workspace's files are the page's, through the command's file channel (web/term-sync.ts) and the shim's
//   mediated mode (web/shims/fs.ts mediate()): nothing of the workspace is kept here.  A Stop on the channel raises
//   KeyboardInterrupt in the program, so it ends with 130.
// - stdin is the finite bytes the page gave, then end of file; input() reads a line of it, as CPython's does with a
//   redirected stdin (the prompt written, the line not echoed).
// - Output goes to one bounded sink (src/term-output.ts), never collected whole.
// - The exit status is CPython's rule (src/exit-status.ts); Magma's is 0, as Magma 2.18's (plan §1, ruled).
import { R, execModule } from "../src/compile";
import { guarded } from "../src/exit-status";
import { TermOutput } from "../src/term-output";
import { raise, T, builtin } from "../src/runtime/object";
import { stdinReadline } from "../src/runtime/builtins";
import { magmaToPython, MagmaSyntaxError } from "../src/magma";
import { matlabToPython, MatlabSyntaxError, matlabSyntaxMessage } from "../src/matlab";
import type { RunPlan, Source } from "../src/term-command";
import { WorkerChannel, CONTROL_BYTES, WINDOW } from "./term-sync";
import { __hooks, mediate, setStdin, startIn, readFileSync, existsSync, statSync } from "./shims/fs";

export type TermMessage = {
  gen: number;
  plan: RunPlan;
  cwd: string;
  stdin: Uint8Array;
  env: { COLUMNS?: number; LINES?: number };
  out: { allowance: number; backstop: number };
  sync: { control: SharedArrayBuffer; data: SharedArrayBuffer };
};
export type TermDone = { gen: number; code: number; stdout: string; stderr: string; output: ReturnType<TermOutput["result"]>["output"] };

const nat = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const canonical = (p: unknown) => typeof p === "string" && (p === "/" || /^(\/(?!\.\.?(?:\/|$))[^/]+)+$/.test(p));

/** The message's shape, checked whole before anything is set up; a message that isn't one is refused whole. */
const str = (x: unknown): x is string => typeof x === "string";
const MODES = ["python", "sage", "matlab", "magma"];
const NAMES = ["python", "python3", "sage", "matlab", "magma"];
function sourceOk(s: any, mode: string): boolean {
  if (!s || typeof s !== "object") return false;
  if (s.kind === "file") return canonical(s.path) && str(s.shown) && str(s.typed) || (mode === "magma" && s.path === "-" && s.shown === "-" && s.typed === "-");
  if (s.kind === "code") return str(s.code);
  return s.kind === "stdin";
}
export function termMessageOf(m: any): TermMessage | null {
  if (!m || typeof m !== "object" || !nat(m.gen) || !canonical(m.cwd)) return null;
  if (!(m.stdin instanceof Uint8Array) || m.stdin.byteLength > 8 * 2 ** 20 || !m.out || !nat(m.out.allowance) || !nat(m.out.backstop)) return null;
  if (!m.sync || !(m.sync.control instanceof SharedArrayBuffer) || !(m.sync.data instanceof SharedArrayBuffer) || m.sync.control.byteLength < CONTROL_BYTES || m.sync.data.byteLength !== WINDOW) return null;
  if (m.env !== undefined && (typeof m.env !== "object" || m.env === null || (m.env.COLUMNS !== undefined && !nat(m.env.COLUMNS)) || (m.env.LINES !== undefined && !nat(m.env.LINES)))) return null;
  const p = m.plan;
  if (!p || typeof p !== "object" || p.run !== true || !MODES.includes(p.mode) || !NAMES.includes(p.argv0) || !sourceOk(p.source, p.mode)) return null;
  if (!Array.isArray(p.argv) || p.argv.length > 1024 || !p.argv.every(str) || !str(p.path0) || (p.path0 !== "" && !canonical(p.path0))) return null;
  if (p.noBytecode !== undefined && p.noBytecode !== true) return null;
  if (p.startIn !== undefined && !canonical(p.startIn)) return null;
  if (p.more !== undefined && (!Array.isArray(p.more) || p.mode !== "magma" || !p.more.every((s: any) => s?.kind === "file" && sourceOk(s, p.mode)))) return null;
  if (p.vars !== undefined && (!Array.isArray(p.vars) || p.mode !== "magma" || !p.vars.every((v: any) => Array.isArray(v) && v.length === 2 && /^[A-Za-z_]\w*$/.test(String(v[0])) && str(v[1])))) return null;
  return m as TermMessage;
}

function mainModule(file: string, sage: boolean): any {
  const m = R.newModule("__main__");
  m.__file__ = file;
  m.__builtins__ = R.builtins;
  R.dictSet(R.sysModules, "__main__", m);
  if (sage) R.loader.exec("from sage_all import *\nimport _sage_lazy as _sage_lazy_; _sage_lazy_.bind(globals()); del _sage_lazy_\n", m, "exec", "<sage>");
  return m;
}

// (a source's text: a file read from the workspace, or the code given, or stdin's bytes; a file that can't be read is
// the command's own message and status)
function sourceText(plan: RunPlan, src: Source, stdin: Uint8Array): { text: string } | { code: number } {
  if (src.kind === "code") return { text: src.code };
  if (src.kind === "stdin") return { text: new TextDecoder().decode(stdin) };
  try {
    if (src.path === "-") throw Object.assign(new Error("-"), { code: "ENOENT" });
    return { text: readFileSync(src.path, "utf8") };
  } catch (e: any) {
    // (a Python exception, a Stop's KeyboardInterrupt: never a file that can't be read)
    if (e?.$cls !== undefined) throw e;
    if (plan.mode === "magma") {
      // (Magma's own words, on stdout, and it goes on: status 0)
      R.stdout.write(`Can't open file "${src.typed}"\n`);
      return { code: 0 };
    }
    const why: Record<string, [number, string]> = { ENOENT: [2, "No such file or directory"], EACCES: [13, "Permission denied"], EISDIR: [21, "Is a directory"] };
    const [n, msg] = why[e?.code] ?? [5, "Input/output error"];
    R.stderr.write(`${plan.argv0}: can't open file '${src.shown}': [Errno ${n}] ${msg}\n`);
    return { code: 2 };
  }
}

// (python FILE where FILE is a folder: CPython runs its __main__.py; here, a folder without one gets CPython's line and 1,
// and one with it is refused for now, @sagebrush's ruling on #976: running a package folder can come later)
function folderAsFile(plan: RunPlan, src: Source): number | null {
  if (plan.mode !== "python" || src.kind !== "file") return null;
  let folder = false;
  try {
    folder = statSync(src.path).isDirectory();
  } catch (e: any) {
    if (e?.$cls !== undefined) throw e;
    return null;
  }
  if (!folder) return null;
  if (existsSync(src.path.replace(/\/$/, "") + "/__main__.py")) {
    R.stderr.write(`${plan.argv0}: a folder as FILE isn't available in the Terminal\n`);
    return 2;
  }
  R.stderr.write(`${plan.argv0}: can't find '__main__' module in '${src.shown}'\n`);
  return 1;
}

function runPython(plan: RunPlan, stdin: Uint8Array): number {
  const sage = plan.mode === "sage";
  const src = plan.source;
  const folder = folderAsFile(plan, src);
  if (folder !== null) return folder;
  const got = sourceText(plan, src, stdin);
  if ("code" in got) return got.code;
  if (src.kind === "file") {
    // (FILE as __main__; a .sage file preparsed, a .py file not)
    return guarded(() => void execModule(got.text, src.path, "__main__", false, sage && src.path.endsWith(".sage"))) ?? 0;
  }
  const name = src.kind === "code" ? "<string>" : "<stdin>";
  const main = mainModule(name, sage);
  return guarded(() => R.loader.exec(got.text, main, "exec", name, { sage })) ?? 0;
}

function runMatlab(plan: RunPlan, stdin: Uint8Array, cwd: string): number {
  let src = plan.source;
  // (-batch NAME runs the script NAME.m when there is one in the folder, as MATLAB's path does; else NAME is code)
  if (src.kind === "code" && /^[A-Za-z]\w*$/.test(src.code)) {
    const p = (plan.startIn ?? cwd).replace(/\/$/, "") + "/" + src.code + ".m";
    if (existsSync(p)) src = { kind: "file", path: p, shown: p, typed: src.code + ".m" };
  }
  const got = sourceText(plan, src, stdin);
  if ("code" in got) return got.code;
  const file = src.kind === "file" ? src.path : src.kind === "code" ? "<string>" : "<stdin>";
  let py: string;
  try {
    py = matlabToPython(got.text, file, { file: src.kind === "file" });
  } catch (e) {
    if (!(e instanceof MatlabSyntaxError)) throw e;
    R.stderr.write(matlabSyntaxMessage(e, got.text, file));
    return 1;
  }
  if (src.kind === "file") return guarded(() => void execModule(py, file, "__main__", false, false)) ?? 0;
  const main = mainModule(file, false);
  return guarded(() => R.loader.exec(py, main, "exec", file)) ?? 0;
}

function runMagma(plan: RunPlan, stdin: Uint8Array): number {
  // (an ordinary error is reported and the next file runs, as Magma's; a Stop ends it all with 130)
  let interrupted = false;
  // (Magma: each file in order, stdin a session; name:=value arguments as string variables; status 0, as Magma's)
  const main = mainModule(plan.source.kind === "file" ? plan.source.path : "<stdin>", false);
  for (const [k, v] of plan.vars ?? []) R.loader.exec(`${k} = ${JSON.stringify(v)}\n`, main, "exec", "<argv>");
  for (const src of [plan.source, ...(plan.more ?? [])]) {
    const got = sourceText(plan, src, stdin);
    if ("code" in got) continue;
    const file = src.kind === "file" ? src.path : "<stdin>";
    if (interrupted) break;
    let py: string;
    try {
      py = magmaToPython(got.text, file, { recover: src.kind === "stdin" ? "session" : "file" });
    } catch (e) {
      if (!(e instanceof MagmaSyntaxError)) throw e;
      const line = got.text.split("\n")[e.line - 1] ?? "";
      R.stdout.write(`\n>> ${line}\n${" ".repeat(e.col + 2)}^\nUser error: bad syntax: ${e.message} (${file}, line ${e.line})\n`);
      continue;
    }
    guarded(() => R.loader.exec(py, main, "exec", file), () => (interrupted = true));
    if (interrupted) return 130;
  }
  return 0;
}

/** Run one command: set the worker up for it, run it, and answer.  `post` is the worker's postMessage. */
export function runCommand(t: TermMessage, post: (m: unknown) => void): void {
  const plan = t.plan;
  const sink = new TermOutput(t.out.allowance, t.out.backstop);
  __hooks.write = (fd, text) => sink.write(fd === 2 ? 2 : 1, text);
  const ch = new WorkerChannel({ control: t.sync.control, data: t.sync.data, gen: t.gen, post });
  mediate(ch, () => raise(T.KeyboardInterrupt));
  setStdin(t.stdin);
  startIn(plan.startIn ?? t.cwd);
  const env = (globalThis as any).process?.env;
  if (env) {
    if (nat(t.env?.COLUMNS)) env.COLUMNS = String(t.env.COLUMNS);
    if (nat(t.env?.LINES)) env.LINES = String(t.env.LINES);
  }
  const sys = R.importModule("sys");
  sys.argv.length = 0;
  sys.argv.push(...plan.argv);
  sys.path.unshift(plan.path0);
  if (plan.noBytecode) sys.dont_write_bytecode = true;
  // input(): a line of stdin, as CPython's with a redirected stdin: the prompt written, the line read, not echoed
  R.builtins.input = builtin((...args: any[]) => {
    if (args.length > 1) raise(T.TypeError, `input expected at most 1 argument, got ${args.length}`);
    if (args.length) R.stdout.write(String(R.str(args[0])));
    R.stdout.flush();
    const line = stdinReadline();
    if (line === "") raise(T.EOFError, "EOF when reading a line");
    return line.endsWith("\n") ? line.slice(0, -1) : line;
  }, "input");
  let code = 0;
  try {
    // (the setup too, reading FILE and the rest, under CPython's rule: a Stop while the page answers is a
    // KeyboardInterrupt with its traceback, and 130, wherever it lands)
    const outer = guarded(() => {
      code = plan.mode === "matlab" ? runMatlab(plan, t.stdin, t.cwd) : plan.mode === "magma" ? runMagma(plan, t.stdin) : runPython(plan, t.stdin);
    });
    if (outer !== null) code = outer;
  } finally {
    try {
      R.stdout.flush();
      R.stderr.flush();
    } catch {}
  }
  const r = sink.result();
  post({ termDone: { gen: t.gen, code, stdout: r.stdout, stderr: r.stderr, output: r.output } satisfies TermDone });
}
