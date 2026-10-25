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
//   W7  the directory fsynced, tmp's name unlinked: the tuple saved; prev retained (§5.3).  A failed fsync:
//       not saved (FILE holds the bytes, not durably), retried as a sync
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

/** The filesystem calls on `n` (node's fs; the tests pass one that fails where they say). */
export function makeRealFs(n: typeof fs = fs, platform: string = process.platform): WriteFs {
  return {
    readFile: (p) => n.readFileSync(p),
    writeFile: (p, data, mode) => {
      const fd = n.openSync(p, "wx", mode & 0o7777);
      try { n.writeSync(fd, data); n.fsyncSync(fd); } finally { n.closeSync(fd); }
      n.chmodSync(p, mode & 0o7777); // (as FILE's, whatever the umask)
    },
    fsync: (p) => { const fd = n.openSync(p, "r"); try { n.fsyncSync(fd); } finally { n.closeSync(fd); } },
    // (every error is the caller's: a directory that wasn't fsynced isn't saved, CORR-153-1.  Windows has no
    // directory fsync (a directory can't be opened as a file): there a save is durable as far as the file's own
    // fsync, W1's, and NTFS's journal of the link make it, an explicit platform case for the docs' page step to state)
    fsyncDir: (dir) => {
      if (platform === "win32") return;
      const fd = n.openSync(dir, "r");
      try { n.fsyncSync(fd); } finally { n.closeSync(fd); }
    },
    link: (a, b) => n.linkSync(a, b),
    rename: (a, b) => n.renameSync(a, b),
    unlink: (p) => n.unlinkSync(p),
    stat: (p) => { try { const s = n.statSync(p); return { ino: s.ino, mode: s.mode }; } catch { return null; } },
    readdir: (d) => n.readdirSync(d),
  };
}

export const realFs: WriteFs = makeRealFs();

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

/** What one save came to (§5.2's table).  `stray`: sidecars whose names couldn't be unlinked, each still holding
 * its slot (§5.7), for the caller to unlink later. */
export type WriteOutcome = (
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
  /** W5/W6: a new FILE appeared: kept; prev (the classified inode) and `outside` (W5's prev2, a version not yet
   * read), each holding its slot */
  | { saved: false; why: "eexist"; kept: string[]; prev: string; outside?: string }
  /** no free slots: nothing started */
  | { saved: false; why: "slots" }
  /** an error before anything moved, or after a restore: retry later */
  | { saved: false; why: "error"; message: string }
  /** W7: FILE holds the bytes, but the directory's fsync failed: not durable, so not saved; prev retained */
  | { saved: false; why: "unsynced"; prev?: string; message: string }
  /** FILE is absent and couldn't be restored: every sidecar kept (`tmp`: the tuple's bytes; `outside`: prev2) */
  | { saved: false; why: "stuck"; kept: string[]; prev: string; outside?: string; tmp?: string; message: string }
) & { stray?: string[] };

export interface WriteStep { (name: "W1" | "W2" | "W3" | "W4" | "W5" | "W6" | "W7"): void }

