// Install a freshly built engine module at its committed path, bytes only.
// fs.copyFileSync also copies the source's mode, and cargo writes .wasm
// outputs 0755, so a copy left wasm/sagebrush-engine.wasm executable: git saw
// a mode change and CI's "differs from a fresh build" warning fired even when
// the bytes were identical.  The committed file is 0644.
//
// The bytes go to a temp file in the same directory, which is completed and
// set 0644, then renamed onto dst: a failed or interrupted write never leaves
// a partial dst (CORR-213-1), and the temp is removed on failure.
import * as fs from "node:fs";
import { basename, dirname, join } from "node:path";

export function installWasm(src, dst, io = fs) {
  const bytes = io.readFileSync(src);
  const tmp = join(dirname(dst), `.${basename(dst)}.${process.pid}.${Date.now()}.tmp`);
  try {
    io.writeFileSync(tmp, bytes, { flag: "wx", mode: 0o644 });
    io.chmodSync(tmp, 0o644); // (the umask may have narrowed the create mode)
    io.renameSync(tmp, dst);
  } catch (e) {
    try {
      io.rmSync(tmp, { force: true });
    } catch {}
    throw e;
  }
  return bytes.length;
}

// A module without its custom sections (names, producers, debug info): what
// ships of a wasm module built for size (scripts/build-mp.mjs).
export function stripCustomSections(b) {
  const parts = [b.subarray(0, 8)];
  let i = 8;
  while (i < b.length) {
    const start = i;
    const id = b[i++];
    let size = 0, shift = 0, byte;
    do {
      byte = b[i++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    i += size;
    if (id !== 0) parts.push(b.subarray(start, i));
  }
  return Buffer.concat(parts);
}
