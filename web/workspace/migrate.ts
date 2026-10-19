// Bringing what this browser keeps today into the workspace
// (design/workspace-files.md §2.3), and keeping the index true to the
// contents afterwards (reconcile, §2.2).  Nothing here deletes anything.
//
// migrate(w, localStorage), once per page load:
// - Boards made here, `sagebrush-board:local:<id>` in localStorage, are
//   written to "sagebrush-workspace"/boards under the same id (so their
//   TimeTravel, outputs and pictures stay theirs), read back, and listed as
//   `/<title>.board.json`.  This browser's edits of an example or a board on
//   the web, `sagebrush-board:<address>`, become boards of their own in
//   `/Edited examples/`, which remember the address.  The localStorage
//   copies stay as they are; a marker beside each,
//   `sagebrush-workspace-moved:<key>`, says which board it became and what it
//   was then.  A copy changed since (an older tab, or the installed app not
//   yet updated, still writes there) is brought in again, as
//   `<title> (from an older tab)`: never merged, never written over.  A key
//   that doesn't hold a board is left alone and reported.
// - Then reconcile: notebooks and data files get entries (the first time, a
//   notebook at the top as `/<name>.ipynb`, a data file at its own path);
//   contents found with no entry later go to `/Recovered/`; an entry whose
//   contents are gone is marked missing, never removed.
import { inTx, req } from "./db";
import { TRASH, nameOf, normPath, parentOf, safeName, splitExt, within } from "./paths";
import { WorkspaceError, type BoardRecord, type Entry, type Workspace } from "./api";
import { isBoard } from "../board/doc";

/** What migrate reads and writes of localStorage. */
export type KeyValue = { readonly length: number; key(i: number): string | null; getItem(k: string): string | null; setItem(k: string, v: string): void };

export const MOVED = "sagebrush-workspace-moved:";
const LOCAL = /^sagebrush-board:local:([0-9a-f]{12})$/;
const EDITED = "sagebrush-board:";
export const RECOVERED = "/Recovered", EDITED_FOLDER = "/Edited examples";
const BOARD_EXT = ".board.json";

/** A short signature of a text: its length and FNV-1a hash. */
export function signature(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return `${text.length}:${h.toString(16)}`;
}

export type MigrateReport = { boards: number; copies: number; unreadable: string[]; notebooks: number; files: number; recovered: number; missing: number; full?: string };

