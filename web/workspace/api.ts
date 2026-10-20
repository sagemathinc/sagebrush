// The workspace (design/workspace-files.md §2, §8.2): one tree of paths in
// this browser, notebooks, boards, data files and folders, and the verbs on
// it that the File menu, the file browser and agents all use: list, stat,
// read, write, create, mkdir, rename, duplicate, remove (to Trash),
// restore, watch.
//
// Where things are kept (§2.2): the index is "sagebrush-workspace"/entries;
// a notebook stays in "sagebrush"/notebooks under its id (IdbStore, so its
// tabs and TimeTravel are unchanged), a board in
// "sagebrush-workspace"/boards under its id, and a data file's bytes in
// "sagebrush-workspace"/fileBytes under its own id (fid), beside the index
// (design/capabilities.md §2a): a change to a data file (its bytes, its
// entry, the version it keeps, Trash) is one transaction of that database,
// all of it or none.  A data file kept before that is still in
// "sagebrush"/files under its path (in Trash: in "sagebrush-workspace"/trash)
// until it is moved (migrateOne: the migrator, web/workspace/migrator.ts, or
// the first change to it), and is read from there meanwhile.  A document's
// contents are written first and its entry second, and an entry is removed
// before its contents, so a failure between the two leaves contents without
// an entry (which reconcile lists again, web/workspace/migrate.ts), never an
// entry pointing at nothing that was there.  Every change here, in every
// tab, holds one Web Lock ("sagebrush-workspace"), so the steps that span
// the two databases are never interleaved with another change.
//
// There is no verb that empties Trash or removes contents for good: only a
// person does that, from the file browser (§2.4, §8.2).
import { inTx, req, hex, openWorkspaceDb, WS_DB, type OpenInfo } from "./db";
import { best, decide, newer, placeOf, readLocal, readOpfs, resolveReset, writeLocal, writeOpfs, type Held, type Place, type ResetKind, type State, type Witness } from "./witness";
import { TRASH, PathError, freePath, join, kindOf, nameOf, normPath, parentOf, splitExt, within, type Kind } from "./paths";
import { IdbStore, bytesHash, openDb as openMainDb, openHistoryDb, openBoardHistoryDb, FENCE } from "../notebook/stores.js";
import { isBoard } from "../board/doc";
import { reserve } from "./reserve";

export type Entry = {
  path: string;
  kind: Kind;
  /** the contents: a notebook's or board's id; a data file's path (its key in "sagebrush"/files, or in Trash in "sagebrush-workspace"/trash, until it is migrated); null for a folder */
  ref: string | null;
  /** a document's language */
  mode?: string;
  /** a data file's bytes */
  size?: number;
  created: number;
  updated: number;
  /** a data file's revision (a document's is its record's) */
  rev?: number;
  /** a data file's or folder's own id, which a rename keeps: a file's versions' (§2.5) and its bytes' key in
   * fileBytes; a folder's, what a grant names (design/capabilities.md §6).  Never reused: a folder removed
   * and made again is a new one */
  fid?: string;
  /** a document's provenance (design/capabilities.md §6, CORR-CAP-5), kept by the host, never read from the
   * document, a file or a URL, never exported: "person", made by the person in this site's own UI (File ▸
   * New board or New notebook, the file browser's New, a first visit's blank board); "elsewhere",
   * anything else (an upload, a drop, Open as…, an agent, an example, a conversion); absent, unknown (made
   * before this was kept), which counts as elsewhere.  A copy has its source's */
  made?: "person" | "elsewhere";
  /** its folder and the NFC form of its name (nkeyOf): what names that look the same share (index byNfc,
   * design/capabilities.md §3); absent on an entry made before, until the migrator gives it */
  nkey?: string;
  /** a data file whose bytes are in "sagebrush-workspace"/fileBytes under its fid (design/capabilities.md §2b) */
  migrated?: boolean;
  /** a data file's SHA-256 (hex): of the bytes it was made, moved or last written with (the migrator gives it to
   * a file written before it was kept: design/sync-client.md §3) */
  sha256?: string;
  /** its identity (identOf: a data file's or folder's fid, a document's ref), the entries' index byIdent's
   * key; written with the entry, and by the migrator for one made before (design/sync-client.md §3a) */
  ident?: string;
  /** a data file kept the old way that the migrator won't move (its bytes larger than LEGACY_MAX): why */
  unmoved?: string;
  /** in Trash: where it was, when it was put there, and that time's own id (Undo's, CORR-989-2) */
  trashed?: { from: string; at: number; id?: string };
  /** a board made from an edited example or a board on the web: its address */
  origin?: string;
  /** a data file recovered from Trash bytes with no entry: from which Trash key, and their SHA-256 (CORR-DF0-1) */
  recovered?: { from: string; sha: string };
  /** contents reconcile could not find (shown, never dropped) */
  missing?: boolean;
};
/** An op's identity as the op left it (design/sync-client.md §3): its identity, the folder it is in (that
 * folder's fid; null for the root, or for something put in Trash itself), its name, its kind, a data file's
 * SHA-256 and size, and whether it was put in Trash (an entry in a folder put there isn't: its folder is). */
export type OpAfter = { id: string; parent: string | null; name: string; kind: Kind; sha256?: string; size?: number; trashed: boolean };
/** One record of the operation log.  With sync's identity (design/sync-client.md §3): `fid` (a data file's or
 * folder's) or `ref` (a document's); a data file's `sha256` and `size` as the op left it, and, on a write,
 * `base`, the SHA-256 it replaced; `parent`, on an op that puts something in a folder (create, adopt, mkdir,
 * write, rename, restore), that folder's fid (absent for the root or Trash); `after`, what the op left
 * (null: its identity is gone; absent: it has none yet, or the op changes no entry, as dropVersions).
 * `origin: "server"` marks an op applied from the server (sync's next steps), never sent back. */
export type Op = {
  seq?: number; t: number; device: string; by: string; op: string; path: string; to?: string; kind: Kind;
  ref?: string; fid?: string; sha256?: string; size?: number; base?: string; parent?: string; after?: OpAfter | null; origin?: "server";
};
/** An entry's identity (design/sync-client.md §3): a data file's or folder's fid, a document's ref; undefined
 * where it has none yet (a folder or file from before ids were kept, until the migrator gives it one). */
export const identOf = (e: Pick<Entry, "kind" | "fid" | "ref">): string | undefined => ((e.kind === "file" || e.kind === "folder" ? e.fid : e.ref) ?? undefined);
/** Whether `e` is a data file whose bytes are beside the index but whose SHA-256 isn't kept (written before it
 * was: design/sync-client.md §3): the migrator hashes it (Workspace.fillHash). */
export const needsHash = (e: Entry): boolean => e.kind === "file" && !!e.migrated && !!e.fid && !e.sha256;

/** An earlier version of a data file (§2.5): its bytes are in versionBytes under `id`. */
export type Version = { id?: number; fid: string; t: number; size: number; sha256: string; by: string; device: string };
export type BoardRecord = { id: string; doc: any; rev: number; updated: number; docId?: string; origin?: string; tag?: string };
export type Limits = { maxFileBytes: number; maxBoardBytes: number; maxEntries: number; maxFolderEntries: number; maxVersions: number; maxVersionAgeMs: number; maxVersionBytes: number };
/** §6.3: one upload at most 200 MB; a board's JSON at most 64 MB; the
 * workspace at most 100,000 entries, a folder at most 10,000 of its own.  §2.5: a data file's latest 20
 * versions, none older than 30 days, all of them at most 1 GB. */
export const LIMITS: Limits = { maxFileBytes: 200 * 2 ** 20, maxBoardBytes: 64 * 2 ** 20, maxEntries: 100_000, maxFolderEntries: 10_000, maxVersions: 20, maxVersionAgeMs: 30 * 864e5, maxVersionBytes: 2 ** 30 };

export type WorkspaceErrorCode = "invalid" | "exists" | "missing" | "conflict" | "limit" | "storage" | "quarantined";
export class WorkspaceError extends Error {
  constructor(public code: WorkspaceErrorCode, message: string, public current?: unknown) { super(message); }
}

/** What the board page keeps of a board of this browser's in localStorage, by its id (web/board/page.ts). */
export const BOARD_KEYS = {
  local: (id: string) => "sagebrush-board:local:" + id,
  here: (id: string) => "sagebrush-board:local:" + id + "#here",
  pending: (id: string) => "sagebrush-workspace-pending:" + id,
  unread: (id: string) => "sagebrush-workspace-pending-unread:" + id,
};
// (dropVersions: files' versions dropped per transaction, and records per transaction when all go)
const DROP_FILES = 200, DROP_RECORDS = 1000;
// (a folder's drop: at most this many operations since it was confirmed are looked at; more, it is asked again)
const SEQ_SCAN = 10_000;
// The first time the person saves something of their own here (not on a
// first visit): the browser asked to keep this site's storage when space
// runs short (§6.3), once per page.  The workspace's own writes call it;
// the notebook page calls it for a notebook's saves.
let keepAsked = false;
export function askToKeep() {
  if (keepAsked) return;
  keepAsked = true;
  try { (globalThis.navigator as any)?.storage?.persist?.()?.catch?.(() => {}); } catch {}
}
const CHANNEL = "sagebrush-workspace";
// (the Storage panel's list of names that look the same: groups, and paths in each, shown)
const LOOKALIKE_GROUPS = 100, LOOKALIKE_MEMBERS = 10;
// (the stores a version is kept in, with the change that keeps it)
const VERSION_STORES = ["versions", "versionBytes", "meta"];
// (an old copy of a migrated file's bytes, in "sagebrush"/files or in trash, not yet deleted: a key
// in meta, so that reconcile never takes it for a file of its own and the migrator deletes it)
const STALE = "stale:";
const staleKey = (where: "files" | "trash", key: string) => STALE + where + ":" + key;
/** A stale old copy's mark: the bytes moved, by their size and SHA-256, and the file they went to. */
type StaleMark = { fid: string; size: number; sha256: string };
/** The most a value kept the old way can be (design/capabilities.md §2b, LIMIT-CAP1A-1): the page's
 * writes were bounded by FILE_QUEUE_MAX (256 MiB) and uploads by maxFileBytes (200 MB).  Its size isn't
 * known until it is read, so reading one reserves this × COPIES, exclusively, first. */
export const LEGACY_MAX = 256 * 2 ** 20;
/** The copies of a file's bytes held while it is moved (as read, and as compared or given to IndexedDB). */
export const COPIES = 2;
// (a file kept the old way that is too large to move beside the index: what can't be done with it, and what can)
const tooLarge = (e: Entry) => `${e.path} is too large to change here (${e.size} bytes, kept by an older version of Sagebrush): download it, then delete it and upload it again`;
/** A path's folder and the NFC form of its name: equal for names that look the same in one folder (every
 * name, ASCII included: U+212A KELVIN SIGN is "K" in NFC). */
export const nkeyOf = (p: string) => parentOf(p) + "\u0000" + nameOf(p).normalize("NFC");
const isPath = (k: string) => { try { return normPath(k) === k && k !== "/"; } catch { return false; } };
const LOCK = "sagebrush-workspace";
type Change = { ops: Op[] };
/** The workspace's identity, in meta (design/workspace-durability.md A.1): its own id, and the generation a
 * deliberate reset bumps.  The witnesses kept outside IndexedDB are compared with it. */
export type Identity = { workspace: string; generation: number };
const isIdentity = (x: any): x is Identity => !!x && typeof x.workspace === "string" && /^[0-9a-f]{16}$/.test(x.workspace) && Number.isSafeInteger(x.generation) && x.generation >= 1;
// (the stores a reset to a new workspace empties, a page at a time, those holding files' bytes first; and meta's
// keys it keeps)
const RESET_STORES = ["fileBytes", "versionBytes", "trash", "entries", "boards", "ops", "versions", "grants", "outbox", "syncIndex", "adoptJournal", "pins", "pending"];
const BYTE_STORES = new Set(["fileBytes", "versionBytes", "trash", "files"]);
const META_KEPT = new Set(["device", "identity", "resetting", "opsFloor", "purgeMain", "purgeLocal", "fenceStep", "fenceBlocked"]);
/** Records deleted per transaction by a reset's cleanup (daybreak2's L2 on 2a4e53a8: never one transaction
 * over the whole workspace). */
export const RESET_PAGE = 500;
/** Records per transaction where values are files' bytes (up to 200 MB each): deleting them costs about the same
 * whatever their size (measured on Chrome 155: 50 records of 8 MiB in 14 ms, 500 of 64 B in 7 ms; the bytes'
 * own files are removed after), so a count bounds the page, kept smaller here (daybreak2's LIMIT-99B-1). */
export const RESET_BYTES_PAGE = 32;
/** Bytes per page of files' bytes whose sizes are known (the index's, the versions'): with RESET_PAGE records at
 * most, so many small versions take few pages (daybreak2's LIMIT-0EE-2); those of unknown size, RESET_BYTES_PAGE. */
export const RESET_PAGE_BYTES = 32 * 2 ** 20;
/** localStorage keys removed per step of the old store's purge. */
export const LOCAL_PAGE = 200;
/** A reset under way, in meta: the new identity it switches to, once every store is emptied. */
type Resetting = { to: Identity; seq: number };
// (the OPFS witness: written at most this often, and when the page is hidden)
const OPFS_EVERY_MS = 10_000;
/** Test hooks at the reset's boundaries (A.3a): each is called holding the lock, and may throw, as a kill
 * there would stop the reset; the next open then resolves it. */
export const RESET_HOOK: { afterFirstWitness?: () => void; afterPrepare?: () => void; afterPage?: (store: string, n: number, ms?: number) => void; openBudgetMs?: number; beforePurge?: () => void; afterIdb?: () => void | Promise<void>; afterFirstCommit?: () => void; failCleanup?: boolean } = {};

