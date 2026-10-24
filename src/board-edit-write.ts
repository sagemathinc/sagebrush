// Writing FILE for `sagebrush board open --edit` (plan-board-open-edit r7 §5):
// one save as the steps W1-W7, each outcome of §5.2's table an explicit
// result; the sidecar slots of §5.7, reserved before a file can exist and
// released only once its name is unlinked; and the recovery at start, which
// never deletes anything.
//
//   W1  tmp: the tuple's bytes, FILE's mode, fsynced
//   W2  FILE's hash is O's (the last version observed and merged), or the save is abandoned
//   W3  link(FILE, prev): a second name for FILE's inode, FILE still present
//   W4  prev read and classified, FILE still present: changed since W2 -> the bytes read are an observed
//       version, prev retained, the save abandoned (FILE never moved or written)
//   W5  rename(FILE, prev2), then prev2 must be prev's inode: another -> restored (no replace), abandoned
//   W6  link(tmp, FILE): no replace (EEXIST: a new FILE, kept with prev; abandoned)
//   W7  the directory fsynced, tmp's name unlinked: the tuple saved; prev retained (§5.3)
//
// Every filesystem call goes through `WriteFs`, and `step` is called before
// each step: the tests put an outside writer at exactly each point.
import * as fs from "fs";
import { dirname, basename, join } from "path";
import { createHash, randomBytes } from "crypto";

export interface WriteFs {
  readFile(p: string): Buffer;
  writeFile(p: string, data: Buffer, mode: number): void;
  fsync(p: string): void;
  fsyncDir(dir: string): void;
  link(from: string, to: string): void;
  rename(from: string, to: string): void;
  unlink(p: string): void;
  stat(p: string): { ino: number; mode: number } | null;
  readdir(dir: string): string[];
}

