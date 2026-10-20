// Detecting a lost workspace (design/workspace-durability.md, part A): two
// witnesses kept outside IndexedDB, and the decision the page makes at open.
//
// A witness is {v, workspace, generation, seq, entries, sampled, reset?}:
// - workspace: the workspace's own id, and generation: bumped by a
//   deliberate reset (A.3a), both kept in IndexedDB's meta too;
// - seq: the workspace's committed counter (Workspace.generation(): never
//   goes down, whatever is deleted or pruned);
// - reset: a reset prepared (A.3a) and not yet committed.
//
// One witness is in localStorage, written in the same hold of the
// workspace's lock as each commit (so the first save has one); the other in
// OPFS (/sagebrush/marker.json), written by the same holder at most every
// 10 s and when the page is hidden.  Each is replaced only by a newer one
// (same workspace and higher (generation, seq), or a reset's own phases),
// compared inside the lock, so no tab puts an older one back.
//
// What can't be detected: the site's data cleared completely (every witness
// with it) looks exactly like a first visit; a witness that can't be read
// (private browsing, storage denied) is "unknown", never "first visit".

export type Witness = { v: 1; workspace: string; generation: number; seq: number; entries: number; sampled: number; reset?: { to: number; kind: ResetKind; at: number } };
export type ResetKind = "new" | "delete" | "import" | "keep";
/** A witness read: the witness, none there, or one that couldn't be read (storage denied, corrupt). */
export type Read = { witness: Witness } | { none: true } | { unreadable: string };

export const LOCAL_KEY = "sagebrush-workspace-marker";
const OPFS_DIR = "sagebrush";
/** Where a workspace's witnesses are kept: the workspace's database's own (tests' databases each have theirs). */
export type Place = { key: string; file: string };
export const placeOf = (db: string, main = "sagebrush-workspace"): Place => (db === main ? { key: LOCAL_KEY, file: "marker.json" } : { key: `${LOCAL_KEY}:${db}`, file: `marker-${db.replace(/[^A-Za-z0-9_-]/g, "_")}.json` });

/** Whether `x` is a witness, as written. */
export function isWitness(x: any): x is Witness {
  return !!x && x.v === 1 && typeof x.workspace === "string" && /^[0-9a-f]{16}$/.test(x.workspace) && Number.isSafeInteger(x.generation) && x.generation >= 1 && Number.isSafeInteger(x.seq) && x.seq >= 0 && Number.isSafeInteger(x.entries) && typeof x.sampled === "number" && (x.reset === undefined || (Number.isSafeInteger(x.reset.to) && ["new", "delete", "import", "keep"].includes(x.reset.kind)));
}
const parse = (text: string | null | undefined): Read => {
  if (text === null || text === undefined) return { none: true };
  try {
    const w = JSON.parse(text);
    return isWitness(w) ? { witness: w } : { unreadable: "not a witness" };
  } catch {
    return { unreadable: "not JSON" };
  }
};

/** The localStorage witness. */
export function readLocal(at: Place): Read {
  try {
    return parse(globalThis.localStorage.getItem(at.key));
  } catch (e) {
    return { unreadable: String((e as Error)?.message ?? e) };
  }
}
/** The localStorage witness written (throws when storage refuses). */
export function writeLocal(at: Place, w: Witness | null) {
  if (w) globalThis.localStorage.setItem(at.key, JSON.stringify(w));
  else globalThis.localStorage.removeItem(at.key);
}

async function opfsDir(create: boolean): Promise<any> {
  const root = await (globalThis.navigator as any)?.storage?.getDirectory?.();
  if (!root) throw new Error("no OPFS");
  return root.getDirectoryHandle(OPFS_DIR, { create });
}
/** The OPFS witness. */
export async function readOpfs(at: Place): Promise<Read> {
  let dir;
  try {
    dir = await opfsDir(false);
  } catch (e: any) {
    return e?.name === "NotFoundError" ? { none: true } : { unreadable: String(e?.message ?? e) };
  }
  try {
    const f = await (await dir.getFileHandle(at.file)).getFile();
    return parse(await f.text());
  } catch (e: any) {
    return e?.name === "NotFoundError" ? { none: true } : { unreadable: String(e?.message ?? e) };
  }
}
/** The OPFS witness written whole (a writable stream's contents replace the file only when it closes). */
export async function writeOpfs(at: Place, w: Witness | null) {
  const dir = await opfsDir(true);
  if (!w) return dir.removeEntry(at.file).catch((e: any) => { if (e?.name !== "NotFoundError") throw e; });
  const h = await dir.getFileHandle(at.file, { create: true });
  if (typeof h.createWritable !== "function") throw new Error("no writable OPFS files here");
  const s = await h.createWritable();
  await s.write(JSON.stringify(w));
  await s.close();
}

