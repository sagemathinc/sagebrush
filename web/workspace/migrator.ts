// The migrator (design/capabilities.md §2b): folders made before folders had
// ids given one (§6), and data files' bytes moved from
// "sagebrush"/files (and Trash's from trash) into
// "sagebrush-workspace"/fileBytes, a little at a time, after the workspace
// opens, never inside the database's upgrade.  Until a file is moved it is
// read where it was (Workspace.contents), so nothing is ever unreadable
// because the migration is paused, failed or not yet done.
//
// - One per workspace: in one tab at a time, under a Web Lock of its own
//   taken with ifAvailable (other tabs don't wait for it).
// - Bounded batches: at most MIGRATE.files entries, MIGRATE.bytes of bytes
//   and MIGRATE.ms of time, then it yields; each file is moved holding the
//   workspace's lock (Workspace.migrateOne), so a change never interleaves
//   with it, and a change waiting for the lock goes between two files.
// - Its memory is the page's reservation (reserve.ts), taken before the
//   workspace's lock, never while holding it.  A value kept the old way has
//   no size until it is read, so each read reserves LEGACY_MAX × COPIES,
//   exclusively (it waits until nothing else is held), and the index's size
//   is corrected from the bytes read (LIMIT-CAP1A-1); one larger than
//   LEGACY_MAX is marked unmoved and not read for this again.
// - Quota first: without room for a file and MIGRATE.headroom, it pauses
//   (the old copies stay where they are, and are read there), says so in
//   the Storage panel, and tries again only when something is freed in
//   this page (Trash emptied, old versions dropped) or at the next open.
// - Bookkeeping: its state in meta ("migration"): the pass in progress (the
//   index's generation when it began, its checkpoint, whether it did any
//   work), paused, or done.  A pass walks the whole index from its first
//   path; the migration is done only when a whole pass did nothing and the
//   index's generation (Workspace.generation: the operation log's latest seq,
//   which never goes down; every change to the entries records an op in its
//   own transaction) is still the one it began
//   with, checked holding the lock (CORR-CAP-46A-1).
import type { Entry, Workspace } from "./api";
import { COPIES, LEGACY_MAX, identOf, needsHash } from "./api";
import { inTx, req } from "./db";
import { reserve } from "./reserve";

export const MIGRATE = {
  /** entries looked at per batch */
  files: 32,
  /** bytes moved per batch (a larger file is a batch of its own) */
  bytes: 64 * 2 ** 20,
  /** a batch's time, after which it ends with the file in progress */
  ms: 2000,
  /** room kept free beyond a file's size before it is moved */
  headroom: 16 * 2 ** 20,
  /** the copies of a file's bytes held while it is moved: COPIES (api.ts) */
  copies: COPIES,
  /** (tests: awaited after each batch, with the state written) */
  afterBatch: null as null | ((s: MigrationState) => Promise<void> | void),
};
const LOCK = "sagebrush-workspace-migrate";
const KEY = "migration";

export type MigrationState = { done?: boolean; paused?: string; pass?: { start: number; at: string; work: boolean } };

async function readState(w: Workspace): Promise<MigrationState> {
  return ((await inTx(w.ws, "meta", "readonly", (tx) => req(tx.objectStore("meta").get(KEY)))) as MigrationState | undefined) ?? {};
}
async function writeState(w: Workspace, s: MigrationState) {
  await inTx(w.ws, "meta", "readwrite", async (tx) => { tx.objectStore("meta").put(s, KEY); });
}
/** The migration's state, for the Storage panel and tests. */
export const migrationState = readState;

/** Whether there is room for `n` more bytes and the headroom; true where the browser can't say. */
async function room(n: number): Promise<boolean> {
  try {
    const est = await (globalThis.navigator as any)?.storage?.estimate?.();
    if (!est || typeof est.quota !== "number" || typeof est.usage !== "number") return true;
    return est.quota - est.usage >= n + MIGRATE.headroom;
  } catch {
    return true;
  }
}
const isQuota = (e: unknown) => (e as any)?.name === "QuotaExceededError" || /quota/i.test(String((e as any)?.message ?? ""));
const pause = (ms = 0) => new Promise<void>((ok) => setTimeout(ok, ms));
// (between batches: the page's own work first)
async function yieldToPage() {
  await pause(0);
  const idle = (globalThis as any).requestIdleCallback;
  if (typeof idle === "function") await new Promise<void>((ok) => idle(() => ok(), { timeout: 1000 }));
}

