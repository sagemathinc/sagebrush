// The file system in the browser: in memory, in the worker.  The page
// keeps a copy in IndexedDB (files survive reloads and restarts): it loads
// the files with load() when a worker starts, and hooks.changed() tells it
// about every change Python makes.  Paths are absolute from "/", which is
// also the initial working directory.  Output streams go to hooks.write.
// (read: a file's contents were read, for the reactive notebook's file
// tracking; with the version of the page's file whose bytes they are (its
// origin, below) if they are still those, for the replay bundle:
// web/notebook/bundle-blobs.mjs)  A shared collection's files are mounted (mount()): fetched from
// the user-content domain the first time Python reads them, and checked
// against their SHA-256, so a notebook that reads one file of a large
// collection downloads only that file.
const hooks: {
  write: (fd: number, s: string) => void;
  changed: (path: string, data: Uint8Array | null) => void;
  read: (path: string, origin?: string) => void;
  /** a change refused (outside what this document may change, or the permissions changed meanwhile: `why`): the page
   * shows its prompt for that path */
  refused: (path: string, what: string, why: Refusal) => void;
  /** a rename, as one change of every path it moves (confinement phase 2: the page admits it whole or not at all);
   * unset, each path's change goes to `changed` */
  renamed: ((from: string, to: string, changes: [string, Uint8Array | null][]) => void) | null;
} = { write: () => {}, changed: () => {}, read: () => {}, refused: () => {}, renamed: null };
export const __hooks = hooks;

// What this document may change (the page's policy, web/notebook/permissions.js; confinement phase 2, write trees):
// checked at every change, before anything changes: a write, an append, a truncate, an open for writing (a handle
// opened before, at its next write, with the entry's current path), mkdir, unlink, rmdir, rename (both ends), rm.
// `allowed(path)` answers for the resolved, canonical path: true, or why not ("refused": outside what may be changed;
// "changed": the permissions changed since this run began, so nothing is changed until the next run). /tmp and
// /$pyjs (by path segment) are scratch: changed freely. Refused: a PermissionError saying why.
export type Refusal = "refused" | "changed";
let allowed: (path: string) => true | Refusal = () => true;
export function setWritable(f: (path: string) => true | Refusal) { allowed = f; }
export const NOT_WRITABLE = "this notebook isn't allowed to change this file: allow its folder when the bar asks, or in File > Permissions…, then run it again";
export const PERMS_CHANGED = "this notebook's permissions changed while it ran: run it again";
/** Scratch: /tmp and /$pyjs and what is below them, by path segment (/tmpfile and /tmp2 are ordinary paths). */
export const scratch = (r: string) => r === "/tmp" || r.startsWith("/tmp/") || r === "/$pyjs" || r.startsWith("/$pyjs/");
function mayChange(r: string, what: string) {
  if (scratch(r)) return;
  const ok = allowed(r);
  if (ok === true) return;
  hooks.refused(r, what, ok);
  // (named so the runtime's open() and os calls raise PermissionError with these words, src/runtime/file-once.ts)
  const e: any = new Error(ok === "changed" ? PERMS_CHANGED : NOT_WRITABLE);
  e.name = "PermissionDenied";
  e.code = "EACCES";
  e.errno = -13;
  throw e;
}

import { sha256Hex } from "../../src/runtime/sha256";

