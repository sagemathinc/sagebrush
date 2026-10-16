// The board format's interfaces as their source writes them, for the
// scripts that publish the format from it: the field reference
// (scripts/board-format-fields.mjs) and the JSON Schema
// (scripts/board-format-schema.mjs).
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** A reader of root's files (web/board/doc.ts and the like): parse(file)
 * gives {interfaces, aliases, consts, text}; each interface is {doc,
 * fields: [{name, optional, type, doc}], unread: [lines it can't read]}. */
export function typeReader(root) {
  // (TypeScript 7 has no compiler API for scripts, and these files keep to
  // one plain style: a doc comment, `//` notes, `name?: type;` a line;
  // anything else is reported as unread)
  const files = new Map();
  return function parse(file) {
    if (files.has(file)) return files.get(file);
    const text = readFileSync(join(root, file), "utf8"), lines = text.split("\n");
    const interfaces = {}, aliases = {}, consts = {};
    let pending = null, current = null;
    // (a doc comment: one line, or several; its text as one line)
    const docAt = (i) => {
      let text = "", k = i;
      for (; k < lines.length; k++) {
        text += " " + lines[k].trim();
        if (lines[k].includes("*/")) break;
      }
      return [text.replace(/^\s*\/\*\*/, "").replace(/\*\/\s*$/, "").replace(/\s*\n?\s*\*(?!\/)\s?/g, " ").replace(/\s+/g, " ").trim(), k];
    };
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i], t = l.trim();
      if (current) {
        if (t === "}") { current = null; pending = null; continue; }
        if (t.startsWith("/**")) { const [d, k] = docAt(i); pending = d; i = k; continue; }
        if (t.startsWith("//") || t === "") continue;
        const m = /^([A-Za-z_]\w*)(\?)?:\s*(.+);$/.exec(t);
        if (!m) { current.unread.push(`${file}:${i + 1}: a line the field reference can't read: ${t}`); continue; }
        current.fields.push({ name: m[1], optional: !!m[2], type: m[3], doc: pending });
        pending = null;
        continue;
      }
      if (t.startsWith("/**")) { const [d, k] = docAt(i); pending = d; i = k; continue; }
      if (t.startsWith("//") || t === "") continue;
      let m = /^export interface (\w+) \{$/.exec(t);
      if (m) { current = interfaces[m[1]] = { doc: pending, fields: [], unread: [] }; pending = null; continue; }
      m = /^export type (\w+) = (.+);$/.exec(t);
      if (m) aliases[m[1]] = m[2];
      m = /^export const (\w+) = (.+);$/.exec(t);
      if (m) consts[m[1]] = m[2];
      pending = null;
    }
    const out = { interfaces, aliases, consts, text };
    files.set(file, out);
    return out;
  };
}

/** The parts of a type at its top level, split at `sep`. */
export function split(text, sep) {
  const out = [];
  let depth = 0, quote = null, start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") quote = c;
    else if ("<[(".includes(c)) depth++;
    else if (">])".includes(c)) depth--;
    else if (c === sep && depth === 0) { out.push(text.slice(start, i).trim()); start = i + 1; }
  }
  out.push(text.slice(start).trim());
  return out;
}