const running = new WeakMap<Workspace, Promise<void>>();
const watching = new WeakSet<Workspace>();
const subs = new WeakMap<Workspace, Set<(s: MigrationState) => void>>();
function said(w: Workspace, s: MigrationState) {
  for (const f of subs.get(w) ?? []) try { f(s); } catch {}
}
/** `f(state)` after each batch and when the migration pauses or ends; returns how to stop. */
export function onMigration(w: Workspace, f: (s: MigrationState) => void): () => void {
  if (!subs.has(w)) subs.set(w, new Set());
  subs.get(w)!.add(f);
  return () => subs.get(w)?.delete(f);
}

/** The migration run in this tab, if no other tab runs it and it isn't done (a pause from an earlier page cleared: the next open tries again). Resolves when this run ends. */
export function startMigrator(w: Workspace): Promise<void> {
  // (a quarantined workspace is written by nothing until the person decides: design/workspace-durability.md A.3)
  if (w.quarantined) return Promise.resolve();
  if (!watching.has(w)) {
    watching.add(w);
    // (space freed in this page: a paused migration tries again)
    w.watch((c) => {
      if (c.ops.some((o) => o.op === "emptyTrash" || o.op === "dropVersions")) void resume(w);
    });
  }
  return resume(w, true);
}
async function resume(w: Workspace, opening = false): Promise<void> {
  const cur = running.get(w);
  if (cur) return cur;
  const run = (async () => {
    const locks = (globalThis.navigator as any)?.locks;
    if (!locks?.request) return;
    await locks.request(LOCK, { ifAvailable: true }, async (lock: unknown) => {
      if (!lock) return;
      // (old copies first, whatever the migration's state: their marks are durable, and "done" covers only the
      // passes over the index (astra's CORR-6B7-1: a tab closed between an adopt's move and its old copy's
      // deletion leaves a mark that nothing else would ever come back to))
      await cleanStale(w);
      const s = await readState(w).catch(() => ({}) as MigrationState);
      if (s.done || (s.paused && !opening && !(await room(0)))) return;
      if (s.paused) { delete s.paused; await writeState(w, s); }
      await migrate(w);
    });
  })().catch((e) => console.warn("workspace migration:", e)).finally(() => running.delete(w));
  running.set(w, run);
  return run;
}

/** Old copies of moved files deleted, or kept as files of their own if written since (Workspace.dropStale), by
 * their marks, a page of MIGRATE.files at a time, each read in its reservation taken before the lock; at most
 * STALE_PAGES pages a run.  Each run goes on from where the last left off (a durable cursor in meta, CURSOR: the
 * last mark looked at), wrapping round at the end, so marks that keep failing (a copy that can't be kept: its
 * folder full) can't keep any after them from being reached (astra's CORR-AC1-1); each mark once a run. */
const STALE_PAGES = 32;
const CURSOR = "staleCursor";
async function cleanStale(w: Workspace) {
  const getCursor = async () => ((await inTx(w.ws, "meta", "readonly", (tx) => req(tx.objectStore("meta").get(CURSOR)))) as string | undefined) ?? "";
  const setCursor = (c: string) => inTx(w.ws, "meta", "readwrite", async (tx) => { tx.objectStore("meta").put(c, CURSOR); });
  let cursor = await getCursor(), wrapped = cursor === "";
  const tried = new Set<string>();
  for (let page = 0; page < STALE_PAGES && !w.closed; page++) {
    const marks = (await w.staleCopies(MIGRATE.files, cursor || undefined)).filter(([where, key]) => !tried.has(where + ":" + key));
    if (!marks.length) {
      // (the end: round to the first mark, once a run)
      if (wrapped) return;
      wrapped = true;
      cursor = "";
      await setCursor(cursor);
      continue;
    }
    for (const [where, key] of marks) {
      const at = where + ":" + key;
      tried.add(at);
      const release = await reserve(LEGACY_MAX * MIGRATE.copies);
      try {
        await w.locked(() => w.dropStale(where, key, undefined, release));
      } catch (e) {
        console.warn("workspace migration: an old copy:", e);
      } finally {
        release();
      }
      // (past it, whether it went or stayed: the next run goes on after it)
      cursor = at;
      await setCursor(cursor);
    }
  }
}

