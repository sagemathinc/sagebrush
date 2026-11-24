// The first visit's notebook, Welcome (or Sage, on a Sage link), made from the corpus in examples/notebook/ at build
// time. It's a default document, not a list of examples: the examples are the gallery's (web/examples/panel.ts). Run
// as it is (Bun's tests), this reads the corpus. A bundle never carries this file: web/build.ts's plugin
// (examplesWelcomePlugin) gives every bundle welcomeSource() instead, the same function returning the notebooks as
// literals, each text a String.raw template (a macro's strings are printed escaped: every backslash and newline twice).
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..", "examples", "notebook");
// (the notebooks, by their name on the page: their slugs in the corpus)
const WELCOME: Record<string, string> = { Welcome: "welcome", Sage: "sage-first-steps" };

/** Welcome and Sage: their cells (code as a string, Markdown as {md}). */
export function welcomeNotebooks(): Record<string, (string | { md: string })[]> {
  const text = (x: string | string[]) => (Array.isArray(x) ? x.join("") : x);
  const r: Record<string, (string | { md: string })[]> = {};
  for (const [name, slug] of Object.entries(WELCOME)) {
    const m = JSON.parse(readFileSync(join(root, slug, "example.json"), "utf8"));
    const nb = JSON.parse(readFileSync(join(root, slug, m.main), "utf8"));
    r[name] = nb.cells.map((c: { cell_type: string; source: string | string[] }) => (c.cell_type === "markdown" ? { md: text(c.source) } : text(c.source)));
  }
  return r;
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
/** This module as a bundle carries it: the function, returning the notebooks as literals. */
export function welcomeSource(): string {
  return `// (web/examples/welcome.ts, as web/build.ts bundles it: the notebooks, made from examples/notebook/)
export function welcomeNotebooks() { return ${source(welcomeNotebooks())}; }
`;
}
