// The editors' old example lists, generated from the corpus in examples/ (plan-examples-gallery §6, PR 2: "the old
// in-editor lists keep working, generated from examples/ at build time"). Run as it is (Bun's tests), these read
// the corpus. A bundle never carries this file: web/build.ts's plugin (examplesLegacyPlugin) gives every bundle
// legacySource() instead, the same functions returning the lists as literals, each text a String.raw template, as
// the lists were written by hand (a macro's strings are printed escaped: every backslash and newline twice, 45 KB more
// in the CLI's copy of the page for the same lists). web/build.ts writes the board page's examples/ from
// boardMenu() and boardFiles(). They go with the old menus (PR 6), once the Examples… panel replaces them.
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

/**
 * A string as JavaScript source, the shorter of JSON and a String.raw template: its text as it is, but for what a raw
 * template can't hold,
 * each put in as an interpolation of a JSON string: a run of characters beyond ASCII (Bun writes one inside a raw
 * template as \uXXXX, which is then those six characters), a backtick, a "$" before "{", a carriage return (which a
 * template's raw text turns into a line feed), and a backslash at the end or before one of these (it would escape
 * the "$" that starts it).
 */
export function rawLiteral(t: string): string {
  // (which characters go in interpolations, decided from the end: a backslash does when the one after it does)
  const put = new Array<boolean>(t.length + 1).fill(false);
  put[t.length] = true;
  for (let k = t.length - 1; k >= 0; k--) {
    const c = t.charCodeAt(k);
    put[k] = c > 0x7f || c === 0x60 || c === 0x0d || (c === 0x24 && t[k + 1] === "{") || (c === 0x5c && put[k + 1]);
  }
  let out = "";
  for (let k = 0; k < t.length; ) {
    if (!put[k]) {
      out += t[k++];
      continue;
    }
    let e = k + 1;
    while (e < t.length && put[e]) e++;
    out += "${" + JSON.stringify(t.slice(k, e)) + "}";
    k = e;
  }
  const raw = "String.raw`" + out + "`", json = JSON.stringify(t);
  // (whichever is shorter: a text with many characters beyond ASCII and few backslashes is shorter as JSON)
  return json.length < raw.length ? json : raw;
}
/** A value as JavaScript source, every string through rawLiteral. */
function source(v: unknown): string {
  if (typeof v === "string") return rawLiteral(v);
  if (Array.isArray(v)) return "[" + v.map(source).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.entries(v).map(([k, x]) => JSON.stringify(k) + ":" + source(x)).join(",") + "}";
  return JSON.stringify(v);
}
/** This module as a bundle carries it: the menus' functions, returning the corpus's lists as literals. */
export function legacySource(): string {
  return `// (web/examples/legacy.ts, as web/build.ts bundles it: the lists, generated from examples/)
export function notebookExamples() { return ${source(notebookExamples())}; }
export function latexExamples() { return ${source(latexExamples())}; }
`;
}
