// `open(F, M).write(S)` with plain operands, in one native step: the file is
// opened, written in full and closed at the statement, as CPython's
// temporary is when its last reference goes (plan-pyjs-file-visibility r7,
// with addendum 1).  The compiler (emit.ts: fileOnceCall) emits the site; it
// calls only what is exported here.
//
// The dependency inventory (test/file-once.test.ts checks it against this
// file's imports and names): the canonical open, by identity only; the
// canonical builtins module, by identity only; Node's fs (openSync,
// writeSync, closeSync) or the web build's shim (writeFileSync,
// appendFileSync); TextEncoder; the exception types and callObj/markRaised,
// to raise; hostPath, the path as _fs reads it.
// Nothing here is reached through a Python module attribute, a class
// attribute or a global: patching builtins.open declines the site, and
// patching _pyjs_open, its classes, _unwritten, _fs or io changes nothing
// here (deliberately: a patched private method is bypassed at a site).
import { T, PyBytes, typeOf, callObj, markRaised, NS_DICT, NS_GLOBALS } from "./object";
import { builtins } from "./builtins";
import { hostPath } from "./modules";

// (the builtin open object, index.ts's, set once at start-up)
let canonicalOpen: any = null;
export function setCanonicalOpen(f: any): void {
  canonicalOpen = f;
}

// A namespace whose reads run no user code: a module's own (a plain object),
// not exec's layered or mapping one, nor an exact dict's proxy; and the
// builtins module itself (r6 §1).  Identity and own-slot checks, no lookup.
export function fileOnceEnv(ns: any, b: any): boolean {
  return b === builtins && ns[NS_DICT] === undefined && ns[NS_GLOBALS] === undefined;
}
// A builtin's value for a peek, or undefined: builtinName's read of the
// builtins module, without its NameError
export function fileOncePeekBuiltin(k: string): any {
  return Object.prototype.hasOwnProperty.call(builtins, k) ? builtins[k] : undefined;
}
// What the site's open must be (r7 §2.2, the prefix inlined by the compiler:
// open is this object, F an exact str, M one of w, a, wb, ab; no Python
// call): the canonical open, when the builtins and each namespace a global
// operand reads (nss, then b, the builtins last) are safe (fileOnceEnv),
// else NEVER, which no Python value is, so the site declines.  Taken once,
// at the module's start.
const NEVER = Object.freeze({});
export function fileOnceOpen(...nsb: any[]): any {
  const b = nsb[nsb.length - 1];
  if (canonicalOpen === null || b !== builtins) return NEVER;
  for (let i = 0; i < nsb.length - 1; i++) if (!fileOnceEnv(nsb[i], b)) return NEVER;
  return canonicalOpen;
}
// S fits the mode: an exact str with no lone surrogate (UTF-8 encodes it),
// or exact bytes
export function fileOnceFits(s: any, m: string): boolean {
  if (m.length === 2) return s instanceof PyBytes && typeOf(s) === T.bytes;
  return typeof s === "string" && wellFormed(s);
}
const wellFormed: (s: string) => boolean =
  typeof (String.prototype as any).isWellFormed === "function"
    ? (s) => (s as any).isWellFormed()
    : (s) => !/[\uD800-\uDFFF]/.test(s.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ""));

export interface FileOps {
  open(path: string, append: boolean): number;
  write(fd: number, data: Uint8Array, off: number, len: number): number;
  close(fd: number): void;
}
// (the descriptor calls; the web build's shim has none, and writes a whole
// file in one call instead: see whole())
const nodeOps = (fs: any): FileOps => ({
  open: (p, append) => fs.openSync(p, fs.constants.O_WRONLY | fs.constants.O_CREAT | (append ? fs.constants.O_APPEND : fs.constants.O_TRUNC), 0o666),
  write: (fd, data, off, len) => fs.writeSync(fd, data, off, len),
  close: (fd) => fs.closeSync(fd),
});

