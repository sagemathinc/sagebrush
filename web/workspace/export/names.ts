// An archive member's name, refused (never renamed) if a .zip can't hold it safely (astra's EXPORT-ZIPNAME-1): an
// empty name; a leading "/"; a trailing "/" but a folder's own (and a folder without it); a part that is empty, ".",
// "..", ends in "." or a space, holds \ : < > " | ? * or a control character, or is a Windows device name (CON PRN AUX
// NUL, COM/LPT with 1-9 or ¹²³, with or without an extension).  Case-only collisions: a DATA follow-up's.  The bytes are
// checked as they are: every byte tested is ASCII or a superscript's C2 B9/B2/B3, never inside another character.
const SLASH = 0x2f, DOT = 0x2e, SPACE = 0x20;
// \ : < > " | ? *
const FORBIDDEN = new Set([0x5c, 0x3a, 0x3c, 0x3e, 0x22, 0x7c, 0x3f, 0x2a]);
const upper = (c: number) => (c >= 0x61 && c <= 0x7a ? c - 32 : c);

/** Whether part `b[s, e)`'s base (up to its first ".") is a device name. */
function device(b: Uint8Array, s: number, e: number): boolean {
  let end = s;
  while (end < e && b[end] !== DOT) end++;
  const len = end - s;
  if (len < 3) return false;
  const a = upper(b[s]), m = upper(b[s + 1]), z = upper(b[s + 2]);
  const three = String.fromCharCode(a, m, z);
  if (len === 3) return three === "CON" || three === "PRN" || three === "AUX" || three === "NUL";
  if (three !== "COM" && three !== "LPT") return false;
  if (len === 4) return b[s + 3] >= 0x31 && b[s + 3] <= 0x39;
  return len === 5 && b[s + 3] === 0xc2 && (b[s + 4] === 0xb9 || b[s + 4] === 0xb2 || b[s + 4] === 0xb3);
}

/** Why member name `b[0, n)` (UTF-8) can't be written, or null.  `folder`: a directory member, `name/`. */
export function unsafeMemberBytes(b: Uint8Array, n: number, folder: boolean): string | null {
  if (n === 0) return "an empty name";
  if (b[0] === SLASH) return "it starts with /";
  if (folder ? b[n - 1] !== SLASH : b[n - 1] === SLASH) return folder ? "a folder's name without its /" : "it ends with /";
  const end = folder ? n - 1 : n;
  let start = 0;
  for (let i = 0; i <= end; i++) {
    const c = i < end ? b[i] : SLASH;
    if (c === SLASH) {
      const len = i - start;
      if (len === 0) return "an empty part (//)";
      if ((len === 1 && b[start] === DOT) || (len === 2 && b[start] === DOT && b[start + 1] === DOT)) return "a . or .. part";
      if (b[i - 1] === DOT || b[i - 1] === SPACE) return "a name ending in . or a space";
      if (device(b, start, i)) return "a device name (CON, NUL, COM1…)";
      start = i + 1;
    } else if (FORBIDDEN.has(c)) return `a ${String.fromCharCode(c)} in a name`;
    else if (c < 0x20 || c === 0x7f) return "a control character in a name";
  }
  return null;
}

const enc = new TextEncoder();
/** The same, for a name as a string. */
export function unsafeMember(name: string, folder: boolean): string | null {
  const b = enc.encode(name);
  return unsafeMemberBytes(b, b.length, folder);
}

/** The words of an export refused for unsafe names: `paths`, the first few (workspace paths), of `count` in all. */
export function unsafeNamesWhy(paths: string[], count: number): string {
  const shown = paths.map((p) => p.slice(1)).join(", ");
  const more = count > paths.length ? ` and ${count - paths.length} more` : "";
  return `${count === 1 ? "A file's name" : `${count} files' names`} can't go safely into a .zip (a character such as \\ or :, a device name such as NUL, or a name ending in a dot or space): ${shown}${more}. Rename ${count === 1 ? "it" : "them"}, then export again.`;
}