interface Remote {
  url: string;
  sha256: string;
  size: number;
}
interface Entry {
  data: Uint8Array;
  mtime: number;
  /** not fetched yet */
  remote?: Remote;
  /** the path that names it now, null once it is unlinked (an open file
   * keeps the entry, as a descriptor keeps an inode: onceOpen) */
  path: string | null;
  /** a file the page gave (load, put): which version of the page's file its
   * bytes are, while they are still (or still begin with) that version's:
   * "s:<path>" for one the session started with, else the token the page gave
   * with it (a put's, or a load's third element); kept through a rename and an
   * append, gone once Python writes it over or truncates it, or the page puts
   * it again (another version) */
  origin?: string;
  /** os.chmod's permission bits and os.utime's access time: session-local (P3b-2, @sagebrush's ruling): stat shows
   * them for the session, the page's change callback (bytes only) never carries them, a reload forgets them */
  perm?: number;
  atime?: number;
}
const files = new Map<string, Entry>();
// (an entry named r; one that r named before is unlinked)
function place(r: string, f: Entry): void {
  const old = files.get(r);
  if (old !== undefined && old !== f) old.path = null;
  files.set(r, f);
  f.path = r;
}
function drop(r: string): void {
  const f = files.get(r);
  if (f !== undefined) f.path = null;
  files.delete(r);
}
const dirs = new Map<string, number>([["/", Date.now()]]); // path -> mtime
// (inode numbers, given at a file's or folder's first stat: a file's is its entry's, kept through a rename as a
// descriptor's inode is; a folder's moves with it; os.path.samefile and pathlib's samefile compare them, as
// CPython's do, so two files must never share one)
let nextIno = 2;
const fileIno = new WeakMap<Entry, number>();
const dirIno = new Map<string, number>();
const inoOfFile = (f: Entry) => fileIno.get(f) ?? (fileIno.set(f, nextIno), nextIno++);
const inoOfDir = (d: string) => dirIno.get(d) ?? (dirIno.set(d, nextIno), nextIno++);
// (a folder's os.chmod bits and os.utime access time, session-local as a file's: they move with a rename, go with rmdir)
const dirPerm = new Map<string, number>();
const dirAtime = new Map<string, number>();
let cwd = "/";

const g = globalThis as any;
if (g.process) {
  g.process.cwd = () => cwd;
  g.process.chdir = (p: string) => {
    const d = resolve(p);
    if (!dirs.has(d)) fail("ENOENT", -2, "chdir", p);
    cwd = d;
  };
}

function fail(code: string, errno: number, what: string, path: string): never {
  const e: any = new Error(`${code}: ${what} '${path}'`);
  e.code = code;
  e.errno = errno;
  throw e;
}

export function resolve(p: string): string {
  p = String(p);
  const parts = (p.startsWith("/") ? p : cwd + "/" + p).split("/");
  const out: string[] = [];
  for (const s of parts) {
    if (s === "" || s === ".") continue;
    if (s === "..") out.pop();
    else out.push(s);
  }
  return "/" + out.join("/");
}
const parent = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";
const bytes = (data: any): Uint8Array =>
  typeof data === "string" ? new TextEncoder().encode(data) : data instanceof Uint8Array ? data.slice() : new Uint8Array(data);

function ensureDirs(p: string) {
  for (let d = parent(p); !dirs.has(d); d = parent(d)) dirs.set(d, Date.now());
}

/** The interpreter starts in `d` (a notebook's own folder, as Jupyter runs a notebook: the Nov 4 ruling): it and the
 * folders above it are known here, without a change to the person's files, and relative paths resolve against it.
 * `d` is the worker's checked absolute path (web/worker.ts startDirOf). */
export function startIn(d: string) {
  ensureDirs(d + "/.");
  dirs.set(d, dirs.get(d) ?? Date.now());
  cwd = d;
}

