// The terminal's completion, help lists and ls colours, as pure functions (plan-term-help-tab r3.1 §2: H, G, T, C):
// no workspace, no DOM, no shell.  The panel (web/shell/panel.ts) calls them with what it has; ShellHost.complete
// (web/shell/host.ts) is the only listing, under the shell's own checks.  Tested by web/shell/test-panel-complete.mjs.

// ---------------------------------------------------------------- the lists (§2H, §2G; T-H2 holds them equal)
/** The commands the shell registers (optional/bash/src/shell.js COMMANDS; the panel can't import the optional package). */
export const SHELL_COMMANDS = [
  "ls", "cat", "head", "tail", "wc", "mkdir", "mv", "cp", "rm", "touch", "stat", "tree", "find",
  "grep", "sort", "uniq", "cut", "tr", "sed", "awk", "diff",
  "echo", "printf", "pwd", "basename", "dirname", "env", "true", "false", "seq",
  "jq",
];
/** just-bash 3.6.0's builtins, as its `help` lists them. */
export const BUILTINS = [
  ".", ":", "[", "alias", "bg", "break", "builtin", "caller", "cd", "command", "compgen", "complete", "continue",
  "declare", "dirs", "disown", "echo", "enable", "eval", "exec", "exit", "export", "false", "fc", "fg", "getopts",
  "hash", "help", "history", "jobs", "kill", "let", "local", "logout", "mapfile", "popd", "printf", "pushd", "pwd",
  "read", "readarray", "readonly", "return", "set", "shift", "shopt", "source", "suspend", "test", "times", "trap",
  "true", "type", "typeset", "ulimit", "umask", "unalias", "unset", "wait",
];
/** The panel's own commands (typed alone): web/shell/panel.ts's clear and reset, panel-commands.ts's others. */
export const PANEL_COMMANDS = ["clear", "reset", "open", "ps", "top", "help"];

