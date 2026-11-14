// The account copy of an assignment (S4 A, design r3 §2a): one copy per account, whichever devices press Start.
//
// - The copy's folder has an identity derived from the account, the copy and a number: F(n), the first that this
//   browser's confirmed index (current, by syncReady) has neither live nor forgotten.  A copy deleted and started again
//   is a new folder, F(n+1): no grant made on the old one (grants are by identity) carries over, and the server never
//   takes it as "made again".
// - Found (F(n) live): it is there; nothing is made.  Unless it is this device's own create, applied, its handout
//   unfinished (the page closed meanwhile): the rest of the handout written now (below).
// - Otherwise this device makes the folder with that identity (mkdir's internal `ident`) and waits for what the
//   server's log did with its own mkdir (the confirmed index's watch: "applied" or "skipped").  Only on "applied" does
//   it write the handout's files: before that, and on "skipped" (another device's create came first), it writes nothing
//   under the folder; "skipped" is "arriving": the files come from the device that made it.
// - Sync paused here (full, read-only) or its log stuck while waiting: "refused", nothing written beyond the folder.
// - Another account or epoch (sync turned off here) while waiting: "off", nothing written beyond the folder.
// - The copy's definition (its revision and the handout's manifest, a digest of every file's path, kind and contents)
//   pinned on this device before its create, in a record beside the watch: a Start with another one is refused, never
//   mixed into it.  The record keeps the handout's progress (each file marked in the transaction that makes it) and its
//   completion: a file written once is never made again (one the student renamed or deleted stays so), and a finished
//   copy opens as found, never seeded again.
// - Each file is made with a fence in its own transaction: sync's lifecycle still the one the call began with (on), and
//   the copy's folder still that identity at that path, live.  Between files: the signal, the deadline and sync's
//   state.  Any of them failing stops the handout: "off", "timeout" or "refused", never "applied".
import type { Workspace, Entry } from "./api";
import type { SyncOwner } from "./sync-owner";
import { syncReady } from "./sync-ready";
import { confirmedEntry, watchIdent, watchOf, type Watch } from "./sync-confirmed";
import { inTx, req } from "./db";
import { TRASH, within } from "./paths";

export type CopyState = "applied" | "found" | "arriving" | "refused" | "off" | "timeout";
export type CopyFile = { path: string; kind: "notebook" | "file"; content: unknown };
export type CopyResult = { state: CopyState; folder?: string; notebooks: { path: string; ref: string }[]; reason?: string; trashed?: boolean };

/** The identities tried at most (copies deleted and started again): past it, refused. */
/** `seam`: a test seam, unset in production: awaited before the folder's fenced transaction ("mkdir"), a kept
 * entry's ("kept") and the completion's ("done"); called, never awaited, inside each file's transaction, before its
 * final check ("file"). */
export const COPY: { maxTries: number; pollMs: number; seam?: (stage: "mkdir" | "file" | "kept" | "done") => void | Promise<void> } = { maxTries: 64, pollMs: 250 };

const enc = new TextEncoder();
/** F(n): the first 16 hex of SHA-256 over the parts, each length-prefixed, the first naming what it is; `account`: the
 * account's sync namespace without the device ("<hash>:<generation>"). */
