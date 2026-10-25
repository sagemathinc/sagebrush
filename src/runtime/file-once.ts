// `open(F, M).write(S)` as a statement: the file is opened, written and closed
// at the statement, as CPython's temporary is when its last reference goes
// (plan-pyjs-file-visibility r7 with addendum 1, and c1 + c2: any F, M and S,
// open-once with the descriptor held while S is evaluated).  The compiler
// (emit.ts: fileOnceStmt) emits the site; it calls only what is exported here.
//
// The protocol, in CPython's order:
//   open, F and M are evaluated as today (any expressions);
//   if open is the builtin, F an exact str and M one of w, a, wb, ab:
//     fileOnceBegin opens the file (its error raised before S is evaluated);
//   S is evaluated as today (any expression without yield or await);
//   fileOnceEnd writes S through that descriptor and closes it, once;
//   if S (or anything before the end) raises, or Stop arrives,
//     fileOnceAbort closes it, once (the compiler's finally).
// S needs no special type: an exact str or bytes is written as is; a str
// subclass's text, or any bytes-like object (bytes subclass, bytearray,
// memoryview, array) as CPython's text and buffered writers take them; any
// other value raises CPython's TypeError, and a lone surrogate CPython's
// UnicodeEncodeError, after which the file is closed as CPython's would be.
// No file is opened a second time.
//
// The dependency inventory (test/file-once.test.ts checks it against this
// file's imports and names): the canonical open, by identity only; Node's fs
// (openSync, writeSync, closeSync) or the web build's shim (readFileSync,
// writeFileSync, appendFileSync); TextEncoder; the exception types,
// callObj/markRaised/isinstance/typeName/unbox, to raise and to read a str
// subclass's text; memoryview and bufferOf, for a bytes-like S; hostPath,
// the path as _fs reads it.  Nothing here is reached through a Python module
// attribute, a class attribute or a global: patching builtins.open declines
// the site, and patching _pyjs_open, its classes, _unwritten, _fs or io
// changes nothing here (deliberately: a patched private method is bypassed).
import { T, PyBytes, callObj, markRaised, isinstance, typeName, unbox } from "./object";
import { bufferOf } from "./ops";
import { hostPath } from "./modules";

// (the builtin open object, index.ts's, set once at start-up)
let canonicalOpen: any = null;
export function setCanonicalOpen(f: any): void {
  canonicalOpen = f;
}
// What the site's open must be, taken once at the module's start: the
// builtin open, or before start-up NEVER, which no Python value is (not
// null: None is null)
const NEVER = Object.freeze({});
export function fileOnceOpen(): any {
  return canonicalOpen ?? NEVER;
}

export interface FileOps {
  open(path: string, append: boolean): number;
  write(fd: number, data: Uint8Array, off: number, len: number): number;
  close(fd: number): void;
}
const nodeOps = (fs: any): FileOps => ({
  open: (p, append) => fs.openSync(p, fs.constants.O_WRONLY | fs.constants.O_CREAT | (append ? fs.constants.O_APPEND : fs.constants.O_TRUNC), 0o666),
  write: (fd, data, off, len) => fs.writeSync(fd, data, off, len),
  close: (fd) => fs.closeSync(fd),
});
// The web build's in-memory fs has no descriptors: a "descriptor" there is
// the path and a position, each write rewriting the file with the bytes at
// that position (so a write after another handle's lands where CPython's
// would), an append appending.
const shimOps = (fs: any): FileOps => {
  const open = new Map<number, { p: string; append: boolean; pos: number }>();
  let next = 1;
  return {
    open: (p, append) => {
      if (append) fs.appendFileSync(p, new Uint8Array(0));
      else fs.writeFileSync(p, new Uint8Array(0));
      open.set(next, { p, append, pos: 0 });
      return next++;
    },
    write: (fd, data, off, len) => {
      const h = open.get(fd)!;
      const part = data.subarray(off, off + len);
      if (h.append) fs.appendFileSync(h.p, part);
      else {
        const old: Uint8Array = fs.readFileSync(h.p);
        const out = new Uint8Array(Math.max(old.length, h.pos + part.length));
        out.set(old);
        out.set(part, h.pos);
        fs.writeFileSync(h.p, out);
        h.pos += part.length;
      }
      return len;
    },
    close: (fd) => {
      open.delete(fd);
    },
  };
};

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