const uniqSorted = (xs: string[]) => [...new Set(xs)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
/** Every command name a first word can complete to. */
export const commandNames = (): string[] => uniqSorted([...PANEL_COMMANDS, ...SHELL_COMMANDS, ...BUILTINS]);

/** `compgen -c|-b|-A command|-A builtin [PREFIX]` typed alone (§2G): the lines and the exit status, or null if not ours. */
export function compgen(args: string[]): { out: string; code: number } | null {
  let kind: "c" | "b" | null = null;
  let rest: string[];
  if (args[0] === "-c" || args[0] === "-b") (kind = args[0] === "-c" ? "c" : "b"), (rest = args.slice(1));
  else if (args[0] === "-A" && (args[1] === "command" || args[1] === "builtin")) (kind = args[1] === "command" ? "c" : "b"), (rest = args.slice(2));
  else return null;
  if (rest.length > 1) return null;
  const prefix = rest[0] ?? "";
  const names = (kind === "c" ? commandNames() : uniqSorted(BUILTINS)).filter((n) => n.startsWith(prefix));
  return { out: names.map((n) => n + "\n").join(""), code: names.length ? 0 : 1 };
}

// ---------------------------------------------------------------- the Tab gate (§2T; U6)
/** "complete": the caret is at the end of a word, nothing selected, nothing running; else the browser's own Tab. */
export function tabAction(value: string, selStart: number, selEnd: number, running: boolean): "complete" | "default" {
  if (running || selStart !== selEnd || value.trim() === "") return "default";
  const c = selStart;
  if (c === 0 || /\s/.test(value[c - 1])) return "default";
  if (c < value.length && !/\s/.test(value[c])) return "default";
  return "complete";
}

// ---------------------------------------------------------------- the word at the caret (§2T, §2T.Q; U1)
export type Ctx = "none" | "single" | "double";
export interface WordAt {
  /** where the word starts in the line (it ends at the caret) */
  start: number;
  /** the first word of a command (after the start, `;`, `&`, `|`, `(`, or a newline) */
  first: boolean;
  /** the quote open at the caret */
  ctx: Ctx;
  /** the word's literal value so far, or null if any part of it isn't literal (an expansion we don't model) */
  literal: string | null;
}
const OPERATOR = new Set([";", "&", "|", "(", ")", "<", ">", "\n"]);
const NONLITERAL = new Set(["$", "`", "*", "?", "[", "{"]);

/** The word ending at `caret`, scanning the line from its start; null if the caret is right after an operator or a space. */
export function wordAt(line: string, caret: number): WordAt | null {
  let start = 0, first = true, ctx: Ctx = "none", lit: string | null = "", inWord = false, cmdStart = true;
  for (let i = 0; i < caret; i++) {
    const c = line[i];
    if (ctx === "single") {
      if (c === "'") ctx = "none";
      else if (lit !== null) lit += c;
      continue;
    }
    if (ctx === "double") {
      if (c === '"') ctx = "none";
      else if (c === "\\" && i + 1 < caret && "$`\"\\".includes(line[i + 1])) {
        if (lit !== null) lit += line[i + 1];
        i++;
      } else if (c === "$" || c === "`") lit = null;
      else if (lit !== null) lit += c;
      continue;
    }
    if (c === " " || c === "\t" || OPERATOR.has(c)) {
      if (inWord) cmdStart = false;
      // (a command starts after ; & | ( or a newline; a redirection's target is a path, not a command)
      if (OPERATOR.has(c) && c !== "<" && c !== ">" && c !== ")") cmdStart = true;
      inWord = false;
      continue;
    }
    if (!inWord) {
      inWord = true;
      start = i;
      first = cmdStart;
      lit = "";
      // (a leading ~ expands; a leading # starts a comment)
      if (c === "~" || c === "#") lit = null;
    }
    if (c === "'") ctx = "single";
    else if (c === '"') ctx = "double";
    else if (c === "\\") {
      if (i + 1 < caret) {
        if (line[i + 1] === "\n") lit = null;
        else if (lit !== null) lit += line[i + 1];
        i++;
      } else lit = null;
    } else if (NONLITERAL.has(c)) lit = null;
    else if (lit !== null) lit += c;
  }
  if (!inWord) return null;
  return { start, first, ctx, literal: lit };
}

// ---------------------------------------------------------------- the literal encoding (§2T.Q; U3)
const SAFE = /^[A-Za-z0-9._/+@%:,=-]+$/;
// (a name we can't put on the line as one literal word: a newline or any other C0 control, or DEL)
const UNREPRESENTABLE = /[\x00-\x1f\x7f]/;

/**
 * The whole word, re-encoded for its context, holding exactly `value` (the typed directory part plus the chosen
 * name); `close` ends it (a file or a command: the quote closed, then a space).  Null: declined (§2T.Q).
 * Every context re-encodes the WHOLE word from its start, so what was typed is re-encoded too (grader C-1).
 */
export function encodeWord(value: string, ctx: Ctx, close: boolean): string | null {
  if (UNREPRESENTABLE.test(value)) return null;
  if (value.startsWith("-")) return null;
  const tail = close ? " " : "";
  if (ctx === "none") {
    if (value === "") return null;
    if (SAFE.test(value)) return value + tail;
    return "'" + value.replace(/'/g, "'\\''") + "'" + tail;
  }
  if (ctx === "single") return "'" + value.replace(/'/g, "'\\''") + (close ? "'" + tail : "");
  return '"' + value.replace(/[$`"\\]/g, (m) => "\\" + m) + (close ? '"' + tail : "");
}

/** The directory part of a typed literal (through its last `/`) and the name part after it. */
export function splitPath(literal: string): { dir: string; name: string } {
  const k = literal.lastIndexOf("/");
  return k < 0 ? { dir: "", name: literal } : { dir: literal.slice(0, k + 1), name: literal.slice(k + 1) };
}

/** The longest common prefix of the names (by UTF-16 unit, never splitting a surrogate pair). */
export function commonPrefix(names: string[]): string {
  if (!names.length) return "";
  let p = names[0];
  for (const n of names) {
    let i = 0;
    while (i < p.length && i < n.length && p[i] === n[i]) i++;
    p = p.slice(0, i);
  }
  if (p.length && /[\ud800-\udbff]/.test(p[p.length - 1])) p = p.slice(0, -1);
  return p;
}

export type Cand = { name: string; dir?: boolean };
/**
 * Which candidates a typed name prefix completes to (§2T matching): a prefix match; a dot-name only when the prefix
 * starts with a dot; the top's Trash only once a prefix is typed (`atTop`); names that can't be encoded (controls,
 * a leading `-` at a word's start) left out.
 */
export function matches(cands: Cand[], prefix: string, atWordStart: boolean, atTop = false): Cand[] {
  return cands.filter((c) => c.name.startsWith(prefix) && (prefix.startsWith(".") || !c.name.startsWith(".")) && !(atTop && prefix === "" && c.name === "Trash") && !UNREPRESENTABLE.test(c.name) && !(atWordStart && c.name.startsWith("-")));
}

/** One Tab's edit: the new line and caret, or "list" (nothing new to insert: show the candidates), or null (nothing). */
export function complete(line: string, caret: number, w: WordAt, cands: Cand[], atTop = false): { line: string; caret: number } | "list" | null {
  if (w.literal === null) return null;
  const { dir, name } = splitPath(w.literal);
  const ms = matches(cands, name, dir === "", atTop);
  if (!ms.length) return null;
  let value: string, close: boolean;
  if (ms.length === 1) {
    value = dir + ms[0].name + (ms[0].dir ? "/" : "");
    close = !ms[0].dir;
  } else {
    const p = commonPrefix(ms.map((m) => m.name));
    if (p.length <= name.length) return "list";
    value = dir + p;
    close = false;
  }
  const enc = encodeWord(value, w.ctx, close);
  if (enc === null) return null;
  const next = line.slice(0, w.start) + enc + line.slice(caret);
  return { line: next, caret: w.start + enc.length };
}

// ---------------------------------------------------------------- the candidate block (§2T.B; U2)
export const BLOCK_NAMES = 100;
export const BLOCK_BYTES = 8192;
const utf8Len = (s: string) => new TextEncoder().encode(s).length;
/** The candidates as one block: at most BLOCK_NAMES names and BLOCK_BYTES bytes, then "…and N more". */
export function candidateBlock(names: string[], maxNames = BLOCK_NAMES, maxBytes = BLOCK_BYTES): string {
  const shown: string[] = [];
  let bytes = 0;
  for (const n of names) {
    if (shown.length >= maxNames) break;
    const b = utf8Len(n) + 2;
    if (bytes + b > maxBytes) break;
    shown.push(n);
    bytes += b;
  }
  const more = names.length - shown.length;
  return shown.join("  ") + (more > 0 ? `${shown.length ? "  " : ""}…and ${more} more` : "");
}

// ---------------------------------------------------------------- ls colours (§2C; U5)
const LS_FLAGS = new Set(["a", "A", "1", "F", "R"]);
/** The paths of a plain `ls` whose output may be coloured: argv's non-flag words, or null if not colourable. */
export function lsColourable(argv: string[] | null): string[] | null {
  if (!argv || argv[0] !== "ls") return null;
  const paths: string[] = [];
  for (const a of argv.slice(1)) {
    if (a.startsWith("-") && a.length > 1) {
      for (const f of a.slice(1)) if (!LS_FLAGS.has(f)) return null;
    } else paths.push(a);
  }
  return paths;
}
export type KindOf = (dir: string, name: string) => string | undefined;
const SGR: Record<string, string> = { folder: "\x1b[1;34m", notebook: "\x1b[32m", board: "\x1b[35m" };
/**
 * `ls`'s output with the fixed SGR palette around each line that is EXACTLY an entry's name in its section's folder
 * (a folder's with -F's "/" too); every other line, and every character, unchanged.  `sections(header)` resolves a
 * "dir:" header to its folder (only when `headers`: -R, or more than one path); `start` is the first section's folder.
 */
export function colourLs(output: string, start: string | null, headers: boolean, sections: (header: string) => string | null, kindOf: KindOf): string {
  let dir = start;
  return output
    .split("\n")
    .map((line, i, all) => {
      if (headers && line.endsWith(":") && (i === 0 || all[i - 1] === "")) {
        dir = sections(line.slice(0, -1));
        return line;
      }
      if (dir === null || line === "") return line;
      let kind = kindOf(dir, line);
      if (kind === undefined && line.endsWith("/") && kindOf(dir, line.slice(0, -1)) === "folder") kind = "folder";
      const s = kind && SGR[kind];
      return s ? s + line + "\x1b[0m" : line;
    })
    .join("\n");
}