export async function copyFolderId(account: string, copyId: string, n: number): Promise<string> {
  const parts = ["sagebrush/assignment-folder/v1", account, copyId, String(n)].map((x) => enc.encode(x));
  const all = new Uint8Array(parts.reduce((a, p) => a + 4 + p.length, 0));
  let at = 0;
  for (const p of parts) {
    new DataView(all.buffer).setUint32(at, p.length);
    all.set(p, at + 4);
    at += 4 + p.length;
  }
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", all));
  return Array.from(h.slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A folder name from a title: its own characters, but no slashes or control characters, and not too long. */
export function copyFolderName(title: string, copyId: string): string {
  const t = (title || "Assignment").replace(/[\u0000-\u001f\u007f/\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "Assignment";
  return `${t} (${copyId.slice(0, 6)})`;
}

/** The record of this device's copy: the definition pinned, the handout's files made (by their path in it), done. */
export type CopyRecord = { revision: string; manifest: string; written: string[]; done: boolean };
export const copyKey = (ns: string, fid: string) => `sync:${ns}:copy:${fid}`;
const recordOf = (w: Workspace, ns: string, fid: string) =>
  inTx(w.ws, "meta", "readonly", async (tx) => (await req(tx.objectStore("meta").get(copyKey(ns, fid)))) as CopyRecord | undefined);
/** The definition pinned (unless one is there): the record as it is then. */
const pin = (w: Workspace, ns: string, fid: string, revision: string, manifest: string) =>
  inTx(w.ws, "meta", "readwrite", async (tx) => {
    const meta = tx.objectStore("meta"), k = copyKey(ns, fid), was = (await req(meta.get(k))) as CopyRecord | undefined;
    if (was) return was;
    const v: CopyRecord = { revision, manifest, written: [], done: false };
    meta.put(v, k);
    return v;
  });
/** Whether `r` is the record of this definition (its revision and its manifest). */
const isDef = (r: CopyRecord | undefined, d: { revision: string; manifest: string }): r is CopyRecord => !!r && r.revision === d.revision && r.manifest === d.manifest;
const hexOf = async (b: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", b)), (x) => x.toString(16).padStart(2, "0")).join("");
/** The handout's relative paths, checked: each a path under the folder, none twice; else why not. */
function relsOf(files: CopyFile[]): string[] | string {
  const rels = files.map((f) => (typeof f?.path === "string" ? f.path.replace(/^\/+/, "") : ""));
  if (rels.some((r) => !r || r.split("/").some((x) => x === "" || x === "." || x === ".."))) return "a handout path isn't one under the copy's folder";
  if (new Set(rels).size !== rels.length) return "a handout path is there twice";
  return rels;
}
/** The manifest: a digest of each file's path, kind and contents (bytes as bytes, text as text, else its JSON). */
export async function copyManifest(files: CopyFile[]): Promise<string> {
  const rows = [];
  for (const f of files) {
    const c = f.content;
    const d = c instanceof Uint8Array ? "b" + (await hexOf(c)) : c instanceof ArrayBuffer ? "b" + (await hexOf(new Uint8Array(c))) : typeof c === "string" ? "s" + (await hexOf(enc.encode(c))) : "j" + (await hexOf(enc.encode(JSON.stringify(c ?? null))));
    rows.push([f.path.replace(/^\/+/, ""), f.kind, d]);
  }
  return hexOf(enc.encode(JSON.stringify(["sagebrush/assignment-handout/v1", rows])));
}

const folderPath = async (w: Workspace, fid: string) => { const r = await w.pathOfFolder(fid); return r.ok ? r.path : undefined; };
const notebooksIn = async (w: Workspace, folder: string) =>
  (await w.list(folder, { recursive: true })).filter((e: Entry) => e.kind === "notebook" && e.ref).map((e: Entry) => ({ path: e.path, ref: e.ref! }));

/** Starts (or finds) the account copy; see above. */
export async function startAssignmentCopy(
  owner: SyncOwner,
  w: Workspace,
  o: { copyId: string; revision: string; title: string; files: CopyFile[]; signal?: AbortSignal; timeoutMs?: number },
): Promise<CopyResult> {
  if (typeof o.copyId !== "string" || !/^[0-9a-z]{8,128}$/.test(o.copyId)) return { state: "refused", notebooks: [], reason: "not a copy id" };
  if (typeof o.revision !== "string" || o.revision === "" || o.revision.length > 256) return { state: "refused", notebooks: [], reason: "not a revision" };
  const rels = relsOf(o.files ?? []);
  if (typeof rels === "string") return { state: "refused", notebooks: [], reason: rels };
  const manifest = await copyManifest(o.files);
  const t0 = Date.now(), ms = o.timeoutMs ?? 60_000;
  const left = () => Math.max(0, ms - (Date.now() - t0));
  const ready = await syncReady(owner, { signal: o.signal, timeoutMs: Math.min(left(), 120_000) });
  if (ready !== "current") return { state: ready === "refused" ? "refused" : ready, notebooks: [] };
  const life = owner.lifecycle();
  if (!life) return { state: "off", notebooks: [] };
  const ns = life.ns;
  // (the account's part of the namespace, the same on every device: its hash and sync generation, not this device's id)
  const account = ns.split(":").slice(0, 2).join(":");
  // (the series in order: forgotten, the next; live (wherever it is now, in Trash too), that copy, opened, never a new
  // one beside it (unless this device's own, its handout unfinished: finished); not there, the one to make; a live
  // identity that isn't a folder: refused, nothing made)
  let fid = "";
  for (let n = 0; n < COPY.maxTries; n++) {
    const id = await copyFolderId(account, o.copyId, n);
    const e = await confirmedEntry(w, ns, id);
    if (e && "gone" in e) continue;
    if (e && e.kind !== "folder") return { state: "refused", notebooks: [], reason: "the copy's identity is another kind of entry" };
    if (e) {
      const trashed = within(e.path, TRASH);
      if (!trashed && (await watchOf(w, ns, id))?.state === "applied" && !(await recordOf(w, ns, id))?.done) {
        fid = id;
        break;
      }
      return { state: "found", folder: e.path, notebooks: trashed ? [] : await notebooksIn(w, e.path), ...(trashed ? { trashed } : {}) };
    }
    fid = id;
    break;
  }
  if (!fid) return { state: "refused", notebooks: [], reason: "too many copies of this assignment were deleted" };
  // (the definition pinned before anything is made: another revision or handout than the one this device began with,
  // refused)
  const rec = await pin(w, ns, fid, o.revision, manifest);
  if (!isDef(rec, { revision: o.revision, manifest })) return { state: "refused", folder: await folderPath(w, fid), notebooks: [], reason: "this copy was begun from another revision of the assignment" };
  // (the watch first, then the folder: its own mkdir's outcome is recorded as the log applies it)
  let watch: Watch = await watchIdent(w, ns, fid);
  let folder = await folderPath(w, fid);
  if (!folder && watch.state === "pending") {
    const base = "/Assignments/" + copyFolderName(o.title, o.copyId);
    // (the folder made with the fence in its own transaction: this call's lifecycle and definition there, the stop
    // conditions its last act)
    const f = { ns, epoch: life.epoch, fid, revision: o.revision, manifest, signal: o.signal, left };
    for (let k = 1; k <= 20 && !folder; k++) {
      const p = k === 1 ? base : `${base} (${k})`;
      if (COPY.seam) await COPY.seam("mkdir");
      try {
        folder = (await w.mkdirGated(p, fid, async (tx) => {
          await fenceIn(tx, f);
          return () => stopNow(owner, f);
        })).path;
      } catch (e) {
        if (e instanceof Stop) return { state: e.state, notebooks: [], ...(e.reason ? { reason: e.reason } : {}) };
        if ((e as { code?: string })?.code !== "exists") throw e;
      }
    }
    if (!folder) return { state: "refused", notebooks: [], reason: "no free name for the copy's folder" };
  }
  // (what the server's log did with it: nothing is written under the folder before "applied")
  while (watch.state === "pending") {
    if (o.signal?.aborted || left() === 0) return { state: "timeout", folder, notebooks: [] };
    const stop = stopped(owner, life);
    if (stop) return { ...stop, folder, notebooks: [] };
    await new Promise((r) => setTimeout(r, COPY.pollMs));
    // (the confirmed entry read first, then the watch: the identity live with the watch still pending is another
    // device's create (this device's own decides the watch in the same transaction), so it is arriving now, not after
    // this device's create (if it ever sends one: the folder may have come from the other device first) is answered)
    const e = await confirmedEntry(w, ns, fid);
    watch = (await watchOf(w, ns, fid)) ?? watch;
    if (watch.state === "pending" && e && !("gone" in e)) return { state: "arriving", folder: e.path, notebooks: [] };
  }
  if (watch.state === "duplicate") {
    const e = await confirmedEntry(w, ns, fid);
    return { state: "arriving", folder: e && !("gone" in e) ? e.path : folder, notebooks: [], reason: watch.why };
  }
  if (watch.state === "refused") return { state: "refused", folder, notebooks: [], reason: watch.why };
  // (applied: this device made the copy.  Its handout written by one caller at a time in this browser (a lock per
  // identity: another tab writing it, this one says arriving))
  const locks = (globalThis.navigator as { locks?: LockManager } | undefined)?.locks;
  if (!locks) return { state: "refused", folder, notebooks: [], reason: "this browser can't make sure only one page writes the copy" };
  const name = `sagebrush-copy:${ns}:${fid}`;
  const out = await locks.request(name, { ifAvailable: true }, async (lock) => {
    if (!lock) return null;
    return writeHandout(owner, w, { ns, epoch: life.epoch, fid, files: o.files, rels, revision: o.revision, manifest, signal: o.signal, left });
  });
  return out ?? { state: "arriving", folder, notebooks: [], reason: "another page of this browser is writing the copy" };
}

type Life = { ns: string; epoch: number };
/** Why the copy can't go on now: another lifecycle (or none), sync stuck or paused for a reason, or off. */
function stopped(owner: SyncOwner, life: Life): { state: "off" | "refused"; reason?: string } | null {
  const s = owner.view().s, now = owner.lifecycle();
  if (!now || now.ns !== life.ns || now.epoch !== life.epoch) return { state: "off" };
  if (s.stuck || (s.state === "paused" && s.reason !== undefined)) return { state: "refused", reason: s.reason ?? "sync can't go on here" };
  if (s.state === "off") return { state: "off" };
  return null;
}

const FOLDER_MOVED = "the copy's folder isn't there any more", DEF_MOVED = "the copy's record changed", KEPT_GONE = "a handout path changed while it was written";
/** Why the copy stopped, thrown from inside a fenced transaction (nothing there kept): its answer. */
class Stop extends Error {
  constructor(readonly state: "off" | "refused" | "timeout", readonly reason?: string) { super(reason ?? state); }
}
type Fence = Life & { fid: string; revision: string; manifest: string; signal?: AbortSignal; left: () => number };
/** In a transaction: sync's lifecycle still this call's (on), and the copy's record still this definition. */
async function fenceIn(tx: IDBTransaction, f: Fence): Promise<CopyRecord> {
  const meta = tx.objectStore("meta");
  const cur = (await req(meta.get("sync:current"))) as { ns?: string; off?: boolean } | undefined, ep = ((await req(meta.get("sync:epoch"))) as number | undefined) ?? 0;
  if (!cur || cur.off || cur.ns !== f.ns || ep !== f.epoch) throw new Stop("off");
  const r = (await req(meta.get(copyKey(f.ns, f.fid)))) as CopyRecord | undefined;
  if (!isDef(r, f)) throw new Stop("refused", DEF_MOVED);
  return r;
}
/** In a transaction: the copy's folder still `fid` at `at`, live. */
async function folderIn(tx: IDBTransaction, at: string, fid: string) {
  const d = (await req(tx.objectStore("entries").get(at))) as Entry | undefined;
  if (!d || d.kind !== "folder" || d.fid !== fid || d.trashed) throw new Stop("refused", FOLDER_MOVED);
}
/** Synchronous, a fenced transaction's last act: the caller's signal, the deadline and sync's state now. */
function stopNow(owner: SyncOwner, f: Fence) {
  if (f.signal?.aborted || f.left() === 0) throw new Stop("timeout");
  const st = stopped(owner, f);
  if (st) throw new Stop(st.state, st.reason);
}
/** The handout: each file not yet made (by the record) made with its fence, in its own transaction, and marked there. */
async function writeHandout(
  owner: SyncOwner,
  w: Workspace,
  c: Fence & { files: CopyFile[]; rels: string[] },
): Promise<CopyResult> {
  const key = copyKey(c.ns, c.fid);
  let at = await folderPath(w, c.fid);
  const end = (state: CopyState, reason?: string): CopyResult => ({ state, folder: at, notebooks: [], ...(reason ? { reason } : {}) });
  for (let i = 0; i < c.files.length; i++) {
    const rel = c.rels[i], f = c.files[i];
    const rec = await recordOf(w, c.ns, c.fid);
    if (!isDef(rec, c)) return end("refused", DEF_MOVED);
    if (rec.done) break;
    if (rec.written.includes(rel)) continue;
    if (c.signal?.aborted || c.left() === 0) return end("timeout");
    const stop = stopped(owner, c);
    if (stop) return end(stop.state, stop.reason);
    at = await folderPath(w, c.fid);
    const e = await confirmedEntry(w, c.ns, c.fid);
    if (!at || !e || "gone" in e || within(at, TRASH)) return end("refused", FOLDER_MOVED);
    const top = at;
    // (in the file's own transaction: the lifecycle and the folder, then the mark; a throw keeps nothing)
    const gate = async (tx: IDBTransaction) => {
      const r = await fenceIn(tx, c);
      await folderIn(tx, top, c.fid);
      if (r.done || r.written.includes(rel)) throw new Stop("refused", DEF_MOVED);
      tx.objectStore("meta").put({ ...r, written: [...r.written, rel] } satisfies CopyRecord, key);
      void COPY.seam?.("file");
      return () => stopNow(owner, c);
    };
    try {
      await w.createGated(top + "/" + rel, { content: f.content, signal: c.signal }, gate);
    } catch (err) {
      if (err instanceof Stop) return end(err.state, err.reason);
      const code = (err as { code?: string })?.code;
      // (something already at that path (the student's): kept, never written over; the file counted as made)
      // (something already at that path (the student's): kept, never written over, and counted as made, in a transaction
      // fenced as a file's own: the lifecycle, the definition, the folder, and the entry really there at that path; the
      // stop conditions its last act)
      if (code === "exists") {
        if (COPY.seam) await COPY.seam("kept");
        try {
          await inTx(w.ws, ["meta", "entries"], "readwrite", async (tx) => {
            const r = await fenceIn(tx, c);
            await folderIn(tx, top, c.fid);
            if (!(await req(tx.objectStore("entries").get(top + "/" + rel)))) throw new Stop("refused", KEPT_GONE);
            if (!r.done && !r.written.includes(rel)) tx.objectStore("meta").put({ ...r, written: [...r.written, rel] } satisfies CopyRecord, key);
            stopNow(owner, c);
          });
        } catch (e) {
          if (e instanceof Stop) return end(e.state, e.reason);
          throw e;
        }
        continue;
      }
      if (c.signal?.aborted) return end("timeout");
      throw err;
    }
  }
  // (done, in a transaction fenced as each file's: the lifecycle, the definition, the folder, then the stop conditions
  // its last act)
  if (c.signal?.aborted || c.left() === 0) return end("timeout");
  const stop = stopped(owner, c);
  if (stop) return end(stop.state, stop.reason);
  at = await folderPath(w, c.fid);
  if (!at || within(at, TRASH)) return end("refused", FOLDER_MOVED);
  const top = at;
  if (COPY.seam) await COPY.seam("done");
  try {
    await inTx(w.ws, ["meta", "entries"], "readwrite", async (tx) => {
      const r = await fenceIn(tx, c);
      await folderIn(tx, top, c.fid);
      tx.objectStore("meta").put({ ...r, done: true } satisfies CopyRecord, key);
      stopNow(owner, c);
    });
  } catch (err) {
    if (err instanceof Stop) return end(err.state, err.reason);
    throw err;
  }
  return { state: "applied", folder: at, notebooks: await notebooksIn(w, at) };
}