// errno, strerror and the OSError subclass CPython makes of that errno
const STRERROR: Record<string, [number, string]> = {
  ENOENT: [2, "No such file or directory"],
  EACCES: [13, "Permission denied"],
  EPERM: [1, "Operation not permitted"],
  EISDIR: [21, "Is a directory"],
  ENOTDIR: [20, "Not a directory"],
  ENOSPC: [28, "No space left on device"],
  EIO: [5, "Input/output error"],
  EROFS: [30, "Read-only file system"],
  EFBIG: [27, "File too large"],
  EDQUOT: [122, "Disk quota exceeded"],
  ELOOP: [40, "Too many levels of symbolic links"],
  ENAMETOOLONG: [36, "File name too long"],
  EMFILE: [24, "Too many open files"],
  ENXIO: [6, "No such device or address"],
  ETXTBSY: [26, "Text file busy"],
};
function errClass(errno: number): any {
  switch (errno) {
    case 2:
      return T.FileNotFoundError;
    case 1:
    case 13:
      return T.PermissionError;
    case 21:
      return T.IsADirectoryError;
    case 20:
      return T.NotADirectoryError ?? T.OSError;
    default:
      return T.OSError;
  }
}
// The Python exception for a failed fs call: with the file's name for the
// open's, without one for a write's or close's, as CPython's
function osError(e: any, path: string | null): any {
  if (e?.$cls !== undefined) return e;
  if (e?.name === "NotCapable" || e?.name === "PermissionDenied" || e?.code === "ERR_ACCESS_DENIED") return markRaised(callObj(T.PermissionError, path === null ? [13, String(e.message).split("\n")[0]] : [13, String(e.message).split("\n")[0], path]));
  const known = STRERROR[e?.code];
  const errno = known !== undefined ? known[0] : typeof e?.errno === "number" ? Math.abs(e.errno) : 0;
  const msg = known !== undefined ? known[1] : String(e?.message ?? e);
  return markRaised(callObj(errClass(errno), path === null ? [errno, msg] : [errno, msg, path]));
}
const zeroProgress = () => markRaised(callObj(T.OSError, [5, "Input/output error: a write made no progress"]));

// Open, write all of data, close: the descriptor is closed exactly once,
// whatever fails.  An open error raises before any write or close; a write
// error is raised with a close error after it as its __context__; a close
// error alone is raised.  A write that takes nothing of what is left raises
// (EIO) rather than looping.  (ops: the test hook, test/file-once.test.ts;
// Python can't reach it)
export function writeWhole(path: string, append: boolean, data: Uint8Array | null, ops: FileOps): void {
  let fd: number;
  try {
    fd = ops.open(path, append);
  } catch (e) {
    throw osError(e, path);
  }
  let err: any = null;
  try {
    if (data !== null) {
      for (let off = 0; off < data.length; ) {
        const k = ops.write(fd, data, off, data.length - off);
        if (!(typeof k === "number" && k > 0)) throw zeroProgress();
        off += k;
      }
    }
  } catch (e) {
    err = osError(e, null);
  }
  try {
    ops.close(fd);
  } catch (e) {
    const ce = osError(e, null);
    if (err === null) throw ce;
    if (err.__context__ === undefined || err.__context__ === null) err.__context__ = ce;
  }
  if (err !== null) throw err;
}

let fsOps: FileOps | null = null;
let fsMod: any = null;
function fsModule(): any {
  return (fsMod ??= require("fs"));
}
// the web build's in-memory fs: a whole file in one call (no descriptor)
function whole(fs: any, p: string, append: boolean, data: Uint8Array | null, path: string): void {
  try {
    const b = data ?? new Uint8Array(0);
    if (append) fs.appendFileSync(p, b);
    else fs.writeFileSync(p, b);
  } catch (e) {
    throw osError(e, path);
  }
}
function run(path: string, m: string, data: Uint8Array | null): void {
  const fs = fsModule();
  const p = hostPath(path);
  const append = m[0] === "a";
  if (typeof fs.openSync !== "function") return whole(fs, p, append, data, path);
  writeWhole(p, append, data, (fsOps ??= nodeOps(fs)));
}

// len() of the str these UTF-8 bytes encode: its characters' first bytes.
// (Not strpos's cpLen, whose cache keeps the last long string it measured:
// the site keeps no reference to S once it returns)
function utf8Chars(b: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < b.length; i++) if ((b[i] & 0xc0) !== 0x80) n++;
  return n;
}
// The eligible site: the native step, then len(S).  S, the site's peek, is
// handed over in fileOnceS.v, which the site set and this clears, and which
// the site's temporary no longer holds (addendum 1); no Python runs between.
export const fileOnceS: { v: any } = { v: undefined };
export function fileOnceWrite(f: string, m: string): number {
  const s = fileOnceS.v;
  fileOnceS.v = undefined;
  if (typeof s === "string") {
    const data = new TextEncoder().encode(s);
    run(f, m, data);
    return data.length === s.length ? s.length : utf8Chars(data);
  }
  run(f, m, (s as PyBytes).a.subarray(0, (s as PyBytes).n));
  return (s as PyBytes).n;
}
// An unbound S: the open's effects (create or truncate; its error first),
// then today's read of S raises the scope's own error (r7 §2.3)
export function fileOnceTouch(f: string, m: string): void {
  run(f, m, null);
}
// (after fileOnceTouch, today's read of an unbound S raised; a value here
// would mean the peek and the read disagreed)
export function fileOnceNever(_v: any): never {
  throw markRaised(callObj(T.SystemError, ["open(...).write(...): the name was unbound when peeked and bound when read"]));
}
