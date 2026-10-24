// The Node hosts' reading of a limits file (src/limits.ts has the rest; the
// launcher, packages/sagebrush/bin/sagebrush.cjs, reads the same way).
import { openSync, readSync, closeSync } from "fs";
import { oneLine } from "./terminal-text";
import { LIMITS_MAX_BYTES, type LimitsText } from "./limits";

const WHY: Record<string, string> = { ENOENT: "No such file or directory", EACCES: "Permission denied", EISDIR: "Is a directory", ENOTDIR: "Not a directory", ELOOP: "Too many levels of symbolic links" };

/** A limits file's text, read with a bounded read (never more than
 * LIMITS_MAX_BYTES + 1 bytes, whatever its size says), or {error}. */
export function readLimitsFile(path: string): { text: string; name: string } | { error: string } {
  const name = oneLine(path);
  const buf = Buffer.alloc(LIMITS_MAX_BYTES + 1);
  let n = 0;
  try {
    const fd = openSync(path, "r");
    try {
      for (;;) {
        const k = readSync(fd, buf, n, buf.length - n, null);
        if (k === 0) break;
        n += k;
        if (n === buf.length) break;
      }
    } finally {
      closeSync(fd);
    }
  } catch (e: any) {
    return { error: `limits: cannot read ${name}: ${WHY[e?.code] ?? oneLine(String(e?.code ?? e?.message ?? e))}` };
  }
  if (n > LIMITS_MAX_BYTES) return { error: `limits: ${name} is larger than ${LIMITS_MAX_BYTES} bytes` };
  let text: string;
  try {
    // (fatal: bytes that are not UTF-8 are refused; ignoreBOM: a BOM is kept,
    // for the validator to refuse as CPython's json does)
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buf.subarray(0, n));
  } catch {
    return { error: `limits: ${name} is not JSON: it is not UTF-8` };
  }
  return { text, name };
}

/** This run's limits: from the launcher (`preset`, when it decided), else
 * `--limits FILE`, else SAGEBRUSH_LIMITS=FILE.  {error} if the file selected
 * can't be read. */
export function selectLimits(file: string | null, preset?: LimitsText): LimitsText | { error: string } {
  if (preset !== undefined) return preset;
  let path = file;
  if (path === null) {
    try {
      path = process.env.SAGEBRUSH_LIMITS || null;
    } catch {
      path = null; // (a Deno without --allow-env)
    }
  }
  return path === null ? null : readLimitsFile(path);
}
