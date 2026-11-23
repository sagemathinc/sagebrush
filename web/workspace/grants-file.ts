// The desktop app's file permissions across launches (#1565): the record web/notebook/permissions.js keeps in
// localStorage ("sagebrush-grants", {v: 1, seq, docs: {doc id: {write, read, net, denied, t}}}) is forgotten at quit
// (the app's web view keeps nothing between launches), and a workspace notebook's id is new at every launch (the
// workspace is made again from disk, disk-mirror.ts importDisk). So the app keeps it in grants.json beside
// settings.json (disk.rs grants_read/grants_write), each document named by where it is: "ws:" and a workspace
// notebook's path, or a notebook file's own id ("file:" and its path, the same at every launch).
//   restoreGrants(ws, invoke): at launch, once the workspace is the disk's copy: the kept record back, each
//     "ws:<path>" named by the notebook at that path now (a path that isn't a notebook now: left out, its permission
//     gone, so a prompt comes back; never more than was kept); what this page already holds for a document wins.
//   grantsToKeep(ws): the record as grants.json keeps it (a notebook no longer in the workspace: left out).
//   keepGrants(ws, invoke, onChange): grants.json written whenever the record changes, one write at a time, the
//     last one winning.

export const GRANTS_KEY = "sagebrush-grants";
type Rec = { v: 1; seq?: number; migrated?: number; docs: Record<string, unknown> };
export interface GrantsWorkspace {
  stat(p: string): Promise<{ kind: string; ref: string | null } | undefined>;
  pathOf(kind: "notebook", ref: string): Promise<string | undefined>;
}
type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
type Store = Pick<Storage, "getItem" | "setItem">;

/** The page's record, or null if `text` isn't one. */
export function parseGrants(text: unknown): Rec | null {
  if (typeof text !== "string" || !text) return null;
  try {
    const r = JSON.parse(text);
    return r && typeof r === "object" && r.v === 1 && r.docs && typeof r.docs === "object" && !Array.isArray(r.docs) ? r : null;
  } catch {
    return null;
  }
}

/** grants.json's record back into localStorage at launch; how many documents came back. */
export async function restoreGrants(ws: GrantsWorkspace, invoke: Invoke, storage: Store = localStorage): Promise<number> {
  const kept = parseGrants(await invoke("grants_read").catch(() => ""));
  if (!kept) return 0;
  const cur = parseGrants(storage.getItem(GRANTS_KEY)) ?? { v: 1, seq: 0, docs: {} };
  let n = 0;
  for (const [k, e] of Object.entries(kept.docs)) {
    let id: string | null = null;
    if (k.startsWith("ws:")) {
      const s = await ws.stat(k.slice(3)).catch(() => undefined);
      if (s?.kind === "notebook" && s.ref) id = s.ref;
    } else if (k.startsWith("file:")) id = k;
    if (!id || Object.hasOwn(cur.docs, id)) continue;
    cur.docs[id] = e;
    n++;
  }
  if (!n) return 0;
  cur.seq = Math.max(Number(cur.seq) || 0, Number(kept.seq) || 0);
  if (kept.migrated === 1) cur.migrated = 1;
  storage.setItem(GRANTS_KEY, JSON.stringify(cur));
  return n;
}

/** The record as grants.json keeps it: each document by where it is now. */
export async function grantsToKeep(ws: GrantsWorkspace, storage: Store = localStorage): Promise<Rec> {
  const cur = parseGrants(storage.getItem(GRANTS_KEY)) ?? { v: 1, seq: 0, docs: {} };
  const out: Rec = { v: 1, seq: Number(cur.seq) || 0, ...(cur.migrated === 1 ? { migrated: 1 } : {}), docs: {} };
  for (const [id, e] of Object.entries(cur.docs)) {
    if (id.startsWith("file:")) out.docs[id] = e;
    else {
      const p = await ws.pathOf("notebook", id).catch(() => undefined);
      if (p) out.docs["ws:" + p] = e;
    }
  }
  return out;
}

/** grants.json written at each change of the record (`onChange`), one write at a time, the record as it is when each
 * write starts; a change during a write makes one more. A write that fails keeps the latest change unwritten: tried
 * again after `retryMs`, and at the next flush. `flush()` resolves once the latest change is in grants.json, and
 * rejects, saying why, if it can't be written now (the quit's and the leave's barrier, disk-mirror.ts keepAll). */
export function keepGrants(ws: GrantsWorkspace, invoke: Invoke, onChange: (f: () => void) => void, storage: Store = localStorage, retryMs = 3000) {
  let changes = 0, written = 0, failed: unknown = null, busy: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // (one job at a time, `busy` while it runs: nothing to write is no job at all, and a job yields before it starts, so
  // it can never finish before it is `busy`; it clears `busy` only if it is still the one there)
  const run = (): Promise<void> => {
    if (busy) return busy;
    if (written >= changes) return Promise.resolve();
    const job: Promise<void> = (async () => {
    await Promise.resolve();
    try {
      while (written < changes) {
        const upTo = changes;
        try {
          await invoke("grants_write", { json: JSON.stringify(await grantsToKeep(ws, storage)) });
          written = upTo;
          failed = null;
        } catch (e) {
          failed = e;
          console.warn("grants.json:", e);
          if (!timer) timer = setTimeout(() => { timer = null; void run(); }, retryMs);
          return;
        }
      }
    } finally { if (busy === job) busy = null; }
    })();
    busy = job;
    return job;
  };
  onChange(() => { changes++; void run(); });
  const flush = async (): Promise<void> => {
    let last: Promise<void> | null = null;
    for (;;) {
      const job = run();
      // (the same job twice is one already done that was never let go of: said, never a loop that spins)
      if (job === last) throw new Error("grants.json: the latest change wasn't written, and no write is running");
      last = job;
      await job;
      if (written >= changes) return;
      if (failed) throw new Error(`grants.json: ${(failed as any)?.message ?? failed}`);
    }
  };
  return { flush, save: flush, get unwritten() { return written < changes; } };
}
