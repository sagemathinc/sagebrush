// What a board's code may do where it runs, and the person's approvals of it (William, Nov 28 2026, 7:56 AM PST: "it
// depends on where it is running and what it might do. Obviously if it doesn't touch files ... then autorun is much
// better"; Codex S14 F1; the design SEC cleared with its conditions D1 to D6).
//   - In the runner (an opaque-origin sandboxed frame: no storage, no network, none of the person's files, design/
//     capabilities.md §2) a board's code has no capability, so it runs, whoever wrote it.
//   - Unconfined (a plain worker with the page's origin: the desktop app until it hosts the runner, a browser without
//     the runner, a runner that gave up), it could reach the page's storage: capability `host`. There it runs only
//     if this code, its digest, is approved for `host`, by the person: their Run, an edit of theirs to approved code,
//     or a board they made. Kept per device, in the permissions record (localStorage, which no worker can reach and
//     nothing syncs; on the desktop app also grants.json, beside the grants: web/workspace/grants-file.ts).
//   - The gate is where code crosses into the interpreter (gateWorker): an unconfined worker is given no code unless
//     the code it has is approved.
import { pageCount, pageView, type BoardDoc, type BoardMode } from "./doc";

/** The seed of a board without one of its own: code.ts's BOARD_SEED (a test checks they are one). */
export const SEED = "0".repeat(64);
type Store = Pick<Storage, "getItem" | "setItem">;
const store = (): Store => globalThis.localStorage;
const MODES: readonly string[] = ["python", "sage", "magma", "matlab"];

// ---- the digest of what runs (D1, D2)

/** Each item kind's fields as cleanDoc keeps them: `run`, what is executed; `shown`, what isn't. A kind, or a field,
 * not here makes the board unapprovable (held unconfined): never left out of the digest by not being known. */
export const KINDS: Record<string, { run: readonly string[]; shown: readonly string[] }> = {
  note: { run: ["code", "mode"], shown: ["id", "title", "image", "text", "hideCode", "detail", "ref", "color", "shape", "fit", "x", "y", "w", "h", "preview"] },
  group: { run: [], shown: ["id", "kind", "title", "text", "layout", "columns", "direction", "children", "color", "x", "y", "w", "h"] },
  ink: { run: [], shown: ["id", "kind", "x", "y", "points", "size", "color", "opacity"] },
  sticker: { run: [], shown: ["id", "kind", "emoji", "icon", "color", "x", "y", "w"] },
  ask: { run: ["check", "checkMs", "hints"], shown: ["id", "kind", "title", "text", "input", "options", "required", "min", "max", "step", "low", "high", "lines", "answer", "note", "next", "decide", "example", "attempts", "wrongAttempts", "result", "detail", "color", "x", "y", "w", "h"] },
};
/** The fields of a cell handed to the engine (mount.ts withPreviews): `id`, `code` and `mode` run; `preview` is shown. */
const CELL_RUN = ["id", "code", "mode"], CELL_SHOWN = ["preview"];

export type Cell = { id: string; code: string; mode?: BoardMode; preview?: unknown };

/** What of the document runs beside its cells: each ask's check and hints, by page, in page order; null if the
 * document has a kind or a field KINDS doesn't know. */
export function runnableOf(d: BoardDoc): unknown[] | null {
  const out: unknown[] = [];
  const visit = (nodes: any[], page: number): boolean => {
    for (const n of nodes ?? []) {
      const kind = n?.kind ?? "note", k = KINDS[kind];
      if (!k) return false;
      for (const f of Object.keys(n)) if (!k.run.includes(f) && !k.shown.includes(f)) return false;
      if (kind === "ask" && (n.check !== undefined || n.checkMs !== undefined || n.hints !== undefined)) out.push([page, String(n.id), n.check ?? null, n.checkMs ?? null, n.hints ?? null]);
      if (kind === "group" && !visit(n.children ?? [], page)) return false;
    }
    return true;
  };
  for (let i = 0; i < pageCount(d); i++) if (!visit((pageView(d, i).nodes ?? []) as any[], i)) return null;
  return out;
}

/** The digest of what runs: the cells exactly as they are handed to the engine (D1), the board's language, seed and
 * engine, and each ask's check and hints. Canonical JSON of fixed shape, the counts with the lists, so no two
 * boards collide by moving text between fields (D2). null: unapprovable (a cell field, a kind or a field not known). */
