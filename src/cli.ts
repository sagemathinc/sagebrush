// pyjs: run Python programs, or an interactive prompt.
//
//   sagebrush                 interactive prompt
//   pyjs program.py [args]    run a program
//   pyjs -c 'code' [args]     run a string
//   pyjs -m module [args]     run a library module as __main__
//   pyjs -i program.py        run, then stay interactive
//   pyjs --emit program.py    print the generated JavaScript

import { readFileSync, mkdirSync, appendFileSync, writeFileSync } from "fs";
import { dirname, resolve, join } from "path";
import { homedir, tmpdir } from "os";
import * as readline from "readline";
import { initParser, compile, execModule, R, libDir, findModuleSource } from "./compile";
import { needsMore, complete } from "./interactive";
import { builtin, isType, typeName, getattr } from "./runtime/object";

const VERSION = `sagebrush ${(globalThis as any).__SAGEBRUSH_VERSION__ ?? "dev"} (Python 3.14 language on a JavaScript runtime)`;
const USAGE = `usage: sagebrush [-c cmd | -m mod | file | -] [args]
  -c cmd   run the program passed as a string
  -m mod   run a library module as a script
  -i       inspect interactively after running a program
  --sage   Sage syntax (2^3 == 8, 2/3 is a Rational) with sage_all imported;
           implied for .sage files
  -q       no banner on the interactive prompt
  --emit   print the JavaScript compiled from file
  -V       print the version
`;

// Run fn, reporting an uncaught exception as CPython does; returns the exit code.
function guarded(fn: () => void): number | null {
  try {
    fn();
    return null;
  } catch (e: any) {
    const exc = R.toPyExc(e);
    if (R.typeOf(exc).$mro.includes(R.T.SystemExit)) {
      const c = exc.code;
      if (c === null || c === undefined) return 0;
      if (typeof c === "number") return c;
      R.stdout.flush();
      R.stderr.write(R.str(c) + "\n");
      return 1;
    }
    R.stdout.flush();
    R.stderr.write(R.formatException(exc));
    return 1;
  }
}

// Rich display on a terminal: a picture (SVG) is written to a file whose
// path is printed with the picture's description; the rest prints its repr.
let plotCount = 0;
R.host = {
  display(bundle: Record<string, string>): boolean {
    const svg = bundle["image/svg+xml"];
    if (svg === undefined) return false;
    let path: string;
    try {
      path = join(tmpdir(), `sagebrush-${process.pid}-${++plotCount}.svg`);
      writeFileSync(path, svg);
    } catch {
      return false; // e.g. a sandbox without environment or write access
    }
    const m = /<title>([^<]*)<\/title>/.exec(svg);
    const desc = m ? m[1].replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&") : "";
    R.stdout.write(`${bundle["text/plain"] ?? ""}\nSaved ${path}${desc ? ` (${desc.length > 300 ? desc.slice(0, 300) + "…" : desc})` : ""}\n`);
    return true;
  },
};

// --sage: Sage syntax for everything typed or passed on the command line.
let sage = false;
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

// Module names importable from sys.path (and the builtin modules).
function moduleNames(): string[] {
  const names = new Set<string>(R.builtinModuleNames());
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
        const code = guarded(() => R.loader.exec(src + "\n", main, "single", "<stdin>", opts()));
        R.stdout.flush();
        R.stderr.flush();
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

// help(obj): signature and docstring (help() alone explains the prompt).
function installHelp() {
  const help = (obj: any = undefined) => {
    if (obj === undefined) {
      process.stdout.write("pyjs is the Python 3.14 language compiled to JavaScript.\nhelp(obj) shows an object's signature and docstring; dir(obj) lists its attributes.\n");
      return null;
    }
    const name = getattr(obj, "__qualname__", null) ?? getattr(obj, "__name__", null) ?? typeName(obj);
    const sig = typeof obj === "function" && obj.$sig ? obj.$sig : null;
    let head = String(name);
    if (sig) {
      const parts = [...sig.args];
      if (sig.vararg) parts.push("*" + sig.vararg);
      else if (sig.kwonly.length) parts.push("*");
      parts.push(...sig.kwonly);
      if (sig.kwarg) parts.push("**" + sig.kwarg);
      head += "(" + parts.join(", ") + ")";
    }
    const kind = isType(obj) ? "class" : typeof obj === "function" ? "function" : "object";
    let out = `Help on ${kind} ${name}:\n\n${head}\n`;
    const doc = getattr(obj, "__doc__", null);
    if (typeof doc === "string") out += doc.split("\n").map((l: string) => "    " + l.trim()).join("\n") + "\n";
    if (isType(obj)) {
      const methods = R.toArray(R.builtins.dir(obj)).filter((n: string) => !n.startsWith("_"));
      if (methods.length) out += "\n  Attributes and methods:\n" + methods.map((n: string) => "    " + n).join("\n") + "\n";
    }
    process.stdout.write(out);
    return null;
  };
  R.builtins.help = builtin(help, "help");
}

// ------------------------------------------------------------------ main

async function main() {
  const argv = process.argv.slice(2);
  let emit = false, inspect = false, quiet = false;
  let cmd: string | null = null, mod: string | null = null, file: string | null = null;
  while (argv.length) {
    const a = argv[0];
    if (a === "--emit") emit = true;
    else if (a === "-i") inspect = true;
    else if (a === "-q") quiet = true;
    else if (a === "--sage") sage = true;
    else if (a === "-V" || a === "--version") {
      process.stdout.write(VERSION + "\n");
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
  await initParser();
  installHelp();
  if (emit) {
    if (file === null) {
      process.stderr.write("--emit needs a file\n");
      process.exitCode = 2;
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
  let code: number | null = null;
  let main: any = null;
  const interactive = (file === null && cmd === null && mod === null && process.stdin.isTTY) || inspect;
  if (cmd !== null) {
    main = mainModule("<string>");
    code = guarded(() => R.loader.exec(cmd!, main, "exec", "<string>", opts()));
  } else if (mod !== null) {
    code = guarded(() => {
      main = execModuleAsMain(mod!);
    });
  } else if (file !== null && file !== "-") {
    const source = readFileSync(file, "utf8");
    code = guarded(() => {
      main = execModule(source, file!, "__main__", false, sage || file!.endsWith(".sage"));
    });
  } else if (!interactive) {
    // program on stdin
    const source = readFileSync(0, "utf8");
    main = mainModule("<stdin>");
    code = guarded(() => R.loader.exec(source, main, "exec", "<stdin>", opts()));
  }
  R.stdout.flush();
  R.stderr.flush();
  if (interactive && (code === null || inspect)) {
    main ??= mainModule("<stdin>");
    code = await repl(main, quiet || inspect);
  }
  R.stdout.flush();
  R.stderr.flush();
  process.exitCode = code ?? 0;
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

main();
