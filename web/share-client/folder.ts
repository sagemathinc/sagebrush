// Share folder (book links B2, design r2): a folder's notebooks and data files as one collection, its chapter links,
// and the upload's retry safety, kept apart from the page so it can be tested with stand-ins.
//
// The folder remembers its share in the workspace (api.ts folderShare, by the folder's fid: a rename keeps it):
// the collection's id once made, or, before, the attempt of its first upload (32 hex digits), saved before anything
// is sent.  As for a notebook's first upload (index.html's share dialog, plan-upload-leak r3), this device also
// records the attempt it sends (shareSent, keyed "folder:<fid>") before the request that makes the share, so a retry
// after a lost answer, a crash or a reload sends that same attempt and gets that share back, never a second one.
import type { LazyFile } from "./upload";

/** A workspace entry, as much of it as a plan needs. */
export interface PlanEntry {
  path: string;
  kind: string;
  size?: number;
  fid?: string;
  /** a notebook's record id */
  ref?: string | null;
}
export interface PlanFile {
  /** its path in the share: relative to the folder */
  rel: string;
  entry: PlanEntry;
  notebook: boolean;
}
export interface FolderPlan {
  files: PlanFile[];
  /** what isn't shared, and why */
  left: { rel: string; why: string }[];
}

const relOf = (folder: string, p: string) => (folder === "/" ? p.slice(1) : p.slice(folder.length + 1));
/** A path the share server takes (web/share/server.ts validPath): relative, plain segments, at most 512 characters. */
export function sharePathOk(p: string): boolean {
  if (p.length === 0 || p.length > 512 || /[\u0000-\u001f\u007f\\]/.test(p)) return false;
  return p.split("/").every((s) => s !== "" && s !== "." && s !== "..");
}

/** What sharing `folder` uploads: every notebook (as its .ipynb) and data file under it, by path; boards are left
 * out (a share can't open them yet), and anything whose path the server wouldn't take. */
