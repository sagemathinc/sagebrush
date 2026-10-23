// The first sync's adoption journal (design/sync-client.md C3; LIMIT-SC1-R1, R3): a device's existing tree captured
// into `adoptJournal` under `<ns>#adopt`, keyed by identity, each record `{id, parent, name, kind, sha256, size,
// trashed}` with its folder's identity (never a path), then sent as `adopt` records through the bounded outbox
// (Outbox.drainJournal, the same drain as a rebuild's reissue journal).  In order, each step resumable from
// `sync:<ns>:adopt`:
//
//   start   one transaction: W0, the latest op, recorded, and the scan watermark set to it (ops after it kept);
//   walk    by identity, through the entries' byIdent index, 500 a transaction with its position: each record the
//           entry's state and the pin on its bytes (C2), owned by the journal until it drains;
//   close   one short transaction holding the workspace's lock: W1, the latest op;
//   replay  the ops in (W0, W1] only, 500 a transaction: each one's identity assigned from its `after` (an
//           assignment: an op the walk already saw is harmless), own intents only (wireOf's rule);
//   done    the last replay page sets the watermark to W1 and makes the journal the active one, the tree as of W1.
//
// The account socket is opened only then (sync-client.ts), so welcome's `index` is applied with the journal in the
// view (layer 2).  The scanner stays idle until the journal has drained.
import type { Entry, Op, Workspace } from "./api";
import { inTx, req } from "./db";
import { TRASH, nameOf, parentOf } from "./paths";
import { wireOf } from "./sync-outbox";
import { pinOfCurrent, pinPresent, type Pin } from "./sync-pins";
import type { JournalRecord } from "./sync-view";

export const ADOPT = {
  /** entries a walk transaction takes at most */
  page: 500,
  /** ops a replay transaction reads at most */
  replayPage: 500,
  /** (tests: awaited before each step: walk, close, replay) */
  before: null as null | ((step: string) => Promise<void>),
};
type State = { step: "walk" | "close" | "replay"; W0: number; W1?: number; at: string | number };
const stateKey = (ns: string) => `sync:${ns}:adopt`;
export const adoptPrefix = (ns: string) => `${ns}#adopt`;
const META = "meta";

/** A journal record of `e`'s present state (its folder's identity, or "" for the root, or for Trash itself). */
async function recordOf(st: IDBObjectStore, jp: string, e: Entry): Promise<JournalRecord> {
  let parent = "";
  const folder = parentOf(e.path);
  if (!e.trashed && folder !== "/" && folder !== TRASH) parent = (((await req(st.get(folder))) as Entry | undefined)?.fid) ?? "";
  return { ns: jp, id: e.ident!, parent, name: nameOf(e.path), kind: e.kind, ...(e.kind === "file" ? { sha256: e.sha256, size: e.size } : {}), trashed: !!e.trashed, ...(e.trashed ? { from: e.trashed.from } : {}) };
}

/** Whether `ns` has begun syncing (its watermark is set) and its adoption, if any, is captured. */
export async function adopted(w: Workspace, ns: string): Promise<boolean> {
  return inTx(w.ws, META, "readonly", async (tx) => {
    const meta = tx.objectStore(META);
    return (await req(meta.get(`sync:${ns}:scanned`))) !== undefined && (await req(meta.get(stateKey(ns)))) === undefined;
  });
}