// The page's files (path -> bytes, and a version's token if not one the session
// starts with), as a worker starts: no change hooks.
export function load(entries: [string, Uint8Array, string?][]) {
  for (const [p, data, tok] of entries) {
    const r = resolve(p);
    ensureDirs(r);
    place(r, { data: new Uint8Array(data), mtime: Date.now(), path: r, origin: typeof tok === "string" ? tok : "s:" + String(p) });
  }
}
// A shared collection's files: [path, {url, sha256, size}], fetched when read.
export function mount(entries: [string, Remote][]) {
  for (const [p, remote] of entries) {
    const r = resolve(p);
    ensureDirs(r);
    place(r, { data: new Uint8Array(0), mtime: Date.now(), remote: { url: String(remote.url), sha256: String(remote.sha256), size: Number(remote.size) }, path: r });
  }
}
// (synchronously: Python's open() is synchronous, and a worker may block)
function fetchRemote(path: string, m: Remote): Uint8Array {
  let data: Uint8Array;
  const sync = (globalThis as any).__SAGEBRUSH_FETCH_SYNC__;
  if (typeof sync === "function") {
    // (in the runner, which has no network, the page fetches it: web/runner)
    try {
      data = sync(m.url);
    } catch (e) {
      fail("EIO", -5, `fetch (${(e as Error)?.message ?? e})`, path);
    }
  } else {
    if (typeof XMLHttpRequest !== "function") fail("EIO", -5, "fetch", path);
    const x = new XMLHttpRequest();
    x.open("GET", m.url, false);
    x.responseType = "arraybuffer";
    try {
      x.send();
    } catch {
      fail("EIO", -5, "fetch", path);
    }
    if (x.status !== 200) fail("EIO", -5, `fetch (HTTP ${x.status})`, path);
    data = new Uint8Array(x.response as ArrayBuffer);
  }
  if (data.length !== m.size || sha256Hex(data) !== m.sha256) fail("EIO", -5, "fetch (the file is not the one shared: wrong SHA-256)", path);
  return data;
}
function contents(r: string, f: Entry): Uint8Array {
  if (f.remote) {
    f.data = fetchRemote(r, f.remote);
    delete f.remote;
  }
  return f.data;
}

// Changes the page makes (an upload, a delete in the files panel), with the
// new version's token (none: bytes no version of the page's, e.g. another
// interpreter's write).
export function put(p: string, data: Uint8Array | null, tok?: string) {
  const r = resolve(p);
  if (data === null) drop(r);
  else {
    ensureDirs(r);
    rewrite(r, new Uint8Array(data));
    const f = files.get(r)!;
    if (typeof tok === "string") f.origin = tok;
    else delete f.origin;
  }
}
// (a file's new contents: the same entry if there is one, as a write to an
// existing file is the same file to every descriptor open on it)
function rewrite(r: string, data: Uint8Array): void {
  const f = files.get(r);
  if (f === undefined) place(r, { data, mtime: Date.now(), path: r });
  else {
    delete f.remote;
    f.data = data;
    f.mtime = Date.now();
  }
}

function setFile(r: string, data: Uint8Array) {
  if (dirs.has(r)) fail("EISDIR", -21, "open", r);
  if (!dirs.has(parent(r))) fail("ENOENT", -2, "open", r);
  rewrite(r, data);
  hooks.changed(r, data);
}

// A file held open (open(F, M).write(S)'s, src/runtime/file-once.ts): its
// entry, not its path, so that a rename, an unlink or a new file at the path
// while S is evaluated leaves the write where a descriptor's would go
export interface OpenFile {
  entry: Entry;
  append: boolean;
  pos: number;
}
// open for writing: create, or truncate ("w"), or keep ("a")
export function onceOpen(p: string, append: boolean): OpenFile {
  const r = resolve(p);
  if (dirs.has(r)) fail("EISDIR", -21, "open", p);
  if (!dirs.has(parent(r))) fail("ENOENT", -2, "open", p);
  mayChange(r, "open");
  let f = files.get(r);
  if (f === undefined) {
    f = { data: new Uint8Array(0), mtime: Date.now(), path: r };
    place(r, f);
    hooks.changed(r, f.data);
  } else if (!append) {
    delete f.remote;
    delete f.origin;
    f.data = new Uint8Array(0);
    f.mtime = Date.now();
    hooks.changed(r, f.data);
  }
  return { entry: f, append, pos: 0 };
}
// bytes at the handle's position, or at the end when appending; the page
// told of the change while a path names the file
export function onceWrite(h: OpenFile, data: Uint8Array): void {
  const f = h.entry;
  if (f.path !== null) mayChange(f.path, "write");
  const old = contents(f.path ?? "", f);
  const at = h.append ? old.length : h.pos;
  const out = new Uint8Array(Math.max(old.length, at + data.length));
  out.set(old);
  out.set(data, at);
  f.data = out;
  f.mtime = Date.now();
  h.pos = at + data.length;
  if (f.path !== null) hooks.changed(f.path, out);
}

