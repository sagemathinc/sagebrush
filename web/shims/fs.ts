// The file system in the browser: in memory, in the worker.  The page
// keeps a copy in IndexedDB (files survive reloads and restarts): it loads
// the files with load() when a worker starts, and hooks.changed() tells it
// about every change Python makes.  Paths are absolute from "/", which is
// also the initial working directory.  Output streams go to hooks.write.
const hooks: {
  write: (fd: number, s: string) => void;
  changed: (path: string, data: Uint8Array | null) => void;
} = { write: () => {}, changed: () => {} };
export const __hooks = hooks;

interface Entry {
  data: Uint8Array;
  mtime: number;
}
const files = new Map<string, Entry>();
const dirs = new Map<string, number>([["/", Date.now()]]); // path -> mtime
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

// The page's files (path -> bytes), as a worker starts: no change hooks.
export function load(entries: [string, Uint8Array][]) {
  for (const [p, data] of entries) {
    const r = resolve(p);
    ensureDirs(r);
    files.set(r, { data: new Uint8Array(data), mtime: Date.now() });
  }
}
// Changes the page makes (an upload, a delete in the files panel).
export function put(p: string, data: Uint8Array | null) {
  const r = resolve(p);
  if (data === null) files.delete(r);
  else {
    ensureDirs(r);
    files.set(r, { data: new Uint8Array(data), mtime: Date.now() });
  }
}

function setFile(r: string, data: Uint8Array) {
  if (dirs.has(r)) fail("EISDIR", -21, "open", r);
  if (!dirs.has(parent(r))) fail("ENOENT", -2, "open", r);
  files.set(r, { data, mtime: Date.now() });
  hooks.changed(r, data);
}

export function writeSync(fd: number, data: any) {
  hooks.write(fd, typeof data === "string" ? data : new TextDecoder().decode(data));
}
export function readSync() {
  return 0;
}
export const existsSync = (p: string) => {
  const r = resolve(p);
  return files.has(r) || dirs.has(r);
};
export function readFileSync(p: string, enc?: any): any {
  const r = resolve(p);
  const f = files.get(r);
  if (!f) dirs.has(r) ? fail("EISDIR", -21, "read", p) : fail("ENOENT", -2, "open", p);
  const encoding = typeof enc === "string" ? enc : enc?.encoding;
  return encoding ? new TextDecoder().decode(f!.data) : f!.data.slice();
}
export function writeFileSync(p: string, data: any) {
  setFile(resolve(p), bytes(data));
}
export function appendFileSync(p: string, data: any) {
  const r = resolve(p);
  const old = files.get(r)?.data ?? new Uint8Array(0);
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
        for (const t of todo.reverse()) dirs.set(t, Date.now());
        return;
      }
      if (files.has(d)) fail("ENOTDIR", -20, "mkdir", p);
      todo.push(d);
    }
  }
  if (dirs.has(r) || files.has(r)) fail("EEXIST", -17, "mkdir", p);
  if (!dirs.has(parent(r))) fail("ENOENT", -2, "mkdir", p);
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
export function statSync(p: string) {
  const r = resolve(p);
  const f = files.get(r), d = dirs.get(r);
  if (!f && d === undefined) fail("ENOENT", -2, "stat", p);
  const t = f ? f.mtime : d!;
  return {
    isDirectory: () => !f,
    isFile: () => !!f,
    isSymbolicLink: () => false,
    size: f ? f.data.length : 0,
    mode: f ? 0o100644 : 0o40755,
    ino: 0, dev: 0, nlink: 1, uid: 0, gid: 0,
    atimeMs: t, mtimeMs: t, ctimeMs: t,
  };
}
export function unlinkSync(p: string) {
  const r = resolve(p);
  if (!files.has(r)) dirs.has(r) ? fail("EISDIR", -21, "unlink", p) : fail("ENOENT", -2, "unlink", p);
  files.delete(r);
  hooks.changed(r, null);
}
export function rmdirSync(p: string) {
  const r = resolve(p);
  if (!dirs.has(r)) fail("ENOENT", -2, "rmdir", p);
  if (readdirSync(r).length) fail("ENOTEMPTY", -39, "rmdir", p);
  if (r !== "/") dirs.delete(r);
}
export function renameSync(a: string, b: string) {
  const ra = resolve(a), rb = resolve(b);
  if (!dirs.has(parent(rb))) fail("ENOENT", -2, "rename", b);
  const f = files.get(ra);
  if (f) {
    files.delete(ra);
    hooks.changed(ra, null);
    setFile(rb, f.data);
    return;
  }
  if (!dirs.has(ra)) fail("ENOENT", -2, "rename", a);
  const pre = ra + "/";
  for (const [k, v] of [...files]) {
    if (k.startsWith(pre)) {
      files.delete(k);
      hooks.changed(k, null);
      const nk = rb + k.slice(ra.length);
      files.set(nk, v);
      hooks.changed(nk, v.data);
    }
  }
  for (const [k, v] of [...dirs]) {
    if (k === ra || k.startsWith(pre)) {
      dirs.delete(k);
      dirs.set(rb + k.slice(ra.length), v);
    }
  }
}
export default { writeSync, readSync, existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync, rmdirSync, renameSync };
