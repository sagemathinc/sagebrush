// Bringing what this browser keeps today into the workspace
// (design/workspace-files.md §2.3), and keeping the index true to the
// contents afterwards (reconcile, §2.2).  Nothing here deletes anything.
//
// migrate(w, localStorage), once per page load:
// - Boards made here, `sagebrush-board:local:<id>` in localStorage, are
//   written to "sagebrush-workspace"/boards under the same id (so their
//   TimeTravel, outputs and pictures stay theirs) and listed as
//   `/<title>.board.json`.  This browser's edits of an example or a board on
//   the web, `sagebrush-board:<address>`, become boards of their own in
//   `/Edited examples/`, which remember the address.  localStorage is only
//   read, never written.  What was brought in is recorded in the workspace's
//   own database (meta, `import:<key>`: the SHA-256s of the documents
//   brought in from that key), in the same transaction as the board and its
//   entry, so a run that stops part way leaves all of one or none of it,
//   and no later run brings the same document in twice (CORR-4A0-2).  A key
//   whose document has changed since (an older tab, or the installed app not
//   yet updated, still writes there) is brought in again, once per change,
//   as `<title> (from an older tab)`: never merged, never written over.  A
//   key that doesn't hold a board is left alone and reported.
// - Then reconcile: notebooks and data files get entries (a notebook at
//   the top as `/<name>.ipynb`, whenever it is found: one made by a page
//   not yet writing through the workspace is an ordinary notebook; a data
//   file at its own path); a board's record or Trash bytes with no entry,
//   whose entry was lost, go to `/Recovered/`; an entry whose contents are
//   gone is marked missing, never removed.
import { inTx, req } from "./db";
import { TRASH, nameOf, normPath, parentOf, safeName, splitExt, within } from "./paths";
import { COPIES, LEGACY_MAX, WorkspaceError, type BoardRecord, type Entry, type OldBytes, type PlainBoardRecord, type Workspace } from "./api";
import { reserve, type Release } from "./reserve";
import { rewriting } from "./sync-rewrite";
import { bytesHash, FENCE } from "../notebook/stores.js";
import { isBoard } from "../board/doc";

/** What migrate reads and writes of localStorage. */
export type KeyValue = { readonly length: number; key(i: number): string | null; getItem(k: string): string | null; setItem(k: string, v: string): void };

const IMPORT = "import:", RECOVERING = "recovering:";
const LOCAL = /^sagebrush-board:local:([0-9a-f]{12})$/;
const EDITED = "sagebrush-board:";
export const RECOVERED = "/Recovered", EDITED_FOLDER = "/Edited examples";
const BOARD_EXT = ".board.json";

/** A document's signature: the SHA-256 of its JSON. */
export const signature = (doc: unknown): Promise<string> => bytesHash(new TextEncoder().encode(JSON.stringify(doc)));

export type MigrateReport = { boards: number; copies: number; unreadable: string[]; notebooks: number; files: number; recovered: number; missing: number; full?: string };

/** Everything of this browser's in the workspace (above); safe to run at every load. */
/** `proceed`: asked once the lock is held; false, and nothing is done (a page that gave up on the workspace meanwhile: LIMIT-12C-3). */
export function migrate(w: Workspace, storage: KeyValue, opts: { proceed?: () => boolean } = {}): Promise<MigrateReport> {
  // (a quarantined workspace is written by nothing, this included, until the person decides: design/workspace-durability.md A.3)
  if (w.quarantined) return Promise.resolve({ boards: 0, copies: 0, unreadable: [], notebooks: 0, files: 0, recovered: 0, missing: 0 });
  const old: OldBytes[] = [];
  return w.locked(async () => {
    if (opts.proceed && !opts.proceed()) return { boards: 0, copies: 0, unreadable: [], notebooks: 0, files: 0, recovered: 0, missing: 0 };
    // (a reset's purge not finished: nothing brought in until it is, in the background; the next migrate brings in what's left)
    // (localStorage's part too: an old board it couldn't yet remove isn't brought into the new workspace: CORR-2A4-3)
    if (await inTx(w.ws, "meta", "readonly", async (tx) => (await req(tx.objectStore("meta").get("purgeMain"))) || (await req(tx.objectStore("meta").get("purgeLocal"))))) { void w.cleanUp(); return { boards: 0, copies: 0, unreadable: [], notebooks: 0, files: 0, recovered: 0, missing: 0 }; }
    const first = (await inTx(w.ws, "meta", "readonly", (tx) => req(tx.objectStore("meta").get("migrated")))) === undefined;
    const r: MigrateReport = { boards: 0, copies: 0, unreadable: [], notebooks: 0, files: 0, recovered: 0, missing: 0 };
    try {
      await migrateBoards(w, storage, r);
      // (not while a large move is being applied (D11 r8 N4): the next migrate reconciles)
      if (!(await rewriting(w.ws))) old.push(...(await reconcile(w, first, r)));
    } catch (e) {
      // (the workspace full: what fitted is in, the rest still where it was, said)
      if (e instanceof WorkspaceError && e.code === "limit") r.full = e.message;
      else throw e;
    }
    if (first) await inTx(w.ws, "meta", "readwrite", async (tx) => { tx.objectStore("meta").put(Date.now(), "migrated"); });
    return r;
  }).then((r) => adoptOld(w, old, r));
}

