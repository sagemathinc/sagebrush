// A board downloaded as one HTML file (export.ts), opened again: its
// document is the JSON the file embeds, read from the file's text alone.
// Nothing of the file is parsed as HTML, so none of its scripts or markup
// ever runs; a file that is not a Sagebrush export, or whose embedded JSON
// is not well-formed, is refused.  The JSON is then a document like any
// other opened (formatError, isBoard): untrusted text, shown as such.
// The file's carried outputs (#sb-outputs) are not taken: outputs kept here
// are this browser's own runs, and its code runs again.  For any Sagebrush
// export (a notebook's too): `id` and `generator` say which.

/** Whether `text` is an HTML file rather than JSON, Markdown or a CoCalc board. */
export function isHtml(text: string): boolean {
  return /^\s*(?:<!doctype html|<html[\s>])/i.test(text.slice(0, 1024));
}

/**
 * The JSON a Sagebrush export embeds as `<script type="application/json"
 * id="${id}">`, parsed; null if `text` is no such export: its generator
 * (`<meta name="generator">`, near its start, as assemble() writes it)
 * starts with `generator`, and the script is there, whole, its JSON
 * well-formed. (exportHtml writes each "<" in it as \u003c, so no
 * "</script>" is in it: the first "</script>" after it is its end.)
 */
export function embeddedJson(text: string, id: string, generator: string): unknown {
  const meta = /<meta name="generator" content="([^"<>]*)">/.exec(text.slice(0, 8192));
  if (!meta || !meta[1].startsWith(generator)) return null;
  const open = `<script type="application/json" id="${id}">`;
  const i = text.indexOf(open);
  if (i < 0) return null;
  const j = text.indexOf("</script>", i + open.length);
  if (j < 0) return null;
  try {
    return JSON.parse(text.slice(i + open.length, j));
  } catch {
    return null;
  }
}

/** A board downloaded as HTML: the board it holds (its JSON object), else an error saying why not. */
export function boardFromHtml(text: string): object {
  const d = embeddedJson(text, "sb-doc", "Sagebrush boards");
  if (!d || typeof d !== "object" || Array.isArray(d)) throw new Error("not a board: an HTML file, but not a board downloaded from Sagebrush (Download as HTML)");
  return d;
}