// The interpreter's file descriptors (os.open, os.read, os.write, os.lseek, os.fstat, os.close: P3b-2, the design note
// astra cleared): this worker's own table, one per session, dropped with the worker. A descriptor holds its entry,
// not its path, as onceOpen's handle does (a rename keeps it, an unlink orphans it, a new file at the path is another
// entry). Numbers are the lowest free from 3 (0, 1 and 2 stay the standard streams), and name only entries here: no
// host, Tauri or internal descriptor is reachable through them. Every write is checked when it happens
// (mayChange with the entry's current path), never once at the open.
interface Fd {
  entry: Entry;
  read: boolean;
  write: boolean;
  append: boolean;
  pos: number;
}
const fds = new Map<number, Fd>();
// (Linux's open flags: the access mode, the effects, and those with nothing to do here; anything else is refused)
const O_ACCMODE = 3, O_CREAT = 64, O_EXCL = 128, O_TRUNC = 512, O_APPEND = 1024;
const O_NOEFFECT = 2048 | 131072 | 524288; // O_NONBLOCK, O_NOFOLLOW (no symlinks here), O_CLOEXEC
// (an operation this file system doesn't do: os raises NotImplementedError with these words, before any effect)
function unsupported(what: string): never {
  const e: any = new Error(`${what} is not supported in Sagebrush's browser filesystem`);
  e.unsupported = true;
  throw e;
}
// (a descriptor's file is at most what a bytes object can be, the runtime's checked limit (ops.ts, 2**32 - 1): a
// position past it is EINVAL at lseek and a write past it EFBIG, as a file system's maximum size is; a growth the
// host can't allocate is MemoryError)
const FILE_MAX = 2 ** 32 - 1;
function noMemory(): never {
  const e: any = new Error("out of memory");
  e.memory = true;
  throw e;
}
const fdOf = (fd: number, what: string): Fd => fds.get(fd) ?? fail("EBADF", -9, what, "");
export function openSync(p: string, flags: number, _mode?: number): number {
  // (the whole value checked before any bitwise operator, which would drop the bits above 31: a C int, never negative)
  if (typeof flags !== "number" || !Number.isInteger(flags) || flags < 0 || flags > 0x7fffffff) unsupported("open with these flags");
  const acc = flags & O_ACCMODE;
  if (acc === 3) fail("EINVAL", -22, "open", p);
  if (flags & ~(O_ACCMODE | O_CREAT | O_EXCL | O_TRUNC | O_APPEND | O_NOEFFECT)) unsupported(`open with flags 0o${(flags & ~(O_ACCMODE | O_CREAT | O_EXCL | O_TRUNC | O_APPEND | O_NOEFFECT)).toString(8)}`);
  const write = acc !== 0;
  if (flags & O_TRUNC && !write) unsupported("open with O_TRUNC and O_RDONLY");
  const r = resolve(p);
  if (dirs.has(r)) unsupported("open of a folder");
  let f = files.get(r);
  if (f === undefined) {
    if (!(flags & O_CREAT)) fail("ENOENT", -2, "open", p);
    if (!dirs.has(parent(r))) fail("ENOENT", -2, "open", p);
    mayChange(r, "open");
    f = { data: new Uint8Array(0), mtime: Date.now(), path: r };
    place(r, f);
    hooks.changed(r, f.data);
  } else {
    if (flags & O_CREAT && flags & O_EXCL) fail("EEXIST", -17, "open", p);
    if (flags & O_TRUNC) {
      mayChange(r, "open");
      delete f.remote;
      delete f.origin;
      f.data = new Uint8Array(0);
      f.mtime = Date.now();
      hooks.changed(r, f.data);
    }
  }
  let fd = 3;
  while (fds.has(fd)) fd++;
  fds.set(fd, { entry: f, read: acc !== 1, write, append: !!(flags & O_APPEND), pos: 0 });
  return fd;
}
export function closeSync(fd: number): void {
  fdOf(fd, "close");
  fds.delete(fd);
}
export function fstatSync(fd: number) {
  const f = fdOf(fd, "fstat").entry;
  return {
    isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false,
    size: f.remote ? f.remote.size : f.data.length,
    mode: 0o100000 | (f.perm ?? 0o644),
    ino: inoOfFile(f), dev: 1, nlink: f.path === null ? 0 : 1, uid: 0, gid: 0,
    atimeMs: f.atime ?? f.mtime, mtimeMs: f.mtime, ctimeMs: f.mtime,
  };
}
// (os.lseek: the descriptor's position; SEEK_END from the entry's size now)
export function seekFd(fd: number, pos: number, how: number): number {
  const h = fdOf(fd, "lseek");
  const base = how === 0 ? 0 : how === 1 ? h.pos : how === 2 ? contents(h.entry.path ?? "", h.entry).length : NaN;
  if (Number.isNaN(base) || !Number.isSafeInteger(pos)) fail("EINVAL", -22, "lseek", "");
  const at = base + pos;
  if (at < 0 || at > FILE_MAX) fail("EINVAL", -22, "lseek", "");
  h.pos = at;
  return at;
}
// (os.write on a descriptor of this table: the bytes at its position, or the end when appending; checked now)
function writeFd(h: Fd, data: Uint8Array): number {
  if (!h.write) fail("EBADF", -9, "write", "");
  const f = h.entry;
  if (f.path !== null) mayChange(f.path, "write");
  const old = contents(f.path ?? "", f);
  const at = h.append ? old.length : h.pos;
  // (nothing to write changes nothing, wherever the position is, as POSIX's write of 0 bytes to a regular file)
  if (data.length === 0) return 0;
  if (at + data.length > FILE_MAX) fail("EFBIG", -27, "write", "");
  let out: Uint8Array;
  try {
    out = new Uint8Array(Math.max(old.length, at + data.length));
  } catch (e) {
    if (e instanceof RangeError) noMemory();
    throw e;
  }
  out.set(old);
  out.set(data, at);
  f.data = out;
  f.mtime = Date.now();
  delete f.origin;
  h.pos = at + data.length;
  if (f.path !== null) hooks.changed(f.path, out);
  return data.length;
}
export function writeSync(fd: number, data: any) {
  const h = fds.get(fd);
  if (h !== undefined) return writeFd(h, typeof data === "string" ? new TextEncoder().encode(data) : data);
  // (a closed, never-opened or negative descriptor: EBADF, as the kernel says; only 0, 1 and 2 are the standard
  // streams, 1 and 2 the page's)
  if (!(fd >= 0 && fd <= 2)) fail("EBADF", -9, "write", "");
  hooks.write(fd, typeof data === "string" ? data : new TextDecoder().decode(data));
}
// (so that the runtime's writeAll knows this writeSync, which takes all of
// its data at once and returns no count, from Node's)
(writeSync as any).webShim = true;
// (a descriptor of this table: up to buf.length bytes from its position, advanced; 0 at the end. Any other
// descriptor, the standard input among them, reads nothing here, as before)
export function readSync(fd?: number, buf?: Uint8Array) {
  const h = fd === undefined ? undefined : fds.get(fd);
  if (h === undefined) {
    if (fd !== undefined && !(fd >= 0 && fd <= 2)) fail("EBADF", -9, "read", "");
    return 0;
  }
  if (!h.read) fail("EBADF", -9, "read", "");
  const data = contents(h.entry.path ?? "", h.entry);
  const n = Math.max(0, Math.min(buf!.length, data.length - h.pos));
  buf!.set(data.subarray(h.pos, h.pos + n));
  h.pos += n;
  return n;
}
// (os.read on a descriptor of this table: up to n bytes from its position, advanced; the result exactly the bytes
// read, never a buffer of n)
export function readFd(fd: number, n: number): Uint8Array {
  const h = fdOf(fd, "read");
  if (!h.read) fail("EBADF", -9, "read", "");
  const data = contents(h.entry.path ?? "", h.entry);
  const out = data.slice(h.pos, h.pos + Math.max(0, Math.min(n, data.length - h.pos)));
  h.pos += out.length;
  return out;
}
// os.chmod: the permission bits only (never the kind or identity), checked before the change; session-local
export function chmodSync(p: string, mode: number) {
  const r = resolve(p);
  const f = files.get(r);
  if (!f && !dirs.has(r)) fail("ENOENT", -2, "chmod", p);
  mayChange(r, "chmod");
  if (f) f.perm = mode & 0o7777;
  else dirPerm.set(r, mode & 0o7777);
}
// os.utime: access and modification times in milliseconds, checked before the change; session-local
export function utimesMs(p: string, atimeMs: number, mtimeMs: number) {
  const r = resolve(p);
  const f = files.get(r);
  if (!f && !dirs.has(r)) fail("ENOENT", -2, "utime", p);
  mayChange(r, "utime");
  if (f) {
    f.atime = atimeMs;
    f.mtime = mtimeMs;
  } else {
    dirAtime.set(r, atimeMs);
    dirs.set(r, mtimeMs);
  }
}
export const existsSync = (p: string) => {
  const r = resolve(p);
  return files.has(r) || dirs.has(r);
};
export function readFileSync(p: string, enc?: any): any {
  const r = resolve(p);
  const f = files.get(r);
  if (!f) dirs.has(r) ? fail("EISDIR", -21, "read", p) : fail("ENOENT", -2, "open", p);
  hooks.read(r, f!.origin);
  const data = contents(r, f!);
  const encoding = typeof enc === "string" ? enc : enc?.encoding;
  return encoding ? new TextDecoder().decode(data) : data.slice();
}
export function writeFileSync(p: string, data: any) {
  const r = resolve(p);
  mayChange(r, "write");
  setFile(r, bytes(data));
  delete files.get(r)!.origin; // (Python's bytes now, not the page's; an append keeps them: appendFileSync)
}
export function appendFileSync(p: string, data: any) {
  const r = resolve(p);
  mayChange(r, "append");
  const f = files.get(r);
  const old = f ? contents(r, f) : new Uint8Array(0);
  const add = bytes(data);
  const both = new Uint8Array(old.length + add.length);
  both.set(old);
  both.set(add, old.length);
  setFile(r, both);
}
export function mkdirSync(p: string, opts?: any) {
  const r = resolve(p);
  if (opts?.recursive) {
    if (files.has(r)) fail("EEXIST", -17, "mkdir", p);
    for (let d = r, todo: string[] = []; ; d = parent(d)) {
      if (dirs.has(d)) {
        if (todo.length) mayChange(r, "mkdir");
        for (const t of todo.reverse()) dirs.set(t, Date.now());
        return;
      }
      if (files.has(d)) fail("ENOTDIR", -20, "mkdir", p);
      todo.push(d);
    }
  }
  if (dirs.has(r) || files.has(r)) fail("EEXIST", -17, "mkdir", p);
  if (!dirs.has(parent(r))) fail("ENOENT", -2, "mkdir", p);
  mayChange(r, "mkdir");
  dirs.set(r, Date.now());
}
export function readdirSync(p: string): string[] {
  const r = resolve(p);
  if (!dirs.has(r)) files.has(r) ? fail("ENOTDIR", -20, "scandir", p) : fail("ENOENT", -2, "scandir", p);
  const pre = r === "/" ? "/" : r + "/";
  const names = new Set<string>();
  for (const k of [...files.keys(), ...dirs.keys()]) {
    if (k !== r && k.startsWith(pre)) names.add(k.slice(pre.length).split("/")[0]);
  }
  return [...names].sort();
}
// (whether `p` may be written (mode's W_OK, 2), with nothing changed: open()'s "a", which writes only at its flush,
// refused at the open as CPython's is)
export function accessSync(p: string, mode = 0) {
  const r = resolve(p);
  if (!files.has(r) && !dirs.has(r)) fail("ENOENT", -2, "access", p);
  if (mode & 2) mayChange(r, "open");
}
export function statSync(p: string) {
  const r = resolve(p);
  const f = files.get(r), d = dirs.get(r);
  if (!f && d === undefined) fail("ENOENT", -2, "stat", p);
  const t = f ? f.mtime : d!;
  return {
    isDirectory: () => !f,
    isFile: () => !!f,
    isSymbolicLink: () => false,
    size: f ? (f.remote ? f.remote.size : f.data.length) : 0,
    mode: f ? 0o100000 | (f.perm ?? 0o644) : 0o40000 | (dirPerm.get(r) ?? 0o755),
    ino: f ? inoOfFile(f) : inoOfDir(r), dev: 1, nlink: 1, uid: 0, gid: 0,
    atimeMs: (f ? f.atime : dirAtime.get(r)) ?? t, mtimeMs: t, ctimeMs: t,
  };
}
export function unlinkSync(p: string) {
  const r = resolve(p);
  if (!files.has(r)) dirs.has(r) ? fail("EISDIR", -21, "unlink", p) : fail("ENOENT", -2, "unlink", p);
  mayChange(r, "unlink");
  drop(r);
  hooks.changed(r, null);
}
export function rmdirSync(p: string) {
  const r = resolve(p);
  if (!dirs.has(r)) fail("ENOENT", -2, "rmdir", p);
  if (readdirSync(r).length) fail("ENOTEMPTY", -39, "rmdir", p);
  mayChange(r, "rmdir");
  if (r !== "/") {
    dirs.delete(r);
    dirIno.delete(r);
    dirPerm.delete(r);
    dirAtime.delete(r);
  }
}
export function renameSync(a: string, b: string) {
  const ra = resolve(a), rb = resolve(b);
  if (!dirs.has(parent(rb))) fail("ENOENT", -2, "rename", b);
  const f = files.get(ra);
  if (!f && !dirs.has(ra)) fail("ENOENT", -2, "rename", a);
  mayChange(ra, "rename");
  mayChange(rb, "rename");
  // (every path the rename moves, told as one change when the page takes renames whole: confinement phase 2)
  const batch: [string, Uint8Array | null][] = [];
  const told = (p: string, d: Uint8Array | null) => { if (hooks.renamed) batch.push([p, d]); else hooks.changed(p, d); };
  if (f) {
    // (the same entry under its new name: a file held open follows it)
    if (dirs.has(rb)) fail("EISDIR", -21, "rename", b);
    const data = contents(ra, f);
    if (ra === rb) return;
    drop(ra);
    told(ra, null);
    place(rb, f);
    f.mtime = Date.now();
    told(rb, data);
    if (hooks.renamed) hooks.renamed(ra, rb, batch);
    return;
  }
  if (!dirs.has(ra)) fail("ENOENT", -2, "rename", a);
  const pre = ra + "/";
  for (const [k, v] of [...files]) {
    if (k.startsWith(pre)) {
      const data = contents(k, v);
      files.delete(k);
      told(k, null);
      const nk = rb + k.slice(ra.length);
      place(nk, v);
      told(nk, data);
    }
  }
  for (const [k, v] of [...dirs]) {
    if (k === ra || k.startsWith(pre)) {
      dirs.delete(k);
      dirs.set(rb + k.slice(ra.length), v);
      for (const meta of [dirIno, dirPerm, dirAtime]) {
        const x = meta.get(k);
        if (x !== undefined) {
          meta.delete(k);
          meta.set(rb + k.slice(ra.length), x);
        }
      }
    }
  }
  if (hooks.renamed) hooks.renamed(ra, rb, batch);
}
export function rmSync(p: string, opts?: { recursive?: boolean; force?: boolean }) {
  const r = resolve(p);
  if (files.has(r)) return unlinkSync(r);
  if (!dirs.has(r)) return opts?.force ? undefined : fail("ENOENT", -2, "rm", p);
  if (!opts?.recursive) fail("EISDIR", -21, "rm", p);
  for (const f of readdirSync(r)) rmSync(r + "/" + f, opts);
  rmdirSync(r);
}
export default { onceOpen, onceWrite, writeSync, readSync, openSync, closeSync, fstatSync, seekFd, readFd, chmodSync, utimesMs, existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync, rmdirSync, rmSync, renameSync };
