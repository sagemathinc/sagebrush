// The Terminal's commands, read (plan-term-3a r1.7 §1): `python`, `python3`, `sage`, `matlab` and `magma` as a shell
// runs them, each with its own argv and stdin.  This is only the reading: what a command line asks for, as a plan to
// run, or the answer it gets at once (a usage text, a refusal, the version), with CPython's, Sage's, MATLAB's or
// Magma's own words and exit status where the plan keeps them, and board's where it states a difference.  Nothing
// here runs code or touches a file: the worker runs a plan (web/term-run.ts).
//
// `cwd` is the shell's directory, a canonical workspace path; FILE is joined to it, as the Terminal shows paths, so a
// message names the path the person typed against, never an internal mount.

export type TermName = "python" | "python3" | "sage" | "matlab" | "magma";

/** What the program is: a file, code given on the line, stdin, or the person typing at an interactive prompt. */
/** `typed`: a file's name as typed (Magma's messages name it so); `shown`: the workspace path messages show. */
export type Source = { kind: "file"; path: string; shown: string; typed: string } | { kind: "code"; code: string } | { kind: "stdin" } | { kind: "prompt" };

/** A plan to run.  `argv` is sys.argv; `path0` sys.path[0] ("" for -c and stdin, else FILE's directory). */
export type RunPlan = {
  run: true;
  mode: "python" | "sage" | "matlab" | "magma";
  /** the command's name as typed (python or python3), which its messages begin with */
  argv0: TermName;
  source: Source;
  argv: string[];
  path0: string;
  /** -B: sys.dont_write_bytecode */
  noBytecode?: true;
  /** magma: files in order after the first (`magma a.m b.m`) */
  more?: Source[];
  /** magma: `name:=value` arguments, as string variables */
  vars?: [string, string][];
  /** matlab: -sd FOLDER, the directory to start in */
  startIn?: string;
};
/** An answer given at once: nothing runs. */
export type Answer = { run: false; code: number; stdout: string; stderr: string };
export type Plan = RunPlan | Answer;

export const PYTHON_VERSION = "Python 3.14.10";
const clip = (s: string) => (s.length > 40 ? s.slice(0, 40) : s);
const answer = (code: number, stdout: string, stderr = ""): Answer => ({ run: false, code, stdout, stderr });
const join = (cwd: string, p: string) => {
  const out: string[] = [];
  for (const s of (p.startsWith("/") ? p : cwd + "/" + p).split("/")) {
    if (s === "" || s === ".") continue;
    if (s === "..") out.pop();
    else out.push(s);
  }
  return "/" + out.join("/");
};
const dirOf = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";
const fileSource = (cwd: string, typed: string): Source => ({ kind: "file", path: join(cwd, typed), shown: join(cwd, typed), typed });

// ------------------------------------------------------------------ python, python3

// CPython's options (Modules/main.c's getopt): single letters, clustered as typed (-uB), read left to right; `c`, `m`,
// `W` and `X` take the rest of the word, or the next word, as their argument.  The Terminal accepts -u (output is
// collected whole, so it changes nothing) and -B (sys.dont_write_bytecode); -c, -V, -h are the forms above; every
// other option CPython has is refused before anything runs, as typed (status 2); one CPython doesn't have gets its
// own "Unknown option" words.
const PY_HAS = new Set([..."bBcdEhiImOPqRsSuvVWxX?"]);
const PY_LONG_REFUSED = new Set(["--check-hash-based-pycs", "--help-env", "--help-xoptions", "--help-all"]);
const pyUsage = (argv0: string) => `usage: ${argv0} [option] ... [-c cmd | -m mod | file | -] [arg] ...\nTry \`python -h' for more information.\n`;