async function migrate(w: Workspace) {
  for (;;) {
    if (w.closed) return;
    const s = await readState(w);
    if (s.done || s.paused) return;
    if (!s.pass) {
      s.pass = { start: await w.generation(), at: "", work: false };
      await writeState(w, s);
    }
    const r = await batch(w, s.pass);
    if (r === "paused") {
      const p: MigrationState = { ...s, paused: "storage full" };
      await writeState(w, p);
      said(w, p);
      return;
    }
    if (r === "end") {
      // (done only if this whole pass did nothing and nothing changed the index meanwhile, checked holding the lock)
      const done = await w.locked(async () => {
        // (old copies left aren't the passes' to wait for: their marks are durable, and each start cleans them up
        // first, whatever the state says (CORR-6B7-1))
        const gen = await w.generation();
        if (!s.pass!.work && gen === s.pass!.start) {
          await writeState(w, { done: true });
          return true;
        }
        await writeState(w, { pass: { start: gen, at: "", work: false } });
        return false;
      });
      if (done) return said(w, { done: true });
    } else {
      await writeState(w, s);
    }
    said(w, s);
    if (MIGRATE.afterBatch) await MIGRATE.afterBatch(s);
    await yieldToPage();
  }
}

/** One batch of the pass `p` (changed in place): "end" when the pass has looked at every entry, "paused" for want of room, else "more". */
async function batch(w: Workspace, p: { start: number; at: string; work: boolean }): Promise<"end" | "more" | "paused"> {
  const t0 = performance.now();
  let moved = 0, bytes = 0;
  // (old copies are cleanStale's alone, bounded and fair, at each start: none here, so marks that can't go are
  // never counted as this pass's work, nor hold it at its start (daybreak2's LIMIT-1F3-1))
  // (a cursor over the index from the checkpoint: at most MIGRATE.files entries held, never a list of all)
  const next: Entry[] = await inTx(w.ws, "entries", "readonly", (tx) => req(tx.objectStore("entries").getAll(IDBKeyRange.lowerBound(p.at, true), MIGRATE.files)));
  if (!next.length) return "end";
  for (const e of next) {
    if (moved >= MIGRATE.files || bytes >= MIGRATE.bytes || performance.now() - t0 > MIGRATE.ms) return "more";
    if (e.kind === "file" && !e.migrated && !e.unmoved && e.ref !== null) {
      const size = e.size ?? 0;
      if (!(await room(size))) return "paused";
      // (reserved before the workspace's lock, never while holding it: its true size is known only once read)
      const release = await reserve(LEGACY_MAX * MIGRATE.copies);
      try {
        const r = await w.locked(async () => {
          const cur = await w.stat(e.path);
          if (!cur || cur.kind !== "file" || cur.migrated || cur.unmoved || cur.ref === null) return "none";
          try {
            const after = await w.migrateOne(cur, LEGACY_MAX, release);
            return after.migrated ? "moved" : after.unmoved ? "unmoved" : "none";
          } catch (err) {
            if (isQuota(err)) return "quota";
            throw err;
          }
        });
        if (r === "quota") return "paused";
        if (r === "moved") { p.work = true; moved++; bytes += size; }
      } finally {
        release();
      }
    }
    // an entry made before its identities were kept: a folder's id (§6), before any grant can name it, any
    // entry's nkey (§3), so names that look the same are found by the index, and any entry's ident, its
    // identity as the index byIdent's key (design/sync-client.md §3a)
    if ((e.kind === "folder" && !e.fid) || e.nkey === undefined || (e.ident === undefined && identOf(e) !== undefined)) {
      if (await w.locked(() => w.fillIdentity(e))) { p.work = true; moved++; }
    }
    // a data file written before its SHA-256 was kept: hashed (its bytes read whole: reserved first, before
    // the lock, as a move's; counted in the batch's bytes)
    if (needsHash(e)) {
      const size = e.size ?? 0;
      const release = await reserve(size * MIGRATE.copies);
      try {
        if (await w.locked(async () => { const cur = await w.stat(e.path); return !!cur && w.fillHash(cur); })) { p.work = true; moved++; bytes += size; }
      } finally {
        release();
      }
    }
    p.at = e.path;
  }
  return next.length < MIGRATE.files ? "end" : "more";
}