export const realFs: WriteFs = {
  readFile: (p) => fs.readFileSync(p),
  writeFile: (p, data, mode) => {
    const fd = fs.openSync(p, "wx", mode & 0o7777);
    try { fs.writeSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.chmodSync(p, mode & 0o7777); // (as FILE's, whatever the umask)
  },
  fsync: (p) => { const fd = fs.openSync(p, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } },
  fsyncDir: (dir) => { const fd = fs.openSync(dir, "r"); try { fs.fsyncSync(fd); } catch {} finally { fs.closeSync(fd); } },
  link: (a, b) => fs.linkSync(a, b),
  rename: (a, b) => fs.renameSync(a, b),
  unlink: (p) => fs.unlinkSync(p),
  stat: (p) => { try { const s = fs.statSync(p); return { ino: s.ino, mode: s.mode }; } catch { return null; } },
  readdir: (d) => fs.readdirSync(d),
};

export const hashOf = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** The sidecar slots (§5.7): every file the board may leave beside FILE takes one, reserved before it can exist. */
export class Slots {
  used = 0;
  constructor(readonly max: number) {}
  reserve(n: number): boolean {
    if (this.used + n > this.max) return false;
    this.used += n;
    return true;
  }
  release(n: number) { this.used = Math.max(0, this.used - n); }
}

/** A sidecar's name: FILE.sagebrush-prev-<rand> or FILE.sagebrush-<rand>.tmp. */
export const sidecarName = (file: string, kind: "prev" | "tmp", rand = randomBytes(6).toString("hex")) =>
  kind === "prev" ? `${file}.sagebrush-prev-${rand}` : `${file}.sagebrush-${rand}.tmp`;
export const isSidecar = (file: string, name: string) => {
  const base = basename(file);
  return name.startsWith(base + ".sagebrush-") && (/\.sagebrush-prev-[0-9a-f]+$/.test(name) || /\.sagebrush-[0-9a-f]+\.tmp$/.test(name) || /\.sagebrush-[0-9TZ:.-]+\.bak$/.test(name));
};

/** What one save came to (§5.2's table). */
export type WriteOutcome =
  /** W7: saved; `prev` (P's old bytes) is retained, holding a slot */
  | { saved: true; prev: string }
  /** W2: FILE isn't O any more: its bytes, to ingest; nothing written */
  | { saved: false; why: "changed"; bytes: Buffer }
  /** W2/W3/W5: FILE is gone: hold as deleted (after W4, `prev`, the inode classified, is retained) */
  | { saved: false; why: "deleted"; prev?: string }
  /** W4: the bytes read from prev (C), an observed version; prev retained (holding a slot); FILE untouched */
  | { saved: false; why: "classified"; bytes: Buffer; prev: string }
  /** W5: FILE was replaced between W3 and W5: the replacement restored at FILE; prev (the classified inode) retained */
  | { saved: false; why: "replaced"; prev: string }
  /** W5/W6: a new FILE appeared: kept; prev (and prev2, if any) kept as outside versions */
  | { saved: false; why: "eexist"; kept: string[] }
  /** no free slots: nothing started */
  | { saved: false; why: "slots" }
  /** an error before anything moved, or after a restore: retry later */
  | { saved: false; why: "error"; message: string }
  /** FILE is absent and couldn't be restored: every sidecar kept */
  | { saved: false; why: "stuck"; kept: string[]; message: string };

export interface WriteStep { (name: "W1" | "W2" | "W3" | "W4" | "W5" | "W6" | "W7"): void }

/** One save of `bytes` over FILE, whose last observed (and merged) hash is `observed`. */
export function writeOnce(file: string, bytes: Buffer, observed: string, slots: Slots, o: { fs?: WriteFs; step?: WriteStep; rand?: () => string } = {}): WriteOutcome {
  const f = o.fs ?? realFs, step = o.step ?? (() => {}), rand = o.rand ?? (() => randomBytes(6).toString("hex"));
  // (three slots before anything can exist: tmp, prev and prev2)
  if (!slots.reserve(3)) return { saved: false, why: "slots" };
  const tmp = sidecarName(file, "tmp", rand()), prev = sidecarName(file, "prev", rand()), prev2 = sidecarName(file, "prev", rand());
  const drop = (p: string) => { try { f.unlink(p); } catch {} };
  const msg = (e: any) => String(e?.code ?? e?.message ?? e);
  // W1
  step("W1");
  const st = f.stat(file);
  if (!st) { slots.release(3); return { saved: false, why: "deleted" }; }
  try { f.writeFile(tmp, bytes, st.mode); } catch (e) { drop(tmp); slots.release(3); return { saved: false, why: "error", message: msg(e) }; }
  // W2
  step("W2");
  let now: Buffer;
  try { now = f.readFile(file); } catch (e: any) {
    drop(tmp); slots.release(3);
    return e?.code === "ENOENT" ? { saved: false, why: "deleted" } : { saved: false, why: "error", message: msg(e) };
  }
  if (hashOf(now) !== observed) { drop(tmp); slots.release(3); return { saved: false, why: "changed", bytes: now }; }
  // W3
  step("W3");
  try { f.link(file, prev); } catch (e: any) {
    drop(tmp); slots.release(3);
    return e?.code === "ENOENT" ? { saved: false, why: "deleted" } : { saved: false, why: "error", message: msg(e) };
  }
  // W4: classify, FILE still present
  step("W4");
  let c: Buffer;
  try { c = f.readFile(prev); } catch (e) { drop(prev); drop(tmp); slots.release(3); return { saved: false, why: "error", message: msg(e) }; }
  if (hashOf(c) !== observed) {
    // (the bytes just read are an observed version; prev retained; FILE never moved)
    drop(tmp);
    slots.release(2); // (tmp's and prev2's)
    return { saved: false, why: "classified", bytes: c, prev };
  }
  // W5: FILE aside as prev2, which must be prev's inode
  step("W5");
  try { f.rename(file, prev2); } catch (e: any) {
    drop(tmp); slots.release(2);
    // (FILE vanished after W4: prev kept, held as deleted)
    if (e?.code === "ENOENT") return { saved: false, why: "deleted", prev };
    drop(prev); slots.release(1);
    return { saved: false, why: "error", message: msg(e) };
  }
  const i1 = f.stat(prev)?.ino, i2 = f.stat(prev2)?.ino;
  if (i1 === undefined || i2 === undefined || i1 !== i2) {
    // (another program replaced FILE between W3 and W5: its version, at prev2, restored without replacing anything)
    drop(tmp);
    try {
      f.link(prev2, file);
      drop(prev2);
      slots.release(2); // (tmp's and prev2's; prev, the classified inode, retained)
      return { saved: false, why: "replaced", prev };
    } catch (e: any) {
      slots.release(1); // (tmp's)
      if (e?.code === "EEXIST") return { saved: false, why: "eexist", kept: [prev, prev2] };
      return { saved: false, why: "stuck", kept: [prev, prev2], message: msg(e) };
    }
  }
  drop(prev2); // (prev2 is prev's inode: one name is enough)
  slots.release(1);
  // W6: tmp at FILE, without replacing anything
  step("W6");
  try { f.link(tmp, file); } catch (e: any) {
    if (e?.code === "EEXIST") { drop(tmp); slots.release(1); return { saved: false, why: "eexist", kept: [prev] }; }
    // (restore P's old bytes at FILE, without replacing anything)
    try {
      f.link(prev, file);
      drop(prev); drop(tmp); slots.release(2);
      return { saved: false, why: "error", message: msg(e) };
    } catch (e2: any) {
      if (e2?.code === "EEXIST") { drop(tmp); slots.release(1); return { saved: false, why: "eexist", kept: [prev] }; }
      return { saved: false, why: "stuck", kept: [tmp, prev], message: msg(e2) };
    }
  }
  // W7
  step("W7");
  try { f.fsyncDir(dirname(file)); } catch {}
  drop(tmp);
  slots.release(1); // (tmp's; prev's slot held until it is unlinked, §5.3)
  return { saved: true, prev };
}

/** At start: the sidecars an interrupted save left beside FILE, counted against BACKUPS_MAX before anything
 * else; with `edit`, FILE restored from the only prev if FILE is absent.  Nothing is deleted. */
export function recoverAtStart(file: string, slots: Slots, edit: boolean, f: WriteFs = realFs): { leftovers: string[]; restored: string | null; over: boolean } {
  const dir = dirname(file);
  let names: string[] = [];
  try { names = f.readdir(dir); } catch {}
  const leftovers = names.filter((n) => isSidecar(file, n)).sort().map((n) => join(dir, n));
  // (each holds a slot; more than BACKUPS_MAX of them: saving stops until they are resolved, nothing evicted)
  slots.used += leftovers.length;
  const over = slots.used > slots.max;
  let restored: string | null = null;
  const prevs = leftovers.filter((p) => /\.sagebrush-prev-[0-9a-f]+$/.test(p));
  if (edit && !f.stat(file) && prevs.length === 1) {
    try { f.link(prevs[0], file); restored = prevs[0]; } catch {}
  }
  return { leftovers, restored, over };
}