function python(argv0: "python" | "python3", args: string[], cwd: string, stdinRedirected: boolean, interactive: boolean): Plan {
  let noBytecode = false;
  const refuse = (a: string) => answer(2, "", `${argv0}: ${clip(a)} isn't available in the Terminal\n`);
  const run = (source: Source, argv: string[], path0: string): RunPlan => ({ run: true, mode: "python", argv0, source, argv, path0, ...(noBytecode ? { noBytecode: true as const } : {}) });
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      i++;
      break;
    }
    if (a === "-" || !a.startsWith("-")) break;
    if (a.startsWith("--")) {
      if (a === "--version") return answer(0, PYTHON_VERSION + "\n");
      if (a === "--help") return help(argv0);
      if (PY_LONG_REFUSED.has(a)) return refuse(a);
      return answer(2, "", `Unknown option: ${a}\n${pyUsage(argv0)}`);
    }
    if (a === "-VV") return refuse(a);
    for (let k = 1; k < a.length; k++) {
      const ch = a[k];
      if (!PY_HAS.has(ch)) return answer(2, "", `Unknown option: -${ch}\n${pyUsage(argv0)}`);
      if (ch === "c") {
        const attached = a.slice(k + 1);
        if (attached === "" && i + 1 >= args.length) return answer(2, "", `Argument expected for the -c option\n${pyUsage(argv0)}`);
        const code = attached !== "" ? attached : args[i + 1];
        return run({ kind: "code", code }, ["-c", ...args.slice(attached !== "" ? i + 1 : i + 2)], "");
      }
      if (ch === "u") continue;
      if (ch === "B") {
        noBytecode = true;
        continue;
      }
      if (ch === "V") return answer(0, PYTHON_VERSION + "\n");
      if (ch === "h" || ch === "?") return help(argv0);
      // (m, W, X take an argument; every other letter CPython has: refused, the word as typed)
      return refuse(a);
    }
  }
  const rest = args.slice(i);
  if (rest.length && rest[0] !== "-") {
    const src = fileSource(cwd, rest[0]);
    return run(src, rest, dirOf(join(cwd, rest[0])));
  }
  if (rest[0] === "-") return run({ kind: "stdin" }, rest, "");
  if (!stdinRedirected) {
    if (interactive) return run({ kind: "prompt" }, [""], "");
    return answer(2, "", `${argv0}: the interactive prompt isn't available in the Terminal yet. Run ${argv0} FILE, ${argv0} -c CODE, or pipe code in.\n`);
  }
  return run({ kind: "stdin" }, [""], "");
}
const help = (argv0: string) =>
  answer(0, `usage: ${argv0} [-c cmd | file | -] [arg] ...\nIn Sagebrush's Terminal, ${argv0} runs a file, -c code, or code from stdin (- or a pipe).\nOptions -u and -B are accepted; other options aren't available here.\n`);

// ------------------------------------------------------------------ sage

// Sage's options the Terminal refuses; anything else that starts with "-" is Sage's own unknown option
const SAGE_REFUSED = new Set(["-n", "--notebook", "-t", "-pip", "--pip", "-i", "--python", "--ipython", "-sh", "--sh", "-docbuild", "--docbuild", "-gap", "--gap", "-gp", "--gp", "-maxima", "--maxima", "-singular", "--singular", "-preparse", "--preparse", "-root", "--root", "-v", "--version", "-h", "--help", "-advanced", "--advanced"]);

function sage(args: string[], cwd: string, stdinRedirected: boolean, interactive: boolean): Plan {
  const a = args[0];
  if (a === undefined) {
    if (!stdinRedirected && interactive) return { run: true, mode: "sage", argv0: "sage", source: { kind: "prompt" }, argv: [""], path0: "" };
    if (!stdinRedirected) return answer(2, "", "sage: the interactive prompt isn't available in the Terminal yet. Run sage FILE, sage -c CODE, or pipe code in.\n");
    return { run: true, mode: "sage", argv0: "sage", source: { kind: "stdin" }, argv: [""], path0: "" };
  }
  if (a === "-c") {
    // (Sage: -c with nothing after it is silent, status 0; words after CODE join the code, as Sage 10.10 runs it)
    if (args.length < 2) return answer(0, "");
    return { run: true, mode: "sage", argv0: "sage", source: { kind: "code", code: args.slice(1).join(" ") }, argv: ["-c"], path0: "" };
  }
  if (SAGE_REFUSED.has(a)) return answer(2, "", `sage: ${clip(a)} isn't available in the Terminal\n`);
  if (a.startsWith("-")) return answer(1, `Error: unknown option: ${a}\n`);
  const src = fileSource(cwd, a);
  return { run: true, mode: "sage", argv0: "sage", source: src, argv: args, path0: dirOf((src as any).path) };
}

// ------------------------------------------------------------------ matlab

const MATLAB_NOOPS = new Set(["-nodesktop", "-nodisplay", "-nojvm", "-nosplash"]);

