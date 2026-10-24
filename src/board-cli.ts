// sagebrush board render FILE [--svg] [-o OUT] [--page N]: a board (its
// .board.json, a Mermaid flowchart, Markdown with some, a JSON Canvas, a
// CoCalc whiteboard) as an SVG file, without a browser (web/board/svg.ts).
// Loaded only when the command is `board` (src/cli.ts), so nothing else
// starts slower.

import { readFileSync, writeFileSync } from "fs";
import { boardFromText } from "../web/board/mermaid";
import { boardSvg } from "../web/board/svg";
import { badPictureNames, formatError, pageCount } from "../web/board/doc";
import { oneLine } from "./terminal-text";

const USAGE = `usage: sagebrush board render FILE [--svg] [-o OUT] [--page N]
  a board as an SVG file (to OUT, else to standard output); --page N: its
  Nth page (from 1)
       sagebrush board run FILE [--json] [--timeout S] [--store-previews]
  run its code items as the board does, and report each one's output or
  error (sagebrush board run --help)
       sagebrush board check FILE [--json] [--no-run] [--timeout S]
  check a board before anyone opens it: the format, ids, edges, steps,
  pictures, and its code items run; every problem in one report
  (sagebrush board check --help)
       sagebrush board answers FILE [--json] [--apply SUBMISSION]
  its questions and the answers kept in it; --apply writes a host's
  submission into it first (sagebrush board answers --help)
       sagebrush board try FILE --cases CASES.json [--json]
  try its questions with given answers, as a reader would: each checked,
  its hints shown; a report for an evaluator (sagebrush board try --help)
       sagebrush board open FILE [--port N] [--no-browser]
  show it in your browser, as sagebrush.space/board does, and again each
  time the file changes (sagebrush board open --help)
`;
/** The board commands this sagebrush has. */
const COMMANDS = ["render", "run", "check", "answers", "try", "open"];

/** The command line as a reader of boards, in what it says of one it can't
 * read: which sagebrush refused it, and what to do (formatError). */
export const CLI_READER = { reader: `this sagebrush (${(globalThis as any).__SAGEBRUSH_VERSION__ ?? "dev"})`, remedy: "update sagebrush (npx sagebrush@latest)" };

/** What the command line says of a board's pictures whose names the board
 * leaves out (doc.ts badPictureNames): the rule, and the names, so that
 * whoever wrote the board can rename them; null if there are none. */
export function pictureWarning(d: unknown): string | null {
  const bad = badPictureNames(d);
  if (!bad.length) return null;
  const shown = bad.slice(0, 10).map((n) => JSON.stringify(n.length > 60 ? n.slice(0, 60) + "…" : n));
  return oneLine(`pictures left out: a picture's name is letters, digits, _ and -, at most 100 characters (plot-1, not "plot 1" or "figure.png"), and ${bad.length === 1 ? "this one is" : "these are"} not: ${shown.join(", ")}${bad.length > 10 ? `, and ${bad.length - 10} more` : ""}`);
}

/** The `board` command; returns the exit code. */
export async function boardCommand(argv: string[]): Promise<number> {
  // (sagebrush board run: src/board-run.ts)
  if (argv[0] === "run") return (await import("./board-run")).boardRun(argv.slice(1));
  // (sagebrush board check: src/board-check.ts)
  if (argv[0] === "check") return (await import("./board-check")).boardCheck(argv.slice(1));
  // (sagebrush board try: src/board-try.ts)
  if (argv[0] === "try") return (await import("./board-try")).boardTry(argv.slice(1));
  // (sagebrush board open: src/board-open.ts)
  if (argv[0] === "open") return (await import("./board-open")).boardOpen(argv.slice(1));
  // (sagebrush board answers: src/board-answers.ts)
  if (argv[0] === "answers") return (await import("./board-answers")).boardAnswers(argv.slice(1));
  // (a command this sagebrush doesn't have: said so, with the ones it has,
  // not taken as a file's name, agent-UX R0-3)
  if (argv.length && !COMMANDS.includes(argv[0]) && !["-h", "--help"].includes(argv[0])) {
    process.stderr.write(`sagebrush board: unknown board command ${oneLine(JSON.stringify(argv[0]))}: this sagebrush (${(globalThis as any).__SAGEBRUSH_VERSION__ ?? "dev"}) has ${COMMANDS.join(", ")}\n${USAGE}`);
    return 2;
  }
  if (argv[0] !== "render" || argv.includes("-h") || argv.includes("--help")) {
    (argv[0] === "render" || !argv.length ? process.stdout : process.stderr).write(USAGE);
    return argv[0] === "render" || !argv.length ? 0 : 2;
  }
  let file: string | null = null, out: string | null = null, page = 1;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--svg") continue;
    if (a === "-o" || a === "--output") out = argv[++i] ?? null;
    else if (a === "--page") page = Number(argv[++i]);
    else if (a.startsWith("-") && a !== "-") { process.stderr.write(`sagebrush board render: unknown option ${oneLine(a)}\n${USAGE}`); return 2; }
    else if (file === null) file = a;
    else { process.stderr.write(USAGE); return 2; }
  }
  if (file === null || (out === null && argv.includes("-o"))) { process.stderr.write(USAGE); return 2; }
  let doc;
  try {
    const text = readFileSync(file === "-" ? 0 : file, "utf8");
    doc = boardFromText(text, file === "-" ? undefined : file.split(/[\\/]/).pop());
    // (a document the board would not show, as the board says it: a later
    // version of the format than this one reads, another format, an id
    // twice on a page; no SVG of it)
    const bad = formatError(doc, CLI_READER);
    if (bad) throw new Error(bad);
  } catch (e: any) {
    process.stderr.write(`sagebrush board render: ${oneLine(String(file))}: ${oneLine(String(e?.message ?? e))}\n`);
    return 1;
  }
  // (pictures the board leaves out for their names: said, so they can be renamed)
  const pics = pictureWarning(doc);
  if (pics) process.stderr.write(`sagebrush board render: ${pics}\n`);
  const pages = pageCount(doc);
  if (!Number.isInteger(page) || page < 1 || page > pages) { process.stderr.write(`sagebrush board render: --page: from 1 to ${pages}\n`); return 2; }
  // (math typeset: MathJax, loaded only for a board with math in it)
  const math = JSON.stringify(doc).includes("$") ? (await import("./board-math")).texSvg : undefined;
  const { svg, left, overflow } = boardSvg(doc, { page: page - 1, math });
  if (out === null) process.stdout.write(svg);
  else writeFileSync(out, svg);
  if (left.length) process.stderr.write(`sagebrush board render: shown only in part: ${left.join(", ")}\n`);
  // (the notes' ids, quoted as JSON: a board's text never reaches the terminal as control characters, CORR-974-1)
  if (overflow.length) process.stderr.write(`sagebrush board render: text cut to its note's box (a note of a given size): ${overflow.map((id) => JSON.stringify(id)).join(", ")}\n`);
  return 0;
}