/** One save of `bytes` over FILE, whose last observed (and merged) hash is `observed`. */
export function writeOnce(file: string, bytes: Buffer, observed: string, slots: Slots, o: { fs?: WriteFs; step?: WriteStep; rand?: () => string } = {}): WriteOutcome {
  const f = o.fs ?? realFs, step = o.step ?? (() => {}), rand = o.rand ?? (() => randomBytes(6).toString("hex"));
  // (three slots before anything can exist: tmp, prev and prev2)
  if (!slots.reserve(3)) return { saved: false, why: "slots" };
  const tmp = sidecarName(file, "tmp", rand()), prev = sidecarName(file, "prev", rand()), prev2 = sidecarName(file, "prev", rand());
  // (a name unlinked releases its slot; one that can't be keeps it, returned as stray: the slots are the files, §5.7)
  const stray: string[] = [];
  const drop = (p: string) => {
    try { f.unlink(p); } catch (e: any) { if (e?.code !== "ENOENT") { stray.push(p); return; } }
    slots.release(1);
  };
  const out = (r: WriteOutcome): WriteOutcome => (stray.length ? { ...r, stray } : r);
  const msg = (e: any) => String(e?.code ?? e?.message ?? e);
  // W1
  step("W1");
  const st = f.stat(file);
  if (!st) { slots.release(3); return { saved: false, why: "deleted" }; }
  try { f.writeFile(tmp, bytes, st.mode); } catch (e) { drop(tmp); slots.release(2); return out({ saved: false, why: "error", message: msg(e) }); }
  // W2
  step("W2");
  let now: Buffer;
  try { now = f.readFile(file); } catch (e: any) {
    drop(tmp); slots.release(2);
    return out(e?.code === "ENOENT" ? { saved: false, why: "deleted" } : { saved: false, why: "error", message: msg(e) });
  }
  if (hashOf(now) !== observed) { drop(tmp); slots.release(2); return out({ saved: false, why: "changed", bytes: now }); }
  // W3
  step("W3");
  try { f.link(file, prev); } catch (e: any) {
    drop(tmp); slots.release(2);
    return out(e?.code === "ENOENT" ? { saved: false, why: "deleted" } : { saved: false, why: "error", message: msg(e) });
  }
  // W4: classify, FILE still present
  step("W4");
  let c: Buffer;
  try { c = f.readFile(prev); } catch (e) { drop(prev); drop(tmp); slots.release(1); return out({ saved: false, why: "error", message: msg(e) }); }
  if (hashOf(c) !== observed) {
    // (the bytes just read are an observed version; prev retained; FILE never moved)
    drop(tmp);
    slots.release(1); // (prev2's)
    return out({ saved: false, why: "classified", bytes: c, prev });
  }
  // W5: FILE aside as prev2, which must be prev's inode
  step("W5");
  try { f.rename(file, prev2); } catch (e: any) {
    drop(tmp); slots.release(1);
    // (FILE vanished after W4: prev kept, held as deleted)
    if (e?.code === "ENOENT") return out({ saved: false, why: "deleted", prev });
    drop(prev);
    return out({ saved: false, why: "error", message: msg(e) });
  }
  const i1 = f.stat(prev)?.ino, i2 = f.stat(prev2)?.ino;
  if (i1 === undefined || i2 === undefined || i1 !== i2) {
    // (another program replaced FILE between W3 and W5: its version, at prev2, restored without replacing anything)
    drop(tmp);
    try {
      f.link(prev2, file);
      drop(prev2); // (prev, the classified inode, retained)
      return out({ saved: false, why: "replaced", prev });
    } catch (e: any) {
      if (e?.code === "EEXIST") return out({ saved: false, why: "eexist", kept: [prev, prev2], prev, outside: prev2 });
      return out({ saved: false, why: "stuck", kept: [prev, prev2], prev, outside: prev2, message: msg(e) });
    }
  }
  drop(prev2); // (prev2 is prev's inode: one name is enough)
  // W6: tmp at FILE, without replacing anything
  step("W6");
  try { f.link(tmp, file); } catch (e: any) {
    if (e?.code === "EEXIST") { drop(tmp); return out({ saved: false, why: "eexist", kept: [prev], prev }); }
    // (restore P's old bytes at FILE, without replacing anything)
    try {
      f.link(prev, file);
      drop(prev); drop(tmp);
      return out({ saved: false, why: "error", message: msg(e) });
    } catch (e2: any) {
      if (e2?.code === "EEXIST") { drop(tmp); return out({ saved: false, why: "eexist", kept: [prev], prev }); }
      return out({ saved: false, why: "stuck", kept: [tmp, prev], prev, tmp, message: msg(e2) });
    }
  }
  // W7: the directory fsynced, or this isn't a save (CORR-153-1): FILE holds the bytes, not durably
  step("W7");
  let synced: unknown = null;
  try { f.fsyncDir(dirname(file)); } catch (e) { synced = e; }
  drop(tmp); // (tmp's; prev's slot held until it is unlinked, §5.3)
  if (synced !== null) return out({ saved: false, why: "unsynced", prev, message: msg(synced) });
  return out({ saved: true, prev });
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
