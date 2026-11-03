// The files a .tex reads with \input and \include (William's L4, Nov 2: they were silently ignored, which broke his
// shared macros file). Found as TeX finds them (images.ts texCandidates: the .tex's folder, ../, a leading "/" for
// the workspace's top; .tex added first), read by the host (the page from the workspace, the CLI from the folder it
// runs in, each with its own read rules), bounded here, and given to the engine as a snapshot: the engine never reads
// a file itself (engine/pipeline.mjs inputs, engine/demo-machine.mjs doInput). Pure: test-latex-units.mjs checks it.
import { texCandidates, notFoundWhy } from "./images";
import { openBytes, EDIT_MAX } from "./save";

/** At most this many included files, of at most EDIT_MAX bytes each and INPUT_BOUNDS.total in all. */
export const INPUT_BOUNDS = { files: 64, perFile: EDIT_MAX, total: 16 * 2 ** 20 };

/** What the host knows of a candidate path: its text, why it isn't read (refused, too large, not text), or absent. */
export type Known = { text: string } | { why: string } | { absent: true };

/** The engine's inputs, for the .tex at `docPath`, from what the host has read (`known`, by workspace path):
 * `files` (key -> text: the read ones), `resolve(name)` (the key, or why there is none) and `wanted(names)` (the
 * candidate paths the host should look at next: unknown ones for each name, in order, up to the first that might
 * be it). The .tex itself is the engine's main.tex. `relativeToFile`: the folders named from the file's (the CLI). */
export function engineInputs(docPath: string, known: Map<string, Known>, relativeToFile = false) {
  const files = new Map<string, string>();
  for (const [p, k] of known) if ("text" in k && p !== docPath) files.set(p, k.text);
  const resolve = (name: string): { key?: string; why?: string } => {
    const c = texCandidates(name, docPath);
    if (!c.ok) return { why: c.why };
    for (const p of c.paths) {
      if (p === docPath) return { key: "main.tex" };
      const k = known.get(p);
      if (k === undefined) return { why: "not read yet" };
      if ("text" in k) return { key: p };
      if ("why" in k) return { why: k.why };
    }
    return { why: notFoundWhy(docPath, c.searched, [], relativeToFile, name) };
  };
  const wanted = (names: string[]): string[] => {
    const out: string[] = [];
    for (const name of names) {
      const c = texCandidates(name, docPath);
      if (!c.ok) continue;
      for (const p of c.paths) {
        if (p === docPath) break;
        const k = known.get(p);
        if (k === undefined) { if (!out.includes(p)) out.push(p); break; }
        if (!("absent" in k)) break;
      }
    }
    return out;
  };
  return { files, resolve, wanted };
}

/** An included file's bytes as the engine's text, or why not, against what is already kept (`kept` bytes, `count`
 * files). */
export function admitInput(bytes: Uint8Array, kept: number, count: number, b = INPUT_BOUNDS): Known {
  if (count >= b.files) return { why: "too many included files (" + b.files + ")" };
  if (bytes.length > b.perFile || kept + bytes.length > b.total) return { why: "too large" };
  const o = openBytes(bytes);
  if (o.kind === "binary") return { why: o.why };
  return { text: o.text };
}
