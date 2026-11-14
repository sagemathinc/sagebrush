// The account copy of an assignment (S4 A, design r3 §2a): one copy per account, whichever devices press Start.
//
// - The copy's folder has an identity derived from the account, the copy and a number: F(n), the first that this
//   browser's confirmed index (current, by syncReady) has neither live nor forgotten.  A copy deleted and started again
//   is a new folder, F(n+1): no grant made on the old one (grants are by identity) carries over, and the server never
//   takes it as "made again".
// - Found (F(n) live, not in Trash): it is there; nothing is made.
// - Otherwise this device makes the folder with that identity (mkdir's internal `ident`) and waits for what the
//   server's log did with its own mkdir (the confirmed index's watch: "applied" or "skipped").  Only on "applied" does
//   it write the handout's files: before that, and on "skipped" (another device's create came first), it writes nothing
//   under the folder; "skipped" is "arriving": the files come from the device that made it.
// - Sync paused here (full, read-only) or its log stuck while waiting: "refused", nothing written beyond the folder.
import type { Workspace, Entry } from "./api";
import type { SyncOwner } from "./sync-owner";
import { syncReady } from "./sync-ready";
import { confirmedEntry, watchIdent, watchOf, type Watch } from "./sync-confirmed";
import { TRASH, within } from "./paths";

export type CopyState = "applied" | "found" | "arriving" | "refused" | "off" | "timeout";
export type CopyFile = { path: string; kind: "notebook" | "file"; content: unknown };
export type CopyResult = { state: CopyState; folder?: string; notebooks: { path: string; ref: string }[]; reason?: string; trashed?: boolean };

/** The identities tried at most (copies deleted and started again): past it, refused. */
export const COPY = { maxTries: 64, pollMs: 250 };

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
  // one beside it; not there, the one to make; a live identity that isn't a folder: refused, nothing made)
  let fid = "";
  for (let n = 0; n < COPY.maxTries; n++) {
    const id = await copyFolderId(account, o.copyId, n);
    const e = await confirmedEntry(w, ns, id);
    if (e && "gone" in e) continue;
    if (e && e.kind !== "folder") return { state: "refused", notebooks: [], reason: "the copy's identity is another kind of entry" };
    if (e) {
      const trashed = within(e.path, TRASH);
      return { state: "found", folder: e.path, notebooks: trashed ? [] : await notebooksIn(w, e.path), ...(trashed ? { trashed } : {}) };
    }
    fid = id;
    break;
  }
  if (!fid) return { state: "refused", notebooks: [], reason: "too many copies of this assignment were deleted" };
  // (the watch first, then the folder: its own mkdir's outcome is recorded as the log applies it)
  let watch: Watch = await watchIdent(w, ns, fid);
  let folder = await folderPath(w, fid);
  if (!folder && watch.state === "pending") {
    const base = "/Assignments/" + copyFolderName(o.title, o.copyId);
    for (let k = 1; k <= 20 && !folder; k++) {
      const p = k === 1 ? base : `${base} (${k})`;
      try {
        folder = (await w.mkdir(p, { ident: fid })).path;
      } catch (e) {
        if ((e as { code?: string })?.code !== "exists") throw e;
      }
    }
    if (!folder) return { state: "refused", notebooks: [], reason: "no free name for the copy's folder" };
  }
  // (what the server's log did with it: nothing is written under the folder before "applied")
  while (watch.state === "pending") {
    if (o.signal?.aborted || left() === 0) return { state: "timeout", folder, notebooks: [] };
    const s = owner.view().s;
    if (s.stuck || (s.state === "paused" && s.reason !== undefined)) return { state: "refused", folder, notebooks: [], reason: s.reason ?? "sync can't go on here" };
    if (s.state === "off") return { state: "off", folder, notebooks: [] };
    await new Promise((r) => setTimeout(r, COPY.pollMs));
    watch = (await watchOf(w, ns, fid)) ?? watch;
  }
  if (watch.state === "duplicate") {
    const e = await confirmedEntry(w, ns, fid);
    return { state: "arriving", folder: e && !("gone" in e) ? e.path : folder, notebooks: [], reason: watch.why };
  }
  if (watch.state === "refused") return { state: "refused", folder, notebooks: [], reason: watch.why };
  // (applied: this device made the copy.  Its handout written by one caller at a time in this browser (a lock per
  // identity: another tab writing it, this one says arriving), each file once (one there already, from an earlier
  // try, kept), and only while the lifecycle is the same and the folder is still live, rechecked first)
  const locks = (globalThis.navigator as { locks?: LockManager } | undefined)?.locks;
  if (!locks) return { state: "refused", folder, notebooks: [], reason: "this browser can't make sure only one page writes the copy" };
  const name = `sagebrush-copy:${ns}:${fid}`;
  const out = await locks.request(name, { ifAvailable: true }, async (lock) => {
    if (!lock) return null;
    const now = owner.lifecycle();
    const e = await confirmedEntry(w, ns, fid);
    const at = await folderPath(w, fid);
    if (!now || now.ns !== ns || now.epoch !== life.epoch) return { state: "off" as const, folder, notebooks: [] };
    if (!e || "gone" in e || within(e.path, TRASH) || !at) return { state: "refused" as const, folder, notebooks: [], reason: "the copy's folder isn't there any more" };
    return writeHandout(w, at, o.files);
  });
  return out ?? { state: "arriving", folder, notebooks: [], reason: "another page of this browser is writing the copy" };
}

async function writeHandout(w: Workspace, at: string, files: CopyFile[]): Promise<CopyResult> {
  for (const f of files) {
    const rel = f.path.replace(/^\/+/, "");
    if (!rel || rel.split("/").some((s) => s === "" || s === "." || s === "..")) continue;
    const p = at + "/" + rel;
    if (await w.stat(p)) continue;
    const dir = p.slice(0, p.lastIndexOf("/"));
    if (dir !== at && !(await w.stat(dir))) await w.mkdir(dir);
    await w.create(p, { content: f.content });
  }
  return { state: "applied", folder: at, notebooks: await notebooksIn(w, at) };
}
