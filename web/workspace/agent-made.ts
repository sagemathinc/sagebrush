// A notebook a paired agent created: opened where the page shows notebooks, then run once by itself, as the person's
// Run all would, when the conditions decided Nov 18 2026 hold. One decision for every page that shows one: the
// notebook page (web/index.html) and the Agents page's pane (web/agents/page.ts). Its creation's op is spent the first
// time it is announced, before anything is read or checked, and never armed again (in memory only: a reload starts
// with none, so nothing runs after one): a second announcement, a reconnect, a second open, a failure or a refusal
// never runs it. It runs only
//   - if this page's own pairing created it, and the grant it was created under is still in force as the run is
//     admitted, with May run code and Everything (AgentPairing.mayRunCreated);
//   - if, read back at once, it is still at its creation's own revision (a new notebook's first: one more at each write,
//     stores.js), and at the admission the notebook shown is that one with what Run all reads the same as read back
//     (runInputs, canonical: its language, pinned package set, seed, autorun and metadata, and each cell's id, kind,
//     source and metadata, manual among them). Nothing else is compared: an edit undone meanwhile isn't seen, nor a
//     change to anything Run all doesn't read;
//   - in the notebook's own interpreter, as the person's Run would run it there.
import type { Created } from "./agent-pair";

// (a value with its object keys sorted, so the same inputs always give the same text; a value left out stays left out
//  and null stays null, as they differ: no pin is the current package set, a null pin turns optional packages off)
const canon = (v: any): any => Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v;
/** What Run all reads of a notebook, as text: two notebooks run alike exactly when theirs are equal. */
export const runInputs = (doc: any): string => JSON.stringify(canon({ mode: doc?.mode, pkgset: doc?.pkgset, seed: doc?.seed, autorun: doc?.autorun, metadata: doc?.metadata,
  cells: (doc?.cells ?? []).map((c: any) => ({ id: c.id, kind: c.type === "markdown" || c.type === "raw" ? c.type : "code", code: String(c.code ?? ""), metadata: c.metadata })) }));
/** A new notebook's revision: its creation's own. */
export const CREATED_REV = 1;

export type CreatedPage<I> = {
  /** the notebook read back from the workspace (null: it can't be) */
  read(path: string): Promise<{ entry: any; content: any; rev: number } | null | undefined>;
  /** opened where this page shows notebooks; true once it is shown (or would be, the person's view kept) */
  open(c: Created, intent?: I): Promise<boolean>;
  /** the admission, in one turn: if the notebook shown is `ref` and `ok` holds for what it shows, its Run all, now;
   * true if it ran */
  runIfShown(ref: string, ok: (doc: any) => boolean): boolean;
  /** tests only (a local host): holds between the announcement and the read back, and between the open and the
   * admission; and the announcement seen */
  holdRead?(path: string): Promise<void> | void;
  holdRun?(path: string): Promise<void> | void;
  announced?(c: Created, p: { mayRunCreated(c: Created): boolean }): void;
};

/** The page's handler for an agent's creation (AgentPairing's onCreated): opens it, and runs it once if it may. */
export function createdRunner<I>(page: CreatedPage<I>): (c: Created, p: { mayRunCreated(c: Created): boolean }, intent?: I) => Promise<void> {
  const spent = new Set<string>();
  return async (c, p, intent) => {
    // (spent at once: a second announcement of the same creation is no second chance)
    if (spent.has(c.op)) return;
    spent.add(c.op);
    page.announced?.(c, p);
    let made: string | null = null;
    try {
      await page.holdRead?.(String(c.path));
      const r = await page.read(c.path);
      if (r?.entry?.kind === "notebook" && r.entry.ref === c.ref && r.rev === CREATED_REV) made = runInputs(r.content);
    } catch {}
    const opened = await page.open(c, intent);
    await page.holdRun?.(String(c.path));
    // (admitted in the page's runIfShown, all in one turn: every condition, then the run)
    if (!opened || made === null || !c.ref) return;
    page.runIfShown(c.ref, (doc) => runInputs(doc) === made && p.mayRunCreated(c));
  };
}