// (bytes compared four at a time where both are aligned: a 200 MB file in well under a second, inside one
// transaction's callback, which can't yield; a byte at a time was 2 s there)
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let i = 0;
  if (a.byteOffset % 4 === 0 && b.byteOffset % 4 === 0) {
    const n = a.length >>> 2, x = new Uint32Array(a.buffer, a.byteOffset, n), y = new Uint32Array(b.buffer, b.byteOffset, n);
    for (let k = 0; k < n; k++) if (x[k] !== y[k]) return false;
    i = n << 2;
  }
  for (; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
// (the same entry, put in Trash the same time: each time something is put
// in Trash has an id of its own, which a clock that ties can't give
// (CORR-989-2); and the same entry: a data file known by its own id (its
// key is its path), a document by its id)
const sameTrashed = (e: Entry, x: Entry) =>
  !!e.trashed?.id && e.trashed.id === x.trashed?.id &&
  e.kind === x.kind && e.created === x.created && e.fid === x.fid && (e.kind === "file" || e.ref === x.ref) && e.trashed.from === x.trashed?.from;
/** The bytes of a data file's contents as given (bytes, a buffer, or text). */
// (bytes the caller gave, copied once, at the call, before anything is awaited: what is hashed is what is kept,
// whatever the caller does with its buffer meanwhile (astra's CORR-9C2-1).  One copy, at most `max` bytes:
// larger ones aren't copied, and are refused as too large)
function owned(c: unknown, max: number): unknown {
  if (c instanceof Uint8Array) return c.byteLength > max ? c : c.slice();
  if (c instanceof ArrayBuffer) return c.byteLength > max ? c : new Uint8Array(c.slice(0));
  return c;
}
function bytesOf(c: unknown): Uint8Array {
  if (c instanceof Uint8Array) return c;
  if (c instanceof ArrayBuffer) return new Uint8Array(c);
  if (typeof c === "string") return new TextEncoder().encode(c);
  throw new WorkspaceError("invalid", "a file's contents are bytes or text");
}
// (a path made one, its errors said as the workspace's)
function path(p: unknown): string {
  try { return normPath(p); } catch (e) { throw new WorkspaceError("invalid", e instanceof PathError ? e.message : String(e)); }
}
// (every path under `p`: the keys from `p/` up to, not including, `p0`, "0"
// being the character after "/", so every name, whatever its first
// character, is in it: CORR-4A0-3)
const subtree = (p: string) => (p === "/" ? undefined : IDBKeyRange.bound(p + "/", p + "0", false, true));

export class Workspace {
  private subs = new Set<(c: Change) => void>();
  private channel: BroadcastChannel | null = null;
  private tab = hex(8);
  /** Who makes the changes from here: "person", or "agent:<name>" (§8.3); in the operation log and on versions. */
  actor = "person";
  /** Where this workspace's witnesses are kept, and its identity as this page knows it. */
  private place: Place = placeOf(WS_DB);
  identity: Identity = { workspace: "0".repeat(16), generation: 1 };
  /** What the open decided about a lost workspace (design/workspace-durability.md A.2). Confirmed or suspected:
   * quarantined, every change refused, until the person decides (A.3). */
  durability: State = { state: "ok" };
  /** The witnesses that couldn't be written in this session, and why: the Storage panel says so. */
  witnessDown: { local?: string; opfs?: string } = {};
  private opfsTimer: ReturnType<typeof setTimeout> | null = null;
  private opfsDue = false;
  private onHidden: (() => void) | null = null;
  get quarantined(): boolean { const s = this.durability.state; return s === "confirmed" || s === "suspected" || s === "resetting" || s === "purging"; }
  private durabilitySubs = new Set<() => void>();
  /** `f()` whenever what this page knows of the workspace's durability changes (a quarantine learnt from
   * another tab, a witness found unwritable): the pages show it.  Returns how to stop. */
  onDurability(f: () => void): () => void {
    this.durabilitySubs.add(f);
    return () => this.durabilitySubs.delete(f);
  }
  private durabilityChanged() {
    for (const f of this.durabilitySubs) try { f(); } catch (e) { console.warn("workspace onDurability:", e); }
  }
  // (a quarantine another tab found, persisted in meta or broadcast: this page's changes refused from now on)
  private adoptQuarantine(q: State) {
    // (the tab that found it wrote the fence; this one only stops writing: a closed tab, stale, does nothing)
    if (this.quarantined || this.closed) return;
    this.durability = q;
    this.durabilityChanged();
  }
  /** The workspace's fence in the notebooks' store and their history's (notebook/stores.js FENCE): its identity,
   * and whether it is quarantined or being reset, which every notebook and history write checks in its own
   * transaction.  Written at every open and every change of state, so it always says what meta says. */
  async writeFence() {
    // (called holding the lock, which orders writes within a generation; a fence is never replaced by an earlier
    // generation's, compared in the same transaction, so a stale tab can't put an older one back; one that can't
    // be written is never deleted (its absence would read as a database the workspace never had): its database is
    // marked blocked instead, every write to it refused: astra's CORR-2A4-2 on 28f6511b.  The step, counted
    // in meta, says which write it was)
    const s = this.durability.state;
    const phase = s === "confirmed" || s === "suspected" ? "quarantined" : s === "resetting" ? "resetting" : s === "purging" ? "purging" : "ok";
    // (a tab whose identity meta no longer holds (a reset elsewhere, carried on here or not) writes nothing)
    const step = await inTx(this.ws, "meta", "readwrite", async (tx) => {
      const st = tx.objectStore("meta"), id = (await req(st.get("identity"))) as Identity | undefined;
      if (id && (id.workspace !== this.identity.workspace || id.generation !== this.identity.generation)) return null;
      const n = (((await req(st.get("fenceStep"))) as number | undefined) ?? 0) + 1;
      st.put(n, "fenceStep");
      return n;
    });
    if (step === null) return;
    // (the workspace's database named in it: the authority each write confirms, notebook/stores.js)
    const fence = { workspace: this.identity.workspace, generation: this.identity.generation, step, phase, primary: this.ws.name };
    const put = (db: IDBDatabase, store: string, key: IDBValidKey, rec: unknown, cur: (v: any) => any) => new Promise<void>((ok, no) => {
      const tx = db.transaction(store, "readwrite"), st = tx.objectStore(store), g = st.get(key);
      // (never replaced by an earlier generation's: a tab left over from before a reset can't put its fence back;
      // within a generation every write holds the workspace's lock, which orders them.  One of a later generation
      // left there (the workspace's own database rolled back behind it) is not this fence written: the database
      // is blocked, as if the write had failed: astra's CORR-56C-1)
      let skipped: unknown = null;
      g.onsuccess = () => {
        const c = cur(g.result);
        if (typeof c?.generation === "number" && c.generation > fence.generation) { skipped = c; return; }
        try { st.put(rec); } catch (e) { tx.abort(); no(e); }
      };
      tx.oncomplete = () => (skipped ? no(new Error(`a fence of a later generation is there: ${JSON.stringify(skipped)}`)) : ok());
      tx.onerror = () => no(tx.error);
      tx.onabort = () => no(tx.error);
    });
    // (every store the editors write outside the lock, design/workspace-durability.md A.3b: the notebooks', their
    // history's, the boards' history's; one whose fence can't be written is marked blocked in meta, which every
    // write to it reads first (notebook/stores.js), so its writes are refused until a later write succeeds; a
    // fence is never deleted.  meta itself refusing the mark fails the open)
    const blocked: string[] = [];
    const fenceIn = async (db: IDBDatabase | null, store: string, key: IDBValidKey, rec: unknown, cur: (v: any) => any) => {
      if (!db) return;
      try {
        await put(db, store, key, rec, cur);
      } catch (e) {
        console.warn(`workspace fence (${db.name}):`, e);
        blocked.push(db.name);
      }
    };
    await fenceIn(this.main, "notebooks", FENCE, { id: FENCE, ...fence }, (v) => v);
    try { this.hdb ??= await openHistoryDb(); } catch {}
    await fenceIn(this.hdb, "history", [FENCE, ""], { nb: FENCE, time: "", fence }, (v) => v?.fence);
    try { this.bhdb ??= await openBoardHistoryDb(); } catch {}
    await fenceIn(this.bhdb, "history", [FENCE, ""], { nb: FENCE, time: "", fence }, (v) => v?.fence);
    this.fenceBlocked = blocked;
    await inTx(this.ws, "meta", "readwrite", async (tx) => { if (blocked.length) tx.objectStore("meta").put(blocked, "fenceBlocked"); else tx.objectStore("meta").delete("fenceBlocked"); });
  }
  /** The latest generation any of the editors' stores' fences names (0 if none). */
  private async fencesUpTo(): Promise<number> {
    const gen = async (db: IDBDatabase | null, store: string, key: IDBValidKey, f: (v: any) => any) => {
      if (!db) return 0;
      const v = f(await new Promise((ok) => { try { const r = db.transaction(store).objectStore(store).get(key); r.onsuccess = () => ok(r.result); r.onerror = () => ok(undefined); } catch { ok(undefined); } }));
      return typeof v?.generation === "number" ? v.generation : 0;
    };
    try { this.hdb ??= await openHistoryDb(); } catch {}
    try { this.bhdb ??= await openBoardHistoryDb(); } catch {}
    return Math.max(await gen(this.main, "notebooks", FENCE, (v) => v), await gen(this.hdb, "history", [FENCE, ""], (v) => v?.fence), await gen(this.bhdb, "history", [FENCE, ""], (v) => v?.fence));
  }
  /** The stores whose fence couldn't be written at the latest try: their writes are refused (the pages' gates too). */
  fenceBlocked: string[] = [];
  private bhdb: IDBDatabase | null = null;
  private hdb: IDBDatabase | null = null;

  /** `ws`: the workspace's database; `main`: "sagebrush" (notebooks, files), or null where there is none. */
  constructor(readonly ws: IDBDatabase, readonly main: IDBDatabase | null, readonly device: string, readonly limits: Limits = LIMITS, private now: () => number = Date.now) {
    if (typeof BroadcastChannel === "function") {
      this.channel = new BroadcastChannel(CHANNEL);
      this.channel.onmessage = (ev) => {
        if (ev.data?.from === this.tab) return;
        if (Array.isArray(ev.data?.ops)) this.tell({ ops: ev.data.ops }, false);
        if (ev.data?.quarantine) this.adoptQuarantine(ev.data.quarantine);
        // (reset in another tab: this page's workspace is no longer the workspace; reload, as after an upgrade)
        if (ev.data?.reset && (ev.data.reset.workspace !== this.identity.workspace || ev.data.reset.generation !== this.identity.generation)) this.closedElsewhere();
      };
    }
  }

  /** Whether another page (a newer version of Sagebrush) upgraded the workspace's database, closing it here: nothing more can be read or changed from this page until it is reloaded. */
  closed = false;
  private closedSubs = new Set<() => void>();
  /** `f()` when the workspace closes here because another page upgraded it (once); returns how to stop. */
  onClosed(f: () => void): () => void {
    this.closedSubs.add(f);
    return () => this.closedSubs.delete(f);
  }
  private closedElsewhere() {
    if (this.closed) return;
    this.closed = true;
    for (const f of this.closedSubs) try { f(); } catch (e) { console.warn("workspace onClosed:", e); }
  }
  // (closed by another page's upgrade: said, not an IndexedDB error)
  private open() {
    if (this.closed) throw new WorkspaceError("storage", "your files were upgraded by a newer Sagebrush page: reload this page to use them");
  }

  /** The workspace of this browser (both databases opened), or a WorkspaceError("storage"). */
  static async open(opts: { name?: string; mainName?: string; limits?: Limits; now?: () => number } = {}): Promise<Workspace> {
    let ws: IDBDatabase, made: Workspace | undefined, early = false;
    const info: OpenInfo = { fresh: false };
    try { ws = await openWorkspaceDb(opts.name, () => (made ? made.closedElsewhere() : (early = true)), undefined, info); } catch (e) { throw new WorkspaceError("storage", `this browser's storage can't be opened: ${(e as Error)?.message ?? e}`); }
    const main = await openMainDb(opts.mainName ?? "sagebrush");
    const device = await inTx(ws, "meta", "readwrite", async (tx) => {
      const st = tx.objectStore("meta");
      let d = await req(st.get("device"));
      if (!(typeof d === "string" && /^[0-9a-f]{16}$/.test(d))) st.put((d = hex(8)), "device");
      return d as string;
    });
    made = new Workspace(ws, main, device, opts.limits ?? LIMITS, opts.now);
    made.place = placeOf(opts.name ?? WS_DB);
    if (early) made.closedElsewhere();
    await made.arrive(info);
    return made;
  }
  /** meta's identity, quarantine and an unfinished purge, read together. */
  private async metaState(): Promise<{ identity?: Identity; kept?: State; purge: boolean; purgeLocal: boolean; resetting?: Resetting }> {
    return inTx(this.ws, "meta", "readonly", async (tx) => {
      const st = tx.objectStore("meta"), id = await req(st.get("identity")), q = (await req(st.get("quarantine"))) as State | undefined;
      const r = (await req(st.get("resetting"))) as Resetting | undefined;
      return { identity: isIdentity(id) ? id : undefined, kept: q && (q.state === "confirmed" || q.state === "suspected") ? q : undefined, purge: !!(await req(st.get("purgeMain"))), purgeLocal: !!(await req(st.get("purgeLocal"))), resetting: r && isIdentity(r.to) ? r : undefined };
    });
  }

  /** The open's decision (design/workspace-durability.md A.2): a prepared reset resolved first (A.3a), then
   * what IndexedDB holds compared with the witnesses; a loss quarantines the workspace, kept in meta so a
   * reload doesn't lift it; otherwise the workspace's identity made if it had none, and the witnesses
   * brought up to it. */
  private async arrive(info: OpenInfo) {
    // (decided and installed holding the lock: two tabs opening at once find one identity, the second reading
    // what the first installed; astra's probe on 2a4e53a8.  Without Web Locks, as before them: unlocked)
    const locks = (globalThis.navigator as any)?.locks;
    // (the fence brought to what meta says in the same hold, at every open)
    const decided = async () => {
      await this.decideHere(info);
      if (this.purgePending && !this.quarantined) this.durability = { state: "purging" };
      await this.writeFence();
    };
    if (locks && typeof locks.request === "function") await this.locked(decided, undefined, { internal: true });
    else await decided();
    // (a reset resumed, or a purge: run here for at most a short while, then on in the background: LIMIT-99B-3)
    if (this.durability.state === "resetting" || this.purgePending || this.localPending) await Promise.race([this.cleanUp(), new Promise((r) => setTimeout(r, RESET_HOOK.openBudgetMs ?? 250))]);
    // (the witnesses brought up to what IndexedDB holds: IndexedDB ahead of them is harmless; a first visit gets none until its first save)
    if (!this.quarantined && this.durability.state !== "first" && locks) await this.locked(async () => {}, undefined, { internal: true, publish: true }).catch(() => {});
    this.watchHidden();
  }
  private async decideHere(info: OpenInfo) {
    const { identity, kept, purge, purgeLocal, resetting } = await this.metaState();
    this.localPending = purgeLocal;
    // (a database is new only if, read now under the lock, nobody has made it a workspace yet: another tab's
    // first open may have, since this one's indexedDB.open made it: astra's CORR-2A4-1; Chrome's dataLoss stands)
    if (info.fresh && (identity || (await this.generation()) > 0)) info = { ...info, fresh: false };
    // (a reset to a new workspace stopped part way through its cleanup: resumed in the background, a page per
    // hold of the lock, the open returning at once with every writer refused meanwhile: LIMIT-99B-3)
    if (resetting) {
      this.identity = identity ?? this.identity;
      this.durability = { state: "resetting" };
      return;
    }
    if (kept) {
      this.identity = identity ?? this.identity;
      this.durability = kept;
      return;
    }
    // (an old store's purge not finished: finished after the open, a page at a time; every writer refused until
    // then, so nothing new is made that it would delete: astra's CORR-2A4-3 on 0eefec71)
    if (purge) this.purgePending = true;
    const reads = [readLocal(this.place), await readOpfs(this.place)];
    const held: Held = { fresh: info.fresh, dataLoss: info.dataLoss, dataLossMessage: info.dataLossMessage, workspace: identity?.workspace, generation: identity?.generation, seq: await this.generation() };
    const prepared = best(reads).witness;
    if (prepared?.reset) {
      const out = resolveReset(prepared, held);
      if (out === "rollback") {
        const back: Witness = { ...prepared };
        delete back.reset;
        await this.writeWitnesses(back, true);
        this.identity = identity!;
        this.durability = { state: "ok" };
        return;
      }
      if (out === "finish") {
        await this.setIdentity(identity!, null);
        await this.writeWitnesses(await this.sample(), true);
        this.durability = { state: "ok" };
        return;
      }
      if (out === "unknown") {
        this.identity = identity ?? this.identity;
        this.durability = { state: "unknown", why: "a reset of this workspace was under way, and this browser's storage can't tell how far it got" };
        return;
      }
      // ("lost": a new database under a prepared reset; decided as any loss, below)
    }
    const state = decide(held, reads);
    if (state.state === "confirmed" || state.state === "suspected") {
      // (quarantined: the witness's identity kept, so the next open finds the same; nothing published; other tabs told)
      const w = state.witness;
      const id = identity ?? (w ? { workspace: w.workspace, generation: w.generation } : { workspace: hex(8), generation: 1 });
      await this.setIdentity(id, state);
      this.durability = state;
      this.channel?.postMessage({ from: this.tab, quarantine: state });
      return;
    }
    await this.setIdentity(identity ?? { workspace: hex(8), generation: best(reads).witness?.generation ?? 1 }, null);
    this.durability = state;
    if (state.state === "ok" && state.unavailable) this.witnessDown.local ??= state.unavailable;
  }
  private async setIdentity(id: Identity, quarantine: State | null) {
    await inTx(this.ws, "meta", "readwrite", async (tx) => {
      const st = tx.objectStore("meta");
      st.put(id, "identity");
      if (quarantine) st.put(quarantine, "quarantine");
      else st.delete("quarantine");
    });
    this.identity = id;
  }
  /** A witness of the workspace as it is now (its identity, its counter and its entries). */
  private async sample(): Promise<Witness> {
    const { seq, entries } = await inTx(this.ws, ["ops", "meta", "entries"], "readonly", async (tx) => {
      const last = await new Promise<number>((ok, no) => { const c = tx.objectStore("ops").openKeyCursor(null, "prev"); c.onsuccess = () => ok((c.result?.key as number | undefined) ?? 0); c.onerror = () => no(c.error); });
      const floor = ((await req(tx.objectStore("meta").get("opsFloor"))) as number | undefined) ?? 0;
      return { seq: Math.max(last, floor), entries: (await req(tx.objectStore("entries").count())) as number };
    });
    return { v: 1, workspace: this.identity.workspace, generation: this.identity.generation, seq, entries, sampled: this.now() };
  }
  /** Both witnesses written: `force` for a reset's own phases and its resolution; otherwise each only if it is
   * newer than the one there (never over a prepared reset).  A write that fails is noted, not thrown. */
  private async writeWitnesses(w: Witness, force = false, which: { local?: boolean; opfs?: boolean } = { local: true, opfs: true }) {
    if (which.local) {
      try {
        const cur = readLocal(this.place);
        if (force || !("witness" in cur) || newer(w, cur.witness)) writeLocal(this.place, w);
        if (this.witnessDown.local) { delete this.witnessDown.local; this.durabilityChanged(); }
      } catch (e) {
        const was = this.witnessDown.local;
        this.witnessDown.local = String((e as Error)?.message ?? e);
        if (!was) this.durabilityChanged();
      }
    }
    if (which.opfs) {
      try {
        const cur = await readOpfs(this.place);
        if (force || !("witness" in cur) || newer(w, cur.witness)) await writeOpfs(this.place, w);
        if (this.witnessDown.opfs) { delete this.witnessDown.opfs; this.durabilityChanged(); }
      } catch (e) {
        const was = this.witnessDown.opfs;
        this.witnessDown.opfs = String((e as Error)?.message ?? e);
        if (!was) this.durabilityChanged();
      }
    }
  }
  /** After a commit, holding the lock: the localStorage witness at once (the first save has one before it is
   * reported), the OPFS one at most every OPFS_EVERY_MS. */
  private async publish() {
    if (this.quarantined) return;
    const w = await this.sample();
    await this.writeWitnesses(w, false, { local: true });
    this.opfsDue = true;
    if (!this.opfsTimer) this.opfsTimer = setTimeout(() => this.flushOpfs(), OPFS_EVERY_MS);
  }
  /** The OPFS witness brought up to date now (holding the lock), if a commit made it due. */
  async flushOpfs() {
    if (this.opfsTimer) clearTimeout(this.opfsTimer);
    this.opfsTimer = null;
    if (!this.opfsDue || this.closed || this.quarantined) return;
    this.opfsDue = false;
    // (only if the lock is free now: a background write never waits behind another tab's hold, which may last;
    // otherwise due still, tried again in OPFS_EVERY_MS)
    const done = await this.locked(async () => { await this.writeWitnesses(await this.sample(), false, { opfs: true }); return true; }, undefined, { internal: true, ifAvailable: true }).catch(() => true);
    if (done !== true && !this.closed) {
      this.opfsDue = true;
      this.opfsTimer ??= setTimeout(() => this.flushOpfs(), OPFS_EVERY_MS);
    }
  }
  private watchHidden() {
    const doc = (globalThis as any).document;
    if (!doc || this.onHidden) return;
    this.onHidden = () => { if (doc.visibilityState === "hidden") void this.flushOpfs(); };
    doc.addEventListener("visibilitychange", this.onHidden);
  }

  /** A deliberate reset (A.3a), prepared in both witnesses, then IndexedDB in one transaction, then the witnesses
   * committed: "new" (a new, empty workspace here: what this browser had is deleted), "delete" (the same), or
   * "keep" (what this browser has now accepted as the workspace, after a suspected loss: nothing deleted).
   * A witness write that fails while preparing refuses the reset, nothing changed. */
  async reset(kind: ResetKind): Promise<Identity> {
    return this.locked(async () => {
      // (a tab whose workspace was reset elsewhere resets nothing: astra's probe on 2a4e53a8; nor while a reset or
      // its purge is under way, from here or another tab: one reset at a time, astra's CORR-28F-1)
      await this.sameIdentity();
      // (a reset to a new workspace already admitted, here or in another tab, is joined: carried on to the target
      // it chose, never another; anything else meanwhile is refused as busy)
      const now0 = await this.metaState();
      if (now0.resetting && kind !== "keep") {
        this.durability = { state: "resetting" };
        return { id: now0.resetting.to, before: null };
      }
      if (now0.resetting || now0.purge) throw new WorkspaceError("storage", "a reset of this workspace is already under way: wait for it to finish, then reload");
      // (past every fence left in the editors' stores too: one of a later generation, left by a rollback of this
      // database, would otherwise block the new workspace's fence for good: CORR-56C-1)
      const g = this.identity.generation, to = Math.max(g, await this.fencesUpTo()) + 1, now = this.now();
      const before = await this.sample();
      const prepared: Witness = { ...before, reset: { to, kind, at: now } };
      // 1. prepared, in both witnesses (one already known unwritable this session is passed over)
      // (both prepared, whatever failed earlier this session; passed over only where storage can't be read at
      // all, which no open can take a witness from)
      const was = readLocal(this.place), wasOpfs = await readOpfs(this.place);
      try {
        if (!("unreadable" in was)) writeLocal(this.place, prepared);
        RESET_HOOK.afterFirstWitness?.();
        if (!("unreadable" in wasOpfs)) await writeOpfs(this.place, prepared);
      } catch (e) {
        // (the first written, the second not: the first put back; if that fails too, the next open finds the
        // prepared reset and rolls it back, IndexedDB being unchanged)
        try {
          if (RESET_HOOK.failCleanup) throw new Error("cleanup refused (test)");
          if (!("unreadable" in was)) writeLocal(this.place, "witness" in was ? was.witness : null);
        } catch {}
        throw new WorkspaceError("storage", `the workspace wasn't reset: its record outside IndexedDB couldn't be written (${String((e as Error)?.message ?? e)}). Nothing was changed`);
      }
      RESET_HOOK.afterPrepare?.();
      // 2. IndexedDB: this workspace kept, at generation g+1, in one small transaction; or a new workspace:
      // the reset marked under way (every writer refused meanwhile, and a stop resumed by the next open), every
      // store emptied a page at a time, then the new identity switched to in one small transaction
      const id: Identity = { workspace: kind === "keep" ? this.identity.workspace : hex(8), generation: to };
      if (kind === "keep") {
        await inTx(this.ws, "meta", "readwrite", async (tx) => {
          const meta = tx.objectStore("meta");
          meta.put(id, "identity");
          meta.delete("quarantine");
        });
      } else {
        await inTx(this.ws, "meta", "readwrite", async (tx) => { tx.objectStore("meta").put({ to: id, seq: before.seq } satisfies Resetting, "resetting"); });
        this.durability = { state: "resetting" };
        await this.writeFence();
      }
      return { id, before: before as Witness | null };
    }, undefined, { internal: true }).then(async ({ id }) => {
      // (the cleanup: a page per hold of the lock, then the switch, each in its own hold; then the witnesses committed)
      if (kind !== "keep") await this.cleanUp(true);
      this.identity = id;
      this.durability = { state: "ok" };
      await RESET_HOOK.afterIdb?.();
      return this.locked(async () => {
      // (published only if the workspace is still the one this reset made: astra's CORR-28F-1)
      const { identity: now1 } = await this.metaState();
      if (!now1 || now1.workspace !== id.workspace || now1.generation !== id.generation) throw new WorkspaceError("storage", "the workspace was reset again meanwhile, in another tab: reload this page");
      await this.writeFence();
      // 3. committed, in both witnesses (a write that fails is noted: the next open finds IndexedDB ahead, and harmless)
      const after = await this.sample();
      await this.writeWitnesses(after, true, { local: true });
      RESET_HOOK.afterFirstCommit?.();
      await this.writeWitnesses(after, true, { opfs: true });
      this.channel?.postMessage({ from: this.tab, reset: id });
      this.watchHidden();
      this.durabilityChanged();
      return id;
    }, undefined, { internal: true });
    });
  }

  private cleaning: Promise<void> | null = null;
  private purgePending = false;
  private localPending = false;
  /** Resolves when the cleanup under way here (a reset's, resumed or not, and the old store's purge) is done. */
  settled(): Promise<void> { return this.cleaning ?? Promise.resolve(); }
  /** A reset to a new workspace carried through, or resumed, and the old store's purge: a page per hold of the
   * workspace's lock, yielding between, until nothing is left; then, after a reset, the witnesses committed and
   * the page told.  (`throws`: a stop is thrown, as a reset asked for by the person waits on it; in the
   * background it is noted, and the next open resumes.) */
  cleanUp(throws = false): Promise<void> {
    this.cleaning ??= (async () => {
      let wasResetting = false;
      this.localDoomed = null;
      this.localChecked = false;
      try {
        if ((await this.metaState()).resetting) await this.learnSizes();
        for (;;) {
          const step = await this.locked(() => this.cleanStep(), undefined, { internal: true });
          if (step === "reset") wasResetting = true;
          if (step === "done") break;
          await new Promise((r) => setTimeout(r, 0));
        }
        // (resumed in the background: done, the witnesses committed here; a person's reset commits them itself)
        if (wasResetting && !throws && this.durability.state === "resetting") {
          const { identity } = await this.metaState();
          if (identity) this.identity = identity;
          this.durability = { state: "ok" };
          await this.locked(async () => { await this.writeWitnesses(await this.sample(), true); await this.writeFence(); }, undefined, { internal: true });
          this.durabilityChanged();
        }
      } catch (e) {
        if (throws) throw e;
        console.warn("workspace: a reset's cleanup stopped; the next open resumes it:", e);
      } finally {
        this.cleaning = null;
      }
    })();
    return this.cleaning;
  }
  /** One page of the cleanup, holding the lock: a page of a store a reset empties (its files' bytes first), a
   * page of meta's other keys, the switch to the new identity, or a page of the old store's purge. */
  private async cleanStep(): Promise<"reset" | "purge" | "done"> {
    const { resetting, purge, purgeLocal } = await this.metaState();
    if (resetting) {
      for (const name of RESET_STORES) if (await this.deletePage(this.ws, name)) return "reset";
      // (meta's own keys, those it keeps aside: a bounded key cursor, never every key read again: LIMIT-99B-2)
      const keys = await inTx(this.ws, "meta", "readonly", (tx) => new Promise<IDBValidKey[]>((ok, no) => {
        const out: IDBValidKey[] = [], c = tx.objectStore("meta").openKeyCursor();
        c.onsuccess = () => {
          const k = c.result;
          if (!k || out.length >= RESET_PAGE) return ok(out);
          if (!META_KEPT.has(String(k.key))) out.push(k.key);
          k.continue();
        };
        c.onerror = () => no(c.error);
      }));
      if (keys.length) {
        await inTx(this.ws, "meta", "readwrite", async (tx) => { for (const k of keys) tx.objectStore("meta").delete(k); });
        RESET_HOOK.afterPage?.("meta", keys.length);
        return "reset";
      }
      await inTx(this.ws, "meta", "readwrite", async (tx) => {
        const meta = tx.objectStore("meta");
        meta.put(resetting.to, "identity");
        meta.put(resetting.seq, "opsFloor");
        meta.delete("quarantine");
        meta.delete("resetting");
        // (what the old store and localStorage keep is purged next, so nothing brings it back in; a stop
        // before that finishes is finished by the next open or migrate: astra's CORR-2A4-3)
        meta.put(true, "purgeMain");
      });
      this.identity = resetting.to;
      RESET_HOOK.beforePurge?.();
      return "reset";
    }
    if (purge) {
      if (this.main) for (const st of ["files", "notebooks"]) if (await this.deletePage(this.main, st)) return "purge";
      // (the old store emptied: writers let go; localStorage's part marked pending in the same transaction)
      await inTx(this.ws, "meta", "readwrite", async (tx) => { tx.objectStore("meta").delete("purgeMain"); tx.objectStore("meta").put(true, "purgeLocal"); });
      this.purgePending = false;
      if (this.durability.state === "purging") { this.durability = { state: "ok" }; this.durabilityChanged(); }
      await this.writeFence();
      return "purge";
    }
    if (purgeLocal) {
      // (localStorage's boards and pending copies: LOCAL_PAGE a step from one list (LIMIT-28F-1); its marker
      // dropped only once a full listing finds none left.  Storage that can't be had, listed or emptied now is
      // unknown, never empty (astra's CORR-2A4-3 on 28f6511b): the marker kept, every migrate refused meanwhile,
      // tried again at the next open.  Writers aren't held up by it: the board page's pending copies and a board's
      // marks of the new workspace are under the same prefixes, and each key is removed only if the board it names
      // isn't the workspace's now (astra's CORR-2A4-3 on 56c60932))
      let n: number | "unknown";
      try { n = await this.purgeLocal(); } catch (e) { n = "unknown"; console.warn("workspace: localStorage's old boards couldn't be removed yet; tried again at the next open:", e); }
      if (n === "unknown") { this.localUnknown = true; return "done"; }
      if (n) return "purge";
      await inTx(this.ws, "meta", "readwrite", async (tx) => { tx.objectStore("meta").delete("purgeLocal"); });
      this.localUnknown = false;
      return "purge";
    }
    return "done";
  }
  /** One page of `store` deleted (RESET_PAGE records, RESET_BYTES_PAGE where values are files' bytes): how many. */
  private async deletePage(db: IDBDatabase, store: string): Promise<number> {
    const t0 = performance.now();
    const withVersions = db === this.ws && store === "versionBytes";
    const n = await inTx(db, withVersions ? [store, "versions"] : store, "readwrite", async (tx) => {
      // (the notebooks' fence is not a notebook: kept, and never counted)
      const st = tx.objectStore(store), fence = store === "notebooks" ? await req(st.get(FENCE)) : undefined;
      let keys = ((await req(st.getAllKeys(null, RESET_PAGE + 1))) as IDBValidKey[]).filter((k) => k !== FENCE).slice(0, RESET_PAGE);
      if (keys.length && BYTE_STORES.has(store)) {
        // (files' bytes: cut at RESET_PAGE_BYTES by the sizes recorded for them; a size not known counts so
        // that such records go at most RESET_BYTES_PAGE a page)
        const known = withVersions
          ? new Map(((await req(tx.objectStore("versions").getAll(IDBKeyRange.bound(keys[0], keys[keys.length - 1])))) as Version[]).map((v) => [v.id as IDBValidKey, v.size]))
          : this.sizes[store];
        let total = 0, cut = 0;
        for (const k of keys) {
          const size = known?.get(k as any) ?? RESET_PAGE_BYTES / RESET_BYTES_PAGE;
          if (cut > 0 && total + size > RESET_PAGE_BYTES) break;
          total += size;
          cut++;
        }
        keys = keys.slice(0, cut);
      }
      if (keys.length) st.delete(IDBKeyRange.bound(keys[0], keys[keys.length - 1]));
      if (fence) st.put(fence);
      return keys.length;
    });
    if (n) {
      RESET_HOOK.afterPage?.(store, n, performance.now() - t0);
      this.resetRemoved += n;
      if (this.durability.state === "resetting" && ++this.resetPages % 20 === 0) this.durabilityChanged();
    }
    return n;
  }
  /** Files' bytes' sizes, by their keys, from the index: read before the cleanup's pages, a page at a time
   * (writers are refused meanwhile), so its pages can be cut by bytes. */
  private sizes: Record<string, Map<IDBValidKey, number> | undefined> = {};
  /** How many records a reset's cleanup has removed so far here: the resetting notice shows it. */
  resetRemoved = 0;
  private resetPages = 0;
  private async learnSizes() {
    const files = new Map<IDBValidKey, number>(), trash = new Map<IDBValidKey, number>();
    let after: string | undefined;
    for (;;) {
      const page = (await inTx(this.ws, "entries", "readonly", (tx) => req(tx.objectStore("entries").getAll(after === undefined ? null : IDBKeyRange.lowerBound(after, true), RESET_PAGE)))) as Entry[];
      if (!page.length) break;
      for (const e of page) {
        if (e.kind !== "file") continue;
        if (e.migrated && e.fid) files.set(e.fid, e.size ?? 0);
        if (e.ref && (e.trashed || within(e.path, TRASH))) trash.set(e.ref, e.size ?? 0);
      }
      after = page[page.length - 1].path;
      await new Promise((r) => setTimeout(r, 0));
    }
    this.sizes = { fileBytes: files, trash };
  }
  /** localStorage's boards kept before the workspace, and their pending copies, deleted (after a reset to a new
   * workspace: nothing to bring back in); a key of a board the workspace has now (its pending copy, its marks) kept. */
  // (the keys to purge, listed by one pass over localStorage per cleanup run, then removed LOCAL_PAGE a step from
  // the list: never a scan per step, nor key(i) indexes trusted across removals: daybreak2's LIMIT-28F-1)
  private localDoomed: string[] | null = null;
  private localChecked = false;
  /** Whether localStorage's part of the old store's purge couldn't be done at the latest try (it is tried
   * again at every open; until it is done no migrate brings anything in). */
  localUnknown = false;
  // (how many keys a step went through; a throw when localStorage can't be had, listed or emptied)
  private async purgeLocal(): Promise<number> {
    const doomedKey = (k: string | null) => !!k && (k.startsWith("sagebrush-board:local:") || k.startsWith(BOARD_KEYS.pending("")) || k.startsWith(BOARD_KEYS.unread("")));
    const ls: Storage = globalThis.localStorage;
    if (!ls) throw new Error("no localStorage");
    if (!this.localDoomed?.length && !this.localChecked) {
      // (a list once per run; listed again once when it runs out, to find any key it missed)
      this.localChecked = this.localDoomed !== null;
      const keys: string[] = [];
      for (let i = 0, n = ls.length; i < n; i++) { const k = ls.key(i); if (k !== null) keys.push(k); }
      this.localDoomed = keys.filter(doomedKey);
    }
    const page = this.localDoomed!.splice(0, LOCAL_PAGE);
    if (!page.length) return 0;
    // (the board each key names: "sagebrush-board:local:REF…", or the pending copy's prefix and REF)
    const refOf = (k: string) => (k.startsWith("sagebrush-board:local:") ? k.slice(22, 34) : k.slice((k.startsWith(BOARD_KEYS.unread("")) ? BOARD_KEYS.unread("") : BOARD_KEYS.pending("")).length));
    const ours = await inTx(this.ws, "entries", "readonly", async (tx) => {
      const ix = tx.objectStore("entries").index("byRef");
      const found = await Promise.all(page.map((k) => req(ix.getKey(["board", refOf(k)]))));
      return new Set(page.filter((_, i) => found[i] !== undefined));
    });
    // (read just before each removal: never a key the workspace's board has; a later replacement of one listed
    // for an old board is the same old board's, which the workspace doesn't have)
    for (const k of page) if (!ours.has(k)) ls.removeItem(k);
    RESET_HOOK.afterPage?.("localStorage", page.length);
    return page.length;
  }

  close() {
    this.hdb?.close();
    this.bhdb?.close();
    if (this.opfsTimer) clearTimeout(this.opfsTimer);
    this.opfsTimer = null;
    if (this.onHidden) (globalThis as any).document?.removeEventListener("visibilitychange", this.onHidden);
    this.channel?.close();
    this.ws.close();
    this.main?.close();
  }

  // ------------------------------------------------------------ reading

  /** The entries in `folder` (with `recursive`, everything under it), by path.  Trash shows only when listed itself. */
  async list(folder: string = "/", opts: { recursive?: boolean } = {}): Promise<Entry[]> {
    const f = path(folder);
    this.open();
    const all: Entry[] = await inTx(this.ws, "entries", "readonly", (tx) => req(tx.objectStore("entries").getAll(subtree(f))));
    return all.filter((e) => (opts.recursive || parentOf(e.path) === f) && (within(f, TRASH) || !within(e.path, TRASH)));
  }

  /** One entry, or undefined. */
  async stat(p: string): Promise<Entry | undefined> {
    const q = path(p);
    this.open();
    return inTx(this.ws, "entries", "readonly", (tx) => req(tx.objectStore("entries").get(q)));
  }

  /** An entry and its contents: a notebook's document, a board's document,
   * a data file's bytes, a folder's entries; with the revision to give
   * write() as `base`. */
  /** A data file's bytes, only if they are at most `max` bytes: checked
   * holding the lock (a write can't grow it between the check and the
   * read), and by the bytes read; else a WorkspaceError("limit"), with
   * nothing more read than the check needs (a preview, LIMIT-F85-1). */
  async readUpTo(p: string, max: number): Promise<{ entry: Entry; content: Uint8Array }> {
    return this.locked(async () => {
      const e = await this.mustStat(p);
      if (e.kind !== "file") throw new WorkspaceError("invalid", `${e.path} isn't a data file`);
      if ((e.size ?? 0) > max) throw new WorkspaceError("limit", `${e.path} is larger than ${max} bytes`);
      const c = await this.contents(e);
      if (c === undefined) throw new WorkspaceError("missing", `the contents of ${e.path} are not in this browser`);
      if (c.byteLength > max) throw new WorkspaceError("limit", `${e.path} is larger than ${max} bytes`);
      return { entry: e, content: c };
    });
  }
  async read(p: string): Promise<{ entry: Entry; content: any; rev: number; tag?: string }> {
    const e = await this.mustStat(p);
    if (e.kind === "folder") return { entry: e, content: await this.list(e.path), rev: 0 };
    const c = await this.contents(e);
    if (c === undefined) throw new WorkspaceError("missing", `the contents of ${e.path} are not in this browser`);
    if (e.kind === "notebook") return { entry: e, content: c, rev: c.rev ?? 0 };
    if (e.kind === "board") return { entry: e, content: (c as BoardRecord).doc, rev: (c as BoardRecord).rev, ...((c as BoardRecord).tag ? { tag: (c as BoardRecord).tag } : {}) };
    return { entry: e, content: c, rev: e.rev ?? 0 };
  }

  // ------------------------------------------------------------ changing

  /** A folder, and any folders above it that aren't there. */
  async mkdir(p: string): Promise<Entry> {
    const q = path(p);
    if (q === "/") throw new WorkspaceError("invalid", "the top folder is always there");
    if (within(q, TRASH)) throw new WorkspaceError("invalid", "Trash holds only what was deleted");
    return this.locked(async () => {
      const ops: Op[] = [];
      const e = await inTx(this.ws, ["entries", "ops"], "readwrite", async (tx) => {
        await this.folders(tx, q, ops);
        return req(tx.objectStore("entries").get(q));
      });
      this.tell({ ops });
      return e;
    });
  }

  /** A new notebook, board or data file at `p`, its kind said by its name;
   * `content` its document or bytes (else a blank one), `mode` a document's
   * language.  A path that's taken is refused, never written over. */
  /** Its provenance: "elsewhere" (`made` given here is not read: only the host's createByPerson says "person"). */
  async create(p: string, opts: { content?: unknown; mode?: string; signal?: AbortSignal } = {}): Promise<Entry> {
    return this.createAs(p, opts, "elsewhere");
  }
  /** create(), made by the person in this site's own UI: provenance "person" (design/capabilities.md §6).
   * For the pages' own New only: not offered to agents (forAgent), and no option of create() reaches it. */
  async createByPerson(p: string, opts: { content?: unknown; mode?: string; signal?: AbortSignal } = {}): Promise<Entry> {
    return this.createAs(p, opts, "person");
  }
  /** create(), a copy of `source` (a page's copy of a board: a conflict's, a closed page's changes,
   * Duplicate): the source's provenance, whatever it is (unknown stays unknown).  Not offered to agents. */
  async createCopyOf(source: Pick<Entry, "made">, p: string, opts: { content?: unknown; mode?: string; signal?: AbortSignal } = {}): Promise<Entry> {
    return this.createAs(p, opts, source.made);
  }
  private async createAs(p: string, opts: { content?: unknown; mode?: string; signal?: AbortSignal }, made: Entry["made"]): Promise<Entry> {
    const q = path(p), kind = kindOf(q), content = owned(opts.content, this.limits.maxFileBytes);
    if (q === "/" || within(q, TRASH)) throw new WorkspaceError("invalid", `can't make ${q}`);
    return this.locked(() => this.make(q, kind, content, opts.mode, undefined, made), opts.signal).then((e) => { this.askToKeep(); return e; });
  }

  /** New contents for a notebook, board or data file; with `base` (the
   * revision read() gave), only if nothing else wrote it since: otherwise a
   * WorkspaceError("conflict") with the current contents, nothing written. */
  /** `tag` (a board): who wrote it, kept on the record (a page's session, so that page can tell its own writes from others'). `keepEmpty: false` (a data file): no version of empty bytes (Python's open("w") empties a file before writing it); a version of an empty file is kept otherwise. */
  /** `fid` (a data file): only if the file at `p` is still that one, its own id, not another put at its path since (a WorkspaceError("conflict")). */
  async write(p: string, content: unknown, opts: { base?: number; tag?: string; keepEmpty?: boolean; fid?: string } = {}): Promise<{ entry: Entry; rev: number }> {
    return this.writeLocked(p, owned(content, this.limits.maxFileBytes), opts).then((out) => { this.askToKeep(); return out; });
  }
  private async writeLocked(p: string, content: unknown, opts: { base?: number; tag?: string; keepEmpty?: boolean; fid?: string }): Promise<{ entry: Entry; rev: number }> {
    return this.lockedFor(p, async () => {
      let e = await this.mustStat(p);
      if (e.trashed || within(e.path, TRASH)) throw new WorkspaceError("invalid", "restore it from Trash first");
      if (e.kind === "file") return this.writeFile(await this.migrateOne(e), content, opts);
      const t = this.now();
      let rev: number;
      if (e.kind === "notebook") {
        if (!this.main) throw new WorkspaceError("storage", "this browser has no storage for notebooks");
        const doc = content as any;
        if (!doc || typeof doc !== "object" || !Array.isArray(doc.cells)) throw new WorkspaceError("invalid", "a notebook is {cells: [...]}");
        const { id: _i, rev: _r, updated: _u, ...rest } = doc;
        const out = await new IdbStore(this.main, e.ref!).save({ ...rest, name: splitExt(nameOf(e.path))[0], ...(opts.base !== undefined ? { baseRev: opts.base } : {}) }, { lockHeld: true });
        if (typeof out === "string") throw new WorkspaceError("storage", out);
        if (out.conflict) throw new WorkspaceError("conflict", `${e.path} was changed elsewhere`, out.conflict);
        rev = out.rev;
      } else if (e.kind === "board") {
        this.checkBoard(content);
        rev = await inTx(this.ws, "boards", "readwrite", async (tx) => {
          const st = tx.objectStore("boards"), cur: BoardRecord | undefined = await req(st.get(e.ref!));
          if (!cur) throw new WorkspaceError("missing", `the contents of ${e.path} are not in this browser`);
          if (opts.base !== undefined && cur.rev !== opts.base) throw new WorkspaceError("conflict", `${e.path} was changed elsewhere`, cur.doc);
          const { tag: _t, ...rest } = cur;
          st.put({ ...rest, doc: content, rev: cur.rev + 1, updated: t, ...(opts.tag ? { tag: opts.tag } : {}) });
          return cur.rev + 1;
        });
      } else throw new WorkspaceError("invalid", "a folder has no contents to write");
      const ops: Op[] = [];
      const entry = await inTx(this.ws, ["entries", "ops"], "readwrite", async (tx) => {
        const st = tx.objectStore("entries"), cur: Entry | undefined = await req(st.get(e.path));
        if (!cur || cur.ref !== e.ref) throw new WorkspaceError("conflict", `${e.path} was moved while it was written`);
        const next: Entry = { ...cur, updated: t };
        delete next.missing;
        st.put(next);
        await this.log(tx, ops, { op: "write", path: e.path, kind: e.kind }, next);
        return next;
      });
      this.tell({ ops });
      return { entry, rev };
    });
  }

  /** A data file's new bytes (its entry migrated first, holding the lock):
   * in one transaction of the workspace's database, the bytes it had kept as
   * a version, the new bytes, its entry and the operation: all of it, or
   * none (design/capabilities.md §2a). */
  private async writeFile(e: Entry, content: unknown, opts: { base?: number; keepEmpty?: boolean; fid?: string }): Promise<{ entry: Entry; rev: number }> {
    const b = bytesOf(content);
    if (b.length > this.limits.maxFileBytes) throw new WorkspaceError("limit", `a file is at most ${this.limits.maxFileBytes} bytes`);
    if (opts.fid !== undefined && e.fid !== opts.fid) throw new WorkspaceError("conflict", `${e.path} is another file now`);
    // (one too large to move beside the index: not written, and its old bytes not read to be kept (astra))
    if (e.unmoved) throw new WorkspaceError("limit", tooLarge(e));
    const old = await this.contents(e);
    if (opts.base !== undefined && (e.rev ?? 0) !== opts.base) throw new WorkspaceError("conflict", `${e.path} was changed elsewhere`, old);
    // (the bytes it had, kept as a version: a write that can't keep them doesn't happen)
    // (nothing to lose, nothing kept: the same bytes again, or, asked for (Python's writes: open("w") empties a file first), empty bytes; CORR-12C-4)
    const fid = e.fid ?? hex(8);
    const version = old !== undefined && !sameBytes(old, b) && (old.length > 0 || opts.keepEmpty !== false) ? await this.versionOf({ ...e, fid }, old) : null;
    const t = this.now(), rev = (e.rev ?? 0) + 1, ops: Op[] = [];
    // (a file kept the old way that wasn't moved (too large): its old copy marked, and deleted after, as a move's is)
    const where = e.trashed || within(e.path, TRASH) ? "trash" : "files";
    const oldMark: StaleMark | null = !e.migrated && old !== undefined && e.ref !== null ? { fid, size: old.byteLength, sha256: await bytesHash(old) } : null;
    // (its new bytes' SHA-256, before the transaction (none can await anything else), and the one it replaces:
    // as kept, else as just computed for its version or its old copy's mark; the bytes hashed only when no
    // hash of them is at hand: design/sync-client.md §3)
    const sha256 = await bytesHash(b);
    const base = e.sha256 ?? version?.sha256 ?? oldMark?.sha256 ?? (old === undefined ? undefined : sameBytes(old, b) ? sha256 : await bytesHash(old));
    let entry: Entry;
    try {
      entry = await inTx(this.ws, ["entries", "ops", "fileBytes", ...(version || oldMark ? VERSION_STORES : [])], "readwrite", async (tx) => {
        const st = tx.objectStore("entries"), cur: Entry | undefined = await req(st.get(e.path));
        // (still the file read, at the revision read: CORR-CAP-2's identity at use)
        if (!cur || cur.kind !== "file" || cur.ref !== e.ref || cur.fid !== e.fid || (cur.rev ?? 0) !== (e.rev ?? 0)) throw new WorkspaceError("conflict", `${e.path} changed while it was written`);
        if (version) await this.putVersion(tx, version, old!);
        tx.objectStore("fileBytes").put(b, fid);
        if (oldMark) tx.objectStore("meta").put(oldMark, staleKey(where, e.ref!));
        const next: Entry = { ...cur, fid, ident: fid, migrated: true, rev, size: b.length, sha256, updated: t };
        delete next.missing;
        delete next.unmoved;
        st.put(next);
        await this.log(tx, ops, { op: "write", path: e.path, kind: "file" }, next, undefined, base);
        return next;
      });
    } catch (err) {
      if (err instanceof WorkspaceError) throw err;
      throw new WorkspaceError("storage", `${e.path} couldn't be saved (${(err as Error)?.name ?? err}): nothing was changed`);
    }
    if (oldMark) await this.dropStale(where, e.ref!, old).catch(() => {});
    this.tell({ ops });
    return { entry, rev };
  }

  /** `from` (and, for a folder, everything in it) moved to `to`, which must
   * be free.  A document whose title was its name gets the new name.
   * `opts.still`, asked holding the lock: false, and nothing is moved
   * (undefined returned): a rename asked for earlier and since superseded,
   * as a typed title's by a rename in the file browser (CORR-0B0-1).
   * `opts.retitle` false: the title left to the page that has the document
   * open, which saves it with its other changes (written here, it would be
   * a change from elsewhere to that page: CORR-0B0-2). */
  /** `opts.expect`: the entry the rename was asked for, by its identity
   * (a document's ref, a data file's fid, and when it was made): checked
   * holding the lock, a WorkspaceError("conflict") if what is at `from` now
   * is another (moved away meanwhile, something else put there: CORR-4B2-1). */
  async rename(from: string, to: string, opts?: { retitle?: boolean; expect?: Pick<Entry, "kind" | "ref" | "fid" | "created"> }): Promise<Entry>;
  async rename(from: string, to: string, opts: { still: () => boolean; retitle?: boolean; expect?: Pick<Entry, "kind" | "ref" | "fid" | "created"> }): Promise<Entry | undefined>;
  async rename(from: string, to: string, opts: { still?: () => boolean; retitle?: boolean; expect?: Pick<Entry, "kind" | "ref" | "fid" | "created"> } = {}): Promise<Entry | undefined> {
    const a = path(from), b = path(to);
    if (a === "/" || b === "/") throw new WorkspaceError("invalid", "the top folder can't be moved");
    if (within(a, TRASH) || within(b, TRASH)) throw new WorkspaceError("invalid", "use remove and restore for Trash");
    if (within(b, a)) throw new WorkspaceError("invalid", "a folder can't go inside itself");
    return this.lockedFor(a, async () => {
      if (opts.still && !opts.still()) return undefined;
      if (opts.expect) {
        const x = opts.expect, cur = await this.stat(a);
        if (!cur || cur.kind !== x.kind || cur.created !== x.created || cur.fid !== x.fid || (cur.kind !== "file" && cur.ref !== x.ref)) throw new WorkspaceError("conflict", `${a} was moved or replaced meanwhile`);
      }
      if (a === b) return this.mustStat(a);
      const moved = await this.move(a, b, "rename");
      if (opts.retitle !== false) await this.retitle(moved[0], a);
      return moved[0];
    });
  }

  /** A copy of a notebook, board or data file, at `to` (else the first free `name (2)`, … beside it). */
  async duplicate(p: string, to?: string): Promise<Entry> {
    return this.locked(async () => {
      const e = await this.mustStat(p);
      if (e.kind === "folder") throw new WorkspaceError("invalid", "a folder can't be duplicated yet");
      if (e.unmoved) throw new WorkspaceError("limit", tooLarge(e));
      const c = await this.contents(e);
      if (c === undefined) throw new WorkspaceError("missing", `the contents of ${e.path} are not in this browser`);
      let dest = to === undefined ? undefined : path(to);
      if (dest === undefined) {
        const folder = parentOf(e.path), taken = new Set((await this.list(folder)).map((x) => x.path));
        const [base, ext] = splitExt(nameOf(e.path));
        dest = freePath(folder, base, ext, (x) => taken.has(x));
        if (!dest) throw new WorkspaceError("limit", "no free name for the copy");
      }
      if (within(dest, TRASH) || (e.kind !== "file" && kindOf(dest) !== e.kind)) throw new WorkspaceError("invalid", `a copy of ${e.path} can't be ${dest}`);
      if (e.kind === "notebook") {
        const { id: _i, rev: _r, updated: _u, ...doc } = c;
        return this.make(dest, "notebook", doc, e.mode, undefined, e.made);
      }
      // (a copy has its source's provenance: a copy of something from elsewhere is still from elsewhere)
      if (e.kind === "board") return this.make(dest, "board", structuredClone((c as BoardRecord).doc), e.mode, (c as BoardRecord).origin, e.made);
      return this.make(dest, "file", c);
    });
  }

  /** `p` (and what's in it) put in Trash, as `/Trash/<its name>` (or the
   * first free `name (2)`, …); nothing of its contents removed. */
  /** `expect`: the entry asked for, by its identity (as rename's): another at `q` now, a WorkspaceError("conflict"), nothing moved. */
  async remove(p: string, expect?: Pick<Entry, "kind" | "ref" | "fid" | "created">, signal?: AbortSignal): Promise<Entry> {
    const q = path(p);
    if (q === "/" || within(q, TRASH)) throw new WorkspaceError("invalid", `can't put ${q} in Trash`);
    return this.lockedFor(q, async () => {
      const cur = await this.mustStat(q);
      if (expect && (cur.kind !== expect.kind || cur.created !== expect.created || cur.fid !== expect.fid || (cur.kind !== "file" && cur.ref !== expect.ref))) throw new WorkspaceError("conflict", `${q} was moved or replaced meanwhile`);
      const taken = new Set((await this.list(TRASH)).map((x) => x.path));
      const [base, ext] = splitExt(nameOf(q));
      const dest = freePath(TRASH, base, ext, (x) => taken.has(x));
      if (!dest) throw new WorkspaceError("limit", "Trash is full: empty it first");
      return (await this.move(q, dest, "remove", { from: q, at: this.now(), id: hex(8) }))[0];
    }, signal);
  }

  /** What `p` in Trash was, put back where it was (or, if that's taken now,
   * the first free `name (2)`, … there).  With `expect` (what remove
   * returned), only that same entry, put in Trash that time: checked
   * holding the lock, a WorkspaceError("missing") if it isn't the one
   * there now, nothing moved (Undo, CORR-0B0-3). */
  async restore(p: string, expect?: Entry): Promise<Entry> {
    return this.lockedFor(p, async () => {
      const e = await this.mustStat(p);
      if (expect && !sameTrashed(e, expect)) throw new WorkspaceError("missing", `${nameOf(expect.trashed?.from ?? expect.path)} was already restored or deleted`);
      if (!e.trashed) throw new WorkspaceError("invalid", within(e.path, TRASH) ? "restore the folder it is in" : `${e.path} isn't in Trash`);
      const from = e.trashed.from, folder = parentOf(from);
      const taken = new Set((await this.list(folder).catch(() => [] as Entry[])).map((x) => x.path));
      const [base, ext] = splitExt(nameOf(from));
      const dest = taken.has(from) ? freePath(folder, base, ext, (x) => taken.has(x)) : from;
      if (!dest) throw new WorkspaceError("limit", `no free name in ${folder}`);
      return (await this.move(e.path, dest, "restore", null))[0];
    });
  }

  /** Changes made from here or in another tab of this browser: `f({ops})`; returns how to stop. */
  watch(f: (c: Change) => void): () => void {
    this.subs.add(f);
    return () => this.subs.delete(f);
  }

  /** The operation log, oldest first, from `after` (a seq). */
  /** The operation log's latest seq (0 if none). */
  async lastSeq(): Promise<number> {
    return inTx(this.ws, "ops", "readonly", (tx) => new Promise<number>((ok, no) => { const c = tx.objectStore("ops").openKeyCursor(null, "prev"); c.onsuccess = () => ok((c.result?.key as number | undefined) ?? 0); c.onerror = () => no(c.error); }));
  }
  /** The index's generation: the latest op's seq, or the highest seq of op records deleted (meta's
   * "opsFloor"), whichever is larger; it never goes down (db.ts, "ops"). */
  async generation(): Promise<number> {
    return inTx(this.ws, ["ops", "meta"], "readonly", async (tx) => {
      const last = await new Promise<number>((ok, no) => { const c = tx.objectStore("ops").openKeyCursor(null, "prev"); c.onsuccess = () => ok((c.result?.key as number | undefined) ?? 0); c.onerror = () => no(c.error); });
      const floor = ((await req(tx.objectStore("meta").get("opsFloor"))) as number | undefined) ?? 0;
      return Math.max(last, floor);
    });
  }
  /** Op records up to `upTo` deleted (none yet calls this: sync will, once what it sends is acknowledged),
   * the highest seq deleted recorded first as opsFloor, in the same transaction: the generation never goes down. */
  async dropOps(upTo: number): Promise<number> {
    return inTx(this.ws, ["ops", "meta"], "readwrite", async (tx) => {
      const ops = tx.objectStore("ops"), meta = tx.objectStore("meta");
      const keys = (await req(ops.getAllKeys(IDBKeyRange.upperBound(upTo)))) as number[];
      if (!keys.length) return 0;
      const floor = ((await req(meta.get("opsFloor"))) as number | undefined) ?? 0;
      meta.put(Math.max(floor, keys[keys.length - 1]), "opsFloor");
      ops.delete(IDBKeyRange.upperBound(upTo));
      return keys.length;
    });
  }
  async ops(after = 0): Promise<Op[]> {
    return inTx(this.ws, "ops", "readonly", (tx) => req(tx.objectStore("ops").getAll(IDBKeyRange.lowerBound(after, true))));
  }

  /** A data file's kept versions, in the order they were kept (§2.5); `version(p, i)` reads one's bytes.  (Notebooks' and boards' TimeTravel comes with the pages, step 1b.) */
  async history(p: string): Promise<Version[]> {
    const e = await this.mustStat(p);
    if (e.kind !== "file") throw new WorkspaceError("invalid", "history() is for data files here; a document's is its TimeTravel");
    if (!e.fid) return [];
    const vs: Version[] = await inTx(this.ws, "versions", "readonly", (tx) => req(tx.objectStore("versions").index("byFile").getAll(IDBKeyRange.bound([e.fid, -Infinity], [e.fid, Infinity]))));
    // (in the order they were kept: the ids count up, whatever the clock did)
    return vs.sort((x, y) => x.id! - y.id!);
  }

  /** The bytes of a data file's version `i` (an index into history()). */
  async version(p: string, i: number): Promise<Uint8Array> {
    const v = (await this.history(p))[i];
    if (!v) throw new WorkspaceError("missing", `${path(p)} has no version ${i}`);
    const b = await inTx(this.ws, "versionBytes", "readonly", (tx) => req(tx.objectStore("versionBytes").get(v.id!)));
    if (b === undefined) throw new WorkspaceError("missing", `the bytes of that version are gone`);
    return b;
  }

  /** Old versions of data files dropped for good (§2.5): those of `p` (a
   * file, every file in a folder, or with "/" every version kept), each
   * file keeping its latest `keep` (default none).  Only a person may, from
   * the file browser or the Storage panel after confirming: a workspace
   * acting for an agent (actor "agent:…") is refused, and the agent surfaces
   * (window.sagebrush.workspace, MCP, the endpoint) don't offer it.  Logged.
   * Returns the bytes freed. */
  /** The bytes of `p`'s version `id` (as history() lists it): a
   * WorkspaceError("missing") if it isn't one of this file's, or is gone. */
  async versionById(p: string, id: number): Promise<Uint8Array> {
    const e = await this.mustStat(p);
    if (e.kind !== "file" || !e.fid) throw new WorkspaceError("missing", `${path(p)} has no versions`);
    return inTx(this.ws, ["versions", "versionBytes"], "readonly", async (tx) => {
      const v: Version | undefined = await req(tx.objectStore("versions").get(id));
      if (!v || v.fid !== e.fid) throw new WorkspaceError("missing", `that version of ${e.path} is gone`);
      const b = await req(tx.objectStore("versionBytes").get(id));
      if (b === undefined) throw new WorkspaceError("missing", "the bytes of that version are gone");
      return b as Uint8Array;
    });
  }
  /** `p`'s version `id` written back, only over what was seen (CORR-F85-2):
   * the file still `expect.fid`, at revision `expect.rev`, checked with the
   * write, holding the lock; else a WorkspaceError("conflict") (another
   * file there now, or written since) or ("missing"), nothing written.
   * What it had is kept as a version, as for any write. */
  async restoreVersion(p: string, id: number, expect: { fid: string; rev: number }): Promise<Entry> {
    const bytes = await this.versionById(p, id);
    return (await this.write(p, bytes, { base: expect.rev, fid: expect.fid })).entry;
  }

  /** `expect` (what the person confirmed, CORR-F85-1): for a data file,
   * its id `fid` (the file there now must be that one) and the version
   * `ids` shown (only those go); for a folder or "/", the `count` and
   * `bytes` versionsUsage gave, and a folder's `created` (the same
   * folder): checked holding the lock, a WorkspaceError("conflict") if
   * they changed since, nothing dropped.  And `maxId` (versionsUsage's,
   * when it was confirmed): no newer version goes, one kept since then
   * not having been confirmed (CORR-AC5-1); a folder's are its files' at
   * the drop. */
  async dropVersions(p: string, opts: { keep?: number; expect?: { fid?: string; ids?: number[]; count?: number; bytes?: number; created?: number; maxId?: number; seq?: number } } = {}): Promise<number> {
    const q = path(p), keep = Math.max(0, Math.floor(opts.keep ?? 0)), x = opts.expect;
    if (this.actor !== "person") throw new WorkspaceError("invalid", "only a person can drop old versions");
    return this.locked(async () => {
      if (x) {
        const e = q === "/" ? undefined : await this.mustStat(q);
        if (x.fid !== undefined && e?.fid !== x.fid) throw new WorkspaceError("conflict", `${q} is another file now`);
        if (x.created !== undefined && e?.created !== x.created) throw new WorkspaceError("conflict", `${q} is another folder now`);
        // (a folder's: nothing moved, made, restored or removed in it since
        // it was confirmed, by the operation log after `seq` (writes only
        // add versions, which maxId fences); else asked again, CORR-5D2-2)
        if (x.seq !== undefined && q !== "/") {
          const later = (await inTx(this.ws, "ops", "readonly", (tx) => req(tx.objectStore("ops").getAll(IDBKeyRange.lowerBound(x.seq!, true), SEQ_SCAN + 1)))) as Op[];
          const touched = (o: Op) => o.op !== "write" && o.op !== "dropVersions" && (within(o.path, q) || within(q, o.path) || (o.to !== undefined && (within(o.to, q) || within(q, o.to))));
          if (later.length > SEQ_SCAN || later.some(touched)) throw new WorkspaceError("conflict", `${q} changed since: see its old versions again`);
        }
        if (x.count !== undefined || x.bytes !== undefined) {
          const u = await this.versionsUsage(q);
          if ((x.count !== undefined && u.count !== x.count) || (x.bytes !== undefined && u.bytes !== x.bytes)) throw new WorkspaceError("conflict", `the old versions in ${q} changed since: see them again`);
        }
      }
      // (only the ids confirmed; or, bulk, none newer than the newest shown when it was confirmed: CORR-AC5-1)
      const only = x?.ids ? new Set(x.ids) : null, upTo = x?.maxId ?? Infinity;
      // (only the versions asked about are read, a bounded batch per
      // transaction: a file's or a folder's by their files' ids, at most
      // maxVersions each; all of them, a batch of records at a time, never
      // their bytes: LIMIT-F85-2)
      let kind: Kind = "folder", fids: string[] | null = null;
      if (q !== "/") {
        const e = await this.mustStat(q);
        kind = e.kind;
        const files = e.kind === "folder" ? (await this.list(q, { recursive: true })).filter((x) => x.kind === "file") : e.kind === "file" ? [e] : [];
        fids = [...new Set(files.map((x) => x.fid).filter((x): x is string => !!x))];
      } else if (keep > 0) {
        // (every data file's, Trash's too, by the entries: each file's newest `keep` stay)
        const all = (await inTx(this.ws, "entries", "readonly", (tx) => req(tx.objectStore("entries").getAll()))) as Entry[];
        fids = [...new Set(all.filter((x) => x.kind === "file" && x.fid).map((x) => x.fid!))];
      }
      const stores = ["versions", "versionBytes", "meta"];
      const less = async (tx: IDBTransaction, f: number, all = false) => {
        const meta = tx.objectStore("meta"), total = ((await req(meta.get("versionBytes"))) as number | undefined) ?? 0;
        meta.put(all ? 0 : Math.max(0, total - f), "versionBytes");
      };
      let freed = 0;
      if (fids) {
        for (let i = 0; i < fids.length; i += DROP_FILES) {
          const batch = fids.slice(i, i + DROP_FILES);
          freed += await inTx(this.ws, stores, "readwrite", async (tx) => {
            const vs = tx.objectStore("versions"), vb = tx.objectStore("versionBytes");
            let f = 0;
            for (const fid of batch) {
              const list: Version[] = await req(vs.index("byFile").getAll(IDBKeyRange.bound([fid, -Infinity], [fid, Infinity])));
              list.sort((x, y) => x.id! - y.id!);
              for (const v of list.slice(0, Math.max(0, list.length - keep))) {
                if ((only && !only.has(v.id!)) || v.id! > upTo) continue;
                vs.delete(v.id!); vb.delete(v.id!); f += v.size;
              }
            }
            await less(tx, f);
            return f;
          });
        }
      } else {
        for (;;) {
          const [n, f] = await inTx(this.ws, stores, "readwrite", async (tx) => {
            const vs = tx.objectStore("versions"), vb = tx.objectStore("versionBytes");
            const list: Version[] = await req(vs.getAll(upTo === Infinity ? null : IDBKeyRange.upperBound(upTo), DROP_RECORDS));
            let f = 0;
            for (const v of list) { vs.delete(v.id!); vb.delete(v.id!); f += v.size; }
            // (the total set to 0 only when no version is left at all: a drop fenced by maxId leaves newer ones, CORR-5D2-1)
            await less(tx, f, upTo === Infinity && list.length < DROP_RECORDS);
            return [list.length, f] as const;
          });
          freed += f;
          if (n < DROP_RECORDS) break;
        }
      }
      const ops: Op[] = [];
      await inTx(this.ws, "ops", "readwrite", async (tx) => { await this.log(tx, ops, { op: "dropVersions", path: q, kind }); });
      this.tell({ ops });
      return freed;
    });
  }


  /** The old versions kept of `p`'s data files (a file, a folder's, or
   * with "/" all of them, Trash's too): how many, and their bytes; what
   * dropVersions(p) would free.  Read only: the versions' records, never
   * their bytes. */
  async versionsUsage(p = "/"): Promise<{ count: number; bytes: number; maxId: number; seq: number }> {
    const q = path(p);
    // (seq: the operation log's latest, read first: what is in scope as of then, CORR-5D2-2)
    const seq = await this.lastSeq();
    let fids: Set<string> | null = null;
    if (q !== "/") {
      const e = await this.mustStat(q);
      const files = e.kind === "folder" ? (await this.list(q, { recursive: true })).filter((x) => x.kind === "file") : e.kind === "file" ? [e] : [];
      fids = new Set(files.map((x) => x.fid).filter((x): x is string => !!x));
      if (!fids.size) return { count: 0, bytes: 0, maxId: 0, seq };
    }
    // (all of them: their count and the running total kept with them, no
    // record read; a folder's: each file's, at most maxVersions each)
    return inTx(this.ws, ["versions", "meta"], "readonly", async (tx) => {
      const vs = tx.objectStore("versions");
      // (maxId: the newest version's id, the high-water mark a drop confirmed now is bound to, CORR-AC5-1)
      if (!fids) {
        const last = await new Promise<number>((ok, no) => { const c = vs.openKeyCursor(null, "prev"); c.onsuccess = () => ok((c.result?.key as number | undefined) ?? 0); c.onerror = () => no(c.error); });
        return { count: (await req(vs.count())) as number, bytes: (((await req(tx.objectStore("meta").get("versionBytes"))) as number | undefined) ?? 0), maxId: last, seq };
      }
      let count = 0, bytes = 0, maxId = 0;
      for (const fid of fids) {
        const list: Version[] = await req(vs.index("byFile").getAll(IDBKeyRange.bound([fid, -Infinity], [fid, Infinity])));
        for (const v of list) { count++; bytes += v.size; maxId = Math.max(maxId, v.id!); }
      }
      return { count, bytes, maxId, seq };
    });
  }

  /** What this browser's workspace holds, for the Storage panel (§6.3):
   * notebooks and boards (how many), data files (how many, their bytes),
   * old versions, and Trash (its entries, and its data files' bytes). */
  async usage(): Promise<{ documents: number; files: { count: number; bytes: number }; versions: { count: number; bytes: number; maxId: number }; trash: { count: number; bytes: number }; migration: { left: number }; lookalikes: string[][]; lookalikesMore: { groups: number; members: number } }> {
    const all = await inTx(this.ws, "entries", "readonly", (tx) => req(tx.objectStore("entries").getAll())) as Entry[];
    const out = { documents: 0, files: { count: 0, bytes: 0 }, versions: await this.versionsUsage("/"), trash: { count: 0, bytes: 0 }, migration: { left: 0 }, lookalikes: [] as string[][], lookalikesMore: { groups: 0, members: 0 } };
    // (names that look the same in one folder, made before they were refused: by a cursor over the index
    // byNfc, where they are next to one another; at most LOOKALIKE_GROUPS groups of LOOKALIKE_MEMBERS shown,
    // the rest counted, never all of them held: LIMIT-CAP1B-1)
    Object.assign(out, await this.lookalikeGroups());
    for (const e of all) {
      // (data files whose bytes the migrator hasn't moved yet, Trash's too: capabilities §2b)
      if (e.kind === "file" && !e.migrated && !e.unmoved && !e.missing && e.ref !== null) out.migration.left++;
      if (within(e.path, TRASH)) {
        if (e.path !== TRASH && parentOf(e.path) === TRASH) out.trash.count++;
        if (e.kind === "file") out.trash.bytes += e.size ?? 0;
      } else if (e.kind === "file") { out.files.count++; out.files.bytes += e.size ?? 0; }
      else if (e.kind === "notebook" || e.kind === "board") out.documents++;
    }
    return out;
  }

  /** Names that look the same in one folder: at most `groups` groups of at most `members` paths each, and
   * how many beyond those weren't listed: `groups`, the groups left out; `members`, every path not listed,
   * whether its group was listed or left out (daybreak2). */
  async lookalikeGroups(groups = LOOKALIKE_GROUPS, members = LOOKALIKE_MEMBERS): Promise<{ lookalikes: string[][]; lookalikesMore: { groups: number; members: number } }> {
    return inTx(this.ws, "entries", "readonly", (tx) => new Promise((ok, no) => {
      const out: string[][] = [], more = { groups: 0, members: 0 };
      let key: string | null = null, cur: string[] = [], n = 0;
      const flush = () => {
        if (n > 1) {
          if (out.length < groups) { out.push(cur); more.members += n - cur.length; }
          else { more.groups++; more.members += n; }
        }
      };
      const c = tx.objectStore("entries").index("byNfc").openKeyCursor();
      c.onsuccess = () => {
        const r = c.result;
        if (!r) { flush(); return ok({ lookalikes: out, lookalikesMore: more }); }
        if (r.key !== key) { flush(); key = r.key as string; cur = []; n = 0; }
        n++;
        if (cur.length < members) cur.push(r.primaryKey as string);
        r.continue();
      };
      c.onerror = () => no(c.error);
    }));
  }

  /** (askToKeep, for the person's own writes; never for an agent's, or the migration's, which writes through adopt) */
  private askToKeep() {
    if (this.actor === "person") askToKeep();
  }

  /** Entries in Trash removed for good (§2.4): `paths` (each with what is
   * in it), or everything in Trash.  Their contents go too: a notebook's
   * record and its TimeTravel, a board's record and its TimeTravel, a data
   * file's bytes and its versions.  Only a person may, from the file
   * browser after confirming: refused for an agent's workspace, and not
   * offered to agents.  The entries go first, so a failure part way leaves
   * contents without entries (listed again by reconcile), never entries
   * without contents.  Logged.  Returns how many entries went. */
  async emptyTrash(paths?: string[]): Promise<number> {
    if (this.actor !== "person") throw new WorkspaceError("invalid", "only a person can empty Trash");
    const tops = paths?.map((p) => path(p)) ?? [TRASH];
    for (const t of tops) if (!within(t, TRASH) || (paths && t === TRASH)) throw new WorkspaceError("invalid", `${t} isn't in Trash`);
    return this.locked(async () => {
      const ops: Op[] = [];
      const gone: Entry[] = await inTx(this.ws, ["entries", "ops", "fileBytes", "trash"], "readwrite", async (tx) => {
        const st = tx.objectStore("entries"), out: Entry[] = [];
        for (const t of tops) {
          const top: Entry | undefined = t === TRASH ? undefined : await req(st.get(t));
          if (t !== TRASH && !top) continue;
          const under: Entry[] = await req(st.getAll(subtree(t)));
          for (const e of [...(top ? [top] : []), ...under]) {
            st.delete(e.path);
            // (a data file's bytes with its entry, in this one transaction: in fileBytes, or the old way in trash)
            if (e.kind === "file" && e.migrated && e.fid) tx.objectStore("fileBytes").delete(e.fid);
            else if (e.kind === "file" && e.ref !== null) tx.objectStore("trash").delete(e.ref);
            out.push(e);
          }
          // (one op for each identity removed whole: the entry asked for, or, Trash emptied, each thing in
          // it; what was in a folder removed goes with it, as sync's forget has it: design/sync-client.md §3.
          // So at most maxFolderEntries (10,000) ops, Trash's own entries, whatever is in them: a burst of
          // records and of watchers' notices bounded at about a kilobyte each, low tens of MiB (daybreak2))
          for (const e of top ? [top] : under.filter((x) => parentOf(x.path) === TRASH)) await this.log(tx, ops, { op: "emptyTrash", path: e.path, kind: e.kind }, null, e);
        }
        return out;
      });
      // (then their contents, and their histories)
      const hdb = gone.some((e) => e.kind === "notebook") ? await openHistoryDb() : null;
      const bdb = gone.some((e) => e.kind === "board") ? await openBoardHistoryDb() : null;
      const fids = new Set(gone.filter((e) => e.kind === "file" && e.fid).map((e) => e.fid!));
      for (const e of gone) {
        if (e.ref === null) continue;
        try {
          if (e.kind === "notebook") {
            await this.mainTx("notebooks", "readwrite", (st) => st.delete(e.ref!));
            if (hdb) await inTx(hdb, "history", "readwrite", async (tx) => { tx.objectStore("history").delete(IDBKeyRange.bound([e.ref, -Infinity], [e.ref, Infinity])); });
          } else if (e.kind === "board") {
            await inTx(this.ws, "boards", "readwrite", async (tx) => { tx.objectStore("boards").delete(e.ref!); });
            // (its TimeTravel: by the board's source, "board:local:<id>", with its name in this browser after it)
            const pre = "board:local:" + e.ref;
            if (bdb) await inTx(bdb, "history", "readwrite", async (tx) => { tx.objectStore("history").delete(IDBKeyRange.bound([pre, -Infinity], [pre + ":\uffff", Infinity])); });
            // (and what the board page keeps of it in localStorage: the copy
            // from before the workspace, its mark as written here, a closed
            // page's changes; none of them bring it back, or vouch for a
            // board under its id)
            try {
              const ls = (globalThis as any).localStorage as Storage | undefined;
              for (const k of Object.values(BOARD_KEYS)) ls?.removeItem(k(e.ref));
            } catch {}
          }
        } catch (err) { console.warn("workspace: emptying Trash:", err); }
      }
      if (fids.size) {
        await inTx(this.ws, ["versions", "versionBytes", "meta"], "readwrite", async (tx) => {
          const vs = tx.objectStore("versions"), vb = tx.objectStore("versionBytes"), meta = tx.objectStore("meta");
          let freed = 0;
          for (const fid of fids) {
            const list: Version[] = await req(vs.index("byFile").getAll(IDBKeyRange.bound([fid, -Infinity], [fid, Infinity])));
            for (const v of list) { vs.delete(v.id!); vb.delete(v.id!); freed += v.size; }
          }
          const total = ((await req(meta.get("versionBytes"))) as number | undefined) ?? 0;
          meta.put(Math.max(0, total - freed), "versionBytes");
        });
      }
      hdb?.close();
      bdb?.close();
      this.tell({ ops });
      return gone.length;
    });
  }

  // ------------------------------------------------------------ for the pages

  /** The path of the entry naming these contents (a board's or notebook's id, a data file's key), or undefined. */
  async pathOf(kind: Exclude<Kind, "folder">, ref: string): Promise<string | undefined> {
    return inTx(this.ws, "entries", "readonly", (tx) => req(tx.objectStore("entries").index("byRef").getKey([kind, ref]))) as Promise<string | undefined>;
  }

  /** A data file written at `p`: made if it isn't there, else written over (its old bytes kept as a version, §2.5).  What Python's writes and the Files panel's uploads go through. */
  async putFile(p: string, bytes: unknown, opts: { keepEmpty?: boolean } = {}): Promise<Entry> {
    const q = path(p);
    const e = await this.stat(q);
    if (!e) return this.create(q, { content: bytes }).catch(async (err) => {
      // (made meanwhile, by another tab: written over instead)
      if (err instanceof WorkspaceError && err.code === "exists" && (await this.stat(q))) return (await this.write(q, bytes, opts)).entry;
      throw err;
    });
    if (e.kind !== "file") throw new WorkspaceError("exists", `${q} is a ${e.kind}, not a file`);
    return (await this.write(q, bytes, opts)).entry;
  }

  /** A data file too large to move beside the index (`unmoved`), deleted for good WITHOUT reading it:
   * Trash can't take it (putting it there would read it, daybreak2).  Only a person may, after confirming
   * (the file browser's Delete), and not an agent.  `expect`: the entry confirmed, by its identity.  Its
   * old copy goes first, then its entry (a failure between leaves an entry naming nothing, which reconcile
   * marks missing; never bytes no entry names).  Logged. */
  async discard(p: string, expect: Pick<Entry, "fid" | "created">): Promise<void> {
    if (this.actor !== "person") throw new WorkspaceError("invalid", "only a person can delete a file for good");
    const q = path(p);
    return this.locked(async () => {
      const e = await this.mustStat(q);
      if (e.kind !== "file" || !e.unmoved) throw new WorkspaceError("invalid", `${q} goes to Trash; only a file too large to move is deleted for good`);
      if (e.fid !== expect.fid || e.created !== expect.created) throw new WorkspaceError("conflict", `${q} is another file now`);
      if (e.ref !== null) {
        if (e.trashed || within(e.path, TRASH)) await inTx(this.ws, "trash", "readwrite", async (tx) => { tx.objectStore("trash").delete(e.ref!); });
        else if (this.main) await this.mainTx("files", "readwrite", (st) => st.delete(e.ref!));
      }
      const ops: Op[] = [];
      await inTx(this.ws, ["entries", "ops"], "readwrite", async (tx) => {
        const st = tx.objectStore("entries"), cur: Entry | undefined = await req(st.get(q));
        if (cur && cur.fid === e.fid && cur.created === e.created) st.delete(q);
        await this.log(tx, ops, { op: "discard", path: q, kind: "file" }, null, e);
      });
      this.tell({ ops });
    });
  }

  /** An entry dropped from the index, its contents already removed by the
   * page (a notebook deleted from the Open dialog, as before Trash is in
   * the UI).  For the pages only: not offered to agents. */
  async forget(p: string): Promise<void> {
    const q = path(p);
    if (this.actor !== "person") throw new WorkspaceError("invalid", "only the page itself forgets entries");
    return this.locked(async () => {
      const ops: Op[] = [];
      await inTx(this.ws, ["entries", "ops"], "readwrite", async (tx) => {
        const st = tx.objectStore("entries"), e: Entry | undefined = await req(st.get(q));
        if (!e) return;
        if (e.kind === "folder" && (await req(st.count(subtree(q)))) > 0) throw new WorkspaceError("invalid", `${q} isn't empty`);
        st.delete(q);
        await this.log(tx, ops, { op: "forget", path: q, kind: e.kind }, null, e);
      });
      this.tell({ ops });
    });
  }

  /** The workspace as an agent sees it (§8.2): the verbs, its changes
   * credited to `actor` ("agent:<name>"), and none of what only a person
   * does (dropVersions, forget). */
  forAgent(actor: string) {
    if (!/^agent:[\w.-]{1,64}$/.test(actor)) throw new WorkspaceError("invalid", "an agent is agent:<name>");
    const as: Workspace = Object.create(this);
    as.actor = actor;
    const verbs = ["list", "stat", "read", "write", "create", "mkdir", "rename", "duplicate", "remove", "restore", "history", "version", "watch", "ops"] as const;
    const bound: Record<string, unknown> = Object.fromEntries(verbs.map((v) => [v, (as as any)[v].bind(as)]));
    // (an agent writes with base only: a board's tag says which page session wrote it, and isn't an agent's to claim)
    bound.write = (p: string, content: unknown, opts: { base?: number } = {}) => as.write(p, content, opts?.base !== undefined ? { base: opts.base } : {});
    return Object.freeze(bound) as Pick<Workspace, (typeof verbs)[number]>;
  }

  // ------------------------------------------------------------ inside

  /** `bytes`, what the data file `e` had, kept as its version (§2.5), and
   * the oldest versions dropped past the bounds (never this one): the
   * file's latest maxVersions, none older than maxVersionAgeMs, all of them
   * within maxVersionBytes.  Bytes that can't be kept are an error. */
  async keepVersion(e: Entry, bytes: Uint8Array) {
    const v = await this.versionOf(e, bytes);
    if (!v) return;
    try {
      await inTx(this.ws, VERSION_STORES, "readwrite", (tx) => this.putVersion(tx, v, bytes));
    } catch (err) {
      if (err instanceof WorkspaceError) throw err;
      throw new WorkspaceError("storage", `${e.path}'s present bytes couldn't be kept as a version (${(err as Error)?.name ?? err}), so it isn't written over`);
    }
  }
  /** The record of `bytes` kept as `e`'s version (hashed here, before any transaction), or null for a file with no id. */
  private async versionOf(e: Entry, bytes: Uint8Array): Promise<Version | null> {
    const fid = e.fid;
    if (!fid) return null;
    if (bytes.length > this.limits.maxVersionBytes) throw new WorkspaceError("limit", `${e.path}'s present bytes are too large to keep as a version, so it isn't written over`);
    return { fid, t: this.now(), size: bytes.length, sha256: await bytesHash(bytes), by: this.actor, device: this.device };
  }
  /** The version `v` (its `bytes`) kept in `tx` (with VERSION_STORES), and the oldest dropped past the bounds. */
  private async putVersion(tx: IDBTransaction, v: Version, bytes: Uint8Array) {
    const { fid, t } = v;
    const vs = tx.objectStore("versions"), vb = tx.objectStore("versionBytes"), meta = tx.objectStore("meta");
    const id = (await req(vs.add(v))) as number;
    vb.put(bytes, id);
    let total = ((await req(meta.get("versionBytes"))) as number | undefined ?? 0) + bytes.length;
    const drop = (v: Version) => { vs.delete(v.id!); vb.delete(v.id!); total -= v.size; };
    // (this file's others, oldest first, by the order they were kept (the
    // ids count up; a clock set back doesn't reorder them): past the
    // count left beside the one just kept, or past the age.  The one just
    // kept is counted apart, so the count is always right: CORR-BEF-1)
    const others = ((await req(vs.index("byFile").getAll(IDBKeyRange.bound([fid, -Infinity], [fid, Infinity])))) as Version[]).filter((v) => v.id !== id).sort((x, y) => x.id! - y.id!);
    const room = Math.max(0, this.limits.maxVersions - 1);
    others.forEach((v, i) => { if (i < others.length - room || v.t < t - this.limits.maxVersionAgeMs) drop(v); });
    // (everyone's, oldest first, past the bytes; deletes made above are already out of this read)
    if (total > this.limits.maxVersionBytes) {
      const old: Version[] = await req(vs.getAll());
      for (const v of old) {
        if (total <= this.limits.maxVersionBytes) break;
        if (v.id === id) continue;
        drop(v);
      }
    }
    meta.put(Math.max(0, total), "versionBytes");
  }

  /** `f` holding the workspace's lock, as locked(), for a change to `p`: if it would read values kept
   * the old way (`p`, or anything under it, a data file not yet moved), with a reservation of LEGACY_MAX ×
   * COPIES taken before the lock, never while holding it (LIMIT-CAP1A-1).  The lock is asked for at once,
   * so changes keep the order they were asked for; only one that finds such a file, holding no
   * reservation, gives the lock back unchanged, reserves, and asks again. */
  private async lockedFor<T>(p: string, f: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    let release: (() => void) | null = null, held = 0;
    try {
      for (;;) {
        let need = 0;
        const out = await this.locked(async () => {
          need = await this.readsUnder(p);
          if (need > held) return undefined as T;
          return f();
        }, signal);
        if (need <= held) return out;
        release?.();
        release = await reserve(need);
        held = need;
      }
    } finally {
      release?.();
    }
  }
  /** What a change to `p` may read whole, to reserve before the lock: a data file's bytes still kept the old
   * way at or under it (moved first: LEGACY_MAX × COPIES), else `p` itself a data file whose SHA-256 isn't
   * kept yet (hashed first, so that its op carries it: its size × COPIES, astra's CORR-9C2-2); else 0. */
  private async readsUnder(p: string): Promise<number> {
    if (await this.oldWayUnder(p)) return LEGACY_MAX * COPIES;
    let q: string;
    try { q = path(p); } catch { return 0; }
    const top: Entry | undefined = await inTx(this.ws, "entries", "readonly", (tx) => req(tx.objectStore("entries").get(q)));
    return top && needsHash(top) ? (top.size ?? 0) * COPIES : 0;
  }
  /** Whether `p` or anything under it is a data file whose bytes are still kept the old way. */
  private async oldWayUnder(p: string): Promise<boolean> {
    let q: string;
    try { q = path(p); } catch { return false; }
    const all: Entry[] = await inTx(this.ws, "entries", "readonly", async (tx) => {
      const st = tx.objectStore("entries"), top: Entry | undefined = await req(st.get(q));
      if (!top) return [];
      return top.kind === "folder" ? [top, ...((await req(st.getAll(subtree(q)))) as Entry[])] : [top];
    });
    return all.some((e) => e.kind === "file" && !e.migrated && !e.unmoved && e.ref !== null);
  }

  /** `f` holding the workspace's lock: one change at a time in all of this
   * browser's tabs.  Without Web Locks there is no such lock, and changes
   * that span the two databases could interleave and undo each other's
   * bytes, so none are made (CORR-4A0-5): a WorkspaceError("storage").
   * With `signal`: aborted before the lock is held, `f` never runs, now or
   * later, and this rejects (an AbortError); once held, it runs to its end
   * (daybreak2's LIMIT-59D-1). */
  async locked<T>(f: () => Promise<T>, signal?: AbortSignal, how: { internal?: boolean; publish?: boolean; ifAvailable?: boolean } = {}): Promise<T> {
    const locks = (globalThis.navigator as any)?.locks;
    if (!locks || typeof locks.request !== "function") throw new WorkspaceError("storage", "this browser has no Web Locks, which changes to the workspace need: nothing was changed");
    this.open();
    if (!how.internal) this.unquarantined();
    const g = async () => {
      this.open();
      if (!how.internal) {
        this.unquarantined();
        await this.sameIdentity(true);
      }
      const out = await f();
      // (the witness brought up to the commit, in the same hold: design/workspace-durability.md A.1)
      if (!how.internal || how.publish) await this.publish().catch(() => {});
      return out;
    };
    // (ifAvailable: run only if the lock is free now; else nothing runs, and this resolves to undefined)
    if (how.ifAvailable) return locks.request(LOCK, { ifAvailable: true }, (lock: unknown) => (lock ? g() : undefined));
    return signal ? locks.request(LOCK, { signal }, g) : locks.request(LOCK, g);
  }
  // (quarantined: every change refused until the person decides, A.3)
  private unquarantined() {
    if (this.quarantined) throw new WorkspaceError("quarantined", `this browser's copy of your workspace was lost or is missing changes (${(this.durability as any).why}): nothing can be changed until you decide what to do`);
  }
  // (a tab opened before a reset elsewhere: its workspace is no longer this one, by id or generation, A.1)
  private async sameIdentity(quarantineToo = false) {
    const { identity: id, kept } = await this.metaState();
    if (id && (id.workspace !== this.identity.workspace || id.generation !== this.identity.generation)) {
      this.closedElsewhere();
      throw new WorkspaceError("storage", "this workspace was reset in another tab: reload this page to use it");
    }
    // (a reset under way in another tab, stopped part way: nothing written until an open finishes it)
    if (quarantineToo && (await this.metaState()).resetting) throw new WorkspaceError("quarantined", "this workspace is being reset: reload this page");
    // (quarantined by another tab since this one opened: refused from now on, astra's probe on 2a4e53a8)
    if (quarantineToo && kept) {
      this.adoptQuarantine(kept);
      this.unquarantined();
    }
  }

  async mustStat(p: string): Promise<Entry> {
    const e = await this.stat(p);
    if (!e) throw new WorkspaceError("missing", `${path(p)} isn't in this workspace`);
    return e;
  }

  /** An entry's contents: a notebook's record, a board's record, a data file's bytes; undefined if not there. */
  async contents(e: Entry): Promise<any> {
    if (e.kind === "notebook") return this.mainTx("notebooks", "readonly", (st) => st.get(e.ref!));
    if (e.kind === "board") return inTx(this.ws, "boards", "readonly", (tx) => req(tx.objectStore("boards").get(e.ref!)));
    if (e.kind === "file") {
      if (e.migrated) return inTx(this.ws, "fileBytes", "readonly", (tx) => req(tx.objectStore("fileBytes").get(e.fid!)));
      const old = await this.legacyBytes(e);
      if (old !== undefined) return old;
      // (moved meanwhile by another tab, its old copy deleted: read where it is now; a file is never
      // unreadable because it is being moved)
      const now = await this.stat(e.path);
      if (now?.migrated && now.fid !== undefined && (e.fid === undefined || now.fid === e.fid)) return inTx(this.ws, "fileBytes", "readonly", (tx) => req(tx.objectStore("fileBytes").get(now.fid!)));
      return undefined;
    }
    return undefined;
  }
  /** A data file's bytes where they were kept before fileBytes: "sagebrush"/files, or in Trash, trash. */
  private async legacyBytes(e: Entry): Promise<Uint8Array | undefined> {
    if (e.ref === null) return undefined;
    if (e.trashed || within(e.path, TRASH)) return inTx(this.ws, "trash", "readonly", (tx) => req(tx.objectStore("trash").get(e.ref!)));
    if (!this.main) return undefined;
    return this.mainTx("files", "readonly", (st) => st.get(e.ref!));
  }

  /** An entry made before it would have had them given its identities (the migrator, holding the lock): a
   * folder its fid, any entry its nkey; only if it is still that entry (its path, kind and when it was
   * made).  True if anything was given. */
  async fillIdentity(e: Pick<Entry, "path" | "kind" | "created">): Promise<boolean> {
    return inTx(this.ws, "entries", "readwrite", async (tx) => {
      const st = tx.objectStore("entries"), cur: Entry | undefined = await req(st.get(e.path));
      if (!cur || cur.kind !== e.kind || cur.created !== e.created) return false;
      const fid = cur.kind === "folder" && !cur.fid, nk = cur.nkey !== nkeyOf(cur.path);
      const n: Entry = { ...cur, ...(fid ? { fid: hex(8) } : {}), nkey: nkeyOf(cur.path) };
      // (its identity as the index byIdent's key: design/sync-client.md §3a)
      const ident = identOf(n);
      if (!fid && !nk && n.ident === ident) return false;
      if (ident) n.ident = ident;
      st.put(n);
      return true;
    });
  }

  /** Its SHA-256 kept (fillHash), holding the lock (and, taken before it, a reservation of its size ×
   * COPIES: its bytes are read whole, and hashing copies them): read from fileBytes, hashed, then put on its
   * entry only if it is still the file read (path, fid, revision) with no hash yet, its size set from the
   * bytes.  The reservation trusts the entry's size: this API writes the true one with the bytes, in the same
   * transaction; a record changed by other means is outside that (its bytes are read and hashed all the
   * same, past the reservation, once, and its size corrected; daybreak2).  Returns whether it was. */
  async fillHash(e: Entry): Promise<boolean> {
    if (!needsHash(e)) return false;
    const bytes: Uint8Array | undefined = await inTx(this.ws, "fileBytes", "readonly", (tx) => req(tx.objectStore("fileBytes").get(e.fid!)));
    if (bytes === undefined) return false;
    const sha256 = await bytesHash(bytes);
    return inTx(this.ws, "entries", "readwrite", async (tx) => {
      const st = tx.objectStore("entries"), cur: Entry | undefined = await req(st.get(e.path));
      if (!cur || !needsHash(cur) || cur.fid !== e.fid || (cur.rev ?? 0) !== (e.rev ?? 0)) return false;
      st.put({ ...cur, sha256, size: bytes.byteLength });
      return true;
    });
  }

  /** A data file's bytes moved into fileBytes (design/capabilities.md §2b),
   * holding the lock (and, taken before it, a reservation of LEGACY_MAX ×
   * COPIES: a value kept the old way has no size until it is read,
   * LIMIT-CAP1A-1).  Read where they are; then in one transaction of the
   * workspace's database, put under the file's fid, its entry marked
   * `migrated` with the size and SHA-256 of the bytes read (the index's
   * size corrected by them), and the old copy marked stale (its size and
   * SHA-256), only if the entry is still the one read (path, ref, fid,
   * revision).  Then the old copy deleted if it is still those bytes
   * (dropStale).  Bytes larger than `max` aren't moved: the entry says so
   * (`unmoved`), with their size, and isn't read for this again.  A file
   * whose bytes aren't there, or that changed meanwhile, is left as it is.
   * Returns the entry as it is now. */
  async migrateOne(e: Entry, max = LEGACY_MAX): Promise<Entry> {
    if (e.kind !== "file" || e.migrated || e.unmoved || e.ref === null) return e;
    const same = (cur: Entry | undefined) => !!cur && cur.kind === "file" && !cur.migrated && cur.ref === e.ref && cur.fid === e.fid && (cur.rev ?? 0) === (e.rev ?? 0);
    const mark = async (size: number) => (await inTx(this.ws, "entries", "readwrite", async (tx) => {
      const st = tx.objectStore("entries"), cur: Entry | undefined = await req(st.get(e.path));
      if (!same(cur)) return cur;
      const n: Entry = { ...cur!, size, unmoved: "too large to move" };
      st.put(n);
      return n;
    })) ?? e;
    // (its index already says it is larger than the bound: marked without reading it (daybreak2). Only an
    // index that says less than the bytes are costs a read past the reservation, once: IndexedDB gives no
    // value's length without materializing it, so that case can't be found any earlier)
    if (typeof e.size === "number" && Number.isFinite(e.size) && e.size > max) return mark(e.size);
    const old = await this.legacyBytes(e);
    if (old === undefined) return e;
    if (old.byteLength > max) return mark(old.byteLength);
    const fid = e.fid ?? hex(8), sha256 = await bytesHash(old);
    const where = e.trashed || within(e.path, TRASH) ? "trash" : "files", key = e.ref;
    const now: Entry | undefined = await inTx(this.ws, ["entries", "fileBytes", "meta"], "readwrite", async (tx) => {
      const st = tx.objectStore("entries"), cur: Entry | undefined = await req(st.get(e.path));
      if (!same(cur)) return cur;
      tx.objectStore("fileBytes").put(old, fid);
      tx.objectStore("meta").put({ fid, size: old.byteLength, sha256 } satisfies StaleMark, staleKey(where, key));
      const n: Entry = { ...cur!, fid, ident: fid, migrated: true, size: old.byteLength, sha256 };
      delete n.missing;
      st.put(n);
      return n;
    });
    if (now?.migrated && now.fid === fid) await this.dropStale(where, key, old).catch(() => {});
    return now ?? e;
  }
  /** (tests: awaited between a stale copy's comparison and its deletion) */
  beforeStaleDelete: (() => Promise<void> | void) | null = null;
  /** An old copy left by migrateOne (hold the lock, and a reservation of
   * LEGACY_MAX × COPIES: its bytes are read): deleted only if its bytes are
   * still the ones moved, the last comparison made in the deletion's own
   * transaction, so a page still running the code from before can't have
   * written there in between (CORR-F81-1).  Bytes written there since are
   * kept, as "<name> (from an older tab)" beside where they are; then the
   * mark goes.  `moved`: the bytes just moved, if the caller has them. */
  async dropStale(where: "files" | "trash", key: string, moved?: Uint8Array) {
    const mk = staleKey(where, key);
    const mark = (await inTx(this.ws, "meta", "readonly", (tx) => req(tx.objectStore("meta").get(mk)))) as StaleMark | undefined;
    if (mark === undefined) return;
    const forget = () => inTx(this.ws, "meta", "readwrite", async (tx) => { tx.objectStore("meta").delete(mk); });
    let seen = moved;
    if (!seen) {
      const cur = await this.readOld(where, key);
      if (cur === undefined) return forget();
      if (typeof mark !== "object" || cur.byteLength !== mark.size || (await bytesHash(cur)) !== mark.sha256) return this.keepOld(where, key, cur);
      seen = cur;
    }
    await this.beforeStaleDelete?.();
    const gone = await this.oldTx(where, "readwrite", async (st) => {
      const v = await req(st.get(key));
      if (v === undefined) return true;
      if (!sameBytes(bytesOf(v), seen!)) return false;
      st.delete(key);
      return true;
    });
    if (gone) return forget();
    const cur = await this.readOld(where, key);
    return cur === undefined ? forget() : this.keepOld(where, key, cur);
  }
  // (bytes written at a stale key since the move: a file of their own, its mark dropped with its entry; in
  // trash (where no page writes) the mark alone goes, and reconcile recovers them to /Recovered)
  private async keepOld(where: "files" | "trash", key: string, bytes: Uint8Array) {
    const mk = staleKey(where, key);
    if (where === "trash" || !isPath(key)) return void (await inTx(this.ws, "meta", "readwrite", async (tx) => { tx.objectStore("meta").delete(mk); }));
    const [base, ext] = splitExt(nameOf(key));
    await this.adopt(parentOf(key), base + " (from an older tab)", ext, { kind: "file", ref: key, size: bytes.byteLength, rev: 0 }, { dropMeta: [mk] });
  }
  private async readOld(where: "files" | "trash", key: string): Promise<Uint8Array | undefined> {
    return this.oldTx(where, "readonly", (st) => req(st.get(key))) as Promise<Uint8Array | undefined>;
  }
  private async oldTx<T>(where: "files" | "trash", mode: IDBTransactionMode, f: (st: IDBObjectStore) => Promise<T>): Promise<T> {
    if (where === "trash") return inTx(this.ws, "trash", mode, (tx) => f(tx.objectStore("trash")));
    if (!this.main) throw new WorkspaceError("storage", "this browser has no storage for files");
    return inTx(this.main, "files", mode, (tx) => f(tx.objectStore("files")));
  }
  /** Old copies not yet deleted (at most `n`): [where, key]. */
  async staleCopies(n = 100): Promise<["files" | "trash", string][]> {
    const keys = (await inTx(this.ws, "meta", "readonly", (tx) => req(tx.objectStore("meta").getAllKeys(IDBKeyRange.bound(STALE, STALE + "\uffff"), Number.isFinite(n) ? n : undefined)))) as string[];
    return keys.map((k) => { const rest = k.slice(STALE.length), i = rest.indexOf(":"); return [rest.slice(0, i) as "files" | "trash", rest.slice(i + 1)]; });
  }
  /** Whether `key` in "sagebrush"/files (or trash) is a migrated file's old copy, not yet deleted. */
  async isStale(where: "files" | "trash", key: string): Promise<boolean> {
    return (await inTx(this.ws, "meta", "readonly", (tx) => req(tx.objectStore("meta").getKey(staleKey(where, key))))) !== undefined;
  }

  /** Every data file not in Trash, with its bytes (where they are): what a notebook's interpreter is given when it starts. */
  async dataFiles(): Promise<[string, Uint8Array][]> {
    const all = (await this.list("/", { recursive: true })).filter((e) => e.kind === "file");
    const out: [string, Uint8Array][] = [];
    for (const e of all) {
      const b = await this.contents(e).catch(() => undefined);
      if (b !== undefined) out.push([e.path, b]);
    }
    return out;
  }

  /** One request on "sagebrush" (notebooks, files), or a WorkspaceError("storage") where there is none. */
  async mainTx<T>(store: string, mode: IDBTransactionMode, f: (st: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    if (!this.main) throw new WorkspaceError("storage", "this browser has no storage for notebooks and files");
    return inTx(this.main, store, mode, (tx) => req(f(tx.objectStore(store))));
  }

  private checkBoard(doc: unknown) {
    if (!isBoard(doc)) throw new WorkspaceError("invalid", "not a board");
    if (JSON.stringify(doc).length > this.limits.maxBoardBytes) throw new WorkspaceError("limit", `a board is at most ${this.limits.maxBoardBytes} characters of JSON`);
  }

  /** The contents written, then the entry; the contents taken back if the entry can't be. */
  async make(q: string, kind: Exclude<Kind, "folder">, content: unknown, mode?: string, origin?: string, made?: Entry["made"]): Promise<Entry> {
    if (await this.stat(q)) throw new WorkspaceError("exists", `${q} is there already`);
    const t = this.now();
    let ref: string, size: number | undefined, undo: () => Promise<unknown>, fileBytes: Uint8Array | undefined, sha256: string | undefined;
    if (kind === "notebook") {
      if (!this.main) throw new WorkspaceError("storage", "this browser has no storage for notebooks");
      const given = (content ?? {}) as any;
      if (typeof given !== "object" || (given.cells !== undefined && !Array.isArray(given.cells))) throw new WorkspaceError("invalid", "a notebook is {cells: [...]}");
      const { id: _i, rev: _r, updated: _u, baseRev: _b, ...doc } = given;
      ref = crypto.randomUUID();
      mode = mode ?? doc.mode ?? "python";
      const out = await new IdbStore(this.main, ref).save({ ...doc, cells: doc.cells ?? [], mode, name: splitExt(nameOf(q))[0], id: ref }, { lockHeld: true });
      if (typeof out === "string") throw new WorkspaceError("storage", out);
      undo = () => this.mainTx("notebooks", "readwrite", (st) => st.delete(ref));
    } else if (kind === "board") {
      const doc = content ?? { title: splitExt(nameOf(q))[0], ...(mode && mode !== "python" ? { mode } : {}), nodes: [] };
      this.checkBoard(doc);
      mode = mode ?? (doc as any).mode ?? "python";
      ref = await inTx(this.ws, "boards", "readwrite", async (tx) => {
        const st = tx.objectStore("boards");
        for (;;) {
          const id = hex(6);
          if ((await req(st.getKey(id))) === undefined) {
            st.add({ id, doc, rev: 1, updated: t, ...(origin ? { origin } : {}) } satisfies BoardRecord);
            return id;
          }
        }
      });
      undo = () => inTx(this.ws, "boards", "readwrite", async (tx) => tx.objectStore("boards").delete(ref));
    } else {
      const b = bytesOf(content ?? new Uint8Array(0));
      if (b.length > this.limits.maxFileBytes) throw new WorkspaceError("limit", `a file is at most ${this.limits.maxFileBytes} bytes`);
      // (bytes kept at that path the old way, with no entry, are someone's: not hidden by a new file there
      // (reconcile lists them), unless they are a migrated file's old copy)
      if (this.main && (await this.mainTx("files", "readonly", (st) => st.getKey(q))) !== undefined && !(await this.isStale("files", q))) throw new WorkspaceError("exists", `${q} is there already (as a file not yet listed)`);
      ref = q;
      size = b.length;
      fileBytes = b;
      sha256 = await bytesHash(b);
      undo = async () => {};
    }
    const ops: Op[] = [];
    try {
      const fid = kind === "file" ? hex(8) : undefined;
      const entry = await inTx(this.ws, ["entries", "ops", ...(fileBytes ? ["fileBytes"] : [])], "readwrite", async (tx) => {
        const st = tx.objectStore("entries");
        if ((await req(st.getKey(q))) !== undefined) throw new WorkspaceError("exists", `${q} is there already`);
        await this.folders(tx, parentOf(q), ops);
        await this.lookalike(st, q);
        await this.room(st, q);
        // (a data file's bytes with its entry, in this one transaction)
        if (fileBytes) tx.objectStore("fileBytes").put(fileBytes, fid!);
        const e: Entry = { path: q, kind, ref, created: t, updated: t, ...(mode ? { mode } : {}), ...(kind === "file" ? { size, rev: 0, fid, migrated: true, ...(sha256 ? { sha256 } : {}) } : {}), ...(origin ? { origin } : {}), ...(kind !== "file" && made ? { made } : {}), nkey: nkeyOf(q) };
        const ident = identOf(e);
        if (ident) e.ident = ident;
        st.put(e);
        await this.log(tx, ops, { op: "create", path: q, kind }, e);
        return e;
      });
      this.tell({ ops });
      return entry;
    } catch (e) {
      await undo().catch(() => {});
      throw e;
    }
  }

  /** An entry for contents that are already kept (migration, reconcile):
   * at `base + ext` in `folder`, or the first free `base (2) + ext`, …
   * Hold the lock (locked()) around it. */
  async adopt(folder: string, base: string, ext: string, fields: Omit<Entry, "path" | "created" | "updated"> & { created?: number; updated?: number }, also: { at?: string; board?: BoardRecord; meta?: [string, unknown][]; dropMeta?: string[]; dropTrash?: string[] } = {}): Promise<Entry> {
    // (with the entry, in its transaction: a board's record, records put in
    // or dropped from meta, bytes dropped from trash; all of it, or none)
    const ops: Op[] = [];
    // (a data file whose bytes are kept the old way: the migration, if it was done, has one more to
    // move, so it starts again (its state dropped with this entry, in this transaction: capabilities §2b))
    const oldWay = fields.kind === "file" && !fields.migrated && fields.ref !== null;
    const stores = ["entries", "ops", ...(also.board ? ["boards"] : []), ...(also.meta?.length || also.dropMeta?.length || oldWay ? ["meta"] : []), ...(also.dropTrash?.length ? ["trash"] : [])];
    const entry = await inTx(this.ws, stores, "readwrite", async (tx) => {
      const st = tx.objectStore("entries");
      const taken = new Set((await req(st.getAllKeys(subtree(folder)))) as string[]);
      const p = also.at ?? freePath(folder, base, ext, (x) => taken.has(x));
      if (!p) throw new WorkspaceError("limit", `no free name in ${folder}`);
      if (also.at && (await req(st.getKey(also.at))) !== undefined) throw new WorkspaceError("exists", `${also.at} is there already`);
      if (also.board) tx.objectStore("boards").put(also.board);
      for (const [k, v] of also.meta ?? []) tx.objectStore("meta").put(v, k);
      for (const k of also.dropMeta ?? []) tx.objectStore("meta").delete(k);
      for (const k of also.dropTrash ?? []) tx.objectStore("trash").delete(k);
      if (oldWay) tx.objectStore("meta").delete("migration");
      await this.folders(tx, parentOf(p), ops);
      await this.room(st, p);
      const t = this.now();
      const e: Entry = { created: t, updated: t, ...fields, ...(fields.kind === "file" && !fields.fid ? { fid: hex(8) } : {}), ...(fields.kind === "folder" && !fields.fid ? { fid: hex(8) } : {}), path: p, nkey: nkeyOf(p) };
      const ident = identOf(e);
      if (ident) e.ident = ident;
      st.put(e);
      await this.log(tx, ops, { op: "adopt", path: p, kind: e.kind }, e);
      return e;
    });
    this.tell({ ops });
    return entry;
  }

  /** The folders `folder` and those above it, made where missing (in `tx`); a file in the way is an error. */
  private async folders(tx: IDBTransaction, folder: string, ops: Op[]) {
    const st = tx.objectStore("entries");
    const names = folder === "/" ? [] : folder.slice(1).split("/");
    let at = "";
    for (const n of names) {
      at += "/" + n;
      const e: Entry | undefined = await req(st.get(at));
      if (e && e.kind !== "folder") throw new WorkspaceError("exists", `${at} is a ${e.kind}, not a folder`);
      if (!e) {
        await this.lookalike(st, at);
        await this.room(st, at);
        const t = this.now();
        // (its own id, never reused: a folder made again is a new one, which no grant of the old names)
        const fid = hex(8), f: Entry = { path: at, kind: "folder", ref: null, created: t, updated: t, fid, ident: fid, nkey: nkeyOf(at) };
        st.put(f);
        await this.log(tx, ops, { op: "mkdir", path: at, kind: "folder" }, f);
      }
    }
  }

  /** `p` refused when a name in its folder looks the same but isn't (the same NFC form, different
   * characters: design/capabilities.md §3, CORR-CAP-3).  Names are kept exactly; this only stops a new
   * lookalike.  A name all ASCII has none, so is let through without looking at its folder. */
  private async lookalike(st: IDBObjectStore, p: string) {
    // (one bounded lookup by the index: at most two keys, whatever the folder holds; every name, ASCII
    // included, as U+212A KELVIN SIGN is "K" in NFC: CORR-9A3-1, LIMIT-CAP1B-1)
    const others = ((await req(st.index("byNfc").getAllKeys(IDBKeyRange.only(nkeyOf(p)), 2))) as string[]).filter((k) => k !== p);
    if (others.length) throw new WorkspaceError("exists", `"${nameOf(others[0])}" is already in ${parentOf(p)}, and looks the same as "${nameOf(p)}": choose another name`);
  }

  /** Room for one more entry, `p`: in the workspace (maxEntries) and in its
   * folder (maxFolderEntries direct entries, §6.3: LIMIT-094-1).  A folder's
   * own entries are counted only when everything under it comes near the
   * bound, so the usual case costs two counts. */
  private async room(st: IDBObjectStore, p: string) {
    const total = await req(st.count());
    if (total + 1 > this.limits.maxEntries) throw new WorkspaceError("limit", `a workspace holds at most ${this.limits.maxEntries} entries`);
    await this.folderRoom(st, parentOf(p), total);
  }

  private async folderRoom(st: IDBObjectStore, folder: string, total?: number) {
    const max = this.limits.maxFolderEntries;
    const under = folder === "/" ? (total ?? (await req(st.count()))) : await req(st.count(subtree(folder)));
    if (under + 1 <= max) return;
    const keys = (await req(st.getAllKeys(subtree(folder)))) as string[];
    const direct = keys.filter((k) => k.indexOf("/", folder === "/" ? 1 : folder.length + 1) === -1).length;
    if (direct + 1 > max) throw new WorkspaceError("limit", `a folder holds at most ${max} entries: ${folder} is full`);
  }

  /** The op recorded in `tx`, with its identity (design/sync-client.md §3): `now`, the entry as the op left it
   * (null: the op removed `gone`; undefined: it changed no entry), and, on a data file's write, `base`, the
   * SHA-256 it replaced.  Its parent folder read in `tx`: one lookup. */
  private async log(tx: IDBTransaction, ops: Op[], op: Omit<Op, "t" | "device" | "by">, now?: Entry | null, gone?: Entry, base?: string) {
    // (Trash's own folder is the workspace's, not something synced: no identity, as the root has none)
    const e = (now ?? gone)?.path === TRASH ? undefined : now ?? gone, id: Partial<Op> = {};
    if (e) {
      if (e.kind === "file" || e.kind === "folder") { if (e.fid) id.fid = e.fid; }
      else if (e.ref !== null) id.ref = e.ref;
      if (now && now.kind === "file") {
        if (now.sha256) id.sha256 = now.sha256;
        if (now.size !== undefined) id.size = now.size;
        if (base) id.base = base;
      }
    }
    if (now && e) {
      const after = await this.afterOf(tx.objectStore("entries"), now);
      if (after) {
        id.after = after;
        // (an op whose result is in a folder is one that put it there: create, adopt, mkdir, write, rename,
        // restore; one in Trash has no folder here (after.parent null), and nothing is written or made in Trash)
        if (after.parent !== null) id.parent = after.parent;
      }
    } else if (now === null && e && identOf(e)) id.after = null;
    const rec: Op = { ...op, ...id, t: this.now(), device: this.device, by: this.actor };
    tx.objectStore("ops").add(rec);
    ops.push(rec);
  }

  /** What an op left of `e` (OpAfter), read in `st`'s transaction; undefined when it, or the folder it is in,
   * has no identity yet (the migrator gives them). */
  private async afterOf(st: IDBObjectStore, e: Entry): Promise<OpAfter | undefined> {
    const id = identOf(e);
    if (!id) return undefined;
    // (a data file whose SHA-256 isn't known: its bytes still kept the old way (adopted from there), so
    // nothing it left is said, as for an identity not yet given; its hash comes when the migrator moves it.
    // Every other path to an op fills the hash first: create and write compute it, a move hashes a file
    // written before (astra's CORR-9C2-2))
    if (e.kind === "file" && !e.sha256) return undefined;
    const folder = parentOf(e.path);
    let parent: string | null = null;
    if (!e.trashed && folder !== "/" && folder !== TRASH) {
      const f: Entry | undefined = await req(st.get(folder));
      if (!f?.fid) return undefined;
      parent = f.fid;
    }
    return { id, parent, name: nameOf(e.path), kind: e.kind, ...(e.kind === "file" ? { ...(e.sha256 ? { sha256: e.sha256 } : {}), ...(e.size !== undefined ? { size: e.size } : {}) } : {}), trashed: !!e.trashed };
  }

  /** `a` and everything under it moved to `b` (free).  Its data files are
   * migrated first (migrateOne, one at a time: their bytes in fileBytes, by
   * their own ids, which a move keeps), so the move itself is one
   * transaction of the index: every entry moves, or none does
   * (design/capabilities.md §2a).  A data file whose bytes aren't there
   * moves alone, as before. */
  private async move(a: string, b: string, op: "rename" | "remove" | "restore", trashed?: Entry["trashed"] | null): Promise<Entry[]> {
    const t = this.now();
    const read = async () => inTx(this.ws, "entries", "readonly", async (tx) => {
      const st = tx.objectStore("entries"), top: Entry | undefined = await req(st.get(a));
      if (!top) throw new WorkspaceError("missing", `${a} isn't in this workspace`);
      return top.kind === "folder" ? [top, ...((await req(st.getAll(subtree(a)))) as Entry[])] : [top];
    });
    const to = (p: string) => b + p.slice(a.length);
    // (every new path a path the workspace takes, before anything moves: CORR-4A0-4)
    for (const e of await read()) {
      try { normPath(to(e.path)); } catch (err) { throw new WorkspaceError("invalid", `moving ${a} to ${b} would make ${to(e.path).slice(0, 80)}…: ${(err as Error).message}`); }
    }
    // (bytes kept the old way at a new path, with no entry, are someone's: not hidden behind a moved file;
    // nothing moves (a migrated file's own old copy aside))
    if (this.main) for (const e of await read()) {
      if (e.kind !== "file" || within(to(e.path), TRASH)) continue;
      const key = to(e.path);
      if (key !== e.ref && (await this.mainTx("files", "readonly", (st) => st.getKey(key))) !== undefined && !(await this.isStale("files", key))) throw new WorkspaceError("exists", `${key} is there already (as a file not yet listed)`);
    }
    // (its data files' bytes in fileBytes first, one at a time, holding the lock as the caller does)
    for (const e of await read()) if (e.kind === "file" && !e.migrated) await this.migrateOne(e);
    // (a data file moved whose SHA-256 isn't kept yet, written before it was: hashed first, holding the lock
    // (reserved by lockedFor), so that the move's op carries it; ops can't be mended later (astra's
    // CORR-9C2-2).  Only the moved entry's: what is in a moved folder has no op of its own)
    const [top] = await read();
    if (top && needsHash(top)) await this.fillHash(top);
    const old = await read();
    // (a file too large to move beside the index stays where its bytes are, so it isn't moved; nothing is)
    const stuck = old.find((e) => e.kind === "file" && e.unmoved);
    if (stuck) throw new WorkspaceError("limit", tooLarge(stuck));
    const ops: Op[] = [];
    const moved = await inTx(this.ws, ["entries", "ops"], "readwrite", async (tx) => {
      const st = tx.objectStore("entries");
      if ((await req(st.getKey(b))) !== undefined || (await req(st.count(subtree(b)))) > 0) throw new WorkspaceError("exists", `${b} is there already`);
      for (const e of old) {
        const now: Entry | undefined = await req(st.get(e.path));
        if (!now || now.ref !== e.ref || now.fid !== e.fid) throw new WorkspaceError("conflict", `${e.path} changed while it was moved`);
      }
      await this.folders(tx, parentOf(b), ops);
      await this.lookalike(st, b);
      // (one more entry in b's folder, unless it was already there: LIMIT-094-1)
      if (parentOf(a) !== parentOf(b)) await this.folderRoom(st, parentOf(b));
      const out: Entry[] = [];
      for (const e of old) {
        st.delete(e.path);
        const n: Entry = { ...e, path: to(e.path), ...(e.kind === "file" && e.ref !== null ? { ref: to(e.path) } : {}), nkey: nkeyOf(to(e.path)) };
        if (e.path === a) {
          n.updated = t;
          if (trashed) n.trashed = trashed;
          else if (trashed === null) delete n.trashed;
        }
        st.put(n);
        out.push(n);
      }
      await this.log(tx, ops, { op, path: a, to: b, kind: old[0].kind }, out[0]);
      return out;
    });
    this.tell({ ops });
    return moved;
  }

  /** A renamed document whose title was its old name: titled with its new one. */
  private async retitle(e: Entry, was: string) {
    const oldName = splitExt(nameOf(was))[0], newName = splitExt(nameOf(e.path))[0];
    if (oldName === newName) return;
    if (e.kind === "notebook" && this.main) {
      for (let i = 0; i < 5; i++) {
        const rec = await this.contents(e);
        if (!rec || (rec.name ?? "") !== oldName) return;
        const out = await new IdbStore(this.main, e.ref!).save({ ...rec, name: newName, baseRev: rec.rev }, { lockHeld: true });
        if (typeof out === "string" || !out.conflict) return;
      }
    } else if (e.kind === "board") {
      await inTx(this.ws, "boards", "readwrite", async (tx) => {
        const st = tx.objectStore("boards"), rec: BoardRecord | undefined = await req(st.get(e.ref!));
        if (rec && String(rec.doc?.title ?? "") === oldName) st.put({ ...rec, doc: { ...rec.doc, title: newName }, rev: rec.rev + 1, updated: this.now() });
      });
    }
  }

  /** Changes told to this tab's watchers, and (made here) to the other tabs. */
  tell(c: Change, broadcast = true) {
    if (!c.ops.length) return;
    if (broadcast) try { this.channel?.postMessage({ from: this.tab, ops: c.ops }); } catch {}
    for (const f of this.subs) try { f(c); } catch (e) { console.warn("workspace watcher:", e); }
  }
}