export async function codeDigest(cells: readonly Cell[], d: BoardDoc, mode: BoardMode, seed: string): Promise<string | null> {
  if (!MODES.includes(mode) || typeof seed !== "string") return null;
  const rows: unknown[] = [];
  for (const c of cells) {
    for (const f of Object.keys(c)) if (!CELL_RUN.includes(f) && !CELL_SHOWN.includes(f)) return null;
    if (typeof c.id !== "string" || typeof c.code !== "string" || (c.mode !== undefined && !MODES.includes(c.mode))) return null;
    rows.push([c.id, c.mode ?? null, c.code]);
  }
  const asks = runnableOf(d);
  if (!asks) return null;
  const engine = (d as any).engine ?? null;
  if (engine !== null && typeof engine !== "string") return null;
  const text = JSON.stringify(["sagebrush-board-code", 1, mode, seed, engine, rows.length, rows, asks.length, asks]);
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(h, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- the approvals (D5, D6): approvals.ts, kept apart so that grants.json's merge needs no board code
export { HOST, APPROVALS_MAX, validApprovals, approved, approve, allowOnce, mayRun, forget, forgetAll, mergeApprovals } from "./approvals";
import { mayRun } from "./approvals";

// ---- the gate where code crosses (D1, D3)

/** What an unconfined worker given code that isn't approved answers, as the runner's fallback answers what was waiting. */
export const NOT_APPROVED = "This board's code wasn't run: files can't be protected here, and this code hasn't been approved. Use \"Run this board's code\" to run it.\n";
/** A worker wrapped so that, while it is unconfined (`confined()` false) and its code isn't approved (`allowed()`
 * false), no code reaches it: a run or an interaction is answered as not run, a question as skipped, as the runner's
 * fallback answers what was waiting (web/notebook/runner-worker.js). What isn't code (its start, files) goes through. */
export function gateWorker(w: any, confined: () => boolean, allowed: () => boolean): any {
  const g: any = {
    onmessage: null,
    onerror: null,
    postMessage(m: any, transfer?: Transferable[]) {
      if (m && typeof m === "object" && m.id !== undefined && !confined() && !allowed()) {
        refused.push(m.id);
        const say = (data: unknown) => queueMicrotask(() => g.onmessage?.({ data }));
        if (m.code !== undefined || m.interact !== undefined) {
          say({ id: m.id, stream: "stderr", text: NOT_APPROVED });
          say({ id: m.id, done: true, error: true, ms: 0 });
        } else say({ id: m.id, skipped: true });
        return;
      }
      return transfer?.length ? w.postMessage(m, transfer) : w.postMessage(m);
    },
    terminate: () => w.terminate(),
    get interrupt() { return w.interrupt; },
    get flush() { return w.flush; },
    /** (tests: the ids refused) */
    refused: [] as unknown[],
    /** the worker itself (the runner's pill tells the runner's frame from a plain worker by it) */
    raw: w,
  };
  const refused = g.refused;
  w.onmessage = (e: any) => g.onmessage?.(e);
  w.onerror = (e: any) => g.onerror?.(e);
  return g;
}

// ---- a board whose last run was stopped opens paused (N1)

const STOPPED = "sagebrush-board-stopped";
const stopped = (s: Store): string[] => { try { const a = JSON.parse(s.getItem(STOPPED) ?? "[]"); return Array.isArray(a) ? a.filter((x) => typeof x === "string").slice(-200) : []; } catch { return []; } };
/** The person stopped this board's code: it opens paused next time, here or after a reload, until they run it. */
export function markStopped(ref: string, s: Store = store()) {
  try { s.setItem(STOPPED, JSON.stringify([...stopped(s).filter((x) => x !== ref), ref].slice(-200))); } catch {}
}
/** Whether this board's last run was stopped by the person. */
export const wasStopped = (ref: string, s: Store = store()) => stopped(s).includes(ref);
/** Its code run again: no longer opened paused. */
export function clearStopped(ref: string, s: Store = store()) {
  try { const a = stopped(s); if (a.includes(ref)) s.setItem(STOPPED, JSON.stringify(a.filter((x) => x !== ref))); } catch {}
}
