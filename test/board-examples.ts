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
