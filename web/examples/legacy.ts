// The editors' old example lists, generated from the corpus in examples/ (plan-examples-gallery §6, PR 2: "the old
// in-editor lists keep working, generated from examples/ at build time"). The pages import these with
// { type: "macro" }: Bun runs them while bundling and inlines what they return, so a page carries the same lists it
// did and no file system code. web/build.ts writes the board page's examples/ from boardMenu() and boardFiles().
// They go with the old menus (PR 6), once the Examples… panel replaces them.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..", "examples");
type Manifest = { title: string; summary: string; main: string; files: string[]; mode?: string };
const manifest = (id: string): Manifest => JSON.parse(readFileSync(join(root, id, "example.json"), "utf8"));
const text = (s: string | string[]) => (Array.isArray(s) ? s.join("") : s);

// (each menu's order, as it was; a notebook's title is its menu label and the new notebook's name)
const NOTEBOOKS = [
  "welcome",
  "number-theory",
  "generators-and-classes",
  "sage-first-steps",
  "sage-calculus",
  "sage-plots",
  "sage-modular-forms",
  "sage-group-theory",
  "sage-galois-groups",
  "sage-polynomials",
  "sage-groebner-bases",
  "sage-algebraic-number-theory",
  "magma-first-steps",
  "matlab-first-steps",
  "numpy",
  "matplotlib",
  "text-and-data",
];
const LATEX = ["article", "beamer", "sagetex", "pythontex", "matlab", "figure", "cv", "tikz", "bibliography", "homework"];
const BOARDS = ["how-sagebrush-is-built", "infinitely-many-primes", "collatz-live", "mermaid-flowcharts", "what-is-transitive"];
// (written into dist/board/examples by scripts/board-examples.mjs, so not in the corpus)
const GENERATED_BOARDS = [
  { file: "source.json", title: "Sagebrush's source, file by file", about: "About 300 source files with their opening comments and links to GitHub; directories as groups, imports as edges. Generated from the repository." },
  { file: "integers.json", title: "The integers to 10,000", about: "10,000 notes with factorizations and arithmetic functions in LaTeX: how a large board feels." },
];

/** The notebook page's File > Examples…: title -> cells (code as a string, Markdown as {md}), and the titles by mode. */
export function notebookExamples(): { cells: Record<string, (string | { md: string })[]>; sage: string[]; magma: string[]; matlab: string[] } {
  const r = { cells: {} as Record<string, (string | { md: string })[]>, sage: [] as string[], magma: [] as string[], matlab: [] as string[] };
  for (const slug of NOTEBOOKS) {
    const m = manifest("notebook/" + slug);
    const nb = JSON.parse(readFileSync(join(root, "notebook", slug, m.main), "utf8"));
    r.cells[m.title] = nb.cells.map((c: { cell_type: string; source: string | string[] }) => (c.cell_type === "markdown" ? { md: text(c.source) } : text(c.source)));
    if (m.mode === "sage" || m.mode === "magma" || m.mode === "matlab") r[m.mode].push(m.title);
  }
  return r;
}

/** The LaTeX editor's "From an example": its files, main first, a binary one as base64 (web/latex/examples.ts). */
export function latexExamples(): { id: string; title: string; about: string; files: [string, string, true?][] }[] {
  return LATEX.map((id) => {
    const m = manifest("latex/" + id);
    return {
      id,
      title: m.title,
      about: m.summary,
      files: [m.main, ...m.files.filter((f) => f !== m.main)].map((f): [string, string, true?] => {
        const bytes = readFileSync(join(root, "latex", id, f));
        return /\.(png|jpe?g|pdf)$/i.test(f) ? [f, bytes.toString("base64"), true] : [f, bytes.toString("utf8")];
      }),
    };
  });
}

/** The board page's Examples (dist/board/examples/index.json). */
export function boardMenu(): { file: string; title: string; about: string }[] {
  return [
    ...BOARDS.map((slug) => {
      const m = manifest("board/" + slug);
      return { file: m.main, title: m.title, about: m.summary };
    }),
    ...GENERATED_BOARDS,
  ];
}

/** Every corpus board's main file, by its file name (unique: the board page links examples/<file>). */
export function boardFiles(): [file: string, path: string][] {
  const seen = new Map<string, string>();
  for (const slug of readdirSync(join(root, "board")).sort()) {
    const m = manifest("board/" + slug);
    if (seen.has(m.main)) throw new Error(`board/${slug}: ${m.main} is also another board's file`);
    seen.set(m.main, join(root, "board", slug, m.main));
  }
  return [...seen];
}
