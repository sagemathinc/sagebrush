// The LaTeX editor's file bytes <-> text (plan sbspace r5 §4, r6b E5): a file is opened as text only if it can be
// written back exactly, and saved only as what it was opened as.
//  - UTF-8, decoded fatally, with a leading BOM kept as U+FEFF in the text (ignoreBOM), so it is encoded once, never
//    prepended; a NUL or invalid UTF-8: not text (no editor, no preview).
//  - Line endings: a <textarea> turns CRLF into LF, so a file that is all CRLF is saved with CRLF; one that mixes line
//    endings, or has a lone CR, opens without Save.
//  - The round trip is asserted when the file is opened: the text, encoded back, must be the bytes read, or the file
//    opens without Save ("can't be written back exactly"). Saving encodes the same way.
export const EDIT_MAX = 4 * 2 ** 20;   // bytes: the editable limit, opening and saving

export type Opened =
  | { kind: "text"; text: string; eol: "\n" | "\r\n"; saveable: true }
  | { kind: "text"; text: string; eol: "\n" | "\r\n"; saveable: false; why: string }
  | { kind: "binary"; why: string };

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The text and line ending of a file's bytes, and whether it may be saved. */
export function openBytes(bytes: Uint8Array): Opened {
  if (bytes.includes(0)) return { kind: "binary", why: "it isn't valid UTF-8 text (it has a NUL byte)" };
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { kind: "binary", why: "it isn't valid UTF-8 text" };
  }
  const crlf = (decoded.match(/\r\n/g) ?? []).length, cr = (decoded.match(/\r/g) ?? []).length, lf = (decoded.match(/\n/g) ?? []).length;
  if (cr !== crlf || (crlf > 0 && lf !== crlf)) return { kind: "text", text: decoded.replace(/\r\n?/g, "\n"), eol: "\n", saveable: false, why: "this file mixes line endings" };
  const eol = crlf > 0 ? "\r\n" : "\n";
  const text = eol === "\r\n" ? decoded.replace(/\r\n/g, "\n") : decoded;
  if (bytes.length > EDIT_MAX) return { kind: "text", text, eol, saveable: false, why: "it is over the prototype's 4 MiB limit" };
  if (!sameBytes(encodeText(text, eol), bytes)) return { kind: "text", text, eol, saveable: false, why: "this file can't be written back exactly" };
  return { kind: "text", text, eol, saveable: true };
}

/** The bytes a text is saved as: UTF-8 (a leading U+FEFF is the BOM, once), with the file's own line ending. */
export function encodeText(text: string, eol: "\n" | "\r\n"): Uint8Array {
  // (a textarea's value has only LF; a CR that reached it anyway is normalized the same way)
  const t = text.replace(/\r\n?/g, "\n");
  return new TextEncoder().encode(eol === "\r\n" ? t.replace(/\n/g, "\r\n") : t);
}