/** The old-way bytes reconcile found no entry for (`old`), adopted one at a time, each read and hashed holding
 * the lock with its reservation taken first (Workspace.adoptOld: never a data file's op without its hash,
 * astra's CORR-9C2-2; a reservation is never taken holding the lock, LIMIT-CAP1A-1).  Counted in `r`. */
export async function adoptOld(w: Workspace, old: OldBytes[], r: MigrateReport): Promise<MigrateReport> {
  try {
    for (const a of old) {
      if (a.kind !== "trash") {
        if (await w.adoptOld(a)) r[a.count]++;
        continue;
      }
      // (Trash's bytes: their reservation before the lock, as adoptOld's (daybreak2's LIMIT-6B7-1))
      const release = await reserve(LEGACY_MAX * COPIES);
      try {
        await w.locked(() => recoverTrash(w, a.key, r, release));
      } finally {
        release();
      }
    }
  } catch (e) {
    if (e instanceof WorkspaceError && e.code === "limit") r.full = e.message;
    else throw e;
  }
  return r;
}

// (the localStorage keys, as they are now)
function keys(storage: KeyValue): string[] {
  const out: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k !== null) out.push(k);
  }
  return out;
}

async function migrateBoards(w: Workspace, storage: KeyValue, r: MigrateReport) {
  // (when each board made here was last written: the list's records)
  const at = new Map<string, number>();
  try {
    const l = JSON.parse(storage.getItem("sagebrush-boards") ?? "[]");
    if (Array.isArray(l)) for (const b of l) if (b && typeof b.id === "string" && Number.isFinite(b.at)) at.set(b.id, b.at);
  } catch {}
  for (const k of keys(storage)) {
    const local = LOCAL.exec(k);
    let source: string | null = null;
    if (!local) {
      if (!k.startsWith(EDITED) || k.endsWith("#here") || k.endsWith("#outputs")) continue;
      source = k.slice(EDITED.length);
      // (not boards of this browser's: a board that storage refused, an exported file's)
      if (source.startsWith("local:") || source.startsWith("unsaved:") || source.startsWith("embedded:")) continue;
    }
    let doc: any;
    try { doc = JSON.parse(storage.getItem(k) ?? "null"); } catch {}
    if (!isBoard(doc)) {
      r.unreadable.push(k);
      continue;
    }
    const sig = await signature(doc);
    const prov = await inTx(w.ws, "meta", "readonly", (tx) => req(tx.objectStore("meta").get(IMPORT + k)));
    const sigs: string[] = prov && Array.isArray(prov.sigs) ? prov.sigs.filter((x: unknown) => typeof x === "string") : [];
    if (sigs.includes(sig)) continue;
    const title = safeName(doc.title ?? (source ? nameOf("/" + source.split(/[?#]/)[0]) : ""));
    const docIdText = storage.getItem(k + "#outputs");
    const docId = docIdText && /^[0-9a-f]{32}$/.test(docIdText) ? docIdText : undefined;
    const when = (local && at.get(local[1])) || Date.now();
    const mode = typeof doc.mode === "string" ? doc.mode : "python";
    // (the board under its own id the first time, if that id is free; a board of its own otherwise)
    const later = sigs.length > 0;
    let id = local && !later ? local[1] : null;
    if (id !== null && (await inTx(w.ws, "boards", "readonly", (tx) => req(tx.objectStore("boards").getKey(id!)))) !== undefined) id = null;
    id ??= await freeBoardId(w);
    const board: PlainBoardRecord = { id, doc, rev: 1, updated: when, ...(docId && !later ? { docId } : {}), ...(source ? { origin: source } : {}) };
    // (the record of what came from k, kept to the latest 100)
    const record: [string, unknown] = [IMPORT + k, { sigs: [...sigs, sig].slice(-100), id: prov?.id ?? id }];
    await w.adopt(local ? "/" : EDITED_FOLDER, later ? `${title} (from an older tab)` : title, BOARD_EXT,
      { kind: "board", ref: id, mode, ...(source ? { origin: source } : {}), created: when, updated: when }, { board, meta: [record] });
    if (later) r.copies++;
    else r.boards++;
  }
}

/** An id no board has (twelve hex digits, as boards made here have). */
async function freeBoardId(w: Workspace): Promise<string> {
  for (;;) {
    const id = [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, "0")).join("");
    if ((await inTx(w.ws, "boards", "readonly", (tx) => req(tx.objectStore("boards").getKey(id)))) === undefined) return id;
  }
}

/** The index made true to the contents (hold the lock): contents with no
 * entry listed (`first`: notebooks at the top; after that in /Recovered/),
 * entries whose contents are gone marked missing (and unmarked when they
 * are back).  Counts go in `r`. */
export async function reconcile(w: Workspace, first: boolean, r: MigrateReport): Promise<OldBytes[]> {
  const old: OldBytes[] = [];
  const entries: Entry[] = await inTx(w.ws, "entries", "readonly", (tx) => req(tx.objectStore("entries").getAll()));
  const refs = { notebook: new Set<string>(), board: new Set<string>(), file: new Set<string>(), trash: new Set<string>() };
  for (const e of entries) {
    if (e.ref === null) continue;
    if (e.kind === "file" && (e.trashed || within(e.path, TRASH))) refs.trash.add(e.ref);
    else if (e.kind !== "folder") refs[e.kind].add(e.ref);
  }
  // (the workspace's fence is not a notebook)
  const notebookIds = w.main ? ((await w.mainTx("notebooks", "readonly", (st) => st.getAllKeys())) as string[]).filter((k) => k !== FENCE) : [];
  const fileKeys = w.main ? ((await w.mainTx("files", "readonly", (st) => st.getAllKeys())) as string[]) : [];
  const boardIds = (await inTx(w.ws, "boards", "readonly", (tx) => req(tx.objectStore("boards").getAllKeys()))) as string[];
  const trashKeys = (await inTx(w.ws, "trash", "readonly", (tx) => req(tx.objectStore("trash").getAllKeys()))) as string[];
  // (migrated data files' bytes, by fid; and old copies of migrated files not yet deleted, which
  // are nobody's file of their own: never adopted, the migrator deletes them; capabilities §2b)
  const fileBytesIds = new Set((await inTx(w.ws, "fileBytes", "readonly", (tx) => req(tx.objectStore("fileBytes").getAllKeys()))) as string[]);
  const stale = new Set((await w.staleCopies(Infinity)).map(([where, key]) => where + ":" + key));
  // bytes in Trash with no entry (CORR-4A0-1, CORR-094-1): recovered after this pass, each read with its
  // reservation taken before the lock (recoverTrash, through adoptOld: daybreak2's LIMIT-6B7-1).  Where a
  // recovery stopped part way said it would put its bytes (its "recovering:" record) is that recovery's, not a
  // file to adopt here
  const recovering = new Set<string>();
  for (const v of (await inTx(w.ws, "meta", "readonly", (tx) => req(tx.objectStore("meta").getAll(IDBKeyRange.bound(RECOVERING, RECOVERING + "\uffff"))))) as { dest?: unknown }[]) if (typeof v?.dest === "string") recovering.add(v.dest);
  for (const key of trashKeys) {
    if (refs.trash.has(key) || stale.has("trash:" + key)) continue;
    old.push({ kind: "trash", key, folder: RECOVERED, base: "", ext: "", count: "recovered" });
  }
  // notebooks
  for (const id of notebookIds) {
    if (refs.notebook.has(id)) continue;
    const rec = await w.mainTx("notebooks", "readonly", (st) => st.get(id));
    if (!rec) continue;
    // (at the top, always: a notebook with no entry is one a page not yet
    // writing through the workspace made (an older tab, the installed app
    // not yet updated), or made as the workspace opened; not a loss)
    await w.adopt("/", safeName(rec.name), ".ipynb", { kind: "notebook", ref: id, mode: typeof rec.mode === "string" ? rec.mode : "python", created: rec.updated ?? Date.now(), updated: rec.updated ?? Date.now() });
    r.notebooks++;
  }
  // bytes the old way at a moved file's own key, not marked as its old copy (a marked one is compared and
  // deleted, or kept, by dropStale): written there since by a page still running the code from before
  // (its workspace closed by the upgrade, it saves the old way): kept beside it as a file of their own,
  // never lost (capabilities §2b, CORR-F81-1).  Not read here (reconcile holds the lock, and a reservation
  // can't be taken holding it: LIMIT-CAP1A-1): its size comes when the migrator moves it.
  const movedByRef = new Map(entries.filter((e) => e.kind === "file" && e.migrated && e.ref !== null && !e.trashed && !within(e.path, TRASH)).map((e) => [e.ref!, e]));
  // (keys a file not yet moved names: such bytes are that file's, a copy already kept)
  const oldWay = new Set(entries.filter((e) => e.kind === "file" && !e.migrated && e.ref !== null && !e.trashed && !within(e.path, TRASH)).map((e) => e.ref!));
  for (const key of fileKeys) {
    const moved = typeof key === "string" ? movedByRef.get(key) : undefined;
    if (!moved || stale.has("files:" + key) || oldWay.has(key)) continue;
    const [base, ext] = splitExt(nameOf(moved.path));
    // (adopted after, read and hashed with its reservation: adoptOld)
    old.push({ kind: "older", key, folder: parentOf(moved.path), base: base + " (from an older tab)", ext, count: "recovered" });
  }
  // data files: at their own path (what Python's open() names them by), or, a key that isn't a path, in /Recovered/
  for (const key of fileKeys) {
    if (typeof key !== "string" || refs.file.has(key) || stale.has("files:" + key) || recovering.has(key)) continue;
    // (not read here: reconcile holds the lock, where no reservation may be taken (LIMIT-CAP1A-1); adopted
    // after it, by adoptOld, which reserves first, then reads and hashes them, so that the adopt's op carries
    // their hash (astra's CORR-9C2-2))
    let p: string | null = null;
    try { p = normPath(key); } catch {}
    if (p !== null && p !== "/" && !within(p, TRASH)) {
      const [base, ext] = splitExt(nameOf(p));
      old.push({ kind: "free", key, folder: parentOf(p), base, ext, count: "files" });
    } else {
      const [base, ext] = splitExt(safeName(String(key).split("/").pop()));
      old.push({ kind: "free", key, folder: RECOVERED, base, ext, count: "recovered" });
    }
  }
  // boards with no entry
  for (const id of boardIds) {
    if (refs.board.has(id)) continue;
    const rec: BoardRecord | undefined = await inTx(w.ws, "boards", "readonly", (tx) => req(tx.objectStore("boards").get(id)));
    if (!rec) continue;
    await w.adopt(RECOVERED, safeName(rec.doc?.title), BOARD_EXT, { kind: "board", ref: id, mode: rec.doc?.mode ?? "python", ...(rec.origin ? { origin: rec.origin } : {}) });
    r.recovered++;
  }
  // entries whose contents are gone, or back
  const have = { notebook: new Set(notebookIds), board: new Set(boardIds), file: new Set(fileKeys), trash: new Set(trashKeys) };
  for (const e of entries) {
    if (e.kind === "folder") continue;
    if (e.ref === null) {
      // (an entry naming no contents: shown as missing, never dropped)
      if (!e.missing) {
        await inTx(w.ws, "entries", "readwrite", async (tx) => {
          const st = tx.objectStore("entries"), cur: Entry | undefined = await req(st.get(e.path));
          if (cur && cur.ref === null && cur.kind !== "folder") st.put({ ...cur, missing: true });
        });
        r.missing++;
      }
      continue;
    }
    const set = e.kind === "file" && (e.trashed || within(e.path, TRASH)) ? have.trash : have[e.kind];
    const gone = e.kind === "file" && e.migrated ? !fileBytesIds.has(e.fid!) : !set.has(e.ref);
    if (gone === !!e.missing) continue;
    await inTx(w.ws, "entries", "readwrite", async (tx) => {
      const st = tx.objectStore("entries"), cur: Entry | undefined = await req(st.get(e.path));
      if (!cur || cur.ref !== e.ref || !!cur.migrated !== !!e.migrated) return;
      if (gone) st.put({ ...cur, missing: true });
      else {
        const { missing: _m, ...rest } = cur;
        st.put(rest);
      }
    });
    if (gone) r.missing++;
  }
  return old;
}

/** One Trash key's bytes, with no entry, recovered to /Recovered (reconcile collects them; adoptOld calls this
 * holding the lock, its reservation of LEGACY_MAX × COPIES taken before it: daybreak2's LIMIT-6B7-1).  Still
 * nobody's, checked here: no entry in Trash names the key, and it isn't a moved file's marked old copy.  First the
 * destination is recorded (meta "recovering:<trash key>"), then the bytes written there, where Python reads files;
 * then, in one transaction, the entry naming them (the bytes moved beside the index, as any adopt's), the Trash
 * copy dropped and the record dropped.  A run that stops part way leaves the record, and the next run finishes
 * that same recovery: it knows its destination from the record, never from bytes that happen to be equal. */
export async function recoverTrash(w: Workspace, key: string, r: MigrateReport, token: Release) {
  if (await w.isStale("trash", key)) return;
  const naming: Entry[] = await inTx(w.ws, "entries", "readonly", (tx) => req(tx.objectStore("entries").index("byRef").getAll(["file", key])));
  if (naming.some((e) => e.trashed || within(e.path, TRASH))) return;
  // (never more than two copies at once, the reservation's (daybreak2's LIMIT-AC1-1): the Trash bytes hashed and
  // let go; the destination checked (read, hashed, let go); then the Trash bytes read again, and moved only if
  // they are still the ones hashed (else left for the next run))
  const readTrash = () => inTx(w.ws, "trash", "readonly", (tx) => req(tx.objectStore("trash").get(key))) as Promise<Uint8Array | undefined>;
  let first = await readTrash();
  if (first === undefined) return;
  const size = first.byteLength, sha = await bytesHash(first);
  first = undefined;
  const mark = RECOVERING + key;
  const rec = await inTx(w.ws, "meta", "readonly", (tx) => req(tx.objectStore("meta").get(mark)));
  let dest: string | undefined = rec && typeof rec.dest === "string" && rec.sha === sha ? rec.dest : undefined;
  let done = false;
  if (dest !== undefined) {
    const listed: Entry | undefined = await inTx(w.ws, "entries", "readonly", (tx) => req(tx.objectStore("entries").get(dest!)));
    if (listed) {
      // (an entry there: this recovery's only if it says so, written with
      // it in one transaction (its `recovered` names this Trash key and
      // these bytes); anything else, a person's or anyone's, is not, and
      // this recovery goes somewhere new: CORR-DF0-1)
      if (listed.recovered?.from === key && listed.recovered.sha === sha) done = true;
      else dest = undefined;
    } else {
      // (bytes put at the recorded place by someone else since: not ours to write over, so somewhere new)
      const there = await w.mainTx("files", "readonly", (st) => st.get(dest!));
      if (there !== undefined && (await bytesHash(there)) !== sha) dest = undefined;
    }
  }
  if (dest === undefined) {
    const [base, ext] = splitExt(safeName(String(key).split("/").pop()));
    const taken = new Set(((await inTx(w.ws, "entries", "readonly", (tx) => req(tx.objectStore("entries").getAllKeys()))) as string[]));
    const stored = new Set(w.main ? ((await w.mainTx("files", "readonly", (st) => st.getAllKeys())) as string[]) : []);
    for (let i = 1; i <= 10000 && !dest; i++) {
      const p = `${RECOVERED}/${base}${i === 1 ? "" : ` (${i})`}${ext}`;
      if (!taken.has(p) && !stored.has(p)) dest = p;
    }
    if (!dest) throw new WorkspaceError("limit", `no free name in ${RECOVERED}`);
    const d = dest;
    await inTx(w.ws, "meta", "readwrite", async (tx) => { tx.objectStore("meta").put({ dest: d, sha }, mark); });
  }
  const d = dest;
  let bytes = done ? undefined : await readTrash();
  if (!done && (bytes === undefined || bytes.byteLength !== size || (await bytesHash(bytes)) !== sha)) return;
  if (done) {
    // (completed, and proved so by the entry itself; only the Trash copy and the record were left)
    await inTx(w.ws, ["trash", "meta"], "readwrite", async (tx) => { tx.objectStore("trash").delete(key); tx.objectStore("meta").delete(mark); });
  } else {
    await w.mainTx("files", "readwrite", (st) => st.put(bytes!, d));
    const [base, ext] = splitExt(nameOf(d));
    // (the entry, the Trash copy dropped and the record dropped: one transaction; adopt refuses a taken path)
    const box = { bytes: bytes as Uint8Array | undefined };
    bytes = undefined;
    await w.adopt(RECOVERED, base, ext, { kind: "file", ref: d, size, rev: 0, recovered: { from: key, sha } }, { at: d, dropTrash: [key], dropMeta: [mark], bytes: box, token });
  }
  r.recovered++;
}
