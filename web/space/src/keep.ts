// What the viewer keeps in this browser, on this site's origin (localStorage): a person's edits to an object's code,
// and what its last run showed, per space and object. Bounded in bytes (UTF-8, the key and the value): at most
// KEPT.entries copies and KEPT.bytes in all, the oldest dropped first, before anything is written; a copy over
// KEPT.entry is kept without its figures, and not at all if still over. `storage`: localStorage, or a stand-in.
import { utf8Bytes } from "./read.ts";

export const KEPT = { entries: 200, bytes: 4 << 20, entry: 256 << 10 };
export const EDIT = "space3d:edit:";

// (whether it was kept)
export function keepEdit(storage, key, v, limits = KEPT) {
  let text = JSON.stringify(v);
  if (utf8Bytes(text) > limits.entry) text = JSON.stringify({ ...v, svg: null, png: null, scene: null });
  if (utf8Bytes(text) > limits.entry) return false;
  const size = utf8Bytes(key) + utf8Bytes(text);
  try {
    // (the other copies, the oldest first: dropped until this one fits, then it is written)
    const others = [];
    for (let k = 0; k < storage.length; k++) {
      const name = storage.key(k);
      if (!name?.startsWith(EDIT) || name === key) continue;
      const t = storage.getItem(name) ?? "";
      let at = 0;
      try { at = Number(JSON.parse(t).at) || 0; } catch {}
      others.push([name, utf8Bytes(name) + utf8Bytes(t), at]);
    }
    others.sort((a, b) => a[2] - b[2]);
    let count = others.length + 1, bytes = others.reduce((n, x) => n + x[1], size);
    for (const [name, len] of others) {
      if (count <= limits.entries && bytes <= limits.bytes) break;
      storage.removeItem(name); count--; bytes -= len;
    }
    if (count > limits.entries || bytes > limits.bytes) return false;
    storage.setItem(key, text);
    return true;
  } catch {
    return false;
  }
}
