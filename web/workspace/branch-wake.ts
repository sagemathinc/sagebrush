// A branch's change events (onBranch): this bundle's subscribers directly, every other one (another tab, or another
// chunk of this page with its own copy of this module: the runs' chunk, the review page's) through a BroadcastChannel
// named for the branch store, "sagebrush-branches:" + its name, which every other channel of that name receives.  A
// wake-up only, never the state: the receiver reads it.  One channel per store, kept (a page has one workspace or few).

import { sha256Hex } from "./sha256-hex";

type Wake = { ns: string; fid: string; seq: number };
const local = new Set<(w: Wake) => void>();
const channels = new Map<string, BroadcastChannel>();
function channelFor(ns: string): BroadcastChannel | undefined {
  if (typeof BroadcastChannel === "undefined") return undefined;
  let c = channels.get(ns);
  if (!c) {
    c = new BroadcastChannel("sagebrush-branches:" + ns);
    // (another copy's wake-up: only its keys are read, and only as a wake-up; the receiver reads the state itself)
    c.onmessage = (e: MessageEvent) => {
      const d = e.data;
      if (d && typeof d === "object" && typeof d.fid === "string" && Number.isSafeInteger(d.seq)) for (const f of [...local]) f({ ns, fid: d.fid, seq: d.seq });
    };
    channels.set(ns, c);
  }
  return c;
}

/** Tells this bundle's subscribers and every other copy's that the branch `w.fid` of the store `w.ns` changed. */
export function tellBranch(w: Wake) {
  for (const f of [...local]) f(w);
  channelFor(w.ns)?.postMessage({ fid: w.fid, seq: w.seq });
}

/** `cb` called (with no state: read it) whenever the branch `fid` of the store `ns` may have changed, in this tab or
 * another; returns the unsubscribe. */
export function onBranch(ns: string, fid: string, cb: () => void): () => void {
  channelFor(ns);
  const f = (w: Wake) => { if (w.ns === ns && w.fid === fid) cb(); };
  local.add(f);
  return () => { local.delete(f); };
}

/** The branch store's name for the workspace whose database is `dbName` (branch-store.ts's openBranchStore). */
export async function branchStoreName(dbName: string): Promise<string> {
  return "sagebrush-branches:" + (await sha256Hex(new TextEncoder().encode(dbName)));
}

/** tellBranch, for a page that knows its workspace's database name, not its branch store's (run-verbs.ts). */
export async function wakeBranch(dbName: string, fid: string, seq: number): Promise<void> {
  tellBranch({ ns: await branchStoreName(dbName), fid, seq });
}
