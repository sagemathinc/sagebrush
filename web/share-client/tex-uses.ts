// What a LaTeX document uses, for its Share… (folder-dialog.ts): the files its own commands name (\input, \include,
// \includegraphics, \bibliography, …) and the files its code names (namesIn, as the editor's Run gives Sage: its imports
// and its quoted paths), and, in turn, what the named .py and .sage files name. Paths relative to the document's
// folder; a name that leaves the folder (absolute, a ".." part, a "\" or "~") is never followed: it is reported as
// outside, and nothing outside the folder is ever offered (only the workspace's own files there are listed at all).
import { namesIn } from "../latex/names.mjs";

/** The commands whose argument is a file, and the extensions a name without one may have, in TeX's order. */
const FILE_CMDS: Record<string, string[]> = {
  input: [".tex"], include: [".tex"], subfile: [".tex"], includeonly: [],
  includegraphics: [".pdf", ".png", ".jpg", ".jpeg", ".svg", ".eps"], includepdf: [".pdf"],
  lstinputlisting: [], verbatiminput: [], VerbatimInput: [], inputminted: [],
  bibliography: [".bib"], addbibresource: [], bibliographystyle: [".bst"],
};
/** At most this many rounds of .py/.sage files naming more files (a module naming another, …). */
export const USES_ROUNDS = 8;

// (the text without its comments: % to the end of the line, a \% kept)
const uncommented = (t: string) => t.replace(/(^|[^\\])%.*$/gm, "$1");

/** A name's safe form relative to the folder, or null if it leaves the folder (absolute, "..", "\", "~", empty). */
export function safeRel(name: string): string | null {
  const n = name.trim().replace(/^\.\//, "");
  if (!n || n.startsWith("/") || n.includes("\\") || n.startsWith("~") || /[\u0000-\u001f]/.test(n)) return null;
  const parts = n.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return null;
  return n;
}

/** The files the document's own commands name: for each, the paths it may be (a name without an extension, each of its
 *  command's extensions too), and the names that leave the folder. */
export function texRefs(text: string): { paths: string[][]; outside: string[] } {
  const paths: string[][] = [], outside: string[] = [];
  const t = uncommented(text);
  // \cmd, optional [..] args, then {arg} (inputminted: {lang}{file}, its second)
  for (const m of t.matchAll(/\\(input|include|subfile|includegraphics|includepdf|lstinputlisting|verbatiminput|VerbatimInput|inputminted|bibliography|addbibresource|bibliographystyle)\*?\s*(?:\[[^\]]*\]\s*)*\{([^{}]*)\}(?:\s*\{([^{}]*)\})?/g)) {
    const cmd = m[1], arg = cmd === "inputminted" ? m[3] ?? "" : m[2];
    const names = cmd === "bibliography" ? arg.split(",") : [arg];
    for (const raw of names) {
      if (!raw.trim()) continue;
      const rel = safeRel(raw);
      if (!rel) { outside.push(raw.trim()); continue; }
      const exts = FILE_CMDS[cmd] ?? [];
      const hasExt = /\.[A-Za-z0-9]{1,5}$/.test(rel.split("/").pop()!);
      paths.push(hasExt ? [rel] : [rel, ...exts.map((e) => rel + e)]);
    }
  }
  return { paths, outside };
}

/** The files of the folder (`files`: their paths relative to it) that the document (`text`) uses: what its commands
 *  name, what its code names (a module m: m.py, m.sage, m/__init__.py and m/'s .py files; a quoted path: that file),
 *  and what the named .py and .sage files name in turn (`read` gives a file's text; at most USES_ROUNDS rounds).
 *  `outside`: the names that leave the folder, never followed. */
export async function texUses(text: string, files: string[], read: (rel: string) => Promise<string | null>): Promise<{ uses: Set<string>; outside: string[] }> {
  const have = new Set(files), uses = new Set<string>();
  const { paths, outside } = texRefs(text);
  for (const alts of paths) { const hit = alts.find((p) => have.has(p)); if (hit) uses.add(hit); }
  let todo = [text];
  for (let round = 0; round < USES_ROUNDS && todo.length; round++) {
    const names = new Set(todo.flatMap((c) => namesIn(c)));
    todo = [];
    for (const f of files) {
      if (uses.has(f)) continue;
      const top = f.split("/")[0], stem = f.replace(/(\/__init__)?\.(py|sage)$/, "");
      if (!(names.has(f) || (/\.(py|sage)$/.test(f) && (names.has(stem) || names.has(top))))) continue;
      uses.add(f);
      if (/\.(py|sage)$/.test(f)) { const t = await read(f); if (t) todo.push(t); }
    }
    // (a quoted name that leaves the folder, in the document's or its modules' code: reported, never followed)
    for (const n of names) if (n.includes("/") || n.startsWith("~")) { if (safeRel(n) === null && /\.[A-Za-z0-9]{1,5}$/.test(n)) outside.push(n); }
  }
  return { uses, outside: [...new Set(outside)] };
}
