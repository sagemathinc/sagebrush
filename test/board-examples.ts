import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The example boards: the corpus's, examples/board/<slug>/ (U7), each one main file, by its file name
const root = join(__dirname, "..", "..", "examples", "board");
export const boardExamples = new Map<string, string>(
  readdirSync(root)
    .sort()
    .map((slug) => {
      const main: string = JSON.parse(readFileSync(join(root, slug, "example.json"), "utf8")).main;
      return [main, join(root, slug, main)];
    }),
);
export function boardExample(file: string): string {
  const p = boardExamples.get(file);
  if (!p) throw new Error(`no example board ${file}`);
  return p;
}

/** What makes the corpus's boards not native board files, one line each (none, as it should be): every
 * examples/board/<slug>/'s main a .board.json, listed in its files, with the format's header, in its canonical
 * text (William, Nov 6: the examples should all be .board.json files). */
export function corpusProblems(): string[] {
  const out: string[] = [];
  for (const slug of readdirSync(root).sort()) {
    const m = JSON.parse(readFileSync(join(root, slug, "example.json"), "utf8"));
    if (typeof m.main !== "string" || !m.main.endsWith(".board.json")) { out.push(`${slug}: its main, ${JSON.stringify(m.main)}, is not a .board.json file`); continue; }
    if (!Array.isArray(m.files) || !m.files.includes(m.main)) out.push(`${slug}: ${m.main} is not in its files`);
    const d = JSON.parse(readFileSync(join(root, slug, m.main), "utf8"));
    if (d.format !== "sagebrush-board" || d.version !== 1) out.push(`${slug}: ${m.main} has no "format": "sagebrush-board", "version": 1 header`);
  }
  return out;
}
