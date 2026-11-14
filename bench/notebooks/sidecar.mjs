// The files beside a notebook that browser.mjs gives the page, and the reading of them for its front server.
// Only regular files are given: a symlink is never followed, neither when the files are chosen (lstat) nor when one
// is served (opened with O_NOFOLLOW, then checked to be the same regular file, of the size it had when chosen), so
// nothing outside the notebook's folder is read, and the byte cap holds for what is served.
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";

// (the files given to the page: at most this many, and this many bytes in all; the rest are left out)
export const FILES_MAX = 50, BYTES_MAX = 512 * 2 ** 20;

/** The files to give, name -> size: the regular files of dir in name order, not notebooks or dot files, within the caps. */
export function selectSidecars(dir, { files = FILES_MAX, bytes = BYTES_MAX } = {}) {
  const out = new Map();
  let total = 0;
  for (const f of readdirSync(dir).sort()) {
    if (out.size === files) break;
    if (f.endsWith(".ipynb") || f.startsWith(".")) continue;
    let st;
    try { st = lstatSync(join(dir, f)); } catch { continue; }
    if (!st.isFile() || total + st.size > bytes) continue;
    total += st.size;
    out.set(f, st.size);
  }
  return out;
}

/** The bytes of a chosen file, or null if it isn't one, or is now a symlink or anything but a regular file of its chosen size. */
export function readSidecar(dir, chosen, name) {
  if (!chosen.has(name)) return null;
  const size = chosen.get(name);
  let fd;
  // (O_NONBLOCK: a FIFO put in its place must not hang the open)
  try { fd = openSync(join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return null; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size !== size) return null;
    const buf = Buffer.alloc(size);
    let n = 0;
    while (n < size) {
      const k = readSync(fd, buf, n, size - n, n);
      if (k === 0) break;
      n += k;
    }
    return n === size ? buf : null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}