// The three steps (ops: the descriptor calls; the test hook,
// test/file-once.test.ts, which Python can't reach):
// an open error raises before any write or close
function openWith(ops: FileOps, path: string, append: boolean, name: string): number {
  try {
    return ops.open(path, append);
  } catch (e) {
    throw osError(e, name);
  }
}
// every byte, through short writes; a write that takes nothing of what is
// left raises (EIO) rather than looping
function writeAllWith(ops: FileOps, fd: number, data: Uint8Array): void {
  for (let off = 0; off < data.length; ) {
    const k = ops.write(fd, data, off, data.length - off);
    if (!(typeof k === "number" && k > 0)) throw zeroProgress();
    off += k;
  }
}
// close, once: an error before it (err) is raised with a close error as its
// __context__; a close error alone is raised
function closeWith(ops: FileOps, fd: number, err: any): void {
  try {
    ops.close(fd);
  } catch (e) {
    const ce = osError(e, null);
    if (err === null) throw ce;
    if (err.__context__ === undefined || err.__context__ === null) err.__context__ = ce;
  }
  if (err !== null) throw err;
}
// Open, write all of data, close (the steps as one, for the native tests)
export function writeWhole(path: string, append: boolean, data: Uint8Array | null, ops: FileOps): void {
  const fd = openWith(ops, path, append, path);
  let err: any = null;
  try {
    if (data !== null) writeAllWith(ops, fd, data);
  } catch (e) {
    err = osError(e, null);
  }
  closeWith(ops, fd, err);
}

let defaultOps: FileOps | null = null;
function fsOps(): FileOps {
  if (defaultOps === null) {
    const fs = require("fs");
    defaultOps = typeof fs.openSync === "function" ? nodeOps(fs) : shimOps(fs);
  }
  return defaultOps;
}

// A site's open file: its descriptor, its mode, whether it is closed
export interface FileOnce {
  ops: FileOps;
  fd: number;
  binary: boolean;
  closed: boolean;
}
// The open, at the position CPython calls open(F, M): create or truncate
// ("w", "wb"), or create and append ("a", "ab"), mode 0o666 less the umask
export function fileOnceBegin(f: string, m: string, ops: FileOps = fsOps()): FileOnce {
  const fd = openWith(ops, hostPath(f), m[0] === "a", f);
  return { ops, fd, binary: m.length === 2, closed: false };
}
// S, from the site: set after S is evaluated, taken by the end (or by the
// declined path's write call), so that no temporary, argument or register of
// the site's frame keeps it (addendum 1)
export const fileOnceS: { v: any } = { v: undefined };
export function fileOnceTake(): any {
  const s = fileOnceS.v;
  fileOnceS.v = undefined;
  return s;
}

// S as the mode writes it: its bytes and write()'s result, or CPython's error
function textOf(s: any): [Uint8Array, number] {
  if (!(typeof s === "string" || isinstance(s, T.str))) throw markRaised(callObj(T.TypeError, [`write() argument must be str, not ${s === null || s === undefined ? "None" : typeName(s)}`]));
  const t: string = typeof s === "string" ? s : unbox(s);
  let n = 0;
  for (let i = 0; i < t.length; i++, n++) {
    const c = t.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < t.length && (t.charCodeAt(i + 1) & 0xfc00) === 0xdc00) i++;
    else if (c >= 0xd800 && c <= 0xdfff) throw markRaised(callObj(T.UnicodeEncodeError, ["utf-8", t, n, n + 1, "surrogates not allowed"]));
  }
  return [new TextEncoder().encode(t), n];
}
const notBuffer = (s: any) => markRaised(callObj(T.TypeError, [`a bytes-like object is required, not '${s === null || s === undefined ? "NoneType" : typeName(s)}'`]));
function bytesOf(s: any): [Uint8Array, number] {
  if (s instanceof PyBytes) return [s.a.subarray(0, s.n), s.n];
  if (s === null || s === undefined || typeof s !== "object" || isinstance(s, T.str) || isinstance(s, T.int) || isinstance(s, T.float) || isinstance(s, T.complex) || isinstance(s, T.list) || isinstance(s, T.tuple) || isinstance(s, T.dict) || isinstance(s, T.set)) throw notBuffer(s);
  let view: any;
  try {
    view = callObj(T.memoryview, [s]);
  } catch (e) {
    if (isinstance(e, T.TypeError)) throw notBuffer(s);
    throw e;
  }
  const b = bufferOf(view);
  if (b === undefined) throw notBuffer(s);
  return [b, b.length];
}

// The write and the close: S (from fileOnceS) through the descriptor, then
// the descriptor closed, once, whatever fails; write()'s result
export function fileOnceEnd(h: FileOnce): number {
  const s = fileOnceTake();
  let err: any = null;
  let n = 0;
  try {
    const [data, len] = h.binary ? bytesOf(s) : textOf(s);
    n = len;
    writeAllWith(h.ops, h.fd, data);
  } catch (e) {
    err = osError(e, null);
  }
  h.closed = true;
  closeWith(h.ops, h.fd, err);
  return n;
}
// S raised (or Stop arrived) before the end: the descriptor closed, once, a
// close error dropped (CPython reports its finalizer's as "Exception
// ignored"; the exception S raised is the one that propagates)
export function fileOnceAbort(h: FileOnce): void {
  fileOnceS.v = undefined;
  if (h.closed) return;
  h.closed = true;
  try {
    h.ops.close(h.fd);
  } catch {}
}
