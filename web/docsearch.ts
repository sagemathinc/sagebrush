// The function search, shared by the notebook page (web/index.html) and the
// board's code editor (web/board/inplace.ts): the functions a language has,
// and only those.
// - Sage's: every public function of Sagebrush's Sage library with its
//   signature and docstring (docs-index.json, made by lib/_pyjs_docsearch.py
//   at build time).
// - MATLAB's: its built-ins (docs-index-matlab.json, lib/_matlab_docsearch.py).
// - Magma's: the intrinsics Magma mode binds (docs-index-magma.json,
//   lib/_magma_docsearch.py).
// - Python's: numpy, scipy and the standard library as Sagebrush has them
//   (docs-index-python.json, lib/_python_docsearch.py).
// Ranked as lib/_pyjs_docsearch.py ranks: every word must match; the name
// counts most.  A language without an index has none (null).

/** Each language's index, a file at the site's root. */
export const DOC_INDEX: Record<string, string> = { sage: "docs-index.json", python: "docs-index-python.json", matlab: "docs-index-matlab.json", magma: "docs-index-magma.json" };

/** An index entry, as the build writes it (catalog/SCHEMA.md), and what the search reads of it. */
export interface DocEntry {
  name: string;
  aliases?: string[];
  signature?: string;
  summary: string;
  doc: string;
  module?: string;
  kind?: string;
  source?: string;
  open_problem?: boolean;
  examples?: number | { code: string; setup?: string }[];
  lang: string;
  _name: string;
  _words: Set<string>;
  _lasts: string[];
  _sum: string;
  _doc: string;
  _nex: number;
}

export const docWords = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** An index as fetched (its JSON), made ready to search. */
export function prepareIndex(raw: any[], lang: string): DocEntry[] {
  return raw.map((e) => ({
    // (a catalog entry's aliases are names of it too: catalog/SCHEMA.md)
    ...e, lang, _name: [e.name, ...(e.aliases ?? [])].join(" ").toLowerCase(), _words: new Set([e.name, ...(e.aliases ?? [])].flatMap(docWords)),
    _lasts: [e.name, ...(e.aliases ?? [])].map((n: string) => n.toLowerCase().split(".").at(-1)!), _sum: e.summary.toLowerCase(), _doc: e.doc.toLowerCase(),
    // (a count in the older indexes; the catalog's entries list their examples, catalog/SCHEMA.md)
    _nex: Array.isArray(e.examples) ? e.examples.length : e.examples || 0,
  }));
}

export function docScore(e: DocEntry, words: string[], phrase: string): number {
  let total = 0;
  for (const w of words) {
    if (e._words.has(w)) total += 10;
    else if (e._name.includes(w)) total += 6;
    else if (e._sum.includes(w)) total += 3;
    else if (e._doc.includes(w)) total += 1;
    else return 0;
  }
  if (e._lasts.includes(phrase) || e._lasts.includes(phrase.replaceAll(" ", "_"))) total += 20;
  if (e.open_problem && words.includes("open")) total += 5;
  return total;
}

/** The entries of `idx` matching `query`, best first, at most `limit`. */
export function searchIndex(idx: DocEntry[], query: string, limit = 20): DocEntry[] {
  const words = docWords(query);
  if (!words.length) return [];
  const phrase = query.trim().toLowerCase();
  return idx.map((e) => [docScore(e, words, phrase), e] as const).filter(([s]) => s > 0)
    .sort((a, b) => b[0] - a[0] || a[1].name.length - b[1].name.length || (a[1].name < b[1].name ? -1 : 1))
    .slice(0, limit).map(([, e]) => e);
}

/** An entry's head: a signature that starts with "(" follows the name; any
 * other, as MATLAB's "M = max(A)", is a whole call form (catalog/SCHEMA.md;
 * its first form here). */
export const docHead = (e: DocEntry) => { const f = (e.signature || "").split("\n")[0]; return f && !f.startsWith("(") ? f : e.name + (f || (e.kind === "class" ? "" : "()")); };

/** The examples of a docstring as code: the sage: lines (with their ....:
 * continuations); for MATLAB's, the lines after its prompt, >>; for Magma's,
 * the lines after its prompt, "> ". */
export function docExamples(doc: string, lang: string): string {
  const out: string[] = [];
  for (const line of doc.split("\n")) {
    const t = line.trim();
    if (lang === "matlab") {
      if (line.startsWith(">> ")) out.push(line.slice(3));
      continue;
    }
    if (lang === "magma") {
      if (t.startsWith("> ")) out.push(t.slice(2));
      continue;
    }
    if (t.startsWith("sage: ")) out.push(t.slice(6));
    else if (t.startsWith("....: ")) out.push(t.slice(6));
    else if (t === "....:") out.push("");
  }
  return out.join("\n");
}

/** An entry's examples as code to insert: a catalog entry's own (each with
 * the imports it needs, its setup), else those of its docstring. */
export function entryExamples(e: DocEntry): string {
  if (Array.isArray(e.examples)) {
    const setup = [...new Set(e.examples.flatMap((x) => (x.setup || "").split("\n").filter(Boolean)))];
    return [...setup, ...(setup.length ? [""] : []), e.examples.map((x) => x.code).join("\n\n")].join("\n");
  }
  return docExamples(e.doc ?? "", e.lang);
}
