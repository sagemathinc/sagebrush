// The corpus's boards (examples/board/<slug>/), by their main file's name: web/build.ts copies them into
// dist/board/examples/ (the board page's own document, /board/ alone, is one of them), and the board tests open them.
// Never bundled.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..", "examples", "board");

/** Every corpus board's main file, by its file name (unique: the board page links examples/<file>). */
export function boardFiles(): [file: string, path: string][] {
  const seen = new Map<string, string>();
  for (const slug of readdirSync(root).sort()) {
    const m = JSON.parse(readFileSync(join(root, slug, "example.json"), "utf8"));
    if (seen.has(m.main)) throw new Error(`board/${slug}: ${m.main} is also another board's file`);
    seen.set(m.main, join(root, slug, m.main));
  }
  return [...seen];
}