/** Everything of this browser's in the workspace (above); safe to run at every load. */
export function migrate(w: Workspace, storage: KeyValue): Promise<MigrateReport> {
  return w.locked(async () => {
    const first = (await inTx(w.ws, "meta", "readonly", (tx) => req(tx.objectStore("meta").get("migrated")))) === undefined;
    const r: MigrateReport = { boards: 0, copies: 0, unreadable: [], notebooks: 0, files: 0, recovered: 0, missing: 0 };
    try {
      await migrateBoards(w, storage, r);
      await reconcile(w, first, r);
    } catch (e) {
      // (the workspace full: what fitted is in, the rest still where it was, said)
      if (e instanceof WorkspaceError && e.code === "limit") r.full = e.message;
      else throw e;
    }
    if (first) await inTx(w.ws, "meta", "readwrite", async (tx) => { tx.objectStore("meta").put(Date.now(), "migrated"); });
    return r;
  });
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
    const text = storage.getItem(k);
    let doc: any;
    try { doc = JSON.parse(text ?? "null"); } catch {}
    if (!isBoard(doc)) {
      r.unreadable.push(k);
      continue;
    }
    const sig = signature(JSON.stringify(doc));
    let marker: { id?: string; sig?: string } | null = null;
    try { marker = JSON.parse(storage.getItem(MOVED + k) ?? "null"); } catch {}
    if (marker?.sig === sig) continue;
    const title = safeName(doc.title ?? (source ? nameOf("/" + source.split(/[?#]/)[0]) : ""));
    const docIdText = storage.getItem(k + "#outputs");
    const docId = docIdText && /^[0-9a-f]{32}$/.test(docIdText) ? docIdText : undefined;
    const when = (local && at.get(local[1])) || Date.now();
    const mode = typeof doc.mode === "string" ? doc.mode : "python";
    let id: string;
    if (marker) {
      // (written again since it was brought in: by a tab of the old site)
      id = await newBoard(w, doc, when, undefined, source ?? undefined);
      await w.adopt(local ? "/" : EDITED_FOLDER, `${title} (from an older tab)`, BOARD_EXT, { kind: "board", ref: id, mode, ...(source ? { origin: source } : {}) });
      r.copies++;
    } else if (local) {
      id = local[1];
      // (the board under its own id; there already, from a run whose marker wasn't kept: the same board, or a copy of a changed one)
      const kept: BoardRecord | undefined = await inTx(w.ws, "boards", "readonly", (tx) => req(tx.objectStore("boards").get(id)));
      if (!kept) {
        await inTx(w.ws, "boards", "readwrite", async (tx) => { tx.objectStore("boards").add({ id, doc, rev: 1, updated: when, ...(docId ? { docId } : {}) } satisfies BoardRecord); });
        const back: BoardRecord | undefined = await inTx(w.ws, "boards", "readonly", (tx) => req(tx.objectStore("boards").get(id)));
        if (!back || signature(JSON.stringify(back.doc)) !== sig) throw new WorkspaceError("storage", `board ${id} didn't read back as written`);
      } else if (signature(JSON.stringify(kept.doc)) !== sig) {
        id = await newBoard(w, doc, when, docId);
        r.copies++;
      }
      const listed = await inTx(w.ws, "entries", "readonly", (tx) => req(tx.objectStore("entries").index("byRef").getKey(["board", id])));
      if (listed === undefined) await w.adopt("/", title, BOARD_EXT, { kind: "board", ref: id, mode, created: when, updated: when });
      r.boards++;
    } else {
      id = await newBoard(w, doc, when, docId, source!);
      await w.adopt(EDITED_FOLDER, title, BOARD_EXT, { kind: "board", ref: id, mode, origin: source!, created: when, updated: when });
      r.boards++;
    }
    // (the marker: kept if storage takes it; if not, the next run finds the board by its id or brings it in again)
    try { storage.setItem(MOVED + k, JSON.stringify({ id, sig })); } catch {}
  }
}

/** A board of its own (a fresh id), written and read back. */
async function newBoard(w: Workspace, doc: unknown, when: number, docId?: string, origin?: string): Promise<string> {
  const id = await inTx(w.ws, "boards", "readwrite", async (tx) => {
    const st = tx.objectStore("boards");
    for (;;) {
      const id = [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, "0")).join("");
      if ((await req(st.getKey(id))) === undefined) {
        st.add({ id, doc, rev: 1, updated: when, ...(docId ? { docId } : {}), ...(origin ? { origin } : {}) } satisfies BoardRecord);
        return id;
      }
    }
  });
  const back = await inTx(w.ws, "boards", "readonly", (tx) => req(tx.objectStore("boards").getKey(id)));
  if (back === undefined) throw new WorkspaceError("storage", `board ${id} didn't read back as written`);
  return id;
}

/** The index made true to the contents (hold the lock): contents with no
 * entry listed (`first`: notebooks at the top; after that in /Recovered/),
 * entries whose contents are gone marked missing (and unmarked when they
 * are back).  Counts go in `r`. */
export async function reconcile(w: Workspace, first: boolean, r: MigrateReport) {
  const entries: Entry[] = await inTx(w.ws, "entries", "readonly", (tx) => req(tx.objectStore("entries").getAll()));
  const refs = { notebook: new Set<string>(), board: new Set<string>(), file: new Set<string>(), trash: new Set<string>() };
  for (const e of entries) {
    if (e.ref === null) continue;
    if (e.kind === "file" && (e.trashed || within(e.path, TRASH))) refs.trash.add(e.ref);
    else if (e.kind !== "folder") refs[e.kind].add(e.ref);
  }
  const notebookIds = w.main ? ((await w.mainTx("notebooks", "readonly", (st) => st.getAllKeys())) as string[]) : [];
  const fileKeys = w.main ? ((await w.mainTx("files", "readonly", (st) => st.getAllKeys())) as string[]) : [];
  const boardIds = (await inTx(w.ws, "boards", "readonly", (tx) => req(tx.objectStore("boards").getAllKeys()))) as string[];
  const trashKeys = (await inTx(w.ws, "trash", "readonly", (tx) => req(tx.objectStore("trash").getAllKeys()))) as string[];
  // notebooks
  for (const id of notebookIds) {
    if (refs.notebook.has(id)) continue;
    const rec = await w.mainTx("notebooks", "readonly", (st) => st.get(id));
    if (!rec) continue;
    await w.adopt(first ? "/" : RECOVERED, safeName(rec.name), ".ipynb", { kind: "notebook", ref: id, mode: typeof rec.mode === "string" ? rec.mode : "python", created: rec.updated ?? Date.now(), updated: rec.updated ?? Date.now() });
    if (first) r.notebooks++;
    else r.recovered++;
  }
  // data files: at their own path (what Python's open() names them by), or, a key that isn't a path, in /Recovered/
  for (const key of fileKeys) {
    if (typeof key !== "string" || refs.file.has(key)) continue;
    const bytes = await w.mainTx("files", "readonly", (st) => st.get(key));
    const size = bytes?.length ?? bytes?.byteLength ?? 0;
    let p: string | null = null;
    try { p = normPath(key); } catch {}
    if (p !== null && p !== "/" && !within(p, TRASH)) {
      const [base, ext] = splitExt(nameOf(p));
      await w.adopt(parentOf(p), base, ext, { kind: "file", ref: key, size, rev: 0 });
      r.files++;
    } else {
      const [base, ext] = splitExt(safeName(String(key).split("/").pop()));
      await w.adopt(RECOVERED, base, ext, { kind: "file", ref: key, size, rev: 0 });
      r.recovered++;
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
  // bytes in Trash with no entry: back out as files in /Recovered/
  for (const key of trashKeys) {
    if (refs.trash.has(key)) continue;
    const [base, ext] = splitExt(safeName(String(key).split("/").pop()));
    const bytes = await inTx(w.ws, "trash", "readonly", (tx) => req(tx.objectStore("trash").get(key)));
    // (into "sagebrush"/files under a path of its own, then the trash copy dropped)
    const e = await w.adopt(RECOVERED, base, ext, { kind: "file", ref: null, size: bytes?.length ?? 0, rev: 0 });
    await w.mainTx("files", "readwrite", (st) => st.put(bytes, e.path));
    await inTx(w.ws, "entries", "readwrite", async (tx) => { tx.objectStore("entries").put({ ...e, ref: e.path }); });
    await inTx(w.ws, "trash", "readwrite", async (tx) => { tx.objectStore("trash").delete(key); });
    r.recovered++;
  }
  // entries whose contents are gone, or back
  const have = { notebook: new Set(notebookIds), board: new Set(boardIds), file: new Set(fileKeys), trash: new Set(trashKeys) };
  for (const e of entries) {
    if (e.kind === "folder" || e.ref === null) continue;
    const set = e.kind === "file" && (e.trashed || within(e.path, TRASH)) ? have.trash : have[e.kind];
    const gone = !set.has(e.ref);
    if (gone === !!e.missing) continue;
    await inTx(w.ws, "entries", "readwrite", async (tx) => {
      const st = tx.objectStore("entries"), cur: Entry | undefined = await req(st.get(e.path));
      if (!cur || cur.ref !== e.ref) return;
      if (gone) st.put({ ...cur, missing: true });
      else {
        const { missing: _m, ...rest } = cur;
        st.put(rest);
      }
    });
    if (gone) r.missing++;
  }
}