function matlab(args: string[], cwd: string, stdinRedirected: boolean, interactive: boolean): Plan {
  let startIn: string | undefined;
  let batch: string | null = null;
  let file: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (MATLAB_NOOPS.has(a)) continue;
    if (a === "-sd") {
      if (i + 1 >= args.length) return answer(2, "", "matlab: -sd needs a folder\n");
      startIn = join(cwd, args[++i]);
      continue;
    }
    if (a === "-batch") {
      if (args.includes("-r")) return answer(2, "", "matlab: -batch and -r can't be used together\n");
      if (i + 1 >= args.length) return answer(2, "", 'matlab: -batch needs code or a script name, as in matlab -batch "disp(1)"\n');
      batch = args[++i];
      continue;
    }
    if (a.startsWith("-")) return answer(2, "", `matlab: ${clip(a)} isn't available in the Terminal\n`);
    if (file !== null || batch !== null) return answer(2, "", "matlab: words after a script name aren't available in the Terminal\n");
    file = a;
  }
  const at = startIn ? { startIn } : {};
  if (batch !== null) {
    // (-batch NAME runs the script NAME.m; anything else is code)
    const code = /^[A-Za-z]\w*$/.test(batch) ? batch : batch;
    return { run: true, mode: "matlab", argv0: "matlab", source: { kind: "code", code }, argv: [], path0: "", ...at };
  }
  if (file !== null) {
    const src = fileSource(startIn ?? cwd, file);
    return { run: true, mode: "matlab", argv0: "matlab", source: src, argv: [file], path0: dirOf((src as any).path), ...at };
  }
  if (!stdinRedirected && interactive) return { run: true, mode: "matlab", argv0: "matlab", source: { kind: "prompt" }, argv: [""], path0: "", ...at };
  if (!stdinRedirected) return answer(2, "", "matlab: the interactive prompt isn't available in the Terminal yet. Run matlab -batch CODE, matlab FILE.m, or pipe code in.\n");
  return { run: true, mode: "matlab", argv0: "matlab", source: { kind: "stdin" }, argv: [""], path0: "", ...at };
}

// ------------------------------------------------------------------ magma

const MAGMA_REFUSED = new Set(["-d", "-l", "-s", "-S", "-r", "-c", "-q"]);
// (Magma 2.18-5's own line for an option it doesn't have, on stderr, status 1, recorded by @sagebrush-magma; Magma
// names itself magma.exe there, the Terminal's command is magma)
const MAGMA_USAGE = "Usage: magma [-d] [-l limit] [-b] [-n] [-s startfile] [-S seed] [-r workspace] [-c package] [-q directory machine] [filelist]\n";

function magma(args: string[], cwd: string, stdinRedirected: boolean, interactive: boolean): Plan {
  const files: Source[] = [];
  const vars: [string, string][] = [];
  for (const a of args) {
    if (a === "-b" || a === "-n") continue;
    if (MAGMA_REFUSED.has(a)) return answer(2, "", `magma: ${clip(a)} isn't available in the Terminal\n`);
    if (a === "-") {
      // (Magma reads "-" as a file name it can't open)
      files.push({ kind: "file", path: "-", shown: "-", typed: "-" });
      continue;
    }
    if (a.startsWith("-")) return answer(1, "", MAGMA_USAGE);
    const m = /^([A-Za-z_]\w*):=(.*)$/s.exec(a);
    if (m) {
      vars.push([m[1], m[2]]);
      continue;
    }
    files.push(fileSource(cwd, a));
  }
  const v = vars.length ? { vars } : {};
  if (files.length) {
    const [first, ...more] = files;
    return { run: true, mode: "magma", argv0: "magma", source: first, argv: args, path0: cwd, ...(more.length ? { more } : {}), ...v };
  }
  if (!stdinRedirected && interactive) return { run: true, mode: "magma", argv0: "magma", source: { kind: "prompt" }, argv: [""], path0: cwd, ...v };
  if (!stdinRedirected) return answer(2, "", "magma: the interactive prompt isn't available in the Terminal yet. Run magma FILE, or pipe code in.\n");
  return { run: true, mode: "magma", argv0: "magma", source: { kind: "stdin" }, argv: [""], path0: cwd, ...v };
}

/**
 * Read a Terminal command line: a plan to run, or the answer it gets at once.  `interactive`: the page's bridge says
 * this is the person's own line at the panel, a single top-level command with the keyboard as its stdin (never set
 * by the command or a caller); only then does a bare python, sage, matlab or magma open a prompt.  Every other form
 * keeps the answer it had before.
 */
export function readCommand(name: TermName, args: readonly string[], cwd: string, stdinRedirected: boolean, interactive = false): Plan {
  const a = [...args];
  switch (name) {
    case "python":
    case "python3":
      return python(name, a, cwd, stdinRedirected, interactive);
    case "sage":
      return sage(a, cwd, stdinRedirected, interactive);
    case "matlab":
      return matlab(a, cwd, stdinRedirected, interactive);
    case "magma":
      return magma(a, cwd, stdinRedirected, interactive);
  }
}