/** The capture run to its end (each step its own transactions, resumable after a crash). */
export async function capture(w: Workspace, ns: string): Promise<void> {
  // (start: W0 and the watermark, once)
  await inTx(w.ws, [META, "ops"], "readwrite", async (tx) => {
    const meta = tx.objectStore(META);
    if ((await req(meta.get(`sync:${ns}:scanned`))) !== undefined) return;
    const W0 = await new Promise<number>((ok, no) => { const c = tx.objectStore("ops").openKeyCursor(null, "prev"); c.onsuccess = () => ok((c.result?.key as number | undefined) ?? 0); c.onerror = () => no(c.error); });
    meta.put(W0, `sync:${ns}:scanned`);
    meta.put({ step: "walk", W0, at: "" } satisfies State, stateKey(ns));
  });
  const jp = adoptPrefix(ns);
  for (;;) {
    const s = (await inTx(w.ws, META, "readonly", (tx) => req(tx.objectStore(META).get(stateKey(ns))))) as State | undefined;
    if (!s) return;
    if (ADOPT.before) await ADOPT.before(s.step);
    if (s.step === "walk") {
      await inTx(w.ws, [META, "entries", "adoptJournal", "pins"], "readwrite", async (tx) => {
        const meta = tx.objectStore(META), st = tx.objectStore("entries"), j = tx.objectStore("adoptJournal");
        // (by identity: a rename or a move during the walk doesn't change an identity's place in this order, so
        // nothing is hidden or seen twice)
        const list = await new Promise<Entry[]>((ok, no) => {
          const out: Entry[] = [];
          const c = st.index("byIdent").openCursor(s.at === "" ? null : IDBKeyRange.lowerBound(s.at as string, true));
          c.onsuccess = () => {
            const cur = c.result;
            if (!cur || out.length >= ADOPT.page) return ok(out);
            out.push(cur.value as Entry);
            cur.continue();
          };
          c.onerror = () => no(c.error);
        });
        for (const e of list) {
          if (!e.ident) continue;
          j.put(await recordOf(st, jp, e));
          // (its bytes pinned for the journal until it drains: the pin on them now, else a new one)
          if (e.kind === "file" && e.migrated && e.sha256 && e.fid && !e.remote) {
            const cur = await pinOfCurrent(tx, e.fid, e.sha256);
            if (cur && !cur.owner) tx.objectStore("pins").put({ ...cur, owner: { ns: jp, dseq: 0 } } satisfies Pin);
            else if (!cur) await pinPresent(tx, e.fid, s.W0, e.path, e.sha256, e.size ?? 0, e.fid, { ns: jp, dseq: 0 });
          }
        }
        const next: State = list.length < ADOPT.page ? { ...s, step: "close", at: 0 } : { ...s, at: list[list.length - 1].ident! };
        meta.put(next, stateKey(ns));
      });
    } else if (s.step === "close") {
      // (the boundary: inside the lock, every local change's op is either at most W1 or after it, never both)
      await w.locked(() => inTx(w.ws, [META, "ops"], "readwrite", async (tx) => {
        const W1 = await new Promise<number>((ok, no) => { const c = tx.objectStore("ops").openKeyCursor(null, "prev"); c.onsuccess = () => ok((c.result?.key as number | undefined) ?? 0); c.onerror = () => no(c.error); });
        tx.objectStore(META).put({ ...s, step: "replay", W1, at: s.W0 } satisfies State, stateKey(ns));
      }));
    } else {
      await inTx(w.ws, [META, "ops", "entries", "adoptJournal"], "readwrite", async (tx) => {
        const meta = tx.objectStore(META), j = tx.objectStore("adoptJournal"), st = tx.objectStore("entries");
        const from = s.at as number;
        const ops = from < s.W1! ? ((await req(tx.objectStore("ops").getAll(IDBKeyRange.bound(from, s.W1!, true, false), ADOPT.replayPage))) as Op[]) : [];
        let at = from;
        for (const o of ops) {
          at = o.seq!;
          if (wireOf(o, 0) === null) continue;
          const id = (o.after?.id ?? o.fid ?? o.ref)!;
          if (o.after === null) {
            j.put({ ns: jp, id, parent: "~gone", name: "", kind: o.kind, trashed: false, gone: true } satisfies JournalRecord);
            continue;
          }
          const a = o.after!;
          const from = a.trashed ? (((await req(st.index("byIdent").get(id))) as Entry | undefined)?.trashed?.from) : undefined;
          j.put({ ns: jp, id, parent: a.parent ?? "", name: a.name, kind: a.kind, ...(a.kind === "file" ? { sha256: a.sha256, size: a.size } : {}), trashed: a.trashed, ...(from ? { from } : {}) } satisfies JournalRecord);
        }
        if (ops.length < ADOPT.replayPage || at >= s.W1!) {
          // (captured: the tree as of W1, the active journal; the watermark at W1, the scanner idle until it drains)
          meta.put(s.W1, `sync:${ns}:scanned`);
          meta.put(jp, `sync:${ns}:journal`);
          meta.delete(stateKey(ns));
        } else meta.put({ ...s, at }, stateKey(ns));
      });
    }
  }
}
