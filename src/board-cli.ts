// sagebrush board render FILE [--svg] [-o OUT] [--page N]: a board (its
// .board.json, a Mermaid flowchart, Markdown with some, a JSON Canvas, a
// CoCalc whiteboard) as an SVG file, without a browser (web/board/svg.ts).
// Loaded only when the command is `board` (src/cli.ts), so nothing else
// starts slower.

import { readFileSync, writeFileSync } from "fs";
import { boardFromText } from "../web/board/mermaid";
import { boardSvg } from "../web/board/svg";
import { pageCount } from "../web/board/doc";

const USAGE = `usage: sagebrush board render FILE [--svg] [-o OUT] [--page N]
  a board as an SVG file (to OUT, else to standard output); --page N: its
  Nth page (from 1)
       sagebrush board run FILE [--json] [--timeout S] [--store-previews]
  run its code items as the board does, and report each one's output or
  error (sagebrush board run --help)
`;

/** The `board` command; returns the exit code. */
export async function boardCommand(argv: string[]): Promise<number> {
  // (sagebrush board run: src/board-run.ts)
  if (argv[0] === "run") return (await import("./board-run")).boardRun(argv.slice(1));
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
    else if (a.startsWith("-") && a !== "-") { process.stderr.write(`sagebrush board render: unknown option ${a}\n${USAGE}`); return 2; }
    else if (file === null) file = a;
    else { process.stderr.write(USAGE); return 2; }
  }
  if (file === null || (out === null && argv.includes("-o"))) { process.stderr.write(USAGE); return 2; }
  let doc;
  try {
    const text = readFileSync(file === "-" ? 0 : file, "utf8");
    doc = boardFromText(text, file === "-" ? undefined : file.split(/[\\/]/).pop());
  } catch (e: any) {
    process.stderr.write(`sagebrush board render: ${file}: ${e?.message ?? e}\n`);
    return 1;
  }
  const pages = pageCount(doc);
  if (!Number.isInteger(page) || page < 1 || page > pages) { process.stderr.write(`sagebrush board render: --page: from 1 to ${pages}\n`); return 2; }
  const { svg, left, overflow } = boardSvg(doc, { page: page - 1 });
  if (out === null) process.stdout.write(svg);
  else writeFileSync(out, svg);
  if (left.length) process.stderr.write(`sagebrush board render: shown only in part: ${left.join(", ")}\n`);
  // (the notes' ids, quoted as JSON: a board's text never reaches the terminal as control characters, CORR-974-1)
  if (overflow.length) process.stderr.write(`sagebrush board render: text cut to its note's box (a note of a given size): ${overflow.map((id) => JSON.stringify(id)).join(", ")}\n`);
  return 0;
}