export function folderPlan(folder: string, entries: PlanEntry[]): FolderPlan {
  const files: PlanFile[] = [], left: FolderPlan["left"] = [];
  const under = folder === "/" ? "/" : folder + "/";
  for (const e of [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    if (!e.path.startsWith(under) || e.kind === "folder") continue;
    const rel = relOf(folder, e.path);
    if (e.kind === "board") left.push({ rel, why: "a board: a share can't open boards yet" });
    else if (e.kind !== "notebook" && e.kind !== "file") left.push({ rel, why: `not a notebook or a data file (${e.kind})` });
    else if (!sharePathOk(rel)) left.push({ rel, why: "its path is longer than 512 characters or has characters a share can't hold" });
    else files.push({ rel, entry: e, notebook: e.kind === "notebook" });
  }
  return { files, left };
}

/** A chapter's link: the share's, with ?f=<its path> (the viewer opens that notebook: view.ts), "/" kept readable. */
export function chapterLink(url: string, rel: string): string {
  const u = new URL(url);
  u.search = "";
  u.hash = "";
  return `${u.href}?f=${encodeURIComponent(rel).replace(/%2F/g, "/")}`;
}

/** "Copy all links": each chapter's name and link, one per line. */
export function linksText(url: string, rels: string[]): string {
  return rels.map((r) => `${r.replace(/\.ipynb$/i, "")}\t${chapterLink(url, r)}`).join("\n");
}

/** The notebooks of the previous version no longer in this one: their links stop opening them. */
export function goneChapters(before: string[] | null, after: string[]): string[] {
  if (!before) return [];
  const now = new Set(after);
  return before.filter((p) => /\.ipynb$/i.test(p) && !now.has(p));
}

/** Board's line: a folder whose share was deleted, shared again. */
export const FOLDER_GONE = "This folder's links were deleted. Upload makes new ones, at new addresses.";
export type FolderShare = { share_id: string; share_attempt: null } | { share_id: null; share_attempt: string };
type Sent = { tag: "none" } | { tag: "attempt"; attempt: string } | { tag: "unreadable" };
export interface FolderShareDeps {
  /** the folder's share as the workspace holds it (throws if it can't be read: never taken as none) */
  get: () => Promise<FolderShare | undefined>;
  /** compare-and-set: whether it was still `expect`, and is now `next` */
  set: (expect: FolderShare | undefined, next: FolderShare | undefined) => Promise<boolean>;
  /** this device's record of the attempt it sent (shareSent, "folder:<fid>") */
  sent: { get: () => Promise<Sent>; put: (attempt: string) => Promise<string>; drop: (attempt: string) => Promise<unknown> };
  upload: (o: { id: string | null; attempt?: string; title: string; license?: string; files: LazyFile[] }, progress: (done: number, total: number) => void, opts: { beforeCommit: () => Promise<void> }) => Promise<{ id: string; url: string }>;
  /** an AttemptError's kind and share (upload.ts), else null */
  attemptError: (e: unknown) => { kind: "used" | "retired" | "gone"; share?: { id: string; url: string } } | null;
  random: () => string;
  /** the most first uploads this device keeps unconfirmed (SHARE_SENT_MAX) */
  sentMax: number;
}
const same = (a: FolderShare | undefined, b: FolderShare | undefined) => (a === undefined || b === undefined ? a === b : a.share_id === b.share_id && a.share_attempt === b.share_attempt);

/**
 * Uploads `files` as the folder's share: a new version of it, or its first upload.  Resolves to the share's url and
 * id, `again` (a new version), and `settled` (tests: the record's settling, done in the background).
 */
export async function shareFolderUpload(
  o: { title: string; license?: string; files: LazyFile[] },
  d: FolderShareDeps,
  progress: (done: number, total: number) => void = () => {},
): Promise<{ id: string; url: string; again: boolean; settled: Promise<void> }> {
  // (the record goes only once share `id` is the folder's in the workspace; a failure keeps it, so a retry recovers)
  const settle = async (id: string) => {
    try {
      const g = await d.sent.get();
      if (g.tag !== "attempt") return;
      if ((await d.get())?.share_id === id) await d.sent.drop(g.attempt);
    } catch {}
  };
  // (this device's sent attempt, if any; records that can't be read refuse the upload)
  const sentAttempt = async () => {
    let g: Sent | null;
    try {
      g = await d.sent.get();
    } catch {
      g = null;
    }
    if (g?.tag === "attempt") return g.attempt;
    if (g?.tag === "none") return null;
    throw new Error("this browser couldn't read its upload records, so nothing was shared; upload again");
  };
  const b = await d.get();
  const prev = b?.share_id ?? null;
  let attempt: string | null = null;
  let settled: Promise<void> = Promise.resolve();
  if (prev) settled = settle(prev);
  else {
    // (an attempt this device sent comes first: its share may exist; then the folder's own; else a new one, saved
    // with the folder before anything is read or sent)
    attempt = (await sentAttempt()) ?? b?.share_attempt ?? d.random();
    if (!/^[0-9a-f]{32}$/.test(attempt)) throw new Error("this folder's upload attempt couldn't be made; upload again");
    const want: FolderShare = { share_id: null, share_attempt: attempt };
    if (!same(b, want) && !(await d.set(b, want))) throw new Error("this folder's share changed meanwhile; upload again");
  }
  // (just before the request that makes the share: the folder still holds this attempt, and this device records it)
  const beforeCommit = async () => {
    const now = await d.get();
    if (now?.share_id || now?.share_attempt !== attempt) throw new Error("this folder's share changed while uploading; nothing was shared. Upload again.");
    let recorded: string;
    try {
      recorded = await d.sent.put(attempt!);
    } catch {
      recorded = "failed";
    }
    if (recorded === "recorded") return;
    if (recorded === "full") throw new Error(`this browser has ${d.sentMax} first uploads whose outcome it hasn't confirmed yet, so nothing was shared. Upload one of them again (that confirms it), then this folder.`);
    if (recorded === "other") throw new Error("another upload of this folder from this browser hasn't finished, so nothing was shared. Upload again: that continues it.");
    throw new Error("this browser couldn't record the upload, so nothing was shared; upload again");
  };
  let r: { id: string; url: string };
  try {
    r = await d.upload({ id: prev, attempt: attempt ?? undefined, title: o.title, license: o.license, files: o.files }, progress, { beforeCommit });
  } catch (e) {
    // (an unknown outcome (no answer, a 5xx): the attempt stays the folder's, and its record, so a retry gets it back)
    const ae = d.attemptError(e);
    // (its share deleted by its owner: the record goes only if it is still exactly that share (compare-and-set: a newer
    // one, from another tab, is kept); nothing more is sent: the next Upload makes a new share, as any first one)
    if (ae?.kind === "gone" && prev) {
      await d.set(b, undefined).catch(() => false);
      throw new Error(FOLDER_GONE);
    }
    if (!ae || attempt === null) throw e;
    const held: FolderShare = { share_id: null, share_attempt: attempt };
    if (ae.kind === "used" && ae.share) {
      // (that share, adopted as the folder's: the record stays until it is)
      await d.set(held, { share_id: ae.share.id, share_attempt: null }).catch(() => false);
      void settle(ae.share.id);
      throw new Error(`an earlier upload of this folder was shared with different files: ${ae.share.url}. Nothing new was uploaded. Share the folder again to make a new version with your current selection.`);
    }
    // (its share is gone, so no retry could recover one: this attempt's record and the folder's attempt go)
    await d.sent.drop(attempt).catch(() => {});
    await d.set(held, undefined).catch(() => false);
    throw new Error("this folder's earlier share was deleted. Share the folder again to make a new one.");
  }
  const expect: FolderShare | undefined = prev ? b : { share_id: null, share_attempt: attempt! };
  const kept = await d.set(expect, { share_id: r.id, share_attempt: null }).catch(() => false);
  if (kept) settled = settle(r.id);
  return { id: r.id, url: r.url, again: !!prev, settled };
}