/** Whether `a` may replace `b` in a normal commit's publication: same workspace, a higher (generation, seq), and
 * never over a prepared reset (which only the reset's own phases, or its resolution at open, replace). */
export function newer(a: Witness, b: Witness | undefined): boolean {
  if (!b) return true;
  if (b.reset) return false;
  if (a.workspace !== b.workspace) return a.generation > b.generation;
  return a.generation > b.generation || (a.generation === b.generation && a.seq > b.seq);
}

/** What IndexedDB holds at open. */
export type Held = {
  /** the database was made by this open (no workspace was there) */
  fresh: boolean;
  /** Chrome's `dataLoss` on the open's upgradeneeded: "total" when it deleted a corrupt database */
  dataLoss?: string;
  dataLossMessage?: string;
  /** the workspace's identity and generation in meta (absent: a database from before part A) */
  workspace?: string;
  generation?: number;
  /** its committed counter */
  seq: number;
};

export type State =
  | { state: "ok"; unavailable?: string }
  | { state: "first" }
  | { state: "confirmed"; witness?: Witness; why: string }
  | { state: "suspected"; witness: Witness; why: string }
  | { state: "unknown"; why: string }
  /** a reset to a new workspace under way (resumed after a stop): every writer refused until it is done */
  | { state: "resetting" }
  /** the old store's purge after a reset not finished: every writer refused until it is (astra's CORR-2A4-3) */
  | { state: "purging" };

/** What a reset prepared in a witness means, given what IndexedDB holds (A.3a). */
// (a reset is one IndexedDB transaction that never deletes the database: a new database under a prepared
// reset is a loss, not a reset half done; astra's probe on 2a4e53a8, a refused reset then a loss)
export type ResetOutcome = "rollback" | "finish" | "lost" | "unknown";
export function resolveReset(w: Witness, held: Held | null): ResetOutcome {
  if (!held) return "unknown";
  if (held.fresh || held.workspace === undefined) return "lost";
  if (held.generation === w.reset!.to) return "finish";
  if (held.workspace === w.workspace && held.generation === w.generation) return "rollback";
  return "unknown";
}

/** The witness that counts of two reads: the newer by (generation, seq) when both are this workspace's; one when the other is missing or unreadable. */
export function best(reads: Read[]): { witness?: Witness; unreadable: string[] } {
  const ws = reads.flatMap((r) => ("witness" in r ? [r.witness] : []));
  const unreadable = reads.flatMap((r) => ("unreadable" in r ? [r.unreadable] : []));
  // (a prepared reset first: it is resolved before anything else is decided)
  const prepared = ws.find((w) => w.reset);
  if (prepared) return { witness: prepared, unreadable };
  const top = ws.sort((a, b) => b.generation - a.generation || b.seq - a.seq)[0];
  return { witness: top, unreadable };
}

/** The decision at open (A.2), a prepared reset already resolved. */
export function decide(held: Held | null, reads: Read[]): State {
  const { witness: w, unreadable } = best(reads);
  if (!held) return { state: "unknown", why: "this browser's storage can't be opened" };
  if (held.dataLoss === "total") return { state: "confirmed", witness: w, why: `the browser deleted its storage as damaged${held.dataLossMessage ? ` (${held.dataLossMessage})` : ""}` };
  if (!w) {
    // (a record that can't be read: a lost workspace can't be told from a first visit here)
    if (unreadable.length) return held.fresh ? { state: "unknown", why: `the record that would show a lost workspace can't be read here (${unreadable.join("; ")})` } : { state: "ok", unavailable: unreadable.join("; ") };
    return held.fresh ? { state: "first" } : { state: "ok" };
  }
  if (held.fresh) return { state: "confirmed", witness: w, why: "this browser had a workspace, and its storage is gone" };
  // (a database from before part A has no identity yet: compared by its counter only)
  if (held.workspace !== undefined && held.workspace !== w.workspace) {
    // (another workspace's record: kept, said, never compared as this one's)
    return { state: "ok" };
  }
  const g = held.generation ?? 1;
  if (g < w.generation) return { state: "suspected", witness: w, why: "this browser had a newer workspace than the one it has now" };
  if (g === w.generation && held.seq < w.seq) return { state: "suspected", witness: w, why: `some recent changes are missing (it has up to change ${held.seq}; it had ${w.seq})` };
  return { state: "ok" };
}
