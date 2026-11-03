// A file's new contents put in place whole or not at all (`sagebrush notebook`'s api/file PUT, src/notebook.ts):
//   - written to a temporary file of a fresh random name beside it, made exclusively ("wx": never an entry that is
//     there, a link to elsewhere included: astra's LOCAL-CONTAIN-1);
//   - every byte written (a write may take fewer than asked: the rest is written, and one that makes no progress is a
//     failure: astra's LOCAL-CONTAIN-3), then flushed to the disk;
//   - only then renamed over the file. On any failure the temporary file, and only it, is removed: the file is as it was.
// `io` is the file system's calls, a test's own to inject a short write or a failure.
import * as fs from "fs";
import { join } from "path";
import { randomBytes } from "crypto";

export type WriteIo = Pick<typeof fs, "openSync" | "writeSync" | "fsyncSync" | "closeSync" | "renameSync" | "unlinkSync">;

/** `data` as the contents of `folder`/`name`, whole or not at all. */
export function writeReplacing(folder: string, name: string, data: Uint8Array, io: WriteIo = fs): void {
  const tmp = join(folder, `.${name}.sagebrush-tmp-${randomBytes(8).toString("hex")}`);
  const fd = io.openSync(tmp, "wx", 0o644);
  try {
    for (let at = 0; at < data.length; ) {
      const n = io.writeSync(fd, data, at, data.length - at);
      if (!(n > 0)) throw new Error(`the write made no progress at byte ${at} of ${data.length}`);
      at += n;
    }
    io.fsyncSync(fd);
  } catch (e) {
    try { io.closeSync(fd); } catch {}
    try { io.unlinkSync(tmp); } catch {}
    throw e;
  }
  io.closeSync(fd);
  try {
    io.renameSync(tmp, join(folder, name));
  } catch (e) {
    try { io.unlinkSync(tmp); } catch {}
    throw e;
  }
}
