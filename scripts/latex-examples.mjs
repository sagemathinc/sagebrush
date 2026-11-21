// The LaTeX examples' files, read from the corpus (examples/latex/<id>/, the gallery's), for the tests that render them
// (web/latex/test-latex-units.mjs) and the LaTeX benchmark (bench/latex/run.mjs): each a folder of files, the main .tex
// first, then its assets (an image as base64). Never bundled: the editor's examples are the gallery's.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "examples", "latex");
/** the ten, in the order the editor's own list had them */
export const IDS = ["article", "beamer", "sagetex", "pythontex", "matlab", "figure", "cv", "tikz", "bibliography", "homework"];

/** {id, title, about, files: [name, text, base64?]} for each, main first. */
export const EXAMPLES = IDS.map((id) => {
  const m = JSON.parse(readFileSync(join(root, id, "example.json"), "utf8"));
  return {
    id,
    title: m.title,
    about: m.summary,
    files: [m.main, ...m.files.filter((f) => f !== m.main)].map((f) => {
      const bytes = readFileSync(join(root, id, f));
      return /\.(png|jpe?g|pdf)$/i.test(f) ? [f, bytes.toString("base64"), true] : [f, bytes.toString("utf8")];
    }),
  };
});
